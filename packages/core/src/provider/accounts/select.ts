import type { Result } from "../../contracts/errors";
import {
	type AccountProvider,
	type AccountsDocument,
	isAccountLabel,
} from "./format";

export type ProviderSelectionSource =
	| "environment"
	| "project"
	| "machine_default"
	| "implicit_default";
export type AccountSelectionSource =
	| "environment"
	| "machine_project"
	| "committed_project"
	| "machine_default"
	| "implicit_default";

export interface AccountSelectionRequest {
	/** The canonical checkout path returned by project resolution. */
	readonly checkout: string;
	readonly accounts: AccountsDocument;
	/** The deprecated project.yaml `account:` field, if present. */
	readonly committedAccount?: string;
	readonly environment?: Readonly<{
		KOGEN_BENCH_PROVIDER?: string;
		KOGEN_BENCH_ACCOUNT?: string;
	}>;
}

export interface ResolvedAccountSelection {
	readonly provider: AccountProvider;
	readonly account: string;
	readonly providerSource: ProviderSelectionSource;
	readonly accountSource: AccountSelectionSource;
}

export type AccountSelectionError = Readonly<{
	code: "invalid_provider" | "invalid_account";
	message: string;
}>;

function providerValue(value: string | undefined): AccountProvider | null {
	if (value === "chatgpt" || value === "grok") return value;
	return null;
}

/**
 * Resolve one provider and one label for a run. A run never tries another
 * account after this choice; an injected ChatGPT auth file is resolved by the
 * provider layer and does not change the selected provider/account.
 */
export function resolveAccountSelection(
	request: AccountSelectionRequest,
): Result<ResolvedAccountSelection, AccountSelectionError> {
	const env = request.environment ?? {};
	const requestedProvider = env.KOGEN_BENCH_PROVIDER;
	let provider: AccountProvider;
	let providerSource: ProviderSelectionSource;
	if (requestedProvider !== undefined) {
		const parsedProvider = providerValue(requestedProvider);
		if (parsedProvider === null)
			return {
				ok: false,
				error: {
					code: "invalid_provider",
					message: "KOGEN_BENCH_PROVIDER must be chatgpt or grok.",
				},
			};
		provider = parsedProvider;
		providerSource = "environment";
	} else {
		const project = request.accounts.selection?.projects?.find(
			(row) => row.path === request.checkout,
		);
		if (project !== undefined) {
			provider = project.provider;
			providerSource = "project";
		} else {
			provider = request.accounts.selection?.default ?? "chatgpt";
			providerSource =
				request.accounts.selection?.default === undefined
					? "implicit_default"
					: "machine_default";
		}
	}

	const requestedAccount = env.KOGEN_BENCH_ACCOUNT;
	if (requestedAccount !== undefined && !isAccountLabel(requestedAccount))
		return {
			ok: false,
			error: {
				code: "invalid_account",
				message: "KOGEN_BENCH_ACCOUNT must be a valid account label.",
			},
		};
	if (requestedAccount !== undefined) {
		return {
			ok: true,
			value: {
				provider,
				account: requestedAccount,
				providerSource,
				accountSource: "environment",
			},
		};
	}

	const providerProject = request.accounts[provider]?.projects?.find(
		(row) => row.path === request.checkout,
	);
	if (providerProject !== undefined) {
		return {
			ok: true,
			value: {
				provider,
				account: providerProject.account,
				providerSource,
				accountSource: "machine_project",
			},
		};
	}
	if (provider === "chatgpt" && request.committedAccount !== undefined) {
		if (!isAccountLabel(request.committedAccount))
			return {
				ok: false,
				error: {
					code: "invalid_account",
					message: "The committed ChatGPT account label is invalid.",
				},
			};
		return {
			ok: true,
			value: {
				provider,
				account: request.committedAccount,
				providerSource,
				accountSource: "committed_project",
			},
		};
	}
	const providerDefault = request.accounts[provider]?.default;
	return {
		ok: true,
		value: {
			provider,
			account: providerDefault ?? "default",
			providerSource,
			accountSource:
				providerDefault === undefined ? "implicit_default" : "machine_default",
		},
	};
}
