# Continuum — Python integration (zero dependencies)

Continuum is consumed over a **wire protocol** (see
`GET {issuer}/.well-known/continuum-configuration`), so no Node is required.
This single stdlib-only module covers all three directions.

## 1. Identity — tell Continuum who is logged in

```python
# Flask
from continuum import identity_response

@app.get("/continuum/identity")
def continuum_identity():
    body = identity_response(TENANT_SECRET, session.get("user_id"))
    return (jsonify(body), 200) if body else ("", 401)
```

```python
# Django
def continuum_identity(request):
    body = identity_response(TENANT_SECRET, request.user.id if request.user.is_authenticated else None)
    return JsonResponse(body) if body else HttpResponse(status=401)
```

The page keeps the same one-line script tag with
`data-identity-url="/continuum/identity"`. The token is a **standard HS256
JWT** `{sub, exp}` signed with your tenant secret — PyJWT or any JWT library
produces the identical token if you prefer.

## 2. Enforce verdicts on sensitive actions

```python
from continuum import require_trusted

JWKS = "https://continuum.example.com/.well-known/jwks.json"

@app.post("/transfer")
def transfer():
    ok, result = require_trusted(request.headers.get("X-Continuum-Risk"), JWKS)
    if not ok:
        return jsonify(error=result), 403 if result == "step_up_required" else 401
    ...  # result is the verified claims (result["sub"], result["risk"])
```

`require_verified(token, JWKS)` is the same but answers `(False, "verdict_pending")` for a `warmup` verdict (not
judged yet: keep typing or moving, no passkey needed); use it on actions that must never run before a real verdict.
Only a verdict passes `verify_token`: an identity assertion or a pushed event is refused (`not_a_verdict`), and so is
a token without an expiry (`no_expiry`).

## 3. Receive pushed risk events (CAEP)

```python
from continuum import verify_event

@app.post("/continuum/events")
def continuum_events():
    try:
        claims = verify_event(request.get_data(as_text=True), JWKS)  # raises on tamper, on a stale event
    except ValueError as e:
        return "", 202 if str(e) == "stale" else 400          # 202 stops the gateway's retries
    if claims["event"] == "test":
        return "", 202
    # apply each claims["jti"] once, and ignore an event older (claims["iat"]) than the last one applied for the
    # same claims["sub"]: deliveries are retried for hours and may arrive out of order
    if claims.get("risk") == "suspicious":
        revoke_sessions(claims["sub"])   # sub is YOUR user id
    return "", 202
```

Verification uses the issuer's **public** JWKS — no shared secret leaves your
backend, and the RS256 check is implemented with the stdlib (RSASSA-PKCS1-v1_5).
