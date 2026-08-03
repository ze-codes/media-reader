#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

export MEDIA_READER_BASE_URL="${MEDIA_READER_BASE_URL:-http://127.0.0.1:8099}"

echo "[smoke] HTTP health"
bun -e '
  const base = new URL(process.env.MEDIA_READER_BASE_URL);
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const healthUrl = new URL("api/health", base);
  const response = await fetch(healthUrl);
  const body = await response.text();
  console.log(response.status, body);
  if (!response.ok) process.exit(1);
'
