"""Whisper transcription for WishperType."""

import asyncio
import os
import threading
from typing import Optional

import numpy as np
import torch
import whisper
from whisper import Whisper

from wispertype import config

models: dict[str, Whisper] = {}
_models_lock = threading.Lock()

SAMPLE_RATE = 16_000


def resolve_model_path(file_name: str) -> str:
    models_dir = os.path.join(os.path.dirname(__file__), "models")
    path = os.path.normpath(os.path.join(models_dir, file_name))
    if os.path.dirname(path) != models_dir:
        raise ValueError(f"invalid model name: {file_name}")
    if not os.path.isfile(path):
        raise ValueError(f"unknown model: {file_name}")
    return path


def get_model(file_name: Optional[str] = None) -> Whisper:
    name = file_name or config.DEFAULT_MODEL
    if name not in models:
        path = resolve_model_path(name)
        with _models_lock:
            if name not in models:
                # Drop any other loaded model to avoid holding 2+ GB twice.
                models.clear()
                torch.set_num_threads(int(os.environ.get("OMP_NUM_THREADS", "4")))
                models[name] = whisper.load_model(path).to(
                    "cuda" if torch.cuda.is_available() else "cpu"
                )
    return models[name]


def _trim_silence(audio: np.ndarray, threshold: float = 0.01) -> np.ndarray:
    """Trim leading/trailing silence — helps accuracy and speed."""
    if audio.size == 0:
        return audio
    abs_audio = np.abs(audio)
    mask = abs_audio > threshold
    if not mask.any():
        return audio
    indices = np.where(mask)[0]
    start = max(0, int(indices[0]) - int(SAMPLE_RATE * 0.05))
    end = min(len(audio), int(indices[-1]) + int(SAMPLE_RATE * 0.15))
    return audio[start:end]


def transcribe_pcm_chunks(model: Whisper, chunks: list, lang: str = "en") -> dict:
    """Transcribe raw 16 kHz mono PCM. Tuned for CPU speed + dictation accuracy."""
    arr = (
        np.frombuffer(b"".join(chunks), np.int16).flatten().astype(np.float32) / 32768.0
    )
    arr = _trim_silence(arr)

    # Less than 0.25 s of speech — skip Whisper entirely.
    if arr.size < SAMPLE_RATE // 4:
        return {"text": ""}

    return model.transcribe(
        arr,
        fp16=False,
        language=lang,
        task="transcribe",
        temperature=0.0,
        beam_size=1,
        best_of=1,
        without_timestamps=True,
        logprob_threshold=-1.0,
        compression_ratio_threshold=2.4,
        no_speech_threshold=0.6,
        condition_on_previous_text=False,
    )


async def transcribe_pcm_chunks_async(
    model: Whisper, chunks: list, lang: str = "en"
) -> dict:
    return await asyncio.get_running_loop().run_in_executor(
        None, transcribe_pcm_chunks, model, chunks, lang
    )
