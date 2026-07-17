"""Continuum — Python reference integration (standard library only, zero deps).

Continuum's consumer contract is a wire protocol, not an SDK:
  * identity   : you mint a standard HS256 JWT {sub, exp} with your tenant secret
                 (client_secret_jwt) — `sub` is YOUR user id.
  * verdicts   : Continuum signs risk tokens as RS256 JWTs; you verify them with
                 the PUBLIC key from GET {issuer}/.well-known/jwks.json.
  * push (CAEP): risk-change Security Event Tokens are RS256 too — same JWKS.

This module implements all three directions with nothing but the stdlib
(hmac/hashlib for HS256, textbook RSASSA-PKCS1-v1_5 verification for RS256),
so it runs identically under Flask, Django, FastAPI, or raw WSGI.
Everything here matches {issuer}/.well-known/continuum-configuration.
"""
import base64
import hashlib
import hmac
import json
import time
import urllib.request

__all__ = ["sign_identity", "identity_response", "verify_token", "require_trusted"]


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64url_dec(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


# ---------------------------------------------------------------- identity ----
def sign_identity(secret: str, user_id, ttl_sec: int = 300) -> str:
    """Vouch for YOUR logged-in user: a standard HS256 JWT {sub, exp} signed with
    the tenant secret. Hand it to the SDK (Continuum.identify / data-identity-url)
    or to POST /v1/resolve."""
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = _b64url(json.dumps({"sub": str(user_id), "exp": int(time.time()) + ttl_sec},
                                 separators=(",", ":")).encode())
    data = f"{header}.{payload}"
    sig = _b64url(hmac.new(secret.encode(), data.encode(), hashlib.sha256).digest())
    return f"{data}.{sig}"


def identity_response(secret: str, user_id):
    """The GET /continuum/identity response body ({"token": ...}) or None when the
    user isn't logged in — return 401 in that case. Framework-agnostic:
        Flask   : return jsonify(identity_response(SECRET, session.get("user_id")))
        Django  : JsonResponse(identity_response(SECRET, request.user.id))
        FastAPI : return identity_response(SECRET, user.id)
    """
    if user_id in (None, ""):
        return None
    return {"token": sign_identity(secret, user_id)}


# ------------------------------------------------------- verdict / SET side ----
_jwks_cache: dict = {}


def _fetch_jwks(jwks_uri: str, max_age: float = 300.0) -> dict:
    cached = _jwks_cache.get(jwks_uri)
    if cached and time.time() - cached[0] < max_age:
        return cached[1]
    with urllib.request.urlopen(jwks_uri, timeout=10) as r:
        keys = {k.get("kid", "_"): k for k in json.load(r).get("keys", [])}
    _jwks_cache[jwks_uri] = (time.time(), keys)
    return keys


def _rsa_pkcs1_sha256_verify(n: int, e: int, sig: bytes, data: bytes) -> bool:
    """Textbook RSASSA-PKCS1-v1_5 / SHA-256 verification (RFC 8017) — public-key
    math only (pow(sig, e, n)), so the stdlib suffices."""
    k = (n.bit_length() + 7) // 8
    if len(sig) != k:
        return False
    em = pow(int.from_bytes(sig, "big"), e, n).to_bytes(k, "big")
    digest_info = bytes.fromhex("3031300d060960864801650304020105000420")  # DER SHA-256 prefix
    digest = hashlib.sha256(data).digest()
    expected = b"\x00\x01" + b"\xff" * (k - len(digest_info) - len(digest) - 3) + b"\x00" + digest_info + digest
    return hmac.compare_digest(em, expected)


def verify_token(token: str, jwks_uri: str, clock_skew_sec: int = 5) -> dict:
    """Verify an RS256 Continuum token — a risk verdict (X-Continuum-Risk) or a
    pushed CAEP SET — against the issuer's JWKS. Returns the claims dict;
    raises ValueError on any failure."""
    try:
        h64, p64, s64 = token.split(".")
    except ValueError:
        raise ValueError("malformed")
    header = json.loads(_b64url_dec(h64))
    if header.get("alg") != "RS256":
        raise ValueError("unexpected alg")
    keys = _fetch_jwks(jwks_uri)
    jwk = keys.get(header.get("kid")) or (next(iter(keys.values())) if keys else None)
    if not jwk:
        raise ValueError("unknown kid")
    n = int.from_bytes(_b64url_dec(jwk["n"]), "big")
    e = int.from_bytes(_b64url_dec(jwk["e"]), "big")
    if not _rsa_pkcs1_sha256_verify(n, e, _b64url_dec(s64), f"{h64}.{p64}".encode()):
        raise ValueError("bad signature")
    claims = json.loads(_b64url_dec(p64))
    if claims.get("exp") and time.time() > claims["exp"] + clock_skew_sec:
        raise ValueError("expired")
    return claims


def require_trusted(token, jwks_uri: str, block_warmup: bool = False):
    """Enforcement helper for sensitive actions. Returns (ok, result):
    ok=True  -> result is the verified claims (risk == genuine, or warmup allowed)
    ok=False -> result is a short reason ("missing_token", "bad signature",
                "step_up_required", ...) — respond 401/403 accordingly."""
    if not token:
        return False, "missing_token"
    try:
        claims = verify_token(token, jwks_uri)
    except ValueError as exc:
        return False, str(exc)
    risk = claims.get("risk")
    if risk == "suspicious" or (block_warmup and risk == "warmup"):
        return False, "step_up_required"
    return True, claims
