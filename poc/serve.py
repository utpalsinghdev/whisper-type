"""Transcription API server for the WishperType desktop app.

Exposes the wispertype FastAPI app (used by the capsule via
/transcribe_pcm_chunk). Run with: uvicorn poc.serve:app
"""

from __future__ import annotations

from fastapi.middleware.cors import CORSMiddleware

from wispertype.fast_server import app

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
