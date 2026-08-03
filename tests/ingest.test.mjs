import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    cookieStateAfterSourceObservation,
    detectVideoSource,
    fetchTranscriptApiTranscript,
    isSingleVideoUrl,
    isYoutubeShortUrl,
    isYoutubeAuthBlockedError,
    publishedAtFromInfo,
    parseJson3Transcript,
    pickCookieJson,
    resolveCookieDirectory,
    selectYoutubeCookieSource,
    shouldRetryYoutubeAudioWithHls,
    shouldTrackYoutubeCookieValidity,
    transcriptApiPayloadToText,
    transcriptApiPayloadToResult,
    youtubeVideoIdFromUrl,
} from '../src/ingest/index.mjs';

describe('ingest source detection', () => {
    test('detects YouTube URLs and handles', () => {
        expect(detectVideoSource('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('youtube');
        expect(detectVideoSource('https://youtu.be/dQw4w9WgXcQ')).toBe('youtube');
        expect(detectVideoSource('@OpenAI')).toBe('youtube');
    });

    test('detects Xiaohongshu note URLs', () => {
        expect(detectVideoSource('https://www.xiaohongshu.com/explore/6411cf99000000001300b6d9')).toBe('xiaohongshu');
        expect(detectVideoSource('https://www.xiaohongshu.com/discovery/item/674051740000000007027a15?xsec_token=demo')).toBe('xiaohongshu');
    });

    test('detects local upload media URLs', () => {
        expect(detectVideoSource('upload://1234/demo.mp3')).toBe('upload');
    });

    test('detects single-video URLs separately from channels', () => {
        expect(isSingleVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
        expect(isSingleVideoUrl('https://youtu.be/dQw4w9WgXcQ?t=42')).toBe(true);
        expect(isSingleVideoUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(true);
        expect(isSingleVideoUrl('https://www.youtube.com/live/dQw4w9WgXcQ')).toBe(true);
        expect(isSingleVideoUrl('https://www.youtube.com/@OpenAI/videos')).toBe(false);
        expect(isSingleVideoUrl('@OpenAI')).toBe(false);
    });

    test('extracts YouTube video ids from direct URL forms', () => {
        expect(youtubeVideoIdFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=abc')).toBe('dQw4w9WgXcQ');
        expect(youtubeVideoIdFromUrl('https://youtu.be/dQw4w9WgXcQ?t=42')).toBe('dQw4w9WgXcQ');
        expect(youtubeVideoIdFromUrl('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
        expect(youtubeVideoIdFromUrl('https://www.youtube.com/@OpenAI/videos')).toBe(null);
    });

    test('identifies YouTube Shorts without classifying normal videos as Shorts', () => {
        expect(isYoutubeShortUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(true);
        expect(isYoutubeShortUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(false);
        expect(isYoutubeShortUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(false);
    });

    test('rejects unsupported URLs', () => {
        expect(detectVideoSource('https://example.com/video/123')).toBe(null);
        expect(detectVideoSource('not a url')).toBe(null);
    });

    test('selects Cookie-Editor profiles from the configured native directory', () => {
        const cookieDirectory = mkdtempSync(join(tmpdir(), 'media-reader-cookies-'));
        try {
            writeFileSync(join(cookieDirectory, 'youtube-z.json'), '[]');
            writeFileSync(join(cookieDirectory, 'youtube-a.json'), '[]');
            writeFileSync(join(cookieDirectory, 'xiaohongshu.json'), '[]');

            const resolved = resolveCookieDirectory({ MEDIA_READER_COOKIE_DIR: cookieDirectory });
            expect(resolved).toBe(cookieDirectory);
            expect(pickCookieJson('youtube', resolved)).toBe(join(cookieDirectory, 'youtube-a.json'));
        } finally {
            rmSync(cookieDirectory, { recursive: true, force: true });
        }
    });

    test('preserves /cookies as the cookie directory fallback', () => {
        expect(resolveCookieDirectory({})).toBe('/cookies');
    });

    test('clears invalid cookie state when the cookie source changes', () => {
        expect(cookieStateAfterSourceObservation({
            cookiesInvalid: true,
            cookieSourceType: 'file',
            cookieSourceMarker: '/cookies/youtube.json:1',
        }, {
            type: 'file',
            marker: '/cookies/youtube.json:2',
        })).toEqual({
            cookiesInvalid: false,
            cookieSourceType: 'file',
            cookieSourceMarker: '/cookies/youtube.json:2',
        });

        expect(cookieStateAfterSourceObservation({
            cookiesInvalid: true,
            cookieSourceType: 'file',
            cookieSourceMarker: '/cookies/youtube.json:1',
        }, {
            type: 'file',
            marker: '/cookies/youtube.json:1',
        }).cookiesInvalid).toBe(true);
    });

    test('manual cookie reload prefers and retains an uploaded YouTube profile', () => {
        const fileSource = { type: 'file', marker: '/cookies/youtube.json:new' };
        const chromeSource = { type: 'chrome', marker: '/chrome-session/Cookies' };

        expect(selectYoutubeCookieSource({
            fileSource,
            chromeSource,
            preferFile: true,
        })).toBe(fileSource);

        expect(selectYoutubeCookieSource({
            fileSource,
            chromeSource,
            activeType: 'file',
            activeMarker: fileSource.marker,
        })).toBe(fileSource);
    });

    test('an invalid unchanged uploaded profile can fall back to Chromium', () => {
        const fileSource = { type: 'file', marker: '/cookies/youtube.json:stale' };
        const chromeSource = { type: 'chrome', marker: '/chrome-session/Cookies' };

        expect(selectYoutubeCookieSource({
            fileSource,
            chromeSource,
            activeType: 'file',
            activeMarker: fileSource.marker,
            invalid: true,
        })).toBe(chromeSource);
    });

    test('does not let audio fallback bot-wall errors pause the whole YouTube queue', () => {
        expect(shouldTrackYoutubeCookieValidity('captions')).toBe(true);
        expect(shouldTrackYoutubeCookieValidity('resolve')).toBe(true);
        expect(shouldTrackYoutubeCookieValidity('audio')).toBe(false);
    });

    test('detects YouTube auth and bot-wall errors', () => {
        expect(isYoutubeAuthBlockedError('ERROR: Sign in to confirm you are not a bot')).toBe(true);
        expect(isYoutubeAuthBlockedError('ERROR: account cookies are no longer valid')).toBe(true);
        expect(isYoutubeAuthBlockedError('ERROR: Requested format is not available')).toBe(false);
    });

    test('limits the YouTube HLS audio fallback to forbidden media transfers', () => {
        expect(shouldRetryYoutubeAudioWithHls('unable to download video data: HTTP Error 403: Forbidden')).toBe(true);
        expect(shouldRetryYoutubeAudioWithHls('Sign in to confirm you are not a bot')).toBe(false);
        expect(shouldRetryYoutubeAudioWithHls('HTTP Error 404: Not Found')).toBe(false);
    });

    test('normalizes TranscriptAPI responses', () => {
        expect(transcriptApiPayloadToText({
            transcript: [{ text: 'First line' }, { text: 'second line' }],
        })).toBe('First line second line');

        expect(transcriptApiPayloadToText({
            transcript: 'First line\nsecond line',
        })).toBe('First line second line');
    });

    test('parses documented TranscriptAPI second-based timestamps', () => {
        expect(transcriptApiPayloadToResult({
            transcript: [
                { text: ' First cue ', start: 1.25, duration: 2.5 },
                { text: 'second\ncue', start: 3.75, duration: 0.5 },
            ],
        })).toEqual({
            text: 'First cue second cue',
            source: 'transcriptapi',
            segments: [
                { startMs: 1250, endMs: 3750, text: 'First cue' },
                { startMs: 3750, endMs: 4250, text: 'second cue' },
            ],
        });
    });

    test('retains TranscriptAPI text when cue timing is malformed', () => {
        expect(transcriptApiPayloadToResult({
            transcript: [
                { text: 'Readable untimed cue', start: 'not-a-number', duration: 1 },
                { text: 'and null is not zero', start: null, duration: 1 },
            ],
        })).toEqual({
            text: 'Readable untimed cue and null is not zero',
            source: 'transcriptapi',
            segments: [],
        });
    });

    test('explicitly requests TranscriptAPI timestamps', async () => {
        const previousKey = process.env.TRANSCRIPT_API_KEY;
        const previousFetch = globalThis.fetch;
        process.env.TRANSCRIPT_API_KEY = 'test-key';
        globalThis.fetch = async input => {
            const url = new URL(input);
            expect(url.searchParams.get('include_timestamp')).toBe('true');
            return new Response(JSON.stringify({
                transcript: [{
                    text: 'A documented transcript response with enough readable content to pass the provider quality threshold.',
                    start: 0,
                    duration: 2,
                }],
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        };

        try {
            const result = await fetchTranscriptApiTranscript({
                id: 'dQw4w9WgXcQ',
                url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
            });
            expect(result.segments).toEqual([{
                startMs: 0,
                endMs: 2000,
                text: 'A documented transcript response with enough readable content to pass the provider quality threshold.',
            }]);
        } finally {
            globalThis.fetch = previousFetch;
            if (previousKey === undefined) delete process.env.TRANSCRIPT_API_KEY;
            else process.env.TRANSCRIPT_API_KEY = previousKey;
        }
    });

    test('parses JSON3 event timings without inferring or sorting cues', () => {
        expect(parseJson3Transcript({
            events: [
                { tStartMs: 2200, dDurationMs: 800, segs: [{ utf8: ' second' }, { utf8: '\ncue ' }] },
                { tStartMs: 100, dDurationMs: 300, segs: [{ utf8: 'first cue' }] },
                { tStartMs: -1, dDurationMs: 100, segs: [{ utf8: 'untimed text remains' }] },
                { tStartMs: 3000, dDurationMs: 100, segs: [{ utf8: '\n' }] },
            ],
        })).toEqual({
            text: 'second cue first cue untimed text remains',
            source: 'captions',
            segments: [
                { startMs: 2200, endMs: 3000, text: 'second cue' },
                { startMs: 100, endMs: 400, text: 'first cue' },
            ],
        });
    });

    test('derives publication dates from full and flat YouTube metadata', () => {
        expect(publishedAtFromInfo({ upload_date: '20260712', timestamp: 1 })).toBe('2026-07-12');
        expect(publishedAtFromInfo({ timestamp: 1784419200 })).toBe('2026-07-19');
        expect(publishedAtFromInfo({})).toBe(null);
    });
});
