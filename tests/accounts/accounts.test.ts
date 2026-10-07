import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import type {
	PortError,
	Result,
} from "../../packages/core/src/contracts/errors";
import type {
	CredentialKey,
	FileReadRequest,
	FileSystemPort,
	FileWriteRequest,
} from "../../packages/core/src/contracts/ports";
import {
	type AccountsDocument,
	parseAccountsYaml,
	readAccountsFile,
	serializeAccountsYaml,
	withProviderAccount,
	writeAccountsFile,
} from "../../packages/core/src/provider/accounts/format";
import {
	formatProfileList,
	loadOrCreateHostId,
	type ProfilesDocument,
	parseProfilesJson,
	readProfilesFile,
	serializeProfilesJson,
	writeProfilesFile,
} from "../../packages/core/src/provider/accounts/profiles";
import { resolveAccountSelection } from "../../packages/core/src/provider/accounts/select";
import {
	createInjectedAuthReader,
	INJECTED_AUTH_ERROR_MESSAGE,
	parseInjectedAuthFile,
} from "../../packages/core/src/provider/auth/injected";
import { createKogenFileCredentialPort } from "../../packages/core/src/provider/auth/store";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function portError(code: PortError["code"] = "not_found"): PortError {
	return { code, message: "missing", retryable: false };
}

class MemoryFileSystem implements FileSystemPort {
	readonly reads: FileReadRequest[] = [];
	readonly writes: FileWriteRequest[] = [];
	readonly removals: { readonly root: string; readonly path: string }[] = [];
	readonly files = new Map<string, Uint8Array>();
	readFailure: PortError | null = null;

	async readFile(request: FileReadRequest): Promise<Result<Uint8Array>> {
		this.reads.push(request);
		if (this.readFailure !== null)
			return { ok: false, error: this.readFailure };
		const bytes = this.files.get(`${request.root}\0${request.path}`);
		return bytes === undefined
			? { ok: false, error: portError() }
			: { ok: true, value: bytes.slice() };
	}

	async writeFileAtomically(request: FileWriteRequest): Promise<Result<void>> {
		this.writes.push({ ...request, bytes: request.bytes.slice() });
		this.files.set(`${request.root}\0${request.path}`, request.bytes.slice());
		return { ok: true, value: undefined };
	}

	async removeFile(root: string, path: string): Promise<Result<void>> {
		this.removals.push({ root, path });
		this.files.delete(`${root}\0${path}`);
		return { ok: true, value: undefined };
	}
}

function bytesOf(value: string): Uint8Array {
	return encoder.encode(value);
}

function jwt(
	payload: Readonly<Record<string, unknown>>,
	signature = Buffer.from("unverified").toString("base64url"),
): string {
	const header = Buffer.from(
		JSON.stringify({ alg: "RS256", typ: "JWT" }),
	).toString("base64url");
	const claims = Buffer.from(JSON.stringify(payload)).toString("base64url");
	return `${header}.${claims}.${signature}`;
}

describe("accounts YAML and selection", () => {
	test("accepts the empty provider map and parses both provider rows", () => {
		const empty = parseAccountsYaml(
			bytesOf("# machine accounts\nchatgpt: {}\n"),
		);
		expect(empty).toEqual({ ok: true, value: { chatgpt: {} } });

		const parsed = parseAccountsYaml(
			bytesOf(
				'chatgpt:\n  default: work\ngrok:\n  projects:\n    - path: "/work/project"\n      account: team\nselection:\n  default: grok\n',
			),
		);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.value.chatgpt?.default).toBe("work");
			expect(parsed.value.grok?.projects).toEqual([
				{ path: "/work/project", account: "team" },
			]);
			expect(parsed.value.selection?.default).toBe("grok");
		}
	});

	test("rejects YAML and account schemas outside the strict subset", () => {
		for (const content of [
			"chatgpt:\n",
			"chatgpt: {}\nchatgpt: {}\n",
			"chatgpt:\n  token: secret\n",
			"chatgpt:\n\tdefault: work\n",
			"selection:\n  default: other\n",
			"grok:\n  projects:\n    - path: relative\n      account: team\n",
		]) {
			expect(parseAccountsYaml(bytesOf(content)).ok).toBe(false);
		}
	});

	test("writes canonical provider selection rows, sorted and pruned by existing directories", async () => {
		const initial: AccountsDocument = {
			chatgpt: { projects: [{ path: "/z/project", account: "z" }] },
		};
		const selected = withProviderAccount(
			initial,
			"chatgpt",
			"default",
			"/work/project",
		);
		const output = serializeAccountsYaml(selected);
		expect(decoder.decode(output)).toBe(
			"# Kogen accounts on this machine, written by kogen provider use.\n" +
				"chatgpt:\n" +
				"  projects:\n" +
				'    - path: "/work/project"\n' +
				"      account: default\n" +
				'    - path: "/z/project"\n' +
				"      account: z\n" +
				"selection:\n" +
				"  projects:\n" +
				'    - path: "/work/project"\n' +
				"      provider: chatgpt\n",
		);

		const filesystem = new MemoryFileSystem();
		const result = await writeAccountsFile(
			filesystem,
			"/users/tester",
			selected,
			async (path) => path !== "/z/project",
		);
		expect(result.ok).toBe(true);
		expect(filesystem.writes).toHaveLength(1);
		expect(filesystem.writes[0]).toMatchObject({
			root: "/users/tester/.kogen",
			path: "accounts.yaml",
			mode: 0o600,
		});
		expect(decoder.decode(filesystem.writes[0]?.bytes)).not.toContain(
			"/z/project",
		);
	});

	test("loads absent account settings without reading outside the Kogen state directory", async () => {
		const filesystem = new MemoryFileSystem();
		const absent = await readAccountsFile(filesystem, "/users/tester");
		expect(absent).toEqual({ ok: true, value: null });
		expect(filesystem.reads[0]).toMatchObject({
			root: "/users/tester/.kogen",
			path: "accounts.yaml",
		});
	});

	test("provider and account precedence is resolved independently", () => {
		const accounts: AccountsDocument = {
			chatgpt: {
				default: "personal",
				projects: [{ path: "/work/project", account: "chatgpt-work" }],
			},
			grok: {
				default: "grok-home",
				projects: [{ path: "/work/project", account: "grok-work" }],
			},
			selection: {
				default: "chatgpt",
				projects: [{ path: "/work/project", provider: "grok" }],
			},
		};
		const selected = resolveAccountSelection({
			checkout: "/work/project",
			accounts,
			committedAccount: "legacy",
		});
		expect(selected).toMatchObject({
			ok: true,
			value: {
				provider: "grok",
				account: "grok-work",
				providerSource: "project",
				accountSource: "machine_project",
			},
		});

		const environment = resolveAccountSelection({
			checkout: "/work/project",
			accounts,
			committedAccount: "legacy",
			environment: {
				KOGEN_BENCH_PROVIDER: "chatgpt",
				KOGEN_BENCH_ACCOUNT: "bench",
			},
		});
		expect(environment).toMatchObject({
			ok: true,
			value: {
				provider: "chatgpt",
				account: "bench",
				providerSource: "environment",
				accountSource: "environment",
			},
		});

		const legacy = resolveAccountSelection({
			checkout: "/elsewhere",
			accounts,
			committedAccount: "legacy",
		});
		expect(legacy).toMatchObject({
			ok: true,
			value: {
				provider: "chatgpt",
				account: "legacy",
				accountSource: "committed_project",
			},
		});
		const noLegacyForGrok = resolveAccountSelection({
			checkout: "/elsewhere",
			accounts: { ...accounts, selection: { default: "grok" } },
			committedAccount: "legacy",
		});
		expect(noLegacyForGrok).toMatchObject({
			ok: true,
			value: {
				provider: "grok",
				account: "grok-home",
				accountSource: "machine_default",
			},
		});
		expect(
			resolveAccountSelection({
				checkout: "/elsewhere",
				accounts,
				environment: { KOGEN_BENCH_PROVIDER: "openai" },
			}).ok,
		).toBe(false);
	});
});

describe("profiles and host identity", () => {
	test("reads and writes profiles as compact provider maps and formats both rows", async () => {
		const profiles: ProfilesDocument = {
			chatgpt: {
				work: {
					client_id: "client",
					subject: "subject",
					email: "person@example.test",
					expires_at: 2000,
					signed_in: true,
					plan_usage: null,
					notice_shown: false,
					remote_revoked: false,
				},
			},
			grok: { team: { email: null, expires_at: 3000, signed_in: false } },
		};
		const bytes = serializeProfilesJson(profiles);
		expect(parseProfilesJson(bytes)).toEqual({ ok: true, value: profiles });
		expect(
			formatProfileList(profiles, {
				chatgpt: { default: "work" },
				selection: { default: "chatgpt" },
			}),
		).toBe(
			"chatgpt:work (default) signed in person@example.test expires=2000\n" +
				"grok:team signed out expires=3000\n",
		);
		expect(formatProfileList({ chatgpt: {}, grok: {} }, {})).toBe(
			"chatgpt: not signed in\ngrok: not signed in\n",
		);
		const filesystem = new MemoryFileSystem();
		expect(
			await writeProfilesFile(filesystem, "/users/tester", profiles),
		).toEqual({
			ok: true,
			value: undefined,
		});
		expect(filesystem.writes[0]).toMatchObject({
			root: "/users/tester/.kogen",
			path: "profiles.json",
			mode: 0o600,
		});
		const saved = await readProfilesFile(filesystem, "/users/tester");
		expect(saved).toEqual({ ok: true, value: profiles });
	});

	test("persists a stable host UUID v4 atomically in Kogen state", async () => {
		const filesystem = new MemoryFileSystem();
		const expected = "urn:uuid:123e4567-e89b-42d3-a456-426614174000";
		const first = await loadOrCreateHostId(filesystem, "/users/tester", () =>
			expected.slice("urn:uuid:".length),
		);
		expect(first).toEqual({ ok: true, value: expected });
		expect(filesystem.writes[0]).toMatchObject({
			root: "/users/tester/.kogen",
			path: "host.json",
			mode: 0o600,
		});
		expect(decoder.decode(filesystem.writes[0]?.bytes)).toBe(
			JSON.stringify({ ext_agent_host_id: expected }),
		);
		const second = await loadOrCreateHostId(filesystem, "/users/tester", () => {
			throw new Error("existing host id should be reused");
		});
		expect(second).toEqual(first);
	});
});

describe("credential and injected auth stores", () => {
	test("writes credentials only under HOME/.kogen with private permissions", async () => {
		const filesystem = new MemoryFileSystem();
		const store = createKogenFileCredentialPort(filesystem, "/users/tester");
		const key: CredentialKey = {
			provider: "chatgpt",
			account: "work",
			name: "credential",
		};
		const secret = bytesOf('{"access_token":"test-secret"}');
		expect(await store.write(key, secret)).toEqual({
			ok: true,
			value: undefined,
		});
		expect(filesystem.writes[0]).toMatchObject({
			root: "/users/tester/.kogen",
			path: "credentials/chatgpt-work.json",
			mode: 0o600,
		});
		expect(await store.read(key)).toEqual({ ok: true, value: secret });
		expect((await store.remove(key)).ok).toBe(true);
		expect(filesystem.removals).toEqual([
			{ root: "/users/tester/.kogen", path: "credentials/chatgpt-work.json" },
		]);
		const before = filesystem.writes.length;
		expect(
			(await store.write({ ...key, account: "../source" }, secret)).ok,
		).toBe(false);
		expect(filesystem.writes).toHaveLength(before);
	});

	test("rejects expired injected JWTs and rereads the auth file for every request", async () => {
		const now = 1000;
		const expired = bytesOf(
			JSON.stringify({
				tokens: { access_token: jwt({ exp: now }), account_id: "acct" },
			}),
		);
		expect(parseInjectedAuthFile(expired, now)).toMatchObject({
			ok: false,
			error: { message: INJECTED_AUTH_ERROR_MESSAGE },
		});

		const filesystem = new MemoryFileSystem();
		const path = "/tmp/auth.json";
		filesystem.files.set(
			`/tmp\0auth.json`,
			bytesOf(
				JSON.stringify({
					tokens: { access_token: jwt({ exp: 2000 }), account_id: "acct" },
				}),
			),
		);
		let clockMs = 1_000_000;
		const reader = createInjectedAuthReader(filesystem, path, {
			clock: { unixMilliseconds: () => clockMs },
		});
		const first = await reader();
		expect(first).toMatchObject({
			ok: true,
			value: { accountId: "acct", expiresAt: 2000 },
		});
		filesystem.files.set(
			`/tmp\0auth.json`,
			bytesOf(
				JSON.stringify({
					tokens: { access_token: jwt({ exp: 999 }), account_id: "acct" },
				}),
			),
		);
		clockMs = 1_001_000;
		const second = await reader();
		expect(second).toMatchObject({
			ok: false,
			error: { message: INJECTED_AUTH_ERROR_MESSAGE },
		});
		expect(filesystem.reads).toHaveLength(2);
		expect(filesystem.reads.map((read) => [read.root, read.path])).toEqual([
			["/tmp", "auth.json"],
			["/tmp", "auth.json"],
		]);
	});
});
