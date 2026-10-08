import { accessSync, constants, statSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { ProcessPort } from "../../core/src/contracts/ports";
import {
	type LinuxSandboxProbe,
	resolveLinuxSandbox,
} from "../../core/src/sandbox/linux";
import {
	createMacOSSandboxProfile,
	type MacOSSandboxProbeResult,
	macOSSandboxCommand,
} from "../../core/src/sandbox/macos";
import {
	forcedSandboxUnavailableReason,
	formatSandboxWarning,
	sandboxAlreadyConfined,
} from "../../core/src/sandbox/policy";

type Probe = MacOSSandboxProbeResult | LinuxSandboxProbe;

function executableAvailable(
	program: string,
	cwd: string,
	path: string | undefined,
): boolean {
	const candidates = program.includes("/")
		? [isAbsolute(program) ? program : resolve(cwd, program)]
		: (path ?? "")
				.split(delimiter)
				.map((entry) => resolve(cwd, entry, program));
	return candidates.some((candidate) => {
		try {
			accessSync(candidate, constants.X_OK);
			return statSync(candidate).isFile();
		} catch {
			return false;
		}
	});
}

function missingExecutable(request: Parameters<ProcessPort["run"]>[0]) {
	return !executableAvailable(
		request.argv[0] ?? "",
		request.cwd,
		request.env.PATH,
	)
		? {
				ok: true as const,
				value: {
					exitCode: 127,
					signal: null,
					stdout: new Uint8Array(),
					stderr: new Uint8Array(),
					timedOut: false,
				},
			}
		: null;
}

export interface ApprovalProcessOptions {
	readonly raw: Pick<ProcessPort, "run">;
	readonly platform: string;
	readonly probe: Probe;
	readonly enabled: boolean;
	readonly hostEnvironment: Readonly<Record<string, string | undefined>>;
	readonly checkout: string;
	readonly origin: string;
	readonly workspace: string;
	readonly runDirectory: string;
	readonly home: string;
}

/** This port is passed only to candidate setup, checks and acceptance commands. */
export function createApprovalProcess(options: ApprovalProcessOptions): {
	process: Pick<ProcessPort, "run">;
	warning: string | null;
} {
	if (!options.enabled || sandboxAlreadyConfined(options.hostEnvironment))
		return { process: options.raw, warning: null };
	const forced = forcedSandboxUnavailableReason(options.hostEnvironment);
	const unavailable =
		forced ??
		(!options.probe.available
			? "reason" in options.probe && typeof options.probe.reason === "string"
				? options.probe.reason
				: "sandbox unavailable"
			: null);
	if (unavailable !== null)
		return {
			process: options.raw,
			warning: formatSandboxWarning(unavailable),
		};
	if (options.platform === "darwin") {
		const profilePath = join(options.runDirectory, "approval.sb");
		writeFileSync(
			profilePath,
			createMacOSSandboxProfile({
				checkout: options.checkout,
				origins: [options.origin],
				workspace: options.workspace,
				runDirectory: options.runDirectory,
				home: options.home,
				...(options.hostEnvironment.KOGEN_AUTH_PATH === undefined
					? {}
					: { authPath: options.hostEnvironment.KOGEN_AUTH_PATH }),
				environment: options.hostEnvironment,
			}),
			{ mode: 0o600 },
		);
		return {
			warning: null,
			process: {
				run(request) {
					const missing = missingExecutable(request);
					if (missing !== null) return Promise.resolve(missing);
					return options.raw.run({
						...request,
						argv: macOSSandboxCommand(profilePath, request.argv),
					});
				},
			},
		};
	}
	if (options.platform === "linux" && "bwrapPath" in options.probe) {
		return {
			warning: null,
			process: {
				run(request) {
					const missing = missingExecutable(request);
					if (missing !== null) return Promise.resolve(missing);
					const resolved = resolveLinuxSandbox(request, {
						enabled: true,
						probe: options.probe as LinuxSandboxProbe,
						mount: {
							homeDirectory: options.home,
							workspaceDirectory: options.workspace,
							runDirectory: options.runDirectory,
							checkoutDirectory: options.checkout,
							originDirectory: options.origin,
							...(options.hostEnvironment.KOGEN_AUTH_PATH === undefined
								? {}
								: { authPath: options.hostEnvironment.KOGEN_AUTH_PATH }),
						},
					});
					return options.raw.run(resolved.request);
				},
			},
		};
	}
	return {
		process: options.raw,
		warning: formatSandboxWarning("sandbox unavailable"),
	};
}
