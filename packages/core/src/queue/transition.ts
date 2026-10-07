import { isValidIntentSlug } from "../intent/parse";

export interface QueueIntent {
	readonly slug: string;
	readonly approved: boolean;
	readonly landed: boolean;
	readonly priority: number;
	/** Approval commit time in epoch milliseconds; re-approval changes this key. */
	readonly approvedAt: number;
	readonly blocksOn: readonly string[];
}

export type QueueBlockReason =
	| "dependency_not_landed"
	| "dependency_cycle"
	| "unknown_dependency"
	| "invalid_dependencies";

export interface BlockedQueueIntent {
	readonly slug: string;
	readonly reason: QueueBlockReason;
	readonly dependencies: readonly string[];
}

export interface QueueSelection {
	readonly queued: readonly QueueIntent[];
	readonly blocked: readonly BlockedQueueIntent[];
}

const UTF8_ENCODER = new TextEncoder();

function compareUtf8(left: string, right: string): number {
	const a = UTF8_ENCODER.encode(left);
	const b = UTF8_ENCODER.encode(right);
	const length = Math.min(a.byteLength, b.byteLength);
	for (let index = 0; index < length; index += 1) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return a.byteLength - b.byteLength;
}

function compareQueueIntent(left: QueueIntent, right: QueueIntent): number {
	if (left.priority !== right.priority)
		return left.priority > right.priority ? -1 : 1;
	if (left.approvedAt !== right.approvedAt)
		return left.approvedAt < right.approvedAt ? -1 : 1;
	return compareUtf8(left.slug, right.slug);
}

function unresolvedDependencies(
	intents: ReadonlyMap<string, QueueIntent>,
	landedSlugs: ReadonlySet<string>,
): Map<string, string[]> {
	const graph = new Map<string, string[]>();
	for (const [slug, intent] of intents) {
		const dependencies: string[] = [];
		for (const dependency of intent.blocksOn) {
			if (landedSlugs.has(dependency)) continue;
			const target = intents.get(dependency);
			if (target?.landed) continue;
			if (target !== undefined) dependencies.push(dependency);
		}
		graph.set(slug, dependencies);
	}
	return graph;
}

/** Find every member of a dependency cycle without depending on input order. */
function cycleMembers(
	graph: ReadonlyMap<string, readonly string[]>,
): Set<string> {
	const reverse = new Map<string, string[]>();
	for (const slug of graph.keys()) reverse.set(slug, []);
	for (const [slug, dependencies] of graph) {
		for (const dependency of dependencies) reverse.get(dependency)?.push(slug);
	}

	const visited = new Set<string>();
	const finished: string[] = [];
	for (const root of graph.keys()) {
		if (visited.has(root)) continue;
		const stack: Array<{ readonly slug: string; readonly exit: boolean }> = [
			{ slug: root, exit: false },
		];
		while (stack.length > 0) {
			const frame = stack.pop();
			if (frame === undefined) continue;
			if (frame.exit) {
				finished.push(frame.slug);
				continue;
			}
			if (visited.has(frame.slug)) continue;
			visited.add(frame.slug);
			stack.push({ slug: frame.slug, exit: true });
			const dependencies = graph.get(frame.slug) ?? [];
			for (let index = dependencies.length - 1; index >= 0; index -= 1) {
				const dependency = dependencies[index];
				if (dependency !== undefined && !visited.has(dependency))
					stack.push({ slug: dependency, exit: false });
			}
		}
	}

	const assigned = new Set<string>();
	const cycles = new Set<string>();
	for (let index = finished.length - 1; index >= 0; index -= 1) {
		const root = finished[index];
		if (root === undefined || assigned.has(root)) continue;
		const component: string[] = [];
		const stack = [root];
		assigned.add(root);
		while (stack.length > 0) {
			const slug = stack.pop();
			if (slug === undefined) continue;
			component.push(slug);
			for (const dependent of reverse.get(slug) ?? []) {
				if (assigned.has(dependent)) continue;
				assigned.add(dependent);
				stack.push(dependent);
			}
		}
		if (component.length > 1 || (graph.get(root) ?? []).includes(root))
			for (const slug of component) cycles.add(slug);
	}
	return cycles;
}

function dependencyProblem(
	intent: QueueIntent,
	intents: ReadonlyMap<string, QueueIntent>,
	landedSlugs: ReadonlySet<string>,
	cycles: ReadonlySet<string>,
): BlockedQueueIntent | null {
	const dependencies = intent.blocksOn;
	const seen = new Set<string>();
	for (const dependency of dependencies) {
		if (!isValidIntentSlug(dependency) || seen.has(dependency))
			return {
				slug: intent.slug,
				reason: "invalid_dependencies",
				dependencies,
			};
		seen.add(dependency);
	}
	if (cycles.has(intent.slug))
		return { slug: intent.slug, reason: "dependency_cycle", dependencies };
	for (const dependency of dependencies) {
		if (landedSlugs.has(dependency) || intents.get(dependency)?.landed)
			continue;
		if (!intents.has(dependency))
			return { slug: intent.slug, reason: "unknown_dependency", dependencies };
		return {
			slug: intent.slug,
			reason: "dependency_not_landed",
			dependencies,
		};
	}
	return null;
}

function checkedIntents(
	intents: readonly QueueIntent[],
): Map<string, QueueIntent> {
	const indexed = new Map<string, QueueIntent>();
	for (const intent of intents) {
		if (typeof intent.slug !== "string" || !isValidIntentSlug(intent.slug))
			continue;
		if (
			typeof intent.approved !== "boolean" ||
			typeof intent.landed !== "boolean" ||
			!Number.isSafeInteger(intent.priority) ||
			!Number.isSafeInteger(intent.approvedAt) ||
			intent.approvedAt < 0 ||
			!Array.isArray(intent.blocksOn) ||
			!intent.blocksOn.every((dependency) => typeof dependency === "string")
		)
			throw new TypeError(
				"Queue priority and approval time must be safe integers.",
			);
		if (indexed.has(intent.slug))
			throw new TypeError(`Queue contains duplicate Intent ${intent.slug}.`);
		indexed.set(intent.slug, intent);
	}
	return indexed;
}

/**
 * Derive the runnable approvals from the current Intent/status snapshot.
 * Approval time is the approval commit time, so re-approval reorders ties.
 */
export function selectQueue(
	input: readonly QueueIntent[],
	landedSlugs: ReadonlySet<string> = new Set(),
): QueueSelection {
	const intents = checkedIntents(input);
	const graph = unresolvedDependencies(intents, landedSlugs);
	const cycles = cycleMembers(graph);
	const queued: QueueIntent[] = [];
	const blocked: BlockedQueueIntent[] = [];
	for (const intent of intents.values()) {
		if (!intent.approved || intent.landed || landedSlugs.has(intent.slug))
			continue;
		const problem = dependencyProblem(intent, intents, landedSlugs, cycles);
		if (problem) blocked.push(problem);
		else queued.push(intent);
	}
	queued.sort(compareQueueIntent);
	blocked.sort((left, right) => compareUtf8(left.slug, right.slug));
	return { queued, blocked };
}

export type QueueBuildOutcome =
	| "landed"
	| "failed"
	| "failed_provider"
	| "parked"
	| "stopped_environment"
	| "stopped_provider"
	| "stopped_controller"
	| "skipped";

export type QueueDrainLine =
	| "idle"
	| "building"
	| "already_running"
	| "stopping"
	| "not_running"
	| "nothing_to_build"
	| "done"
	| "stopped_on_request"
	| "stopped_because";

export interface QueueDrainState {
	readonly pending: readonly QueueIntent[];
	readonly attempted: readonly string[];
	readonly current: QueueIntent | null;
	readonly running: boolean;
	readonly stopRequested: boolean;
	readonly builds: number;
	readonly landed: number;
	readonly exitCode: number;
	readonly line: QueueDrainLine;
	readonly stoppedSlug: string | null;
	readonly stoppedClass: "environment" | "provider" | "controller" | null;
}

export type QueueDrainEvent =
	| { readonly type: "start" }
	| { readonly type: "stop" }
	| {
			readonly type: "refresh";
			readonly queue: readonly QueueIntent[];
			readonly landedSlugs?: ReadonlySet<string>;
	  }
	| { readonly type: "outcome"; readonly outcome: QueueBuildOutcome };

export function initialQueueDrain(
	queue: readonly QueueIntent[],
	landedSlugs: ReadonlySet<string> = new Set(),
): QueueDrainState {
	const eligible = selectQueue(queue, landedSlugs).queued;
	return {
		pending: eligible,
		attempted: [],
		current: null,
		running: false,
		stopRequested: false,
		builds: 0,
		landed: 0,
		exitCode: 0,
		line: "idle",
		stoppedSlug: null,
		stoppedClass: null,
	};
}

function sortedPending(queue: readonly QueueIntent[]): readonly QueueIntent[] {
	return [...queue].sort(compareQueueIntent);
}

function finishDrain(
	state: QueueDrainState,
	line: "nothing_to_build" | "done" | "stopped_on_request" | "stopped_because",
	exitCode: number,
	stoppedSlug: string | null = null,
	stoppedClass: QueueDrainState["stoppedClass"] = null,
): QueueDrainState {
	return {
		...state,
		current: null,
		running: false,
		stopRequested: false,
		exitCode,
		line,
		stoppedSlug,
		stoppedClass,
	};
}

function nextBuild(state: QueueDrainState): QueueDrainState {
	if (state.stopRequested) return finishDrain(state, "stopped_on_request", 0);
	const attempted = new Set(state.attempted);
	const next = state.pending.find((intent) => !attempted.has(intent.slug));
	if (next === undefined) {
		if (state.builds === 0) return finishDrain(state, "nothing_to_build", 0);
		return finishDrain(state, "done", state.landed === state.builds ? 0 : 1);
	}
	return {
		...state,
		attempted: [...state.attempted, next.slug],
		current: next,
		running: true,
		line: "building",
		stoppedSlug: null,
		stoppedClass: null,
	};
}

/** Apply one deterministic queue/drain event. Effects and ownership live elsewhere. */
export function transitionQueue(
	state: QueueDrainState,
	event: QueueDrainEvent,
): QueueDrainState {
	switch (event.type) {
		case "start": {
			if (state.running)
				return { ...state, line: "already_running", exitCode: 0 };
			return nextBuild({
				...state,
				attempted: [],
				current: null,
				running: true,
				stopRequested: false,
				builds: 0,
				landed: 0,
				exitCode: 0,
				line: "idle",
				stoppedSlug: null,
				stoppedClass: null,
			});
		}
		case "stop":
			if (!state.running) return { ...state, line: "not_running", exitCode: 0 };
			return { ...state, stopRequested: true, line: "stopping" };
		case "refresh": {
			const attempted = new Set(state.attempted);
			const currentSlug = state.current?.slug;
			const selected = selectQueue(event.queue, event.landedSlugs).queued;
			const refreshed = selected.filter(
				(intent) => !attempted.has(intent.slug) || intent.slug === currentSlug,
			);
			if (
				state.current !== null &&
				!refreshed.some((intent) => intent.slug === state.current?.slug)
			)
				refreshed.push(state.current);
			return { ...state, pending: sortedPending(refreshed) };
		}
		case "outcome": {
			if (!state.running || state.current === null) return state;
			const outcome = event.outcome;
			if (
				outcome === "stopped_environment" ||
				outcome === "stopped_provider" ||
				outcome === "stopped_controller"
			) {
				const stoppedClass =
					outcome === "stopped_environment"
						? "environment"
						: outcome === "stopped_provider"
							? "provider"
							: "controller";
				const exitCode =
					stoppedClass === "environment"
						? 3
						: stoppedClass === "provider"
							? 4
							: 70;
				return finishDrain(
					{ ...state, builds: state.builds + 1 },
					"stopped_because",
					exitCode,
					state.current.slug,
					stoppedClass,
				);
			}
			const pending = state.pending.filter(
				(intent) => intent.slug !== state.current?.slug,
			);
			const skipped = outcome === "skipped";
			const completed: QueueDrainState = {
				...state,
				pending,
				current: null,
				builds: state.builds + (skipped ? 0 : 1),
				landed: state.landed + (outcome === "landed" ? 1 : 0),
				line: state.stopRequested ? "stopped_on_request" : state.line,
			};
			if (state.stopRequested)
				return finishDrain(completed, "stopped_on_request", 0);
			return nextBuild(completed);
		}
	}
}
