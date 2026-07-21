# WishperType remote transcription backend

NestJS HTTP + Socket.IO service that runs **whisper.cpp** on a VPS so the Mac app does not load Whisper into local RAM.

Includes a Prisma + SQLite **dashboard** (`/dashboard`) with first-login admin bootstrap and session logs.

The SQLite file lives only on the server volume (`/app/data/wishpertype.db`) — it is gitignored. Schema migrations in `prisma/migrations/` are committed; on boot the container runs `prisma migrate deploy` to create/update the DB on that host.

## Quick start (Docker)

From the **repo root**:

```bash
cp backend/nestjs/.env.example .env   # optional — set SESSION_SECRET / API_KEY
docker compose up --build -d
curl http://127.0.0.1:3003/health
open http://127.0.0.1:3003/dashboard
```

First boot downloads the configured ggml model (default `medium.en`) into the `whisper_models` volume.

## Models (VPS)

| Model | Approx size | Notes |
|-------|-------------|--------|
| `tiny.en` | ~75 MB | Fastest, least accurate |
| `base.en` | ~142 MB | Light |
| `small.en` | ~466 MB | Good balance |
| `medium.en` | ~1.5 GB | **Default** — strong accuracy on 16GB RAM |
| `large-v3-turbo` | ~1.6 GB | Near-large quality, faster |
| `large-v3` | ~3 GB | Max accuracy; fine with 16GB RAM + swap |

Set `WHISPER_MODEL` in `.env` / compose, or pick in the desktop app (remote mode downloads on the server on first use).

With 4 CPU cores keep `WHISPER_THREADS=4`.

## Dashboard login

1. Open `/dashboard/login`.
2. If the DB has **no users**, the first email + password you submit **creates the only admin account**.
3. After that, only that account can sign in — no further users can be created.

## API

| Method | Path | Notes |
|--------|------|--------|
| GET | `/health` | Liveness + model info |
| GET | `/ready` | Model loaded? |
| POST | `/transcribe_pcm_chunk` | Multipart: `files` (16 kHz mono s16le PCM), optional `model_name` |
| GET | `/dashboard` | Stats + session log (auth required) |
| WS | `/socket.io` | Events: `session:start`, `audio:chunk`, `session:end` → `result` |

Auth for transcribe (optional): set `API_KEY` and send `X-API-Key` or `Authorization: Bearer …`.

Response shape matches the legacy Python server: `{ "text": "…" }`.

## Desktop app

In WishperType Settings → **Backend**, set:

- Mode: **Remote**
- URL: `http://YOUR_VPS_IP:3003` (or `http://127.0.0.1:3003` for local Docker)
- API key: same as `API_KEY` if set
