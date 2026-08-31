from __future__ import annotations

import base64
import io
import os
import wave
from typing import Any

import requests
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response

from api._security import rate_limit, require_session

app = FastAPI(title="LabSight Gemini TTS", version="0.5.2")


def _pcm16_to_wav(pcm: bytes, sample_rate: int = 24000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm)
    return buf.getvalue()


@app.post("/api/gemini_speech")
def gemini_speech(payload: dict[str, Any], request: Request):
    require_session(request)
    rate_limit(request, "tts", limit=180, window=300.0)
    text = str(payload.get("text", "")).strip()
    if not text:
        raise HTTPException(status_code=400, detail="缺少 text")

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="未配置 GEMINI_API_KEY")

    model = os.getenv("GEMINI_TTS_MODEL", "gemini-3.1-flash-tts-preview")
    voice = os.getenv("GEMINI_TTS_VOICE", "Kore")
    style = str(payload.get("style") or (
        "请用自然、温暖、专业的中文工程师助手语气朗读。"
        "语速自然略快，不要像播报机器；句子间做短暂停顿，重点器件型号、数字和单位读清楚。"
        "对于建议和结论，语气稍有起伏；不要夸张表演。"
    ))
    prompt = f"{style}\n\n以下是需要朗读的正文，只朗读正文，不要朗读上面的风格说明：\n{text[:3200]}"

    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {
                    "prebuiltVoiceConfig": {"voiceName": voice}
                }
            },
        },
    }

    try:
        r = requests.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
            json=body,
            timeout=90,
        )
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Gemini TTS 请求失败: {exc}") from exc

    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Gemini TTS error {r.status_code}: {r.text[:1000]}")

    data = r.json()
    inline = None
    for cand in data.get("candidates", []):
        for part in cand.get("content", {}).get("parts", []):
            if part.get("inlineData", {}).get("data"):
                inline = part["inlineData"]
                break
        if inline:
            break
    if not inline:
        raise HTTPException(status_code=502, detail="Gemini TTS 没有返回音频")

    pcm = base64.b64decode(inline["data"])
    wav = _pcm16_to_wav(pcm, 24000)
    return Response(content=wav, media_type="audio/wav", headers={"X-LabSight-TTS-Model": model, "X-LabSight-TTS-Voice": voice})
