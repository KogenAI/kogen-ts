import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import type {
	ApprovalScratchWorkspace,
	ApprovalWorkspacePort,
} from "../../core/src/approval/preflight";
import type { Result } from "../../core/src/contracts/errors";
import type { ProcessPort } from "../../core/src/contracts/ports";
import type {
	GateTreePort,
	GateTreeSnapshot,
} from "../../core/src/gate/checks";
import { cloneFreshWorkspace } from "../../core/src/workspace/clone";

function failure(message: string): Result<never> {
	return {
		ok: false,
		error: { code: "io", message, retryable: false },
	};
}

/** Fingerprint scratch bytes, modes and links without following any links. */
function treeFingerprint(root: string): string {
	const hash = createHash("sha256");
	function visit(directory: string, relative: string): void {
		for (const name of readdirSync(directory).sort()) {
			if (relative === "" && name === ".git") continue;
			const path = join(directory, name);
			const child = relative === "" ? name : `${relative}/${name}`;
			const stat = lstatSync(path);
			hash.update(`${child}\0${stat.mode & 0o7777}\0`);
			if (stat.isSymbolicLink()) {
				hash.update("link\0");
				hash.update(readlinkSync(path));
			} else if (stat.isDirectory()) {
				hash.update("dir\0");
				visit(path, child);
			} else if (stat.isFile()) {
				hash.update("file\0");
				const bytes = readFileSync(path);
				hash.update(`${bytes.byteLength}\0`);
				hash.update(bytes);
			} else {
				throw new Error(`Unsupported scratch entry: ${child}`);
			}
		}
	}
	visit(root, "");
	return hash.digest("hex");
}

function copyContents(source: string, destination: string): void {
	mkdirSync(destination, { recursive: true, mode: 0o700 });
	for (const name of readdirSync(source)) {
		if (name === ".git") continue;
		cpSync(join(source, name), join(destination, name), {
			recursive: true,
			dereference: false,
			verbatimSymlinks: true,
			preserveTimestamps: true,
		});
	}
}

/** The backup is outside the disposable clone and is never model writable. */
class ScratchTree implements GateTreePort {
	private readonly initialFingerprint: string;
	private readonly snapshots = new Map<string, string>();
	private sequence = 0;

	constructor(
		private readonly root: string,
		private readonly backupRoot: string,
		private readonly baseTree: string,
	) {
		this.initialFingerprint = treeFingerprint(root);
		mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
	}

	async snapshot(): Promise<Result<GateTreeSnapshot>> {
		try {
			const fingerprint = treeFingerprint(this.root);
			const restoreToken = `snapshot-${++this.sequence}`;
			const backup = join(this.backupRoot, restoreToken);
			copyContents(this.root, backup);
			this.snapshots.set(restoreToken, backup);
			return {
				ok: true,
				value: {
					identity:
						fingerprint === this.initialFingerprint
							? this.baseTree
							: fingerprint,
					restoreToken,
				},
			};
		} catch (cause) {
			return failure(`Could not snapshot approval scratch: ${String(cause)}`);
		}
	}

	async changedPaths(
		_before: GateTreeSnapshot,
		_after: GateTreeSnapshot,
	): Promise<Result<readonly string[]>> {
		// Approval preflight compares exact identities; it never requests a path list.
		return { ok: true, value: [] };
	}

	async restore(snapshot: GateTreeSnapshot): Promise<Result<void>> {
		const backup = this.snapshots.get(snapshot.restoreToken);
		if (backup === undefined || !existsSync(backup))
			return failure("Approval scratch snapshot is missing.");
		try {
			for (const name of readdirSync(this.root)) {
				if (name !== ".git")
					rmSync(join(this.root, name), { recursive: true, force: true });
			}
			copyContents(backup, this.root);
			return { ok: true, value: undefined };
		} catch (cause) {
			return failure(`Could not restore approval scratch: ${String(cause)}`);
		}
	}
}

export function createApprovalWorkspace(
	checkoutPath: string,
	origin: string,
	process: Pick<ProcessPort, "run">,
	baseTree: string,
	stageDirectory: string,
): ApprovalWorkspacePort {
	const checkoutTree: GateTreePort = {
		async snapshot() {
			try {
				return {
					ok: true,
					value: {
						identity: treeFingerprint(checkoutPath),
						restoreToken: "checkout-read-only",
					},
				};
			} catch (cause) {
				return failure(`Could not snapshot checkout: ${String(cause)}`);
			}
		},
		async changedPaths() {
			return { ok: true, value: [] };
		},
		async restore() {
			return failure("The checkout cannot be restored by approval preflight.");
		},
	};
	return {
		checkoutPath,
		checkoutTree,
		async createScratch(request): Promise<Result<ApprovalScratchWorkspace>> {
			const destination = join(request.scratchRoot, `base-${request.slug}`);
			const cloned = await cloneFreshWorkspace(process, {
				sourceRepository: origin,
				destination,
				baseCommit: request.baseCommit,
			});
			if (!cloned.ok) return cloned;
			if (stageDirectory !== ".")
				mkdirSync(join(destination, stageDirectory), {
					recursive: true,
					mode: 0o700,
				});
			const tree = new ScratchTree(
				destination,
				join(request.scratchRoot, "snapshots"),
				baseTree,
			);
			return {
				ok: true,
				value: {
					path: destination,
					baseTree: request.expectedTree,
					tree,
					async remove(): Promise<Result<void>> {
						try {
							rmSync(destination, { recursive: true, force: false });
							return { ok: true, value: undefined };
						} catch (cause) {
							return failure(
								`Could not remove approval scratch: ${String(cause)}`,
							);
						}
					},
				},
			};
		},
	};
}
