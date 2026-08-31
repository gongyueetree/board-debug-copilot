from __future__ import annotations

from datetime import datetime, timedelta, timezone
import os

import requests
from fastapi import FastAPI, HTTPException, Request

from api._security import rate_limit, require_session

app = FastAPI(title="LabSight Gemini Live Token", version="0.5.6")


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


@app.get("/api/gemini_live_token")
def gemini_live_token(request: Request):
    require_session(request)
    rate_limit(request, "livetoken", limit=30, window=300.0)
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="未配置 GEMINI_API_KEY")

    model = os.getenv("GEMINI_LIVE_MODEL", "gemini-3.1-flash-live-preview")
    voice = os.getenv("GEMINI_LIVE_VOICE", "Kore")
    now = datetime.now(timezone.utc)

    body = {
        "uses": 1,
        "expireTime": _iso(now + timedelta(minutes=2)),
        "newSessionExpireTime": _iso(now + timedelta(minutes=1)),
        "liveConnectConstraints": {
            "model": f"models/{model}",
            "config": {"responseModalities": ["AUDIO"]},
        },
    }

    try:
        r = requests.post(
            "https://generativelanguage.googleapis.com/v1beta/auth_tokens",
            headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
            json=body,
            timeout=20,
        )
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"创建 Gemini Live 临时令牌失败: {exc}") from exc

    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Gemini Live token error {r.status_code}: {r.text[:1000]}")

    data = r.json()
    token = data.get("name")
    if not token:
        raise HTTPException(status_code=502, detail="Gemini Live 未返回临时令牌")

    return {"token": token, "model": model, "voice": voice, "expires_in_seconds": 120}
