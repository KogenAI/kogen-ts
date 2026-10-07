"""Minimal RS256 signing for the fake OAuth server (standard library only).

The key pair is generated once per runner process; it never leaves the process and
signs only fake id_tokens for the conformance suite.
"""

import base64
import hashlib
import json
import random
import threading

_LOCK = threading.Lock()
_KEY = None
KID = "kogen-conformance-1"

# DER prefix of DigestInfo for SHA-256 (RFC 8017 §9.2).
_SHA256_PREFIX = bytes.fromhex("3031300d060960864801650304020105000420")


def _is_probable_prime(n, rng, rounds=40):
    if n < 2:
        return False
    small = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37]
    for p in small:
        if n % p == 0:
            return n == p
    d, s = n - 1, 0
    while d % 2 == 0:
        d //= 2
        s += 1
    for _ in range(rounds):
        a = rng.randrange(2, n - 2)
        x = pow(a, d, n)
        if x in (1, n - 1):
            continue
        for _ in range(s - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True


def _prime(bits, rng):
    while True:
        candidate = rng.getrandbits(bits) | (1 << (bits - 1)) | (1 << (bits - 2)) | 1
        if _is_probable_prime(candidate, rng):
            return candidate


def key():
    """Return (n, e, d), generating a 2048-bit key on first use."""
    global _KEY
    with _LOCK:
        if _KEY is None:
            rng = random.SystemRandom()
            e = 65537
            while True:
                p = _prime(1024, rng)
                q = _prime(1024, rng)
                if p == q:
                    continue
                phi = (p - 1) * (q - 1)
                try:
                    d = pow(e, -1, phi)
                except ValueError:
                    continue
                n = p * q
                if n.bit_length() == 2048:
                    _KEY = (n, e, d)
                    break
        return _KEY


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _int_bytes(value):
    return value.to_bytes((value.bit_length() + 7) // 8, "big")


def jwk():
    n, e, _d = key()
    return {"kty": "RSA", "kid": KID, "alg": "RS256", "use": "sig", "n": b64url(_int_bytes(n)), "e": b64url(_int_bytes(e))}


def sign_rs256(signing_input):
    n, _e, d = key()
    k = (n.bit_length() + 7) // 8
    t = _SHA256_PREFIX + hashlib.sha256(signing_input).digest()
    em = b"\x00\x01" + b"\xff" * (k - len(t) - 3) + b"\x00" + t
    sig = pow(int.from_bytes(em, "big"), d, n)
    return sig.to_bytes(k, "big")


def jwt_rs256(claims):
    header = {"alg": "RS256", "typ": "JWT", "kid": KID}
    signing_input = (b64url(json.dumps(header, separators=(",", ":")).encode()) + "." +
                     b64url(json.dumps(claims, separators=(",", ":")).encode())).encode("ascii")
    return signing_input.decode("ascii") + "." + b64url(sign_rs256(signing_input))


def jwt_unsigned(claims):
    """A JWT whose signature is not checked (injected auth, §4.6)."""
    header = {"alg": "none", "typ": "JWT"}
    return (b64url(json.dumps(header, separators=(",", ":")).encode()) + "." +
            b64url(json.dumps(claims, separators=(",", ":")).encode()) + "." + b64url(b"unsigned"))
