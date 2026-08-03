import { describe, expect, test } from 'bun:test';
import { workerStatusForVideos } from '../src/server/api.mjs';
import { publicVideo } from '../src/services/worker-status.mjs';

describe('worker status projection', () => {
    test('does not globally pause queued YouTube jobs when cookies are invalid', () => {
        expect(workerStatusForVideos([
            {
                id: 'XD1eGSCvUO0',
                state: 'queued',
                url: 'https://www.youtube.com/watch?v=XD1eGSCvUO0',
            },
            {
                id: 'upload:demo',
                state: 'queued',
                url: 'upload://demo/demo.wav',
            },
        ])).toMatchObject({
            youtube_paused: false,
            queued_youtube: 1,
            reason: null,
        });
    });

    test('does not pause non-YouTube queued jobs', () => {
        expect(workerStatusForVideos([
            {
                id: 'upload:demo',
                state: 'queued',
                url: 'upload://demo/demo.wav',
            },
        ])).toMatchObject({
            youtube_paused: false,
            queued_youtube: 0,
            reason: null,
        });
    });

    test('does not let an audio fallback block pause other YouTube jobs', () => {
        expect(workerStatusForVideos([
            {
                id: 'XD1eGSCvUO0',
                state: 'queued',
                url: 'https://www.youtube.com/watch?v=XD1eGSCvUO0',
            },
        ])).toMatchObject({
            youtube_paused: false,
            queued_youtube: 1,
            reason: null,
        });
    });
});

describe('public video projection', () => {
    test('omits transcript, segment arrays, and upload path by default', () => {
        const video = {
            id: 'demo',
            title: 'Demo',
            transcript: 'private transcript',
            segments: [{ startMs: 0, endMs: 1000, text: 'private segment' }],
            transcript_segments: [{ text: 'private joined segment' }],
            uploaded_path: '/app/data/uploads/private.wav',
            article: 'article',
        };
        expect(publicVideo(video)).toEqual({ id: 'demo', title: 'Demo', article: 'article' });
    });

    test('includes transcript and stored segments only through independent explicit flags', () => {
        const video = {
            id: 'demo',
            title: 'Demo',
            transcript: 'private transcript',
            uploaded_path: '/app/data/uploads/private.wav',
            article: 'article',
        };
        const segments = [
            { startMs: 2300, endMs: 4100, text: 'second', source: 'captions' },
            { startMs: 100, endMs: 2200, text: 'first in stored order', source: 'captions' },
        ];

        expect(publicVideo(video, { includeTranscript: true })).toEqual({
            id: 'demo',
            title: 'Demo',
            article: 'article',
            transcript: 'private transcript',
        });
        expect(publicVideo(video, { includeSegments: true, segments })).toEqual({
            id: 'demo',
            title: 'Demo',
            article: 'article',
            segments,
        });
        expect(publicVideo(video, {
            includeTranscript: true,
            includeSegments: true,
            segments,
        })).toEqual({
            id: 'demo',
            title: 'Demo',
            article: 'article',
            transcript: 'private transcript',
            segments,
        });
    });
});
