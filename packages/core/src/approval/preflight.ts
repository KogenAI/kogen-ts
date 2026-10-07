import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { AcceptanceAdapter } from "../adapters/interface";
import type { PortError, Result } from "../contracts/errors";
import type { FileSystemPort, ProcessPort } from "../contracts/ports";
import { FILESYSTEM_MAX_RESPONSE_BYTES } from "../fs/read";
import {
	type GateCommandObservation,
	type GateTreePort,
	type GateTreeSnapshot,
	runGateCommand,
} from "../gate/checks";
import { parseGateFindings } from "../gate/findings";
import { hashApprovalBytes } from "../intent/hash";
import { lintIntent } from "../intent/lint";
import { type ParsedIntent, parseIntent } from "../intent/parse";
import type { CheckSpec } from "../project/schema";
import {
	type ApprovalCardWarning,
	type ApprovalCheckBaseline,
	renderApprovalCard,
	renderApprovalWarnings,
} from "./card";

const MAX_SOURCE_BYTES = FILESYSTEM_MAX_RESPONSE_BYTES - 1;
const SHAPE_WARNINGS_PATH = (slug: string): string =>
	`.kogen/intents/${slug}/shape-warnings.json`;
const SHA256 = /^[0-9a-f]{64}$/u;
const APPROVAL_HASH_PREFIX = /^[0-9a-f]{6,64}$/u;

export interface ApprovalScratchWorkspace {
	readonly path: string;
	/** Tree of the checked-out base commit before setup products are created. */
	readonly baseTree: string;
	readonly tree: GateTreePort;
	/** Remove only after the preflight snapshot has been restored successfully. */
	remove(): Promise<Result<void>>;
}

export interface ApprovalWorkspacePort {
	readonly checkoutPath: string;
	readonly checkoutTree: GateTreePort;
	/** Create an isolated checkout of baseCommit outside the user checkout. */
	createScratch(request: {
		readonly baseCommit: string;
		readonly expectedTree: string;
		readonly scratchRoot: string;
		readonly slug: string;
	}): Promise<Result<ApprovalScratchWorkspace>>;
}

export interface ApprovalBaselineKeyInput {
	readonly checkedBaseTree: string | null;
	readonly setupKey: string | null;
	readonly checks: readonly CheckSpec[];
	readonly childEnv: Readonly<Record<string, string>> | null;
	readonly toolchain: Readonly<Record<string, string>> | null;
	readonly os: string | null;
	readonly arch: string | null;
	readonly adapterVersion: string | null;
}

export interface ApprovalBaselineCacheEntry {
	readonly key: string;
	readonly checkedBaseTree: string;
	readonly checks: readonly ApprovalCheckBaseline[];
}

/** The cache contract carries the base tree separately from its digest. */
export interface ApprovalBaselineCachePort {
	get(request: {
		readonly key: string;
		readonly checkedBaseTree: string;
	}): Promise<Result<ApprovalBaselineCacheEntry | null>>;
	put(entry: ApprovalBaselineCacheEntry): Promise<Result<void>>;
}

export interface ApprovalPreflightRequest {
	readonly slug: string;
	readonly intentPath: string;
	readonly checkoutPath?: string;
	readonly base: string;
	readonly baseCommit: string;
	readonly baseTree: string;
	readonly approver: string;
	readonly expectedHash?: string;
	readonly scratchRoot: string;
	readonly runDirectory: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly project: {
		readonly setup: readonly CheckSpec[];
		readonly checks: readonly CheckSpec[];
		readonly acceptanceChecks: readonly CheckSpec[];
	};
	readonly setupKey: string | null;
	readonly baselineIdentity: {
		readonly childEnv: Readonly<Record<string, string>> | null;
		readonly toolchain: Readonly<Record<string, string>> | null;
		readonly os: string | null;
		readonly arch: string | null;
		readonly adapterVersion: string | null;
	};
	readonly adapter: AcceptanceAdapter;
	readonly process: Pick<ProcessPort, "run">;
	readonly filesystem: Pick<
		FileSystemPort,
		"readFile" | "writeFileAtomically" | "removeFile"
	>;
	readonly workspace: ApprovalWorkspacePort;
	readonly baselineCache?: ApprovalBaselineCachePort;
}

export interface ApprovalPreflightSuccess {
	readonly kind: "card" | "ready_to_approve";
	readonly exitCode: 0 | 5;
	readonly approvalSha256: string;
	readonly intentSha256: string;
	readonly checkedBaseTree: string;
	readonly checkBaseline: readonly ApprovalCheckBaseline[];
	readonly acceptanceChecks: readonly ApprovalAcceptanceCheck[];
	readonly warnings: readonly ApprovalCardWarning[];
	readonly warningText: string;
	readonly card: string | null;
	readonly baselineCacheKey: string | null;
	readonly baselineCacheHit: boolean;
	readonly checkoutTree: string;
	readonly checkedInScratch: true;
}

export interface ApprovalAcceptanceCheck {
	readonly name: string;
	readonly status: "green" | "red" | "unavailable" | "timeout";
	readonly exit_status: number | null;
	readonly timed_out: boolean;
	readonly stdout: Uint8Array;
	readonly stderr: Uint8Array;
}

export interface ApprovalPreflightFailure {
	readonly code: string;
	readonly exitCode: 1 | 3;
	readonly message: string;
	readonly details?: readonly string[];
}

type ApprovalResult = Result<
	ApprovalPreflightSuccess,
	ApprovalPreflightFailure
>;

function failure(
	code: string,
	message: string,
	exitCode: 1 | 3,
	details?: readonly string[],
): ApprovalPreflightFailure {
	return {
		code,
		exitCode,
		message,
		...(details === undefined || details.length === 0 ? {} : { details }),
	};
}

function utf8Compare(left: string, right: string): number {
	const encoder = new TextEncoder();
	const a = encoder.encode(left);
	const b = encoder.encode(right);
	for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return a.length - b.length;
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value))
		return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort(utf8Compare)
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

function validGitObjectId(value: string | null): value is string {
	return value !== null && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
}

function knownStringMap(
	value: Readonly<Record<string, string>> | null,
): value is Readonly<Record<string, string>> {
	return (
		value !== null &&
		Object.entries(value).every(
			([key, entry]) =>
				key.length > 0 && typeof entry === "string" && !entry.includes("\0"),
		)
	);
}

/** Return null unless every check-affecting identity is known. */
export function approvalBaselineCacheKey(
	input: ApprovalBaselineKeyInput,
): string | null {
	if (
		!validGitObjectId(input.checkedBaseTree) ||
		input.setupKey === null ||
		input.setupKey.length === 0 ||
		!knownStringMap(input.childEnv) ||
		!knownStringMap(input.toolchain) ||
		input.os === null ||
		input.os.length === 0 ||
		input.arch === null ||
		input.arch.length === 0 ||
		input.adapterVersion === null ||
		input.adapterVersion.length === 0
	)
		return null;
	const material = {
		v: 3,
		checked_base_tree: input.checkedBaseTree,
		setup_key: input.setupKey,
		checks: input.checks.map((check) => ({
			name: check.name,
			argv: [...check.argv],
			timeout_ms: check.timeoutMs,
		})),
		child_env: input.childEnv,
		toolchain: input.toolchain,
		os: input.os,
		arch: input.arch,
		adapter_version: input.adapterVersion,
	};
	return createHash("sha256")
		.update(canonicalJson(material), "utf8")
		.digest("hex");
}

async function readSource(
	filesystem: Pick<FileSystemPort, "readFile">,
	root: string,
	path: string,
): Promise<Result<Uint8Array>> {
	return filesystem.readFile({ root, path, maxBytes: MAX_SOURCE_BYTES });
}

function sourceReadFailure(
	label: string,
	error: PortError,
): ApprovalPreflightFailure {
	if (error.code === "not_found")
		return failure(
			label === "Intent" ? "intent/not_found" : "intent/test_not_found",
			`${label} file does not exist.`,
			1,
		);
	return failure(
		"environment/approval_source_unavailable",
		`Could not read the ${label.toLowerCase()} file: ${error.message}`,
		3,
	);
}

function decodeLines(bytes: Uint8Array): readonly string[] {
	return new TextDecoder()
		.decode(bytes)
		.split(/\r?\n/u)
		.filter(Boolean)
		.slice(0, 20);
}

function commandDetails(
	stdout: Uint8Array,
	stderr: Uint8Array,
): readonly string[] {
	return [...decodeLines(stdout), ...decodeLines(stderr)].slice(0, 20);
}

function validWarningCode(code: unknown): code is string {
	return (
		typeof code === "string" &&
		/^(?:shape_reclassified|feasibility_concern|lint_[a-z0-9_]+|audit_[a-z0-9_]+|coverage_gap)$/u.test(
			code,
		)
	);
}

function singleLine(value: string): string {
	return [...value]
		.map((character) => {
			const code = character.charCodeAt(0);
			return code < 0x20 || code === 0x7f ? " " : character;
		})
		.join("")
		.trim();
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index += 1)
		if (left[index] !== right[index]) return false;
	return true;
}

function isSafeRelativePath(path: string): boolean {
	return (
		path.length > 0 &&
		!path.startsWith("/") &&
		!path.includes("\\") &&
		!path.includes("\0") &&
		path
			.split("/")
			.every((part) => part.length > 0 && part !== "." && part !== "..")
	);
}

function readShapeWarnings(
	bytes: Uint8Array | null,
	approvalSha256: string,
): readonly ApprovalCardWarning[] {
	if (bytes === null) return [];
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		return [];
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return [];
	const record = value as Record<string, unknown>;
	if (
		record.approval_sha256 !== approvalSha256 ||
		!Array.isArray(record.warnings)
	)
		return [];
	const warnings: ApprovalCardWarning[] = [];
	for (const entry of record.warnings) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry))
			continue;
		const warning = entry as Record<string, unknown>;
		if (
			!validWarningCode(warning.code) ||
			!Array.isArray(warning.item_ids) ||
			!warning.item_ids.every((item) => /^A[1-9][0-9]*$/u.test(String(item))) ||
			typeof warning.message !== "string"
		)
			continue;
		warnings.push({
			code: warning.code,
			itemIds: warning.item_ids as string[],
			message: singleLine(warning.message),
		});
	}
	return warnings;
}

function validBaselineRows(
	rows: readonly ApprovalCheckBaseline[],
	checks: readonly CheckSpec[],
): boolean {
	return (
		rows.length === checks.length &&
		rows.every((row, index) => {
			const expected = checks[index];
			return (
				expected !== undefined &&
				row.name === expected.name &&
				(row.status === "green" ||
					row.status === "red" ||
					row.status === "unavailable" ||
					row.status === "timeout" ||
					row.status === "mutating") &&
				(row.exit_status === null || Number.isSafeInteger(row.exit_status)) &&
				Array.isArray(row.findings)
			);
		})
	);
}

function toCacheFinding(value: {
	readonly path: string;
	readonly rule: string;
	readonly symbol: string;
	readonly message: string;
	readonly line: number;
	readonly column: number;
}): ApprovalCheckBaseline["findings"][number] {
	return {
		path: value.path,
		rule: value.rule,
		symbol: value.symbol,
		message: value.message,
		line: value.line,
	};
}

function approvalBaselineKeyInput(
	request: ApprovalPreflightRequest,
): ApprovalBaselineKeyInput {
	return {
		checkedBaseTree: request.baseTree,
		setupKey: request.setupKey,
		checks: request.project.checks,
		...request.baselineIdentity,
	};
}

function baselineFromCache(
	entry: ApprovalBaselineCacheEntry | null,
	key: string,
	baseTree: string,
	checks: readonly CheckSpec[],
): readonly ApprovalCheckBaseline[] | null {
	if (
		entry === null ||
		entry.key !== key ||
		entry.checkedBaseTree !== baseTree ||
		!validBaselineRows(entry.checks, checks)
	)
		return null;
	return entry.checks;
}

function gateFailure(code: string, message: string): ApprovalPreflightFailure {
	return failure(code, message, 3);
}

async function runApprovalCheck(
	request: ApprovalPreflightRequest,
	workdir: string,
	index: number,
	check: CheckSpec,
	stable: GateTreeSnapshot,
	tree: GateTreePort,
): Promise<Result<ApprovalCheckBaseline, ApprovalPreflightFailure>> {
	const before = await tree.snapshot();
	if (!before.ok)
		return {
			ok: false,
			error: gateFailure(
				"environment/check_snapshot_failed",
				before.error.message,
			),
		};
	if (before.value.identity !== stable.identity) {
		const restored = await tree.restore(stable);
		if (!restored.ok)
			return {
				ok: false,
				error: gateFailure(
					"environment/check_restore_failed",
					restored.error.message,
				),
			};
	}
	const cleanBefore =
		before.value.identity === stable.identity ? before : await tree.snapshot();
	if (!cleanBefore.ok)
		return {
			ok: false,
			error: gateFailure(
				"environment/check_snapshot_failed",
				cleanBefore.error.message,
			),
		};
	const command = await runGateCommand({
		process: request.process,
		filesystem: request.filesystem,
		workdir,
		runDirectory: request.runDirectory,
		environment: request.environment,
		step: `approval/${check.name}`,
		index,
		argv: check.argv,
		timeoutMilliseconds: check.timeoutMs,
	});
	if (!command.ok)
		return {
			ok: false,
			error: gateFailure("environment/check_log_failed", command.error.message),
		};
	const after = await tree.snapshot();
	if (!after.ok)
		return {
			ok: false,
			error: gateFailure(
				"environment/check_snapshot_failed",
				after.error.message,
			),
		};
	const mutated = cleanBefore.value.identity !== after.value.identity;
	const timedOut = command.value.timedOut;
	const status = timedOut
		? "timeout"
		: mutated
			? "mutating"
			: command.value.exitStatus === null ||
					command.value.exitStatus === 126 ||
					command.value.exitStatus === 127 ||
					command.value.error?.code === "unavailable"
				? "unavailable"
				: command.value.exitStatus === 0
					? "green"
					: "red";
	const parsed = parseGateFindings(
		command.value.log.stdout,
		command.value.log.stderr,
		check.name,
	);
	const baseline: ApprovalCheckBaseline = {
		name: check.name,
		status,
		exit_status: command.value.exitStatus,
		findings: parsed.map(toCacheFinding),
	};
	if (after.value.identity !== stable.identity) {
		const restored = await tree.restore(stable);
		if (!restored.ok)
			return {
				ok: false,
				error: gateFailure(
					"environment/check_restore_failed",
					restored.error.message,
				),
			};
	}
	return { ok: true, value: baseline };
}

function commandExitFailure(
	stage: "setup" | "acceptance",
	name: string,
	command: { readonly ok: true; readonly value: GateCommandObservation },
): ApprovalPreflightFailure | null {
	const observation = command.value;
	if (
		stage === "acceptance" &&
		!observation.timedOut &&
		(observation.exitStatus === 126 ||
			observation.exitStatus === 127 ||
			observation.error?.code === "unavailable")
	)
		return failure(
			"environment/acceptance_check_unavailable",
			`Acceptance checker ${name} is unavailable.`,
			3,
			commandDetails(observation.log.stdout, observation.log.stderr),
		);
	if (
		observation.timedOut ||
		observation.exitStatus !== 0 ||
		observation.error !== undefined
	) {
		if (stage === "setup")
			return failure(
				"environment/setup_failed",
				`Setup ${name} failed (status=${String(observation.exitStatus)}, timed_out=${String(observation.timedOut)}).`,
				3,
				commandDetails(observation.log.stdout, observation.log.stderr),
			);
		return failure(
			"check/acceptance_check_failed",
			`Acceptance check ${name} failed`,
			1,
			commandDetails(observation.log.stdout, observation.log.stderr),
		);
	}
	return null;
}

function validateRequest(
	request: ApprovalPreflightRequest,
): ApprovalPreflightFailure | null {
	for (const [name, path] of [
		["checkout", request.checkoutPath ?? request.workspace.checkoutPath],
		["scratch", request.scratchRoot],
		["run", request.runDirectory],
	] as const) {
		if (!isAbsolute(path) || path.includes("\0"))
			return failure(
				"environment/approval_path_invalid",
				`Approval ${name} path must be absolute.`,
				3,
			);
	}
	if (
		!validGitObjectId(request.baseTree) ||
		!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(request.baseCommit)
	)
		return failure(
			"environment/base_identity_invalid",
			"Resolved approval base identity is invalid.",
			3,
		);
	if (
		request.expectedHash !== undefined &&
		!APPROVAL_HASH_PREFIX.test(request.expectedHash)
	)
		return failure(
			"intent/hash_mismatch",
			`Approval hash prefix is invalid; review it again with kogen intent approve ${request.slug}`,
			1,
		);
	return null;
}

function sourceIntentPath(request: ApprovalPreflightRequest): string {
	return request.intentPath;
}

async function loadShapeWarnings(
	request: ApprovalPreflightRequest,
	approvalSha256: string,
): Promise<readonly ApprovalCardWarning[]> {
	const result = await request.filesystem.readFile({
		root: request.checkoutPath ?? request.workspace.checkoutPath,
		path: SHAPE_WARNINGS_PATH(request.slug),
		maxBytes: MAX_SOURCE_BYTES,
	});
	if (!result.ok) return [];
	return readShapeWarnings(result.value, approvalSha256);
}

async function runInScratch(
	request: ApprovalPreflightRequest,
	testBytes: Uint8Array,
	approvalSha256: string,
	intentSha256: string,
	warnings: readonly ApprovalCardWarning[],
	parsedIntent: ParsedIntent,
): Promise<ApprovalResult> {
	const checkoutSnapshot = await request.workspace.checkoutTree.snapshot();
	if (!checkoutSnapshot.ok)
		return {
			ok: false,
			error: failure(
				"environment/checkout_tree_unavailable",
				checkoutSnapshot.error.message,
				3,
			),
		};
	let scratchResult: Result<ApprovalScratchWorkspace>;
	try {
		scratchResult = await request.workspace.createScratch({
			baseCommit: request.baseCommit,
			expectedTree: request.baseTree,
			scratchRoot: request.scratchRoot,
			slug: request.slug,
		});
	} catch (cause) {
		return {
			ok: false,
			error: failure(
				"environment/base_scratch_unavailable",
				cause instanceof Error
					? cause.message
					: "Could not create approval scratch.",
				3,
			),
		};
	}
	if (!scratchResult.ok)
		return {
			ok: false,
			error: failure(
				"environment/base_scratch_unavailable",
				scratchResult.error.message,
				3,
			),
		};
	const scratch = scratchResult.value;
	const initial = await scratch.tree.snapshot();
	if (!initial.ok) {
		const removed = await scratch.remove();
		return {
			ok: false,
			error: failure(
				"environment/scratch_snapshot_failed",
				removed.ok
					? initial.error.message
					: `${initial.error.message}; scratch cleanup failed: ${removed.error.message}`,
				3,
			),
		};
	}
	if (
		scratch.baseTree !== request.baseTree ||
		initial.value.identity !== request.baseTree
	) {
		const restored = await scratch.tree.restore(initial.value);
		const removed = restored.ok ? await scratch.remove() : null;
		return {
			ok: false,
			error: failure(
				restored.ok && removed?.ok
					? "environment/base_tree_mismatch"
					: "environment/scratch_cleanup_pending",
				`Approval scratch did not match the resolved base tree ${request.baseTree}.`,
				3,
			),
		};
	}

	let outcome: ApprovalResult;
	try {
		outcome = await runApprovalInWorkspace(
			request,
			scratch,
			checkoutSnapshot.value.identity,
			testBytes,
			approvalSha256,
			intentSha256,
			warnings,
			parsedIntent,
		);
	} catch (cause) {
		outcome = {
			ok: false,
			error: failure(
				"environment/approval_preflight_failed",
				cause instanceof Error ? cause.message : "Approval preflight failed.",
				3,
			),
		};
	}

	const restored = await scratch.tree.restore(initial.value);
	if (!restored.ok)
		return {
			ok: false,
			error: failure(
				"environment/scratch_restore_failed",
				`Could not restore approval scratch ${scratch.path}: ${restored.error.message}`,
				3,
			),
		};
	const removed = await scratch.remove();
	if (!removed.ok)
		return {
			ok: false,
			error: failure(
				"environment/scratch_cleanup_pending",
				`Could not remove restored approval scratch ${scratch.path}: ${removed.error.message}`,
				3,
			),
		};
	return outcome;
}

async function runApprovalInWorkspace(
	request: ApprovalPreflightRequest,
	scratch: ApprovalScratchWorkspace,
	checkoutTree: string,
	testBytes: Uint8Array,
	approvalSha256: string,
	intentSha256: string,
	warnings: readonly ApprovalCardWarning[],
	intent: ParsedIntent,
): Promise<ApprovalResult> {
	let candidatePath: string;
	try {
		candidatePath = request.adapter.candidatePath(request.slug);
	} catch (cause) {
		return {
			ok: false,
			error: failure(
				"environment/acceptance_test_stage_failed",
				cause instanceof Error ? cause.message : "Acceptance path is invalid.",
				3,
			),
		};
	}
	const candidateBefore = await request.filesystem.readFile({
		root: scratch.path,
		path: candidatePath,
		maxBytes: MAX_SOURCE_BYTES,
	});
	if (candidateBefore.ok || candidateBefore.error.code !== "not_found")
		return {
			ok: false,
			error: failure(
				"environment/acceptance_check_path_conflict",
				candidatePath,
				3,
			),
		};

	let commandIndex = 1;
	for (const setup of request.project.setup) {
		const command = await runGateCommand({
			process: request.process,
			filesystem: request.filesystem,
			workdir: scratch.path,
			runDirectory: request.runDirectory,
			environment: request.environment,
			step: `approval/setup/${setup.name}`,
			index: commandIndex,
			argv: setup.argv,
			timeoutMilliseconds: setup.timeoutMs,
		});
		if (!command.ok)
			return {
				ok: false,
				error: failure(
					"environment/setup_failed",
					`Setup ${setup.name} could not be run: ${command.error.message}`,
					3,
				),
			};
		commandIndex += 1;
		const commandFailure = commandExitFailure("setup", setup.name, command);
		if (commandFailure !== null) return { ok: false, error: commandFailure };
	}

	const setupSnapshot = await scratch.tree.snapshot();
	if (!setupSnapshot.ok)
		return {
			ok: false,
			error: failure(
				"environment/check_snapshot_failed",
				setupSnapshot.error.message,
				3,
			),
		};
	const key = approvalBaselineCacheKey(approvalBaselineKeyInput(request));
	let baseline: readonly ApprovalCheckBaseline[] | null = null;
	let baselineCacheHit = false;
	if (key !== null && request.baselineCache !== undefined) {
		try {
			const cached = await request.baselineCache.get({
				key,
				checkedBaseTree: request.baseTree,
			});
			if (cached.ok) {
				baseline = baselineFromCache(
					cached.value,
					key,
					request.baseTree,
					request.project.checks,
				);
				baselineCacheHit = baseline !== null;
			}
		} catch {
			// A failed cache read is a miss; it never permits baseline reuse.
		}
	}
	if (baseline === null) {
		const rows: ApprovalCheckBaseline[] = [];
		for (const check of request.project.checks) {
			const result = await runApprovalCheck(
				request,
				scratch.path,
				commandIndex,
				check,
				setupSnapshot.value,
				scratch.tree,
			);
			if (!result.ok) return result;
			rows.push(result.value);
			commandIndex += 1;
		}
		baseline = rows;
		if (key !== null && request.baselineCache !== undefined) {
			try {
				await request.baselineCache.put({
					key,
					checkedBaseTree: request.baseTree,
					checks: rows,
				});
			} catch {
				// A failed cache write only causes checks to run again next time.
			}
		}
	}

	const staged = await request.adapter.stage({
		filesystem: request.filesystem,
		sourceRoot: request.checkoutPath ?? request.workspace.checkoutPath,
		workdir: scratch.path,
		slug: request.slug,
	});
	if (!staged.ok) {
		if (staged.error.code === "conflict")
			return {
				ok: false,
				error: failure(
					"environment/acceptance_check_path_conflict",
					candidatePath,
					3,
				),
			};
		return {
			ok: false,
			error: failure(
				"environment/acceptance_test_stage_failed",
				staged.error.message,
				3,
			),
		};
	}
	const stagedBytes = await request.filesystem.readFile({
		root: scratch.path,
		path: staged.value.candidatePath,
		maxBytes: MAX_SOURCE_BYTES,
	});
	if (!stagedBytes.ok || !sameBytes(stagedBytes.value, testBytes))
		return {
			ok: false,
			error: failure(
				"intent/hash_mismatch",
				`intent/hash_mismatch: ${request.slug} acceptance source changed during preflight; review it again with kogen intent approve ${request.slug}`,
				1,
			),
		};
	const stagedTree = await scratch.tree.snapshot();
	if (!stagedTree.ok)
		return {
			ok: false,
			error: failure(
				"environment/check_snapshot_failed",
				stagedTree.error.message,
				3,
			),
		};

	const acceptanceResults: ApprovalAcceptanceCheck[] = [];
	for (const check of request.project.acceptanceChecks) {
		const argv = check.argv.map((argument) =>
			argument.replaceAll("{path}", staged.value.candidatePath),
		);
		const command = await runGateCommand({
			process: request.process,
			filesystem: request.filesystem,
			workdir: scratch.path,
			runDirectory: request.runDirectory,
			environment: request.environment,
			step: `approval/acceptance/${check.name}`,
			index: commandIndex,
			argv,
			timeoutMilliseconds: check.timeoutMs,
		});
		if (!command.ok)
			return {
				ok: false,
				error: failure(
					"environment/acceptance_check_unavailable",
					`Acceptance checker ${check.name} could not be run: ${command.error.message}`,
					3,
				),
			};
		commandIndex += 1;
		const observation = command.value;
		const afterCheck = await scratch.tree.snapshot();
		if (!afterCheck.ok)
			return {
				ok: false,
				error: failure(
					"environment/check_snapshot_failed",
					afterCheck.error.message,
					3,
				),
			};
		if (afterCheck.value.identity !== stagedTree.value.identity) {
			const restored = await scratch.tree.restore(stagedTree.value);
			if (!restored.ok)
				return {
					ok: false,
					error: failure(
						"environment/check_restore_failed",
						restored.error.message,
						3,
					),
				};
			return {
				ok: false,
				error: failure(
					"check/acceptance_check_failed",
					`Acceptance check ${check.name} changed the staged tree.`,
					1,
				),
			};
		}
		const status = observation.timedOut
			? "timeout"
			: observation.exitStatus === null ||
					observation.exitStatus === 126 ||
					observation.exitStatus === 127 ||
					observation.error?.code === "unavailable"
				? "unavailable"
				: observation.exitStatus === 0
					? "green"
					: "red";
		acceptanceResults.push({
			name: check.name,
			status,
			exit_status: observation.exitStatus,
			timed_out: observation.timedOut,
			stdout: observation.log.stdout,
			stderr: observation.log.stderr,
		});
		const commandFailure = commandExitFailure(
			"acceptance",
			check.name,
			command,
		);
		if (commandFailure !== null) return { ok: false, error: commandFailure };
	}

	const warningText = renderApprovalWarnings(warnings, baseline);
	if (request.expectedHash !== undefined && !SHA256.test(approvalSha256))
		return {
			ok: false,
			error: failure("intent/hash_mismatch", "Approval digest is invalid.", 1),
		};
	return {
		ok: true,
		value: {
			kind: request.expectedHash === undefined ? "card" : "ready_to_approve",
			exitCode: request.expectedHash === undefined ? 5 : 0,
			approvalSha256,
			intentSha256,
			checkedBaseTree: request.baseTree,
			checkBaseline: baseline,
			acceptanceChecks: acceptanceResults,
			warnings,
			warningText,
			card:
				request.expectedHash === undefined
					? renderApprovalCard({
							slug: request.slug,
							approvalSha256,
							approver: request.approver,
							base: request.base,
							baseSha: request.baseCommit,
							intent,
							warnings,
							checkBaseline: baseline,
						})
					: null,
			baselineCacheKey: key,
			baselineCacheHit,
			checkoutTree,
			checkedInScratch: true,
		},
	};
}

/** Hash first, then run checks in an isolated exact-base workspace and render the card. */
export async function preflightApproval(
	request: ApprovalPreflightRequest,
): Promise<ApprovalResult> {
	const invalid = validateRequest(request);
	if (invalid !== null) return { ok: false, error: invalid };
	const checkoutRoot = request.checkoutPath ?? request.workspace.checkoutPath;
	if (!isAbsolute(checkoutRoot) || !isSafeRelativePath(request.intentPath))
		return {
			ok: false,
			error: failure(
				"environment/approval_path_invalid",
				"Approval source paths must be absolute.",
				3,
			),
		};
	const intent = await readSource(
		request.filesystem,
		checkoutRoot,
		sourceIntentPath(request),
	);
	if (!intent.ok)
		return { ok: false, error: sourceReadFailure("Intent", intent.error) };
	let acceptancePath: string;
	try {
		acceptancePath = request.adapter.sourcePath(request.slug);
	} catch (cause) {
		return {
			ok: false,
			error: failure(
				"intent/test_path_invalid",
				cause instanceof Error ? cause.message : "Acceptance path is invalid.",
				1,
			),
		};
	}
	const test = await readSource(
		request.filesystem,
		checkoutRoot,
		acceptancePath,
	);
	if (!test.ok)
		return {
			ok: false,
			error: sourceReadFailure("Acceptance test", test.error),
		};

	const approvalSha256 = hashApprovalBytes(intent.value, test.value);
	if (
		request.expectedHash !== undefined &&
		!approvalSha256.startsWith(request.expectedHash)
	)
		return {
			ok: false,
			error: failure(
				"intent/hash_mismatch",
				`intent/hash_mismatch: ${request.slug} is now ${approvalSha256.slice(0, 8)}, not ${request.expectedHash}; review it again with kogen intent approve ${request.slug}`,
				1,
			),
		};

	const parsed = parseIntent(intent.value);
	if (!parsed.ok)
		return {
			ok: false,
			error: failure(
				"intent/parse_failed",
				parsed.errors.map((issue) => issue.message).join("\n"),
				1,
			),
		};
	const lint = lintIntent(parsed.intent);
	const lintErrors = lint.filter((finding) => finding.severity === "error");
	if (lintErrors.length > 0)
		return {
			ok: false,
			error: failure(
				"intent/lint_failed",
				lintErrors.map((finding) => finding.message).join("\n"),
				1,
			),
		};
	const persistedWarnings = await loadShapeWarnings(request, approvalSha256);
	const styleWarnings: ApprovalCardWarning[] = lint
		.filter((finding) => finding.severity === "style")
		.map((finding) => ({
			code: `lint_${finding.rule}`,
			itemIds: [],
			message: singleLine(finding.message),
		}));
	const warnings = [...persistedWarnings, ...styleWarnings];
	return runInScratch(
		request,
		test.value,
		approvalSha256,
		createHash("sha256").update(intent.value).digest("hex"),
		warnings,
		parsed.intent,
	);
}

/** Serialize approval.json's baseline shape; display-only source locations are omitted. */
export function approvalBaselineForRecord(
	rows: readonly ApprovalCheckBaseline[],
): readonly {
	readonly name: string;
	readonly status: ApprovalCheckBaseline["status"];
	readonly exit_status: number | null;
	readonly findings: readonly {
		readonly path: string;
		readonly rule: string;
		readonly symbol: string;
		readonly message: string;
	}[];
}[] {
	return rows.map((row) => ({
		name: row.name,
		status: row.status,
		exit_status: row.exit_status,
		findings: row.findings.map(({ path, rule, symbol, message }) => ({
			path,
			rule,
			symbol,
			message,
		})),
	}));
}

/** Keep shared hash mismatch text identical for callers that pre-read source bytes. */
export function approvalHashMismatchMessage(
	slug: string,
	currentSha256: string,
	requestedPrefix: string,
): string {
	return `intent/hash_mismatch: ${slug} is now ${currentSha256.slice(0, 8)}, not ${requestedPrefix}; review it again with kogen intent approve ${slug}`;
}
