-- media-reader schema
-- Single DB, three tables. `videos` row IS the job queue.

CREATE TABLE IF NOT EXISTS channels (
    id              TEXT PRIMARY KEY,    -- source id (YouTube UC..., local uploads, etc.)
    handle          TEXT,                -- @handle if known
    title           TEXT,
    url             TEXT NOT NULL,       -- canonical URL as user provided it
    added_at        TEXT NOT NULL DEFAULT (datetime('now')),
    video_count     INTEGER,             -- discovered count
    status          TEXT NOT NULL        -- 'listing' | 'ready' | 'error'
);

CREATE TABLE IF NOT EXISTS videos (
    id                  TEXT PRIMARY KEY,    -- source video id or upload id
    channel_id          TEXT NOT NULL REFERENCES channels(id),
    title               TEXT,
    published_at        TEXT,
    duration_sec        INTEGER,
    url                 TEXT NOT NULL,
    source_type         TEXT,                -- 'url' | 'upload'
    original_filename   TEXT,
    uploaded_path       TEXT,                -- app data path for local uploads
    mime_type           TEXT,
    file_size_bytes     INTEGER,
    transcript_source   TEXT,                -- 'captions' | 'whisper' | null
    transcript          TEXT,                -- plain text
    tldr                TEXT,                -- markdown
    article             TEXT,                -- markdown
    cost_usd            REAL,
    llm_model           TEXT,
    transcript_tokens_est INTEGER,
    input_tokens_est    INTEGER,
    output_tokens_est   INTEGER,
    total_tokens_est    INTEGER,
    cost_usd_est        REAL,
    cost_estimate_method TEXT,
    article_prompt_version TEXT,
    article_regenerated_at TEXT,
    read_at             TEXT,
    reading_progress    REAL NOT NULL DEFAULT 0,
    state               TEXT NOT NULL DEFAULT 'queued',
    -- queued | fetching | transcribing | writing | done | error
    error               TEXT,
    added_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_videos_state ON videos(state);
CREATE INDEX IF NOT EXISTS idx_videos_channel ON videos(channel_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_videos_library ON videos(state, published_at DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS transcript_segments (
    video_id   TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    sequence   INTEGER NOT NULL CHECK (sequence >= 0),
    start_ms   INTEGER NOT NULL CHECK (start_ms >= 0),
    end_ms     INTEGER CHECK (end_ms IS NULL OR end_ms >= start_ms),
    text       TEXT NOT NULL CHECK (length(trim(text)) > 0),
    source     TEXT NOT NULL,
    PRIMARY KEY (video_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_transcript_segments_video
    ON transcript_segments(video_id, sequence);

CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT NOT NULL DEFAULT (datetime('now')),
    video_id    TEXT,
    channel_id  TEXT,
    level       TEXT,                    -- info | warn | error
    msg         TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);
