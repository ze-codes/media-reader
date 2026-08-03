#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

echo "[migrate] initialize sqlite schema and idempotent columns"
bun -e "
  const { getDb } = await import('./src/db/index.mjs');
  const db = getDb();
  const columns = db.prepare('PRAGMA table_info(videos)').all().map(col => col.name);
  const required = [
    'llm_model',
    'transcript_tokens_est',
    'input_tokens_est',
    'output_tokens_est',
    'total_tokens_est',
    'cost_usd_est',
    'cost_estimate_method',
    'source_type',
    'original_filename',
    'uploaded_path',
    'mime_type',
    'file_size_bytes',
    'read_at',
    'reading_progress',
  ];
  const missing = required.filter(name => !columns.includes(name));
  if (missing.length) {
    console.error('missing migration columns:', missing.join(', '));
    process.exit(1);
  }
  console.log('videos columns:', columns.length);
"
