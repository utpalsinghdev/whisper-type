"""Runtime configuration sourced from environment variables."""

import os


def get_int(name: str, default: int) -> int:
    try:
        return int(os.environ[name])
    except (KeyError, ValueError):
        return default


def get_float(name: str, default: float) -> float:
    try:
        return float(os.environ[name])
    except (KeyError, ValueError):
        return default


# audio capture/playback
SAMPLE_RATE = get_int("WT_SAMPLE_RATE", 16000)
CHUNK_SIZE = get_int("WT_CHUNK_SIZE", 1024)
SILENCE_THRESHOLD = get_int("WT_SILENCE_THRESHOLD", 500)

# model / transcription
DEFAULT_MODEL = os.environ.get("WT_MODEL", "base.en.pt")
TRANSCRIBE_TIMEOUT = get_float("WT_TRANSCRIBE_TIMEOUT", 120.0)
MAX_WINDOW_CHUNKS = get_int("WT_MAX_WINDOW_CHUNKS", 1000)

# server limits / auth
MAX_UPLOAD_BYTES = get_int("WT_MAX_UPLOAD_BYTES", 50 * 1024 * 1024)
MAX_SESSIONS = get_int("WT_MAX_SESSIONS", 128)
API_KEY = os.environ.get("WT_API_KEY") or None
