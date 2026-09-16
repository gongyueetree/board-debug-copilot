from __future__ import annotations

import json
import os
import re
import time
import uuid
from typing import Any, Iterable

import requests
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

app = FastAPI(title="LabSight A6 Voice Gateway", version="0.20.0")

LAST_TRACE: dict[str, Any] = {}


def _gateway_secret() -> str:
    return (
        os.getenv("SHENGWANG_CUSTOM_LLM_API_KEY", "").strip()
        or os.getenv("AGORA_CUSTOM_LLM_API_KEY", "").strip()
        or os.getenv("SHENGWANG_APP_CERTIFICATE", "").strip()
        or os.getenv("AGORA_APP_CERTIFICATE", "").strip()
    )


def _check_auth(authorization: str | None, x_api_key: str | None) -> None:
    expected = _gateway_secret()
    if not expected:
        return
    supplied = ""
    if authorization:
        supplied = authorization.removeprefix("Bearer ").strip()
    if not supplied and x_api_key:
        supplied = x_api_key.strip()
    if supplied != expected:
        raise HTTPException(status_code=401, detail="Invalid LabSight voice gateway credential")


def _text_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and item.get("type") in {"text", "input_text"} and item.get("text"):
                parts.append(str(item["text"]))
        return "\n".join(parts)
    return str(content or "")


def _last_user_message(body: dict[str, Any]) -> str:
    for message in reversed(body.get("messages") or []):
        if isinstance(message, dict) and str(message.get("role") or "") == "user":
            text = _text_content(message.get("content")).strip()
            if text:
                return text
    raise HTTPException(status_code=400, detail="Voice turn 缺少 user message")


def _project_from_messages(body: dict[str, Any]) -> str:
    pattern = re.compile(r"(?:LABSIGHT_PROJECT_ID|projectId)\s*[=:]\s*([A-Za-z0-9._-]+)")
    for message in body.get("messages") or []:
        if not isinstance(message, dict):
            continue
        match = pattern.search(_text_content(message.get("content")))
        if match:
            return match.group(1)
    return ""


def _project_id(body: dict[str, Any], request: Request, header_value: str | None) -> str:
    metadata = body.get("metadata") if isinstance(body.get("metadata"), dict) else {}
    value = (
        (header_value or "").strip()
        or str(request.query_params.get("projectId") or "").strip()
        or str(metadata.get("projectId") or metadata.get("project_id") or "").strip()
        or _project_from_messages(body)
        or os.getenv("LABSIGHT_VOICE_PROJECT_ID", "").strip()
    )
    if not value:
        raise HTTPException(
            status_code=400,
            detail="A6 voice turn 缺少 projectId；请从宿主传 x-labsight-project-id / metadata.projectId，或测试时配置 LABSIGHT_VOICE_PROJECT_ID",
        )
    return value


def _a6_base_url() -> str:
    value = (
        os.getenv("LABSIGHT_A6_API_BASE_URL", "").strip()
        or os.getenv("NEXT_PUBLIC_API_BASE_URL", "").strip()
        or os.getenv("API_BASE_URL", "").strip()
    )
    if not value:
        raise HTTPException(status_code=503, detail="未配置 LABSIGHT_A6_API_BASE_URL")
    return value.rstrip("/")


def _a6_headers() -> dict[str, str]:
    headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
    token = os.getenv("LABSIGHT_A6_API_TOKEN", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _openai_chunk(
    text: str,
    chunk_id: str,
    *,
    role: str | None = None,
    finish_reason: str | None = None,
) -> bytes:
    delta: dict[str, Any] = {}
    if role:
        delta["role"] = role
    if text:
        delta["content"] = text
    obj = {
        "id": chunk_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": "labsight-a6",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n".encode("utf-8")


def _a6_stream(project_id: str, message: str) -> Iterable[bytes]:
    url = f"{_a6_base_url()}/api/v1/ai/chat"
    chunk_id = f"chatcmpl-labsight-a6-{uuid.uuid4().hex[:16]}"
    started = time.perf_counter()
    output_parts: list[str] = []
    yield _openai_chunk("", chunk_id, role="assistant")

    try:
        with requests.post(
            url,
            headers=_a6_headers(),
            json={
                "projectId": project_id,
                "message": message,
                "mode": "voice",
            },
            stream=True,
            timeout=75,
        ) as response:
            if response.status_code >= 400:
                raise HTTPException(status_code=502, detail=f"A6 voice upstream {response.status_code}: {response.text[:1200]}")

            event_name = ""
            for raw in response.iter_lines(decode_unicode=True):
                line = str(raw or "")
                if not line:
                    event_name = ""
                    continue
                if line.startswith("event:"):
                    event_name = line[6:].strip()
                    continue
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if not data:
                    continue
                try:
                    payload = json.loads(data)
                except json.JSONDecodeError:
                    continue

                if event_name == "narration":
                    delta = str(payload.get("delta") or "")
                    if delta:
                        output_parts.append(delta)
                        yield _openai_chunk(delta, chunk_id)
                elif event_name == "error":
                    raise HTTPException(status_code=502, detail=str(payload.get("message") or "A6 stream error"))
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"A6 voice gateway request failed: {exc}") from exc

    elapsed_ms = round((time.perf_counter() - started) * 1000)
    output = "".join(output_parts)
    LAST_TRACE.clear()
    LAST_TRACE.update({
        "at": int(time.time()),
        "brain": "A6",
        "project_id": project_id,
        "output_chars": len(output),
        "elapsed_ms": elapsed_ms,
    })
    yield _openai_chunk("", chunk_id, finish_reason="stop")
    yield b"data: [DONE]\n\n"


@app.get("/api/agora_chat")
def voice_chat_health() -> JSONResponse:
    configured = bool(
        os.getenv("LABSIGHT_A6_API_BASE_URL", "").strip()
        or os.getenv("NEXT_PUBLIC_API_BASE_URL", "").strip()
        or os.getenv("API_BASE_URL", "").strip()
    )
    return JSONResponse({
        "ok": True,
        "service": "labsight-a6-voice-gateway",
        "version": "0.20.0",
        "brain": "A6",
        "configured": configured,
        "project_binding": "header|query|metadata|system-marker|env-fallback",
        "last_trace": LAST_TRACE or None,
    })


@app.post("/api/agora_chat")
async def voice_chat(
    request: Request,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
    x_labsight_project_id: str | None = Header(default=None),
):
    _check_auth(authorization, x_api_key)
    body = await request.json()
    if body.get("stream") is False:
        raise HTTPException(status_code=400, detail="Voice Chat Completions requires stream=true")
    project_id = _project_id(body, request, x_labsight_project_id)
    message = _last_user_message(body)
    return StreamingResponse(
        _a6_stream(project_id, message),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
            "X-LabSight-Brain": "A6",
        },
    )
