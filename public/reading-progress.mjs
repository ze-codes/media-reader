export function clampReadingProgress(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(1, number));
}

export function readingProgressFromScroll({ scrollTop, scrollHeight, viewportHeight }) {
    const available = Math.max(0, Number(scrollHeight) - Number(viewportHeight));
    if (!Number.isFinite(available) || available <= 0) return 1;
    return clampReadingProgress(Number(scrollTop) / available);
}

export function scrollTopForReadingProgress(progress, { scrollHeight, viewportHeight }) {
    const available = Math.max(0, Number(scrollHeight) - Number(viewportHeight));
    if (!Number.isFinite(available)) return 0;
    return Math.round(clampReadingProgress(progress) * available);
}
