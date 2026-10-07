import { createHash } from "node:crypto";

export type CanonicalJsonValue =
	| null
	| boolean
	| number
	| string
	| readonly CanonicalJsonValue[]
	| { readonly [key: string]: CanonicalJsonValue };

export type CanonicalToolSchema = Readonly<{
	type: "function";
	name: string;
	readonly [key: string]: CanonicalJsonValue;
}>;

export interface StaticPrefixVersion {
	readonly provider: "chatgpt" | "grok";
	readonly model: string;
	readonly adapterVersion: string;
	readonly promptVersion: string;
	readonly toolSchemaVersion: string;
	readonly securityNamespace?: string;
}

export interface StaticPrefixInput {
	readonly version: StaticPrefixVersion;
	readonly genericInstructions: string;
	readonly toolSchemas: readonly CanonicalToolSchema[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function compareUtf8(left: string, right: string): number {
	const a = encoder.encode(left);
	const b = encoder.encode(right);
	const length = Math.min(a.byteLength, b.byteLength);
	for (let index = 0; index < length; index += 1) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return a.byteLength - b.byteLength;
}

function validUnicode(value: string): boolean {
	try {
		return decoder.decode(encoder.encode(value)) === value;
	} catch {
		return false;
	}
}

function canonicalString(value: unknown, seen: Set<object>): string {
	if (value === null || typeof value === "boolean")
		return JSON.stringify(value);
	if (typeof value === "string") {
		if (!validUnicode(value))
			throw new TypeError("Canonical JSON strings must be valid Unicode.");
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (
			!Number.isFinite(value) ||
			(Number.isInteger(value) && !Number.isSafeInteger(value))
		)
			throw new TypeError("Canonical JSON numbers must be finite and safe.");
		return JSON.stringify(value);
	}
	if (typeof value !== "object")
		throw new TypeError("Value is not canonical JSON data.");
	if (seen.has(value))
		throw new TypeError("Canonical JSON cannot contain cycles.");
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			const keys = Object.keys(value);
			if (
				Object.getOwnPropertySymbols(value).length > 0 ||
				keys.length !== value.length ||
				keys.some((key, index) => key !== String(index))
			)
				throw new TypeError(
					"Canonical JSON arrays cannot be sparse or decorated.",
				);
			const entries: string[] = [];
			for (let index = 0; index < value.length; index += 1) {
				const descriptor = Object.getOwnPropertyDescriptor(
					value,
					String(index),
				);
				if (!descriptor || !("value" in descriptor))
					throw new TypeError(
						"Canonical JSON arrays cannot contain accessors.",
					);
				entries.push(canonicalString(descriptor.value, seen));
			}
			return `[${entries.join(",")}]`;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null)
			throw new TypeError("Canonical JSON objects must be plain records.");
		const record = value as Readonly<Record<string, unknown>>;
		const keys = Object.keys(record).sort(compareUtf8);
		for (const key of keys) {
			if (!validUnicode(key))
				throw new TypeError("Canonical JSON keys must be valid Unicode.");
			const descriptor = Object.getOwnPropertyDescriptor(record, key);
			if (
				!descriptor ||
				!("value" in descriptor) ||
				descriptor.value === undefined
			)
				throw new TypeError(
					"Canonical JSON cannot contain accessors or undefined.",
				);
		}
		if (Object.getOwnPropertySymbols(record).length > 0)
			throw new TypeError("Canonical JSON cannot contain symbol keys.");
		return `{${keys
			.map((key) => {
				const descriptor = Object.getOwnPropertyDescriptor(record, key);
				if (!descriptor || !("value" in descriptor))
					throw new TypeError("Canonical JSON cannot contain accessors.");
				return `${JSON.stringify(key)}:${canonicalString(descriptor.value, seen)}`;
			})
			.join(",")}}`;
	} finally {
		seen.delete(value);
	}
}

export function canonicalJson(value: unknown): string {
	return canonicalString(value, new Set());
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
	return encoder.encode(canonicalJson(value));
}

function validateToolSchemas(
	value: readonly CanonicalToolSchema[],
): readonly CanonicalToolSchema[] {
	if (!Array.isArray(value))
		throw new TypeError("Tool schemas must be an array.");
	const names = new Set<string>();
	const copied: CanonicalToolSchema[] = [];
	for (const candidate of value) {
		if (
			candidate === null ||
			typeof candidate !== "object" ||
			Array.isArray(candidate) ||
			candidate.type !== "function" ||
			typeof candidate.name !== "string" ||
			!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(candidate.name) ||
			candidate.parameters === null ||
			typeof candidate.parameters !== "object" ||
			Array.isArray(candidate.parameters)
		)
			throw new TypeError("Tool schema is invalid.");
		if (names.has(candidate.name))
			throw new TypeError(`Duplicate tool schema ${candidate.name}.`);
		names.add(candidate.name);
		const bytes = canonicalJsonBytes(candidate);
		const parsed: unknown = JSON.parse(decoder.decode(bytes));
		copied.push(deepFreeze(parsed) as CanonicalToolSchema);
	}
	return Object.freeze(copied);
}

function deepFreeze(value: unknown): unknown {
	if (value === null || typeof value !== "object" || Object.isFrozen(value))
		return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

function validateVersion(version: StaticPrefixVersion): void {
	if (version.provider !== "chatgpt" && version.provider !== "grok")
		throw new TypeError("Static prefix provider is invalid.");
	for (const [label, value] of Object.entries({
		model: version.model,
		adapterVersion: version.adapterVersion,
		promptVersion: version.promptVersion,
		toolSchemaVersion: version.toolSchemaVersion,
		securityNamespace: version.securityNamespace ?? "default",
	}))
		if (
			typeof value !== "string" ||
			value.length === 0 ||
			value.length > 256 ||
			value.includes("\0") ||
			/[\r\n]/.test(value)
		)
			throw new TypeError(`Static prefix ${label} is invalid.`);
}

function versionKey(version: StaticPrefixVersion): string {
	validateVersion(version);
	return [
		version.provider,
		version.model,
		version.adapterVersion,
		version.promptVersion,
		version.toolSchemaVersion,
		version.securityNamespace ?? "default",
	].join("\0");
}

/** A caller can retain this registry or serialize its entries as frozen metadata. */
export class StaticPrefixRegistry {
	private readonly registered = new Map<string, string>();

	static fromEntries(
		entries: readonly Readonly<{ versionKey: string; sha256: string }>[],
	): StaticPrefixRegistry {
		const registry = new StaticPrefixRegistry();
		for (const entry of entries) {
			if (
				typeof entry.versionKey !== "string" ||
				entry.versionKey.split("\0").length !== 6 ||
				!/^[a-f0-9]{64}$/.test(entry.sha256)
			)
				throw new TypeError(
					"Persisted static prefix registry entry is invalid.",
				);
			const previous = registry.registered.get(entry.versionKey);
			if (previous !== undefined && previous !== entry.sha256)
				throw new TypeError("Persisted static prefix registry has a conflict.");
			registry.registered.set(entry.versionKey, entry.sha256);
		}
		return registry;
	}

	register(version: StaticPrefixVersion, bytes: Uint8Array): void {
		const key = versionKey(version);
		const digest = createHash("sha256").update(bytes).digest("hex");
		const previous = this.registered.get(key);
		if (previous !== undefined && previous !== digest)
			throw new TypeError(
				"Static prefix bytes changed without a version change.",
			);
		this.registered.set(key, digest);
	}

	serialize(): readonly Readonly<{ versionKey: string; sha256: string }>[] {
		return this.entries();
	}

	entries(): readonly Readonly<{ versionKey: string; sha256: string }>[] {
		return Object.freeze(
			[...this.registered.entries()]
				.sort(([left], [right]) => compareUtf8(left, right))
				.map(([registeredVersion, sha256]) =>
					Object.freeze({ versionKey: registeredVersion, sha256 }),
				),
		);
	}
}

export const DEFAULT_STATIC_PREFIX_REGISTRY = new StaticPrefixRegistry();

export class StaticPrefix {
	private readonly schemaJsonValue: string;
	private readonly schemaBytesValue: Uint8Array;
	private readonly bytesValue: Uint8Array;
	private readonly digestValue: string;
	readonly toolNames: readonly string[];

	constructor(
		input: StaticPrefixInput,
		registry = DEFAULT_STATIC_PREFIX_REGISTRY,
	) {
		validateVersion(input.version);
		if (
			typeof input.genericInstructions !== "string" ||
			input.genericInstructions.length === 0 ||
			!validUnicode(input.genericInstructions)
		)
			throw new TypeError("Generic instructions must be nonempty valid UTF-8.");
		const schemas = validateToolSchemas(input.toolSchemas);
		this.schemaJsonValue = canonicalJson(schemas);
		this.schemaBytesValue = encoder.encode(this.schemaJsonValue);
		const instructionsJson = canonicalJson(input.genericInstructions);
		this.bytesValue = encoder.encode(
			`{"instructions":${instructionsJson},"tools":${this.schemaJsonValue}}`,
		);
		this.digestValue = createHash("sha256")
			.update(this.bytesValue)
			.digest("hex");
		this.toolNames = Object.freeze(schemas.map((schema) => schema.name));
		this.genericInstructions = input.genericInstructions;
		this.version = Object.freeze({ ...input.version });
		registry.register(input.version, this.bytesValue);
	}

	readonly genericInstructions: string;
	readonly version: StaticPrefixVersion;

	get toolSchemas(): readonly CanonicalToolSchema[] {
		const parsed: unknown = JSON.parse(this.schemaJsonValue);
		return deepFreeze(parsed) as readonly CanonicalToolSchema[];
	}

	get toolSchemasJson(): string {
		return this.schemaJsonValue;
	}

	get toolSchemasBytes(): Uint8Array {
		return this.schemaBytesValue.slice();
	}

	get bytes(): Uint8Array {
		return this.bytesValue.slice();
	}

	get sha256(): string {
		return this.digestValue;
	}
}
