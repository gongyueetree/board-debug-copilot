from __future__ import annotations

import base64
import json
import os
import re
from typing import Any

import requests
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

app = FastAPI(title="LabSight Gemini TTS OpenAI Bridge", version="0.1.3")


class SpeechRequest(BaseModel):
    model: str | None = None
    input: str = Field(min_length=1, max_length=12000)
    voice: str | None = None
    response_format: str | None = None
    speed: float | None = None
    instruction: str | None = None


def _expected_key() -> str:
    return os.getenv("SHENGWANG_CUSTOM_TTS_API_KEY", "").strip()


def _authorize(authorization: str | None, x_api_key: str | None) -> None:
    expected = _expected_key()
    if not expected:
        return
    bearer = ""
    if authorization and authorization.lower().startswith("bearer "):
        bearer = authorization[7:].strip()
    if bearer != expected and (x_api_key or "").strip() != expected:
        raise HTTPException(status_code=401, detail="Unauthorized TTS bridge request")


def _gemini_key() -> str:
    key = os.getenv("GEMINI_API_KEY", "").strip()
    if not key:
        raise HTTPException(status_code=503, detail="未配置 GEMINI_API_KEY")
    return key


def _extract_pcm(payload: dict[str, Any]) -> bytes:
    candidates = payload.get("candidates") or []
    for candidate in candidates:
        content = candidate.get("content") or {}
        for part in content.get("parts") or []:
            inline = part.get("inlineData") or part.get("inline_data") or {}
            data = inline.get("data")
            if data:
                try:
                    return base64.b64decode(data)
                except Exception as exc:
                    raise HTTPException(status_code=502, detail=f"Gemini TTS 音频解码失败：{exc}") from exc
    raise HTTPException(status_code=502, detail="Gemini TTS 未返回音频")


def _parse_google_error(response: requests.Response) -> tuple[str, dict[str, Any]]:
    raw = response.text[:5000]
    payload: dict[str, Any] = {}
    try:
        payload = response.json()
    except Exception:
        pass

    error = payload.get("error") if isinstance(payload, dict) else None
    if not isinstance(error, dict):
        return raw or response.reason, {}

    message = str(error.get("message") or raw or response.reason)
    meta: dict[str, Any] = {}

    retry_match = re.search(r"retry in\s+([0-9.]+)s", message, flags=re.I)
    if retry_match:
        try:
            meta["retry_after_seconds"] = max(1, int(float(retry_match.group(1))))
        except Exception:
            pass

    details = error.get("details") or []
    for item in details:
        if not isinstance(item, dict):
            continue
        if item.get("@type", "").endswith("QuotaFailure"):
            violations = item.get("violations") or []
            if violations and isinstance(violations[0], dict):
                violation = violations[0]
                meta["quota_metric"] = violation.get("quotaMetric")
                meta["quota_id"] = violation.get("quotaId")
                dims = violation.get("quotaDimensions") or {}
                if isinstance(dims, dict):
                    meta["model"] = dims.get("model")
                    meta["location"] = dims.get("location")

    limit_match = re.search(r"limit:\s*(\d+)", message, flags=re.I)
    if limit_match:
        meta["daily_limit"] = int(limit_match.group(1))

    return message, meta


@app.get("/api/gemini_tts_openai")
def health():
    return {
        "ok": True,
        "service": "gemini-tts-openai-bridge",
        "version": "0.1.3",
        "model": os.getenv("GEMINI_TTS_MODEL", "gemini-3.1-flash-tts-preview"),
        "voice": os.getenv("GEMINI_TTS_VOICE", "Kore"),
        "sample_rate": 24000,
        "configured": bool(os.getenv("GEMINI_API_KEY", "").strip()),
        "auth": "optional-secret" if _expected_key() else "none",
    }


@app.post("/api/gemini_tts_openai")
def speech(
    req: SpeechRequest,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
):
    _authorize(authorization, x_api_key)

    model = os.getenv("GEMINI_TTS_MODEL", "gemini-3.1-flash-tts-preview").strip()
    voice = (req.voice or os.getenv("GEMINI_TTS_VOICE", "Kore")).strip() or "Kore"

    text = req.input.strip()
    if req.instruction:
        text = f"{req.instruction.strip()}\n请只朗读以下正文，不要朗读指令本身：\n{text}"
    else:
        text = f"请使用自然、清晰、简洁的中文语音朗读以下正文。只朗读正文：\n{text}"

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    body = {
        "contents": [{"parts": [{"text": text}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {
                    "prebuiltVoiceConfig": {"voiceName": voice}
                }
            },
        },
    }

    last_error = ""
    for attempt in range(2):
        try:
            response = requests.post(
                url,
                headers={"x-goog-api-key": _gemini_key(), "Content-Type": "application/json"},
                json=body,
                timeout=30,
            )
        except requests.RequestException as exc:
            last_error = str(exc)
            if attempt == 0:
                continue
            raise HTTPException(status_code=502, detail={"code": "upstream_network_error", "message": last_error}) from exc

        if response.status_code == 429:
            message, meta = _parse_google_error(response)
            raise HTTPException(
                status_code=429,
                detail={
                    "code": "gemini_tts_quota_exhausted",
                    "message": "Gemini TTS 配额已耗尽",
                    "provider_message": message,
                    **meta,
                },
            )

        if 400 <= response.status_code < 500:
            message, meta = _parse_google_error(response)
            raise HTTPException(
                status_code=response.status_code,
                detail={"code": "gemini_tts_request_rejected", "message": message, **meta},
            )

        if response.status_code >= 500:
            last_error = f"HTTP {response.status_code}: {response.text[:1200]}"
            if attempt == 0:
                continue
            raise HTTPException(status_code=502, detail={"code": "gemini_tts_upstream_error", "message": last_error})

        try:
            payload = response.json()
            pcm = _extract_pcm(payload)
            return Response(
                content=pcm,
                media_type="audio/pcm",
                headers={
                    "X-Audio-Format": "pcm_s16le",
                    "X-Sample-Rate": "24000",
                    "X-Channels": "1",
                    "Cache-Control": "no-store",
                },
            )
        except HTTPException:
            raise
        except Exception as exc:
            last_error = f"Gemini TTS 响应解析失败：{type(exc).__name__}: {exc}"
            if attempt == 0:
                continue
            raise HTTPException(status_code=502, detail={"code": "gemini_tts_parse_error", "message": last_error}) from exc

    raise HTTPException(status_code=502, detail={"code": "gemini_tts_unknown_error", "message": last_error or "未知错误"})
