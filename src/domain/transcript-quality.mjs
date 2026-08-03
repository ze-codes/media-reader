const FOREIGN_LANGUAGE_PLACEHOLDER =
    /(?:\(|\[)\s*(?:speaking\s+in\s+)?foreign\s+language\s*(?:\)|\])/gi;

export function isPlaceholderTranscript(text) {
    if (!text || typeof text !== 'string') return true;

    const matches = text.match(FOREIGN_LANGUAGE_PLACEHOLDER) || [];
    if (matches.length < 3) return false;

    const withoutPlaceholders = text
        .replace(FOREIGN_LANGUAGE_PLACEHOLDER, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return withoutPlaceholders.length < text.length * 0.25;
}

export function isUsableTranscript(text, { minLength = 200 } = {}) {
    return Boolean(text) && text.length >= minLength && !isPlaceholderTranscript(text);
}
