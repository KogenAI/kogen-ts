import type { PortError, Result } from "../contracts/errors";
import type { FileSystemPort } from "../contracts/ports";
import { hashApprovalBytes } from "../intent/hash";
import { isValidIntentSlug } from "../intent/parse";
import type { ShapeWarning } from "./controller";
import type { ShapeRequirementLedgerRow } from "./ledger";

export interface ShapeLedgerArtifact {
	readonly approval_sha256: string;
	readonly rows: readonly ShapeRequirementLedgerRow[];
}

export interface ShapeWarningsArtifact {
	readonly approval_sha256: string;
	readonly warnings: readonly ShapeWarning[];
}

const encoder = new TextEncoder();
const MAX_SHAPE_ARTIFACT_BYTES = 1024 * 1024;
const PERSISTED_WARNING_CODE =
	/^(?:shape_reclassified|feasibility_concern|coverage_gap|lint_[a-z0-9_]+|audit_[a-z0-9_]+)$/u;

function error(code: PortError["code"], message: string): PortError {
	return { code, message, retryable: code === "io" || code === "unavailable" };
}

function artifactPath(
	slug: string,
	name: "ledger.json" | "shape-warnings.json",
): string | null {
	if (!isValidIntentSlug(slug)) return null;
	return `.kogen/intents/${slug}/${name}`;
}

function artifactBytes(value: unknown): Result<Uint8Array> {
	const bytes = encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
	if (bytes.byteLength > MAX_SHAPE_ARTIFACT_BYTES)
		return {
			ok: false,
			error: error("invalid_input", "Shape artifact exceeds its size limit."),
		};
	return { ok: true, value: bytes };
}

export function shapeApprovalSha256(
	intentBytes: Uint8Array,
	acceptanceBytes: Uint8Array,
): string {
	return hashApprovalBytes(intentBytes, acceptanceBytes);
}

export function createShapeLedgerArtifact(input: {
	readonly intentBytes: Uint8Array;
	readonly acceptanceBytes: Uint8Array;
	readonly rows: readonly ShapeRequirementLedgerRow[];
}): ShapeLedgerArtifact {
	return {
		approval_sha256: shapeApprovalSha256(
			input.intentBytes,
			input.acceptanceBytes,
		),
		rows: input.rows.map((row) => ({
			constraint: row.constraint,
			maps_to: row.maps_to,
		})),
	};
}

export function createShapeWarningsArtifact(input: {
	readonly intentBytes: Uint8Array;
	readonly acceptanceBytes: Uint8Array;
	readonly warnings: readonly ShapeWarning[];
}): ShapeWarningsArtifact {
	return {
		approval_sha256: shapeApprovalSha256(
			input.intentBytes,
			input.acceptanceBytes,
		),
		warnings: input.warnings
			.filter((warning) => PERSISTED_WARNING_CODE.test(warning.code))
			.map((warning) => ({
				code: warning.code,
				item_ids: [...warning.item_ids],
				message: warning.message,
			})),
	};
}

export async function writeShapeLedgerArtifact(
	filesystem: Pick<FileSystemPort, "writeFileAtomically">,
	workdir: string,
	slug: string,
	artifact: ShapeLedgerArtifact,
): Promise<Result<void>> {
	const path = artifactPath(slug, "ledger.json");
	if (path === null || !workdir.startsWith("/") || workdir.includes("\0"))
		return {
			ok: false,
			error: error("invalid_input", "Shape ledger artifact path is invalid."),
		};
	const bytes = artifactBytes(artifact);
	if (!bytes.ok) return bytes;
	return filesystem.writeFileAtomically({
		root: workdir,
		path,
		bytes: bytes.value,
		mode: 0o600,
	});
}

export async function writeShapeWarningsArtifact(
	filesystem: Pick<FileSystemPort, "writeFileAtomically">,
	workdir: string,
	slug: string,
	artifact: ShapeWarningsArtifact,
): Promise<Result<void>> {
	const path = artifactPath(slug, "shape-warnings.json");
	if (path === null || !workdir.startsWith("/") || workdir.includes("\0"))
		return {
			ok: false,
			error: error("invalid_input", "Shape warnings artifact path is invalid."),
		};
	const bytes = artifactBytes(artifact);
	if (!bytes.ok) return bytes;
	return filesystem.writeFileAtomically({
		root: workdir,
		path,
		bytes: bytes.value,
		mode: 0o600,
	});
}

/** Remove stale controller artifacts once, before the first Shape pass. */
export async function clearStaleShapeArtifacts(
	filesystem: Pick<FileSystemPort, "removeFile">,
	workdir: string,
	slug: string,
): Promise<Result<void>> {
	if (
		!isValidIntentSlug(slug) ||
		!workdir.startsWith("/") ||
		workdir.includes("\0")
	)
		return {
			ok: false,
			error: error("invalid_input", "Shape artifact cleanup path is invalid."),
		};
	for (const name of ["shape-warnings.json", "ledger.json"] as const) {
		const path = artifactPath(slug, name);
		if (path === null) continue;
		const removed = await filesystem.removeFile(workdir, path);
		if (!removed.ok && removed.error.code !== "not_found") return removed;
	}
	return { ok: true, value: undefined };
}
