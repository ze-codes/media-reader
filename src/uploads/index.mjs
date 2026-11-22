import Busboy from 'busboy';
import { randomUUID } from 'crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, truncateSync, writeFileSync } from 'fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'path';
import { uploadDir } from '../shared/paths.mjs';

export const UPLOAD_SOURCE = 'upload';
export const LOCAL_UPLOADS_CHANNEL_ID = 'local:uploads';
export const LOCAL_UPLOADS_CHANNEL_URL = 'upload://local';
export const LOCAL_UPLOADS_CHANNEL_TITLE = 'Local uploads';
export const MAX_UPLOAD_BYTES = Number(process.env.MEDIA_READER_MAX_UPLOAD_BYTES || 1024 * 1024 * 1024);

export const ACCEPTED_MEDIA_EXTENSIONS = new Set([
    '.aac',
    '.aiff',
    '.avi',
    '.flac',
    '.m4a',
    '.m4v',
    '.mkv',
    '.mov',
    '.mp3',
    '.mp4',
    '.mpeg',
    '.mpg',
    '.oga',
    '.ogg',
    '.opus',
    '.wav',
    '.webm',
    '.wma',
]);

const ACCEPTED_MIME_TYPES = new Set([
    'application/ogg',
    'application/octet-stream',
]);

export function acceptedUploadExtensions() {
    return Array.from(ACCEPTED_MEDIA_EXTENSIONS).sort();
}

function httpError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

function cleanOriginalFilename(filename) {
    return basename(String(filename || '').replace(/\\/g, '/')).trim();
}

function safeStoredFilename(filename, fallbackExt) {
    const original = cleanOriginalFilename(filename);
    const ext = extname(original).toLowerCase() || fallbackExt || '';
    const stem = basename(original, ext)
        .replace(/[^A-Za-z0-9._ -]+/g, '_')
        .replace(/\s+/g, ' ')
        .replace(/^[._ -]+|[._ -]+$/g, '')
        .slice(0, 120) || 'upload';
    return `${stem}${ext}`;
}

export function mediaTitleFromFilename(filename) {
    const original = cleanOriginalFilename(filename);
    const ext = extname(original);
    return (ext ? original.slice(0, -ext.length) : original).trim() || 'Uploaded media';
}

export function localMediaUrl(uploadId, filename) {
    return `upload://${encodeURIComponent(uploadId)}/${encodeURIComponent(cleanOriginalFilename(filename) || 'media')}`;
}

export function isLocalUpload(video = {}) {
    if (video.source_type === UPLOAD_SOURCE) return true;
    try {
        return new URL(String(video.url || '')).protocol === 'upload:';
    } catch {
        return false;
    }
}

export function validateUploadFile({ filename, mimeType } = {}) {
    const originalFilename = cleanOriginalFilename(filename);
    if (!originalFilename) {
        return { ok: false, status: 400, error: 'Choose an audio or video file to upload.' };
    }

    const ext = extname(originalFilename).toLowerCase();
    if (!ACCEPTED_MEDIA_EXTENSIONS.has(ext)) {
        return {
            ok: false,
            status: 415,
            error: `Unsupported file extension "${ext || '(none)'}". Upload a common audio or video file such as MP3, M4A, WAV, MP4, MOV, or WebM.`,
        };
    }

    const normalizedMime = String(mimeType || '').toLowerCase();
    const mimeAccepted = !normalizedMime ||
        normalizedMime.startsWith('audio/') ||
        normalizedMime.startsWith('video/') ||
        ACCEPTED_MIME_TYPES.has(normalizedMime);

    if (!mimeAccepted) {
        return {
            ok: false,
            status: 415,
            error: `Unsupported media type "${mimeType}". Upload an audio or video file.`,
        };
    }

    return {
        ok: true,
        ext,
        mimeType: normalizedMime || null,
        originalFilename,
        title: mediaTitleFromFilename(originalFilename),
    };
}

export function resolveStoredUploadPath(filePath) {
    const resolvedUploads = resolve(uploadDir());
    const resolvedPath = resolve(String(filePath || ''));
    const rel = relative(resolvedUploads, resolvedPath);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error('uploaded file path is outside the app data directory');
    }
    return resolvedPath;
}

export function deleteUploadedMedia(video = {}) {
    if (!isLocalUpload(video) || !video.uploaded_path) return false;
    let path;
    try {
        path = resolveStoredUploadPath(video.uploaded_path);
    } catch {
        return false;
    }
    rmSync(path, { force: true });
    return true;
}

function cleanupUpload(meta) {
    for (const path of [meta?.tmpPath, meta?.storedPath]) {
        if (path) rmSync(path, { force: true });
    }
}

export function parseMediaUploadRequest(req) {
    const contentType = String(req.headers['content-type'] || '');
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
        return Promise.reject(httpError(415, 'Upload must use multipart/form-data with a media file field.'));
    }

    const contentLength = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES + 2 * 1024 * 1024) {
        return Promise.reject(httpError(413, `File is too large. Maximum upload size is ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`));
    }

    const currentUploadDir = uploadDir();
    mkdirSync(currentUploadDir, { recursive: true });

    return new Promise((resolvePromise, rejectPromise) => {
        const busboy = Busboy({
            headers: req.headers,
            limits: {
                files: 1,
                fileSize: MAX_UPLOAD_BYTES,
            },
        });

        let fileMeta = null;
        let writeDone = null;
        let tooLarge = false;
        let settled = false;

        function fail(status, message) {
            if (settled) return;
            settled = true;
            cleanupUpload(fileMeta);
            rejectPromise(httpError(status, message));
        }

        busboy.on('file', (fieldname, file, info) => {
            if (fieldname !== 'media') {
                file.resume();
                fail(400, 'Upload field must be named "media".');
                return;
            }

            if (fileMeta) {
                file.resume();
                fail(400, 'Upload exactly one media file.');
                return;
            }

            const validation = validateUploadFile(info);
            if (!validation.ok) {
                file.resume();
                fail(validation.status, validation.error);
                return;
            }

            const uuid = randomUUID();
            const storedName = `${uuid}-${safeStoredFilename(validation.originalFilename, validation.ext)}`;
            const tmpPath = join(currentUploadDir, `${storedName}.part`);
            const storedPath = join(currentUploadDir, storedName);
            const out = createWriteStream(tmpPath, { flags: 'wx' });

            fileMeta = {
                id: `upload:${uuid}`,
                uuid,
                originalFilename: validation.originalFilename,
                title: validation.title,
                mimeType: validation.mimeType,
                sizeBytes: 0,
                tmpPath,
                storedPath,
                url: localMediaUrl(uuid, validation.originalFilename),
            };

            writeDone = new Promise((resolveWrite, rejectWrite) => {
                out.on('finish', resolveWrite);
                out.on('error', rejectWrite);
            });

            file.on('data', chunk => {
                fileMeta.sizeBytes += chunk.length;
            });
            file.on('limit', () => {
                tooLarge = true;
                file.unpipe(out);
                out.destroy();
                file.resume();
            });
            file.on('error', err => fail(400, `Could not read upload: ${err.message}`));
            out.on('error', err => fail(500, `Could not store upload: ${err.message}`));
            file.pipe(out);
        });

        busboy.on('filesLimit', () => fail(400, 'Upload exactly one media file.'));
        busboy.on('error', err => fail(400, `Could not parse upload: ${err.message}`));
        busboy.on('finish', async () => {
            if (settled) return;
            if (!fileMeta) {
                fail(400, 'Choose an audio or video file to upload.');
                return;
            }
            if (tooLarge) {
                fail(413, `File is too large. Maximum upload size is ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`);
                return;
            }

            try {
                await writeDone;
                if (fileMeta.sizeBytes <= 0) {
                    fail(400, 'Uploaded file is empty.');
                    return;
                }
                if (existsSync(fileMeta.storedPath)) {
                    fail(500, 'Upload storage collision. Try again.');
                    return;
                }
                renameSync(fileMeta.tmpPath, fileMeta.storedPath);
                fileMeta.tmpPath = null;
                settled = true;
                resolvePromise(fileMeta);
            } catch (err) {
                fail(500, `Could not store upload: ${err.message}`);
            }
        });

        req.pipe(busboy);
    });
}

// Chunked uploads: a proxy in front (Cloudflare) caps one request body at 100 MB,
// so large files arrive as consecutive chunks appended to one .part file.
export const UPLOAD_CHUNK_BYTES = 32 * 1024 * 1024;
const CHUNKED_SESSION_IDLE_MS = 60 * 60 * 1000;
const chunkedSessions = new Map();

function sweepIdleChunkedSessions(now = Date.now()) {
    for (const [uuid, session] of chunkedSessions) {
        if (session.busy || now - session.touchedAt < CHUNKED_SESSION_IDLE_MS) continue;
        chunkedSessions.delete(uuid);
        cleanupUpload(session.meta);
    }
}

export function startChunkedUpload({ filename, mimeType, size } = {}) {
    sweepIdleChunkedSessions();
    const validation = validateUploadFile({ filename, mimeType });
    if (!validation.ok) throw httpError(validation.status, validation.error);
    const expectedBytes = Number(size);
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) throw httpError(400, 'Uploaded file is empty.');
    if (expectedBytes > MAX_UPLOAD_BYTES) {
        throw httpError(413, `File is too large. Maximum upload size is ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`);
    }

    const currentUploadDir = uploadDir();
    mkdirSync(currentUploadDir, { recursive: true });
    const uuid = randomUUID();
    const storedName = `${uuid}-${safeStoredFilename(validation.originalFilename, validation.ext)}`;
    const meta = {
        id: `upload:${uuid}`,
        uuid,
        originalFilename: validation.originalFilename,
        title: validation.title,
        mimeType: validation.mimeType,
        sizeBytes: 0,
        tmpPath: join(currentUploadDir, `${storedName}.part`),
        storedPath: join(currentUploadDir, storedName),
        url: localMediaUrl(uuid, validation.originalFilename),
    };
    writeFileSync(meta.tmpPath, '', { flag: 'wx' });
    chunkedSessions.set(uuid, { meta, expectedBytes, busy: false, touchedAt: Date.now() });
    return { uploadId: uuid, chunkBytes: UPLOAD_CHUNK_BYTES };
}

function chunkedSession(uploadId) {
    const session = chunkedSessions.get(String(uploadId || ''));
    if (!session) throw httpError(404, 'Upload not found or expired. Start the upload again.');
    return session;
}

// Appends one request body at `offset`. A retried chunk the server already has
// is acknowledged without rewriting; any other offset mismatch is a 409 that
// tells the client where to resume.
export function appendUploadChunk(uploadId, offset, req) {
    let session;
    try {
        session = chunkedSession(uploadId);
    } catch (err) {
        req.resume?.();
        return Promise.reject(err);
    }
    const { meta, expectedBytes } = session;
    const at = Number(offset);
    const length = Number(req.headers?.['content-length']);
    const conflict = () => Object.assign(httpError(409, `Expected offset ${meta.sizeBytes}.`), { received: meta.sizeBytes });

    if (session.busy) { req.resume?.(); return Promise.reject(conflict()); }
    if (Number.isSafeInteger(length) && at + length === meta.sizeBytes) {
        req.resume?.();
        return Promise.resolve({ received: meta.sizeBytes });
    }
    if (!Number.isSafeInteger(at) || at !== meta.sizeBytes) { req.resume?.(); return Promise.reject(conflict()); }

    session.busy = true;
    session.touchedAt = Date.now();
    const limit = Math.min(UPLOAD_CHUNK_BYTES, expectedBytes - meta.sizeBytes);
    return new Promise((resolvePromise, rejectPromise) => {
        const out = createWriteStream(meta.tmpPath, { flags: 'a' });
        let written = 0;
        let failed = null;
        let aborted = false;
        req.on('data', chunk => {
            written += chunk.length;
            if (written > limit && !failed) {
                failed = httpError(413, 'Chunk is larger than the remaining file size.');
                req.unpipe(out);
                out.end();
                req.resume();
            }
        });
        // A dropped connection keeps the session: the chunk is rolled back and can be resent.
        const abort = () => { if (!failed) { aborted = true; failed = httpError(400, 'Chunk upload was interrupted.'); } out.end(); };
        req.on('error', abort);
        req.on('aborted', abort);
        out.on('error', err => { failed ||= httpError(500, `Could not store upload: ${err.message}`); });
        out.on('close', () => {
            session.busy = false;
            session.touchedAt = Date.now();
            if (failed) {
                if (aborted) {
                    truncateSync(meta.tmpPath, meta.sizeBytes);
                } else {
                    chunkedSessions.delete(meta.uuid);
                    cleanupUpload(meta);
                }
                rejectPromise(failed);
                return;
            }
            meta.sizeBytes += written;
            resolvePromise({ received: meta.sizeBytes });
        });
        req.pipe(out);
    });
}

export function finishChunkedUpload(uploadId) {
    const session = chunkedSession(uploadId);
    const { meta, expectedBytes } = session;
    if (session.busy || meta.sizeBytes !== expectedBytes) {
        throw httpError(409, `Upload incomplete: received ${meta.sizeBytes} of ${expectedBytes} bytes.`);
    }
    chunkedSessions.delete(meta.uuid);
    if (existsSync(meta.storedPath)) {
        cleanupUpload(meta);
        throw httpError(500, 'Upload storage collision. Try again.');
    }
    renameSync(meta.tmpPath, meta.storedPath);
    meta.tmpPath = null;
    return meta;
}
