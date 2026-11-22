// State-machine worker. Pulls one video at a time out of the `videos` table
// and advances it through the pipeline. Crash-safe because state lives in
// SQLite — on restart, in-flight rows (fetching/transcribing/writing) are
// rolled back to `queued`.

import {
    setVideoState, setVideoError, getChannel,
    getDb, getTranscriptSegments, replaceVideoTranscript,
} from '../db/index.mjs';
import {
    fetchCaptions, fetchAudio, clearVideoCache, detectVideoSource,
    fetchTranscriptApiTranscript, YOUTUBE_AUDIO_BLOCKED_CODE,
} from '../ingest/index.mjs';
import { transcribeWav, ensureModel, modelAvailable, transcribeBackend } from '../transcripts/transcribe.mjs';
import { ARTICLE_PROMPT_VERSION, estimateTokenCount, transformTranscript } from '../llm/index.mjs';
import { log } from '../shared/log.mjs';
import { isUsableTranscript } from '../domain/transcript-quality.mjs';
import { isLocalUpload } from '../uploads/index.mjs';
import { SSE_EVENTS, TRANSCRIPT_SOURCES, VIDEO_STATES } from '../domain/constants.mjs';

let broadcast = () => {};
export function setBroadcaster(fn) { broadcast = fn; }

// Undo any in-flight state at startup so no video gets stuck.
export function resetInFlight() {
    const changed = getDb().prepare(
        "UPDATE videos SET state = 'queued', updated_at = datetime('now') WHERE state IN ('fetching','transcribing','writing')"
    ).run().changes;
    if (changed > 0) log('info', 'worker', `reset ${changed} in-flight videos to queued`);
}

function emitVideoState(video, state, extra = {}) {
    broadcast(SSE_EVENTS.VIDEO_STATE, {
        id: video.id,
        state,
        channelId: video.channel_id,
        title: video.title,
        source_type: video.source_type,
        ...extra,
    });
}

function transcriptMinLength(video) {
    return isLocalUpload(video) ? 40 : 200;
}

export function storedTranscriptResult(video, segments = []) {
    if (!isUsableTranscript(video.transcript, { minLength: transcriptMinLength(video) })) return null;
    return {
        text: video.transcript,
        source: video.transcript_source || TRANSCRIPT_SOURCES.STORED,
        segments: segments.map(segment => ({
            startMs: segment.startMs,
            endMs: segment.endMs,
            text: segment.text,
        })),
    };
}

function storedTranscript(video) {
    return storedTranscriptResult(video, getTranscriptSegments(video.id));
}

async function fetchTranscript(video) {
    const stored = storedTranscript(video);
    if (stored) return stored;

    const youtube = detectVideoSource(video.url) === 'youtube';
    if (youtube) {
        try {
            const transcript = await fetchTranscriptApiTranscript(video);
            if (transcript) {
                log('info', 'worker', `TranscriptAPI transcript found for ${video.id}`, { videoId: video.id });
                return transcript;
            }
        } catch (err) {
            log('warn', 'worker', `TranscriptAPI fetch failed for ${video.id}: ${err.message}`, { videoId: video.id });
        }
    }

    try {
        const transcript = await fetchCaptions(video);
        if (transcript) return transcript;
    } catch (err) {
        log('warn', 'worker', `captions fetch failed for ${video.id}: ${err.message}`, { videoId: video.id });
    }

    return null;
}

async function transcribeVideoAudio(video) {
    setVideoState(video.id, VIDEO_STATES.TRANSCRIBING);
    emitVideoState(video, VIDEO_STATES.TRANSCRIBING, {
        transcript_source: TRANSCRIPT_SOURCES.WHISPER,
    });
    const localUpload = isLocalUpload(video);
    log('info', 'worker', `${localUpload ? 'uploaded file' : 'no captions'}, transcribing ${video.id} via ${transcribeBackend()}`, { videoId: video.id });

    try {
        if (!modelAvailable()) await ensureModel();
        const wavPath = await fetchAudio(video);
        const transcript = await transcribeWav(wavPath);
        return {
            ...transcript,
            source: TRANSCRIPT_SOURCES.WHISPER,
        };
    } catch (err) {
        clearVideoCache(video.id);
        if (err?.code === YOUTUBE_AUDIO_BLOCKED_CODE) throw err;
        throw new Error(`transcription failed: ${err.message}`);
    }
}

async function getUsableTranscript(video) {
    let transcript = await fetchTranscript(video);
    if (!transcript) transcript = await transcribeVideoAudio(video);

    if (!isUsableTranscript(transcript?.text, { minLength: transcriptMinLength(video) })) {
        clearVideoCache(video.id);
        throw new Error('transcript too short, empty, or placeholder-only');
    }
    return transcript;
}

async function writeArticle(video, channelTitle, transcript) {
    setVideoState(video.id, VIDEO_STATES.WRITING, {
        error: null,
    });
    emitVideoState(video, VIDEO_STATES.WRITING, {
        transcript_source: transcript.source,
    });

    return transformTranscript({
        title: video.title,
        channel: channelTitle,
        transcript: transcript.text,
        language: video.article_language || null,
    });
}

function completeVideo(video, transcript, result) {
    const { tldr, article, cost } = result;
    setVideoState(video.id, VIDEO_STATES.DONE, {
        tldr,
        article,
        cost_usd: cost?.costUsd || 0,
        llm_model: cost?.model || null,
        transcript_tokens_est: estimateTokenCount(transcript.text),
        input_tokens_est: cost?.inputTokens || null,
        output_tokens_est: cost?.outputTokens || null,
        total_tokens_est: cost?.totalTokens || null,
        cost_usd_est: cost?.costUsd || null,
        cost_estimate_method: cost?.estimated ? cost?.estimateMethod || 'estimated' : 'reported',
        article_prompt_version: ARTICLE_PROMPT_VERSION,
        article_regenerated_at: new Date().toISOString(),
        error: null,
    });
    clearVideoCache(video.id);
    broadcast(SSE_EVENTS.VIDEO_DONE, {
        id: video.id,
        channelId: video.channel_id,
        title: video.title,
        cost_usd: cost?.costUsd || 0,
        transcript_source: transcript.source,
        source_type: video.source_type,
    });
    log('info', 'worker', `done ${video.id} — $${(cost?.costUsd || 0).toFixed(4)} ${cost?.estimated ? 'est. ' : ''}(${transcript.source}, ${cost?.model || 'unknown model'})`, { videoId: video.id });
}

async function processOne(video) {
    const ch = getChannel(video.channel_id);
    const channelTitle = ch?.title || video.channel_id;

    setVideoState(video.id, VIDEO_STATES.FETCHING);
    emitVideoState(video, VIDEO_STATES.FETCHING);

    const transcript = await getUsableTranscript(video);
    replaceVideoTranscript(video.id, transcript);
    const result = await writeArticle(video, channelTitle, transcript);
    completeVideo(video, transcript, result);
}

// ── Main loop ──────────────────────────────────────────
// Single-concurrency worker. Poll every 2s when idle.

let running = false;
let stopRequested = false;
const YOUTUBE_JOB_DELAY_MS = Number(process.env.YT_YOUTUBE_JOB_DELAY_MS || 15_000);
function wait(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function delayAfterYoutubeJob(video) {
    if (YOUTUBE_JOB_DELAY_MS > 0 && detectVideoSource(video?.url) === 'youtube') {
        await wait(YOUTUBE_JOB_DELAY_MS);
    }
}

function nextQueuedVideo() {
    return getDb().prepare(
        "SELECT * FROM videos WHERE state = 'queued' ORDER BY added_at ASC LIMIT 1"
    ).get() || null;
}

export async function workerLoop() {
    if (running) return;
    running = true;
    log('info', 'worker', 'worker loop started');

    while (!stopRequested) {
        const video = nextQueuedVideo();
        if (!video) {
            await wait(2000);
            continue;
        }
        try {
            await processOne(video);
            await delayAfterYoutubeJob(video);
        } catch (err) {
            const msg = err?.message || String(err);
            if (err?.code === YOUTUBE_AUDIO_BLOCKED_CODE) {
                setVideoError(video.id, msg);
                broadcast(SSE_EVENTS.VIDEO_ERROR, {
                    id: video.id,
                    channelId: video.channel_id,
                    title: video.title,
                    error: msg,
                });
                log('warn', 'worker', `youtube audio fallback blocked for ${video.id}: ${msg}`, { videoId: video.id });
                clearVideoCache(video.id);
                await delayAfterYoutubeJob(video);
                continue;
            }
            setVideoError(video.id, msg);
            broadcast(SSE_EVENTS.VIDEO_ERROR, {
                id: video.id,
                channelId: video.channel_id,
                title: video.title,
                error: msg,
            });
            log('error', 'worker', `failed ${video.id}: ${msg}`, { videoId: video.id });
            clearVideoCache(video.id);
            await delayAfterYoutubeJob(video);
        }
    }

    running = false;
    log('info', 'worker', 'worker loop stopped');
}

export function stopWorker() { stopRequested = true; }
