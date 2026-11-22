// yt-dlp wrappers: list a channel's uploads, resolve single videos, fetch
// captions, and fetch audio.
//
// We shell out to yt-dlp (installed via pip in the Dockerfile) and parse its
// JSON output. All operations are best-effort and report a shaped result —
// the worker decides what to do on failure.

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { isUsableTranscript } from '../domain/transcript-quality.mjs';
import { CACHE_DIR } from '../shared/paths.mjs';
import { isLocalUpload, resolveStoredUploadPath } from '../uploads/index.mjs';
import { SOURCES, TRANSCRIPT_SOURCES } from '../domain/constants.mjs';
import {
    detectVideoSource,
    isSingleVideoUrl,
    isYoutubeShortUrl,
    youtubeVideoIdFromUrl,
} from '../domain/source-detect.mjs';
import { clearVideoCache, videoCacheDir } from './cache.mjs';
import {
    fetchTranscriptApiTranscript,
    transcriptApiPayloadToText,
    transcriptApiPayloadToResult,
} from '../transcripts/transcript-api.mjs';
import { buildTranscriptResult } from '../transcripts/segments.mjs';

export {
    detectVideoSource,
    isSingleVideoUrl,
    isYoutubeShortUrl,
    youtubeVideoIdFromUrl,
} from '../domain/source-detect.mjs';
export {
    fetchTranscriptApiTranscript,
    transcriptApiPayloadToText,
    transcriptApiPayloadToResult,
} from '../transcripts/transcript-api.mjs';
export { clearVideoCache } from './cache.mjs';

// ─── Cookies ──────────────────────────────────────────────
// Cookie-receiver writes Cookie-Editor-format JSON profiles into the shared
// cookie volume (mounted at /cookies). yt-dlp wants Netscape format. We pick
// the alphabetically-first profile matching the platform prefix and convert it
// fresh on every call. yt-dlp rewrites cookie files on exit, so caching by
// mtime can silently drop auth cookies after the first call.

const YOUTUBE_COOKIE_OUT = '/tmp/yt-cookies.txt';
const XIAOHONGSHU_COOKIE_OUT = '/tmp/xhs-cookies.txt';
// Live Chromium profile from the chrome-session sidecar. Preferred source
// because the browser refreshes its own session like a real user, sidestepping
// the rotation problem we hit with file-based cookies. Fall back to file-based
// only if the user hasn't logged into chrome-session yet.
const CHROME_PROFILE = '/chrome-session/.config/chromium/Default';

export function resolveCookieDirectory(env = process.env) {
    return env.MEDIA_READER_COOKIE_DIR || '/cookies';
}

export function pickCookieJson(prefix, cookieDirectory = resolveCookieDirectory()) {
    if (!existsSync(cookieDirectory)) return null;
    let files;
    try { files = readdirSync(cookieDirectory); } catch { return null; }
    const matches = files.filter(f => f.startsWith(prefix) && f.endsWith('.json')).sort();
    return matches.length ? join(cookieDirectory, matches[0]) : null;
}

function jsonToNetscape(cookies) {
    const lines = ['# Netscape HTTP Cookie File'];
    for (const c of cookies) {
        const domain = c.domain || '';
        const includeSub = (domain.startsWith('.') || c.hostOnly === false) ? 'TRUE' : 'FALSE';
        const path = c.path || '/';
        const secure = c.secure ? 'TRUE' : 'FALSE';
        const expiry = c.expires && c.expires > 0 ? Math.round(c.expires) : 0;
        if (!c.name || c.value == null) continue;
        lines.push([domain, includeSub, path, secure, expiry, c.name, c.value].join('\t'));
    }
    return lines.join('\n') + '\n';
}

// Cookie invalidity tracking. yt-dlp surfaces two distinct signals when the
// cookies are rotated/dead; we treat either as "stop the worker until the
// cookie source is refreshed". The flag auto-clears when:
//   - the user uploads new file-based cookies (cookie content changes), or
//   - the cookie source type switches (e.g. user logs into chrome-session
//     for the first time and we transition from file → chrome).
// Persistent chrome-session failures require a media-reader restart, which
// is rare since the live browser refreshes its own session.
let cookiesInvalid = false;
let cookieSourceType = ''; // 'chrome' | 'file' | ''
let cookieSourceMarker = '';
let youtubeAudioBlocked = false;
let youtubeAudioBlockedSourceMarker = '';
let youtubeAudioBlockLoaded = false;
const YOUTUBE_AUDIO_BLOCK_STATE = join(CACHE_DIR, 'youtube-audio-block.json');
const COOKIE_INVALID_PATTERNS = [
    /Sign in to confirm you(['’]re| are)? not a bot/i,
    /account cookies are no longer valid/i,
    /cookies are no longer valid/i,
];
export const YOUTUBE_AUDIO_BLOCKED_CODE = 'youtube_audio_auth_blocked';

export function shouldTrackYoutubeCookieValidity(operation) {
    return operation !== 'audio';
}

export function isYoutubeAuthBlockedError(output) {
    return COOKIE_INVALID_PATTERNS.some(p => p.test(String(output || '')));
}

export function shouldRetryYoutubeAudioWithHls(output) {
    return /HTTP Error 403: Forbidden/i.test(String(output || ''));
}

export function getCookiesInvalid() {
    refreshYoutubeCookieValidity();
    return cookiesInvalid;
}

function noteOutputForCookieValidity(output) {
    if (cookiesInvalid) return;
    for (const p of COOKIE_INVALID_PATTERNS) {
        if (p.test(output)) { cookiesInvalid = true; return; }
    }
}

export function cookieStateAfterSourceObservation(state, source) {
    if (!source) return state;
    if (state.cookieSourceType !== source.type || state.cookieSourceMarker !== source.marker) {
        return {
            cookiesInvalid: false,
            cookieSourceType: source.type,
            cookieSourceMarker: source.marker,
        };
    }
    return state;
}

function applyCookieSource(source) {
    const next = cookieStateAfterSourceObservation({
        cookiesInvalid,
        cookieSourceType,
        cookieSourceMarker,
    }, source);
    cookiesInvalid = next.cookiesInvalid;
    cookieSourceType = next.cookieSourceType;
    cookieSourceMarker = next.cookieSourceMarker;
}

function youtubeFileCookieSource() {
    const src = pickCookieJson(SOURCES.YOUTUBE);
    if (!src) return null;
    try {
        const digest = createHash('sha256').update(readFileSync(src)).digest('hex');
        return { type: 'file', marker: `${src}:${digest}`, src };
    } catch {
        return null;
    }
}

function youtubeChromeCookieSource() {
    const cookiesPath = join(CHROME_PROFILE, 'Cookies');
    if (!existsSync(cookiesPath)) return null;
    return { type: 'chrome', marker: cookiesPath };
}

export function selectYoutubeCookieSource({
    fileSource = null,
    chromeSource = null,
    activeType = '',
    activeMarker = '',
    invalid = false,
    preferFile = false,
} = {}) {
    if (fileSource && (preferFile || (activeType === 'file' && !invalid))) {
        return fileSource;
    }
    if (invalid && fileSource && (activeType !== 'file' || activeMarker !== fileSource.marker)) {
        return fileSource;
    }
    return chromeSource || fileSource;
}

function currentYoutubeCookieSource({ preferFile = false } = {}) {
    return selectYoutubeCookieSource({
        fileSource: youtubeFileCookieSource(),
        chromeSource: youtubeChromeCookieSource(),
        activeType: cookieSourceType,
        activeMarker: cookieSourceMarker,
        invalid: cookiesInvalid,
        preferFile,
    });
}

function youtubeCookieSourceKey(source = currentYoutubeCookieSource()) {
    return source ? `${source.type}:${source.marker}` : '';
}

function youtubeCookieRefreshKey() {
    const fileSource = youtubeFileCookieSource();
    if (fileSource) return `file:${fileSource.marker}`;
    return youtubeCookieSourceKey();
}

function loadYoutubeAudioBlock() {
    if (youtubeAudioBlockLoaded) return;
    youtubeAudioBlockLoaded = true;
    if (!existsSync(YOUTUBE_AUDIO_BLOCK_STATE)) return;

    try {
        const state = JSON.parse(readFileSync(YOUTUBE_AUDIO_BLOCK_STATE, 'utf8'));
        youtubeAudioBlocked = Boolean(state?.blocked);
        youtubeAudioBlockedSourceMarker = state?.sourceMarker || '';
    } catch {
        youtubeAudioBlocked = false;
        youtubeAudioBlockedSourceMarker = '';
    }
}

function persistYoutubeAudioBlock() {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(YOUTUBE_AUDIO_BLOCK_STATE, JSON.stringify({
        blocked: youtubeAudioBlocked,
        sourceMarker: youtubeAudioBlockedSourceMarker,
        updatedAt: new Date().toISOString(),
    }) + '\n');
}

function refreshYoutubeAudioBlock() {
    loadYoutubeAudioBlock();
    const marker = youtubeCookieRefreshKey();
    if (youtubeAudioBlocked && marker && marker !== youtubeAudioBlockedSourceMarker) {
        youtubeAudioBlocked = false;
        youtubeAudioBlockedSourceMarker = '';
        persistYoutubeAudioBlock();
    }
    return youtubeAudioBlocked;
}

export function getYoutubeAudioBlocked() {
    return refreshYoutubeAudioBlock();
}

export function noteYoutubeAudioBlocked() {
    loadYoutubeAudioBlock();
    youtubeAudioBlocked = true;
    youtubeAudioBlockedSourceMarker = youtubeCookieRefreshKey();
    persistYoutubeAudioBlock();
}

export function reloadYoutubeAccess() {
    loadYoutubeAudioBlock();
    // Reload is an explicit signal that a newly uploaded profile should replace
    // a stale live-browser session. Keep that file selected after this call.
    const source = currentYoutubeCookieSource({ preferFile: true });
    cookiesInvalid = false;
    cookieSourceType = source?.type || '';
    cookieSourceMarker = source?.marker || '';
    youtubeAudioBlocked = false;
    youtubeAudioBlockedSourceMarker = '';
    persistYoutubeAudioBlock();
    return { source: source?.type || null };
}

export function refreshYoutubeCookieValidity() {
    applyCookieSource(currentYoutubeCookieSource());
    return cookiesInvalid;
}

function fileCookieArgs(prefix, outPath) {
    const src = pickCookieJson(prefix);
    if (!src) return [];
    try {
        const cookies = JSON.parse(readFileSync(src, 'utf8'));
        writeFileSync(outPath, jsonToNetscape(cookies));
        return ['--cookies', outPath];
    } catch {
        return [];
    }
}

function youtubeCookieArgs() {
    const source = currentYoutubeCookieSource();
    applyCookieSource(source);

    if (source?.type === 'chrome') {
        return ['--cookies-from-browser', `chromium:${CHROME_PROFILE}`];
    }
    if (source?.type !== 'file' || !source.src) return [];

    try {
        const cookies = JSON.parse(readFileSync(source.src, 'utf8'));
        writeFileSync(YOUTUBE_COOKIE_OUT, jsonToNetscape(cookies));
        return ['--cookies', YOUTUBE_COOKIE_OUT];
    } catch {
        return [];
    }
}

function xiaohongshuCookieArgs() {
    return fileCookieArgs(SOURCES.XIAOHONGSHU, XIAOHONGSHU_COOKIE_OUT);
}

// ─── Shared yt-dlp args ───────────────────────────────────
// Combines cookies + PO Token plugin + EJS challenge solver.
// Player client priority: tv first, web second.
//   - tv:  exposes direct audio/video URLs (no SABR), no PO Token required.
//   - web: PO-Token-friendly fallback, but YouTube now forces SABR streaming
//     for the web client which hides direct audio URLs (issue yt-dlp#12482).
// Without specifying clients yt-dlp falls back to android_vr, which gets
// bot-walled on most videos.
const POT_PROVIDER_URL = 'http://bgutil-pot-provider:4416';
function youtubeArgs({ playerClients = 'tv,web' } = {}) {
    return [
        ...youtubeCookieArgs(),
        '--remote-components', 'ejs:github',
        '--extractor-args', `youtubepot-bgutilhttp:base_url=${POT_PROVIDER_URL}`,
        '--extractor-args', `youtube:player_client=${playerClients}`,
    ];
}

function xiaohongshuArgs() {
    return [
        ...xiaohongshuCookieArgs(),
        '--add-header', 'Referer: https://www.xiaohongshu.com/',
        '--add-header', 'User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    ];
}

function ytArgsForSource(source) {
    if (source === SOURCES.YOUTUBE) return youtubeArgs();
    if (source === SOURCES.XIAOHONGSHU) return xiaohongshuArgs();
    return [];
}

function run(cmd, args, { input = null, timeoutMs = 5 * 60 * 1000, trackCookieValidity = false } = {}) {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        const timer = setTimeout(() => {
            proc.kill('SIGKILL');
            reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        proc.stdout.on('data', d => { stdout += d; });
        proc.stderr.on('data', d => { stderr += d; });
        proc.on('error', err => { clearTimeout(timer); reject(err); });
        proc.on('close', code => {
            clearTimeout(timer);
            if (trackCookieValidity && cmd === 'yt-dlp') noteOutputForCookieValidity(stdout + stderr);
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error(`${cmd} exited ${code}: ${stderr.trim().slice(0, 500)}`));
        });
        if (input != null) { try { proc.stdin.write(input); proc.stdin.end(); } catch {} }
    });
}

export function publishedAtFromInfo(info = {}) {
    const compactDate = info.upload_date || info.release_date || '';
    if (/^\d{8}$/.test(compactDate)) {
        return `${compactDate.slice(0, 4)}-${compactDate.slice(4, 6)}-${compactDate.slice(6, 8)}`;
    }

    const timestamp = Number(info.timestamp || info.release_timestamp);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
    return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

// ─── Channel listing ──────────────────────────────────────
// Accepts any channel URL (including @handle, /c/, /channel/UC..., playlist).
// Uses --flat-playlist so we don't download anything, just metadata for each video.

export async function listChannel(channelUrl) {
    const source = detectVideoSource(channelUrl);
    if (source && source !== SOURCES.YOUTUBE) {
        throw new Error('channel imports currently only support YouTube URLs');
    }

    const { stdout } = await run('yt-dlp', [
        ...ytArgsForSource(SOURCES.YOUTUBE),
        '--flat-playlist',
        '--dump-single-json',
        '--no-warnings',
        '--extractor-args', 'youtubetab:approximate_date',
        channelUrl,
    ], { timeoutMs: 5 * 60 * 1000, trackCookieValidity: true });

    const info = JSON.parse(stdout);
    // yt-dlp returns nested playlists (channel → Videos/Shorts/Live tabs).
    // Flatten to a single list of video entries.
    const videos = [];
    const seen = new Set();
    function walk(node) {
        if (!node) return;
        const entries = Array.isArray(node.entries) ? node.entries : null;
        if (entries) {
            for (const e of entries) walk(e);
            return;
        }
        // Leaf — an actual video
        if (node.id && !seen.has(node.id) && (node._type === 'url' || node._type === undefined)) {
            // Only take real videos — skip "upcoming", shorts tabs, etc. Heuristic:
            // must look like a YouTube video id (11 chars) and not be a playlist link.
            if (typeof node.id === 'string' && node.id.length === 11) {
                seen.add(node.id);
                const url = node.url || `https://www.youtube.com/watch?v=${node.id}`;
                if (isYoutubeShortUrl(url)) return;
                videos.push({
                    id: node.id,
                    title: node.title || null,
                    url,
                    durationSec: node.duration != null ? Math.round(node.duration) : null,
                    publishedAt: publishedAtFromInfo(node),
                });
            }
        }
    }
    walk(info);

    return {
        channelId: info.channel_id || info.id || null,
        channelTitle: info.channel || info.title || null,
        channelHandle: info.uploader_id || info.channel_id || null,
        videos,
    };
}

// ─── Single-video resolution ──────────────────────────────
// Resolve a single video URL to its metadata + parent channel info.
// --no-playlist guards against URLs that include a list= param.

async function resolveYoutubeVideo(videoUrl) {
    let stdout;
    try {
        const result = await run('yt-dlp', [
            ...ytArgsForSource(SOURCES.YOUTUBE),
            '--dump-json',
            '--no-playlist',
            '--no-warnings',
            '--skip-download',
            '--ignore-no-formats-error',
            videoUrl,
        ], { timeoutMs: 60 * 1000, trackCookieValidity: true });
        stdout = result.stdout;
    } catch (err) {
        const fallbackId = youtubeVideoIdFromUrl(videoUrl);
        if (!fallbackId || !isYoutubeAuthBlockedError(err.message)) throw err;
        return {
            source: SOURCES.YOUTUBE,
            id: fallbackId,
            title: `YouTube video ${fallbackId}`,
            url: `https://www.youtube.com/watch?v=${fallbackId}`,
            durationSec: null,
            publishedAt: null,
            channelId: 'youtube:single',
            channelTitle: 'Single YouTube Videos',
            channelHandle: null,
            channelUrl: 'https://www.youtube.com',
        };
    }

    const info = JSON.parse(stdout);
    if (!info.id || typeof info.id !== 'string' || info.id.length !== 11) {
        throw new Error('could not resolve a youtube video id from URL');
    }

    // Some videos (members-only, restricted, no available formats) come back
    // without a channel_id. Fall back to hitting the uploader's channel page,
    // which reliably yields the UC id.
    let channelId = info.channel_id || null;
    let channelTitle = info.channel || info.uploader || null;
    let channelHandle = info.uploader_id || null;

    if (!channelId && info.uploader_url) {
        try {
            const { stdout: chOut } = await run('yt-dlp', [
                ...ytArgsForSource(SOURCES.YOUTUBE),
                '--flat-playlist',
                '--playlist-items', '0',
                '--dump-single-json',
                '--no-warnings',
                info.uploader_url,
            ], { timeoutMs: 60 * 1000, trackCookieValidity: true });
            const ch = JSON.parse(chOut);
            channelId = ch.channel_id || ch.id || channelId;
            channelTitle = ch.channel || ch.title || channelTitle;
            channelHandle = ch.uploader_id || channelHandle;
        } catch {
            // best-effort; let outer caller fail with a clear error
        }
    }

    return {
        source: SOURCES.YOUTUBE,
        id: info.id,
        title: info.title || null,
        url: info.webpage_url || `https://www.youtube.com/watch?v=${info.id}`,
        durationSec: info.duration != null ? Math.round(info.duration) : null,
        publishedAt: publishedAtFromInfo(info),
        channelId,
        channelTitle,
        channelHandle,
        channelUrl: channelId ? `https://www.youtube.com/channel/${channelId}` : videoUrl,
    };
}

async function resolveXiaohongshuVideo(videoUrl) {
    const { stdout } = await run('yt-dlp', [
        ...ytArgsForSource(SOURCES.XIAOHONGSHU),
        '--dump-json',
        '--no-playlist',
        '--no-warnings',
        '--skip-download',
        '--ignore-no-formats-error',
        videoUrl,
    ], { timeoutMs: 60 * 1000 });

    const info = JSON.parse(stdout);
    if (!info.id || typeof info.id !== 'string') {
        throw new Error('could not resolve a Xiaohongshu video id from URL');
    }

    const uploaderId = info.uploader_id || null;
    const title = info.title && !/^XiaoHongShu video #/i.test(info.title)
        ? info.title
        : `Xiaohongshu note ${info.id}`;
    const channelTitle = info.uploader || info.channel || title || (uploaderId ? `Xiaohongshu ${uploaderId}` : 'Xiaohongshu');

    return {
        source: SOURCES.XIAOHONGSHU,
        id: info.id,
        title,
        url: info.webpage_url || videoUrl,
        durationSec: info.duration != null ? Math.round(info.duration) : null,
        publishedAt: publishedAtFromInfo(info),
        channelId: uploaderId ? `xhs:${uploaderId}` : `xhs:note:${info.id}`,
        channelTitle,
        channelHandle: uploaderId,
        channelUrl: info.uploader_url || videoUrl,
    };
}

export async function resolveVideo(videoUrl) {
    const source = detectVideoSource(videoUrl);
    if (source === SOURCES.YOUTUBE) return resolveYoutubeVideo(videoUrl);
    if (source === SOURCES.XIAOHONGSHU) return resolveXiaohongshuVideo(videoUrl);
    throw new Error('unsupported video URL: only YouTube and Xiaohongshu are supported');
}

// ─── Captions ─────────────────────────────────────────────
// Tries to download auto-generated English subs as json3. Returns plain text
// on success, or null if no captions are available (signal to fall back to
// whisper).

export function parseJson3Transcript(json) {
    const events = Array.isArray(json?.events) ? json.events : [];
    const textParts = [];
    const segments = [];
    for (const ev of events) {
        if (!Array.isArray(ev?.segs)) continue;
        const text = ev.segs.map(segment => segment?.utf8 || '').join('');
        if (!text.replace(/\s+/g, ' ').trim()) continue;
        textParts.push(text);

        const startMs = typeof ev.tStartMs === 'number' ? ev.tStartMs : Number.NaN;
        const durationMs = typeof ev.dDurationMs === 'number' ? ev.dDurationMs : Number.NaN;
        segments.push({
            startMs,
            endMs: startMs + durationMs,
            text,
        });
    }
    return buildTranscriptResult({
        text: textParts.join(' '),
        source: TRANSCRIPT_SOURCES.CAPTIONS,
        segments,
    });
}

export async function fetchCaptions(video) {
    const source = detectVideoSource(video?.url);
    if (source !== SOURCES.YOUTUBE) return null;

    const dir = videoCacheDir(video.id);
    const base = join(dir, 'caps');

    try {
        await run('yt-dlp', [
            ...ytArgsForSource(SOURCES.YOUTUBE),
            '--skip-download',
            '--write-auto-subs',
            '--write-subs',
            '--sub-langs', 'en.*,en',
            '--sub-format', 'json3',
            '--no-warnings',
            '--ignore-no-formats-error',
            '-o', base,
            video.url,
        ], { timeoutMs: 90 * 1000, trackCookieValidity: true });
    } catch {
        return null;
    }

    // Look for any .json3 file written into dir
    const files = readdirSync(dir).filter(f => f.startsWith('caps.') && f.endsWith('.json3'));
    if (files.length === 0) return null;

    // Prefer uploaded subs over auto; yt-dlp names them caps.en.json3 vs caps.en-orig.json3 etc.
    files.sort();
    const raw = readFileSync(join(dir, files[0]), 'utf8');
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return null; }
    const transcript = parseJson3Transcript(parsed);
    if (!isUsableTranscript(transcript.text, { minLength: 50 })) return null;
    return transcript;
}

// ─── Audio (for Whisper fallback) ─────────────────────────
// Extracts 16kHz mono wav, which is what whisper.cpp expects directly.

export async function fetchAudio(video) {
    if (isLocalUpload(video)) return extractUploadedAudio(video);

    const source = detectVideoSource(video?.url);
    if (!source) throw new Error('unsupported video source');
    if (source === SOURCES.UPLOAD) return extractUploadedAudio(video);

    const dir = videoCacheDir(video.id);
    const wavPath = join(dir, 'audio.wav');
    const formatSelector = source === SOURCES.XIAOHONGSHU ? 'bestaudio/best' : 'bestaudio';
    const outputTemplate = join(dir, 'audio.%(ext)s');
    const audioArgs = (sourceArgs, format) => [
        ...sourceArgs,
        '-f', format,
        '-x',
        '--audio-format', 'wav',
        '--postprocessor-args', 'ffmpeg:-ar 16000 -ac 1',
        '--no-warnings',
        '-o', outputTemplate,
        video.url,
    ];

    let downloadError = null;
    try {
        await run('yt-dlp', audioArgs(ytArgsForSource(source), formatSelector), {
            timeoutMs: 15 * 60 * 1000,
            trackCookieValidity: source === SOURCES.YOUTUBE && shouldTrackYoutubeCookieValidity('audio'),
        });
    } catch (err) {
        downloadError = err;
    }

    // Some authenticated YouTube responses expose direct audio URLs that allow
    // probes but reject full transfers. The segmented Safari HLS stream remains
    // usable, so retry only this 403 case through its lowest-bandwidth format.
    if (source === SOURCES.YOUTUBE && shouldRetryYoutubeAudioWithHls(downloadError?.message)) {
        try {
            await run('yt-dlp', audioArgs(
                youtubeArgs({ playerClients: 'web_safari' }),
                'worst[acodec!=none]/worst',
            ), { timeoutMs: 15 * 60 * 1000 });
            downloadError = null;
        } catch (err) {
            downloadError = err;
        }
    }

    // The tv/web clients sometimes expose no audio formats; yt-dlp's default clients do.
    if (source === SOURCES.YOUTUBE && /Requested format is not available/i.test(downloadError?.message || '')) {
        try {
            await run('yt-dlp', audioArgs(youtubeArgs({ playerClients: 'default' }), formatSelector), { timeoutMs: 15 * 60 * 1000 });
            downloadError = null;
        } catch (err) {
            downloadError = err;
        }
    }

    if (downloadError) {
        if (source === SOURCES.YOUTUBE && isYoutubeAuthBlockedError(downloadError?.message)) {
            noteYoutubeAudioBlocked();
            const blocked = new Error('YouTube audio download is blocked by authentication/bot checks. Refresh YouTube cookies before retrying captionless videos.');
            blocked.code = YOUTUBE_AUDIO_BLOCKED_CODE;
            throw blocked;
        }
        throw downloadError;
    }

    if (!existsSync(wavPath)) throw new Error('audio extraction produced no wav file');
    return wavPath;
}

async function extractUploadedAudio(video) {
    if (!video?.uploaded_path) throw new Error('uploaded media path missing');
    const inputPath = resolveStoredUploadPath(video.uploaded_path);
    if (!existsSync(inputPath)) throw new Error('uploaded media file is missing from app data');

    const dir = videoCacheDir(video.id);
    const wavPath = join(dir, 'audio.wav');

    await run('ffmpeg', [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-i', inputPath,
        '-vn',
        '-ar', '16000',
        '-ac', '1',
        wavPath,
    ], { timeoutMs: 15 * 60 * 1000 });

    if (!existsSync(wavPath)) throw new Error('audio extraction produced no wav file');
    return wavPath;
}
