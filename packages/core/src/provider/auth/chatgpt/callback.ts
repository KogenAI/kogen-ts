import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { PortError, Result } from "../../../contracts/errors";

export const CHATGPT_LOOPBACK_HOST = "127.0.0.1";
export const CHATGPT_LOOPBACK_PORT = 1455;
export const CHATGPT_CALLBACK_PATH = "/auth/callback";
export const CHATGPT_CALLBACK_URL = `http://${CHATGPT_LOOPBACK_HOST}:${CHATGPT_LOOPBACK_PORT}${CHATGPT_CALLBACK_PATH}`;
export const CHATGPT_LOGIN_TIMEOUT_MILLISECONDS = 300_000;
export const CHATGPT_CALLBACK_SUCCESS_TEXT =
	"Kogen sign-in complete. You can close this tab.";
export const CHATGPT_CALLBACK_FAILURE_TEXT =
	"Kogen could not verify this sign-in callback.";

export interface ChatGptOAuthCallback {
	readonly code: string | null;
	readonly state: string;
	readonly clientId: string | null;
	readonly oauthError: string | null;
}

export interface ChatGptCallbackListener {
	readonly result: Promise<Result<ChatGptOAuthCallback>>;
	close(): Promise<void>;
}

export interface ChatGptCallbackOptions {
	readonly expectedState: string;
	readonly timeoutMilliseconds?: number;
	/** Port 1455 is fixed in production; override it only in an isolated test. */
	readonly port?: number;
}

function error(
	code: PortError["code"],
	message: string,
	retryable = false,
): PortError {
	return { code, message, retryable };
}

function equalState(actual: string, expected: string): boolean {
	const actualBytes = Buffer.from(actual, "utf8");
	const expectedBytes = Buffer.from(expected, "utf8");
	return (
		actualBytes.byteLength === expectedBytes.byteLength &&
		timingSafeEqual(actualBytes, expectedBytes)
	);
}

function singleParameter(url: URL, name: string): string | null {
	const values = url.searchParams.getAll(name);
	return values.length === 1 ? (values[0] ?? null) : null;
}

function sendText(
	response: import("node:http").ServerResponse,
	status: number,
	text: string,
): void {
	const body = Buffer.from(text, "utf8");
	response.writeHead(status, {
		"Cache-Control": "no-store",
		"Content-Length": String(body.byteLength),
		"Content-Type": "text/plain; charset=utf-8",
	});
	response.end(body);
}

function closeServer(server: Server): Promise<void> {
	if (!server.listening) return Promise.resolve();
	return new Promise((resolve, reject) => {
		server.close((cause) => {
			if (cause) reject(cause);
			else resolve();
		});
	});
}

/**
 * Bind the fixed loopback callback before opening a browser. Node/Bun set
 * SO_REUSEADDR for TCP listeners on supported Unix hosts, allowing a later
 * login to bind after the first connection enters TIME_WAIT. SO_REUSEPORT is
 * deliberately not enabled: concurrent login listeners must not share the
 * callback port.
 */
export async function listenForChatGptCallback(
	options: ChatGptCallbackOptions,
): Promise<Result<ChatGptCallbackListener>> {
	const timeoutMilliseconds =
		options.timeoutMilliseconds ?? CHATGPT_LOGIN_TIMEOUT_MILLISECONDS;
	const port = options.port ?? CHATGPT_LOOPBACK_PORT;
	if (
		options.expectedState.length === 0 ||
		!/^[A-Za-z0-9_-]+$/.test(options.expectedState) ||
		!Number.isSafeInteger(timeoutMilliseconds) ||
		timeoutMilliseconds <= 0 ||
		!Number.isSafeInteger(port) ||
		port < 0 ||
		port > 65_535
	)
		return {
			ok: false,
			error: error("invalid_input", "ChatGPT callback settings are invalid."),
		};

	let settleResult: (result: Result<ChatGptOAuthCallback>) => void = () => {};
	let settled = false;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const server = createServer((request, response) => {
		if (settled) {
			sendText(response, 410, CHATGPT_CALLBACK_FAILURE_TEXT);
			return;
		}
		let url: URL;
		try {
			url = new URL(request.url ?? "/", CHATGPT_CALLBACK_URL);
		} catch {
			sendText(response, 400, CHATGPT_CALLBACK_FAILURE_TEXT);
			return;
		}
		if (request.method !== "GET" || url.pathname !== CHATGPT_CALLBACK_PATH) {
			sendText(response, 404, "Not found.");
			return;
		}

		const state = singleParameter(url, "state");
		const code = singleParameter(url, "code");
		const clientIdValues = url.searchParams.getAll("client_id");
		const clientId =
			clientIdValues.length === 0 ? null : (clientIdValues[0] ?? null);
		const oauthErrorValues = url.searchParams.getAll("error");
		const oauthErrorDescriptionValues =
			url.searchParams.getAll("error_description");
		const oauthError = singleParameter(url, "error");
		const oauthErrorDescription = singleParameter(url, "error_description");
		const validClientId =
			clientIdValues.length === 0 ||
			(clientIdValues.length === 1 &&
				clientId !== null &&
				clientId.length > 0 &&
				!/[\0\r\n]/u.test(clientId));
		const stateMatches =
			state !== null && equalState(state, options.expectedState);
		const validCode =
			code !== null && code.length > 0 && !/[\0\r\n]/u.test(code);
		const validOAuthError =
			oauthErrorValues.length === 1 &&
			oauthErrorDescriptionValues.length <= 1 &&
			oauthError !== null &&
			/^[A-Za-z0-9_.-]{1,128}$/.test(oauthError) &&
			(oauthErrorDescription === null ||
				(oauthErrorDescription.length <= 2048 &&
					!/[\0\r\n]/u.test(oauthErrorDescription)));
		if (
			!stateMatches ||
			!validClientId ||
			(validCode &&
				(oauthErrorValues.length > 0 ||
					oauthErrorDescriptionValues.length > 0)) ||
			(!validCode && !validOAuthError) ||
			(code !== null && !validCode)
		) {
			sendText(response, 400, CHATGPT_CALLBACK_FAILURE_TEXT);
			finish({
				ok: false,
				error: error(
					"invalid_input",
					"ChatGPT callback could not be verified.",
				),
			});
			return;
		}
		if (validOAuthError) {
			response.writeHead(200, {
				"Cache-Control": "no-store",
				"Content-Length": String(
					Buffer.byteLength(CHATGPT_CALLBACK_FAILURE_TEXT, "utf8"),
				),
				"Content-Type": "text/plain; charset=utf-8",
			});
			response.end(CHATGPT_CALLBACK_FAILURE_TEXT, () => {
				finish({
					ok: true,
					value: {
						code: null,
						state: state as string,
						clientId,
						oauthError,
					},
				});
			});
			return;
		}

		response.writeHead(200, {
			"Cache-Control": "no-store",
			"Content-Length": String(
				Buffer.byteLength(CHATGPT_CALLBACK_SUCCESS_TEXT, "utf8"),
			),
			"Content-Type": "text/plain; charset=utf-8",
		});
		response.end(CHATGPT_CALLBACK_SUCCESS_TEXT, () => {
			finish({
				ok: true,
				value: {
					code: code as string,
					state: state as string,
					clientId,
					oauthError: null,
				},
			});
		});
	});

	const result = new Promise<Result<ChatGptOAuthCallback>>((resolve) => {
		settleResult = resolve;
	});
	const finish = (value: Result<ChatGptOAuthCallback>): void => {
		if (settled) return;
		settled = true;
		if (timeout !== undefined) clearTimeout(timeout);
		settleResult(value);
		void closeServer(server).catch(() => {});
	};
	server.on("error", (cause: NodeJS.ErrnoException) => {
		if (settled) return;
		finish({
			ok: false,
			error:
				cause.code === "EADDRINUSE"
					? error("conflict", "ChatGPT callback port 1455 is already in use.")
					: error("unavailable", "ChatGPT callback listener failed.", true),
		});
	});

	const started = await new Promise<boolean>((resolve) => {
		const onListening = (): void => {
			server.off("error", onStartError);
			resolve(true);
		};
		const onStartError = (): void => {
			server.off("listening", onListening);
			resolve(false);
		};
		server.once("listening", onListening);
		server.once("error", onStartError);
		server.listen({ host: CHATGPT_LOOPBACK_HOST, port, exclusive: true });
	});
	if (!started) {
		const addressError = error(
			"conflict",
			"ChatGPT callback port 1455 is already in use.",
		);
		return { ok: false, error: addressError };
	}
	timeout = setTimeout(() => {
		finish({
			ok: false,
			error: error("timeout", "ChatGPT sign-in callback timed out.", true),
		});
	}, timeoutMilliseconds);

	return {
		ok: true,
		value: {
			result,
			async close() {
				finish({
					ok: false,
					error: error("cancelled", "ChatGPT sign-in callback was cancelled."),
				});
				await closeServer(server).catch(() => {});
			},
		},
	};
}
