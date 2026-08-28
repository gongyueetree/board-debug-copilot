from __future__ import annotations

import base64
import os
from typing import Any

import requests
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI(title="LabSight Shengwang Control", version="0.1.0")
API_BASE = "https://api.agora.io/cn/api/conversational-ai-agent/v2/projects"


class ControlRequest(BaseModel):
    action: str = "think"
    agent_id: str
    text: str | None = None


def _first_env(*names: str) -> str:
    for name in names:
        value = os.getenv(name, "").strip()
        if value:
            return value
    raise HTTPException(status_code=503, detail=f"未配置 {' / '.join(names)}")


def _app_id() -> str:
    return _first_env("SHENGWANG_APP_ID", "AGORA_APP_ID")


def _auth() -> str:
    customer_id = _first_env("SHENGWANG_CUSTOMER_ID", "AGORA_CUSTOMER_ID")
    customer_secret = _first_env("SHENGWANG_CUSTOMER_SECRET", "AGORA_CUSTOMER_SECRET")
    raw = f"{customer_id}:{customer_secret}".encode("utf-8")
    return "Basic " + base64.b64encode(raw).decode("ascii")


def _request(method: str, url: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    try:
        r = requests.request(
            method,
            url,
            headers={"Authorization": _auth(), "Content-Type": "application/json"},
            json=body,
            timeout=25,
        )
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"声网控制请求失败：{exc}") from exc
    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"声网 API {r.status_code}: {r.text[:1600]}")
    try:
        return r.json()
    except Exception:
        return {"raw": r.text[:1600]}


@app.post("/api/shengwang_control")
def control(req: ControlRequest) -> JSONResponse:
    action = req.action.strip().lower()
    base = f"{API_BASE}/{_app_id()}/agents/{req.agent_id}"

    if action == "think":
        text = (req.text or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="think 缺少 text")
        data = _request(
            "POST",
            base + "/think",
            {
                "text": text,
                "on_listening_action": "interrupt",
                "on_thinking_action": "interrupt",
                "on_speaking_action": "interrupt",
                "interruptable": True,
                "metadata": {"source": "labsight-browser"},
            },
        )
        return JSONResponse({"ok": True, "action": "think", "response": data})

    if action == "status":
        data = _request("GET", base)
        return JSONResponse({"ok": True, "action": "status", "response": data})

    raise HTTPException(status_code=400, detail="action 仅支持 think 或 status")
