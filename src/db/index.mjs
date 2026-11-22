import { Database } from 'bun:sqlite';
import { readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { dbPath } from '../shared/paths.mjs';
import { normalizeTranscriptSegments } from '../transcripts/segments.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db;

const VIDEO_MIGRATIONS = [
    ['llm_model', 'TEXT'],
    ['transcript_tokens_est', 'INTEGER'],
    ['input_tokens_est', 'INTEGER'],
    ['output_tokens_est', 'INTEGER'],
    ['total_tokens_est', 'INTEGER'],
    ['cost_usd_est', 'REAL'],
    ['cost_estimate_method', 'TEXT'],
    ['article_prompt_version', 'TEXT'],
    ['article_regenerated_at', 'TEXT'],
    ['source_type', 'TEXT'],
    ['original_filename', 'TEXT'],
    ['uploaded_path', 'TEXT'],
    ['mime_type', 'TEXT'],
    ['file_size_bytes', 'INTEGER'],
    ['read_at', 'TEXT'],
    ['reading_progress', 'REAL NOT NULL DEFAULT 0'],
    ['article_language', 'TEXT'],
];

const ACTIVE_VIDEO_STATES = ['queued', 'fetching', 'transcribing', 'writing'];

function ensureVideoColumns(database) {
    const existing = new Set(database.prepare('PRAGMA table_info(videos)').all().map(col => col.name));
    for (const [name, type] of VIDEO_MIGRATIONS) {
        if (!existing.has(name)) database.exec(`ALTER TABLE videos ADD COLUMN ${name} ${type}`);
    }
}

export function getDb() {
    if (!db) {
        const DB_PATH = dbPath();
        mkdirSync(dirname(DB_PATH), { recursive: true });
        db = new Database(DB_PATH);
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA busy_timeout = 5000');
        db.exec('PRAGMA foreign_keys = ON');
        const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
        db.exec(schema);
        ensureVideoColumns(db);
    }
    return db;
}

// ─── Channels ───────────────────────────────────────────────

export function upsertChannel({ id, handle, title, url, status = 'listing' }) {
    getDb().prepare(`
        INSERT INTO channels (id, handle, title, url, status)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            handle = COALESCE(excluded.handle, channels.handle),
            title  = COALESCE(excluded.title,  channels.title),
            url    = excluded.url,
            status = excluded.status
    `).run(id, handle || null, title || null, url, status);
}

export function setChannelStatus(id, status, videoCount = null) {
    if (videoCount != null) {
        getDb().prepare('UPDATE channels SET status = ?, video_count = ? WHERE id = ?').run(status, videoCount, id);
    } else {
        getDb().prepare('UPDATE channels SET status = ? WHERE id = ?').run(status, id);
    }
}

export function getChannel(id) {
    return getDb().prepare('SELECT * FROM channels WHERE id = ?').get(id);
}

export function listChannels() {
    return getDb().prepare(`
        SELECT c.*,
            (SELECT COUNT(*) FROM videos v WHERE v.channel_id = c.id) AS videos_total,
            (SELECT COUNT(*) FROM videos v WHERE v.channel_id = c.id AND v.state = 'done') AS videos_done,
            (SELECT COUNT(*) FROM videos v WHERE v.channel_id = c.id AND v.state = 'error') AS videos_error
        FROM channels c
        ORDER BY c.added_at DESC
    `).all();
}

export function deleteChannel(id) {
    const db = getDb();
    const tx = db.transaction((channelId) => {
        const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
        if (!channel) return null;

        const videos = db.prepare('SELECT id, uploaded_path FROM videos WHERE channel_id = ?').all(channelId);
        for (const v of videos) {
            db.prepare('DELETE FROM events WHERE video_id = ?').run(v.id);
        }
        db.prepare('DELETE FROM events WHERE channel_id = ?').run(channelId);
        db.prepare('DELETE FROM videos WHERE channel_id = ?').run(channelId);
        db.prepare('DELETE FROM channels WHERE id = ?').run(channelId);

        return {
            channel,
            videoIds: videos.map(v => v.id),
            uploadedPaths: videos.map(v => v.uploaded_path).filter(Boolean),
        };
    });
    return tx(id);
}

// ─── Videos ─────────────────────────────────────────────────

export function upsertVideoQueued({
    id,
    channelId,
    title,
    publishedAt,
    durationSec,
    url,
    sourceType = 'url',
    originalFilename = null,
    uploadedPath = null,
    mimeType = null,
    fileSizeBytes = null,
}) {
    const result = getDb().prepare(`
        INSERT INTO videos (
            id, channel_id, title, published_at, duration_sec, url,
            source_type, original_filename, uploaded_path, mime_type, file_size_bytes,
            state, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', datetime('now'))
        ON CONFLICT(id) DO NOTHING
    `).run(
        id,
        channelId,
        title || null,
        publishedAt || null,
        durationSec || null,
        url,
        sourceType,
        originalFilename,
        uploadedPath,
        mimeType,
        fileSizeBytes,
    );
    return result.changes > 0;
}

export function getVideo(id) {
    return getDb().prepare('SELECT * FROM videos WHERE id = ?').get(id);
}

export function getTranscriptSegments(videoId) {
    return getDb().prepare(`
        SELECT start_ms, end_ms, text, source
        FROM transcript_segments
        WHERE video_id = ?
        ORDER BY sequence ASC
    `).all(videoId).map(row => ({
        startMs: row.start_ms,
        endMs: row.end_ms,
        text: row.text,
        source: row.source,
    }));
}

export function replaceVideoTranscript(videoId, transcript) {
    const database = getDb();
    const segments = normalizeTranscriptSegments(transcript?.segments);
    const source = String(transcript?.source || '');
    const text = String(transcript?.text || '').replace(/\s+/g, ' ').trim();
    const replace = database.transaction(() => {
        const updated = database.prepare(`
            UPDATE videos
            SET transcript = ?, transcript_source = ?, updated_at = datetime('now')
            WHERE id = ?
        `).run(text, source || null, videoId);
        if (updated.changes === 0) throw new Error(`video not found: ${videoId}`);

        database.prepare('DELETE FROM transcript_segments WHERE video_id = ?').run(videoId);
        const insert = database.prepare(`
            INSERT INTO transcript_segments (video_id, sequence, start_ms, end_ms, text, source)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        segments.forEach((segment, sequence) => {
            insert.run(videoId, sequence, segment.startMs, segment.endMs, segment.text, source);
        });
    });
    replace();
}

export function setVideoPublishedAtIfMissing(id, publishedAt) {
    if (!publishedAt) return false;
    return getDb().prepare(`
        UPDATE videos
        SET published_at = ?
        WHERE id = ? AND (published_at IS NULL OR trim(published_at) = '')
    `).run(publishedAt, id).changes > 0;
}

export function listVideosForChannel(channelId) {
    return getDb().prepare(`
        SELECT id, channel_id, title, published_at, duration_sec, url,
               source_type, original_filename, mime_type, file_size_bytes,
               transcript_source, state, error, cost_usd, llm_model,
               transcript_tokens_est, input_tokens_est, output_tokens_est,
               total_tokens_est, cost_usd_est, cost_estimate_method, updated_at,
               read_at, reading_progress,
               (tldr IS NOT NULL) AS has_tldr,
               (article IS NOT NULL) AS has_article
        FROM videos
        WHERE channel_id = ?
        ORDER BY published_at DESC, id DESC
    `).all(channelId);
}

export function listLibraryVideos({
    limit = 50,
    offset = 0,
    filter = 'all',
    channelId = null,
    query = '',
    sort = 'newest',
} = {}) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const where = [];
    const args = [];

    if (channelId) {
        where.push('v.channel_id = ?');
        args.push(channelId);
    }
    if (filter === 'unread') {
        where.push("v.state = 'done' AND v.read_at IS NULL");
    } else if (filter === 'processing') {
        where.push(`v.state IN (${ACTIVE_VIDEO_STATES.map(() => '?').join(',')})`);
        args.push(...ACTIVE_VIDEO_STATES);
    } else if (filter === 'done') {
        where.push("v.state = 'done'");
    } else if (filter === 'error') {
        where.push("v.state = 'error'");
    }
    const normalizedQuery = String(query || '').trim().toLowerCase();
    if (normalizedQuery) {
        where.push("(lower(COALESCE(v.title, '')) LIKE ? OR lower(COALESCE(v.tldr, '')) LIKE ?)");
        const pattern = `%${normalizedQuery}%`;
        args.push(pattern, pattern);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const direction = sort === 'oldest' ? 'ASC' : 'DESC';
    const db = getDb();
    const total = db.prepare(`SELECT COUNT(*) AS count FROM videos v ${whereSql}`).get(...args).count;
    const videos = db.prepare(`
        SELECT v.id, v.channel_id, v.title, v.published_at, v.duration_sec, v.url,
               v.source_type, v.original_filename, v.mime_type, v.file_size_bytes,
               v.transcript_source, v.state, v.error, v.cost_usd, v.llm_model,
               v.transcript_tokens_est, v.input_tokens_est, v.output_tokens_est,
               v.total_tokens_est, v.cost_usd_est, v.cost_estimate_method,
               v.updated_at, v.read_at, v.reading_progress, v.tldr,
               (v.article IS NOT NULL) AS has_article,
               c.title AS channel_title, c.handle AS channel_handle
        FROM videos v
        JOIN channels c ON c.id = v.channel_id
        ${whereSql}
        ORDER BY
            CASE WHEN v.state IN ('queued','fetching','transcribing','writing') THEN 0
                 WHEN v.state = 'error' THEN 1 ELSE 2 END ASC,
            COALESCE(v.published_at, v.updated_at, v.added_at) ${direction},
            v.id ${direction}
        LIMIT ? OFFSET ?
    `).all(...args, safeLimit, safeOffset);

    return { videos, total, limit: safeLimit, offset: safeOffset };
}

export function libraryCounts() {
    return getDb().prepare(`
        SELECT COUNT(*) AS all_count,
               SUM(CASE WHEN state = 'done' AND read_at IS NULL THEN 1 ELSE 0 END) AS unread_count,
               SUM(CASE WHEN state IN ('queued','fetching','transcribing','writing') THEN 1 ELSE 0 END) AS processing_count,
               SUM(CASE WHEN state = 'done' THEN 1 ELSE 0 END) AS done_count,
               SUM(CASE WHEN state = 'error' THEN 1 ELSE 0 END) AS error_count
        FROM videos
    `).get();
}

export function setVideoRead(id, read) {
    return getDb().prepare(
        `UPDATE videos SET read_at = ${read ? "datetime('now')" : 'NULL'} WHERE id = ?`
    ).run(id).changes > 0;
}

export function setVideoReadingProgress(id, progress) {
    const normalized = Math.max(0, Math.min(1, Number(progress)));
    if (!Number.isFinite(normalized)) return false;
    return getDb().prepare(`
        UPDATE videos
        SET reading_progress = ?
        WHERE id = ?
    `).run(normalized, id).changes > 0;
}

export function listYoutubeAuthBlockedVideos() {
    return getDb().prepare(`
        SELECT id, channel_id, title, source_type
        FROM videos
        WHERE state = 'error'
          AND error LIKE 'YouTube audio download is blocked by authentication/bot checks.%'
        ORDER BY updated_at ASC
    `).all();
}

export function claimNextVideo(states) {
    // Pick the oldest-added video in one of the given states.
    const placeholders = states.map(() => '?').join(',');
    return getDb().prepare(
        `SELECT * FROM videos WHERE state IN (${placeholders}) ORDER BY added_at ASC LIMIT 1`
    ).get(...states);
}

export function setVideoState(id, state, extra = {}) {
    const sets = ['state = ?', "updated_at = datetime('now')"];
    const args = [state];
    for (const [k, v] of Object.entries(extra)) {
        sets.push(`${k} = ?`);
        args.push(v);
    }
    args.push(id);
    getDb().prepare(`UPDATE videos SET ${sets.join(', ')} WHERE id = ?`).run(...args);
}

export function setVideoError(id, error) {
    getDb().prepare(
        "UPDATE videos SET state = 'error', error = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(String(error).slice(0, 2000), id);
}

// Re-queue a finished video to rewrite its article in `language`; the stored
// transcript is reused, so only the article step runs again.
export function rewriteVideoArticle(id, language) {
    getDb().prepare(
        "UPDATE videos SET article_language = ?, state = 'queued', error = NULL, updated_at = datetime('now') WHERE id = ?"
    ).run(language, id);
}

export function retryVideo(id) {
    getDb().prepare(
        "UPDATE videos SET state = 'queued', error = NULL, updated_at = datetime('now') WHERE id = ?"
    ).run(id);
}

export function deleteVideo(id) {
    const db = getDb();
    const tx = db.transaction((videoId) => {
        const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
        if (!video) return null;

        db.prepare('DELETE FROM events WHERE video_id = ?').run(videoId);
        db.prepare('DELETE FROM videos WHERE id = ?').run(videoId);

        return video;
    });
    return tx(id);
}

// ─── Events ─────────────────────────────────────────────────

export function logEvent(level, msg, { videoId = null, channelId = null } = {}) {
    getDb().prepare(
        'INSERT INTO events (level, msg, video_id, channel_id) VALUES (?, ?, ?, ?)'
    ).run(level, msg, videoId, channelId);
}

export function recentEvents(limit = 200) {
    return getDb().prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
}
