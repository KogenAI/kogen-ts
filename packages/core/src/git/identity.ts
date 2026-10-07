import type { PortError, Result } from "../contracts/errors";
import type { ProcessPort } from "../contracts/ports";
import {
	GIT_DEFAULT_TIMEOUT_MS,
	type GitCommandOptions,
	runGitCommand,
} from "./command";

export interface PublicGitIdentity {
	readonly name: string;
	readonly email: string;
	readonly ident: string;
}

function portError(code: PortError["code"], message: string): PortError {
	return { code, message, retryable: false };
}

/**
 * Resolve the identity Git would use for a public commit. This deliberately
 * uses the public configuration path, retaining user global identity/signing
 * configuration while the command runner still disables hooks and redirection.
 */
export async function readPublicGitIdentity(
	process: Pick<ProcessPort, "run">,
	repository: string,
	options: Omit<GitCommandOptions, "configuration"> = {},
): Promise<Result<PublicGitIdentity>> {
	const commandOptions: GitCommandOptions = {
		...(options.executable === undefined
			? {}
			: { executable: options.executable }),
		...(options.environment === undefined
			? {}
			: { environment: options.environment }),
		configuration: "public",
	};
	const result = await runGitCommand(
		process,
		{
			repository,
			argv: ["var", "GIT_AUTHOR_IDENT"],
			timeoutMilliseconds: GIT_DEFAULT_TIMEOUT_MS,
			outputLimitBytes: 1024,
		},
		commandOptions,
	);
	if (!result.ok) return result;
	if (result.value.timedOut) {
		return {
			ok: false,
			error: {
				code: "timeout",
				message: "Git public identity lookup timed out",
				retryable: true,
			},
		};
	}
	if (result.value.exitCode !== 0) {
		return {
			ok: false,
			error: portError(
				"unavailable",
				"Git could not resolve the public author identity",
			),
		};
	}
	let ident: string;
	try {
		ident = new TextDecoder("utf-8", { fatal: true })
			.decode(result.value.stdout)
			.trimEnd();
	} catch {
		return {
			ok: false,
			error: portError(
				"unavailable",
				"Git returned an invalid author identity",
			),
		};
	}
	const match = /^(.*) <([^<>]+)> ([0-9]+) ([+-][0-9]{4})$/.exec(ident);
	const name = match?.[1];
	const email = match?.[2];
	if (
		match === null ||
		name === undefined ||
		name.trim().length === 0 ||
		email === undefined ||
		email.trim().length === 0
	) {
		return {
			ok: false,
			error: portError(
				"unavailable",
				"Git returned an invalid author identity",
			),
		};
	}
	return { ok: true, value: { name, email, ident: `${name} <${email}>` } };
}

/** Apply the frozen `--by` override rule without altering the commit identity. */
export function publicApproverLabel(
	by: string | undefined,
	identity: PublicGitIdentity,
): Result<string> {
	if (by === undefined) return { ok: true, value: identity.ident };
	if (by.trim().length === 0) return { ok: true, value: identity.ident };
	if (/[\r\n\0]/.test(by)) {
		return {
			ok: false,
			error: portError(
				"invalid_input",
				"Approver must be non-blank and contain one line",
			),
		};
	}
	return { ok: true, value: by };
}
