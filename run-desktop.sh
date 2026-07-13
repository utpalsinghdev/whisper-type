#!/bin/bash
# Run WishperType desktop app in dev mode.
# Usage:
#   ./run-desktop.sh          # local Python backend (auto-setup on first run)
#   ./run-desktop.sh --docker # use Docker for transcription server only
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/tmp/wishper-type-target}"

USE_DOCKER=false
for arg in "$@"; do
  case "$arg" in
    --docker|-d) USE_DOCKER=true ;;
    -h|--help)
      echo "Usage: ./run-desktop.sh [--docker]"
      echo ""
      echo "  --docker  Start transcription API via docker compose (skip local Python)"
      exit 0
      ;;
  esac
done

if [ "$USE_DOCKER" = true ]; then
  if ! command -v docker &>/dev/null; then
    echo "Error: docker not found. Install Docker or run without --docker."
    exit 1
  fi
  echo "==> Starting transcription server (Docker)…"
  docker compose up -d --build
  echo "    API: http://127.0.0.1:19527/health"
else
  if [ ! -d "$ROOT/.venv" ]; then
    echo "==> First run: setting up Python environment…"
    "$ROOT/scripts/setup.sh"
  fi

  if [ ! -f "$ROOT/backend/wispertype/models/base.en.pt" ]; then
    echo "==> Downloading default Whisper model (base.en)…"
    PYTHONPATH="$ROOT/backend:$ROOT" "$ROOT/.venv/bin/python3" \
      "$ROOT/poc/bootstrap_model.py" base.en
  fi
fi

echo "==> Installing Node dependencies (if needed)…"
cd "$ROOT/app"
npm install

echo "==> Starting WishperType (dev)…"
echo "    Hotkey: Cmd+Shift+R (macOS) / Ctrl+Shift+R (other)"
echo "    Press Ctrl+C to stop"
echo ""

npm run dev
