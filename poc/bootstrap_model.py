"""Download Whisper weights into backend/wispertype/models.

Usage: python poc/bootstrap_model.py [model_name]
model_name defaults to base.en (e.g. tiny.en, base.en, small.en).

Emits PROGRESS lines on stdout for the desktop UI.
"""

from __future__ import annotations

import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = ROOT / "backend" / "wispertype" / "models"


def log(msg: str) -> None:
    print(msg, flush=True)


def main() -> None:
    # Emit immediately — importing whisper can take several seconds.
    log("PROGRESS:0")

    name = sys.argv[1] if len(sys.argv) > 1 else "base.en"
    dest = MODELS_DIR / f"{name}.pt"

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    if dest.is_file():
        log("PROGRESS:100")
        log(f"Model already present: {dest}")
        return

    log("PROGRESS:1")
    import whisper  # noqa: PLC0415 — deferred so UI gets early progress

    urls = getattr(whisper, "_MODELS", {})
    url = urls.get(name)
    if not url:
        log(f"Unknown model: {name}")
        sys.exit(1)

    log("PROGRESS:2")
    log(f"Downloading {name}…")
    tmp = dest.with_suffix(".pt.part")
    try:
        with urllib.request.urlopen(url) as resp:
            total = int(resp.headers.get("Content-Length", 0))
            downloaded = 0
            last_pct = -1
            with open(tmp, "wb") as out:
                while True:
                    chunk = resp.read(1 << 20)
                    if not chunk:
                        break
                    out.write(chunk)
                    downloaded += len(chunk)
                    if total:
                        pct = max(3, int(downloaded * 100 / total))
                        if pct != last_pct:
                            log(f"PROGRESS:{pct}")
                            last_pct = pct
                    elif downloaded % (5 << 20) < (1 << 20):
                        # Unknown size — pulse progress so UI doesn't look stuck.
                        log(f"PROGRESS:{min(95, 3 + (downloaded >> 20) % 90)}")
        os.replace(tmp, dest)
    except Exception as err:  # noqa: BLE001
        if tmp.exists():
            tmp.unlink(missing_ok=True)
        log(f"Download failed: {err}")
        sys.exit(1)

    log("PROGRESS:100")
    log(f"Installed model at {dest}")


if __name__ == "__main__":
    main()
