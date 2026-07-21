# WishperType remote transcription backend

NestJS HTTP + Socket.IO service that runs **whisper.cpp** on a VPS so the Mac app does not load Whisper into local RAM.

## Quick start (Docker)

From the **repo root**:

```bash
cp backend/nestjs/.env.example .env   # optional
docker compose up --build -d
curl http://127.0.0.1:3000/health
```

First boot downloads `ggml-base.en.bin` into the `whisper_models` volume (can take a minute).

## API

| Method | Path | Notes |
|--------|------|--------|
| GET | `/health` | Liveness + model info |
| GET | `/ready` | Model loaded? |
| POST | `/transcribe_pcm_chunk` | Multipart: `files` (16 kHz mono s16le PCM), optional `model_name` |
| WS | `/socket.io` | Events: `session:start`, `audio:chunk`, `session:end` → `result` |

Auth (optional): set `API_KEY` and send `X-API-Key` or `Authorization: Bearer …`.

Response shape matches the legacy Python server: `{ "text": "…" }`.

## Local Node (without Docker)

Requires `ffmpeg` and `whisper-cli` on PATH, plus models in `./models`.

```bash
cd backend/nestjs
npm install
npm run start:dev
```

## Desktop app

In WishperType Settings → **Backend**, set:

- Mode: **Remote**
- URL: `http://YOUR_VPS_IP:3000` (or `http://127.0.0.1:3000` for local Docker)
- API key: same as `API_KEY` if set
