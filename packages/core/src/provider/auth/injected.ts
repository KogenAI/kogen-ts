import { Buffer } from "node:buffer";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { ClockPort } from "../../contracts/clock";
import type { PortError, Result } from "../../contracts/errors";
import type { FileSystemPort } from "../../contracts/ports";

export const INJECTED_AUTH_MAX_BYTES = 64 * 1024;
export const INJECTED_AUTH_ERROR_MESSAGE =
	"Codex login is missing, invalid, or expired.";

export interface InjectedAuth {
	readonly accessToken: string;
	readonly accountId: string;
	readonly expiresAt: number;
}

export type InjectedAuthReader = () => Promise<Result<InjectedAuth>>;

function loginError(): PortError {
	return {
		code: "invalid_input",
		message: INJECTED_AUTH_ERROR_MESSAGE,
		retryable: false,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeText(value: unknown): value is string {
	return (
		typeof value === "string" && value.length > 0 && !/[\0\r\n]/u.test(value)
	);
}

function decodeJsonSegment(segment: string): unknown | null {
	if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
	try {
		const bytes = Buffer.from(segment, "base64url");
		if (bytes.byteLength === 0 || bytes.toString("base64url") !== segment)
			return null;
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(bytes),
		) as unknown;
	} catch {
		return null;
	}
}

function decodeJwtPayload(token: string): unknown | null {
	const parts = token.split(".");
	if (
		parts.length !== 3 ||
		parts[0] === undefined ||
		parts[1] === undefined ||
		parts[2] === undefined ||
		(parts[2].length > 0 && !/^[A-Za-z0-9_-]+$/.test(parts[2]))
	)
		return null;
	const header = decodeJsonSegment(parts[0]);
	const claims = decodeJsonSegment(parts[1]);
	if (!isRecord(header) || !isSafeText(header.alg) || !isRecord(claims))
		return null;
	if (parts[2].length > 0) {
		const signature = Buffer.from(parts[2], "base64url");
		if (signature.toString("base64url") !== parts[2]) return null;
	}
	return claims;
}

function parseAuthDocument(
	bytes: Uint8Array,
	nowUnixSeconds: number,
): Result<InjectedAuth> {
	let document: unknown;
	try {
		document = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(bytes),
		) as unknown;
	} catch {
		return { ok: false, error: loginError() };
	}
	if (!isRecord(document) || !isRecord(document.tokens))
		return { ok: false, error: loginError() };
	const accessToken = document.tokens.access_token;
	const accountId = document.tokens.account_id;
	if (!isSafeText(accessToken) || !isSafeText(accountId))
		return { ok: false, error: loginError() };
	const claims = decodeJwtPayload(accessToken);
	if (
		!isRecord(claims) ||
		typeof claims.exp !== "number" ||
		!Number.isFinite(claims.exp) ||
		claims.exp <= nowUnixSeconds
	)
		return { ok: false, error: loginError() };
	return {
		ok: true,
		value: { accessToken, accountId, expiresAt: claims.exp },
	};
}

/** Read and validate the injected auth file once. No signature verification or refresh is performed. */
export function parseInjectedAuthFile(
	bytes: Uint8Array,
	nowUnixSeconds: number,
): Result<InjectedAuth> {
	if (!Number.isFinite(nowUnixSeconds) || nowUnixSeconds < 0)
		return { ok: false, error: loginError() };
	return parseAuthDocument(bytes, nowUnixSeconds);
}

/**
 * Construct a per-request reader. The closure stores only the file path, so
 * every call rereads the current file and an expired token cannot be silently
 * refreshed or retained from an earlier request.
 */
export function createInjectedAuthReader(
	filesystem: Pick<FileSystemPort, "readFile">,
	authPath: string,
	options: {
		readonly clock?: Pick<ClockPort, "unixMilliseconds">;
		readonly cwd?: string;
	} = {},
): InjectedAuthReader {
	if (authPath.length === 0 || authPath.includes("\0"))
		return async () => ({ ok: false, error: loginError() });
	const absolutePath = resolve(options.cwd ?? process.cwd(), authPath);
	if (!isAbsolute(absolutePath))
		return async () => ({ ok: false, error: loginError() });
	const root = dirname(absolutePath);
	const path = basename(absolutePath);
	return async () => {
		const result = await filesystem.readFile({
			root,
			path,
			maxBytes: INJECTED_AUTH_MAX_BYTES,
		});
		if (!result.ok) {
			if (
				result.error.code === "not_found" ||
				result.error.code === "invalid_input"
			)
				return { ok: false, error: loginError() };
			return { ok: false, error: result.error };
		}
		const nowMilliseconds = options.clock?.unixMilliseconds() ?? Date.now();
		return parseAuthDocument(result.value, nowMilliseconds / 1000);
	};
}
