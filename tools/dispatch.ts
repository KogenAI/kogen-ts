import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface Packet {
	readonly id: string;
	readonly name: string;
	readonly deps: readonly string[];
	readonly minutes: number;
	readonly title: string;
	readonly owned: string;
	readonly goal: string;
	readonly acceptance: string;
}

interface PackageQueueRow {
	readonly name: string;
	readonly deps: readonly string[];
}

interface GateRequirement {
	readonly packageName: string;
	readonly gate: string;
}

interface IntegrationGate {
	readonly id: string;
	readonly deps: readonly string[];
	readonly prior: string | null;
}

interface Receipt {
	readonly status: string;
	readonly headSha: string | null;
}

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
if (args.length !== 1 || (args[0] !== "--dry-run" && args[0] !== "--check")) {
	throw new Error(
		"Usage: tools/dispatch.ts --dry-run|--check (worker and integration hooks are owned by later rounds)",
	);
}
const showDetails = args[0] === "--dry-run";

function readText(relativePath: string): string {
	return readFileSync(join(root, relativePath), "utf8");
}

function parseIds(raw: string): string[] {
	return raw === "none" ? [] : raw.split(",");
}

function parseQueue(): PackageQueueRow[] {
	return readText("docs/work/QUEUE.txt")
		.split(/\r?\n/)
		.filter((line) => line.length > 0)
		.map((line) => {
			const match = /^(\d{2}-[a-z0-9-]+) deps: (none|\d{2}(?:,\d{2})*)$/.exec(
				line,
			);
			if (!match?.[1] || !match[2])
				throw new Error(`Invalid queue row: ${line}`);
			return { name: match[1], deps: parseIds(match[2]) };
		});
}

function parseGates(): GateRequirement[] {
	return readText("docs/work/GATES.txt")
		.split(/\r?\n/)
		.filter((line) => line.length > 0)
		.map((line) => {
			const match = /^(\d{2}-[a-z0-9-]+) gate: (I\d+)$/.exec(line);
			if (!match?.[1] || !match[2])
				throw new Error(`Invalid gate row: ${line}`);
			return { packageName: match[1], gate: match[2] };
		});
}

function parseIntegration(): IntegrationGate[] {
	return readText("docs/work/INTEGRATION.txt")
		.split(/\r?\n/)
		.filter((line) => line.length > 0)
		.map((line) => {
			const match =
				/^(I\d+) deps: (none|\d{2}(?:,\d{2})*) prior: (none|I\d+)$/.exec(line);
			if (!match?.[1] || !match[2] || !match[3])
				throw new Error(`Invalid integration row: ${line}`);
			return {
				id: match[1],
				deps: parseIds(match[2]),
				prior: match[3] === "none" ? null : match[3],
			};
		});
}

function git(args: readonly string[], allowMissing = false): string | null {
	const command = args[0];
	if (!command) throw new Error("Missing Git command");
	const result = spawnSync("git", [...args], {
		cwd: root,
		encoding: "utf8",
		timeout: 10_000,
		maxBuffer: 1024 * 1024,
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: process.env.HOME ?? "/dev/null",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			LC_ALL: "C",
			TZ: "UTC",
		},
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		if (allowMissing) return null;
		throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function isAncestor(commit: string, head: string): boolean {
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) return false;
	return git(["merge-base", "--is-ancestor", commit, head], true) !== null;
}

const resolvedHead = git(["rev-parse", "--verify", "HEAD"]);
if (resolvedHead === null)
	throw new Error("Cannot determine the current Git HEAD");
const currentHead: string = resolvedHead;

function committedReceipt(relativePath: string): Receipt | null {
	const pathInHead = git(["cat-file", "-e", `HEAD:${relativePath}`], true);
	if (pathInHead === null) return null;
	const text = git(["show", `HEAD:${relativePath}`]);
	if (text === null)
		throw new Error(`Could not read committed receipt ${relativePath}`);
	const status = /^Status:\s*([A-Za-z_-]+)\s*$/im
		.exec(text)?.[1]
		?.toUpperCase();
	const headSha =
		/^Head SHA:\s*([a-f0-9]{40}|[a-f0-9]{64})\s*$/im.exec(text)?.[1] ?? null;
	return { status: status ?? "UNKNOWN", headSha };
}

function isMergedReceipt(receipt: Receipt | null): boolean {
	if (receipt === null) return false;
	const headSha = receipt.headSha;
	return (
		(receipt.status === "MERGED" || receipt.status === "ACCEPTED") &&
		headSha !== null &&
		isAncestor(headSha, currentHead)
	);
}

const packets = JSON.parse(readText("docs/work/packages.json")) as Packet[];
const byId = new Map(packets.map((packet) => [packet.id, packet]));
if (packets.length !== 66 || byId.size !== packets.length)
	throw new Error("Expected 66 uniquely identified queue packets");

const queueRows = parseQueue();
if (queueRows.length !== packets.length)
	throw new Error("Queue and package counts differ");
for (const row of queueRows) {
	const id = row.name.slice(0, 2);
	const packet = byId.get(id);
	if (
		!packet ||
		packet.name !== row.name ||
		packet.deps.join(",") !== row.deps.join(",")
	)
		throw new Error(`Queue and package DAG disagree at ${row.name}`);
	for (const dependency of packet.deps) {
		if (!byId.has(dependency))
			throw new Error(`${packet.id} has unknown dependency ${dependency}`);
	}
}

function assertAcyclic<T>(
	items: readonly T[],
	getId: (item: T) => string,
	getDeps: (item: T) => readonly string[],
): void {
	const remaining = new Map(
		items.map((item) => [getId(item), new Set(getDeps(item))]),
	);
	while (remaining.size > 0) {
		const ready = [...remaining]
			.filter(([, deps]) =>
				[...deps].every((dependency) => !remaining.has(dependency)),
			)
			.map(([id]) => id);
		if (ready.length === 0)
			throw new Error("Dependency graph contains a cycle");
		for (const id of ready) remaining.delete(id);
	}
}

assertAcyclic(
	packets,
	(packet) => packet.id,
	(packet) => packet.deps,
);

const gateRequirements = parseGates();
const gatesByPackage = new Map(
	gateRequirements.map((entry) => [entry.packageName, entry.gate]),
);
for (const requirement of gateRequirements) {
	if (!packets.some((packet) => packet.name === requirement.packageName))
		throw new Error(
			`Gate references unknown package ${requirement.packageName}`,
		);
}

const integrationGates = parseIntegration();
const integrationById = new Map(
	integrationGates.map((gate) => [gate.id, gate]),
);
if (integrationById.size !== integrationGates.length)
	throw new Error("Duplicate integration gate ID");
for (const gate of integrationGates) {
	for (const dependency of gate.deps) {
		if (!byId.has(dependency))
			throw new Error(`${gate.id} has unknown dependency ${dependency}`);
	}
	if (gate.prior !== null && !integrationById.has(gate.prior))
		throw new Error(`${gate.id} has unknown prior gate ${gate.prior}`);
}
assertAcyclic(
	[
		...packets.map((packet) => ({
			id: `P${packet.id}`,
			deps: [
				...packet.deps.map((dependency) => `P${dependency}`),
				...(gatesByPackage.has(packet.name)
					? [gatesByPackage.get(packet.name) ?? ""]
					: []),
			],
		})),
		...integrationGates.map((gate) => ({
			id: gate.id,
			deps: [
				...gate.deps.map((dependency) => `P${dependency}`),
				...(gate.prior === null ? [] : [gate.prior]),
			],
		})),
	],
	(item) => item.id,
	(item) => item.deps,
);

const packageReceipts = new Map(
	packets.map((packet) => [
		packet.id,
		committedReceipt(`docs/work/receipts/${packet.name}.md`),
	]),
);
const gateReceipts = new Map(
	integrationGates.map((gate) => [
		gate.id,
		committedReceipt(`docs/work/receipts/${gate.id}.md`),
	]),
);

function gateIsReady(gateId: string): boolean {
	const gate = integrationById.get(gateId);
	if (!gate) return false;
	const receipt = gateReceipts.get(gateId) ?? null;
	if (!isMergedReceipt(receipt)) return false;
	if (gate.prior !== null && !gateIsReady(gate.prior)) return false;
	return gate.deps.every((dependency) =>
		isMergedReceipt(packageReceipts.get(dependency) ?? null),
	);
}

console.log(`Dispatcher dry-run: head=${currentHead}`);
console.log(
	"Mode: read-only DAG/receipt planning; no workers, pushes, or worktree cleanup",
);
let readyCount = 0;
let blockedCount = 0;
let mergedCount = 0;
let awaitingCount = 0;
let unverifiedCount = 0;
for (const packet of packets) {
	const blockers: string[] = [];
	for (const dependency of packet.deps) {
		if (!isMergedReceipt(packageReceipts.get(dependency) ?? null))
			blockers.push(`merged receipt ${dependency}`);
	}
	const requiredGate = gatesByPackage.get(packet.name);
	if (requiredGate && !gateIsReady(requiredGate))
		blockers.push(`accepted gate ${requiredGate}`);
	const receipt = packageReceipts.get(packet.id) ?? null;
	const status = isMergedReceipt(receipt)
		? "MERGED"
		: receipt?.status === "AWAITING_INTEGRATION"
			? "AWAITING_INTEGRATION"
			: receipt !== null
				? "UNVERIFIED_RECEIPT"
				: blockers.length === 0
					? "READY"
					: "BLOCKED";
	const detail =
		status === "BLOCKED"
			? ` waits for ${blockers.join("; ")}`
			: status === "MERGED"
				? ` receipt=${receipt?.headSha}`
				: status === "AWAITING_INTEGRATION"
					? ` receipt=${receipt?.headSha}`
					: status === "UNVERIFIED_RECEIPT"
						? " receipt needs coordinator review"
						: " dependencies and integration gate are satisfied";
	if (status === "READY") readyCount += 1;
	else if (status === "BLOCKED") blockedCount += 1;
	else if (status === "MERGED") mergedCount += 1;
	else if (status === "AWAITING_INTEGRATION") awaitingCount += 1;
	else unverifiedCount += 1;
	if (showDetails)
		console.log(`${packet.id} ${status} ${packet.name}${detail}`);
}
console.log(
	`Queue state: ${readyCount} ready, ${blockedCount} blocked, ${awaitingCount} awaiting integration, ${mergedCount} merged, ${unverifiedCount} unverified receipts`,
);
console.log(
	"No worker was launched; failed worktrees are never removed by this planner.",
);
