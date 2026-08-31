"""Explicit Vercel entrypoint for LabSight cloud TTS."""

from fastapi import Request

from api._security import rate_limit, require_session
from api.index import app


@app.middleware("http")
async def _protect_speech(request: Request, call_next):
    if request.url.path == "/api/speech":
        require_session(request)
        rate_limit(request, "tts", limit=180, window=300.0)
    return await call_next(request)


__all__ = ["app"]
