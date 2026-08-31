"""Explicit Vercel entrypoint for LabSight speech transcription."""

from fastapi import Request

from api._security import rate_limit, require_session
from api.index import app


@app.middleware("http")
async def _protect_transcribe(request: Request, call_next):
    if request.url.path == "/api/transcribe":
        require_session(request)
        rate_limit(request, "transcribe", limit=120, window=300.0)
    return await call_next(request)


__all__ = ["app"]
