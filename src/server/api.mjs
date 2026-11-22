import express from 'express';
import {
    getChannel, listChannels,
    deleteChannel, getVideo, listVideosForChannel, retryVideo, rewriteVideoArticle,
    deleteVideo, libraryCounts, listLibraryVideos, listYoutubeAuthBlockedVideos,
    getTranscriptSegments, setVideoRead, setVideoReadingProgress,
} from '../db/index.mjs';
import { clearVideoCache, reloadYoutubeAccess } from '../ingest/index.mjs';
import { log } from '../shared/log.mjs';
import {
    deleteUploadedMedia,
    LOCAL_UPLOADS_CHANNEL_URL,
    UPLOAD_SOURCE,
} from '../uploads/index.mjs';
import { ACTIVE_VIDEO_STATES, SSE_EVENTS } from '../domain/constants.mjs';
import { ARTICLE_LANGUAGES } from '../llm/index.mjs';
import { importChannelOrSingleVideo } from '../services/channel-imports.mjs';
import { resolveAndQueueSingleVideo } from '../services/video-submissions.mjs';
import {
    enrichVideoStatus,
    publicVideo,
    workerStatusForVideos,
} from '../services/worker-status.mjs';
import {
    appendUploadChunk,
    queueChunkedUpload,
    queueUploadedMedia,
    startChunkedUpload,
    uploadResponse,
} from '../services/uploads-service.mjs';
import { PUBLIC_DIR } from '../shared/paths.mjs';
import {
    maintenanceEnabled,
    rejectMaintenanceMutation,
    workerEnabled,
} from '../shared/runtime-flags.mjs';

export { workerStatusForVideos } from '../services/worker-status.mjs';

const sseClients = new Set();

export function broadcastSSE(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
        try { res.write(msg); } catch { sseClients.delete(res); }
    }
}

export function startServer(port) {
    const app = express();
    app.use(express.json({ limit: '64kb' }));
    app.use((req, res, next) => {
        res.setHeader('Content-Security-Policy', [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' https://fonts.gstatic.com",
            "img-src 'self' data: https:",
            "connect-src 'self'",
            "object-src 'none'",
            "base-uri 'none'",
            "frame-ancestors 'self'",
        ].join('; '));
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'same-origin');
        next();
    });
    app.use('/api', rejectMaintenanceMutation);
    app.use(express.static(PUBLIC_DIR));

    // ── Channels ─────────────────────────────────────
    app.get('/api/channels', (req, res) => {
        res.json({ channels: listChannels() });
    });

    app.post('/api/channels', async (req, res) => {
        const url = (req.body?.url || '').trim();
        if (!url) return res.status(400).json({ error: 'url required' });

        // Kick off channel listing in the background so the request returns
        // immediately. All progress is streamed via SSE.
        res.json({ ok: true });

        try {
            await importChannelOrSingleVideo(url, { broadcast: broadcastSSE });
        } catch (err) {
            log('error', 'api', `channel import failed: ${err.message}`);
            broadcastSSE(SSE_EVENTS.CHANNEL_ERROR, { url, error: err.message });
        }
    });

    app.get('/api/channels/:id/videos', (req, res) => {
        const ch = getChannel(req.params.id);
        if (!ch) return res.status(404).json({ error: 'not found' });
        const videos = listVideosForChannel(req.params.id);
        const workerStatus = workerStatusForVideos(videos);
        res.json({
            channel: ch,
            videos: videos.map(v => enrichVideoStatus(v, workerStatus)),
            worker_status: workerStatus,
        });
    });

    app.get('/api/library', (req, res) => {
        const channelId = String(req.query.channel_id || '').trim() || null;
        if (channelId && !getChannel(channelId)) return res.status(404).json({ error: 'source not found' });
        const page = listLibraryVideos({
            limit: req.query.limit,
            offset: req.query.offset,
            filter: String(req.query.filter || 'all'),
            channelId,
            query: String(req.query.q || ''),
            sort: String(req.query.sort || 'newest'),
        });
        res.json({
            ...page,
            videos: page.videos.map(video => enrichVideoStatus(video)),
            counts: libraryCounts(),
        });
    });

    app.delete('/api/channels/:id', (req, res) => {
        const ch = getChannel(req.params.id);
        if (!ch) return res.status(404).json({ error: 'not found' });

        const videos = listVideosForChannel(req.params.id);
        const active = videos.filter(v => ACTIVE_VIDEO_STATES.has(v.state));
        if (active.length > 0) {
            return res.status(409).json({
                error: `cannot delete channel while ${active.length} transcript${active.length === 1 ? ' is' : 's are'} in progress`,
            });
        }

        const deleted = deleteChannel(req.params.id);
        for (const videoId of deleted.videoIds) clearVideoCache(videoId);
        for (const path of deleted.uploadedPaths || []) {
            deleteUploadedMedia({ source_type: UPLOAD_SOURCE, uploaded_path: path, url: LOCAL_UPLOADS_CHANNEL_URL });
        }

        broadcastSSE(SSE_EVENTS.CHANNEL_DELETED, {
            id: req.params.id,
            deletedVideos: deleted.videoIds.length,
        });
        log('info', 'api', `deleted channel ${ch.title || ch.id} (${deleted.videoIds.length} videos)`);
        res.json({ ok: true, deletedVideos: deleted.videoIds.length });
    });

    // ── Videos ───────────────────────────────────────
    // Submit a single video URL. Resolves channel info from the video and
    // attaches the video to that channel (creating the channel row with
    // status='single' if it doesn't exist — so we don't auto-crawl the rest).
    app.post('/api/videos', async (req, res) => {
        const url = (req.body?.url || '').trim();
        if (!url) return res.status(400).json({ error: 'url required' });

        res.json({ ok: true });

        try {
            await resolveAndQueueSingleVideo(url, { broadcast: broadcastSSE });
        } catch (err) {
            log('error', 'api', `resolveVideo failed: ${err.message}`);
            broadcastSSE(SSE_EVENTS.CHANNEL_ERROR, { url, error: err.message });
        }
    });

    app.post('/api/uploads', async (req, res) => {
        try {
            const upload = await queueUploadedMedia(req, { broadcast: broadcastSSE });
            res.json(uploadResponse(upload));
        } catch (err) {
            const status = err.status || 500;
            log(status >= 500 ? 'error' : 'warn', 'api', `upload failed: ${err.message}`);
            res.status(status).json({ error: err.message || 'upload failed' });
        }
    });

    // Large files come in chunks (each under the 100 MB proxy body cap): start,
    // append each chunk at its byte offset, then complete to queue it.
    const uploadError = (res, err) => {
        const status = err.status || 500;
        log(status >= 500 ? 'error' : 'warn', 'api', `upload failed: ${err.message}`);
        res.status(status).json({ error: err.message || 'upload failed', received: err.received });
    };

    app.post('/api/uploads/chunked', (req, res) => {
        try {
            res.json(startChunkedUpload(req.body || {}));
        } catch (err) {
            uploadError(res, err);
        }
    });

    app.post('/api/uploads/chunked/:id/chunk', async (req, res) => {
        try {
            res.json(await appendUploadChunk(req.params.id, req.query.offset, req));
        } catch (err) {
            uploadError(res, err);
        }
    });

    app.post('/api/uploads/chunked/:id/complete', (req, res) => {
        try {
            res.json(uploadResponse(queueChunkedUpload(req.params.id, { broadcast: broadcastSSE })));
        } catch (err) {
            uploadError(res, err);
        }
    });

    app.get('/api/videos/:id', (req, res) => {
        const v = getVideo(req.params.id);
        if (!v) return res.status(404).json({ error: 'not found' });
        const includeSegments = req.query.segments === '1';
        res.json({
            video: publicVideo(v, {
                includeTranscript: req.query.transcript === '1',
                includeSegments,
                segments: includeSegments ? getTranscriptSegments(v.id) : [],
            }),
        });
    });

    app.post('/api/videos/:id/read', (req, res) => {
        const v = getVideo(req.params.id);
        if (!v) return res.status(404).json({ error: 'not found' });
        const read = req.body?.read !== false;
        setVideoRead(req.params.id, read);
        res.json({ ok: true, read, read_at: read ? new Date().toISOString() : null });
    });

    app.post('/api/videos/:id/progress', (req, res) => {
        const v = getVideo(req.params.id);
        if (!v) return res.status(404).json({ error: 'not found' });
        const progress = Number(req.body?.progress);
        if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
            return res.status(400).json({ error: 'progress must be a number from 0 to 1' });
        }
        setVideoReadingProgress(req.params.id, progress);
        res.json({ ok: true, progress });
    });

    app.post('/api/videos/:id/retry', (req, res) => {
        const v = getVideo(req.params.id);
        if (!v) return res.status(404).json({ error: 'not found' });
        retryVideo(req.params.id);
        broadcastSSE(SSE_EVENTS.VIDEO_STATE, {
            id: req.params.id,
            state: 'queued',
            channelId: v.channel_id,
            title: v.title,
            source_type: v.source_type,
        });
        res.json({ ok: true });
    });

    app.post('/api/videos/:id/rewrite', (req, res) => {
        const v = getVideo(req.params.id);
        if (!v) return res.status(404).json({ error: 'not found' });
        const language = req.body?.language;
        if (!Object.hasOwn(ARTICLE_LANGUAGES, language)) {
            return res.status(400).json({ error: `language must be one of: ${Object.keys(ARTICLE_LANGUAGES).join(', ')}` });
        }
        if (ACTIVE_VIDEO_STATES.has(v.state)) return res.status(409).json({ error: 'video is still processing' });
        if (!v.transcript) return res.status(409).json({ error: 'no transcript to rewrite yet' });
        rewriteVideoArticle(req.params.id, language);
        broadcastSSE(SSE_EVENTS.VIDEO_STATE, {
            id: req.params.id,
            state: 'queued',
            channelId: v.channel_id,
            title: v.title,
            source_type: v.source_type,
        });
        res.json({ ok: true, language });
    });

    app.delete('/api/videos/:id', (req, res) => {
        const v = getVideo(req.params.id);
        if (!v) return res.status(404).json({ error: 'not found' });
        if (ACTIVE_VIDEO_STATES.has(v.state)) {
            return res.status(409).json({ error: `cannot delete transcript while it is ${v.state}` });
        }

        const deleted = deleteVideo(req.params.id);
        clearVideoCache(req.params.id);
        deleteUploadedMedia(deleted);

        broadcastSSE(SSE_EVENTS.VIDEO_DELETED, { id: req.params.id, channelId: deleted.channel_id });
        log('info', 'api', `deleted transcript ${v.title || v.id}`);
        res.json({ ok: true });
    });

    app.post('/api/youtube/reload-access', (req, res) => {
        const access = reloadYoutubeAccess();
        const blocked = listYoutubeAuthBlockedVideos();
        for (const video of blocked) {
            retryVideo(video.id);
            broadcastSSE(SSE_EVENTS.VIDEO_STATE, {
                id: video.id,
                state: 'queued',
                channelId: video.channel_id,
                title: video.title,
                source_type: video.source_type,
            });
        }
        log('info', 'api', `youtube access reloaded from ${access.source || 'no cookie source'}; retried ${blocked.length} blocked video(s)`);
        res.json({ ok: true, source: access.source, retried: blocked.length });
    });

    // ── SSE stream ───────────────────────────────────
    app.get('/api/stream', (req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
        sseClients.add(res);
        const keepalive = setInterval(() => { try { res.write(':\n\n'); } catch {} }, 30_000);
        req.on('close', () => {
            sseClients.delete(res);
            clearInterval(keepalive);
        });
    });

    app.get('/api/health', (req, res) => {
        res.json({
            ok: true,
            maintenance: maintenanceEnabled(),
            worker_enabled: workerEnabled(),
            ts: new Date().toISOString(),
        });
    });

    app.listen(port, '0.0.0.0', () => {
        log('info', 'api', `media-reader listening on port ${port}`);
    });
}
