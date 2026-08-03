import Busboy from 'busboy';
import { randomUUID } from 'crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'fs';
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
