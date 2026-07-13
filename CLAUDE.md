# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

WishperType is a cross-platform voice-typing utility: a global hotkey opens a floating "capsule" overlay, records the microphone, transcribes speech locally with OpenAI Whisper, and pastes the result into whatever app was focused. The repo is three independently-deployable pieces:

- `app/` — Tauri 2 desktop shell (Rust in `app/src-tauri`, vanilla JS/HTML/CSS in `app/src`). Owns the global hotkey, tray menu, window management, clipboard/paste simulation, and settings persistence.
- `backend/wispertype/` — Python FastAPI transcription service wrapping `openai-whisper`.
- `poc/` — glue code: `serve.py` (CORS-wrapped ASGI entrypoint), `bootstrap_model.py` (downloads Whisper weights with progress reporting), `entrypoint.sh` (Docker entrypoint).

## Commands

Desktop app (from `app/`):
```bash
npm install
export CARGO_TARGET_DIR=/tmp/wishper-type-target   # avoid building on slow/external drives
npm run dev      # tauri dev — launches the app with hot reload
npm run build    # tauri build — installer output: $CARGO_TARGET_DIR/release/bundle/
```

Transcription backend, local (from repo root, no Docker):
```bash
./scripts/setup.sh                 # creates .venv, installs deps, downloads the base.en model
source .venv/bin/activate
PYTHONPATH=backend:. python -m uvicorn poc.serve:app --host 127.0.0.1 --port 19527
```

Transcription backend, Docker:
```bash
docker compose up --build          # serves on :19527, model weights persisted in a named volume
```

Download/verify a specific Whisper model manually:
```bash
PYTHONPATH=backend:. python poc/bootstrap_model.py small.en   # tiny.en | base.en | small.en
```

There is no test suite, linter, or type checker configured in this repo currently.

## Architecture

### Process model
The Rust side orchestrates everything. On first hotkey press (and once at app startup, off the main thread) it spawns the Python server as a child process (`spawn_transcription_server` in `app/src-tauri/src/lib.rs`), preferring `.venv/bin/python3` over the system `python3`. It polls `GET /health` before treating the server as ready and restarts it if the child died. Functionally identical: a server already running via `docker compose` on the same port (19527) — the app just detects it's healthy and skips spawning its own.

### Recording → transcription → paste flow
1. The global shortcut (`CommandOrControl+Shift+R`) toggles `toggle_recording` in Rust, which records the PID of the frontmost app (macOS, via `NSWorkspace`) so focus can be restored later, shows the transparent `capsule` window, and emits a `session-start` event.
2. `app/src/main.js` captures mic audio with the Web Audio API, downsamples it to 16 kHz mono in JS, and buffers raw Int16 PCM client-side. Nothing is sent to the server while recording is in progress.
3. On stop (Enter, Escape, stop button, or hotkey again), the full buffered recording is merged into one blob and POSTed once as multipart form data to `/transcribe_pcm_chunk` (`backend/wispertype/fast_server.py`), which runs `whisper.transcribe` synchronously inside a thread-pool executor.
4. The returned text is put on the clipboard, the previously-frontmost app is reactivated, and Rust simulates Cmd/Ctrl+V (`enigo`) to paste it (`paste_text`).

**Important:** `backend/wispertype/streaming.py` and the `/ws` WebSocket endpoint implement a sliding-window session protocol for incremental *partial* transcription (`TranscribeSession`), but the shipped desktop frontend never opens that socket — it only calls the batch `/transcribe_pcm_chunk` endpoint after recording ends. This is a separate, currently-unwired code path, not dead code to prune without checking history/intent first.

### Model lifecycle
Whisper weights (`tiny.en` ~75MB, `base.en` ~145MB, `small.en` ~480MB) are gitignored (`*.pt`) and fetched on demand into `backend/wispertype/models/`. `poc/bootstrap_model.py` prints `PROGRESS:<pct>` lines to stdout as it downloads; Rust's `download_model` parses those lines and re-emits a `model-progress` Tauri event so the settings UI (`app/src/setup.js`) can render a live progress bar. `transcriber.py` caches one loaded model per model name in a process-wide dict guarded by a lock, so switching models in Settings keeps previously-used models warm in memory instead of reloading them from disk each time.

### Two windows, one tray
`app/src-tauri/tauri.conf.json` defines two windows: `main` (onboarding/settings, `setup.html`, shown at first launch and from the tray's "Settings…") and `capsule` (transparent, undecorated, always-on-top overlay, `index.html`, shown only while recording/transcribing). The tray menu (`tray_menu` in `lib.rs`) is rebuilt on every settings change to reflect the current mic, capsule position, theme, and model selections. There's no settings database — Rust reads/writes plain JSON (`settings.json`, `capsule.json`) in the Tauri app-config directory.

### Config
Backend runtime tuning is entirely env-var driven (`backend/wispertype/config.py`): `WT_MODEL`, `WT_SAMPLE_RATE`, `WT_MAX_UPLOAD_BYTES`, `WT_MAX_SESSIONS`, `WT_API_KEY`, `WT_TRANSCRIBE_TIMEOUT`, etc. There are no config files to edit.

### Inference
`poc/requirements.txt` pulls `openai-whisper`; both `scripts/setup.sh` and the `Dockerfile` explicitly install the CPU-only PyTorch wheel (`--index-url https://download.pytorch.org/whl/cpu`). `transcriber.get_model` will still move the model to CUDA if `torch.cuda.is_available()` on the host, but nothing in the shipped setup path installs a CUDA build, so in practice inference runs on CPU.
