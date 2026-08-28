from __future__ import annotations

import math
import struct
import time
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field

app = FastAPI(title="LabSight GenericTTS Probe", version="0.1.0")

SAMPLE_RATE = 24000
DURATION_SECONDS = 1.4
FREQUENCY_HZ = 880.0
AMPLITUDE = 0.18


class ProbeSpeechRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    model: str | None = None
    input: str = Field(default="LabSight GenericTTS probe", min_length=1, max_length=12000)
    voice: str | None = None
    response_format: str | None = None
    speed: float | None = None
    instruction: str | None = None


def _tone_pcm() -> bytes:
    """Return deterministic raw signed 16-bit little-endian mono PCM.

    This endpoint intentionally has no external dependency. If Shengwang can call
    this OpenAI-TTS-compatible endpoint, the returned tone should be published to
    RTC. That cleanly separates GenericTTS/network/config problems from Gemini.
    """
    total = int(SAMPLE_RATE * DURATION_SECONDS)
    out = bytearray(total * 2)
    fade = max(1, int(SAMPLE_RATE * 0.03))
    for i in range(total):
        envelope = 1.0
        if i < fade:
            envelope = i / fade
        elif i > total - fade:
            envelope = max(0.0, (total - i) / fade)
        sample = int(32767 * AMPLITUDE * envelope * math.sin(2.0 * math.pi * FREQUENCY_HZ * i / SAMPLE_RATE))
        struct.pack_into("<h", out, i * 2, sample)
    return bytes(out)


@app.get("/api/tts_probe")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "labsight-generic-tts-probe",
        "version": "0.1.0",
        "format": "pcm_s16le",
        "sample_rate": SAMPLE_RATE,
        "channels": 1,
        "duration_seconds": DURATION_SECONDS,
        "frequency_hz": FREQUENCY_HZ,
    }


@app.post("/api/tts_probe")
async def speech(req: ProbeSpeechRequest, request: Request) -> Response:
    pcm = _tone_pcm()
    return Response(
        content=pcm,
        media_type="audio/pcm",
        headers={
            "X-LabSight-TTS-Probe": "ok",
            "X-Audio-Format": "pcm_s16le",
            "X-Sample-Rate": str(SAMPLE_RATE),
            "X-Channels": "1",
            "X-Probe-Received-At": str(int(time.time())),
            "Cache-Control": "no-store",
        },
    )
