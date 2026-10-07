import { isAbsolute, join, resolve } from "node:path";
import type { PortError, Result } from "../../contracts/errors";
import type { FileSystemPort } from "../../contracts/ports";
import type { YamlBlockNode, YamlMapNode } from "../../yaml/block";
import { parseYaml } from "../../yaml/parse";

export const ACCOUNT_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const ACCOUNTS_FILE_MAX_BYTES = 1024 * 1024;

export type AccountProvider = "chatgpt" | "grok";

export interface ProviderAccountProject {
	readonly path: string;
	readonly account: string;
}

export interface ProviderAccountMap {
	readonly default?: string;
	readonly projects?: readonly ProviderAccountProject[];
}

export interface ProviderSelectionProject {
	readonly path: string;
	readonly provider: AccountProvider;
}

export interface ProviderSelectionMap {
	readonly default?: AccountProvider;
	readonly projects?: readonly ProviderSelectionProject[];
}

export interface AccountsDocument {
	readonly chatgpt?: ProviderAccountMap;
	readonly grok?: ProviderAccountMap;
	readonly selection?: ProviderSelectionMap;
}

export interface AccountsFormatError {
	readonly message: string;
	readonly line?: number;
}

export type AccountsParseResult =
	| { readonly ok: true; readonly value: AccountsDocument }
	| { readonly ok: false; readonly error: AccountsFormatError };

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function isMap(node: YamlBlockNode | null | undefined): node is YamlMapNode {
	return node?.kind === "map";
}

function scalar(node: YamlBlockNode | undefined): string | undefined {
	return node?.kind === "scalar" ? node.value : undefined;
}

function isValidText(value: string): boolean {
	try {
		return decoder.decode(encoder.encode(value)) === value;
	} catch {
		return false;
	}
}

function hasYamlControlCharacter(value: string): boolean {
	for (const character of value) {
		const point = character.codePointAt(0);
		if (point !== undefined && (point <= 0x1f || point === 0x7f)) return true;
	}
	return false;
}

export function isAccountLabel(value: string): boolean {
	return ACCOUNT_LABEL_PATTERN.test(value);
}

function isCanonicalCheckoutPath(value: string): boolean {
	return (
		isAbsolute(value) &&
		value.length > 0 &&
		!hasYamlControlCharacter(value) &&
		isValidText(value)
	);
}

function invalid(message: string, line?: number): AccountsParseResult {
	return {
		ok: false,
		error: { message, ...(line === undefined ? {} : { line }) },
	};
}

function isFormatError(value: unknown): value is AccountsFormatError {
	return (
		value !== null &&
		typeof value === "object" &&
		"message" in value &&
		typeof value.message === "string"
	);
}

function checkKeys(
	map: YamlMapNode,
	allowed: readonly string[],
	path: string,
): AccountsFormatError | null {
	const keys = new Set(allowed);
	for (const key of map.entries.keys()) {
		if (!keys.has(key))
			return { message: `${path} has unknown key ${JSON.stringify(key)}` };
	}
	return null;
}

function parseProjectRows<Value extends object>(
	node: YamlBlockNode | undefined,
	path: string,
	parseRow: (row: YamlMapNode, index: number) => Value | AccountsFormatError,
): readonly Value[] | AccountsFormatError {
	if (node === undefined) return [];
	if (node.kind !== "sequence") return { message: `${path} must be a list` };
	const rows: Value[] = [];
	const seenPaths = new Set<string>();
	for (const [index, item] of node.items.entries()) {
		if (!isMap(item)) return { message: `${path}[${index + 1}] must be a map` };
		const row = parseRow(item, index + 1);
		if (isFormatError(row)) return row;
		const rowPath = (row as { readonly path: string }).path;
		if (seenPaths.has(rowPath))
			return {
				message: `${path} has duplicate project path ${JSON.stringify(rowPath)}`,
			};
		seenPaths.add(rowPath);
		rows.push(row);
	}
	return rows;
}

function parseAccountProjects(
	node: YamlBlockNode | undefined,
	provider: AccountProvider,
): readonly ProviderAccountProject[] | AccountsFormatError {
	return parseProjectRows(node, `${provider}.projects`, (row, index) => {
		const keyError = checkKeys(
			row,
			["path", "account"],
			`${provider}.projects[${index}]`,
		);
		if (keyError) return keyError;
		const path = scalar(row.entries.get("path"));
		if (path === undefined || !isCanonicalCheckoutPath(path))
			return {
				message: `${provider}.projects[${index}].path must be an absolute checkout path`,
			};
		const account = scalar(row.entries.get("account"));
		if (account === undefined || !isAccountLabel(account))
			return {
				message: `${provider}.projects[${index}].account must be a valid account label`,
			};
		return { path, account };
	});
}

function parseProviderMap(
	node: YamlBlockNode | undefined,
	provider: AccountProvider,
): ProviderAccountMap | AccountsFormatError {
	if (!isMap(node)) return { message: `${provider} must be a map` };
	const keyError = checkKeys(node, ["default", "projects"], provider);
	if (keyError) return keyError;
	const defaultLabel = scalar(node.entries.get("default"));
	if (
		node.entries.has("default") &&
		(defaultLabel === undefined || !isAccountLabel(defaultLabel))
	)
		return { message: `${provider}.default must be a valid account label` };
	const projects = parseAccountProjects(node.entries.get("projects"), provider);
	if (isFormatError(projects)) return projects;
	return {
		...(defaultLabel === undefined ? {} : { default: defaultLabel }),
		...(node.entries.has("projects") ? { projects } : {}),
	};
}

function parseSelection(
	node: YamlBlockNode | undefined,
): ProviderSelectionMap | AccountsFormatError {
	if (!isMap(node)) return { message: "selection must be a map" };
	const keyError = checkKeys(node, ["default", "projects"], "selection");
	if (keyError) return keyError;
	const defaultProvider = scalar(node.entries.get("default"));
	if (
		node.entries.has("default") &&
		defaultProvider !== "chatgpt" &&
		defaultProvider !== "grok"
	)
		return { message: "selection.default must be chatgpt or grok" };
	const projects = parseProjectRows<ProviderSelectionProject>(
		node.entries.get("projects"),
		"selection.projects",
		(row, index) => {
			const rowError = checkKeys(
				row,
				["path", "provider"],
				`selection.projects[${index}]`,
			);
			if (rowError) return rowError;
			const path = scalar(row.entries.get("path"));
			if (path === undefined || !isCanonicalCheckoutPath(path))
				return {
					message: `selection.projects[${index}].path must be an absolute checkout path`,
				};
			const providerValue = scalar(row.entries.get("provider"));
			if (providerValue !== "chatgpt" && providerValue !== "grok")
				return {
					message: `selection.projects[${index}].provider must be chatgpt or grok`,
				};
			const provider: AccountProvider = providerValue;
			return { path, provider };
		},
	);
	if (isFormatError(projects)) return projects;
	const selectedProvider: AccountProvider | undefined =
		defaultProvider === "chatgpt" || defaultProvider === "grok"
			? defaultProvider
			: undefined;
	return {
		...(selectedProvider === undefined ? {} : { default: selectedProvider }),
		...(node.entries.has("projects") ? { projects } : {}),
	};
}

export function parseAccountsYaml(input: Uint8Array): AccountsParseResult {
	const parsed = parseYaml(input);
	if (parsed.issue !== null)
		return invalid(parsed.issue.message, parsed.issue.line);
	if (!isMap(parsed.node))
		return invalid("accounts file must be a YAML map", 1);
	const rootError = checkKeys(
		parsed.node,
		["chatgpt", "grok", "selection"],
		"accounts",
	);
	if (rootError) return { ok: false, error: rootError };
	const chatgpt = parsed.node.entries.has("chatgpt")
		? parseProviderMap(parsed.node.entries.get("chatgpt"), "chatgpt")
		: undefined;
	if (chatgpt !== undefined && "message" in chatgpt)
		return { ok: false, error: chatgpt };
	const grok = parsed.node.entries.has("grok")
		? parseProviderMap(parsed.node.entries.get("grok"), "grok")
		: undefined;
	if (grok !== undefined && "message" in grok)
		return { ok: false, error: grok };
	const selection = parsed.node.entries.has("selection")
		? parseSelection(parsed.node.entries.get("selection"))
		: undefined;
	if (selection !== undefined && "message" in selection)
		return { ok: false, error: selection };
	return {
		ok: true,
		value: {
			...(chatgpt === undefined ? {} : { chatgpt }),
			...(grok === undefined ? {} : { grok }),
			...(selection === undefined ? {} : { selection }),
		},
	};
}

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

function validateDocument(document: AccountsDocument): void {
	for (const provider of ["chatgpt", "grok"] as const) {
		const settings = document[provider];
		if (settings === undefined) continue;
		if (settings.default !== undefined && !isAccountLabel(settings.default))
			throw new TypeError(`${provider}.default must be a valid account label`);
		const seen = new Set<string>();
		for (const row of settings.projects ?? []) {
			if (!isCanonicalCheckoutPath(row.path) || !isAccountLabel(row.account))
				throw new TypeError(`${provider}.projects contains an invalid row`);
			if (seen.has(row.path))
				throw new TypeError(`${provider}.projects contains a duplicate path`);
			seen.add(row.path);
		}
	}
	const selection = document.selection;
	if (selection?.default !== undefined && !isAccountProvider(selection.default))
		throw new TypeError("selection.default must be chatgpt or grok");
	const seen = new Set<string>();
	for (const row of selection?.projects ?? []) {
		if (!isCanonicalCheckoutPath(row.path) || !isAccountProvider(row.provider))
			throw new TypeError("selection.projects contains an invalid row");
		if (seen.has(row.path))
			throw new TypeError("selection.projects contains a duplicate path");
		seen.add(row.path);
	}
}

function isAccountProvider(value: string): value is AccountProvider {
	return value === "chatgpt" || value === "grok";
}

function yamlPath(value: string): string {
	if (!isCanonicalCheckoutPath(value))
		throw new TypeError("Project paths must be absolute valid Unicode paths.");
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function writeProvider(
	lines: string[],
	provider: AccountProvider,
	settings: ProviderAccountMap | undefined,
	allowedPaths?: ReadonlySet<string>,
): void {
	if (settings === undefined) return;
	const projects = (settings.projects ?? [])
		.filter((row) => allowedPaths === undefined || allowedPaths.has(row.path))
		.slice()
		.sort((left, right) => compareUtf8(left.path, right.path));
	if (settings.default === undefined && projects.length === 0) {
		lines.push(`${provider}: {}`);
		return;
	}
	lines.push(`${provider}:`);
	if (settings.default !== undefined)
		lines.push(`  default: ${settings.default}`);
	if (projects.length > 0) {
		lines.push("  projects:");
		for (const project of projects) {
			lines.push(`    - path: ${yamlPath(project.path)}`);
			lines.push(`      account: ${project.account}`);
		}
	}
}

export function serializeAccountsYaml(
	document: AccountsDocument,
	allowedProjectPaths?: ReadonlySet<string>,
): Uint8Array {
	validateDocument(document);
	const lines = [
		"# Kogen accounts on this machine, written by kogen provider use.",
	];
	writeProvider(lines, "chatgpt", document.chatgpt, allowedProjectPaths);
	writeProvider(lines, "grok", document.grok, allowedProjectPaths);
	const selection = document.selection;
	if (selection !== undefined) {
		const projects = (selection.projects ?? [])
			.filter(
				(row) =>
					allowedProjectPaths === undefined ||
					allowedProjectPaths.has(row.path),
			)
			.slice()
			.sort((left, right) => compareUtf8(left.path, right.path));
		if (selection.default === undefined && projects.length === 0) {
			lines.push("selection: {}");
		} else {
			lines.push("selection:");
			if (selection.default !== undefined)
				lines.push(`  default: ${selection.default}`);
			if (projects.length > 0) {
				lines.push("  projects:");
				for (const project of projects) {
					lines.push(`    - path: ${yamlPath(project.path)}`);
					lines.push(`      provider: ${project.provider}`);
				}
			}
		}
	}
	if (lines.length === 1) lines.push("chatgpt: {}");
	return encoder.encode(`${lines.join("\n")}\n`);
}

function portError(error: PortError): PortError {
	return {
		code: error.code,
		message: error.message,
		retryable: error.retryable,
		...(error.cause === undefined ? {} : { cause: error.cause }),
	};
}

function kogenDirectory(homeDirectory: string): string {
	if (!isAbsolute(homeDirectory) || homeDirectory.includes("\0"))
		throw new TypeError("HOME must be an absolute path.");
	return join(resolve(homeDirectory), ".kogen");
}

export async function readAccountsFile(
	filesystem: Pick<FileSystemPort, "readFile">,
	homeDirectory: string,
): Promise<Result<AccountsDocument | null>> {
	let root: string;
	try {
		root = kogenDirectory(homeDirectory);
	} catch (cause) {
		return {
			ok: false,
			error: {
				code: "invalid_input",
				message: cause instanceof Error ? cause.message : "HOME is invalid.",
				retryable: false,
			},
		};
	}
	const file = await filesystem.readFile({
		root,
		path: "accounts.yaml",
		maxBytes: ACCOUNTS_FILE_MAX_BYTES,
	});
	if (!file.ok) {
		if (file.error.code === "not_found") return { ok: true, value: null };
		return { ok: false, error: portError(file.error) };
	}
	const parsed = parseAccountsYaml(file.value);
	if (!parsed.ok)
		return {
			ok: false,
			error: {
				code: "invalid_input",
				message: parsed.error.message,
				retryable: false,
			},
		};
	return { ok: true, value: parsed.value };
}

export async function writeAccountsFile(
	filesystem: Pick<FileSystemPort, "writeFileAtomically">,
	homeDirectory: string,
	document: AccountsDocument,
	isDirectory: (path: string) => Promise<boolean>,
): Promise<Result<void>> {
	let root: string;
	try {
		root = kogenDirectory(homeDirectory);
		validateDocument(document);
	} catch (cause) {
		return {
			ok: false,
			error: {
				code: "invalid_input",
				message:
					cause instanceof Error ? cause.message : "Accounts file is invalid.",
				retryable: false,
			},
		};
	}
	const allPaths = new Set<string>();
	for (const provider of ["chatgpt", "grok"] as const)
		for (const row of document[provider]?.projects ?? [])
			allPaths.add(row.path);
	for (const row of document.selection?.projects ?? []) allPaths.add(row.path);
	const existing = new Set<string>();
	try {
		for (const path of allPaths)
			if (await isDirectory(path)) existing.add(path);
	} catch (cause) {
		return {
			ok: false,
			error: {
				code: "io",
				message:
					cause instanceof Error
						? cause.message
						: "Could not check project directories.",
				retryable: true,
			},
		};
	}
	let bytes: Uint8Array;
	try {
		bytes = serializeAccountsYaml(document, existing);
	} catch (cause) {
		return {
			ok: false,
			error: {
				code: "invalid_input",
				message:
					cause instanceof Error ? cause.message : "Accounts file is invalid.",
				retryable: false,
			},
		};
	}
	return filesystem.writeFileAtomically({
		root,
		path: "accounts.yaml",
		bytes,
		mode: 0o600,
	});
}

export function withProviderAccount(
	document: AccountsDocument,
	provider: AccountProvider,
	label: string,
	projectPath?: string,
): AccountsDocument {
	if (!isAccountLabel(label)) throw new TypeError("Account label is invalid.");
	if (projectPath !== undefined && !isCanonicalCheckoutPath(projectPath))
		throw new TypeError("Project path must be an absolute checkout path.");
	if (projectPath === undefined) {
		return {
			...document,
			[provider]: { ...(document[provider] ?? {}), default: label },
			selection: { ...(document.selection ?? {}), default: provider },
		};
	}
	const providerProjects = (document[provider]?.projects ?? []).filter(
		(row) => row.path !== projectPath,
	);
	const selectionProjects = (document.selection?.projects ?? []).filter(
		(row) => row.path !== projectPath,
	);
	return {
		...document,
		[provider]: {
			...(document[provider] ?? {}),
			projects: [...providerProjects, { path: projectPath, account: label }],
		},
		selection: {
			...(document.selection ?? {}),
			projects: [...selectionProjects, { path: projectPath, provider }],
		},
	};
}
