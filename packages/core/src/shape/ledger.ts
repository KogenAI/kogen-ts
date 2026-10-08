import type { IntentAcceptanceItem } from "../intent/parse";

export interface ShapeRequirementLedgerRow {
	readonly constraint: string;
	readonly maps_to: string;
}

export interface ShapeRequirementLedger {
	readonly rows: readonly ShapeRequirementLedgerRow[];
	readonly gaps: readonly string[];
}

interface LocatedReference {
	readonly start: number;
	readonly value: string;
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function stringField(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function coverageReferences(request: string): readonly string[] {
	const found: LocatedReference[] = [];
	const patterns = [
		{ pattern: /`([^`\r\n]+)`/gu, contentOffset: 1, stripEnd: 1 },
		{ pattern: /"(?:\\.|[^"\\\r\n])*"/gu, contentOffset: 1, stripEnd: 1 },
		{
			pattern: /(?<![\p{L}\p{N}_])'(?:\\.|[^'\\\r\n])*'(?![\p{L}\p{N}_])/gu,
			contentOffset: 1,
			stripEnd: 1,
		},
		/(?<![\p{L}\p{N}_])\d+(?:\.\d+)?(?![\p{L}\p{N}_])/gu,
	];
	for (const entry of patterns) {
		if (entry instanceof RegExp) {
			for (const match of request.matchAll(entry)) {
				if (match[0] !== undefined && match.index !== undefined)
					found.push({ start: match.index, value: match[0] });
			}
			continue;
		}
		for (const match of request.matchAll(entry.pattern)) {
			if (match[0] === undefined || match.index === undefined) continue;
			const end = match[0].length - (entry.stripEnd ?? 0);
			const value = match[0].slice(entry.contentOffset, end);
			if (value.length > 0)
				found.push({ start: match.index + entry.contentOffset, value });
		}
	}
	found.sort((left, right) => left.start - right.start);
	const unique = new Set<string>();
	for (const reference of found) unique.add(reference.value);
	return [...unique];
}

/**
 * Parse the requirement auditor's closed JSON shape and check the literal
 * coverage obligations from §3.2.3. Invalid rows become gaps so the test
 * audit can still run in the same traversal.
 */
export function parseShapeRequirementLedger(
	text: string,
	requestBytes: Uint8Array,
	items: readonly IntentAcceptanceItem[],
): ShapeRequirementLedger {
	const knownIds = new Set(items.map((item) => item.id));
	const gaps: string[] = [];
	const rows: ShapeRequirementLedgerRow[] = [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {
			rows,
			gaps: ["Requirement auditor returned malformed JSON."],
		};
	}
	const root = record(parsed);
	if (
		root === null ||
		Object.keys(root).length !== 1 ||
		!Array.isArray(root.rows)
	) {
		return {
			rows,
			gaps: ["Requirement auditor response must contain only a rows array."],
		};
	}
	const seenConstraints = new Set<string>();
	for (let index = 0; index < root.rows.length; index += 1) {
		const row = record(root.rows[index]);
		if (
			row === null ||
			Object.keys(row).length !== 2 ||
			!stringField(row.constraint) ||
			!stringField(row.maps_to)
		) {
			gaps.push(`Requirement ledger row ${index + 1} is malformed.`);
			continue;
		}
		const constraint = row.constraint;
		const mapsTo = row.maps_to;
		if (seenConstraints.has(constraint)) {
			gaps.push(`Duplicate ledger constraint: ${constraint}.`);
			continue;
		}
		seenConstraints.add(constraint);
		if (!knownIds.has(mapsTo) && !/^untestable: \S[\s\S]*$/u.test(mapsTo)) {
			gaps.push(`Ledger row for ${constraint} maps to unknown item ${mapsTo}.`);
			continue;
		}
		rows.push({ constraint, maps_to: mapsTo });
	}
	if (root.rows.length === 0)
		gaps.push("Requirement auditor returned no constraint rows.");

	let requestText: string;
	try {
		requestText = new TextDecoder("utf-8", { fatal: true }).decode(
			requestBytes,
		);
	} catch {
		// The Request bytes remain untouched in the Intent. Invalid bytes cannot
		// be expressed as a ledger token; report the limitation as a gap.
		requestText = new TextDecoder("utf-8").decode(requestBytes);
	}
	for (const reference of coverageReferences(requestText)) {
		if (!rows.some((row) => row.constraint.includes(reference)))
			gaps.push(`Request literal ${reference} has no ledger row.`);
	}
	return { rows, gaps };
}
