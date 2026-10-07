import { accessSync, constants, statSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import type { PortError, Result } from "../contracts/errors";
import type {
	ProcessPort,
	ProcessRequest,
	ProcessResult,
} from "../contracts/ports";
import { HOST_MAX_PAYLOAD_BYTES } from "./host";

export const MISE_ENV_TIMEOUT_MS = 30_000;
export const MISE_ENV_OUTPUT_LIMIT_BYTES = HOST_MAX_PAYLOAD_BYTES - 64;

const BASE_ENVIRONMENT_NAMES = new Set([
	"PATH",
	"HOME",
	"LANG",
	"LC_ALL",
	"TERM",
	"USER",
	"SHELL",
]);
const PROXY_ENVIRONMENT_NAME = /^(?:http|https|all|no|ftp|socks)_proxy$/i;
const MAX_ENVIRONMENT_BYTES = HOST_MAX_PAYLOAD_BYTES - 64;
const encoder = new TextEncoder();

export type HostEnvironment = Readonly<Record<string, string | undefined>>;
export type ChildEnvironment = Readonly<Record<string, string>>;

export interface AllowlistedEnvironmentOptions {
	readonly adapter?: string;
	readonly runtimePaths?: readonly string[];
}

export interface ChildEnvironmentOptions extends AllowlistedEnvironmentOptions {
	readonly projectRoot: string;
	readonly workspace: string;
	readonly runDirectory: string;
	readonly projectEnvironment?: Readonly<Record<string, string>>;
	readonly hostEnvironment?: HostEnvironment;
	readonly process: Pick<ProcessPort, "run">;
	/** Explicit path/null makes mise lookup deterministic for tests and embeddings. */
	readonly miseBinaryPath?: string | null;
}

export interface ChildEnvironmentResult {
	readonly environment: ChildEnvironment;
	readonly miseBinaryPath: string | null;
}

export class ChildEnvironmentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ChildEnvironmentError";
	}
}

function isAllowedBaseName(name: string, adapter: string | undefined): boolean {
	if (BASE_ENVIRONMENT_NAMES.has(name) || PROXY_ENVIRONMENT_NAME.test(name))
		return true;
	if (name.startsWith("GIT_") || name.startsWith("MISE_")) return true;
	return adapter === "exunit" && (name === "MIX_HOME" || name === "HEX_HOME");
}

function pathEntries(pathValue: string): string[] {
	return pathValue.split(delimiter);
}

function normalizedPathEntry(entry: string): string {
	return resolve(entry.length === 0 ? "." : entry);
}

function filterRuntimePaths(
	pathValue: string | undefined,
	runtimePaths: readonly string[],
): string | undefined {
	if (pathValue === undefined || runtimePaths.length === 0) return pathValue;
	const excluded = new Set(runtimePaths.map((path) => resolve(path)));
	return pathEntries(pathValue)
		.filter(
			(entry) =>
				entry.length === 0 || !excluded.has(normalizedPathEntry(entry)),
		)
		.join(delimiter);
}

function defaultRuntimePaths(hostEnvironment: HostEnvironment): string[] {
	const paths: string[] = [];
	if (basename(process.execPath).toLowerCase() === "bun")
		paths.push(dirname(process.execPath));
	if (hostEnvironment.BUN_INSTALL)
		paths.push(join(hostEnvironment.BUN_INSTALL, "bin"));
	return [...new Set(paths)];
}

export function createAllowlistedBaseEnvironment(
	hostEnvironment: HostEnvironment = process.env,
	options: AllowlistedEnvironmentOptions = {},
): Record<string, string> {
	const environment: Record<string, string> = Object.create(null);
	for (const [name, value] of Object.entries(hostEnvironment)) {
		if (value !== undefined && isAllowedBaseName(name, options.adapter))
			environment[name] = value;
	}
	const runtimePaths =
		options.runtimePaths ?? defaultRuntimePaths(hostEnvironment);
	const pathValue = filterRuntimePaths(environment.PATH, runtimePaths);
	if (pathValue === undefined) delete environment.PATH;
	else environment.PATH = pathValue;
	return environment;
}

function findExecutable(
	name: string,
	pathValue: string | undefined,
): string | null {
	if (pathValue === undefined) return null;
	for (const entry of pathEntries(pathValue)) {
		const candidate = resolve(entry.length === 0 ? "." : entry, name);
		try {
			accessSync(candidate, constants.X_OK);
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			// Continue through the host PATH; absence of mise is supported.
		}
	}
	return null;
}

function appendTrustedPaths(
	baseValue: string | undefined,
	projectRoot: string,
	workspace: string,
): string {
	const paths = [
		...(baseValue === undefined ? [] : pathEntries(baseValue)),
		projectRoot,
		workspace,
	];
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const entry of paths) {
		if (entry.length === 0) continue;
		const normalized = resolve(entry);
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		unique.push(entry);
	}
	return unique.join(delimiter);
}

function prependPath(directory: string, pathValue: string | undefined): string {
	const prefix = resolve(directory);
	const remaining = (
		pathValue === undefined ? [] : pathEntries(pathValue)
	).filter((entry) => entry.length === 0 || resolve(entry) !== prefix);
	return [directory, ...remaining].join(delimiter);
}

function ensureEnvironmentFits(
	environment: Readonly<Record<string, string>>,
): void {
	let bytes = 0;
	for (const [name, value] of Object.entries(environment)) {
		if (!validateEnvironmentEntry(name, value))
			throw new ChildEnvironmentError(
				"child environment contains an invalid entry",
			);
		bytes += 4 + encoder.encode(`${name}=${value}`).byteLength;
		if (bytes > MAX_ENVIRONMENT_BYTES)
			throw new ChildEnvironmentError(
				"child environment exceeds its byte limit",
			);
	}
}

function validateEnvironmentEntry(
	name: string,
	value: unknown,
): value is string {
	if (
		name.length > 0 &&
		!name.includes("=") &&
		!name.includes("\0") &&
		typeof value === "string" &&
		!value.includes("\0")
	) {
		try {
			return (
				new TextDecoder("utf-8", { fatal: true }).decode(
					encoder.encode(name),
				) === name &&
				new TextDecoder("utf-8", { fatal: true }).decode(
					encoder.encode(value),
				) === value
			);
		} catch {
			return false;
		}
	}
	return false;
}

function decodeMiseEnvironment(stdout: Uint8Array): Record<string, string> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(stdout),
		);
	} catch {
		throw new ChildEnvironmentError("mise env returned invalid UTF-8 JSON");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
		throw new ChildEnvironmentError(
			"mise env returned an invalid environment map",
		);
	const environment: Record<string, string> = Object.create(null);
	for (const [name, value] of Object.entries(parsed)) {
		if (!validateEnvironmentEntry(name, value))
			throw new ChildEnvironmentError(
				"mise env returned an invalid environment entry",
			);
		if (name.startsWith("KOGEN_")) continue;
		environment[name] = value;
	}
	return environment;
}

function validateProjectEnvironment(
	projectEnvironment: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
	const environment: Record<string, string> = Object.create(null);
	for (const [name, value] of Object.entries(projectEnvironment ?? {})) {
		if (!validateEnvironmentEntry(name, value))
			throw new ChildEnvironmentError(
				"project environment contains an invalid entry",
			);
		if (name.startsWith("KOGEN_"))
			throw new ChildEnvironmentError(`project environment cannot set ${name}`);
		environment[name] = value;
	}
	return environment;
}

function portFailure(error: PortError): ChildEnvironmentError {
	return new ChildEnvironmentError(`mise env failed (${error.code})`);
}

function miseProcessRequest(
	options: ChildEnvironmentOptions,
	misePath: string,
	base: Record<string, string>,
	stateDirectory: string,
	cacheDirectory: string,
	temporaryDirectory: string,
	trustedPaths: string,
): ProcessRequest {
	return {
		argv: [misePath, "env", "-C", options.workspace, "--json", "--quiet"],
		cwd: options.workspace,
		env: {
			...base,
			TMPDIR: temporaryDirectory,
			MISE_STATE_DIR: stateDirectory,
			MISE_CACHE_DIR: cacheDirectory,
			MISE_TRUSTED_CONFIG_PATHS: trustedPaths,
		},
		timeoutMilliseconds: MISE_ENV_TIMEOUT_MS,
		outputLimitBytes: MISE_ENV_OUTPUT_LIMIT_BYTES,
	};
}

/** Build the exact allowlisted child environment used by project commands. */
export async function buildChildEnvironment(
	options: ChildEnvironmentOptions,
): Promise<ChildEnvironmentResult> {
	const hostEnvironment = options.hostEnvironment ?? process.env;
	const base = createAllowlistedBaseEnvironment(hostEnvironment, options);
	const runtimePaths =
		options.runtimePaths ?? defaultRuntimePaths(hostEnvironment);
	const misePath =
		options.miseBinaryPath === undefined
			? findExecutable("mise", hostEnvironment.PATH)
			: options.miseBinaryPath;
	const temporaryDirectory = join(options.runDirectory, "tmp");
	let environment: Record<string, string> = {
		...base,
		TMPDIR: temporaryDirectory,
	};

	if (misePath !== null) {
		const stateDirectory = join(options.runDirectory, "mise-state");
		const cacheDirectory = join(options.runDirectory, "mise-cache");
		const trustedPaths = appendTrustedPaths(
			base.MISE_TRUSTED_CONFIG_PATHS,
			options.projectRoot,
			options.workspace,
		);
		const request = miseProcessRequest(
			options,
			misePath,
			base,
			stateDirectory,
			cacheDirectory,
			temporaryDirectory,
			trustedPaths,
		);
		ensureEnvironmentFits(request.env);
		let response: Result<ProcessResult>;
		try {
			response = await options.process.run(request);
		} catch {
			throw new ChildEnvironmentError("mise env could not be started");
		}
		if (!response.ok) throw portFailure(response.error);
		if (response.value.timedOut)
			throw new ChildEnvironmentError(
				`mise env timed out after ${MISE_ENV_TIMEOUT_MS} ms`,
			);
		if (response.value.signal !== null || response.value.exitCode !== 0)
			throw new ChildEnvironmentError(
				`mise env exited unsuccessfully (status=${response.value.exitCode ?? "signal"})`,
			);
		if (response.value.stdout.byteLength > MISE_ENV_OUTPUT_LIMIT_BYTES)
			throw new ChildEnvironmentError(
				"mise env output exceeded its byte limit",
			);
		const miseEnvironment = decodeMiseEnvironment(response.value.stdout);
		const misePathValue = filterRuntimePaths(
			miseEnvironment.PATH ?? base.PATH,
			runtimePaths,
		);
		environment = {
			...environment,
			...miseEnvironment,
			MISE_STATE_DIR: stateDirectory,
			MISE_CACHE_DIR: cacheDirectory,
			MISE_TRUSTED_CONFIG_PATHS: trustedPaths,
		};
		if (misePathValue === undefined) delete environment.PATH;
		else environment.PATH = prependPath(dirname(misePath), misePathValue);
	}

	const projectEnvironment = validateProjectEnvironment(
		options.projectEnvironment,
	);
	environment = { ...environment, ...projectEnvironment };
	ensureEnvironmentFits(environment);
	return { environment, miseBinaryPath: misePath };
}
