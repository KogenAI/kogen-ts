import { describe, expect, test } from "bun:test";
import type {
	PortError,
	Result,
} from "../../packages/core/src/contracts/errors";
import type {
	CredentialKey,
	FileSystemPort,
	RandomPort,
} from "../../packages/core/src/contracts/ports";
import {
	createCredentialPort,
	createHostKeychainPort,
	createMacOSCredentialVaultPort,
	KEYCHAIN_HOST_OPERATION,
	type KeychainPort,
} from "../../packages/core/src/provider/auth/vault";

interface StoredFile {
	readonly bytes: Uint8Array;
	readonly mode: number;
}

function failure<T>(code: PortError["code"], message: string): Result<T> {
	return { ok: false, error: { code, message, retryable: false } };
}

function fileKey(root: string, path: string): string {
	return `${root}\0${path}`;
}

function createMemoryFilesystem(): {
	readonly port: FileSystemPort;
	readonly files: Map<string, StoredFile>;
} {
	const files = new Map<string, StoredFile>();
	const port: FileSystemPort = {
		async readFile(request) {
			const stored = files.get(fileKey(request.root, request.path));
			if (!stored) return failure("not_found", "File not found.");
			if (stored.bytes.byteLength > request.maxBytes)
				return failure("io", "File exceeds read limit.");
			return { ok: true, value: stored.bytes.slice() };
		},
		async writeFileAtomically(request) {
			files.set(fileKey(request.root, request.path), {
				bytes: request.bytes.slice(),
				mode: request.mode,
			});
			return { ok: true, value: undefined };
		},
		async removeFile(root, path) {
			if (!files.delete(fileKey(root, path)))
				return failure("not_found", "File not found.");
			return { ok: true, value: undefined };
		},
	};
	return { port, files };
}

function createMemoryKeychain(): {
	readonly port: KeychainPort;
	readonly items: Map<string, Uint8Array>;
	readonly calls: string[];
} {
	const items = new Map<string, Uint8Array>();
	const calls: string[] = [];
	const port: KeychainPort = {
		async get(account) {
			calls.push(`get:${account}`);
			const key = items.get(account);
			return key
				? { ok: true, value: key.slice() }
				: failure("not_found", "Key not found.");
		},
		async add(account, key) {
			calls.push(`add:${account}`);
			if (items.has(account)) return failure("conflict", "Key exists.");
			items.set(account, key.slice());
			return { ok: true, value: undefined };
		},
		async delete(account) {
			calls.push(`delete:${account}`);
			if (!items.delete(account)) return failure("not_found", "Key not found.");
			return { ok: true, value: undefined };
		},
	};
	return { port, items, calls };
}

function createDeterministicRandom(): RandomPort {
	let call = 0;
	return {
		async bytes(length) {
			const bytes = new Uint8Array(length);
			for (let index = 0; index < length; index++)
				bytes[index] = (index + call * 37 + 1) & 0xff;
			call++;
			return { ok: true, value: bytes };
		},
	};
}

const credentialKey: CredentialKey = {
	provider: "chatgpt",
	account: "work",
	name: "credential",
};
const plaintext = new TextEncoder().encode('{"access_token":"private-token"}');

describe("macOS credential vault", () => {
	test("encrypts credentials in a private AES-256-GCM envelope and round-trips them", async () => {
		const filesystem = createMemoryFilesystem();
		const keychain = createMemoryKeychain();
		const vault = createMacOSCredentialVaultPort(
			filesystem.port,
			"/users/test",
			keychain.port,
			createDeterministicRandom(),
		);

		expect(await vault.write(credentialKey, plaintext)).toEqual({
			ok: true,
			value: undefined,
		});
		const stored = filesystem.files.get(
			"/users/test/.kogen\0credentials/chatgpt-work.json",
		);
		expect(stored).toBeDefined();
		expect(stored?.mode).toBe(0o600);
		expect(stored?.bytes.subarray(0, 4)).toEqual(
			new Uint8Array([0x4b, 0x47, 0x56, 0x31]),
		);
		expect(stored?.bytes).not.toEqual(plaintext);
		expect(
			Buffer.from(stored?.bytes ?? []).includes(Buffer.from("private-token")),
		).toBe(false);
		expect([...keychain.items.keys()]).toEqual(["chatgpt:work:key"]);

		const read = await vault.read(credentialKey);
		expect(read.ok).toBe(true);
		if (read.ok) expect(read.value).toEqual(plaintext);
	});

	test("rejects a modified authentication tag and does not invent a replacement key on read", async () => {
		const filesystem = createMemoryFilesystem();
		const keychain = createMemoryKeychain();
		const vault = createMacOSCredentialVaultPort(
			filesystem.port,
			"/users/test",
			keychain.port,
			createDeterministicRandom(),
		);
		await vault.write(credentialKey, plaintext);
		const stored = filesystem.files.get(
			"/users/test/.kogen\0credentials/chatgpt-work.json",
		);
		if (!stored) throw new Error("Expected an encrypted credential file.");
		stored.bytes[16] = (stored.bytes[16] ?? 0) ^ 0x80;

		const before = keychain.calls.length;
		const read = await vault.read(credentialKey);
		expect(read.ok).toBe(false);
		if (!read.ok) expect(read.error.message).toContain("integrity");
		expect(keychain.calls.slice(before)).toEqual(["get:chatgpt:work:key"]);
	});

	test("a missing Keychain key does not get recreated while reading an existing envelope", async () => {
		const filesystem = createMemoryFilesystem();
		const keychain = createMemoryKeychain();
		const vault = createMacOSCredentialVaultPort(
			filesystem.port,
			"/users/test",
			keychain.port,
			createDeterministicRandom(),
		);
		await vault.write(credentialKey, plaintext);
		keychain.items.delete("chatgpt:work:key");

		const before = keychain.calls.length;
		const read = await vault.read(credentialKey);
		expect(read.ok).toBe(false);
		if (!read.ok) expect(read.error.code).toBe("not_found");
		expect(keychain.calls.slice(before)).toEqual(["get:chatgpt:work:key"]);
		expect(keychain.items.has("chatgpt:work:key")).toBe(false);
	});

	test("uses separate provider key accounts and authenticates the credential identity", async () => {
		const filesystem = createMemoryFilesystem();
		const keychain = createMemoryKeychain();
		const vault = createMacOSCredentialVaultPort(
			filesystem.port,
			"/users/test",
			keychain.port,
			createDeterministicRandom(),
		);
		const grokKey: CredentialKey = {
			provider: "grok",
			account: "work",
			name: "credential",
		};
		await vault.write(credentialKey, plaintext);
		await vault.write(grokKey, plaintext);
		expect([...keychain.items.keys()].sort()).toEqual([
			"chatgpt:work:key",
			"grok:work:key",
		]);

		const chatgptFile = filesystem.files.get(
			"/users/test/.kogen\0credentials/chatgpt-work.json",
		);
		if (!chatgptFile) throw new Error("Expected ChatGPT credential file.");
		filesystem.files.set(
			"/users/test/.kogen\0credentials/grok-work.json",
			chatgptFile,
		);
		// Force the same key bytes to isolate the associated-data identity check.
		keychain.items.set(
			"grok:work:key",
			keychain.items.get("chatgpt:work:key")?.slice() ?? new Uint8Array(),
		);
		const crossProviderRead = await vault.read(grokKey);
		expect(crossProviderRead.ok).toBe(false);
	});

	test("the file seam bypasses Keychain and keeps its existing plaintext file behavior", async () => {
		const filesystem = createMemoryFilesystem();
		const previousStore = process.env.KOGEN_CREDENTIAL_STORE;
		process.env.KOGEN_CREDENTIAL_STORE = "file";
		try {
			const selected = createCredentialPort({
				filesystem: filesystem.port,
				homeDirectory: "/users/test",
				platform: "darwin",
			});
			expect(await selected.write(credentialKey, plaintext)).toEqual({
				ok: true,
				value: undefined,
			});
			expect(
				filesystem.files.get(
					"/users/test/.kogen\0credentials/chatgpt-work.json",
				)?.bytes,
			).toEqual(plaintext);
		} finally {
			if (previousStore === undefined)
				delete process.env.KOGEN_CREDENTIAL_STORE;
			else process.env.KOGEN_CREDENTIAL_STORE = previousStore;
		}
	});

	test("encodes key requests as provider-scoped framed-helper payloads", async () => {
		const keyBytes = new Uint8Array(KEY_BYTES_FOR_TEST).fill(9);
		let seenOperation = 0;
		let seenPayload = new Uint8Array();
		const bridge = {
			async request(operation: number, payload = new Uint8Array()) {
				seenOperation = operation;
				seenPayload = payload.slice();
				const response = new Uint8Array(5 + keyBytes.byteLength);
				response[0] = 0;
				new DataView(response.buffer).setUint32(1, keyBytes.byteLength, false);
				response.set(keyBytes, 5);
				return response;
			},
		};
		const hostKeychain = createHostKeychainPort(bridge);
		const result = await hostKeychain.get("grok:work:key");
		expect(result.ok).toBe(true);
		expect(seenOperation).toBe(KEYCHAIN_HOST_OPERATION);
		expect(seenPayload[0]).toBe(1);
		const accountLength = new DataView(seenPayload.buffer).getUint16(1, false);
		expect(
			new TextDecoder().decode(seenPayload.subarray(7, 7 + accountLength)),
		).toBe("grok:work:key");
		if (result.ok) expect(result.value).toEqual(keyBytes);
	});
});

const KEY_BYTES_FOR_TEST = 32;
