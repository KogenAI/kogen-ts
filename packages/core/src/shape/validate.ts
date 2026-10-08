import type {
	AcceptanceAdapter,
	StagedAcceptanceTest,
} from "../adapters/interface";
import type { PortError, Result } from "../contracts/errors";
import type { FileSystemPort, ProcessPort } from "../contracts/ports";
import { FILESYSTEM_MAX_RESPONSE_BYTES } from "../fs/read";
import {
	type GateTreePort,
	type GateTreeSnapshot,
	runGateCommand,
} from "../gate/checks";
import { runAcceptanceLedger } from "../gate/ledger";
import { effectiveGateProgramPaths } from "../gate/manifest";
import { lintIntent, renderIntentLintFinding } from "../intent/lint";
import { normalizeIntentBytes } from "../intent/normalize";
import {
	type IntentAcceptanceItem,
	type ParsedIntent,
	parseIntent,
} from "../intent/parse";
import type { ResolvedRole } from "../project/roles";
import type { ProjectConfig } from "../project/schema";
import type { RespondResult } from "../provider/retry/respond";
import {
	clearStaleShapeArtifacts,
	createShapeLedgerArtifact,
	createShapeWarningsArtifact,
	writeShapeLedgerArtifact,
	writeShapeWarningsArtifact,
} from "./artifacts";
import { createShapeAuditSession, parseShapeTestAudit } from "./audit";
import type {
	ShapeValidationInput,
	ShapeValidationOutcome,
	ShapeWarning,
} from "./controller";
import {
	parseShapeRequirementLedger,
	type ShapeRequirementLedgerRow,
} from "./ledger";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");
const SHAPE_SOURCE_MAX_BYTES = FILESYSTEM_MAX_RESPONSE_BYTES - 1;
const SHAPE_FORMAT_TIMEOUT_MS = 60_000;
const LEDGER_REPORT_FILENAME = "shape-acceptance-ledger.jsonl";

export interface ShapeFormatterAdapter extends AcceptanceAdapter {
	formatter?(
		project: Pick<ProjectConfig, "checks" | "format">,
	): readonly string[];
	formatterPaths?(paths: readonly string[]): readonly string[];
}

export interface ShapeValidationWorkspace extends GateTreePort {}

export interface ShapeValidationState {
	coverageRepairUsed: boolean;
	testAuditRepairUsed: boolean;
	artifactsCleared: boolean;
	logIndex: number;
}

export function createShapeValidationState(): ShapeValidationState {
	return {
		coverageRepairUsed: false,
		testAuditRepairUsed: false,
		artifactsCleared: false,
		logIndex: 1,
	};
}

export interface ShapeValidationWorkflowContext {
	/** This is selected by the configured/detected acceptance adapter. */
	readonly adapter: ShapeFormatterAdapter;
	readonly auditorRole: ResolvedRole;
	readonly filesystem: FileSystemPort;
	readonly process: ProcessPort;
	readonly workspace: ShapeValidationWorkspace;
	readonly project: ProjectConfig;
	readonly workdir: string;
	readonly scratchDirectory: string;
	readonly slug: string;
	/** Original Request bytes; normalization never decodes or rewrites them. */
	readonly requestBytes: Uint8Array;
	readonly environment: Readonly<Record<string, string>>;
	readonly state?: ShapeValidationState;
	readonly onProgress?: (
		event: "formatter_unavailable",
		passNumber: number,
	) => void;
}

interface FormatterInvocation {
	readonly argv: readonly string[];
	readonly step: string;
}

interface FormattedResult {
	readonly unavailable: boolean;
	readonly error: ShapeValidationOutcome | null;
}

function error(code: PortError["code"], message: string): PortError {
	return { code, message, retryable: code === "io" || code === "unavailable" };
}

function failure(
	category: "candidate" | "provider" | "environment",
	reason: string,
	message: string,
	exitCode: number,
) {
	return { category, reason, message, exitCode } as const;
}

function candidateRepair(
	reason: string,
	message: string,
	_input: ShapeValidationInput,
	context: ShapeValidationWorkflowContext,
	repairKind:
		| "validation"
		| "coverage"
		| "test_audit"
		| "combined" = "validation",
): ShapeValidationOutcome {
	const failureValue = failure("candidate", `candidate/${reason}`, message, 1);
	return {
		kind: "repair",
		failure: failureValue,
		feedback: renderRepairFeedback(context, failureValue),
		repairKind,
	};
}

function terminalFailure(
	category: "provider" | "environment",
	reason: string,
	message: string,
	exitCode: number,
): ShapeValidationOutcome {
	return {
		kind: "failure",
		failure: failure(category, reason, message, exitCode),
	};
}

function renderRepairFeedback(
	context: ShapeValidationWorkflowContext,
	problem: ReturnType<typeof failure>,
): string {
	return [
		"Validation failed. Repair the generated files in this conversation. The required paths and their current state are:",
		`- \`.kogen/intents/${context.slug}/intent.md\`: present on disk. Keep it in place; change it only if the failure below requires a correction.`,
		`- \`${context.adapter.sourcePath(context.slug)}\`: present on disk. Keep it in place; change it only if the failure below requires a correction.`,
		"Both exact paths must exist after this pass. Every missing path must be written now. Do not delete required files. The available tools can read, search, and write files; they cannot remove them. Preserve present content unless the failure below requires a focused correction.",
		"",
		"Exact failure output:",
		"",
		`${problem.reason}: ${problem.message}`,
	].join("\n");
}

function sortUtf8(left: string, right: string): number {
	const a = encoder.encode(left);
	const b = encoder.encode(right);
	for (
		let index = 0;
		index < Math.min(a.byteLength, b.byteLength);
		index += 1
	) {
		const delta = (a[index] ?? 0) - (b[index] ?? 0);
		if (delta !== 0) return delta;
	}
	return a.byteLength - b.byteLength;
}

function effectiveGatePaths(
	context: ShapeValidationWorkflowContext,
): readonly string[] {
	const railsPaths =
		context.adapter.name === "rails"
			? [
					"Gemfile",
					"Gemfile.lock",
					"bin/rails",
					".standard.yml",
					".rubocop.yml",
				]
			: [];
	return [
		".kogen/project.yaml",
		...context.project.gatePaths,
		...effectiveGateProgramPaths(context.project),
		...railsPaths,
	].sort(sortUtf8);
}

function pathFailure(
	result: Result<Uint8Array>,
	path: string,
): ShapeValidationOutcome {
	if (!result.ok && result.error.code === "not_found")
		return { kind: "finish_guard", missingPaths: [path] };
	return terminalFailure(
		"environment",
		"environment/shape_read_failed",
		result.ok
			? "Filesystem returned an invalid read result."
			: result.error.message,
		3,
	);
}

function formatOutput(result: {
	readonly stdout: Uint8Array;
	readonly stderr: Uint8Array;
}): string {
	const stdout = decoder.decode(result.stdout);
	const stderr = decoder.decode(result.stderr);
	return [stdout, stderr].filter((part) => part.length > 0).join("\n");
}

function formatterInvocations(
	context: ShapeValidationWorkflowContext,
	intentPath: string,
	testPath: string,
): readonly FormatterInvocation[] {
	const project = context.project;
	const configured = project.format ?? context.adapter.formatter?.(project);
	if (configured === undefined || configured.length === 0) return [];
	const allPaths = [intentPath, testPath];
	const paths = context.adapter.formatterPaths?.(allPaths) ?? allPaths;
	if (paths.length === 0) return [];
	if (configured.some((argument) => argument.includes("{path}")))
		return paths.map((path, index) => ({
			argv: configured.map((argument) => argument.replaceAll("{path}", path)),
			step: `shape-format-${index + 1}`,
		}));
	return [
		{
			argv: [...configured, ...paths],
			step: "shape-format",
		},
	];
}

function isMissingFormatter(result: {
	readonly exitStatus: number | null;
	readonly timedOut: boolean;
	readonly error?: PortError;
	readonly log: { readonly stdout: Uint8Array; readonly stderr: Uint8Array };
}): boolean {
	if (result.error?.code === "unavailable") return true;
	if (result.exitStatus === 126 || result.exitStatus === 127) return true;
	const output = formatOutput(result.log);
	return /(?:command not found|not found|no such file or directory|is not installed)/iu.test(
		output,
	);
}

async function formatWrittenFiles(
	context: ShapeValidationWorkflowContext,
	state: ShapeValidationState,
	passNumber: number,
	intentPath: string,
	testPath: string,
	input: ShapeValidationInput,
): Promise<FormattedResult> {
	for (const invocation of formatterInvocations(
		context,
		intentPath,
		testPath,
	)) {
		const result = await runGateCommand({
			process: context.process,
			filesystem: context.filesystem,
			workdir: context.workdir,
			runDirectory: context.scratchDirectory,
			environment: context.environment,
			step: invocation.step,
			index: nextLogIndex(state),
			argv: invocation.argv,
			timeoutMilliseconds: SHAPE_FORMAT_TIMEOUT_MS,
		});
		if (!result.ok)
			return {
				unavailable: false,
				error: terminalFailure(
					"environment",
					"environment/shape_formatter_log_failed",
					result.error.message,
					3,
				),
			};
		if (isMissingFormatter(result.value)) {
			context.onProgress?.("formatter_unavailable", passNumber);
			return { unavailable: true, error: null };
		}
		if (result.value.timedOut)
			return {
				unavailable: false,
				error: candidateRepair(
					"formatter_timeout",
					`Configured formatter timed out after ${SHAPE_FORMAT_TIMEOUT_MS} ms.`,
					input,
					context,
				),
			};
		if (result.value.exitStatus !== 0)
			return {
				unavailable: false,
				error: candidateRepair(
					"formatter_failed",
					`Configured formatter exited ${String(result.value.exitStatus)}.\n${formatOutput(result.value.log)}`,
					input,
					context,
				),
			};
	}
	return { unavailable: false, error: null };
}

function nextLogIndex(state: ShapeValidationState): number {
	const index = state.logIndex;
	if (!Number.isSafeInteger(index) || index < 1 || index > 999_999)
		throw new RangeError("Shape validation log index is invalid.");
	state.logIndex = index + 1;
	return index;
}

function isToolUnavailable(result: {
	readonly exitStatus: number | null;
	readonly timedOut: boolean;
	readonly error?: PortError;
}): boolean {
	return (
		result.error?.code === "unavailable" ||
		result.exitStatus === null ||
		result.exitStatus === 126 ||
		result.exitStatus === 127
	);
}

function workspaceFailure(
	message: string,
	input: ShapeValidationInput,
	context: ShapeValidationWorkflowContext,
): ShapeValidationOutcome {
	return candidateRepair("tree_mutated", message, input, context);
}

async function restoreWorkspace(
	context: ShapeValidationWorkflowContext,
	snapshot: GateTreeSnapshot,
): Promise<Result<void>> {
	return context.workspace.restore(snapshot);
}

async function runAcceptanceChecks(
	context: ShapeValidationWorkflowContext,
	state: ShapeValidationState,
	input: ShapeValidationInput,
	candidatePath: string,
): Promise<ShapeValidationOutcome | null> {
	for (const check of context.project.acceptanceChecks) {
		const before = await context.workspace.snapshot();
		if (!before.ok)
			return terminalFailure(
				"environment",
				"environment/tree_snapshot_failed",
				before.error.message,
				3,
			);
		const argv = check.argv.map((argument) =>
			argument.replaceAll("{path}", candidatePath),
		);
		const observation = await runGateCommand({
			process: context.process,
			filesystem: context.filesystem,
			workdir: context.workdir,
			runDirectory: context.scratchDirectory,
			environment: context.environment,
			step: `shape-acceptance-check-${check.name}`,
			index: nextLogIndex(state),
			argv,
			timeoutMilliseconds: check.timeoutMs,
		});
		if (!observation.ok)
			return terminalFailure(
				"environment",
				"environment/acceptance_check_log_failed",
				observation.error.message,
				3,
			);
		const after = await context.workspace.snapshot();
		if (!after.ok)
			return terminalFailure(
				"environment",
				"environment/tree_snapshot_failed",
				after.error.message,
				3,
			);
		if (before.value.identity !== after.value.identity) {
			const restored = await restoreWorkspace(context, before.value);
			if (!restored.ok)
				return terminalFailure(
					"environment",
					"environment/tree_restore_failed",
					restored.error.message,
					3,
				);
			return workspaceFailure(
				`Acceptance check ${check.name} changed the candidate tree.`,
				input,
				context,
			);
		}
		if (observation.value.timedOut)
			return candidateRepair(
				"acceptance_check_timeout",
				`Acceptance check ${check.name} timed out after ${check.timeoutMs} ms.\n${formatOutput(observation.value.log)}`,
				input,
				context,
			);
		if (isToolUnavailable(observation.value))
			return terminalFailure(
				"environment",
				"environment/acceptance_check_unavailable",
				`Acceptance check ${check.name} is not available (exit ${String(observation.value.exitStatus)}).`,
				3,
			);
		if (observation.value.exitStatus !== 0)
			return candidateRepair(
				"acceptance_check_failed",
				`Acceptance check ${check.name} exited ${String(observation.value.exitStatus)}.\n${formatOutput(observation.value.log)}`,
				input,
				context,
			);
	}
	return null;
}

async function restoreStagedTest(
	context: ShapeValidationWorkflowContext,
	staged: StagedAcceptanceTest,
	bytes: Uint8Array,
): Promise<Result<void>> {
	const restoredSource = await context.filesystem.writeFileAtomically({
		root: context.workdir,
		path: staged.sourcePath,
		bytes,
		mode: 0o600,
	});
	if (!restoredSource.ok) return restoredSource;
	const removedCandidate = await context.filesystem.removeFile(
		context.workdir,
		staged.candidatePath,
	);
	if (!removedCandidate.ok && removedCandidate.error.code !== "not_found")
		return removedCandidate;
	return { ok: true, value: undefined };
}

function statusFailure(
	classification: string,
	message: string,
	context: ShapeValidationWorkflowContext,
	input: ShapeValidationInput,
): ShapeValidationOutcome {
	if (classification === "tool_missing")
		return terminalFailure(
			"environment",
			"environment/tool_missing",
			message,
			3,
		);
	return candidateRepair(classification, message, input, context);
}

function reclassifyIntent(
	bytes: Uint8Array,
	intent: ParsedIntent,
	items: readonly {
		readonly id: string;
		readonly status: "pass" | "fail";
		readonly rows: readonly { readonly status: string }[];
	}[],
): { readonly bytes: Uint8Array; readonly warnings: readonly ShapeWarning[] } {
	const itemById = new Map(items.map((item) => [item.id, item]));
	const changes: Array<{
		readonly line: number;
		readonly from: "test" | "test keep";
		readonly to: "test" | "test keep";
		readonly id: string;
	}> = [];
	for (const verify of intent.verify) {
		const result = itemById.get(verify.id);
		if (result === undefined) continue;
		if (verify.keep && result.status === "fail")
			changes.push({
				line: verify.line,
				from: "test keep",
				to: "test",
				id: verify.id,
			});
		else if (!verify.keep && result.status === "pass")
			changes.push({
				line: verify.line,
				from: "test",
				to: "test keep",
				id: verify.id,
			});
	}
	if (changes.length === 0) return { bytes, warnings: [] };
	const lines = splitByteLines(bytes);
	let result = bytes.slice();
	const appliedChanges: typeof changes = [];
	for (const change of [...changes].sort(
		(left, right) => right.line - left.line,
	)) {
		const line = lines[change.line - 1];
		if (line === undefined) continue;
		const rawLine = result.subarray(line.start, line.end);
		const marker = verifyKindRange(rawLine, change.id, change.from);
		if (marker === null) continue;
		appliedChanges.push(change);
		const start = marker.start;
		const before = rawLine.subarray(0, start);
		const after = rawLine.subarray(marker.end);
		const replacement = encoder.encode(change.to);
		const updated = new Uint8Array(
			before.byteLength + replacement.byteLength + after.byteLength,
		);
		updated.set(before, 0);
		updated.set(replacement, before.byteLength);
		updated.set(after, before.byteLength + replacement.byteLength);
		const complete = new Uint8Array(
			result.byteLength - rawLine.byteLength + updated.byteLength,
		);
		complete.set(result.subarray(0, line.start), 0);
		complete.set(updated, line.start);
		complete.set(result.subarray(line.end), line.start + updated.byteLength);
		result = complete;
	}
	const warnings: ShapeWarning[] = [];
	for (const direction of [
		{ from: "test keep" as const, to: "test" as const },
		{ from: "test" as const, to: "test keep" as const },
	]) {
		const ids = appliedChanges
			.filter((change) => change.from === direction.from)
			.map((change) => change.id);
		if (ids.length > 0)
			warnings.push({
				code: "shape_reclassified",
				item_ids: ids,
				message: `Items ${ids.join(", ")} changed from ${direction.from} to ${direction.to} based on acceptance results on the base.`,
			});
	}
	return { bytes: result, warnings };
}

function verifyKindRange(
	line: Uint8Array,
	id: string,
	kind: "test" | "test keep",
): { readonly start: number; readonly end: number } | null {
	const prefix = encoder.encode(`${id}:`);
	const colon = findBytes(line, prefix);
	if (colon < 0) return null;
	let start = colon + prefix.byteLength;
	while (line[start] === 0x20 || line[start] === 0x09) start += 1;
	const test = encoder.encode("test");
	for (let offset = 0; offset < test.byteLength; offset += 1)
		if (line[start + offset] !== test[offset]) return null;
	let end = start + test.byteLength;
	if (kind === "test keep") {
		while (line[end] === 0x20 || line[end] === 0x09) end += 1;
		const keep = encoder.encode("keep");
		for (let offset = 0; offset < keep.byteLength; offset += 1)
			if (line[end + offset] !== keep[offset]) return null;
		end += keep.byteLength;
	}
	return { start, end };
}

interface ByteLine {
	readonly start: number;
	readonly end: number;
}

function splitByteLines(bytes: Uint8Array): readonly ByteLine[] {
	const lines: ByteLine[] = [];
	let start = 0;
	for (let index = 0; index < bytes.byteLength; index += 1) {
		if (bytes[index] !== 0x0a) continue;
		lines.push({ start, end: index });
		start = index + 1;
	}
	lines.push({ start, end: bytes.byteLength });
	return lines;
}

function findBytes(haystack: Uint8Array, needle: Uint8Array): number {
	outer: for (
		let start = 0;
		start <= haystack.byteLength - needle.byteLength;
		start += 1
	) {
		for (let offset = 0; offset < needle.byteLength; offset += 1)
			if (haystack[start + offset] !== needle[offset]) continue outer;
		return start;
	}
	return -1;
}

function text(bytes: Uint8Array): string {
	return decoder.decode(bytes);
}

function requirementAuditMessage(input: {
	readonly requestBytes: Uint8Array;
	readonly intentBytes: Uint8Array;
	readonly items: readonly IntentAcceptanceItem[];
}): string {
	return [
		"Enumerate every atomic Request constraint and map each to an Acceptance id or an explicit untestable reason.",
		"Request:",
		text(input.requestBytes),
		"Intent:",
		text(input.intentBytes),
		"Acceptance ids:",
		...input.items.map((item) => `${item.id}: ${item.text}`),
		'Return JSON only: {"rows":[{"constraint":string,"maps_to":string}]}',
	].join("\n\n");
}

function testAuditMessage(input: {
	readonly requestBytes: Uint8Array;
	readonly intentBytes: Uint8Array;
	readonly testBytes: Uint8Array;
	readonly items: readonly IntentAcceptanceItem[];
	readonly baseRows: readonly {
		readonly id: string;
		readonly status: string;
		readonly rows: readonly unknown[];
	}[];
}): string {
	return [
		"Determine whether each acceptance test follows the Request. A citation must be an exact non-empty substring of the Request; advice never changes the test result.",
		"Request:",
		text(input.requestBytes),
		"Intent:",
		text(input.intentBytes),
		"Acceptance test source:",
		text(input.testBytes),
		"Each item's test output on the unchanged base:",
		JSON.stringify(input.baseRows),
		"Acceptance items:",
		...input.items.map((item) => `${item.id}: ${item.text}`),
		'Return JSON only: {"items":[{"id":string,"verdict":"valid|over_strict|infeasible","citation":string,"reason":string}]}',
	].join("\n\n");
}

function providerFailure(
	result: Extract<RespondResult, { kind: "stopped" }>,
): ShapeValidationOutcome {
	return terminalFailure(
		"provider",
		result.reason,
		result.error.message,
		result.exitCode,
	);
}

interface AuditCallResult {
	readonly response: RespondResult | null;
	readonly failure: ShapeValidationOutcome | null;
}

async function requestAuditor(
	input: ShapeValidationInput,
	context: ShapeValidationWorkflowContext,
	kind: "requirement" | "test",
	message: string,
): Promise<AuditCallResult> {
	try {
		const session = createShapeAuditSession({
			source: input.session,
			role: context.auditorRole,
			passNumber: input.passNumber,
			kind,
			message,
		});
		return {
			response: await input.requestModel(session, context.auditorRole),
			failure: null,
		};
	} catch (cause) {
		return {
			response: null,
			failure: terminalFailure(
				"environment",
				"environment/shape_audit_failed",
				cause instanceof Error ? cause.message : "Shape audit request failed.",
				3,
			),
		};
	}
}

async function readShapeFiles(context: ShapeValidationWorkflowContext): Promise<
	| {
			readonly ok: true;
			readonly intentBytes: Uint8Array;
			readonly testBytes: Uint8Array;
			readonly intentPath: string;
			readonly sourceTestPath: string;
			readonly candidateTestPath: string;
	  }
	| { readonly ok: false; readonly outcome: ShapeValidationOutcome }
> {
	let sourceTestPath: string;
	let candidateTestPath: string;
	try {
		sourceTestPath = context.adapter.sourcePath(context.slug);
		candidateTestPath = context.adapter.candidatePath(context.slug);
	} catch (cause) {
		return {
			ok: false,
			outcome: terminalFailure(
				"environment",
				"environment/shape_adapter_invalid",
				cause instanceof Error
					? cause.message
					: "Acceptance adapter rejected the slug.",
				3,
			),
		};
	}
	const intentPath = `.kogen/intents/${context.slug}/intent.md`;
	const intentResult = await context.filesystem.readFile({
		root: context.workdir,
		path: intentPath,
		maxBytes: SHAPE_SOURCE_MAX_BYTES,
	});
	if (!intentResult.ok)
		return { ok: false, outcome: pathFailure(intentResult, intentPath) };
	const testResult = await context.filesystem.readFile({
		root: context.workdir,
		path: sourceTestPath,
		maxBytes: SHAPE_SOURCE_MAX_BYTES,
	});
	if (!testResult.ok)
		return { ok: false, outcome: pathFailure(testResult, sourceTestPath) };
	return {
		ok: true,
		intentBytes: intentResult.value,
		testBytes: testResult.value,
		intentPath,
		sourceTestPath,
		candidateTestPath,
	};
}

async function writeIntent(
	context: ShapeValidationWorkflowContext,
	path: string,
	bytes: Uint8Array,
): Promise<Result<void>> {
	return context.filesystem.writeFileAtomically({
		root: context.workdir,
		path,
		bytes,
		mode: 0o600,
	});
}

function lintWarnings(
	issues: readonly {
		readonly rule: string;
		readonly message: string;
		readonly severity: string;
	}[],
): readonly ShapeWarning[] {
	return issues
		.filter((issue) => issue.severity === "style")
		.map((issue) => ({
			code: `lint_${issue.rule}`,
			item_ids: [],
			message: issue.message,
		}));
}

function parseIntentFailure(
	errors: readonly { readonly line: number; readonly message: string }[],
): string {
	return errors.map((item) => `line ${item.line}: ${item.message}`).join("\n");
}

function isShapeValidationState(
	value: ShapeValidationState | undefined,
): ShapeValidationState {
	return value ?? createShapeValidationState();
}

/**
 * Build the production validation callback consumed by `runShape`. All
 * effects remain explicit, and the provided adapter is the one selected by
 * project/checkout adapter resolution.
 */
export function createShapeValidationWorkflow(
	context: ShapeValidationWorkflowContext,
): (input: ShapeValidationInput) => Promise<ShapeValidationOutcome> {
	const state = isShapeValidationState(context.state);
	return (input) => validateShapePass(input, { ...context, state }, state);
}

export async function validateShapePass(
	input: ShapeValidationInput,
	contextInput: ShapeValidationWorkflowContext,
	stateInput?: ShapeValidationState,
): Promise<ShapeValidationOutcome> {
	const state = stateInput ?? isShapeValidationState(contextInput.state);
	const context = { ...contextInput, state };
	const adapterMatches =
		context.adapter.name === context.project.acceptance.adapter;
	if (
		!context.workdir.startsWith("/") ||
		!context.scratchDirectory.startsWith("/") ||
		context.workdir.includes("\0") ||
		context.scratchDirectory.includes("\0") ||
		!adapterMatches
	) {
		return terminalFailure(
			"environment",
			"environment/shape_configuration_invalid",
			"Shape requires absolute work/run paths and the configured acceptance adapter.",
			3,
		);
	}
	if (!state.artifactsCleared) {
		const cleared = await clearStaleShapeArtifacts(
			context.filesystem,
			context.workdir,
			context.slug,
		);
		if (!cleared.ok)
			return terminalFailure(
				"environment",
				"environment/shape_artifact_cleanup_failed",
				cleared.error.message,
				3,
			);
		state.artifactsCleared = true;
	}
	if (
		context.auditorRole.name !== "auditor" ||
		!Number.isSafeInteger(input.passNumber) ||
		input.passNumber < 1 ||
		input.conversationId.length === 0
	)
		return terminalFailure(
			"environment",
			"environment/shape_configuration_invalid",
			"Shape auditor role or pass number is invalid.",
			3,
		);

	let staged: StagedAcceptanceTest | null = null;
	let stagedBytes: Uint8Array | null = null;
	let outcome: ShapeValidationOutcome | null = null;
	try {
		const loaded = await readShapeFiles(context);
		if (!loaded.ok) return loaded.outcome;
		let intentBytes = normalizeIntentBytes(
			loaded.intentBytes,
			context.requestBytes,
		);
		let testBytes: Uint8Array = loaded.testBytes.slice();
		if (!bytesEqual(intentBytes, loaded.intentBytes)) {
			const written = await writeIntent(
				context,
				loaded.intentPath,
				intentBytes,
			);
			if (!written.ok)
				return terminalFailure(
					"environment",
					"environment/shape_normalize_failed",
					written.error.message,
					3,
				);
		}

		let parsed = parseIntent(intentBytes);
		if (!parsed.ok)
			return candidateRepair(
				"intent_parse_failed",
				parseIntentFailure(parsed.errors),
				input,
				context,
			);
		let intent = parsed.intent;
		const lint = lintIntent(intent, {
			shaping: true,
			gatePaths: effectiveGatePaths(context),
			acceptanceTest: testBytes,
		});
		const lintErrors = lint.filter(
			(issue) =>
				issue.severity === "error" && issue.rule !== "undeclared_gate_path",
		);
		if (lintErrors.length > 0)
			return candidateRepair(
				"intent_lint_failed",
				lintErrors.map(renderIntentLintFinding).join("\n"),
				input,
				context,
			);
		const styleIssues = lint.filter((issue) => issue.severity === "style");
		if (
			styleIssues.length > 0 &&
			input.accounting.canRepairStyle(input.conversationId)
		)
			return {
				kind: "style_repair",
				feedback: styleIssues.map(renderIntentLintFinding).join("\n"),
			};
		const warnings: ShapeWarning[] = [...lintWarnings(styleIssues)];
		const undeclaredGate = lint.find(
			(issue) => issue.rule === "undeclared_gate_path",
		);
		if (undeclaredGate !== undefined)
			return candidateRepair(
				"undeclared_gate_path",
				undeclaredGate.message,
				input,
				context,
			);

		const formatted = await formatWrittenFiles(
			context,
			state,
			input.passNumber,
			loaded.intentPath,
			loaded.sourceTestPath,
			input,
		);
		if (formatted.error !== null) return formatted.error;
		if (formatted.unavailable)
			warnings.push({
				code: "formatter_unavailable",
				item_ids: [],
				message: "Configured formatter is not available.",
			});

		const formattedIntent = await context.filesystem.readFile({
			root: context.workdir,
			path: loaded.intentPath,
			maxBytes: SHAPE_SOURCE_MAX_BYTES,
		});
		const formattedTest = await context.filesystem.readFile({
			root: context.workdir,
			path: loaded.sourceTestPath,
			maxBytes: SHAPE_SOURCE_MAX_BYTES,
		});
		if (!formattedIntent.ok || !formattedTest.ok)
			return terminalFailure(
				"environment",
				"environment/shape_format_read_failed",
				!formattedIntent.ok
					? formattedIntent.error.message
					: !formattedTest.ok
						? formattedTest.error.message
						: "Formatted files could not be read.",
				3,
			);
		intentBytes = formattedIntent.value;
		testBytes = formattedTest.value;
		parsed = parseIntent(intentBytes);
		if (!parsed.ok)
			return candidateRepair(
				"intent_parse_failed",
				parseIntentFailure(parsed.errors),
				input,
				context,
			);
		intent = parsed.intent;

		const stageResult = await context.adapter.stage({
			filesystem: context.filesystem,
			sourceRoot: context.workdir,
			workdir: context.workdir,
			slug: context.slug,
		});
		if (!stageResult.ok)
			return candidateRepair(
				"acceptance_stage_failed",
				stageResult.error.message,
				input,
				context,
			);
		staged = stageResult.value;
		stagedBytes = testBytes.slice();
		outcome = await validateStagedAcceptance({
			input,
			context,
			state,
			intent,
			intentBytes,
			testBytes,
			staged,
			warnings,
		});
	} catch (cause) {
		outcome = terminalFailure(
			"environment",
			"environment/shape_validation_failed",
			cause instanceof Error ? cause.message : "Shape validation failed.",
			3,
		);
	}

	if (staged !== null && stagedBytes !== null) {
		const restored = await restoreStagedTest(context, staged, stagedBytes);
		if (!restored.ok)
			return terminalFailure(
				"environment",
				"environment/shape_stage_restore_failed",
				restored.error.message,
				3,
			);
	}
	return (
		outcome ??
		terminalFailure(
			"environment",
			"environment/shape_validation_incomplete",
			"Shape validation produced no outcome.",
			3,
		)
	);
}

async function validateStagedAcceptance(input: {
	readonly input: ShapeValidationInput;
	readonly context: ShapeValidationWorkflowContext;
	readonly state: ShapeValidationState;
	readonly intent: ParsedIntent;
	readonly intentBytes: Uint8Array;
	readonly testBytes: Uint8Array;
	readonly staged: StagedAcceptanceTest;
	readonly warnings: ShapeWarning[];
}): Promise<ShapeValidationOutcome> {
	const { input: validation, context, state } = input;
	const checkOutcome = await runAcceptanceChecks(
		context,
		state,
		validation,
		input.staged.candidatePath,
	);
	if (checkOutcome !== null) return checkOutcome;

	const beforeTests = await context.workspace.snapshot();
	if (!beforeTests.ok)
		return terminalFailure(
			"environment",
			"environment/tree_snapshot_failed",
			beforeTests.error.message,
			3,
		);
	const baseResult = await runAcceptanceLedger({
		adapter: context.adapter,
		process: context.process,
		filesystem: context.filesystem,
		tree: {
			async snapshot() {
				const snapshot = await context.workspace.snapshot();
				return snapshot.ok
					? { ok: true, value: snapshot.value.identity }
					: snapshot;
			},
		},
		workdir: context.workdir,
		slug: context.slug,
		itemIds: input.intent.acceptance.map((item) => item.id),
		reportDirectory: context.scratchDirectory,
		reportFilename: LEDGER_REPORT_FILENAME,
		environment: context.environment,
		timeoutMilliseconds: context.project.acceptance.timeoutMs,
	});
	if (!baseResult.ok)
		return terminalFailure(
			"environment",
			"environment/shape_acceptance_failed",
			baseResult.error.message,
			3,
		);
	if (baseResult.value.treeBefore !== baseResult.value.treeAfter) {
		const restored = await restoreWorkspace(context, beforeTests.value);
		return restored.ok
			? workspaceFailure(
					"Acceptance runner changed the candidate tree.",
					validation,
					context,
				)
			: terminalFailure(
					"environment",
					"environment/tree_restore_failed",
					restored.error.message,
					3,
				);
	}
	const environmentFailure = baseResult.value.failures.find(
		(item) => item.scope === "environment",
	);
	if (environmentFailure !== undefined)
		return statusFailure(
			environmentFailure.classification,
			environmentFailure.message,
			context,
			validation,
		);
	const candidateFailure = baseResult.value.failures.find(
		(item) => item.scope === "candidate",
	);
	if (candidateFailure !== undefined)
		return statusFailure(
			candidateFailure.classification,
			candidateFailure.message,
			context,
			validation,
		);

	const reclassified = reclassifyIntent(
		input.intentBytes,
		input.intent,
		baseResult.value.items,
	);
	let intentBytes = input.intentBytes;
	let intent = input.intent;
	if (!bytesEqual(reclassified.bytes, intentBytes)) {
		const written = await writeIntent(
			context,
			`.kogen/intents/${context.slug}/intent.md`,
			reclassified.bytes,
		);
		if (!written.ok)
			return terminalFailure(
				"environment",
				"environment/shape_reclassification_failed",
				written.error.message,
				3,
			);
		intentBytes = reclassified.bytes;
		input.warnings.push(...reclassified.warnings);
		const parsed = parseIntent(intentBytes);
		if (!parsed.ok)
			return candidateRepair(
				"intent_parse_failed",
				parseIntentFailure(parsed.errors),
				validation,
				context,
			);
		intent = parsed.intent;
	}
	const baseItems = new Map(
		baseResult.value.items.map((item) => [item.id, item]),
	);
	const hasRedChangeItem = intent.verify.some(
		(verify) => !verify.keep && baseItems.get(verify.id)?.status === "fail",
	);
	if (!hasRedChangeItem)
		return candidateRepair(
			"all_items_keep",
			"At least one test item must fail on the unchanged base.",
			validation,
			context,
		);

	const requirementCall = await requestAuditor(
		validation,
		context,
		"requirement",
		requirementAuditMessage({
			requestBytes: context.requestBytes,
			intentBytes,
			items: intent.acceptance,
		}),
	);
	const requirement =
		requirementCall.response?.kind === "completed"
			? parseShapeRequirementLedger(
					requirementCall.response.response.text,
					context.requestBytes,
					intent.acceptance,
				)
			: {
					rows: [] as readonly ShapeRequirementLedgerRow[],
					gaps: [
						(requirementCall.failure?.kind === "failure"
							? requirementCall.failure.failure.message
							: null) ??
							(requirementCall.response === null
								? "Requirement audit did not return a response."
								: `Requirement audit stopped: ${requirementCall.response.kind}.`),
					],
				};
	let ledgerWrite: Result<void>;
	try {
		ledgerWrite = await writeShapeLedgerArtifact(
			context.filesystem,
			context.workdir,
			context.slug,
			createShapeLedgerArtifact({
				intentBytes,
				acceptanceBytes: input.testBytes,
				rows: requirement.rows,
			}),
		);
	} catch (cause) {
		ledgerWrite = {
			ok: false,
			error: error(
				"io",
				cause instanceof Error
					? cause.message
					: "Shape ledger artifact write failed.",
			),
		};
	}

	// The test auditor always runs after an eligible traversal, even when the
	// ledger has missing coverage or its artifact could not be published.
	const testCall = await requestAuditor(
		validation,
		context,
		"test",
		testAuditMessage({
			requestBytes: context.requestBytes,
			intentBytes,
			testBytes: input.testBytes,
			items: intent.acceptance,
			baseRows: baseResult.value.items,
		}),
	);
	const expectedIds = intent.acceptance.map((item) => item.id);
	const parsedAudit =
		testCall.response?.kind === "completed"
			? parseShapeTestAudit(
					testCall.response.response.text,
					expectedIds,
					context.requestBytes,
					state.testAuditRepairUsed,
				)
			: {
					repairs: [],
					warnings: [
						{
							code: "audit_invalid",
							item_ids: expectedIds,
							message:
								(testCall.failure?.kind === "failure"
									? testCall.failure.failure.message
									: null) ??
								(testCall.response === null
									? "Test audit did not return a response."
									: `Test audit stopped: ${testCall.response.kind}.`),
						},
					],
				};

	if (!ledgerWrite.ok)
		return terminalFailure(
			"environment",
			"environment/shape_ledger_write_failed",
			ledgerWrite.error.message,
			3,
		);
	const auditFailure =
		auditCallFailure(requirementCall) ?? auditCallFailure(testCall);
	if (auditFailure !== null) return auditFailure;

	const needsCoverageRepair =
		requirement.gaps.length > 0 && !state.coverageRepairUsed;
	const needsTestAuditRepair =
		parsedAudit.repairs.length > 0 && !state.testAuditRepairUsed;
	if (requirement.gaps.length > 0 && !needsCoverageRepair)
		input.warnings.push({
			code: "coverage_gap",
			item_ids: [],
			message: requirement.gaps.join("; "),
		});
	input.warnings.push(...parsedAudit.warnings);
	if (needsCoverageRepair || needsTestAuditRepair) {
		const feedback: string[] = [];
		if (needsCoverageRepair) {
			state.coverageRepairUsed = true;
			feedback.push(`Coverage gaps: ${requirement.gaps.join("; ")}`);
		}
		if (needsTestAuditRepair) {
			state.testAuditRepairUsed = true;
			feedback.push(
				`Test audit findings: ${parsedAudit.repairs
					.map(
						(item) =>
							`${item.id} ${item.verdict}: ${item.reason}${item.citation.length > 0 ? ` (Request citation: ${item.citation})` : ""}`,
					)
					.join("; ")}`,
			);
		}
		const reason = needsCoverageRepair ? "coverage_gap" : "test_audit";
		const repairKind =
			needsCoverageRepair && needsTestAuditRepair
				? "combined"
				: needsCoverageRepair
					? "coverage"
					: "test_audit";
		return candidateRepair(
			reason,
			feedback.join("\n\n"),
			validation,
			context,
			repairKind,
		);
	}

	input.warnings.push(...parseConcerns(validation.finalResponseText));
	const warningArtifact = createShapeWarningsArtifact({
		intentBytes,
		acceptanceBytes: input.testBytes,
		warnings: input.warnings,
	});
	const warningWrite = await writeShapeWarningsArtifact(
		context.filesystem,
		context.workdir,
		context.slug,
		warningArtifact,
	);
	if (!warningWrite.ok)
		return terminalFailure(
			"environment",
			"environment/shape_warnings_write_failed",
			warningWrite.error.message,
			3,
		);
	return { kind: "valid", warnings: input.warnings };
}

function auditCallFailure(
	call: AuditCallResult,
): ShapeValidationOutcome | null {
	if (call.failure !== null) return call.failure;
	const response = call.response;
	if (response === null)
		return terminalFailure(
			"environment",
			"environment/shape_audit_failed",
			"Audit returned no response.",
			3,
		);
	if (response.kind === "stopped") return providerFailure(response);
	if (response.kind === "cancelled")
		return terminalFailure(
			"environment",
			"environment/shape_cancelled",
			"Shaping was interrupted.",
			130,
		);
	if (response.kind === "budget_exhausted")
		return terminalFailure(
			"environment",
			"environment/shape_audit_budget_unexpected",
			"Shape auditor unexpectedly received a wall budget.",
			3,
		);
	return null;
}

function parseConcerns(value: string): readonly ShapeWarning[] {
	const lines = value.replace(/\r\n?/gu, "\n").split("\n");
	const warnings: ShapeWarning[] = [];
	let inConcerns = false;
	const seen = new Set<string>();
	for (const line of lines) {
		if (/^\s*Concerns:\s*$/u.test(line)) {
			inConcerns = true;
			continue;
		}
		if (inConcerns && /^-\s+/u.test(line)) {
			const concern = line.replace(/^-\s+/u, "");
			if (concern.length > 0 && !seen.has(concern)) {
				seen.add(concern);
				warnings.push({
					code: "feasibility_concern",
					item_ids: [],
					message: concern,
				});
			}
			continue;
		}
		if (inConcerns) break;
	}
	return warnings;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index += 1)
		if (left[index] !== right[index]) return false;
	return true;
}
