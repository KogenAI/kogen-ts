import { expect, test } from "bun:test";
import type {
	AcceptanceAdapter,
	AdapterRunResult,
} from "../../packages/core/src/adapters/interface";
import type {
	PortError,
	Result,
} from "../../packages/core/src/contracts/errors";
import type {
	FileSystemPort,
	ProcessPort,
	ProcessResult,
} from "../../packages/core/src/contracts/ports";
import type {
	GateTreePort,
	GateTreeSnapshot,
} from "../../packages/core/src/gate/checks";
import { resolveRoles } from "../../packages/core/src/project/roles";
import type { ProjectConfig } from "../../packages/core/src/project/schema";
import type { RespondResult } from "../../packages/core/src/provider/retry/respond";
import {
	createSession,
	type RoleToolAuthorization,
} from "../../packages/core/src/provider/session/transition";
import type { AssembledResponse } from "../../packages/core/src/provider/sse/assemble";
import {
	CANONICAL_TOOL_SCHEMAS,
	TOOL_SCHEMA_VERSION,
} from "../../packages/core/src/provider/tools/schema";
import {
	createShapeWarningsArtifact,
	shapeApprovalSha256,
} from "../../packages/core/src/shape/artifacts";
import { parseShapeTestAudit } from "../../packages/core/src/shape/audit";
import type { ShapeValidationInput } from "../../packages/core/src/shape/controller";
import {
	ShapeAccounting,
	shapeRoleAssignment,
} from "../../packages/core/src/shape/counters";
import { parseShapeRequirementLedger } from "../../packages/core/src/shape/ledger";
import { SHAPER_SYSTEM_PROMPT } from "../../packages/core/src/shape/prompts";
import { createShapeValidationWorkflow } from "../../packages/core/src/shape/validate";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const workdir = "/shape-48-work";
const scratchDirectory = "/shape-48-run";
const slug = "shape-48";
const intentPath = `.kogen/intents/${slug}/intent.md`;
const sourcePath = `.kogen/acceptance/${slug}.sh`;
const candidatePath = `test/acceptance/${slug}.sh`;
const requestBytes = encoder.encode("Change threshold to 8.");
const intentBytes = encoder.encode(`---
title: Adjust threshold behavior
size: small
domains: [app]
---
Adjust threshold behavior to match the request.

## Acceptance
- A1: The threshold equals 8.
- A2: Existing validation behavior remains available.

## Verify
- A1: test domain=app
- A2: test keep domain=app

## Notes
Approach: update threshold handling in the existing module and preserve validation behavior.
`);
const testBytes = encoder.encode(
	'describe("shape-48", () => { test("threshold", () => {}); });\n',
);

function portError(code: PortError["code"], message: string): PortError {
	return { code, message, retryable: false };
}

function bytes(value: string): Uint8Array {
	return encoder.encode(value);
}

class MemoryFileSystem implements FileSystemPort {
	readonly files = new Map<string, Uint8Array>();
	readonly writes: Array<{ root: string; path: string; mode: number }> = [];

	private key(root: string, path: string): string {
		return `${root}\0${path}`;
	}

	async readFile(request: {
		root: string;
		path: string;
		maxBytes: number;
	}): Promise<Result<Uint8Array>> {
		const value = this.files.get(this.key(request.root, request.path));
		if (value === undefined)
			return { ok: false, error: portError("not_found", "file not found") };
		if (value.byteLength > request.maxBytes)
			return {
				ok: false,
				error: portError("invalid_input", "file exceeds read limit"),
			};
		return { ok: true, value: value.slice() };
	}

	async writeFileAtomically(request: {
		root: string;
		path: string;
		bytes: Uint8Array;
		mode: number;
	}): Promise<Result<void>> {
		this.files.set(this.key(request.root, request.path), request.bytes.slice());
		this.writes.push({
			root: request.root,
			path: request.path,
			mode: request.mode,
		});
		return { ok: true, value: undefined };
	}

	async removeFile(root: string, path: string): Promise<Result<void>> {
		if (!this.files.delete(this.key(root, path)))
			return { ok: false, error: portError("not_found", "file not found") };
		return { ok: true, value: undefined };
	}

	get(root: string, path: string): Uint8Array | undefined {
		return this.files.get(this.key(root, path))?.slice();
	}
}

class StableTree implements GateTreePort {
	private next = 0;
	async snapshot(): Promise<Result<GateTreeSnapshot>> {
		this.next += 1;
		return {
			ok: true,
			value: { identity: "base-tree", restoreToken: `snapshot-${this.next}` },
		};
	}
	async changedPaths(): Promise<Result<readonly string[]>> {
		return { ok: true, value: [] };
	}
	async restore(): Promise<Result<void>> {
		return { ok: true, value: undefined };
	}
}

function processPort(exitCodes: readonly number[] = []): ProcessPort {
	let index = 0;
	return {
		async run(): Promise<Result<ProcessResult>> {
			const exitCode = exitCodes[index] ?? 0;
			index += 1;
			return {
				ok: true,
				value: {
					exitCode,
					signal: null,
					stdout: new Uint8Array(),
					stderr:
						exitCode === 127 ? bytes("command not found") : new Uint8Array(),
					timedOut: false,
				},
			};
		},
	};
}

function makeAdapter(
	filesystem: MemoryFileSystem,
	statuses: readonly ["passed" | "failed", "passed" | "failed"],
): AcceptanceAdapter {
	return {
		name: "command",
		sourcePath: () => sourcePath,
		candidatePath: () => candidatePath,
		async stage(request) {
			const source = await request.filesystem.readFile({
				root: request.sourceRoot,
				path: sourcePath,
				maxBytes: 200_000,
			});
			if (!source.ok) return source;
			const write = await request.filesystem.writeFileAtomically({
				root: request.workdir,
				path: candidatePath,
				bytes: source.value,
				mode: 0o600,
			});
			if (!write.ok) return write;
			const removed = await request.filesystem.removeFile(
				request.workdir,
				sourcePath,
			);
			if (!removed.ok) return removed;
			return {
				ok: true,
				value: {
					sourcePath,
					candidatePath,
					bytesWritten: source.value.byteLength,
				},
			};
		},
		async run(request): Promise<Result<AdapterRunResult>> {
			const reportPath = request.reportPath.slice(scratchDirectory.length + 1);
			const rows = ["A1", "A2"].map((id, index) =>
				JSON.stringify({
					tag: `${slug}/${id}`,
					test: id,
					status: statuses[index],
				}),
			);
			const write = await filesystem.writeFileAtomically({
				root: scratchDirectory,
				path: reportPath,
				bytes: bytes(`${rows.join("\n")}\n`),
				mode: 0o600,
			});
			if (!write.ok) return write;
			return {
				ok: true,
				value: {
					exitStatus: statuses.includes("failed") ? 1 : 0,
					timedOut: false,
					log: { stdout: new Uint8Array(), stderr: new Uint8Array() },
				},
			};
		},
	};
}

function modelResult(
	session: Parameters<ShapeValidationInput["requestModel"]>[0],
	responseText: string,
): RespondResult {
	const response: AssembledResponse = {
		ok: true,
		id: "shape-validation-audit",
		text: responseText,
		tool_calls: [],
		usage: null,
		raw_items: [],
		raw_item_json: [],
	};
	return {
		kind: "completed",
		session,
		response,
		attempts: [],
		events: [],
		retryState: {} as RespondResult extends { retryState: infer T } ? T : never,
	} as RespondResult;
}

function makeWorkflow(
	options: {
		statuses?: readonly ["passed" | "failed", "passed" | "failed"];
		processExitCodes?: readonly number[];
		format?: readonly string[];
		gatePaths?: readonly string[];
		intentSource?: Uint8Array;
		acceptanceChecks?: readonly {
			name: string;
			argv: readonly string[];
			timeoutMs: number;
		}[];
		baseAudit?: (kind: "requirement" | "test") => string;
		finalResponseText?: string;
	} = {},
) {
	const roleResult = resolveRoles({ provider: "chatgpt" });
	if (!roleResult.ok) throw new Error("Could not resolve test model roles.");
	const roles = roleResult.value.roles;
	const filesystem = new MemoryFileSystem();
	filesystem.files.set(
		`${workdir}\0${intentPath}`,
		(options.intentSource ?? intentBytes).slice(),
	);
	filesystem.files.set(`${workdir}\0${sourcePath}`, testBytes.slice());
	const adapter = makeAdapter(
		filesystem,
		options.statuses ?? ["failed", "passed"],
	);
	const project = {
		name: "shape validation fixture",
		checks: [],
		acceptanceChecks: options.acceptanceChecks ?? [],
		setup: [],
		setupOutputs: [],
		setupInputs: [],
		fix: [],
		...(options.format === undefined ? {} : { format: options.format }),
		protectedPaths: [],
		gatePaths: options.gatePaths ?? [],
		domains: new Map([["app", []]]),
		env: new Map(),
		sandbox: true,
		acceptance: { adapter: "command", timeoutMs: 60_000 },
		shaping: { proof: "none", witnessRounds: 2 },
		build: {} as ProjectConfig["build"],
	} as ProjectConfig;
	const authorization: RoleToolAuthorization = {
		builder: [],
		planner: [],
		shaper: ["read", "search", "write"],
		auditor: [],
		reviewer: [],
		context: [],
	};
	const sourceSession = createSession({
		runDirectory: "/tmp/shape-validation-tests",
		provider: "chatgpt",
		authMode: "injected",
		role: "shaper",
		model: roles.shaper.effective.model,
		effort: roles.shaper.effective.effort,
		stage: "shape",
		attempt: "primary",
		rung: "primary",
		roleInstructions: SHAPER_SYSTEM_PROMPT,
		genericInstructions: "Complete shared instructions.",
		toolSchemas: CANONICAL_TOOL_SCHEMAS,
		toolSchemaVersion: TOOL_SCHEMA_VERSION,
		promptVersion: "shape-v1.3-test",
		adapterVersion: "responses-test",
		roleToolAuthorization: authorization,
	});
	const conversationId = "shape-validation-thread";
	const accounting = new ShapeAccounting({
		shaper: roles.shaper,
		auditor: roles.auditor,
	});
	accounting.registerConversation(
		conversationId,
		"primary",
		shapeRoleAssignment(roles.shaper, "shaper"),
	);
	const calls: string[] = [];
	const progress: string[] = [];
	const workflow = createShapeValidationWorkflow({
		adapter,
		auditorRole: roles.auditor,
		filesystem,
		process: processPort(options.processExitCodes),
		workspace: new StableTree(),
		project,
		workdir,
		scratchDirectory,
		slug,
		requestBytes,
		environment: {},
		onProgress: (event) => progress.push(event),
	});
	const validation: ShapeValidationInput = {
		conversation: "primary",
		conversationId,
		passNumber: 1,
		session: sourceSession,
		finalResponseText: options.finalResponseText ?? "Intent complete.",
		accounting,
		async requestModel(session) {
			const kind = session.roleInstructions.includes("requirement auditor")
				? "requirement"
				: "test";
			calls.push(kind);
			const text =
				options.baseAudit?.(kind) ??
				(kind === "requirement"
					? JSON.stringify({
							rows: [{ constraint: "Change threshold to 8.", maps_to: "A1" }],
						})
					: JSON.stringify({
							items: [
								{ id: "A1", verdict: "valid", citation: "", reason: "" },
								{ id: "A2", verdict: "valid", citation: "", reason: "" },
							],
						}));
			return modelResult(session, text);
		},
	};
	return { filesystem, workflow, validation, calls, progress };
}

test("requirement ledger checks Request literals and target ids", () => {
	const items = [{ id: "A1", text: "Change the threshold.", line: 1 }];
	const valid = parseShapeRequirementLedger(
		JSON.stringify({
			rows: [{ constraint: "Change threshold to 8.", maps_to: "A1" }],
		}),
		requestBytes,
		items,
	);
	expect(valid.gaps).toEqual([]);
	const gap = parseShapeRequirementLedger(
		JSON.stringify({
			rows: [{ constraint: "Change threshold.", maps_to: "A9" }],
		}),
		requestBytes,
		items,
	);
	expect(gap.gaps).toContain(
		"Ledger row for Change threshold. maps to unknown item A9.",
	);
	expect(gap.gaps).toContain("Request literal 8 has no ledger row.");
	const literals = parseShapeRequirementLedger(
		JSON.stringify({
			rows: [{ constraint: "Set max_items to blue.", maps_to: "A1" }],
		}),
		bytes('Set `max_items` to "blue".'),
		items,
	);
	expect(literals.gaps).toEqual([]);
});

test("test audit repairs only exact citations and leaves duplicate items unusable", () => {
	const request = encoder.encode("Change threshold to 8.");
	const cited = parseShapeTestAudit(
		JSON.stringify({
			items: [
				{
					id: "A1",
					verdict: "over_strict",
					citation: "threshold to 8",
					reason: "Assertion is too strict.",
				},
			],
		}),
		["A1"],
		request,
		false,
	);
	expect(cited.repairs).toHaveLength(1);
	const uncited = parseShapeTestAudit(
		JSON.stringify({
			items: [
				{
					id: "A1",
					verdict: "over_strict",
					citation: "threshold to 9",
					reason: "Assertion is too strict.",
				},
			],
		}),
		["A1"],
		request,
		false,
	);
	expect(uncited.repairs).toEqual([]);
	expect(uncited.warnings[0]?.code).toBe("audit_over_strict");
	const duplicate = parseShapeTestAudit(
		JSON.stringify({
			items: [
				{ id: "A1", verdict: "valid", citation: "", reason: "" },
				{ id: "A1", verdict: "valid", citation: "", reason: "" },
				{ id: "A1", verdict: "valid", citation: "", reason: "" },
			],
		}),
		["A1"],
		request,
		false,
	);
	expect(duplicate.repairs).toEqual([]);
	expect(duplicate.warnings.map((item) => item.code)).toContain(
		"audit_missing",
	);
});

test("ledger gap still calls the test auditor and combines exact repair feedback", async () => {
	const fixture = makeWorkflow({
		baseAudit(kind) {
			return kind === "requirement"
				? JSON.stringify({ rows: [] })
				: JSON.stringify({
						items: [
							{
								id: "A1",
								verdict: "over_strict",
								citation: "Change threshold to 8.",
								reason: "The test rejects the requested threshold.",
							},
							{ id: "A2", verdict: "valid", citation: "", reason: "" },
						],
					});
		},
	});
	const outcome = await fixture.workflow(fixture.validation);
	expect(fixture.calls).toEqual(["requirement", "test"]);
	expect(outcome.kind).toBe("repair");
	if (outcome.kind !== "repair") throw new Error("Expected combined repair.");
	expect(outcome.repairKind).toBe("combined");
	expect(outcome.feedback).toBe(
		[
			"Validation failed. Repair the generated files in this conversation. The required paths and their current state are:",
			"- `.kogen/intents/shape-48/intent.md`: present on disk. Keep it in place; change it only if the failure below requires a correction.",
			"- `.kogen/acceptance/shape-48.sh`: present on disk. Keep it in place; change it only if the failure below requires a correction.",
			"Both exact paths must exist after this pass. Every missing path must be written now. Do not delete required files. The available tools can read, search, and write files; they cannot remove them. Preserve present content unless the failure below requires a focused correction.",
			"",
			"Exact failure output:",
			"",
			"candidate/coverage_gap: Coverage gaps: Requirement auditor returned no constraint rows.; Request literal 8 has no ledger row.\n\nTest audit findings: A1 over_strict: The test rejects the requested threshold. (Request citation: Change threshold to 8.)",
		].join("\n"),
	);
	expect(fixture.filesystem.get(workdir, sourcePath)).toEqual(testBytes);
	expect(fixture.filesystem.get(workdir, candidatePath)).toBeUndefined();
	const ledgerBytes = fixture.filesystem.get(
		workdir,
		`.kogen/intents/${slug}/ledger.json`,
	);
	expect(ledgerBytes).toBeDefined();
	if (ledgerBytes === undefined) throw new Error("Expected ledger artifact.");
	expect(JSON.parse(decoder.decode(ledgerBytes))).toEqual({
		approval_sha256: shapeApprovalSha256(
			fixture.filesystem.get(workdir, intentPath) ?? intentBytes,
			testBytes,
		),
		rows: [],
	});
	expect(
		fixture.filesystem.writes.find((write) =>
			write.path.endsWith("/ledger.json"),
		)?.mode,
	).toBe(0o600);
});

test("a remaining coverage gap becomes an ordered warning after its one repair", async () => {
	const fixture = makeWorkflow({
		baseAudit(kind) {
			return kind === "requirement"
				? JSON.stringify({ rows: [] })
				: JSON.stringify({
						items: [
							{ id: "A1", verdict: "valid", citation: "", reason: "" },
							{ id: "A2", verdict: "valid", citation: "", reason: "" },
						],
					});
		},
	});
	const repair = await fixture.workflow(fixture.validation);
	expect(repair.kind).toBe("repair");
	const valid = await fixture.workflow({
		...fixture.validation,
		passNumber: 2,
	});
	expect(fixture.calls).toEqual(["requirement", "test", "requirement", "test"]);
	expect(valid.kind).toBe("valid");
	if (valid.kind !== "valid")
		throw new Error("Expected a warning pass after repair.");
	expect(valid.warnings?.map((warning) => warning.code)).toEqual([
		"coverage_gap",
	]);
});

test("shape-15 all-items-keep stops before auditors", async () => {
	const fixture = makeWorkflow({ statuses: ["passed", "passed"] });
	const outcome = await fixture.workflow(fixture.validation);
	expect(outcome.kind).toBe("repair");
	if (outcome.kind !== "repair")
		throw new Error("Expected all-items-keep repair.");
	expect(outcome.failure.reason).toBe("candidate/all_items_keep");
	expect(fixture.calls).toEqual([]);
	expect(fixture.filesystem.get(workdir, sourcePath)).toEqual(testBytes);
	expect(fixture.filesystem.get(workdir, candidatePath)).toBeUndefined();
});

test("base red reclassification changes both Verify directions and groups warnings", async () => {
	const tabbedIntent = bytes(
		decoder
			.decode(intentBytes)
			.replace("- A1: test domain=app", "- A1:\ttest domain=app"),
	);
	const fixture = makeWorkflow({
		statuses: ["passed", "failed"],
		intentSource: tabbedIntent,
	});
	const outcome = await fixture.workflow(fixture.validation);
	expect(fixture.calls).toEqual(["requirement", "test"]);
	expect(outcome.kind).toBe("valid");
	if (outcome.kind !== "valid")
		throw new Error("Expected a valid pass after reclassification.");
	expect(
		outcome.warnings?.map((warning) => [warning.code, warning.item_ids]),
	).toEqual([
		["shape_reclassified", ["A2"]],
		["shape_reclassified", ["A1"]],
	]);
	const savedIntent = fixture.filesystem.get(workdir, intentPath);
	expect(savedIntent).toBeDefined();
	if (savedIntent === undefined)
		throw new Error("Expected reclassified Intent.");
	const savedText = decoder.decode(savedIntent);
	expect(savedText).toContain("- A1:\ttest keep domain=app");
	expect(savedText).toContain("- A2: test domain=app");
	expect(savedText).toContain("## Request\nChange threshold to 8.");
	const warningBytes = fixture.filesystem.get(
		workdir,
		`.kogen/intents/${slug}/shape-warnings.json`,
	);
	expect(warningBytes).toBeDefined();
	if (warningBytes === undefined)
		throw new Error("Expected warnings artifact.");
	const artifact = JSON.parse(decoder.decode(warningBytes)) as {
		approval_sha256: string;
	};
	expect(artifact.approval_sha256).toBe(
		shapeApprovalSha256(savedIntent, testBytes),
	);
});

test("shape-17 undeclared gate path is exact candidate feedback before checks", async () => {
	const changedIntent = bytes(
		decoder
			.decode(intentBytes)
			.replace(
				"Approach: update threshold handling in the existing module and preserve validation behavior.",
				"Approach: update checks/lint.sh to skip blank lines and preserve validation behavior.",
			),
	);
	const fixture = makeWorkflow({
		intentSource: changedIntent,
		gatePaths: ["checks/lint.sh"],
	});
	const outcome = await fixture.workflow(fixture.validation);
	expect(outcome.kind).toBe("repair");
	if (outcome.kind !== "repair")
		throw new Error("Expected gate declaration repair.");
	expect(outcome.failure.reason).toBe("candidate/undeclared_gate_path");
	expect(outcome.feedback).toContain(
		"Gate-path edit requires `changes_gate: true`; matched path checks/lint.sh.",
	);
	expect(fixture.calls).toEqual([]);
});

test("shape-16 acceptance check tool missing is an environment failure", async () => {
	const fixture = makeWorkflow({
		processExitCodes: [127],
		acceptanceChecks: [
			{ name: "syntax", argv: ["missing-check", "{path}"], timeoutMs: 1000 },
		],
	});
	const outcome = await fixture.workflow(fixture.validation);
	expect(outcome.kind).toBe("failure");
	if (outcome.kind !== "failure")
		throw new Error("Expected an environment failure.");
	expect(outcome.failure.category).toBe("environment");
	expect(outcome.failure.reason).toBe(
		"environment/acceptance_check_unavailable",
	);
	expect(fixture.calls).toEqual([]);
	const redCheck = makeWorkflow({
		processExitCodes: [1],
		acceptanceChecks: [
			{ name: "syntax", argv: ["syntax-check", "{path}"], timeoutMs: 1000 },
		],
	});
	const red = await redCheck.workflow(redCheck.validation);
	expect(red.kind).toBe("repair");
	if (red.kind !== "repair")
		throw new Error("Expected acceptance check repair.");
	expect(red.failure.reason).toBe("candidate/acceptance_check_failed");
	expect(redCheck.calls).toEqual([]);
});

test("shape-21 uncited test audit advice warns without repairing", async () => {
	const fixture = makeWorkflow({
		baseAudit(kind) {
			return kind === "requirement"
				? JSON.stringify({
						rows: [{ constraint: "Change threshold to 8.", maps_to: "A1" }],
					})
				: JSON.stringify({
						items: [
							{
								id: "A1",
								verdict: "over_strict",
								citation: "",
								reason: "Feels strict.",
							},
							{ id: "A2", verdict: "valid", citation: "", reason: "" },
						],
					});
		},
	});
	const outcome = await fixture.workflow(fixture.validation);
	expect(outcome.kind).toBe("valid");
	expect(fixture.calls).toEqual(["requirement", "test"]);
	if (outcome.kind !== "valid")
		throw new Error("Expected uncited advice to warn only.");
	expect(
		outcome.warnings?.map((warning) => [warning.code, warning.item_ids]),
	).toEqual([["audit_over_strict", ["A1"]]]);
});

test("formatter unavailable stays a warning and concerns are appended last", async () => {
	const fixture = makeWorkflow({
		processExitCodes: [127],
		format: ["missing-formatter"],
		finalResponseText:
			"Intent complete.\n\nConcerns:\n- This may need a migration.\n",
	});
	const outcome = await fixture.workflow(fixture.validation);
	expect(outcome.kind).toBe("valid");
	if (outcome.kind !== "valid") throw new Error("Expected a valid Shape pass.");
	expect(fixture.progress).toEqual(["formatter_unavailable"]);
	expect(outcome.warnings?.map((warning) => warning.code)).toEqual([
		"formatter_unavailable",
		"feasibility_concern",
	]);
	const warningBytes = fixture.filesystem.get(
		workdir,
		`.kogen/intents/${slug}/shape-warnings.json`,
	);
	expect(warningBytes).toBeDefined();
	if (warningBytes === undefined) throw new Error("Expected warning artifact.");
	const artifact = JSON.parse(decoder.decode(warningBytes)) as {
		approval_sha256: string;
		warnings: readonly { code: string }[];
	};
	expect(artifact.approval_sha256).toBe(
		shapeApprovalSha256(
			fixture.filesystem.get(workdir, intentPath) ?? intentBytes,
			testBytes,
		),
	);
	expect(artifact.warnings.map((warning) => warning.code)).toEqual([
		"feasibility_concern",
	]);
});

test("shape warning artifact filters progress-only codes and preserves supplied warning order", () => {
	const artifact = createShapeWarningsArtifact({
		intentBytes,
		acceptanceBytes: testBytes,
		warnings: [
			{ code: "lint_notes_style", item_ids: [], message: "style" },
			{ code: "formatter_unavailable", item_ids: [], message: "progress only" },
			{ code: "coverage_gap", item_ids: [], message: "coverage" },
		],
	});
	expect(artifact.warnings.map((warning) => warning.code)).toEqual([
		"lint_notes_style",
		"coverage_gap",
	]);
});
