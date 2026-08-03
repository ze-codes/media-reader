#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

echo "[test] bun test"
bun test

echo "[test] public smoke"
bun run smoke:public
