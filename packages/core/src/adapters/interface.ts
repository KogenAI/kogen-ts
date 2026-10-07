import type { Result } from "../contracts/errors";
import type { FileSystemPort, ProcessPort } from "../contracts/ports";

export type AcceptanceRowStatus =
	| "passed"
	| "failed"
	| "skipped"
	| "excluded"
	| "invalid";

export interface AcceptanceLedgerRow {
	readonly tag: string;
	readonly test: string;
	readonly status: AcceptanceRowStatus;
}

export interface AdapterLog {
	readonly stdout: Uint8Array;
	readonly stderr: Uint8Array;
}

export interface AdapterRunResult {
	readonly exitStatus: number | null;
	readonly timedOut: boolean;
	readonly log: AdapterLog;
}

export interface StageAcceptanceTestRequest {
	readonly filesystem: Pick<
		FileSystemPort,
		"readFile" | "writeFileAtomically" | "removeFile"
	>;
	/** Checkout containing the approved source acceptance test. */
	readonly sourceRoot: string;
	/** Candidate worktree where the test is staged and the source copy removed. */
	readonly workdir: string;
	readonly slug: string;
}

export interface StagedAcceptanceTest {
	readonly sourcePath: string;
	readonly candidatePath: string;
	readonly bytesWritten: number;
}

export interface RunAcceptanceTestRequest {
	readonly process: Pick<ProcessPort, "run">;
	readonly workdir: string;
	readonly slug: string;
	readonly reportPath: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly timeoutMilliseconds: number;
}

/**
 * Adapter boundary shared by Build and Shape. Paths are worktree-relative and
 * runners receive explicit argv and a caller-provided, already-filtered child
 * environment.
 */
export interface AcceptanceAdapter {
	readonly name: string;
	sourcePath(slug: string): string;
	candidatePath(slug: string): string;
	stage(
		request: StageAcceptanceTestRequest,
	): Promise<Result<StagedAcceptanceTest>>;
	run(request: RunAcceptanceTestRequest): Promise<Result<AdapterRunResult>>;
	/** Stack adapters may identify missing tools from their captured log. */
	unavailable?(log: AdapterLog): boolean;
}
