#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

echo "[deploy] public-tree audit"
bun run audit:public

echo "[deploy] tests"
bun test

echo "[deploy] credential-free public smoke"
bun run smoke:public

echo "[deploy] validating Compose configuration"
docker compose config --quiet

if [ "${MEDIA_READER_DEPLOY_APPROVED:-0}" != "1" ]; then
  echo "[deploy] review the Compose configuration, then set MEDIA_READER_DEPLOY_APPROVED=1" >&2
  exit 2
fi

echo "[deploy] validating migrations"
./ops/migrate.sh

echo "[deploy] docker compose build"
docker compose build

echo "[deploy] refreshing app_node_modules volume"
docker compose run --rm media-reader bun install --frozen-lockfile

echo "[deploy] docker compose up -d"
docker compose up -d

echo "[deploy] containers"
docker compose ps

echo "[deploy] HTTP health"
./ops/smoke.sh
