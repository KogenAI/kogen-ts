import { randomBytes } from "node:crypto";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClockPort } from "../../core/src/contracts/clock";
import type { RandomPort } from "../../core/src/contracts/ports";
import { createAllowlistedBaseEnvironment } from "../../core/src/process/environment";
import {
	readAccountsFile,
	withProviderAccount,
	writeAccountsFile,
} from "../../core/src/provider/accounts/format";
import {
	formatProfileList,
	readProfilesFile,
} from "../../core/src/provider/accounts/profiles";
import { loginChatGpt } from "../../core/src/provider/auth/chatgpt/login";
import { logoutChatGpt } from "../../core/src/provider/auth/chatgpt/logout";
import {
	createCredentialPort,
	createHostKeychainPort,
} from "../../core/src/provider/auth/vault";
import { HttpTransport } from "../../core/src/provider/http/transport";
import type { ParsedCommand } from "./argv";
import type { ControllerRuntime } from "./composition";
import { type CliOutput, renderErrorLine } from "./output";

const clock: ClockPort = {
	unixMilliseconds: () => Date.now(),
	monotonicMilliseconds: () => performance.now(),
	sleep: (milliseconds) =>
		new Promise((resolve) => setTimeout(resolve, milliseconds)),
};
const random: RandomPort = {
	async bytes(length) {
		return { ok: true, value: randomBytes(length) };
	},
};

export function createI2CredentialPort(
	runtime: ControllerRuntime,
	home: string,
) {
	mkdirSync(join(home, ".kogen", "credentials"), {
		recursive: true,
		mode: 0o700,
	});
	return createCredentialPort({
		filesystem: runtime.filesystem,
		homeDirectory: home,
		keychain: createHostKeychainPort(runtime.bridge),
		random,
	});
}

export async function runI2ProviderLogin(
	command: Extract<ParsedCommand, { name: "provider login" }>,
	runtime: ControllerRuntime,
): Promise<CliOutput> {
	if (command.provider !== "chatgpt")
		return renderErrorLine(
			"environment/provider_login_unavailable: Grok login enters at I6.",
			3,
		);
	const home = process.env.HOME ?? homedir();
	const credentials = createI2CredentialPort(runtime, home);
	const progress: string[] = [];
	const result = await loginChatGpt({
		filesystem: runtime.filesystem,
		credentials,
		http: new HttpTransport(clock),
		random,
		clock,
		homeDirectory: home,
		label: "default",
		...(process.env.KOGEN_AUTH_URL === undefined
			? {}
			: { authUrl: process.env.KOGEN_AUTH_URL }),
		progress(line) {
			progress.push(line);
		},
		async openBrowser(url) {
			const opened = await runtime.process.run({
				argv: [process.platform === "darwin" ? "open" : "xdg-open", url],
				cwd: home,
				env: createAllowlistedBaseEnvironment(),
				timeoutMilliseconds: 15_000,
				outputLimitBytes: 64 * 1024,
			});
			return opened.ok && opened.value.exitCode === 0
				? { ok: true as const, value: undefined }
				: {
						ok: false as const,
						error: {
							code: "unavailable" as const,
							message: "Could not open the sign-in page.",
							retryable: false,
						},
					};
		},
	});
	if (!result.ok)
		return renderErrorLine(`provider/login: ${result.error.message}`, 4);
	return {
		stdout: `${progress.join("")}You're using your ChatGPT plan\nchatgpt:default signed in${result.value.email === null ? "" : ` (${result.value.email})`}\n`,
		stderr: "",
		exitCode: 0,
	};
}

export async function runI2ProviderCommand(
	command: Extract<
		ParsedCommand,
		{
			name:
				| "provider list"
				| "provider login"
				| "provider logout"
				| "provider use";
		}
	>,
	runtime: ControllerRuntime,
): Promise<CliOutput> {
	if (command.name === "provider login")
		return runI2ProviderLogin(command, runtime);
	const home = process.env.HOME ?? homedir();
	if (command.name === "provider list") {
		const profiles = await readProfilesFile(runtime.filesystem, home);
		if (!profiles.ok)
			return renderErrorLine(
				`environment/invalid_profiles_file: ${profiles.error.message}`,
				3,
			);
		const accounts = await readAccountsFile(runtime.filesystem, home);
		if (!accounts.ok)
			return renderErrorLine(
				`environment/invalid_accounts_file: ${accounts.error.message}`,
				3,
			);
		return {
			stdout: formatProfileList(profiles.value, accounts.value ?? {}),
			stderr: "",
			exitCode: 0,
		};
	}
	if (command.provider !== "chatgpt")
		return renderErrorLine(
			"environment/provider_unavailable: Grok provider commands enter at I6.",
			3,
		);
	if (command.name === "provider logout") {
		const result = await logoutChatGpt({
			credentials: createI2CredentialPort(runtime, home),
			filesystem: runtime.filesystem,
			http: new HttpTransport(clock),
			homeDirectory: home,
			label: "default",
			...(process.env.KOGEN_AUTH_URL === undefined
				? {}
				: { authUrl: process.env.KOGEN_AUTH_URL }),
		});
		return result.ok
			? renderErrorLine("chatgpt:default signed out", 0)
			: renderErrorLine(
					`provider/logout: ${result.error.kind === "port" ? result.error.error.message : result.error.message}`,
					4,
				);
	}
	const accounts = await readAccountsFile(runtime.filesystem, home);
	if (!accounts.ok)
		return renderErrorLine(
			`environment/invalid_accounts_file: ${accounts.error.message}`,
			3,
		);
	let project: string | undefined;
	if (command.project !== undefined) {
		try {
			project = realpathSync(command.project);
		} catch {
			return renderErrorLine(
				"environment/project_not_found: Project is unavailable.",
				3,
			);
		}
	}
	const profiles = await readProfilesFile(runtime.filesystem, home);
	if (!profiles.ok)
		return renderErrorLine(
			`environment/invalid_profiles_file: ${profiles.error.message}`,
			3,
		);
	if (profiles.value.chatgpt[command.account]?.signed_in !== true)
		return renderErrorLine(
			`provider/login: Selected account ${command.account} has no saved login; run kogen provider login chatgpt to sign in`,
			4,
		);
	const selected = withProviderAccount(
		accounts.value ?? {},
		command.provider,
		command.account,
		project,
	);
	const written = await writeAccountsFile(
		runtime.filesystem,
		home,
		selected,
		async (path) => {
			try {
				return statSync(path).isDirectory();
			} catch {
				return false;
			}
		},
	);
	if (!written.ok)
		return renderErrorLine(
			`environment/accounts_write_failed: ${written.error.message}`,
			3,
		);
	return renderErrorLine(
		project === undefined
			? `${command.provider}:${command.account} is the default account`
			: `${command.provider}:${command.account} is the account for ${project}`,
		0,
	);
}
