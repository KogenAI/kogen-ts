import type { Result } from "../../contracts/errors";
import type { AccountProvider } from "../accounts/format";
import type { SessionAuthMode } from "../session/transition";

export const CHATGPT_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
export const LITE_UNSUPPORTED_MESSAGE =
	"Unsupported adapter or model-generation cap for this backend.";
export const MODEL_GENERATION_CAP_UNSUPPORTED_MESSAGE =
	"Model-generation cap is unsupported on this endpoint/adapter.";

export type ChatGptAdapterMode = "responses" | "lite";

/** Endpoint capability declarations are scoped to the exact endpoint URL. */
export interface EndpointCapabilities {
	readonly endpoint: string;
	readonly modelGenerationTokens?: boolean;
}

export interface ChatGptRequestPolicy {
	readonly mode: ChatGptAdapterMode;
	readonly provider: AccountProvider;
	readonly authMode: SessionAuthMode;
	readonly model: string;
	readonly endpoint: string;
	readonly modelGenerationTokens?: number;
	readonly endpointCapabilities?: EndpointCapabilities;
}

export interface AdapterCompatibilityError {
	readonly class: "unsupported";
	readonly message: string;
}

function unsupported(message: string): AdapterCompatibilityError {
	return Object.freeze({ class: "unsupported", message });
}

function hasGenerationCapCapability(
	endpoint: string,
	capabilities: EndpointCapabilities | undefined,
): boolean {
	if (endpoint === CHATGPT_RESPONSES_ENDPOINT) return true;
	return (
		capabilities?.endpoint === endpoint &&
		capabilities.modelGenerationTokens === true
	);
}

/**
 * Validate adapter/model/endpoint compatibility before any credential or HTTP
 * effect. Unknown endpoints have no capabilities unless an exact-URL
 * declaration explicitly enables the requested capability.
 */
export function validateChatGptRequestPolicy(
	policy: ChatGptRequestPolicy,
): Result<void, AdapterCompatibilityError> {
	if (policy.mode !== "responses" && policy.mode !== "lite")
		throw new TypeError("ChatGPT adapter mode is invalid.");
	if (policy.provider !== "chatgpt" && policy.provider !== "grok")
		throw new TypeError("ChatGPT provider is invalid.");
	if (policy.authMode !== "owned" && policy.authMode !== "injected")
		throw new TypeError("ChatGPT auth mode is invalid.");
	if (typeof policy.endpoint !== "string" || policy.endpoint.length === 0)
		throw new TypeError("ChatGPT endpoint is invalid.");
	if (
		policy.modelGenerationTokens !== undefined &&
		(!Number.isSafeInteger(policy.modelGenerationTokens) ||
			policy.modelGenerationTokens < 1 ||
			policy.modelGenerationTokens > 100_000)
	)
		throw new TypeError(
			"modelGenerationTokens is outside its supported range.",
		);

	if (
		policy.mode === "lite" &&
		(policy.provider !== "chatgpt" ||
			policy.authMode !== "injected" ||
			policy.model !== "gpt-6-luna" ||
			policy.modelGenerationTokens !== undefined)
	)
		return { ok: false, error: unsupported(LITE_UNSUPPORTED_MESSAGE) };

	if (
		policy.modelGenerationTokens !== undefined &&
		!hasGenerationCapCapability(policy.endpoint, policy.endpointCapabilities)
	)
		return {
			ok: false,
			error: unsupported(MODEL_GENERATION_CAP_UNSUPPORTED_MESSAGE),
		};

	return { ok: true, value: undefined };
}

/**
 * Credential reads must go through this gate so unsupported requests are
 * rejected before touching the credential store.
 */
export async function loadCredentialsAfterCompatibilityCheck<
	Credential,
	CredentialError,
>(
	policy: ChatGptRequestPolicy,
	load: () => Promise<Result<Credential, CredentialError>>,
): Promise<Result<Credential, CredentialError | AdapterCompatibilityError>> {
	const compatible = validateChatGptRequestPolicy(policy);
	if (!compatible.ok) return compatible;
	return load();
}
