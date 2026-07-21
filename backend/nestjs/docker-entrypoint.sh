#!/bin/sh
set -e

DATA_DIR="$(dirname "${DATABASE_PATH:-/app/data/wishpertype.db}")"
mkdir -p "$DATA_DIR"

# Create/update SQLite schema on this host — DB file stays on the volume, never in git.
npx prisma migrate deploy

exec node dist/main.js
