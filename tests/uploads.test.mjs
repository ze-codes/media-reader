import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import {
    acceptedUploadExtensions,
    isLocalUpload,
    localMediaUrl,
    mediaTitleFromFilename,
    parseMediaUploadRequest,
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
