import { Buffer } from "node:buffer";
import { createPublicKey, verify } from "node:crypto";
import type { Result } from "../../../contracts/errors";

export const CHATGPT_TOKEN_ISSUER = "https://auth.openai.com";

export interface ChatGptIdentity {
	readonly subject: string;
	readonly email: string | null;
}

function invalidToken(): Result<never> {
	return {
		ok: false,
		error: {
			code: "invalid_input",
			message: "ChatGPT identity token could not be verified.",
			retryable: false,
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeBase64Url(segment: string): Uint8Array | null {
	if (segment.length === 0 || !/^[A-Za-z0-9_-]+$/.test(segment)) return null;
	try {
		const bytes = Buffer.from(segment, "base64url");
		return bytes.byteLength > 0 && bytes.toString("base64url") === segment
			? bytes
			: null;
	} catch {
		return null;
	}
}

function decodeJsonSegment(segment: string): unknown | null {
	const bytes = decodeBase64Url(segment);
	if (bytes === null) return null;
	try {
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(bytes),
		) as unknown;
	} catch {
		return null;
	}
}

function jwtSignatureIsValid(
	header: Record<string, unknown>,
	encodedHeader: string,
	encodedClaims: string,
	encodedSignature: string,
	jwks: unknown,
): boolean {
	if (
		header.alg !== "RS256" ||
		header.crit !== undefined ||
		(header.b64 !== undefined && header.b64 !== true)
	)
		return false;
	const signature = decodeBase64Url(encodedSignature);
	if (signature === null || !isRecord(jwks) || !Array.isArray(jwks.keys))
		return false;

	const keyId = header.kid;
	if (keyId !== undefined && (typeof keyId !== "string" || keyId.length === 0))
		return false;
	const candidates = jwks.keys.filter((candidate: unknown) => {
		if (!isRecord(candidate)) return false;
		return (
			candidate.kty === "RSA" &&
			(typeof candidate.alg === "undefined" || candidate.alg === "RS256") &&
			(typeof candidate.use === "undefined" || candidate.use === "sig") &&
			(typeof candidate.key_ops === "undefined" ||
				(Array.isArray(candidate.key_ops) &&
					candidate.key_ops.includes("verify"))) &&
			(typeof keyId === "undefined" || candidate.kid === keyId)
		);
	});
	if (candidates.length !== 1) return false;
	const candidate: unknown = candidates[0];
	if (
		!isRecord(candidate) ||
		typeof candidate.n !== "string" ||
		typeof candidate.e !== "string"
	)
		return false;
	if (
		decodeBase64Url(candidate.n) === null ||
		decodeBase64Url(candidate.e) === null
	)
		return false;

	try {
		const publicKey = createPublicKey({
			key: { kty: "RSA", n: candidate.n, e: candidate.e },
			format: "jwk",
		});
		return (
			publicKey.asymmetricKeyType === "rsa" &&
			verify(
				"RSA-SHA256",
				Buffer.from(`${encodedHeader}.${encodedClaims}`, "ascii"),
				publicKey,
				signature,
			)
		);
	} catch {
		return false;
	}
}

/** Verify the signed identity and the claims bound to this PKCE login attempt. */
export function verifyChatGptIdToken(
	idToken: string,
	options: {
		readonly jwks: unknown;
		readonly clientId: string;
		readonly nonce: string;
		readonly nowUnixSeconds: number;
	},
): Result<ChatGptIdentity> {
	if (
		typeof idToken !== "string" ||
		options.clientId.length === 0 ||
		options.nonce.length === 0 ||
		!Number.isFinite(options.nowUnixSeconds) ||
		options.nowUnixSeconds < 0
	)
		return invalidToken();

	const parts = idToken.split(".");
	if (parts.length !== 3) return invalidToken();
	const encodedHeader = parts[0];
	const encodedClaims = parts[1];
	const encodedSignature = parts[2];
	if (
		encodedHeader === undefined ||
		encodedClaims === undefined ||
		encodedSignature === undefined
	)
		return invalidToken();
	const header = decodeJsonSegment(encodedHeader);
	const claims = decodeJsonSegment(encodedClaims);
	if (
		!isRecord(header) ||
		!isRecord(claims) ||
		!jwtSignatureIsValid(
			header,
			encodedHeader,
			encodedClaims,
			encodedSignature,
			options.jwks,
		)
	)
		return invalidToken();

	const audience = claims.aud;
	const audienceMatches =
		typeof audience === "string"
			? audience === options.clientId
			: Array.isArray(audience) && audience.includes(options.clientId);
	if (
		claims.iss !== CHATGPT_TOKEN_ISSUER ||
		!audienceMatches ||
		typeof claims.exp !== "number" ||
		!Number.isFinite(claims.exp) ||
		claims.exp <= options.nowUnixSeconds ||
		claims.nonce !== options.nonce ||
		typeof claims.sub !== "string" ||
		claims.sub.trim().length === 0 ||
		/[\0\r\n]/u.test(claims.sub) ||
		!(
			claims.email === undefined ||
			claims.email === null ||
			typeof claims.email === "string"
		) ||
		(typeof claims.email === "string" && /[\0\r\n]/u.test(claims.email))
	)
		return invalidToken();

	return {
		ok: true,
		value: {
			subject: claims.sub,
			email: typeof claims.email === "string" ? claims.email : null,
		},
	};
}
