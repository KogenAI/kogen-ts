export type SandboxMode = "confined" | "unconfined" | "off";

export interface SandboxCapability {
	readonly available: boolean;
	readonly reason?: string;
}

export interface SandboxPolicyInput {
	readonly enabled: boolean;
	readonly alreadyConfined?: boolean;
	readonly forcedUnavailableReason?: string;
	readonly capability: SandboxCapability;
}

export interface SandboxDecision {
	readonly mode: SandboxMode;
	readonly wrapCommands: boolean;
	readonly alreadyConfined: boolean;
	readonly unavailableReason: string | null;
	readonly warning: string | null;
	readonly event: "sandbox_unavailable" | null;
}

export const SANDBOX_WARNING_PREFIX = "kogen: warning: sandbox unavailable: ";

export function sandboxAlreadyConfined(
	environment: Readonly<Record<string, string | undefined>>,
): boolean {
	return environment.KOGEN_SANDBOXED === "1";
}

export function forcedSandboxUnavailableReason(
	environment: Readonly<Record<string, string | undefined>>,
): string | null {
	return environment.KOGEN_SANDBOX === "unavailable"
		? "forced unavailable by KOGEN_SANDBOX=unavailable"
		: null;
}

export function formatSandboxWarning(reason: string): string {
	const safeReason = sanitizeSandboxReason(reason);
	return `${SANDBOX_WARNING_PREFIX}${safeReason}; building unconfined`;
}

function sanitizeSandboxReason(reason: string): string {
	return reason.replace(/[\r\n\0]/g, " ").trim() || "unknown reason";
}

export function resolveSandboxPolicy(
	input: SandboxPolicyInput,
): SandboxDecision {
	if (!input.enabled) {
		return {
			mode: "off",
			wrapCommands: false,
			alreadyConfined: false,
			unavailableReason: null,
			warning: null,
			event: null,
		};
	}

	if (input.alreadyConfined === true) {
		return {
			mode: "confined",
			wrapCommands: false,
			alreadyConfined: true,
			unavailableReason: null,
			warning: null,
			event: null,
		};
	}

	const reason =
		input.forcedUnavailableReason?.trim() ||
		(input.capability.available
			? null
			: input.capability.reason?.trim() || "sandbox capability unavailable");
	if (reason !== null) {
		const safeReason = sanitizeSandboxReason(reason);
		return {
			mode: "unconfined",
			wrapCommands: false,
			alreadyConfined: false,
			unavailableReason: safeReason,
			warning: formatSandboxWarning(safeReason),
			event: "sandbox_unavailable",
		};
	}

	return {
		mode: "confined",
		wrapCommands: true,
		alreadyConfined: false,
		unavailableReason: null,
		warning: null,
		event: null,
	};
}
