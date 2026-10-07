import { isAbsolute, join, resolve } from "node:path";
import type { PortError } from "../../contracts/errors";
import type {
	CredentialKey,
	CredentialPort,
	FileSystemPort,
} from "../../contracts/ports";
import { type AccountProvider, isAccountLabel } from "../accounts/format";

export const CREDENTIAL_DIRECTORY = "credentials";
export const CREDENTIAL_FILE_MAX_BYTES = 1024 * 1024 - 8;

function kogenDirectory(homeDirectory: string): string {
	if (!isAbsolute(homeDirectory) || homeDirectory.includes("\0"))
		throw new TypeError("HOME must be an absolute path.");
	return join(resolve(homeDirectory), ".kogen");
}

function credentialPath(key: CredentialKey): string | null {
	if (
		(key.provider !== "chatgpt" && key.provider !== "grok") ||
		!isAccountLabel(key.account) ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(key.name)
	)
		return null;
	const suffix = key.name === "credential" ? "" : `-${key.name}`;
	return `${CREDENTIAL_DIRECTORY}/${key.provider}-${key.account}${suffix}.json`;
}

function invalid(message: string): PortError {
	return { code: "invalid_input", message, retryable: false };
}

/**
 * File-backed credentials are scoped to `$HOME/.kogen/credentials` only.
 * The caller selects this adapter for `KOGEN_CREDENTIAL_STORE=file` (and on
 * platforms whose configured store is the private JSON-file backend).
 * Directory creation and OS-specific encryption are supplied by the auth
 * composition; this adapter never reads an agent's own credential directory.
 */
export function createKogenFileCredentialPort(
	filesystem: Pick<
		FileSystemPort,
		"readFile" | "writeFileAtomically" | "removeFile"
	>,
	homeDirectory: string,
): CredentialPort {
	let root: string;
	try {
		root = kogenDirectory(homeDirectory);
	} catch {
		root = "";
	}
	return {
		async read(key) {
			const path = credentialPath(key);
			if (root.length === 0)
				return { ok: false, error: invalid("HOME must be an absolute path.") };
			if (path === null)
				return { ok: false, error: invalid("Credential key is invalid.") };
			return filesystem.readFile({
				root,
				path,
				maxBytes: CREDENTIAL_FILE_MAX_BYTES,
			});
		},
		async write(key, value) {
			const path = credentialPath(key);
			if (root.length === 0)
				return { ok: false, error: invalid("HOME must be an absolute path.") };
			if (path === null)
				return { ok: false, error: invalid("Credential key is invalid.") };
			if (value.byteLength > CREDENTIAL_FILE_MAX_BYTES)
				return {
					ok: false,
					error: invalid("Credential exceeds the private file size limit."),
				};
			return filesystem.writeFileAtomically({
				root,
				path,
				bytes: value.slice(),
				mode: 0o600,
			});
		},
		async remove(key) {
			const path = credentialPath(key);
			if (root.length === 0)
				return { ok: false, error: invalid("HOME must be an absolute path.") };
			if (path === null)
				return { ok: false, error: invalid("Credential key is invalid.") };
			return filesystem.removeFile(root, path);
		},
	};
}

export function credentialFileRelativePath(
	provider: AccountProvider,
	label: string,
): string {
	const path = credentialPath({ provider, account: label, name: "credential" });
	if (path === null)
		throw new TypeError("Credential account label is invalid.");
	return path;
}
