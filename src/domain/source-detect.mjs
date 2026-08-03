import { SOURCES } from './constants.mjs';

export function detectVideoSource(rawUrl) {
    const input = String(rawUrl || '').trim();
    if (!input) return null;
    if (input.startsWith('@')) return SOURCES.YOUTUBE;

    try {
        const url = new URL(input);
        const host = url.hostname.toLowerCase();
        if (url.protocol === 'upload:') return SOURCES.UPLOAD;
        if (host === 'youtu.be' || host.endsWith('youtube.com')) return SOURCES.YOUTUBE;
        if (host.endsWith('xiaohongshu.com')) return SOURCES.XIAOHONGSHU;
    } catch {
        // Fall through to substring matching for partially-entered URLs.
    }

    if (/youtu\.be|youtube\.com/i.test(input)) return SOURCES.YOUTUBE;
    if (/xiaohongshu\.com/i.test(input)) return SOURCES.XIAOHONGSHU;
    return null;
}

export function youtubeVideoIdFromUrl(rawUrl) {
    const input = String(rawUrl || '').trim();
    if (!input) return null;

    try {
        const url = new URL(input);
        const host = url.hostname.toLowerCase();
        if (host === 'youtu.be') {
            const id = url.pathname.replace(/^\/+/, '').split('/')[0];
            return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
        }
        if (host.endsWith('youtube.com')) {
            const watchId = url.searchParams.get('v');
            if (/^[A-Za-z0-9_-]{11}$/.test(watchId || '')) return watchId;

            const match = url.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})(?:\/|$)/);
            if (match) return match[1];
        }
    } catch {
        return null;
    }

    return null;
}

export function isYoutubeShortUrl(rawUrl) {
    try {
        const url = new URL(String(rawUrl || '').trim());
        return url.hostname.toLowerCase().endsWith('youtube.com') && /^\/shorts\/[A-Za-z0-9_-]{11}(?:\/|$)/.test(url.pathname);
    } catch {
        return false;
    }
}

export function isSingleVideoUrl(rawUrl) {
    const input = String(rawUrl || '').trim();
    if (!input) return false;

    if (youtubeVideoIdFromUrl(input)) return true;

    try {
        const url = new URL(input);
        const host = url.hostname.toLowerCase();
        return host.endsWith('xiaohongshu.com') &&
            /^\/(?:explore|discovery\/item)\//.test(url.pathname);
    } catch {
        return false;
    }
}
