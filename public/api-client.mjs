// Base path detection lets the UI work whether served at /, /media-reader/,
// or another stripped prefix.
const BASE = new URL('.', document.querySelector('script[src*="app.js"]')?.src || location.href)
    .pathname.replace(/\/$/, '');

export const api = (path) => `${BASE}/api${path}`;

export async function fetchChannelsRequest() {
    const response = await fetch(api('/channels'));
    return response.json();
}

export async function fetchChannelVideosRequest(channelId) {
    const response = await fetch(api(`/channels/${channelId}/videos`));
    if (!response.ok) return { ok: false, status: response.status };
    return { ok: true, ...(await response.json()) };
}

export async function fetchLibraryRequest({
    limit = 50,
    offset = 0,
    filter = 'all',
    channelId = '',
    query = '',
    sort = 'newest',
} = {}) {
    const params = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
        filter,
        sort,
    });
    if (channelId) params.set('channel_id', channelId);
    if (query) params.set('q', query);
    const response = await fetch(api(`/library?${params}`));
    if (!response.ok) throw new Error(`Library request failed (${response.status})`);
    return response.json();
}

export async function submitChannel(url) {
    return postJson('/channels', { url });
}

export async function submitVideo(url) {
    return postJson('/videos', { url });
}

async function postJson(path, body) {
    const response = await fetch(api(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const payload = response.ok ? {} : await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, payload };
}

// Cloudflare caps one request body at 100 MB; bigger files go up in chunks.
export const CHUNKED_UPLOAD_THRESHOLD_BYTES = 90 * 1024 * 1024;
const CHUNK_RETRIES = 4;

export async function uploadLargeMediaRequest(file, { onProgress = () => {} } = {}) {
    const { uploadId, chunkBytes } = await sendRequest('POST', api('/uploads/chunked'),
        JSON.stringify({ filename: file.name, mimeType: file.type, size: file.size }), { contentType: 'application/json' });
    const id = encodeURIComponent(uploadId);

    let offset = 0;
    while (offset < file.size) {
        const chunk = file.slice(offset, offset + chunkBytes);
        let result;
        for (let attempt = 1; ; attempt++) {
            try {
                result = await sendRequest('POST', api(`/uploads/chunked/${id}/chunk?offset=${offset}`), chunk, {
                    contentType: 'application/octet-stream',
                    onProgress: (event) => onProgress({ lengthComputable: true, loaded: offset + event.loaded, total: file.size }),
                });
                break;
            } catch (err) {
                // 409 carries the offset the server has; resume from there.
                if (err.status === 409 && Number.isSafeInteger(err.payload?.received) && err.payload.received !== offset) { result = err.payload; break; }
                if (attempt >= CHUNK_RETRIES || (err.status && ![400, 409].includes(err.status) && err.status < 500)) throw err;
                await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
            }
        }
        offset = result.received;
    }
    return sendRequest('POST', api(`/uploads/chunked/${id}/complete`), null);
}

export function uploadMediaRequest(body, { onProgress = () => {} } = {}) {
    return sendRequest('POST', api('/uploads'), body, { onProgress });
}

function sendRequest(method, url, body, { contentType, onProgress = () => {} } = {}) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(method, url);
        if (contentType) xhr.setRequestHeader('Content-Type', contentType);
        xhr.responseType = 'json';

        xhr.upload.addEventListener('progress', (event) => {
            onProgress(event);
        });

        xhr.addEventListener('load', () => {
            const payload = xhr.response || {};
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(payload);
            } else {
                const err = new Error(payload.error || xhr.statusText || `Upload failed (${xhr.status})`);
                err.status = xhr.status;
                err.payload = payload;
                reject(err);
            }
        });
        xhr.addEventListener('error', () => reject(new Error('Network error while uploading file.')));
        xhr.addEventListener('abort', () => reject(new Error('Upload cancelled.')));
        xhr.send(body);
    });
}

export async function fetchFullVideoRequest(videoId) {
    const response = await fetch(api(`/videos/${encodeURIComponent(videoId)}?transcript=1&segments=1`));
    if (!response.ok) return null;
    const payload = await response.json();
    return payload.video;
}

export function retryVideoRequest(videoId) {
    return fetch(api(`/videos/${videoId}/retry`), { method: 'POST' });
}

export async function setVideoReadRequest(videoId, read) {
    const response = await fetch(api(`/videos/${encodeURIComponent(videoId)}/read`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ read }),
    });
    if (!response.ok) throw new Error(`Could not update read state (${response.status})`);
    return response.json();
}

export async function setReadingProgressRequest(videoId, progress, { keepalive = false } = {}) {
    const response = await fetch(api(`/videos/${encodeURIComponent(videoId)}/progress`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ progress }),
        keepalive,
    });
    if (!response.ok) throw new Error(`Progress update failed (${response.status})`);
    return response.json();
}

export async function reloadYoutubeAccessRequest() {
    const response = await fetch(api('/youtube/reload-access'), { method: 'POST' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Could not reload YouTube access (${response.status})`);
    return payload;
}

export function deleteVideoRequest(videoId) {
    return fetch(api(`/videos/${encodeURIComponent(videoId)}`), { method: 'DELETE' });
}

export function deleteChannelRequest(channelId) {
    return fetch(api(`/channels/${encodeURIComponent(channelId)}`), { method: 'DELETE' });
}
