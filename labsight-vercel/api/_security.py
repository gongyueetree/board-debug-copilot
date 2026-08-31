"""LabSight API session guard + lightweight rate limiting.

This is a P0 anti-abuse layer for the public EVT deployment:
- Browser requests receive a short-lived HMAC token from /api/session.
- Protected same-origin API calls carry X-LabSight-Session.
- A per-process sliding-window rate limiter provides best-effort protection.

Important: this is not user identity/authentication. The public LabSight page can mint a
session token by design. It prevents accidental/cross-site invocation and adds a basic
rate-limit barrier. Production user authentication should later sit in front of this.

Server-to-server Shengwang callbacks must use their own dedicated callback secrets and
must not depend on the browser session header.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import time

from fastapi import FastAPI, HTTPException, Request

TOKEN_TTL_SECONDS = 2 * 3600


def session_secret() -> str:
    return os.getenv("LABSIGHT_SESSION_SECRET", "").strip()


def mint_token(ttl: int = TOKEN_TTL_SECONDS) -> str:
    secret = session_secret()
    if not secret:
        return ""
    exp = str(int(time.time()) + max(60, ttl))
    sig = hmac.new(secret.encode(), exp.encode(), hashlib.sha256).hexdigest()
    return f"{exp}.{sig}"


def require_session(request: Request) -> None:
    """Validate X-LabSight-Session; disabled when no secret is configured."""
    secret = session_secret()
    if not secret:
        return
    token = (request.headers.get("x-labsight-session") or "").strip()
    exp_s, _, sig = token.partition(".")
    if not exp_s or not sig:
        raise HTTPException(status_code=401, detail="缺少会话令牌，请刷新页面")
    try:
        exp = int(exp_s)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="会话令牌格式无效，请刷新页面") from exc
    if exp < int(time.time()):
        raise HTTPException(status_code=401, detail="会话令牌已过期，请刷新页面")
    good = hmac.new(secret.encode(), exp_s.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(good, sig):
        raise HTTPException(status_code=401, detail="会话令牌校验失败")


def client_ip(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


_RATE: dict[str, list[float]] = {}


def rate_limit(request: Request, bucket: str, limit: int, window: float = 300.0) -> None:
    """Best-effort per-IP sliding-window limiter for a serverless instance."""
    key = f"{bucket}:{client_ip(request)}"
    now = time.time()
    hits = _RATE.setdefault(key, [])
    hits[:] = [t for t in hits if now - t < window]
    if len(hits) >= limit:
        raise HTTPException(status_code=429, detail="请求过于频繁，请稍后再试")
    hits.append(now)
    if len(_RATE) > 4096:
        for k in list(_RATE)[:1024]:
            _RATE.pop(k, None)


# Vercel treats each api/*.py as an entrypoint. Keep a tiny app so this helper
# remains importable without build-time entrypoint errors.
app = FastAPI(title="LabSight Security Helper", version="0.2.0")


@app.get("/api/_security")
def _noop() -> dict[str, bool]:
    return {"ok": True}
