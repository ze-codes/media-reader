function normalizeText(value) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

export function normalizeTranscriptSegments(segments) {
    if (!Array.isArray(segments)) return [];

    const normalized = [];
    for (const segment of segments) {
        const startMs = segment?.startMs;
        const hasEnd = segment?.endMs !== null && segment?.endMs !== undefined;
        const endMs = hasEnd ? segment.endMs : null;
        const text = normalizeText(segment?.text);

        if (!text || typeof startMs !== 'number' || !Number.isFinite(startMs) || startMs < 0) continue;
        if (hasEnd && (typeof endMs !== 'number' || !Number.isFinite(endMs) || endMs < startMs)) continue;

        normalized.push({
            startMs: Math.round(startMs),
            endMs: hasEnd ? Math.round(endMs) : null,
            text,
        });
    }
    return normalized;
}

export function flattenTranscriptSegments(segments) {
    return normalizeTranscriptSegments(segments)
        .map(segment => segment.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function buildTranscriptResult({ text = '', source, segments = [] } = {}) {
    const normalizedSegments = normalizeTranscriptSegments(segments);
    const normalizedText = normalizeText(text) || flattenTranscriptSegments(normalizedSegments);
    return {
        text: normalizedText,
        source,
        segments: normalizedSegments,
    };
}
