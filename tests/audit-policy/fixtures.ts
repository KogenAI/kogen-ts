import type { AcceptanceLedgerRow } from "../../packages/core/src/adapters/interface";
import type { GateRawLog } from "../../packages/core/src/gate/checks";
import type { AcceptanceItemResult } from "../../packages/core/src/gate/ledger";
import type {
	GateAcceptanceResult,
	GateCheckResult,
	GateVerificationResult,
} from "../../packages/core/src/gate/verify";

export const emptyLog: GateRawLog = {
	step: "acceptance",
	stdoutPath: "/run/gate.stdout",
	stderrPath: "/run/gate.stderr",
	stdout: new Uint8Array(),
	stderr: new Uint8Array(),
};

export function gateResult(input: {
	readonly items: readonly AcceptanceItemResult[];
	readonly checks?: readonly GateCheckResult[];
}): GateVerificationResult {
	const rows: AcceptanceLedgerRow[] = [];
	for (const item of input.items) {
		if (item.rows.length > 0) rows.push(...item.rows);
		else
			rows.push({
				tag: `greet/${item.id}`,
				test: `test ${item.id}`,
				status: item.status === "pass" ? "passed" : "failed",
			});
	}
	const ledger = {
		reportState: "valid" as const,
		rows,
		items: input.items,
		unknownTags: [],
		failures: [],
		treeBefore: "tree-1",
		treeAfter: "tree-1",
		exitStatus: 0,
		timedOut: false,
	};
	const acceptance: GateAcceptanceResult = {
		ledger,
		items: input.items,
		failures: [],
		findings: [],
		log: emptyLog,
		exitStatus: 0,
		timedOut: false,
	};
	const checks = input.checks ?? [];
	const status =
		input.items.some((item) => item.status !== "pass") ||
		checks.some((check) => check.status !== "green" && !check.excused)
			? "red"
			: "green";
	const result: GateVerificationResult = {
		status,
		fixes: [],
		checks,
		acceptance,
		findings: checks.flatMap((check) => check.findings),
		rawLogs: [emptyLog],
		failureCount: 0,
		counts: { errors: 0, warnings: 0, byTool: {} },
		findingsPath: "/run/findings.json",
	};
	return result;
}

export function acceptanceItem(
	id: string,
	status: "pass" | "fail",
): AcceptanceItemResult {
	return {
		id,
		status,
		rows: [
			{
				tag: `greet/${id}`,
				test: `test ${id}`,
				status: status === "pass" ? "passed" : "failed",
			},
		],
	};
}
