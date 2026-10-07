import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import {
	CHATGPT_TOKEN_ISSUER,
	verifyChatGptIdToken,
} from "../../packages/core/src/provider/auth/chatgpt/jwks";

const CLIENT_ID = "registered-client-test";
const NONCE = "nonce-for-the-login-attempt";
const NOW = 1_800_000_000;
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = keys.publicKey.export({ format: "jwk" });
const jwks = {
	keys: [
		{
			kty: "RSA",
			kid: "current-key",
			alg: "RS256",
			use: "sig",
			n: jwk.n,
			e: jwk.e,
		},
	],
};

function token(
	claims: Record<string, unknown> = {},
	header: Record<string, unknown> = {},
): string {
	const encodedHeader = Buffer.from(
		JSON.stringify({ alg: "RS256", kid: "current-key", ...header }),
	).toString("base64url");
	const encodedClaims = Buffer.from(
		JSON.stringify({
			iss: CHATGPT_TOKEN_ISSUER,
			aud: ["another-client", CLIENT_ID],
			exp: NOW + 30,
			nonce: NONCE,
			sub: "subject-1",
			email: "person@example.test",
			...claims,
		}),
	).toString("base64url");
	const signature = sign(
		"RSA-SHA256",
		Buffer.from(`${encodedHeader}.${encodedClaims}`, "ascii"),
		keys.privateKey,
	).toString("base64url");
	return `${encodedHeader}.${encodedClaims}.${signature}`;
}

function verify(value: string, keySet: unknown = jwks) {
	return verifyChatGptIdToken(value, {
		jwks: keySet,
		clientId: CLIENT_ID,
		nonce: NONCE,
		nowUnixSeconds: NOW,
	});
}

test("verifies RS256 signature and returns subject and optional email", () => {
	expect(verify(token())).toEqual({
		ok: true,
		value: { subject: "subject-1", email: "person@example.test" },
	});
	const withoutEmail = verify(token({ email: undefined }));
	expect(withoutEmail).toEqual({
		ok: true,
		value: { subject: "subject-1", email: null },
	});
});

test("rejects non-RS256, bad signatures and ambiguous or unusable JWKS keys", () => {
	expect(verify(token({}, { alg: "HS256" })).ok).toBe(false);

	const changed = token().split(".");
	const originalSignature = changed[2] ?? "";
	const replacement = originalSignature.startsWith("A") ? "B" : "A";
	changed[2] = `${replacement}${originalSignature.slice(1)}`;
	expect(verify(changed.join(".")).ok).toBe(false);

	expect(verify(token(), { keys: [jwks.keys[0], jwks.keys[0]] }).ok).toBe(
		false,
	);
	expect(
		verify(token(), {
			keys: [{ ...jwks.keys[0], use: "enc" }],
		}).ok,
	).toBe(false);
});

test("checks issuer, audience, expiry, nonce, and non-empty subject", () => {
	for (const claims of [
		{ iss: "https://issuer.attacker.invalid" },
		{ aud: ["other-client"] },
		{ aud: CLIENT_ID, exp: NOW },
		{ nonce: "another-login" },
		{ sub: "  " },
	])
		expect(verify(token(claims)).ok).toBe(false);

	expect(verify(token({ aud: CLIENT_ID })).ok).toBe(true);
});
