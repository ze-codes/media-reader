import { isUsableTranscript } from '../domain/transcript-quality.mjs';
import { detectVideoSource } from '../domain/source-detect.mjs';
import { SOURCES, TRANSCRIPT_SOURCES } from '../domain/constants.mjs';
import { buildTranscriptResult } from './segments.mjs';

const TRANSCRIPT_API_BASE_URL = process.env.TRANSCRIPT_API_BASE_URL || 'https://transcriptapi.com/api/v2';
const TRANSCRIPT_API_TIMEOUT_MS = Number(process.env.TRANSCRIPT_API_TIMEOUT_MS || 45_000);

export function transcriptApiPayloadToText(payload) {
    return transcriptApiPayloadToResult(payload).text;
}

function transcriptApiCueToSegment(cue) {
    if (!cue || typeof cue !== 'object') return null;

    const numberOrNaN = value => typeof value === 'number' && Number.isFinite(value)
        ? value
        : Number.NaN;

    if (cue.startMs !== undefined || cue.durationMs !== undefined || cue.endMs !== undefined) {
        const startMs = numberOrNaN(cue.startMs);
        const endMs = cue.endMs !== undefined
            ? numberOrNaN(cue.endMs)
            : startMs + numberOrNaN(cue.durationMs);
        return { startMs, endMs, text: cue.text };
    }

    const start = numberOrNaN(cue.start);
    const duration = numberOrNaN(cue.duration);
    return {
        startMs: start * 1000,
        endMs: (start + duration) * 1000,
        text: cue.text,
    };
}

export function transcriptApiPayloadToResult(payload) {
    const transcript = payload?.transcript;
    const text = typeof transcript === 'string'
        ? transcript
        : Array.isArray(transcript)
            ? transcript.map(segment => segment?.text || '').join(' ')
            : '';
    const segments = Array.isArray(transcript)
        ? transcript.map(transcriptApiCueToSegment).filter(Boolean)
        : [];
    return buildTranscriptResult({
        text,
        source: TRANSCRIPT_SOURCES.TRANSCRIPT_API,
        segments,
    });
}

export async function fetchTranscriptApiTranscript(video) {
    const source = detectVideoSource(video?.url);
    if (source !== SOURCES.YOUTUBE) return null;

    const apiKey = process.env.TRANSCRIPT_API_KEY;
    if (!apiKey) return null;

    const url = new URL(`${TRANSCRIPT_API_BASE_URL.replace(/\/+$/, '')}/youtube/transcript`);
    url.searchParams.set('video_url', video?.id || video?.url);
    url.searchParams.set('format', 'json');
    url.searchParams.set('include_timestamp', 'true');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRANSCRIPT_API_TIMEOUT_MS);
    let response;
    try {
        response = await fetch(url, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: controller.signal,
        });
    } catch (err) {
        if (err?.name === 'AbortError') {
            throw new Error(`TranscriptAPI timed out after ${TRANSCRIPT_API_TIMEOUT_MS}ms`);
        }
        throw new Error(`TranscriptAPI request failed: ${err.message}`);
    } finally {
        clearTimeout(timer);
    }

    let payload = null;
    try { payload = await response.json(); } catch {}

    if (!response.ok) {
        const detail = payload?.detail || payload?.message || response.statusText || `HTTP ${response.status}`;
        throw new Error(`TranscriptAPI ${response.status}: ${detail}`);
    }

    const transcript = transcriptApiPayloadToResult(payload);
    return isUsableTranscript(transcript.text, { minLength: 50 }) ? transcript : null;
}
