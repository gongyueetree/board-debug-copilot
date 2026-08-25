"""Explicit Vercel entrypoint for LabSight image analysis.

Vercel routes /api/analyze to this file. Reuse the shared FastAPI app defined in
api/index.py so request/response validation and provider logic stay in one place.
"""

from api.index import app

__all__ = ["app"]
