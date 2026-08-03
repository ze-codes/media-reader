#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

echo "[ui-test] Isolated transcript reader QA"
bun ops/ui-transcript-reader.mjs

if [ "${MEDIA_READER_RUN_INTEGRATION_UI:-0}" = "1" ]; then
    echo "[ui-test] Local integration browser QA"
    bun ops/ui-test.mjs

    echo "[ui-test] Local mobile reader chrome"
    bun ops/ui-reader-chrome.mjs
fi
