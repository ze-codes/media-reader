const YOUTUBE_HOSTS = new Set([
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'music.youtube.com',
    'youtu.be',
]);

function validStartMs(startMs) {
    if (startMs === null || startMs === undefined || startMs === '') return null;
    const value = Number(startMs);
    return Number.isFinite(value) && value >= 0 ? value : null;
}

export function formatTranscriptTimestamp(startMs) {
    const value = validStartMs(startMs);
    if (value === null) return '';
    const totalSeconds = Math.floor(value / 1000);
    const seconds = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const minutes = totalMinutes % 60;
    const hours = Math.floor(totalMinutes / 60);
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
        : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function transcriptTimestampUrl({ sourceType, sourceUrl, startMs } = {}) {
    const value = validStartMs(startMs);
    if (sourceType === 'upload' || value === null) return null;

    let url;
    try {
        url = new URL(String(sourceUrl || ''));
    } catch {
        return null;
    }
    if (!['http:', 'https:'].includes(url.protocol) || !YOUTUBE_HOSTS.has(url.hostname)) return null;

    const hasVideoIdentity = url.hostname === 'youtu.be'
        ? url.pathname.split('/').filter(Boolean).length > 0
        : (url.pathname === '/watch' ? Boolean(url.searchParams.get('v')) : /^\/(shorts|embed|live)\/[^/]+/.test(url.pathname));
    if (!hasVideoIdentity) return null;

    url.searchParams.set('t', String(Math.floor(value / 1000)));
    return url.toString();
}

export function transcriptBlocks({ transcript, segments } = {}) {
    if (Array.isArray(segments) && segments.length > 0) {
        return segments.map(segment => ({ ...segment }));
    }
    return String(transcript || '')
        .split(/\n\s*\n/)
        .map(text => text.trim())
        .filter(Boolean)
        .map(text => ({ startMs: null, endMs: null, text }));
}
