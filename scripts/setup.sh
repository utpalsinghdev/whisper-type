#!/bin/bash
# One-time local setup (no Docker). Run from the repo root.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> WishperType local setup"

if ! command -v python3 &>/dev/null; then
  echo "Error: python3 not found. Install Python 3.9+ first."
  exit 1
fi

if [ ! -d ".venv" ]; then
  echo "==> Creating Python virtual environment"
  python3 -m venv .venv
fi

# shellcheck disable=SC1091
source .venv/bin/activate

echo "==> Installing Python dependencies"
pip install -q --upgrade pip
pip install -q "setuptools<70"
pip install -q -r poc/requirements.txt
pip install -q torch --index-url https://download.pytorch.org/whl/cpu

echo "==> Downloading default Whisper model (base.en)"
PYTHONPATH="backend:." python poc/bootstrap_model.py base.en

if ! command -v rustc &>/dev/null; then
  echo ""
  echo "Note: Rust not found. Install from https://rustup.rs then run:"
  echo "  cd app && npm install && npm run dev"
  exit 0
fi

if ! command -v node &>/dev/null; then
  echo ""
  echo "Note: Node.js not found. Install Node 18+ then run:"
  echo "  cd app && npm install && npm run dev"
  exit 0
fi

echo "==> Installing Node dependencies"
cd app
npm install

echo ""
echo "Done! Start the desktop app with:"
echo "  cd app"
echo "  export CARGO_TARGET_DIR=/tmp/wishper-type-target"
echo "  npm run dev"
