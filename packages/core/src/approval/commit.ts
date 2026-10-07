import { isAbsolute } from "node:path";
import type { ClockPort } from "../contracts/clock";
import type { PortError, Result } from "../contracts/errors";
import type {
	FileSystemPort,
	GitPort,
	ProcessResult,
} from "../contracts/ports";
import {
	GIT_DEFAULT_TIMEOUT_MS,
	GIT_MAX_OUTPUT_LIMIT_BYTES,
} from "../git/command";
import { hashApprovalBytes, hashIntentBytes } from "../intent/hash";
import { isValidIntentSlug, parseIntent } from "../intent/parse";
import {
	type ApprovalPreflightSuccess,
	approvalBaselineForRecord,
} from "./preflight";
import { approvalCasTransition } from "./transition";

const MAX_APPROVAL_SOURCE_BYTES = 2 * 1024 * 1024 - 9;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const APPROVAL_PREFIX = /^[0-9a-f]{6,64}$/u;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder("utf-8", { fatal: true });

export interface ApprovalWitnessRecord {
	readonly verdict: "PROVEN" | "PROVEN_WITH_CONCERNS";
	readonly commit: string;
	readonly diff_sha256: string;
	readonly base_sha: string;
}

export interface ApprovalCommitRequest {
	readonly origin: string;
	readonly checkout: string;
	readonly slug: string;
	readonly intentPath: string;
	readonly acceptancePath: string;
	readonly targetBranch: string;
	readonly baseSha: string;
	/** Hash argument typed by the user; approval is refused unless it matches. */
	readonly givenHash: string;
	/** A verbatim `--by` value. Omit it to use Git's public author identity. */
	readonly by?: string;
	readonly preflight: ApprovalPreflightSuccess;
	/** `buildProtectedManifest(...).hashes` from the checked base. */
	readonly protectedManifest: Readonly<Record<string, string>>;
	readonly witnessRequired?: boolean;
	readonly witness?: ApprovalWitnessRecord | null;
	readonly filesystem: Pick<FileSystemPort, "readFile">;
	/** Must be the public Git port so global identity and signing are retained. */
	readonly git: Pick<GitPort, "command">;
	readonly clock: Pick<ClockPort, "unixMilliseconds">;
}

export interface ApprovalCommitSuccess {
	readonly approvalCommit: string;
	readonly approvalRef: string;
	readonly approvalSha256: string;
	readonly intentSha256: string;
	readonly by: string;
	readonly at: string;
	readonly parent: string | null;
	readonly tree: string;
	readonly retryCount: 0 | 1;
}

export interface ApprovalCommitFailure {
	readonly code:
		| "intent/hash_mismatch"
		| "intent/acceptance_missing"
		| "intent/unproven"
		| "intent/approval_by_invalid"
		| "intent/approval_identity_unavailable"
		| "environment/approval_path_invalid"
		| "environment/approval_source_unavailable"
		| "environment/approval_manifest_invalid"
		| "environment/approval_ref_invalid"
		| "environment/approval_cas_failed"
		| "environment/approval_commit_failed";
	readonly exitCode: 1 | 2 | 3;
	readonly message: string;
}

export type ApprovalCommitResult = Result<
	ApprovalCommitSuccess,
	ApprovalCommitFailure
>;

class ApprovalFailure extends Error {
	constructor(readonly result: ApprovalCommitFailure) {
		super(result.message);
		this.name = "ApprovalFailure";
	}
}

function refuse(
	code: ApprovalCommitFailure["code"],
	exitCode: ApprovalCommitFailure["exitCode"],
	message: string,
): never {
	throw new ApprovalFailure({ code, exitCode, message });
}

function validObjectId(value: string, length?: number): boolean {
	return (
		OBJECT_ID.test(value) && (length === undefined || value.length === length)
	);
}

function safeRelativePath(value: string): boolean {
	return (
		value.length > 0 &&
		!value.startsWith("/") &&
		!value.includes("\\") &&
		!value.includes("\0") &&
		ENCODER.encode(value).byteLength <= 4096 &&
		value
			.split("/")
			.every(
				(component) =>
					component.length > 0 &&
					component !== "." &&
					component !== ".." &&
					component !== ".git",
			)
	);
}

function utf8Compare(left: string, right: string): number {
	const a = ENCODER.encode(left);
	const b = ENCODER.encode(right);
	for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return a.length - b.length;
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object")
		return JSON.stringify(value) ?? "null";
	if (Array.isArray(value))
		return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort(utf8Compare)
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index += 1)
		if (left[index] !== right[index]) return false;
	return true;
}

function failureFromPort(
	code: ApprovalCommitFailure["code"],
	message: string,
	error?: PortError,
): never {
	refuse(
		code,
		3,
		error === undefined ? message : `${message}: ${error.message}`,
	);
}

async function git(
	request: ApprovalCommitRequest,
	argv: readonly string[],
	stdin?: Uint8Array,
	outputLimitBytes = GIT_MAX_OUTPUT_LIMIT_BYTES,
): Promise<ProcessResult> {
	let result: Result<ProcessResult>;
	try {
		result = await request.git.command({
			repository: request.origin,
			argv,
			...(stdin === undefined ? {} : { stdin }),
			timeoutMilliseconds: GIT_DEFAULT_TIMEOUT_MS,
			outputLimitBytes,
		});
	} catch (cause) {
		refuse(
			"environment/approval_commit_failed",
			3,
			`Git ${argv[0] ?? "command"} could not be run: ${cause instanceof Error ? cause.message : "unknown Git port failure"}`,
		);
	}
	if (!result.ok)
		failureFromPort(
			"environment/approval_commit_failed",
			`Git ${argv[0] ?? "command"} could not be run`,
			result.error,
		);
	if (result.value.timedOut)
		refuse(
			"environment/approval_commit_failed",
			3,
			`Git ${argv[0] ?? "command"} timed out.`,
		);
	return result.value;
}

function commandText(
	result: ProcessResult,
	command: string,
	length: number,
): string {
	if (result.exitCode !== 0)
		refuse(
			"environment/approval_commit_failed",
			3,
			`Git ${command} failed with exit ${String(result.exitCode)}.`,
		);
	const text = commandOutputText(result, command, length);
	const value = text.trimEnd();
	if (value.includes("\0") || value.length === 0 || value.length > length)
		refuse(
			"environment/approval_commit_failed",
			3,
			`Git ${command} returned invalid output.`,
		);
	return value;
}

function commandOutputText(
	result: ProcessResult,
	command: string,
	length: number,
): string {
	if (result.exitCode !== 0)
		refuse(
			"environment/approval_commit_failed",
			3,
			`Git ${command} failed with exit ${String(result.exitCode)}.`,
		);
	let text: string;
	try {
		text = DECODER.decode(result.stdout);
	} catch {
		refuse(
			"environment/approval_commit_failed",
			3,
			`Git ${command} returned invalid UTF-8.`,
		);
	}
	if (text.length > length + 1)
		refuse(
			"environment/approval_commit_failed",
			3,
			`Git ${command} returned invalid output.`,
		);
	return text;
}

function objectIdFromResult(
	result: ProcessResult,
	command: string,
	length: number,
): string {
	const value = commandText(result, command, length);
	if (!validObjectId(value, length))
		refuse(
			"environment/approval_commit_failed",
			3,
			`Git ${command} returned an invalid object id.`,
		);
	return value;
}

async function readSource(
	request: ApprovalCommitRequest,
	path: string,
	label: "Intent" | "acceptance",
): Promise<Uint8Array> {
	let result: Result<Uint8Array>;
	try {
		result = await request.filesystem.readFile({
			root: request.checkout,
			path,
			maxBytes: MAX_APPROVAL_SOURCE_BYTES,
		});
	} catch (cause) {
		refuse(
			"environment/approval_source_unavailable",
			3,
			`Could not read the ${label} file: ${cause instanceof Error ? cause.message : "filesystem port failed"}`,
		);
	}
	if (!result.ok) {
		if (label === "Intent" && result.error.code === "not_found")
			refuse(
				"intent/hash_mismatch",
				1,
				`intent/hash_mismatch: ${request.slug} Intent source disappeared after preflight; review it again with kogen intent approve ${request.slug}`,
			);
		if (label === "acceptance" && result.error.code === "not_found")
			refuse(
				"intent/acceptance_missing",
				2,
				`intent/acceptance_missing: ${path} does not exist`,
			);
		failureFromPort(
			"environment/approval_source_unavailable",
			`Could not read the ${label} file`,
			result.error,
		);
	}
	return result.value.slice();
}

async function readOptionalLedger(
	request: ApprovalCommitRequest,
	path: string,
): Promise<Uint8Array | null> {
	let result: Result<Uint8Array>;
	try {
		result = await request.filesystem.readFile({
			root: request.checkout,
			path,
			maxBytes: MAX_APPROVAL_SOURCE_BYTES,
		});
	} catch (cause) {
		refuse(
			"environment/approval_source_unavailable",
			3,
			`Could not read ledger.json: ${cause instanceof Error ? cause.message : "filesystem port failed"}`,
		);
	}
	if (!result.ok) {
		if (result.error.code === "not_found") return null;
		failureFromPort(
			"environment/approval_source_unavailable",
			"Could not read ledger.json",
			result.error,
		);
	}
	return result.value.slice();
}

async function readApprover(request: ApprovalCommitRequest): Promise<string> {
	if (request.by !== undefined) {
		if (request.by.trim().length === 0 || /[\r\n\0]/u.test(request.by))
			refuse(
				"intent/approval_by_invalid",
				2,
				"intent/approval_by_invalid: --by must be non-blank and contain one line",
			);
		return request.by;
	}
	const result = await git(
		request,
		["var", "GIT_AUTHOR_IDENT"],
		undefined,
		4096,
	);
	if (result.exitCode !== 0)
		refuse(
			"intent/approval_identity_unavailable",
			2,
			"intent/approval_identity_unavailable: configure git user.name and user.email",
		);
	let ident: string;
	try {
		ident = DECODER.decode(result.stdout).trimEnd();
	} catch {
		refuse(
			"intent/approval_identity_unavailable",
			2,
			"intent/approval_identity_unavailable: configure git user.name and user.email",
		);
	}
	const match = /^(.*) <([^<>]+)> [0-9]+ [+-][0-9]{4}$/u.exec(ident);
	const name = match?.[1];
	const email = match?.[2];
	if (
		match === null ||
		name === undefined ||
		name.trim().length === 0 ||
		email === undefined ||
		email.trim().length === 0
	)
		refuse(
			"intent/approval_identity_unavailable",
			2,
			"intent/approval_identity_unavailable: configure git user.name and user.email",
		);
	return `${name} <${email}>`;
}

function manifestForCommit(
	request: ApprovalCommitRequest,
	intentSha256: string,
	acceptanceSha256: string,
): Readonly<Record<string, string>> {
	const result: Record<string, string> = Object.create(null);
	for (const [path, digest] of Object.entries(request.protectedManifest)) {
		if (!safeRelativePath(path) || !SHA256.test(digest))
			refuse(
				"environment/approval_manifest_invalid",
				3,
				"Approval protected manifest contains an invalid path or SHA-256.",
			);
		result[path] = digest;
	}
	if (
		result[request.intentPath] !== intentSha256 ||
		result[request.acceptancePath] !== acceptanceSha256
	)
		refuse(
			"environment/approval_manifest_invalid",
			3,
			"Approval protected manifest does not bind the exact Intent and acceptance bytes.",
		);
	return result;
}

interface TreeFile {
	readonly mode: "100644";
	readonly objectId: string;
}

interface TreeNode {
	readonly files: Map<string, TreeFile>;
	readonly directories: Map<string, TreeNode>;
}

function newTreeNode(): TreeNode {
	return { files: new Map(), directories: new Map() };
}

function addTreeFile(root: TreeNode, path: string, file: TreeFile): void {
	const components = path.split("/");
	let parent = root;
	for (const component of components.slice(0, -1)) {
		let next = parent.directories.get(component);
		if (next === undefined) {
			next = newTreeNode();
			parent.directories.set(component, next);
		}
		if (parent.files.has(component))
			refuse(
				"environment/approval_commit_failed",
				3,
				"Approval package paths have a file/directory collision.",
			);
		parent = next;
	}
	const name = components.at(-1);
	if (
		name === undefined ||
		parent.directories.has(name) ||
		parent.files.has(name)
	)
		refuse(
			"environment/approval_commit_failed",
			3,
			"Approval package paths are duplicated or invalid.",
		);
	parent.files.set(name, file);
}

async function writeBlob(
	request: ApprovalCommitRequest,
	bytes: Uint8Array,
	objectIdLength: number,
): Promise<string> {
	const result = await git(
		request,
		["hash-object", "-w", "--no-filters", "--stdin"],
		bytes,
		4096,
	);
	return objectIdFromResult(result, "blob hashing", objectIdLength);
}

async function writeTree(
	request: ApprovalCommitRequest,
	node: TreeNode,
	objectIdLength: number,
): Promise<string> {
	const entries: {
		readonly name: string;
		readonly mode: string;
		readonly type: string;
		readonly objectId: string;
	}[] = [];
	for (const [name, file] of node.files)
		entries.push({
			name,
			mode: file.mode,
			type: "blob",
			objectId: file.objectId,
		});
	for (const [name, directory] of node.directories)
		entries.push({
			name,
			mode: "040000",
			type: "tree",
			objectId: await writeTree(request, directory, objectIdLength),
		});
	entries.sort((left, right) =>
		utf8Compare(
			left.type === "tree" ? `${left.name}/` : left.name,
			right.type === "tree" ? `${right.name}/` : right.name,
		),
	);
	const treeInput = new Uint8Array(
		entries.reduce(
			(length, entry) =>
				length +
				ENCODER.encode(
					`${entry.mode} ${entry.type} ${entry.objectId}\t${entry.name}\0`,
				).byteLength,
			0,
		),
	);
	let offset = 0;
	for (const entry of entries) {
		const bytes = ENCODER.encode(
			`${entry.mode} ${entry.type} ${entry.objectId}\t${entry.name}\0`,
		);
		treeInput.set(bytes, offset);
		offset += bytes.byteLength;
	}
	const result = await git(request, ["mktree", "-z"], treeInput, 4096);
	return objectIdFromResult(result, "tree creation", objectIdLength);
}

async function writeCommit(
	request: ApprovalCommitRequest,
	tree: string,
	parent: string | null,
	message: string,
	objectIdLength: number,
): Promise<string> {
	const result = await git(
		request,
		[
			"commit-tree",
			tree,
			...(parent === null ? [] : ["-p", parent]),
			"-F",
			"-",
		],
		ENCODER.encode(message),
		4096,
	);
	return objectIdFromResult(result, "approval commit creation", objectIdLength);
}

async function currentApprovalParent(
	request: ApprovalCommitRequest,
	ref: string,
	objectIdLength: number,
): Promise<string | null> {
	const symbolic = await git(
		request,
		["symbolic-ref", "--quiet", ref],
		undefined,
		4096,
	);
	if (symbolic.exitCode === 0)
		refuse(
			"environment/approval_ref_invalid",
			3,
			"Approval ref must not be symbolic.",
		);
	if (symbolic.exitCode !== 1)
		refuse(
			"environment/approval_ref_invalid",
			3,
			`Git could not inspect approval ref ${ref}.`,
		);
	const listed = await git(
		request,
		["for-each-ref", "--format=%(refname)%00%(objectname)", ref],
		undefined,
		4096,
	);
	const text = commandOutputText(listed, "approval ref lookup", 4096);
	if (text.length === 0) return null;
	const line = text.endsWith("\n") ? text.slice(0, -1) : text;
	const separator = line.indexOf("\0");
	const name = separator < 0 ? undefined : line.slice(0, separator);
	const objectId = separator < 0 ? undefined : line.slice(separator + 1);
	if (
		name !== ref ||
		objectId === undefined ||
		!validObjectId(objectId, objectIdLength) ||
		line.indexOf("\n") >= 0
	)
		refuse(
			"environment/approval_ref_invalid",
			3,
			"Approval ref contains an invalid object id.",
		);
	const type = await git(
		request,
		["cat-file", "-t", objectId],
		undefined,
		4096,
	);
	if (commandText(type, "approval ref object type", 64) !== "commit")
		refuse(
			"environment/approval_ref_invalid",
			3,
			"Approval ref must point to a commit.",
		);
	return objectId;
}

async function assertLateSourcesStable(
	request: ApprovalCommitRequest,
	intentSnapshot: Uint8Array,
	acceptanceSnapshot: Uint8Array,
): Promise<void> {
	const intentNow = await readSource(request, request.intentPath, "Intent");
	const acceptanceNow = await readSource(
		request,
		request.acceptancePath,
		"acceptance",
	);
	const currentApprovalSha256 = hashApprovalBytes(intentNow, acceptanceNow);
	if (
		!sameBytes(intentSnapshot, intentNow) ||
		!sameBytes(acceptanceSnapshot, acceptanceNow) ||
		currentApprovalSha256 !== request.preflight.approvalSha256
	)
		refuse(
			"intent/hash_mismatch",
			1,
			`intent/hash_mismatch: ${request.slug} is now ${currentApprovalSha256.slice(0, 8)}, not ${request.givenHash}; review it again with kogen intent approve ${request.slug}`,
		);
}

function validateRequest(request: ApprovalCommitRequest): void {
	if (
		!isAbsolute(request.origin) ||
		!isAbsolute(request.checkout) ||
		request.origin.includes("\0") ||
		request.checkout.includes("\0") ||
		!isValidIntentSlug(request.slug) ||
		request.intentPath !== `.kogen/intents/${request.slug}/intent.md` ||
		!new RegExp(
			`^\\.kogen/acceptance/${request.slug}(?:\\.[^/]+|_[^/]+)$`,
			"u",
		).test(request.acceptancePath) ||
		!safeRelativePath(request.intentPath) ||
		!safeRelativePath(request.acceptancePath) ||
		request.targetBranch.length === 0 ||
		/[\r\n\0]/u.test(request.targetBranch) ||
		!validObjectId(request.baseSha) ||
		!APPROVAL_PREFIX.test(request.givenHash)
	)
		refuse(
			"environment/approval_path_invalid",
			3,
			"Approval source, origin, base, branch, or hash argument is invalid.",
		);
	if (
		request.preflight.kind !== "ready_to_approve" ||
		request.preflight.exitCode !== 0 ||
		!SHA256.test(request.preflight.approvalSha256) ||
		!SHA256.test(request.preflight.intentSha256) ||
		request.preflight.checkedInScratch !== true ||
		request.preflight.acceptanceChecks.some((check) => check.status !== "green")
	)
		refuse(
			"environment/approval_commit_failed",
			3,
			"Approval commit requires a successful exact-base preflight.",
		);
	if (!request.preflight.approvalSha256.startsWith(request.givenHash))
		refuse(
			"intent/hash_mismatch",
			1,
			`intent/hash_mismatch: ${request.slug} is now ${request.preflight.approvalSha256.slice(0, 8)}, not ${request.givenHash}; review it again with kogen intent approve ${request.slug}`,
		);
	if (
		request.witnessRequired === true &&
		(request.witness === null ||
			request.witness === undefined ||
			(request.witness.verdict !== "PROVEN" &&
				request.witness.verdict !== "PROVEN_WITH_CONCERNS"))
	)
		refuse(
			"intent/unproven",
			1,
			`intent/unproven: ${request.slug} has no green witness; shape it again or answer its concerns`,
		);
	if (request.witness !== undefined && request.witness !== null) {
		if (
			!validObjectId(request.witness.commit) ||
			!SHA256.test(request.witness.diff_sha256) ||
			request.witness.base_sha !== request.baseSha
		)
			refuse(
				"environment/approval_commit_failed",
				3,
				"Approval witness does not bind the resolved base.",
			);
	}
}

async function commitApproval(
	request: ApprovalCommitRequest,
): Promise<ApprovalCommitSuccess> {
	validateRequest(request);
	const approver = await readApprover(request);
	const intentSnapshot = await readSource(
		request,
		request.intentPath,
		"Intent",
	);
	const acceptanceSnapshot = await readSource(
		request,
		request.acceptancePath,
		"acceptance",
	);
	const intentSha256 = hashIntentBytes(intentSnapshot);
	const approvalSha256 = hashApprovalBytes(intentSnapshot, acceptanceSnapshot);
	if (
		intentSha256 !== request.preflight.intentSha256 ||
		approvalSha256 !== request.preflight.approvalSha256 ||
		!approvalSha256.startsWith(request.givenHash)
	)
		refuse(
			"intent/hash_mismatch",
			1,
			`intent/hash_mismatch: ${request.slug} is now ${approvalSha256.slice(0, 8)}, not ${request.givenHash}; review it again with kogen intent approve ${request.slug}`,
		);
	const parsed = parseIntent(intentSnapshot);
	if (!parsed.ok)
		refuse(
			"intent/hash_mismatch",
			1,
			`intent/hash_mismatch: ${request.slug} source changed after preflight; review it again with kogen intent approve ${request.slug}`,
		);
	const ledgerPath = `.kogen/intents/${request.slug}/ledger.json`;
	const ledgerBytes = await readOptionalLedger(request, ledgerPath);
	const protectedManifest = manifestForCommit(
		request,
		intentSha256,
		hashIntentBytes(acceptanceSnapshot),
	);
	const atMilliseconds = request.clock.unixMilliseconds();
	if (!Number.isSafeInteger(atMilliseconds))
		refuse(
			"environment/approval_commit_failed",
			3,
			"Approval clock returned an invalid Unix timestamp.",
		);
	let at: string;
	try {
		at = new Date(atMilliseconds).toISOString();
	} catch {
		refuse(
			"environment/approval_commit_failed",
			3,
			"Approval clock returned an invalid Unix timestamp.",
		);
	}
	const approvalJson = canonicalJson({
		schema: 2,
		slug: request.slug,
		approval_sha256: approvalSha256,
		intent_sha256: intentSha256,
		target_branch: request.targetBranch,
		base_sha: request.baseSha,
		domains: parsed.intent.frontmatter.domains,
		acceptance_paths: [request.acceptancePath],
		protected_manifest: protectedManifest,
		check_baseline: approvalBaselineForRecord(request.preflight.checkBaseline),
		witness: request.witness ?? null,
		by: approver,
		at,
	});
	const ref = `refs/kogen/intents/${request.slug}`;
	const objectFormat = await git(
		request,
		["rev-parse", "--show-object-format=storage"],
		undefined,
		4096,
	);
	const format = commandText(objectFormat, "object-format lookup", 16);
	const oidLength = format === "sha1" ? 40 : format === "sha256" ? 64 : 0;
	if (oidLength === 0 || request.baseSha.length !== oidLength)
		refuse(
			"environment/approval_commit_failed",
			3,
			"Approval base does not match the origin Git object format.",
		);
	const baseType = await git(
		request,
		["cat-file", "-t", request.baseSha],
		undefined,
		4096,
	);
	if (commandText(baseType, "base object type", 64) !== "commit")
		refuse(
			"environment/approval_commit_failed",
			3,
			"Resolved approval base is not a commit.",
		);
	const intentBlob = await writeBlob(request, intentSnapshot, oidLength);
	const approvalBlob = await writeBlob(
		request,
		ENCODER.encode(`${approvalJson}\n`),
		oidLength,
	);
	const acceptanceBlob = await writeBlob(
		request,
		acceptanceSnapshot,
		oidLength,
	);
	const root = newTreeNode();
	addTreeFile(root, request.intentPath, {
		mode: "100644",
		objectId: intentBlob,
	});
	addTreeFile(root, `.kogen/intents/${request.slug}/approval.json`, {
		mode: "100644",
		objectId: approvalBlob,
	});
	if (ledgerBytes !== null) {
		const ledgerBlob = await writeBlob(request, ledgerBytes, oidLength);
		addTreeFile(root, ledgerPath, { mode: "100644", objectId: ledgerBlob });
	}
	addTreeFile(root, request.acceptancePath, {
		mode: "100644",
		objectId: acceptanceBlob,
	});
	const tree = await writeTree(request, root, oidLength);
	const message =
		`Kogen immutable approval package\n\n` +
		`Kogen-Approval: ${request.slug}\n` +
		`Kogen-Approved-By: ${approver}\n` +
		`Kogen-Approved-Hash: ${approvalSha256}\n` +
		`Kogen-Approved-At: ${at}\n`;

	let expectedParent = await currentApprovalParent(request, ref, oidLength);
	for (const attempt of [0, 1] as const) {
		const commit = await writeCommit(
			request,
			tree,
			expectedParent,
			message,
			oidLength,
		);
		await assertLateSourcesStable(request, intentSnapshot, acceptanceSnapshot);
		const zero = "0".repeat(oidLength);
		let update: ProcessResult | null = null;
		let updatePortError: PortError | undefined;
		try {
			const result = await request.git.command({
				repository: request.origin,
				argv: ["update-ref", "--no-deref", ref, commit, expectedParent ?? zero],
				timeoutMilliseconds: GIT_DEFAULT_TIMEOUT_MS,
				outputLimitBytes: 4096,
			});
			if (result.ok) update = result.value;
			else updatePortError = result.error;
		} catch (cause) {
			updatePortError = {
				code: "unknown",
				message: cause instanceof Error ? cause.message : "Git port failed",
				retryable: true,
				cause,
			};
		}
		if (update !== null && !update.timedOut && update.exitCode === 0)
			return {
				approvalCommit: commit,
				approvalRef: ref,
				approvalSha256,
				intentSha256,
				by: approver,
				at,
				parent: expectedParent,
				tree,
				retryCount: attempt,
			};
		const observedParent = await currentApprovalParent(request, ref, oidLength);
		if (observedParent === commit)
			return {
				approvalCommit: commit,
				approvalRef: ref,
				approvalSha256,
				intentSha256,
				by: approver,
				at,
				parent: expectedParent,
				tree,
				retryCount: attempt,
			};
		const decision = approvalCasTransition({
			attempt,
			expectedParent,
			observedParent,
		});
		if (decision.kind === "failed")
			refuse(
				"environment/approval_cas_failed",
				3,
				updatePortError === undefined
					? `Git could not update ${ref} with its expected parent.`
					: `Git could not update ${ref}: ${updatePortError.message}`,
			);
		if (decision.kind === "exhausted")
			refuse(
				"environment/approval_cas_failed",
				3,
				`Approval ref ${ref} changed during both compare-and-swap attempts.`,
			);
		expectedParent = decision.expectedParent;
	}
	refuse(
		"environment/approval_cas_failed",
		3,
		`Approval ref ${ref} changed during both compare-and-swap attempts.`,
	);
}

/**
 * Create the immutable approval package, then publish its ref with one retry
 * after a lost compare-and-swap. This is the effectful production transition
 * used by CLI composition and the private xspec adapter.
 */
export async function commitApprovalPackage(
	request: ApprovalCommitRequest,
): Promise<ApprovalCommitResult> {
	try {
		return { ok: true, value: await commitApproval(request) };
	} catch (cause) {
		if (cause instanceof ApprovalFailure)
			return { ok: false, error: cause.result };
		return {
			ok: false,
			error: {
				code: "environment/approval_commit_failed",
				exitCode: 3,
				message:
					cause instanceof Error
						? `Approval commit failed: ${cause.message}`
						: "Approval commit failed.",
			},
		};
	}
}
