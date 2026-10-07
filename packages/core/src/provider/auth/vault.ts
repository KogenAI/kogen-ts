import { createCipheriv, createDecipheriv } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import type { PortError, Result } from "../../contracts/errors";
import type {
	CredentialKey,
	CredentialPort,
	FileSystemPort,
	RandomPort,
} from "../../contracts/ports";
import type { HostBridge } from "../../process/host";
import { isAccountLabel } from "../accounts/format";
import {
	CREDENTIAL_FILE_MAX_BYTES,
	createKogenFileCredentialPort,
} from "./store";

export const KEYCHAIN_HOST_OPERATION = 0x0304;
export const KEYCHAIN_SERVICE = "kogen";
export const KEYCHAIN_KEY_BYTES = 32;
export const KEYCHAIN_NONCE_BYTES = 12;
export const KEYCHAIN_TAG_BYTES = 16;

const KEYCHAIN_ACCOUNT_MAX_BYTES = 80;
const KEYCHAIN_REQUEST_HEADER_BYTES = 7;
const KEYCHAIN_RESPONSE_HEADER_BYTES = 5;
const ENVELOPE_MAGIC = new Uint8Array([0x4b, 0x47, 0x56, 0x31]); // KGV1
const ENVELOPE_HEADER_BYTES =
	ENVELOPE_MAGIC.byteLength + KEYCHAIN_NONCE_BYTES + KEYCHAIN_TAG_BYTES;
const CREDENTIAL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type KeychainResult<T> = Result<T, PortError>;

/** Keychain items contain only the random AES key; credential bytes stay in files. */
export interface KeychainPort {
	get(account: string): Promise<KeychainResult<Uint8Array>>;
	add(account: string, key: Uint8Array): Promise<KeychainResult<void>>;
	delete(account: string): Promise<KeychainResult<void>>;
}

enum KeychainAction {
	Get = 1,
	Add = 2,
	Delete = 3,
}

enum KeychainStatus {
	Ok = 0,
	Invalid = 1,
	NotFound = 2,
	Conflict = 3,
	Permission = 4,
	Unavailable = 5,
	Io = 6,
}

function portError(
	code: PortError["code"],
	message: string,
	retryable = false,
): PortError {
	return { code, message, retryable };
}

function validateKeychainAccount(account: string): Uint8Array | null {
	const match = /^(chatgpt|grok):([A-Za-z0-9][A-Za-z0-9._-]{0,63}):key$/.exec(
		account,
	);
	if (!match) return null;
	const bytes = new TextEncoder().encode(account);
	return bytes.byteLength <= KEYCHAIN_ACCOUNT_MAX_BYTES ? bytes : null;
}

function encodeKeychainRequest(
	action: KeychainAction,
	account: string,
	data: Uint8Array = new Uint8Array(),
): Uint8Array | null {
	const accountBytes = validateKeychainAccount(account);
	if (!accountBytes || accountBytes.byteLength > 0xffff) return null;
	if (
		(action === KeychainAction.Add && data.byteLength !== KEYCHAIN_KEY_BYTES) ||
		(action !== KeychainAction.Add && data.byteLength !== 0)
	)
		return null;
	const request = new Uint8Array(
		KEYCHAIN_REQUEST_HEADER_BYTES + accountBytes.byteLength + data.byteLength,
	);
	const view = new DataView(request.buffer);
	request[0] = action;
	view.setUint16(1, accountBytes.byteLength, false);
	view.setUint32(3, data.byteLength, false);
	request.set(accountBytes, KEYCHAIN_REQUEST_HEADER_BYTES);
	request.set(data, KEYCHAIN_REQUEST_HEADER_BYTES + accountBytes.byteLength);
	return request;
}

const STATUS_ERRORS: Readonly<Record<KeychainStatus, PortError>> = {
	[KeychainStatus.Ok]: portError("unknown", "Keychain operation succeeded."),
	[KeychainStatus.Invalid]: portError(
		"invalid_input",
		"Keychain request was invalid.",
	),
	[KeychainStatus.NotFound]: portError(
		"not_found",
		"Credential encryption key was not found.",
	),
	[KeychainStatus.Conflict]: portError(
		"conflict",
		"Credential encryption key already exists.",
	),
	[KeychainStatus.Permission]: portError(
		"permission_denied",
		"Keychain access was denied.",
	),
	[KeychainStatus.Unavailable]: portError(
		"unavailable",
		"Keychain is unavailable on this platform.",
	),
	[KeychainStatus.Io]: portError("io", "Keychain operation failed."),
};

function decodeKeychainResponse(
	response: Uint8Array,
	expectedDataBytes: number,
): KeychainResult<Uint8Array> {
	if (response.byteLength < KEYCHAIN_RESPONSE_HEADER_BYTES)
		return {
			ok: false,
			error: portError("io", "Keychain returned a truncated response."),
		};
	const status = response[0] as KeychainStatus | undefined;
	const dataLength = new DataView(
		response.buffer,
		response.byteOffset,
		response.byteLength,
	).getUint32(1, false);
	if (
		status === undefined ||
		!Object.values(KeychainStatus).includes(status) ||
		response.byteLength !== KEYCHAIN_RESPONSE_HEADER_BYTES + dataLength
	)
		return {
			ok: false,
			error: portError("io", "Keychain returned a malformed response."),
		};
	if (status !== KeychainStatus.Ok) {
		return {
			ok: false,
			error:
				STATUS_ERRORS[status] ?? portError("io", "Keychain operation failed."),
		};
	}
	if (dataLength !== expectedDataBytes)
		return {
			ok: false,
			error: portError("io", "Keychain returned an invalid key length."),
		};
	return { ok: true, value: response.slice(KEYCHAIN_RESPONSE_HEADER_BYTES) };
}

/** Adapts the framed native helper operation; key bytes never enter argv. */
export function createHostKeychainPort(
	bridge: Pick<HostBridge, "request">,
): KeychainPort {
	async function request(
		action: KeychainAction,
		account: string,
		data: Uint8Array,
		expectedDataBytes: number,
	): Promise<KeychainResult<Uint8Array>> {
		const payload = encodeKeychainRequest(action, account, data);
		if (!payload)
			return {
				ok: false,
				error: portError("invalid_input", "Keychain request was invalid."),
			};
		const wirePayload = new Uint8Array(payload);
		try {
			return decodeKeychainResponse(
				await bridge.request(KEYCHAIN_HOST_OPERATION, wirePayload),
				expectedDataBytes,
			);
		} catch {
			return {
				ok: false,
				error: portError(
					"unavailable",
					"The native Keychain helper is unavailable.",
					true,
				),
			};
		} finally {
			wirePayload.fill(0);
			payload.fill(0);
		}
	}
	return {
		async get(account) {
			return request(
				KeychainAction.Get,
				account,
				new Uint8Array(),
				KEYCHAIN_KEY_BYTES,
			);
		},
		async add(account, key) {
			const result = await request(KeychainAction.Add, account, key, 0);
			return result.ok ? { ok: true, value: undefined } : result;
		},
		async delete(account) {
			const result = await request(
				KeychainAction.Delete,
				account,
				new Uint8Array(),
				0,
			);
			return result.ok ? { ok: true, value: undefined } : result;
		},
	};
}

function validCredentialKey(key: CredentialKey): boolean {
	return (
		(key.provider === "chatgpt" || key.provider === "grok") &&
		isAccountLabel(key.account) &&
		CREDENTIAL_NAME_PATTERN.test(key.name)
	);
}

function credentialFilePath(key: CredentialKey): string {
	const suffix = key.name === "credential" ? "" : `-${key.name}`;
	return `credentials/${key.provider}-${key.account}${suffix}.json`;
}

function keychainAccount(key: CredentialKey): string {
	return `${key.provider}:${key.account}:key`;
}

function additionalData(key: CredentialKey): Uint8Array {
	return new TextEncoder().encode(
		`kogen-credential-vault\0v1\0${key.provider}\0${key.account}\0${key.name}`,
	);
}

function envelopeIsValid(bytes: Uint8Array): boolean {
	return (
		bytes.byteLength >= ENVELOPE_HEADER_BYTES &&
		bytes.byteLength <= CREDENTIAL_FILE_MAX_BYTES &&
		ENVELOPE_MAGIC.every((byte, index) => bytes[index] === byte)
	);
}

function encryptCredential(
	plaintext: Uint8Array,
	keyBytes: Uint8Array,
	nonceBytes: Uint8Array,
	key: CredentialKey,
): Uint8Array {
	const keyMaterial = Buffer.from(keyBytes);
	const nonce = Buffer.from(nonceBytes);
	const aad = Buffer.from(additionalData(key));
	try {
		const cipher = createCipheriv("aes-256-gcm", keyMaterial, nonce, {
			authTagLength: KEYCHAIN_TAG_BYTES,
		});
		cipher.setAAD(aad);
		const ciphertext = Buffer.concat([
			cipher.update(plaintext),
			cipher.final(),
		]);
		const envelope = new Uint8Array(
			ENVELOPE_HEADER_BYTES + ciphertext.byteLength,
		);
		envelope.set(ENVELOPE_MAGIC, 0);
		envelope.set(nonceBytes, ENVELOPE_MAGIC.byteLength);
		envelope.set(
			cipher.getAuthTag(),
			ENVELOPE_MAGIC.byteLength + KEYCHAIN_NONCE_BYTES,
		);
		envelope.set(ciphertext, ENVELOPE_HEADER_BYTES);
		return envelope;
	} finally {
		keyMaterial.fill(0);
		nonce.fill(0);
		aad.fill(0);
	}
}

function decryptCredential(
	envelope: Uint8Array,
	keyBytes: Uint8Array,
	key: CredentialKey,
): Uint8Array {
	if (!envelopeIsValid(envelope)) throw new TypeError("Invalid envelope.");
	const nonceStart = ENVELOPE_MAGIC.byteLength;
	const tagStart = nonceStart + KEYCHAIN_NONCE_BYTES;
	const ciphertextStart = ENVELOPE_HEADER_BYTES;
	const keyMaterial = Buffer.from(keyBytes);
	const nonce = Buffer.from(envelope.subarray(nonceStart, tagStart));
	const tag = Buffer.from(envelope.subarray(tagStart, ciphertextStart));
	const aad = Buffer.from(additionalData(key));
	try {
		const decipher = createDecipheriv("aes-256-gcm", keyMaterial, nonce, {
			authTagLength: KEYCHAIN_TAG_BYTES,
		});
		decipher.setAAD(aad);
		decipher.setAuthTag(tag);
		return Buffer.concat([
			decipher.update(envelope.subarray(ciphertextStart)),
			decipher.final(),
		]);
	} finally {
		keyMaterial.fill(0);
		nonce.fill(0);
		tag.fill(0);
		aad.fill(0);
	}
}

function resultError<T>(error: PortError): Result<T> {
	return { ok: false, error };
}

/** AES-256-GCM credential envelope backed by a provider/account Keychain key. */
export function createMacOSCredentialVaultPort(
	filesystem: Pick<
		FileSystemPort,
		"readFile" | "writeFileAtomically" | "removeFile"
	>,
	homeDirectory: string,
	keychain: KeychainPort,
	random: RandomPort,
): CredentialPort {
	const root =
		isAbsolute(homeDirectory) && !homeDirectory.includes("\0")
			? join(resolve(homeDirectory), ".kogen")
			: "";
	async function encryptionKey(
		credentialKey: CredentialKey,
		createIfMissing: boolean,
	): Promise<Result<Uint8Array>> {
		const account = keychainAccount(credentialKey);
		const existing = await keychain.get(account);
		if (existing.ok) {
			const keyBytes = existing.value.slice();
			existing.value.fill(0);
			if (keyBytes.byteLength === KEYCHAIN_KEY_BYTES)
				return { ok: true, value: keyBytes };
			keyBytes.fill(0);
			return resultError(portError("io", "Keychain returned an invalid key."));
		}
		if (existing.error.code !== "not_found" || !createIfMissing)
			return existing;

		const generated = await random.bytes(KEYCHAIN_KEY_BYTES);
		if (!generated.ok) return generated;
		if (generated.value.byteLength !== KEYCHAIN_KEY_BYTES) {
			generated.value.fill(0);
			return resultError(
				portError("io", "Random source returned an invalid key."),
			);
		}
		const created = await keychain.add(account, generated.value);
		if (created.ok) return { ok: true, value: generated.value };
		generated.value.fill(0);
		if (created.error.code !== "conflict") return resultError(created.error);

		// Another process won the create-only Keychain add; load its key.
		const raced = await keychain.get(account);
		if (!raced.ok) return raced;
		const racedKey = raced.value.slice();
		raced.value.fill(0);
		if (racedKey.byteLength !== KEYCHAIN_KEY_BYTES) {
			racedKey.fill(0);
			return resultError(portError("io", "Keychain returned an invalid key."));
		}
		return { ok: true, value: racedKey };
	}

	return {
		async read(key) {
			if (root.length === 0)
				return resultError(
					portError("invalid_input", "HOME must be an absolute path."),
				);
			if (!validCredentialKey(key))
				return resultError(
					portError("invalid_input", "Credential key is invalid."),
				);
			const stored = await filesystem.readFile({
				root,
				path: credentialFilePath(key),
				maxBytes: CREDENTIAL_FILE_MAX_BYTES,
			});
			if (!stored.ok) return stored;
			const vaultKey = await encryptionKey(key, false);
			if (!vaultKey.ok) return vaultKey;
			try {
				if (!envelopeIsValid(stored.value))
					return resultError(
						portError("io", "Stored credential envelope is invalid."),
					);
				const plaintext = decryptCredential(stored.value, vaultKey.value, key);
				try {
					return { ok: true, value: new Uint8Array(plaintext) };
				} finally {
					plaintext.fill(0);
				}
			} catch {
				return resultError(
					portError("io", "Stored credential failed its integrity check."),
				);
			} finally {
				vaultKey.value.fill(0);
			}
		},
		async write(key, value) {
			if (root.length === 0)
				return resultError(
					portError("invalid_input", "HOME must be an absolute path."),
				);
			if (!validCredentialKey(key))
				return resultError(
					portError("invalid_input", "Credential key is invalid."),
				);
			if (value.byteLength > CREDENTIAL_FILE_MAX_BYTES - ENVELOPE_HEADER_BYTES)
				return resultError(
					portError(
						"invalid_input",
						"Credential exceeds the private file size limit.",
					),
				);
			const vaultKey = await encryptionKey(key, true);
			if (!vaultKey.ok) return vaultKey;
			try {
				const nonce = await random.bytes(KEYCHAIN_NONCE_BYTES);
				if (!nonce.ok) return nonce;
				if (nonce.value.byteLength !== KEYCHAIN_NONCE_BYTES) {
					nonce.value.fill(0);
					return resultError(
						portError("io", "Random source returned an invalid nonce."),
					);
				}
				try {
					const envelope = encryptCredential(
						value,
						vaultKey.value,
						nonce.value,
						key,
					);
					return filesystem.writeFileAtomically({
						root,
						path: credentialFilePath(key),
						bytes: envelope,
						mode: 0o600,
					});
				} finally {
					nonce.value.fill(0);
				}
			} catch {
				return resultError(portError("io", "Credential encryption failed."));
			} finally {
				vaultKey.value.fill(0);
			}
		},
		async remove(key) {
			if (root.length === 0)
				return resultError(
					portError("invalid_input", "HOME must be an absolute path."),
				);
			if (!validCredentialKey(key))
				return resultError(
					portError("invalid_input", "Credential key is invalid."),
				);
			// A provider/account key can protect several named credential rows.
			// Keep it until account-wide logout can prove every row is gone.
			return filesystem.removeFile(root, credentialFilePath(key));
		},
	};
}

export interface CredentialPortSelectionOptions {
	readonly filesystem: Pick<
		FileSystemPort,
		"readFile" | "writeFileAtomically" | "removeFile"
	>;
	readonly homeDirectory: string;
	readonly platform?: string;
	readonly credentialStore?: string;
	readonly keychain?: KeychainPort;
	readonly random?: RandomPort;
}

/** Selects the file seam before touching Security.framework or the helper. */
export function createCredentialPort(
	options: CredentialPortSelectionOptions,
): CredentialPort {
	const platform = options.platform ?? process.platform;
	const store = options.credentialStore ?? process.env.KOGEN_CREDENTIAL_STORE;
	if (store === "file" || platform !== "darwin")
		return createKogenFileCredentialPort(
			options.filesystem,
			options.homeDirectory,
		);
	if (store !== undefined && store !== "keychain")
		throw new TypeError("KOGEN_CREDENTIAL_STORE must be file or keychain.");
	if (!options.keychain || !options.random)
		throw new TypeError("macOS Keychain and random ports are required.");
	return createMacOSCredentialVaultPort(
		options.filesystem,
		options.homeDirectory,
		options.keychain,
		options.random,
	);
}
