#!/bin/sh
set -euo pipefail

MODEL="${WT_MODEL:-base.en}"
MODEL="${MODEL%.pt}"

echo "WishperType: preparing model ${MODEL}…"
python poc/bootstrap_model.py "$MODEL"

echo "WishperType: starting server on :19527"
exec python -m uvicorn poc.serve:app --host 0.0.0.0 --port 19527
