from __future__ import annotations

import json
import os
import time
import uuid
from typing import Any, Iterable

import requests
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import StreamingResponse

app = FastAPI(title="LabSight Voice OpenAI-Compatible LLM Gateway", version="0.10.0")

SYSTEM_PROMPT = (
    "你是 LabSight 的实时语音调试助手，面向电子研发工程师。"
    "始终使用简体中文，回答短、快、自然，优先 2~5 句话：先给结论，再给下一步。"
    "器件型号、网络名、引脚名、协议名和单位保持原样。"
    "当前实时语音通道还没有自动注入摄像头画面；如果问题明确依赖当前 PCB 或仪器画面，"
    "请直接说明需要当前画面/PCB Deep Vision 证据，不要假装看到了画面。"
)


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
        raise HTTPException(status_code=401, detail="Invalid LabSight voice LLM gateway credential")


def _text_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                if item.get("type") in {"text", "input_text"} and item.get("text"):
                    parts.append(str(item["text"]))
        return "\n".join(parts)
    return str(content or "")


def _normalized_messages(body: dict[str, Any]) -> list[dict[str, str]]:
    out = [{"role": "system", "content": SYSTEM_PROMPT}]
    for msg in body.get("messages") or []:
        if not isinstance(msg, dict):
            continue
        role = str(msg.get("role") or "user")
        if role not in {"system", "user", "assistant", "tool"}:
            role = "user"
        text = _text_content(msg.get("content"))
        if text:
            out.append({"role": role, "content": text})
    return out[-18:]


def _temp() -> float:
    return float(os.getenv("SHENGWANG_LLM_TEMPERATURE", os.getenv("AGORA_LLM_TEMPERATURE", "0.30")))


def _max_tokens() -> int:
    return int(os.getenv("SHENGWANG_LLM_MAX_TOKENS", os.getenv("AGORA_LLM_MAX_TOKENS", "220")))


def _openai_stream(messages: list[dict[str, str]]) -> Iterable[bytes]:
    key = os.getenv("OPENAI_API_KEY", "").strip()
    if not key:
        raise HTTPException(status_code=503, detail="实时语音选择 OpenAI，但未配置 OPENAI_API_KEY")
    model = os.getenv("SHENGWANG_OPENAI_MODEL", os.getenv("AGORA_OPENAI_MODEL", "gpt-4o-mini"))
    payload = {"model": model, "messages": messages, "stream": True, "temperature": _temp(), "max_tokens": _max_tokens()}
    try:
        with requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json=payload,
            stream=True,
            timeout=60,
        ) as r:
            if r.status_code >= 400:
                raise HTTPException(status_code=502, detail=f"OpenAI voice gateway error {r.status_code}: {r.text[:1000]}")
            for line in r.iter_lines():
                if line and line.startswith(b"data:"):
                    yield line + b"\n\n"
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"OpenAI voice gateway request failed: {exc}") from exc


def _gemini_messages(messages: list[dict[str, str]]) -> tuple[str, list[dict[str, Any]]]:
    systems: list[str] = []
    contents: list[dict[str, Any]] = []
    for msg in messages:
        if msg["role"] == "system":
            systems.append(msg["content"])
            continue
        contents.append({"role": "model" if msg["role"] == "assistant" else "user", "parts": [{"text": msg["content"]}]})
    return "\n".join(systems), contents


def _openai_chunk(text: str, model: str, chunk_id: str) -> bytes:
    obj = {
        "id": chunk_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}],
    }
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n".encode("utf-8")


def _gemini_stream(messages: list[dict[str, str]]) -> Iterable[bytes]:
    key = os.getenv("GEMINI_API_KEY", "").strip()
    if not key:
        raise HTTPException(status_code=503, detail="实时语音选择 Gemini，但未配置 GEMINI_API_KEY")
    model = os.getenv("SHENGWANG_GEMINI_MODEL", os.getenv("AGORA_GEMINI_MODEL", "gemini-2.5-flash"))
    system_instruction, contents = _gemini_messages(messages)
    payload: dict[str, Any] = {"contents": contents, "generationConfig": {"temperature": _temp(), "maxOutputTokens": _max_tokens()}}
    if system_instruction:
        payload["systemInstruction"] = {"parts": [{"text": system_instruction}]}
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse"
    chunk_id = f"chatcmpl-labsight-{uuid.uuid4().hex[:16]}"
    try:
        with requests.post(url, headers={"x-goog-api-key": key, "Content-Type": "application/json"}, json=payload, stream=True, timeout=60) as r:
            if r.status_code >= 400:
                raise HTTPException(status_code=502, detail=f"Gemini voice gateway error {r.status_code}: {r.text[:1000]}")
            for raw in r.iter_lines(decode_unicode=True):
                if not raw or not raw.startswith("data:"):
                    continue
                data = raw[5:].strip()
                if not data:
                    continue
                try:
                    obj = json.loads(data)
                except json.JSONDecodeError:
                    continue
                for candidate in obj.get("candidates") or []:
                    for part in candidate.get("content", {}).get("parts", []):
                        text = part.get("text")
                        if text:
                            yield _openai_chunk(text, model, chunk_id)
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Gemini voice gateway request failed: {exc}") from exc
    yield b"data: [DONE]\n\n"


@app.post("/api/agora_chat")
async def voice_chat(
    request: Request,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
):
    _check_auth(authorization, x_api_key)
    body = await request.json()
    if body.get("stream") is False:
        raise HTTPException(status_code=400, detail="Voice Chat Completions requires stream=true")
    messages = _normalized_messages(body)
    requested = str(body.get("model") or "").lower()
    provider = "gemini" if "gemini" in requested else "openai"
    generator = _gemini_stream(messages) if provider == "gemini" else _openai_stream(messages)
    return StreamingResponse(generator, media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
