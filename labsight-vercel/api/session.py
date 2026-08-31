"""Issue short-lived LabSight browser session tokens.

The endpoint is intentionally lightweight and only mints tokens for the configured
LabSight production/preview hosts. This is an EVT anti-abuse/session guard, not end-user
identity authentication.
"""
from __future__ import annotations

import os
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request

from api._security import TOKEN_TTL_SECONDS, mint_token, rate_limit, session_secret

app = FastAPI(title="LabSight Session", version="0.2.0")


def _allowed_hosts() -> set[str]:
    hosts: set[str] = {"localhost", "127.0.0.1"}
    for name in (
        "LABSIGHT_PUBLIC_BASE_URL",
        "VERCEL_PROJECT_PRODUCTION_URL",
        "VERCEL_URL",
        "VERCEL_BRANCH_URL",
        "LABSIGHT_EXTRA_ALLOWED_ORIGIN",
    ):
        value = os.getenv(name, "").strip()
        if not value:
            continue
        if not value.startswith(("http://", "https://")):
            value = "https://" + value
        host = urlparse(value).hostname
        if host:
            hosts.add(host)
    return hosts


@app.get("/api/session")
def issue_session(request: Request):
    if not session_secret():
        return {
            "ok": True,
            "auth": "disabled",
            "token": "",
            "note": "未配置 LABSIGHT_SESSION_SECRET，API 会话保护处于关闭状态。",
        }

    rate_limit(request, "session", limit=60, window=600.0)

    source = request.headers.get("origin") or request.headers.get("referer") or ""
    host = urlparse(source).hostname if source else request.url.hostname
    if host not in _allowed_hosts():
        raise HTTPException(status_code=403, detail="来源不在 LabSight 白名单内")

    return {
        "ok": True,
        "auth": "enabled",
        "token": mint_token(),
        "expires_in": TOKEN_TTL_SECONDS,
    }
