import type { PortError, Result } from "../../../contracts/errors";
import type { CredentialPort, FileSystemPort } from "../../../contracts/ports";
import { isAccountLabel } from "../../accounts/format";
import {
	readProfilesFile,
	withAccountProfile,
	writeProfilesFile,
} from "../../accounts/profiles";
import { GROK_CREDENTIAL_KEY, type GrokAuthResult } from "./login";

export interface GrokLogoutOptions {
	readonly credentials: CredentialPort;
	readonly filesystem: Pick<FileSystemPort, "readFile" | "writeFileAtomically">;
	readonly homeDirectory: string;
	readonly label: string;
}

export interface GrokLogoutOutcome {
	readonly localCredentialRemoved: boolean;
}

function portFailure<Value = never>(error: PortError): GrokAuthResult<Value> {
	return { ok: false, error: { kind: "port", error } };
}

function loginFailure(message: string): GrokAuthResult<never> {
	return { ok: false, error: { kind: "provider_login", message } };
}

/** Grok logout is local-only; it never makes an OAuth revocation request. */
export async function logoutGrok(
	options: GrokLogoutOptions,
): Promise<GrokAuthResult<GrokLogoutOutcome>> {
	if (!isAccountLabel(options.label))
		return loginFailure("Invalid Grok account label.");
	let removed: Result<void>;
	try {
		removed = await options.credentials.remove({
			...GROK_CREDENTIAL_KEY,
			account: options.label,
		});
	} catch (cause) {
		removed = {
			ok: false,
			error: {
				code: "io",
				message: "Could not remove the saved Grok credential.",
				retryable: true,
				cause,
			},
		};
	}
	if (!removed.ok && removed.error.code !== "not_found")
		return portFailure(removed.error);
	const profiles = await readProfilesFile(
		options.filesystem,
		options.homeDirectory,
	);
	if (!profiles.ok) return portFailure(profiles.error);
	const previousProfile = profiles.value.grok[options.label];
	const signedOut = withAccountProfile(profiles.value, "grok", options.label, {
		email: previousProfile?.email ?? null,
		expires_at: previousProfile?.expires_at ?? null,
		signed_in: false,
	});
	const profileWrite = await writeProfilesFile(
		options.filesystem,
		options.homeDirectory,
		signedOut,
	);
	if (!profileWrite.ok) return portFailure(profileWrite.error);
	return {
		ok: true,
		value: { localCredentialRemoved: removed.ok },
	};
}
