"""Vercel FastAPI entrypoint for LabSight.

Current Vercel Python deployments auto-detect a root-level ``main.py`` exposing
an ASGI ``app``. The actual LabSight API remains in ``api/index.py`` so local
and existing imports continue to work; this file simply makes the deployment
entrypoint explicit.
"""

from api.index import app

__all__ = ["app"]
