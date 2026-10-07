import { createHash } from "node:crypto";

const NUL = new Uint8Array([0]);

/** SHA-256 of the exact Intent source bytes, including Request and line endings. */
export function hashIntentBytes(intentBytes: Uint8Array): string {
	return createHash("sha256").update(intentBytes).digest("hex");
}

/**
 * Approval digest: exact Intent bytes, one NUL byte, then exact acceptance
 * source bytes. Inputs are never decoded or newline-normalized.
 */
export function hashApprovalBytes(
	intentBytes: Uint8Array,
	acceptanceBytes: Uint8Array,
): string {
	return createHash("sha256")
		.update(intentBytes)
		.update(NUL)
		.update(acceptanceBytes)
		.digest("hex");
}

export const hashIntentSha256 = hashIntentBytes;
export const hashApprovalSha256 = hashApprovalBytes;
