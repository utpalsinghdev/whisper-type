#!/usr/bin/env python3
"""Benchmark WishperType remote transcription (base.en).

Reads API URL + key from macOS settings.json by default.
Usage:
  python3 scripts/bench_transcribe.py [/path/to.pcm ...]
"""
from __future__ import annotations

import json
import pathlib
import sys
import time
import urllib.request

SETTINGS = (
    pathlib.Path.home()
    / "Library/Application Support/com.wishper.type/settings.json"
)


def load_creds():
    d = json.loads(SETTINGS.read_text())
    return d["backend_url"].rstrip("/"), d["api_key"]


def multipart(fields: dict, files: dict) -> tuple[bytes, str]:
    boundary = f"----wt{int(time.time() * 1000)}"
    body = bytearray()
    for k, v in fields.items():
        body.extend(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
        )
    for name, (filename, data, ctype) in files.items():
        body.extend(
            (
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; "
                f'filename="{filename}"\r\nContent-Type: {ctype}\r\n\r\n'
            ).encode()
        )
        body.extend(data)
        body.extend(b"\r\n")
    body.extend(f"--{boundary}--\r\n".encode())
    return bytes(body), boundary


def post(url: str, key: str, path: str, *, json_body=None, fields=None, files=None):
    headers = {"X-API-Key": key, "Authorization": f"Bearer {key}"}
    if json_body is not None:
        data = json.dumps(json_body).encode()
        headers["Content-Type"] = "application/json"
    else:
        data, boundary = multipart(fields or {}, files or {})
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    req = urllib.request.Request(url + path, data=data, method="POST", headers=headers)
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=300) as r:
        raw = r.read()
    return time.perf_counter() - t0, json.loads(raw)


def bench_batch(url: str, key: str, pcm: bytes, runs: int = 3):
    audio_sec = len(pcm) / (16000 * 2)
    times, texts = [], []
    for _ in range(runs):
        dt, data = post(
            url,
            key,
            "/transcribe_pcm_chunk",
            fields={"model_name": "base.en"},
            files={"file": ("a.pcm", pcm, "application/octet-stream")},
        )
        times.append(dt)
        texts.append((data.get("text") or "").strip())
    times.sort()
    med = times[len(times) // 2]
    return {
        "kind": "batch",
        "audio_sec": audio_sec,
        "median_s": med,
        "rtf": med / audio_sec if audio_sec else 0,
        "text": texts[-1],
        "runs": times,
    }


def bench_stream(url: str, key: str, pcm: bytes, chunk_sec: float = 3.0):
    audio_sec = len(pcm) / (16000 * 2)
    chunk = int(16000 * 2 * chunk_sec)
    t0 = time.perf_counter()
    _, start = post(url, key, "/transcribe_stream/start", json_body={"model_name": "base.en"})
    sid = start["sessionId"]
    offset = 0
    while offset < len(pcm):
        piece = pcm[offset : offset + chunk]
        offset += len(piece)
        post(
            url,
            key,
            "/transcribe_stream/chunk",
            fields={"session_id": sid},
            files={"file": ("c.pcm", piece, "application/octet-stream")},
        )
    t_push = time.perf_counter()
    stop_s, data = post(
        url, key, "/transcribe_stream/end", json_body={"session_id": sid}
    )
    # post() already includes network; stop_s is full end() call time
    return {
        "kind": "stream",
        "audio_sec": audio_sec,
        "stop_s": stop_s,
        "server_latency_ms": data.get("latencyMs"),
        "mode": data.get("mode"),
        "total_s": time.perf_counter() - t0,
        "push_to_end_s": time.perf_counter() - t_push,  # negligible leftover
        "text": (data.get("text") or "").strip(),
    }


def main():
    url, key = load_creds()
    print(f"target={url}")
    urllib.request.urlopen(url + "/health", timeout=30).read()
    paths = [pathlib.Path(p) for p in sys.argv[1:]] or [pathlib.Path("/tmp/wt-bench/jfk.pcm")]
    for path in paths:
        pcm = path.read_bytes()
        print(f"\n=== {path.name} ({len(pcm)/(16000*2):.1f}s) ===")
        b = bench_batch(url, key, pcm)
        print(
            f"batch med={b['median_s']:.2f}s RTF={b['rtf']:.2f} text={b['text'][:100]!r}"
        )
        s = bench_stream(url, key, pcm)
        print(
            f"stream Stop→text={s['stop_s']:.2f}s mode={s.get('mode')} "
            f"serverMs={s.get('server_latency_ms')} text={s['text'][:100]!r}"
        )


if __name__ == "__main__":
    main()
