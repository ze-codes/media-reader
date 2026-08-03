export function readerRouteFromHash(hash = '') {
    const match = String(hash).match(/^#\/article\/([^/]+)(?:\/(transcript))?$/);
    if (!match) return null;
    try {
        return {
            videoId: decodeURIComponent(match[1]),
            tab: match[2] === 'transcript' ? 'transcript' : 'article',
        };
    } catch {
        return null;
    }
}

export function articleIdFromHash(hash = '') {
    return readerRouteFromHash(hash)?.videoId || null;
}

export function articleHash(videoId) {
    return `#/article/${encodeURIComponent(String(videoId || ''))}`;
}

export function transcriptHash(videoId) {
    return `${articleHash(videoId)}/transcript`;
}
