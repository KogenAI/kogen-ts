import type { GateFinding } from "./findings";
import type { GateVerificationResult } from "./verify";

const MAX_FINDINGS_PER_TOOL = 10;
const MAX_FINDINGS_TOTAL = 20;
const MAX_MESSAGE_CHARACTERS = 200;
const MAX_TAIL_LINES = 8;
const MAX_TAIL_CHARACTERS = 600;

function codePoints(value: string): readonly string[] {
	return Array.from(value);
}

function clipMessage(value: string): string {
	return codePoints(value).slice(0, MAX_MESSAGE_CHARACTERS).join("");
}

function toolForFinding(finding: GateFinding): string {
	const slash = finding.rule.indexOf("/");
	return slash < 0 ? finding.rule : finding.rule.slice(0, slash);
}

function displayFindings(findings: readonly GateFinding[]): {
	readonly lines: readonly string[];
	readonly hidden: ReadonlyMap<string, number>;
} {
	const perTool = new Map<string, number>();
	const displayed: GateFinding[] = [];
	const shown = new Set<GateFinding>();
	for (const finding of findings) {
		const tool = toolForFinding(finding);
		const count = perTool.get(tool) ?? 0;
		if (count >= MAX_FINDINGS_PER_TOOL) continue;
		perTool.set(tool, count + 1);
		if (displayed.length >= MAX_FINDINGS_TOTAL) continue;
		displayed.push(finding);
		shown.add(finding);
	}
	const hidden = new Map<string, number>();
	for (const finding of findings) {
		if (shown.has(finding)) continue;
		const tool = toolForFinding(finding);
		hidden.set(tool, (hidden.get(tool) ?? 0) + 1);
	}
	const lines = displayed.map(renderFinding);
	for (const [tool, count] of [...hidden].sort(([a], [b]) => compareUtf8(a, b)))
		lines.push(`… ${count} more ${tool} findings`);
	return { lines, hidden };
}

function renderFinding(finding: GateFinding): string {
	const symbol = finding.symbol.length > 0 ? `${finding.symbol}: ` : "";
	return `${finding.path}:${finding.line}:${finding.column}: ${finding.severity}: [${finding.rule}] ${symbol}${clipMessage(finding.message)}`;
}

function compareUtf8(left: string, right: string): number {
	const encoder = new TextEncoder();
	const a = encoder.encode(left);
	const b = encoder.encode(right);
	for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return a.length - b.length;
}

function replacePrivateDirectories(
	value: string,
	tmpDirectory: string,
	homeDirectory: string,
): string {
	let output = value;
	if (tmpDirectory.length > 0)
		output = output.replaceAll(tmpDirectory, "$TMPDIR");
	if (homeDirectory.length > 0)
		output = output.replaceAll(homeDirectory, "$HOME");
	return output;
}

function tailText(
	stdout: Uint8Array,
	stderr: Uint8Array,
	tmpDirectory: string,
	homeDirectory: string,
): string {
	const bytes = new Uint8Array(stdout.byteLength + stderr.byteLength);
	bytes.set(stdout);
	bytes.set(stderr, stdout.byteLength);
	const decoded = new TextDecoder("utf-8").decode(bytes);
	const normalized = replacePrivateDirectories(
		decoded.replace(/\r\n?/gu, "\n"),
		tmpDirectory,
		homeDirectory,
	);
	const lines = normalized.split("\n");
	if (lines.at(-1) === "") lines.pop();
	const tail = lines.slice(-MAX_TAIL_LINES).join("\n");
	return codePoints(tail).slice(-MAX_TAIL_CHARACTERS).join("");
}

function isAcceptanceFailure(result: GateVerificationResult): boolean {
	return (
		result.acceptance.failures.length > 0 ||
		result.acceptance.items.some((item) => item.status !== "pass")
	);
}

function failedSteps(result: GateVerificationResult): ReadonlySet<string> {
	const failed = new Set<string>();
	for (const fix of result.fixes) if (fix.failed) failed.add(fix.command.step);
	for (const check of result.checks)
		if (check.status !== "green") failed.add(check.name);
	if (isAcceptanceFailure(result)) failed.add("acceptance");
	return failed;
}

function formatTimeoutSeconds(milliseconds: number): string {
	return (milliseconds / 1_000)
		.toFixed(3)
		.replace(/0+$/u, "")
		.replace(/\.$/u, "");
}

function checkFailureLines(result: GateVerificationResult): readonly string[] {
	const lines: string[] = [];
	for (const check of result.checks) {
		if (check.status === "green" || check.excused) continue;
		if (check.status === "timeout") {
			lines.push(
				`timed out after ${formatTimeoutSeconds(check.timeoutMilliseconds)} s`,
			);
		} else if (check.status === "mutating") {
			const changedPaths =
				check.changedPaths.length > 0
					? check.changedPaths.join(", ")
					: "<unknown>";
			lines.push(`changed paths: ${changedPaths}`);
		} else if (check.status === "unavailable") {
			const executable = check.argv[0] ?? check.name;
			lines.push(
				check.baselineStatus !== null && check.baselineStatus !== "unavailable"
					? `${executable} is not available, but it ran on the base`
					: `${executable} is not available`,
			);
		}
	}
	return lines;
}

function rawLogLines(result: GateVerificationResult): readonly string[] {
	const failed = failedSteps(result);
	const lines: string[] = [];
	for (const log of result.rawLogs) {
		if (!failed.has(log.step)) continue;
		if (log.stdout.byteLength > 0 || log.stderr.byteLength === 0)
			lines.push(`raw log: ${log.stdoutPath}`);
		if (log.stderr.byteLength > 0) lines.push(`raw log: ${log.stderrPath}`);
	}
	return lines;
}

function firstFailedLog(result: GateVerificationResult) {
	const failed = failedSteps(result);
	return result.rawLogs.find((log) => failed.has(log.step));
}

function checkSummary(result: GateVerificationResult): string {
	return result.checks
		.map((check) => `${check.name}=${check.status}`)
		.join(", ");
}

function toolCounts(result: GateVerificationResult): string {
	const entries = Object.entries(result.counts.byTool).sort(([a], [b]) =>
		compareUtf8(a, b),
	);
	return entries.length === 0
		? "none"
		: entries.map(([tool, count]) => `${tool}=${count}`).join(", ");
}

/** Render the bounded repair message while all raw bytes remain in the run directory. */
export function formatGateFeedback(
	result: GateVerificationResult,
	options: {
		readonly tmpDirectory?: string;
		readonly homeDirectory?: string;
	} = {},
): string {
	const visibleFindings = result.findings.filter(
		(finding) =>
			!finding.excused &&
			!(finding.step === "acceptance" && finding.rule === "acceptance"),
	);
	const clipped = displayFindings(visibleFindings);
	const lines = [
		...clipped.lines,
		...checkFailureLines(result),
		...rawLogLines(result),
	];
	const failedLog = firstFailedLog(result);
	if (failedLog !== undefined) {
		lines.push(`raw tail (first failed step ${failedLog.step}):`);
		const tail = tailText(
			failedLog.stdout,
			failedLog.stderr,
			options.tmpDirectory ?? "",
			options.homeDirectory ?? "",
		);
		if (tail.length > 0) lines.push(tail);
	}
	for (const item of result.acceptance.items) {
		if (item.status === "pass") continue;
		lines.push(`acceptance ${item.id}: failed`);
	}
	for (const check of result.checks) {
		if (check.excused)
			lines.push(
				`Base-red warning: check "${check.name}" still has only findings recorded at approval.`,
			);
	}
	const passed = result.acceptance.items.filter(
		(item) => item.status === "pass",
	).length;
	lines.push(
		`gate: ${result.counts.errors} errors, ${result.counts.warnings} warnings (${toolCounts(result)}); checks ${checkSummary(result)}; acceptance ${passed}/${result.acceptance.items.length}`,
	);
	return lines.join("\n");
}
