import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import {
    acceptedUploadExtensions,
    appendUploadChunk,
    finishChunkedUpload,
    isLocalUpload,
    localMediaUrl,
    mediaTitleFromFilename,
    MAX_UPLOAD_BYTES,
    parseMediaUploadRequest,
    startChunkedUpload,
    validateUploadFile,
} from '../src/uploads/index.mjs';

describe('local media upload helpers', () => {
    test('accepts common audio and video file types', () => {
        expect(validateUploadFile({ filename: 'meeting.mp3', mimeType: 'audio/mpeg' })).toMatchObject({
            ok: true,
            ext: '.mp3',
            title: 'meeting',
        });
        expect(validateUploadFile({ filename: 'screen recording.MP4', mimeType: 'video/mp4' })).toMatchObject({
            ok: true,
            ext: '.mp4',
            title: 'screen recording',
        });
        expect(acceptedUploadExtensions()).toContain('.webm');
    });

    test('rejects unsupported extensions and non-media mime types', () => {
        expect(validateUploadFile({ filename: 'notes.txt', mimeType: 'text/plain' })).toMatchObject({
            ok: false,
            status: 415,
        });
        expect(validateUploadFile({ filename: 'fake.mp3', mimeType: 'text/plain' })).toMatchObject({
            ok: false,
            status: 415,
        });
    });

    test('builds human-readable titles and upload URLs', () => {
        expect(mediaTitleFromFilename('folder/Board review.m4a')).toBe('Board review');
        const url = localMediaUrl('abc123', 'Board review.m4a');
        expect(url).toBe('upload://abc123/Board%20review.m4a');
        expect(isLocalUpload({ source_type: 'upload' })).toBe(true);
        expect(isLocalUpload({ url })).toBe(true);
    });

    test('streams an uploaded media field into the app data directory', async () => {
        const tmp = mkdtempSync(join(tmpdir(), 'media-reader-upload-test-'));
        const previousDataDir = process.env.MEDIA_READER_DATA_DIR;
        process.env.MEDIA_READER_DATA_DIR = tmp;

        try {
            const boundary = 'media-reader-test-boundary';
            const body = Buffer.concat([
                Buffer.from(`--${boundary}\r\n`),
                Buffer.from('Content-Disposition: form-data; name="media"; filename="clip.mp3"\r\n'),
                Buffer.from('Content-Type: audio/mpeg\r\n\r\n'),
                Buffer.from('fake mp3 bytes'),
                Buffer.from(`\r\n--${boundary}--\r\n`),
            ]);
            const req = Readable.from(body);
            req.headers = {
                'content-type': `multipart/form-data; boundary=${boundary}`,
                'content-length': String(body.length),
            };

            const upload = await parseMediaUploadRequest(req);

            expect(upload.title).toBe('clip');
            expect(upload.originalFilename).toBe('clip.mp3');
            expect(upload.mimeType).toBe('audio/mpeg');
            expect(upload.sizeBytes).toBe('fake mp3 bytes'.length);
            expect(upload.storedPath.startsWith(join(tmp, 'uploads'))).toBe(true);
            expect(existsSync(upload.storedPath)).toBe(true);
            expect(readFileSync(upload.storedPath, 'utf8')).toBe('fake mp3 bytes');
        } finally {
            if (previousDataDir == null) delete process.env.MEDIA_READER_DATA_DIR;
            else process.env.MEDIA_READER_DATA_DIR = previousDataDir;
            rmSync(tmp, { recursive: true, force: true });
        }
    });
});

describe('chunked media uploads', () => {
    function chunkRequest(text, { failAfter } = {}) {
        const body = Buffer.from(text);
        const req = failAfter == null
            ? Readable.from([body])
            : new Readable({
                read() {
                    this.push(body.subarray(0, failAfter));
                    setImmediate(() => this.destroy(new Error('connection reset')));
                },
            });
        req.headers = { 'content-length': String(body.length) };
        return req;
    }

    async function withDataDir(fn) {
        const tmp = mkdtempSync(join(tmpdir(), 'media-reader-chunked-test-'));
        const previousDataDir = process.env.MEDIA_READER_DATA_DIR;
        process.env.MEDIA_READER_DATA_DIR = tmp;
        try {
            await fn(tmp);
        } finally {
            if (previousDataDir == null) delete process.env.MEDIA_READER_DATA_DIR;
            else process.env.MEDIA_READER_DATA_DIR = previousDataDir;
            rmSync(tmp, { recursive: true, force: true });
        }
    }

    test('assembles chunks in order, acknowledges a resent chunk and resumes after a dropped one', async () => {
        await withDataDir(async (tmp) => {
            const { uploadId } = startChunkedUpload({ filename: 'talk.mp4', mimeType: 'video/mp4', size: 12 });

            expect(await appendUploadChunk(uploadId, 0, chunkRequest('abcd'))).toEqual({ received: 4 });
            // Response to the first chunk was lost; the client resends it.
            expect(await appendUploadChunk(uploadId, 0, chunkRequest('abcd'))).toEqual({ received: 4 });
            // A chunk at the wrong offset tells the client where to resume.
            await expect(appendUploadChunk(uploadId, 8, chunkRequest('ijkl'))).rejects.toMatchObject({ status: 409, received: 4 });
            // The connection drops mid-chunk: the partial bytes are rolled back and the session survives.
            await expect(appendUploadChunk(uploadId, 4, chunkRequest('efgh', { failAfter: 2 }))).rejects.toMatchObject({ status: 400 });
            expect(() => finishChunkedUpload(uploadId)).toThrow('received 4 of 12');

            expect(await appendUploadChunk(uploadId, 4, chunkRequest('efgh'))).toEqual({ received: 8 });
            expect(await appendUploadChunk(uploadId, 8, chunkRequest('ijkl'))).toEqual({ received: 12 });

            const upload = finishChunkedUpload(uploadId);
            expect(upload.title).toBe('talk');
            expect(upload.sizeBytes).toBe(12);
            expect(upload.storedPath.startsWith(join(tmp, 'uploads'))).toBe(true);
            expect(readFileSync(upload.storedPath, 'utf8')).toBe('abcdefghijkl');
            expect(() => finishChunkedUpload(uploadId)).toThrow('not found');
        });
    });

    test('rejects bad files up front and a chunk that overruns the declared size', async () => {
        await withDataDir(async () => {
            expect(() => startChunkedUpload({ filename: 'notes.txt', mimeType: 'text/plain', size: 10 })).toThrow('Unsupported');
            expect(() => startChunkedUpload({ filename: 'big.mp4', size: MAX_UPLOAD_BYTES + 1 })).toThrow('too large');
            expect(() => startChunkedUpload({ filename: 'empty.mp3', size: 0 })).toThrow('empty');

            const { uploadId } = startChunkedUpload({ filename: 'clip.mp3', mimeType: 'audio/mpeg', size: 4 });
            await expect(appendUploadChunk(uploadId, 0, chunkRequest('toolong'))).rejects.toMatchObject({ status: 413 });
            await expect(appendUploadChunk(uploadId, 0, chunkRequest('abcd'))).rejects.toMatchObject({ status: 404 });
        });
    });
});
