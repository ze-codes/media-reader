export function looksLikeSingleVideoUrl(rawUrl) {
    const input = String(rawUrl || '').trim();
    if (!input) return false;

    try {
        const url = new URL(input);
        const host = url.hostname.toLowerCase();
        if (host === 'youtu.be' && url.pathname.replace(/^\/+/, '').length > 0) return true;
        if (host.endsWith('youtube.com') && url.searchParams.get('v')) return true;
        if (host.endsWith('youtube.com') && /^\/(?:shorts|live|embed)\//.test(url.pathname)) return true;
        if (host.endsWith('xiaohongshu.com') && /^\/(?:explore|discovery\/item)\//.test(url.pathname)) return true;
    } catch {
        return false;
    }

    return false;
}
