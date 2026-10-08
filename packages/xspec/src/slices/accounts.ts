import type {
	AccountProvider,
	AccountsDocument,
	ProviderAccountMap,
} from "../../../core/src/provider/accounts/format";
import {
	isAccountLabel,
	parseAccountsYaml,
	serializeAccountsYaml,
	withProviderAccount,
} from "../../../core/src/provider/accounts/format";
import {
	type ChatGptProfile,
	type GrokProfile,
	type ProfilesDocument,
	withAccountProfile,
} from "../../../core/src/provider/accounts/profiles";
import { resolveAccountSelection } from "../../../core/src/provider/accounts/select";
import {
	decodeSliceEvent,
	XspecProtocolError,
	type XspecSlice,
} from "../protocol";

interface ProfileSeed {
	readonly provider: string;
	readonly label: string;
	readonly present: boolean;
	readonly saved: boolean;
	readonly signedIn: boolean;
	readonly email: string;
	readonly expires: number;
	readonly hasExpiry: boolean;
	readonly notice: boolean;
	readonly remoteRevoked: boolean;
}

interface State {
	profiles: ProfilesDocument;
	accounts: AccountsDocument;
	saved: Set<string>;
	committed: Map<string, string>;
	projectExists: Map<string, boolean>;
	envProvider: string;
	envAccount: string;
	broken: boolean;
	resolvedProvider: string;
	resolvedLabel: string;
	resolvedSaved: boolean;
	last: string;
	exit: number;
	operation: string;
}

const PROVIDERS = ["chatgpt", "grok"] as const;
const PROJECTS = ["alpha", "bravo"] as const;
const PROJECT_PATHS: Readonly<Record<(typeof PROJECTS)[number], string>> = {
	alpha: "/xspec/accounts/alpha",
	bravo: "/xspec/accounts/bravo",
};
const encoder = new TextEncoder();

function fail(message: string): never {
	throw new XspecProtocolError("invalid_event", message);
}

function exact(
	value: Record<string, unknown>,
	keys: readonly string[],
	name: string,
): void {
	if (
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key))
	)
		fail(`${name} does not match the frozen field schema`);
}

function stringField(value: Record<string, unknown>, key: string): string {
	const field = value[key];
	if (typeof field !== "string") fail(`${key} must be a string`);
	return field;
}

function booleanField(value: Record<string, unknown>, key: string): boolean {
	const field = value[key];
	if (typeof field !== "boolean") fail(`${key} must be a boolean`);
	return field;
}

function integerField(value: Record<string, unknown>, key: string): number {
	const field = value[key];
	if (!Number.isSafeInteger(field)) fail(`${key} must be a safe integer`);
	return field as number;
}

function emptyProfiles(): ProfilesDocument {
	return { chatgpt: Object.create(null), grok: Object.create(null) };
}

function emptyState(): State {
	return {
		profiles: emptyProfiles(),
		accounts: {},
		saved: new Set(),
		committed: new Map(),
		projectExists: new Map(),
		envProvider: "",
		envAccount: "",
		broken: false,
		resolvedProvider: "",
		resolvedLabel: "",
		resolvedSaved: false,
		last: "ok",
		exit: 0,
		operation: "none",
	};
}

function profileSeed(value: Record<string, unknown>): ProfileSeed {
	exact(
		value,
		[
			"provider",
			"label",
			"present",
			"saved",
			"signedIn",
			"email",
			"expires",
			"hasExpiry",
			"notice",
			"remoteRevoked",
		],
		"Seed",
	);
	const expires = integerField(value, "expires");
	if (expires < 0) fail("expires must be non-negative");
	return {
		provider: stringField(value, "provider"),
		label: stringField(value, "label"),
		present: booleanField(value, "present"),
		saved: booleanField(value, "saved"),
		signedIn: booleanField(value, "signedIn"),
		email: stringField(value, "email"),
		expires,
		hasExpiry: booleanField(value, "hasExpiry"),
		notice: booleanField(value, "notice"),
		remoteRevoked: booleanField(value, "remoteRevoked"),
	};
}

function key(provider: string, label: string): string {
	return `${provider}:${label}`;
}

function accountsRoundTrip(document: AccountsDocument): AccountsDocument {
	const parsed = parseAccountsYaml(serializeAccountsYaml(document));
	if (!parsed.ok)
		throw new Error(
			`xspec accounts fixture did not round-trip: ${parsed.error.message}`,
		);
	return parsed.value;
}

function setProfile(state: State, seed: ProfileSeed): void {
	if (seed.provider !== "chatgpt" && seed.provider !== "grok") {
		state.last = "bad_profile";
		state.exit = 2;
		state.operation = "seed";
		return;
	}
	if (!isAccountLabel(seed.label)) {
		state.last = "bad_profile";
		state.exit = 2;
		state.operation = "seed";
		return;
	}
	if (seed.present) {
		if (seed.provider === "chatgpt") {
			const profile: ChatGptProfile = {
				client_id: "xspec-client",
				subject: "xspec-subject",
				email: seed.email || null,
				expires_at: seed.hasExpiry ? seed.expires : null,
				signed_in: seed.signedIn,
				plan_usage: null,
				notice_shown: seed.notice,
				remote_revoked: seed.remoteRevoked,
			};
			state.profiles = withAccountProfile(
				state.profiles,
				"chatgpt",
				seed.label,
				profile,
			);
		} else {
			const profile: GrokProfile = {
				email: seed.email || null,
				expires_at: seed.hasExpiry ? seed.expires : null,
				signed_in: seed.signedIn,
			};
			state.profiles = withAccountProfile(
				state.profiles,
				"grok",
				seed.label,
				profile,
			);
		}
	} else {
		const chatgpt = { ...state.profiles.chatgpt };
		const grok = { ...state.profiles.grok };
		if (seed.provider === "chatgpt") delete chatgpt[seed.label];
		else delete grok[seed.label];
		state.profiles = { chatgpt, grok };
	}
	if (seed.saved) state.saved.add(key(seed.provider, seed.label));
	else state.saved.delete(key(seed.provider, seed.label));
	state.last = "ok";
	state.exit = 0;
	state.operation = "seed";
}

function mutateProviderMap(
	document: AccountsDocument,
	provider: AccountProvider,
	change: (current: ProviderAccountMap) => ProviderAccountMap,
): AccountsDocument {
	const current = document[provider] ?? {};
	return { ...document, [provider]: change(current) };
}

function projectForName(name: string): (typeof PROJECTS)[number] | null {
	return PROJECTS.includes(name as (typeof PROJECTS)[number])
		? (name as (typeof PROJECTS)[number])
		: null;
}

function providerForProject(state: State, name: string): string {
	const project = projectForName(name);
	if (project === null) return "";
	return (
		state.accounts.selection?.projects?.find(
			(row) => row.path === PROJECT_PATHS[project],
		)?.provider ?? ""
	);
}

function committedAccount(state: State, name: string): string | undefined {
	return state.committed.get(name);
}

function projectAccount(
	state: State,
	provider: AccountProvider,
	name: string,
): string {
	const project = projectForName(name);
	if (project === null) return "";
	return (
		state.accounts[provider]?.projects?.find(
			(row) => row.path === PROJECT_PATHS[project],
		)?.account ?? ""
	);
}

function accountDefault(state: State, provider: AccountProvider): string {
	return state.accounts[provider]?.default ?? "default";
}

function compareUtf8(left: string, right: string): number {
	const a = encoder.encode(left);
	const b = encoder.encode(right);
	for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return a.length - b.length;
}

function rows(state: State) {
	const result: {
		provider: string;
		label: string;
		isDefault: boolean;
		signedIn: boolean;
		email: string;
		expires: number;
	}[] = [];
	for (const provider of PROVIDERS) {
		const profiles = state.profiles[provider];
		for (const label of Object.keys(profiles).sort(compareUtf8)) {
			const profile = profiles[label];
			if (profile === undefined) continue;
			result.push({
				provider,
				label,
				isDefault:
					(state.accounts.selection?.default ?? "chatgpt") === provider &&
					accountDefault(state, provider) === label,
				signedIn: profile.signed_in,
				email: profile.email ?? "",
				expires: profile.expires_at ?? 0,
			});
		}
	}
	return result.length > 0
		? result
		: [
				{
					provider: "chatgpt",
					label: "",
					isDefault: false,
					signedIn: false,
					email: "",
					expires: 0,
				},
				{
					provider: "grok",
					label: "",
					isDefault: false,
					signedIn: false,
					email: "",
					expires: 0,
				},
			];
}

function projectAccountField(
	state: State,
	provider: AccountProvider,
	name: string,
): string {
	return projectAccount(state, provider, name);
}

function observe(state: State) {
	return {
		last: state.last,
		exit: state.exit,
		operation: state.operation,
		rows: rows(state),
		chatDefault: accountDefault(state, "chatgpt"),
		grokDefault: accountDefault(state, "grok"),
		selectedDefault: state.accounts.selection?.default ?? "chatgpt",
		chatAlpha: projectAccountField(state, "chatgpt", "alpha"),
		chatBravo: projectAccountField(state, "chatgpt", "bravo"),
		grokAlpha: projectAccountField(state, "grok", "alpha"),
		grokBravo: projectAccountField(state, "grok", "bravo"),
		providerAlpha: providerForProject(state, "alpha"),
		providerBravo: providerForProject(state, "bravo"),
		resolvedProvider: state.resolvedProvider,
		resolvedLabel: state.resolvedLabel,
		resolvedSaved: state.resolvedSaved,
		broken: state.broken,
	};
}

function setOutcome(
	state: State,
	last: string,
	exit: number,
	operation: string,
): void {
	state.last = last;
	state.exit = exit;
	state.operation = operation;
}

function login(state: State, value: Record<string, unknown>): void {
	exact(
		value,
		["provider", "success", "email", "expires", "hasExpiry", "notice"],
		"Login",
	);
	const provider = stringField(value, "provider");
	const success = booleanField(value, "success");
	const email = stringField(value, "email");
	const expires = integerField(value, "expires");
	const hasExpiry = booleanField(value, "hasExpiry");
	const notice = booleanField(value, "notice");
	if (provider !== "chatgpt" && provider !== "grok") {
		setOutcome(state, "unknown_provider", 2, "login");
		return;
	}
	if (!success) {
		setOutcome(state, "login_failed", 4, "login");
		return;
	}
	setProfile(state, {
		provider,
		label: "default",
		present: true,
		saved: true,
		signedIn: true,
		email,
		expires,
		hasExpiry,
		notice,
		remoteRevoked: false,
	});
	state.operation = notice ? "login_notice" : "login";
}

function logout(state: State, value: Record<string, unknown>): void {
	exact(value, ["provider", "remote"], "Logout");
	const provider = stringField(value, "provider");
	const remote = booleanField(value, "remote");
	if (provider !== "chatgpt" && provider !== "grok") {
		setOutcome(state, "unknown_provider", 2, "logout");
		return;
	}
	if (provider === "chatgpt") {
		const old = state.profiles.chatgpt.default;
		const profile: ChatGptProfile = {
			client_id: old?.client_id ?? "xspec-client",
			subject: old?.subject ?? "xspec-subject",
			email: old?.email ?? null,
			expires_at: old?.expires_at ?? null,
			signed_in: false,
			plan_usage: old?.plan_usage ?? null,
			notice_shown: old?.notice_shown ?? false,
			remote_revoked: remote,
		};
		state.profiles = withAccountProfile(
			state.profiles,
			"chatgpt",
			"default",
			profile,
		);
	} else {
		const old = state.profiles.grok.default;
		const profile: GrokProfile = {
			email: old?.email ?? null,
			expires_at: old?.expires_at ?? null,
			signed_in: false,
		};
		state.profiles = withAccountProfile(
			state.profiles,
			"grok",
			"default",
			profile,
		);
	}
	state.saved.delete(key(provider, "default"));
	setOutcome(
		state,
		"ok",
		0,
		provider === "chatgpt" && remote ? "logout_remote" : "logout_local",
	);
}

function project(state: State, value: Record<string, unknown>): void {
	exact(value, ["name", "exists", "provider", "account"], "Project");
	const name = stringField(value, "name");
	const exists = booleanField(value, "exists");
	const provider = stringField(value, "provider");
	const account = stringField(value, "account");
	const projectName = projectForName(name);
	if (projectName === null) {
		setOutcome(state, "unknown_project", 2, "project");
		return;
	}
	state.projectExists.set(name, exists);
	state.committed.set(name, account);
	const rows = (state.accounts.selection?.projects ?? []).filter(
		(row) => row.path !== PROJECT_PATHS[projectName],
	);
	if (exists && (provider === "chatgpt" || provider === "grok"))
		rows.push({ path: PROJECT_PATHS[projectName], provider });
	state.accounts = accountsRoundTrip({
		...state.accounts,
		selection: { ...state.accounts.selection, projects: rows },
	});
	setOutcome(state, "ok", 0, "project");
}

function providerDefault(state: State, value: Record<string, unknown>): void {
	exact(value, ["provider", "label"], "ProviderDefault");
	const provider = stringField(value, "provider");
	const label = stringField(value, "label");
	if (
		(provider !== "chatgpt" && provider !== "grok") ||
		(label !== "" && !isAccountLabel(label))
	) {
		setOutcome(state, "bad_choice", 2, "choice");
		return;
	}
	const providerName = provider as AccountProvider;
	state.accounts = accountsRoundTrip(
		mutateProviderMap(state.accounts, providerName, (current) => {
			const { default: _default, ...rest } = current;
			return label === "" ? rest : { ...current, default: label };
		}),
	);
	setOutcome(state, "ok", 0, "choice");
}

function setSelectionDefault(
	state: State,
	value: Record<string, unknown>,
): void {
	exact(value, ["provider"], "SelectionDefault");
	const provider = stringField(value, "provider");
	if (provider !== "chatgpt" && provider !== "grok") {
		setOutcome(state, "bad_choice", 2, "selection");
		return;
	}
	state.accounts = accountsRoundTrip({
		...state.accounts,
		selection: { ...state.accounts.selection, default: provider },
	});
	setOutcome(state, "ok", 0, "selection");
}

function use(state: State, value: Record<string, unknown>): void {
	exact(value, ["provider", "label", "project", "projectExists"], "Use");
	const provider = stringField(value, "provider");
	const label = stringField(value, "label");
	const projectName = stringField(value, "project");
	const projectExistsEffect = booleanField(value, "projectExists");
	if (provider !== "chatgpt" && provider !== "grok") {
		setOutcome(state, "unknown_provider", 2, "use");
		return;
	}
	if (!isAccountLabel(label)) {
		setOutcome(state, "invalid_label", 2, "use");
		return;
	}
	if (projectName !== "" && projectForName(projectName) === null) {
		setOutcome(state, "unknown_project", 2, "use");
		return;
	}
	if (!state.saved.has(key(provider, label))) {
		setOutcome(state, "no_saved_login", 4, "use");
		return;
	}
	if (state.broken) {
		setOutcome(state, "invalid_accounts_file", 3, "use");
		return;
	}
	if (
		projectName !== "" &&
		(!projectExistsEffect || state.projectExists.get(projectName) === false)
	) {
		setOutcome(state, "project_unavailable", 3, "use");
		return;
	}
	try {
		const projectPath = projectForName(projectName);
		state.accounts = accountsRoundTrip(
			withProviderAccount(
				state.accounts,
				provider,
				label,
				projectPath === null ? undefined : PROJECT_PATHS[projectPath],
			),
		);
		setOutcome(
			state,
			"ok",
			0,
			projectName === "" ? "use_default" : "use_project",
		);
	} catch {
		setOutcome(state, "invalid_accounts_file", 3, "use");
	}
}

function resolve(state: State, value: Record<string, unknown>): void {
	exact(value, ["project"], "Resolve");
	const projectName = stringField(value, "project");
	state.resolvedProvider = "";
	state.resolvedLabel = "";
	state.resolvedSaved = false;
	const project = projectForName(projectName);
	if (projectName !== "" && project === null) {
		setOutcome(state, "unknown_project", 2, "resolve");
		return;
	}
	if (project !== null && state.projectExists.get(projectName) !== true) {
		setOutcome(state, "project_unavailable", 3, "resolve");
		return;
	}
	if (state.broken) {
		setOutcome(state, "invalid_accounts_file", 3, "resolve");
		return;
	}
	const selection = resolveAccountSelection({
		checkout:
			project === null ? "/xspec/accounts/none" : PROJECT_PATHS[project],
		accounts: state.accounts,
		...(project === null || committedAccount(state, projectName) === undefined
			? {}
			: { committedAccount: committedAccount(state, projectName) as string }),
		environment: {
			...(state.envProvider === ""
				? {}
				: { KOGEN_BENCH_PROVIDER: state.envProvider }),
			...(state.envAccount === ""
				? {}
				: { KOGEN_BENCH_ACCOUNT: state.envAccount }),
		},
	});
	if (!selection.ok) {
		const code =
			selection.error.code === "invalid_provider"
				? "invalid_provider_environment"
				: "invalid_account_environment";
		setOutcome(state, code, 3, "resolve");
		return;
	}
	state.resolvedProvider = selection.value.provider;
	state.resolvedLabel = selection.value.account;
	state.resolvedSaved = state.saved.has(
		key(selection.value.provider, selection.value.account),
	);
	setOutcome(state, "ok", 0, "resolve");
}

function corrupt(state: State, value: Record<string, unknown>): void {
	exact(value, ["broken"], "Corrupt");
	const broken = booleanField(value, "broken");
	if (broken) {
		const invalid = parseAccountsYaml(encoder.encode("accounts: [broken\n"));
		state.broken = !invalid.ok;
		state.accounts = {};
	} else {
		state.broken = false;
		state.accounts = {};
	}
	setOutcome(state, "ok", 0, "accounts_file");
}

export function createAccountsSlice(): XspecSlice {
	let state = emptyState();
	return {
		async reset() {
			state = emptyState();
			return observe(state);
		},
		async apply(event) {
			const decoded = decodeSliceEvent(event);
			if (decoded.tag === "Init") {
				if (decoded.value !== undefined) fail("Init accepts no value");
				state = emptyState();
				return observe(state);
			}
			if (decoded.tag === "ListAccounts") {
				if (decoded.value !== undefined) fail("ListAccounts accepts no value");
				setOutcome(state, "ok", 0, "list");
			} else if (decoded.tag === "Seed") {
				if (decoded.value === undefined) fail("Seed requires its value object");
				setProfile(state, profileSeed(decoded.value));
			} else if (decoded.tag === "Login") {
				if (decoded.value === undefined)
					fail("Login requires its value object");
				login(state, decoded.value);
			} else if (decoded.tag === "Logout") {
				if (decoded.value === undefined)
					fail("Logout requires its value object");
				logout(state, decoded.value);
			} else if (decoded.tag === "Use") {
				if (decoded.value === undefined) fail("Use requires its value object");
				use(state, decoded.value);
			} else if (decoded.tag === "Project") {
				if (decoded.value === undefined)
					fail("Project requires its value object");
				project(state, decoded.value);
			} else if (decoded.tag === "ProviderDefault") {
				if (decoded.value === undefined)
					fail("ProviderDefault requires its value object");
				providerDefault(state, decoded.value);
			} else if (decoded.tag === "SelectionDefault") {
				if (decoded.value === undefined)
					fail("SelectionDefault requires its value object");
				setSelectionDefault(state, decoded.value);
			} else if (decoded.tag === "Environment") {
				if (decoded.value === undefined)
					fail("Environment requires its value object");
				exact(decoded.value, ["provider", "account"], "Environment");
				state.envProvider = stringField(decoded.value, "provider");
				state.envAccount = stringField(decoded.value, "account");
				setOutcome(state, "ok", 0, "environment");
			} else if (decoded.tag === "Corrupt") {
				if (decoded.value === undefined)
					fail("Corrupt requires its value object");
				corrupt(state, decoded.value);
			} else if (decoded.tag === "Resolve") {
				if (decoded.value === undefined)
					fail("Resolve requires its value object");
				resolve(state, decoded.value);
			} else {
				fail(`Unsupported accounts event ${decoded.tag}`);
			}
			return observe(state);
		},
	};
}
