from __future__ import annotations

import base64
import os
from typing import Any

import requests
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

app = FastAPI(title="LabSight Gemini TTS OpenAI Bridge", version="0.1.0")


class SpeechRequest(BaseModel):
    model: str | None = None
    input: str = Field(min_length=1, max_length=12000)
    voice: str | None = None
    response_format: str | None = None
    speed: float | None = None
    instruction: str | None = None


def _expected_key() -> str:
    # No extra user-managed secret is required. Reuse the Shengwang app certificate
    # as an internal bridge secret unless an explicit bridge key is configured.
    return (
        os.getenv("SHENGWANG_CUSTOM_TTS_API_KEY", "").strip()
        or os.getenv("SHENGWANG_APP_CERTIFICATE", "").strip()
        or os.getenv("AGORA_APP_CERTIFICATE", "").strip()
    )


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
    raise HTTPException(status_code=502, detail=f"Gemini TTS 未返回音频：{str(payload)[:1200]}")


@app.get("/api/gemini_tts_openai")
def health():
    return {
        "ok": True,
        "service": "gemini-tts-openai-bridge",
        "model": os.getenv("GEMINI_TTS_MODEL", "gemini-3.1-flash-tts-preview"),
        "voice": os.getenv("GEMINI_TTS_VOICE", "Kore"),
        "sample_rate": 24000,
        "configured": bool(os.getenv("GEMINI_API_KEY", "").strip()),
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

    # Gemini 3.1 TTS produces raw PCM: signed 16-bit little-endian,
    # mono, 24 kHz. This matches Shengwang GenericTTS response_format=pcm.
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
            continue

        if response.status_code >= 400:
            last_error = f"HTTP {response.status_code}: {response.text[:1200]}"
            if response.status_code < 500:
                break
            continue

        try:
            payload = response.json()
            pcm = _extract_pcm(payload)
            return Response(
                content=pcm,
                media_type="application/octet-stream",
                headers={
                    "X-Audio-Format": "pcm_s16le",
                    "X-Sample-Rate": "24000",
                    "X-Channels": "1",
                },
            )
        except HTTPException as exc:
            last_error = str(exc.detail)
            continue
        except Exception as exc:
            last_error = f"Gemini TTS 响应解析失败：{type(exc).__name__}: {exc}"
            continue

    raise HTTPException(status_code=502, detail=f"Gemini TTS 生成失败：{last_error}")
