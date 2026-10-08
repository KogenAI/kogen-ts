import type { ClockPort } from "../../core/src/contracts/clock";
import type {
	CredentialPort,
	HttpPort,
	HttpRequest,
	RandomPort,
} from "../../core/src/contracts/ports";
import { CHATGPT_CREDENTIAL_KEY } from "../../core/src/provider/auth/chatgpt/login";
import {
	parseSavedChatGptCredential,
	sendChatGptAuthenticatedRequest,
} from "../../core/src/provider/auth/chatgpt/refresh";
import type { InjectedAuthReader } from "../../core/src/provider/auth/injected";
import {
	createHttpDeadline,
	HttpDeadlineError,
} from "../../core/src/provider/http/deadline";
import {
	HTTP_DEADLINE_DEFAULTS,
	resolveProviderEndpoint,
} from "../../core/src/provider/http/transport";
import type {
	ProviderAttemptResult,
	SendProviderAttempt,
} from "../../core/src/provider/retry/respond";
import { assembleResponses } from "../../core/src/provider/sse/assemble";
import { SseFramer } from "../../core/src/provider/sse/framing";
import { FileChatGptRefreshLocks } from "./refresh-lock";

const CHATGPT_OWNED_ENDPOINT = "https://api.openai.com/v1/responses";
const CHATGPT_INJECTED_ENDPOINT =
	"https://chatgpt.com/backend-api/codex/responses";

function stopped(
	className:
		| "login"
		| "timeout"
		| "transport"
		| "malformed"
		| "overload"
		| "usage_limit",
	message: string,
): ProviderAttemptResult {
	return { ok: false, error: { class: className, message } };
}

function transportFailure(cause: unknown): ProviderAttemptResult {
	if (cause instanceof HttpDeadlineError)
		return stopped("timeout", "Provider request timed out.");
	return stopped("transport", "Provider request could not connect.");
}

/** Production injected ChatGPT attempt: auth loading, HTTP, and SSE share one deadline. */
export function createInjectedChatGptAttemptSender(options: {
	readonly http: HttpPort;
	readonly auth: InjectedAuthReader;
	readonly clock: ClockPort;
	readonly version: string;
	readonly testEndpointOverride?: string;
}): SendProviderAttempt {
	const endpoint = resolveProviderEndpoint(
		CHATGPT_INJECTED_ENDPOINT,
		options.testEndpointOverride,
	);
	return async ({ request, session, signal }) => {
		if (session.provider !== "chatgpt" || session.authMode !== "injected")
			return stopped(
				"malformed",
				"ChatGPT request has the wrong session mode.",
			);
		const deadline = createHttpDeadline(
			options.clock,
			HTTP_DEADLINE_DEFAULTS,
			signal,
		);
		const auth = await options.auth();
		if (deadline.error) {
			deadline.complete();
			return stopped("timeout", "Provider request timed out.");
		}
		if (!auth.ok) {
			deadline.complete();
			return stopped("login", auth.error.message);
		}
		const httpRequest: HttpRequest = {
			method: "POST",
			url: endpoint,
			headers: request.headers,
			body: request.body.slice(),
			...HTTP_DEADLINE_DEFAULTS,
		};
		const sent = await sendChatGptAuthenticatedRequest({
			http: options.http,
			request: httpRequest,
			auth: {
				source: "injected",
				accessToken: auth.value.accessToken,
				accountId: auth.value.accountId,
			},
			version: options.version,
			signal: deadline.signal,
		});
		if (!sent.ok) {
			const error = deadline.error;
			deadline.complete();
			if (error) return transportFailure(error);
			if (sent.error.kind === "provider_login")
				return stopped("login", sent.error.message);
			return transportFailure(sent.error.error.cause);
		}
		const response = sent.value;
		if (response.status !== 200) {
			deadline.complete();
			if (response.status === 429)
				return stopped("usage_limit", "Provider usage limit reached.");
			if (response.status >= 500)
				return stopped("overload", "Provider service is overloaded.");
			return stopped(
				"malformed",
				`Provider rejected the request (HTTP ${response.status}).`,
			);
		}
		const framer = new SseFramer();
		const frames = [];
		try {
			for await (const chunk of response.body)
				frames.push(...framer.push(chunk));
			frames.push(...framer.finish());
		} catch (cause) {
			const error = deadline.error;
			deadline.complete();
			return error ? transportFailure(error) : transportFailure(cause);
		}
		deadline.complete();
		const assembled = assembleResponses(frames);
		return assembled.ok
			? { ok: true, response: assembled }
			: {
					ok: false,
					error: {
						class: assembled.class,
						message: assembled.message,
						partialItemJson: assembled.raw_item_json,
						usage: assembled.usage,
					},
				};
	};
}

export { CHATGPT_OWNED_ENDPOINT, CHATGPT_INJECTED_ENDPOINT };

/** Owned Build attempts reread the selected account and include refresh and replay in the deadline. */
export function createOwnedChatGptAttemptSender(options: {
	readonly http: HttpPort;
	readonly credentials: CredentialPort;
	readonly random: RandomPort;
	readonly clock: ClockPort;
	readonly homeDirectory: string;
	readonly label: string;
	readonly version: string;
	readonly testEndpointOverride?: string;
	readonly testAuthUrl?: string;
	readonly timeScale?: number;
}): SendProviderAttempt {
	const endpoint = resolveProviderEndpoint(
		CHATGPT_OWNED_ENDPOINT,
		options.testEndpointOverride,
	);
	const locks = new FileChatGptRefreshLocks();
	return async ({ request, session, signal }) => {
		if (session.provider !== "chatgpt" || session.authMode !== "owned")
			return stopped(
				"malformed",
				"ChatGPT request has the wrong session mode.",
			);
		const deadline = createHttpDeadline(
			options.clock,
			HTTP_DEADLINE_DEFAULTS,
			signal,
		);
		const saved = await options.credentials.read({
			...CHATGPT_CREDENTIAL_KEY,
			account: options.label,
		});
		if (deadline.error) {
			deadline.complete();
			return stopped("timeout", "Provider request timed out.");
		}
		if (!saved.ok) {
			deadline.complete();
			return stopped(
				"login",
				"ChatGPT login is missing or invalid; run `kogen provider login chatgpt`.",
			);
		}
		const credential = parseSavedChatGptCredential(saved.value);
		if (credential === null) {
			deadline.complete();
			return stopped(
				"login",
				"ChatGPT login is missing or invalid; run `kogen provider login chatgpt`.",
			);
		}
		const sent = await sendChatGptAuthenticatedRequest({
			http: options.http,
			request: {
				method: "POST",
				url: endpoint,
				headers: request.headers,
				body: request.body.slice(),
				...HTTP_DEADLINE_DEFAULTS,
			},
			auth: { source: "owned", credential },
			refresh: {
				credentials: options.credentials,
				locks,
				http: options.http,
				random: options.random,
				clock: options.clock,
				homeDirectory: options.homeDirectory,
				label: options.label,
				...(options.testAuthUrl === undefined
					? {}
					: { authUrl: options.testAuthUrl }),
				...(options.timeScale === undefined
					? {}
					: { timeScale: options.timeScale }),
			},
			version: options.version,
			signal: deadline.signal,
		});
		if (!sent.ok) {
			const error = deadline.error;
			deadline.complete();
			if (error) return transportFailure(error);
			if (sent.error.kind === "provider_login")
				return stopped("login", sent.error.message);
			return sent.error.error.code === "timeout"
				? stopped("timeout", sent.error.error.message)
				: transportFailure(sent.error.error.cause);
		}
		const response = sent.value;
		if (response.status !== 200) {
			deadline.complete();
			if (response.status === 429)
				return stopped("usage_limit", "Provider usage limit reached.");
			if (response.status >= 500)
				return stopped("overload", "Provider service is overloaded.");
			return stopped(
				"malformed",
				`Provider rejected the request (HTTP ${response.status}).`,
			);
		}
		const framer = new SseFramer();
		const frames = [];
		try {
			for await (const chunk of response.body)
				frames.push(...framer.push(chunk));
			frames.push(...framer.finish());
		} catch (cause) {
			const error = deadline.error;
			deadline.complete();
			return error ? transportFailure(error) : transportFailure(cause);
		}
		deadline.complete();
		const assembled = assembleResponses(frames);
		return assembled.ok
			? { ok: true, response: assembled }
			: {
					ok: false,
					error: {
						class: assembled.class,
						message: assembled.message,
						partialItemJson: assembled.raw_item_json,
						usage: assembled.usage,
					},
				};
	};
}
