import type { IntentAcceptanceItem, ParsedIntent } from "../intent/parse";

export type ApprovalCheckStatus =
	| "green"
	| "red"
	| "unavailable"
	| "timeout"
	| "mutating";

export interface ApprovalCheckBaseline {
	readonly name: string;
	readonly status: ApprovalCheckStatus;
	readonly exit_status: number | null;
	readonly findings: readonly {
		readonly path: string;
		readonly rule: string;
		readonly symbol: string;
		readonly message: string;
		readonly line?: number;
	}[];
}

export interface ApprovalCardWarning {
	readonly code: string;
	readonly itemIds: readonly string[];
	readonly message: string;
}

export interface ApprovalCardInput {
	readonly slug: string;
	readonly approvalSha256: string;
	readonly approver: string;
	readonly base: string;
	readonly baseSha: string;
	readonly intent: ParsedIntent;
	readonly warnings: readonly ApprovalCardWarning[];
	readonly checkBaseline: readonly ApprovalCheckBaseline[];
}

function acceptanceKind(
	item: IntentAcceptanceItem,
	intent: ParsedIntent,
): "test" | "test keep" {
	return intent.verify.find((value) => value.id === item.id)?.keep
		? "test keep"
		: "test";
}

function warningLine(warning: ApprovalCardWarning): string {
	const ids = warning.itemIds.length === 0 ? "-" : warning.itemIds.join(", ");
	return `  - ${warning.code}: ${ids} — ${warning.message}`;
}

function redBaselineLines(
	checks: readonly ApprovalCheckBaseline[],
): readonly string[] {
	const red = checks.filter((check) => check.status === "red");
	if (red.length === 0) return [];
	const lines = ["Warning: configured checks are already red on the base:"];
	for (const check of red) {
		for (const finding of check.findings.slice(0, 5)) {
			const location =
				finding.line === undefined
					? finding.path
					: `${finding.path}:${finding.line}`;
			lines.push(
				`  - ${check.name}: [${finding.rule}] ${location}: ${finding.message}`,
			);
		}
		if (check.findings.length === 0)
			lines.push(
				`  - ${check.name}: check exited ${String(check.exit_status)}`,
			);
	}
	lines.push(
		"Hint: fix the base first, or scope the check, e.g. a changed-files format argv.",
	);
	return lines;
}

function nonRedBaselineWarnings(
	checks: readonly ApprovalCheckBaseline[],
): readonly ApprovalCardWarning[] {
	return checks
		.filter((check) => check.status !== "green" && check.status !== "red")
		.map((check) => ({
			code: `check_${check.status}`,
			itemIds: [],
			message: `Configured check ${check.name} was ${check.status} on the base.`,
		}));
}

/** Render the warning text shared by the review card and successful approval. */
export function renderApprovalWarnings(
	warnings: readonly ApprovalCardWarning[],
	checkBaseline: readonly ApprovalCheckBaseline[],
): string {
	const allWarnings = [...warnings, ...nonRedBaselineWarnings(checkBaseline)];
	const blocks: string[] = [];
	if (allWarnings.length > 0)
		blocks.push(["Warnings", ...allWarnings.map(warningLine)].join("\n"));
	const redLines = redBaselineLines(checkBaseline);
	if (redLines.length > 0) blocks.push(redLines.join("\n"));
	return blocks.join("\n\n");
}

/** Render the byte-stable human review card for `intent approve <slug>`. */
export function renderApprovalCard(input: ApprovalCardInput): string {
	const lines = [
		`Intent: ${input.slug} — ${input.intent.frontmatter.title}`,
		`SHA-256: ${input.approvalSha256}`,
		`Approver: ${input.approver}`,
		`Base: ${input.base} at ${input.baseSha}`,
		"",
		"Brief",
		...input.intent.brief
			.split("\n")
			.map((line) => (line.length === 0 ? "" : `  ${line}`)),
		"",
		"Acceptance",
		...input.intent.acceptance.map(
			(item) =>
				`  - [${item.id}] ${item.text} (${acceptanceKind(item, input.intent)})`,
		),
	];
	const warnings = renderApprovalWarnings(input.warnings, input.checkBaseline);
	if (warnings.length > 0) lines.push("", ...warnings.split("\n"));
	lines.push(
		"",
		"Approve with:",
		`  kogen intent approve ${input.slug} ${input.approvalSha256.slice(0, 8)}`,
	);
	return lines.join("\n");
}
