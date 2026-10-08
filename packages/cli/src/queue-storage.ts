import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { PortError, Result } from "../../core/src/contracts/errors";
import type {
	QueueLockStorage,
	QueueOwnerIdentity,
} from "../../core/src/queue/lock";

function failure(cause: unknown): PortError {
	return {
		code: "io",
		message:
			cause instanceof Error ? cause.message : "Queue state is unavailable.",
		retryable: true,
		cause,
	};
}

function sameOwner(
	left: QueueOwnerIdentity | null,
	right: QueueOwnerIdentity,
): boolean {
	return left?.pid === right.pid && left.startedMs === right.startedMs;
}

/** Private state-root adapter; a short mkdir transaction serializes all owner and stop changes. */
export class FileQueueLockStorage implements QueueLockStorage {
	private readonly transactionPath: string;
	private readonly ownerPath: string;
	private readonly pidPath: string;
	private readonly stopPath: string;

	constructor(readonly root: string) {
		mkdirSync(root, { recursive: true, mode: 0o700 });
		this.transactionPath = join(root, "queue.transaction");
		this.ownerPath = join(root, "queue.owner.json");
		this.pidPath = join(root, "queue.pid");
		this.stopPath = join(root, "queue.stop");
	}

	private async transaction<Value>(
		operation: () => Value,
	): Promise<Result<Value>> {
		for (let attempt = 0; attempt < 300; attempt += 1) {
			try {
				mkdirSync(this.transactionPath, { mode: 0o700 });
				try {
					return { ok: true, value: operation() };
				} finally {
					rmSync(this.transactionPath, { recursive: true, force: false });
				}
			} catch (cause) {
				if ((cause as NodeJS.ErrnoException).code !== "EEXIST")
					return { ok: false, error: failure(cause) };
				await Bun.sleep(10);
			}
		}
		return {
			ok: false,
			error: {
				code: "timeout",
				message: "Queue state transaction timed out.",
				retryable: true,
			},
		};
	}

	private readOwnerDirect(): QueueOwnerIdentity | null {
		if (!existsSync(this.ownerPath)) return null;
		const value: unknown = JSON.parse(readFileSync(this.ownerPath, "utf8"));
		if (
			value === null ||
			typeof value !== "object" ||
			!("pid" in value) ||
			!("startedMs" in value) ||
			!Number.isSafeInteger(value.pid) ||
			!Number.isSafeInteger(value.startedMs)
		)
			throw new Error("Queue owner identity is invalid.");
		return { pid: value.pid as number, startedMs: value.startedMs as number };
	}

	private writeOwnerDirect(owner: QueueOwnerIdentity): void {
		writeFileSync(this.ownerPath, `${JSON.stringify(owner)}\n`, {
			mode: 0o600,
		});
		writeFileSync(this.pidPath, `${owner.pid}\n`, { mode: 0o600 });
		rmSync(this.stopPath, { force: true });
	}

	async readOwner(): Promise<Result<QueueOwnerIdentity | null>> {
		return this.transaction(() => this.readOwnerDirect());
	}

	async createOwnerAndClearStop(
		owner: QueueOwnerIdentity,
	): Promise<Result<"created" | "exists">> {
		return this.transaction(() => {
			if (this.readOwnerDirect() !== null) return "exists" as const;
			this.writeOwnerDirect(owner);
			return "created" as const;
		});
	}

	async compareExchangeOwnerAndClearStop(
		expected: QueueOwnerIdentity,
		replacement: QueueOwnerIdentity,
	): Promise<Result<boolean>> {
		return this.transaction(() => {
			if (!sameOwner(this.readOwnerDirect(), expected)) return false;
			this.writeOwnerDirect(replacement);
			return true;
		});
	}

	async removeOwnerIf(owner: QueueOwnerIdentity): Promise<Result<boolean>> {
		return this.transaction(() => {
			if (!sameOwner(this.readOwnerDirect(), owner)) return false;
			rmSync(this.ownerPath, { force: true });
			rmSync(this.pidPath, { force: true });
			rmSync(this.stopPath, { force: true });
			return true;
		});
	}

	async requestStopIfOwner(
		owner: QueueOwnerIdentity,
	): Promise<Result<boolean>> {
		return this.transaction(() => {
			if (!sameOwner(this.readOwnerDirect(), owner)) return false;
			writeFileSync(this.stopPath, "stop\n", { mode: 0o600 });
			return true;
		});
	}

	async readStopRequest(): Promise<Result<boolean>> {
		return this.transaction(() => existsSync(this.stopPath));
	}
}
