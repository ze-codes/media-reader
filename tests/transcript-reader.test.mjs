import { describe, expect, test } from 'bun:test';
import {
    formatTranscriptTimestamp,
    transcriptBlocks,
    transcriptTimestampUrl,
} from '../public/transcript-reader.mjs';

describe('transcript timestamps', () => {
    test('formats raw millisecond starts without rounding into a later second', () => {
        expect(formatTranscriptTimestamp(0)).toBe('0:00');
        expect(formatTranscriptTimestamp(62_999)).toBe('1:02');
        expect(formatTranscriptTimestamp(3_661_900)).toBe('1:01:01');
        expect(formatTranscriptTimestamp(null)).toBe('');
        expect(formatTranscriptTimestamp(-1)).toBe('');
    });

    test('sets the actual start second on allowlisted HTTP(S) YouTube URLs', () => {
        expect(transcriptTimestampUrl({
            sourceType: 'url',
            sourceUrl: 'https://www.youtube.com/watch?v=abc_DEF-123&list=keep',
            startMs: 62_999,
        })).toBe('https://www.youtube.com/watch?v=abc_DEF-123&list=keep&t=62');
        expect(transcriptTimestampUrl({
            sourceType: 'url',
            sourceUrl: 'https://youtu.be/abc_DEF-123?si=keep',
            startMs: 1_500,
        })).toBe('https://youtu.be/abc_DEF-123?si=keep&t=1');
        expect(transcriptTimestampUrl({
            sourceType: 'url',
            sourceUrl: 'http://music.youtube.com/watch?v=music-id',
            startMs: 5_000,
        })).toBe('http://music.youtube.com/watch?v=music-id&t=5');
    });

    test('rejects uploads, deceptive or unsupported hosts, unsafe protocols, malformed URLs, and missing timing', () => {
        const base = { sourceType: 'url', sourceUrl: 'https://youtube.com/watch?v=demo', startMs: 1000 };
        expect(transcriptTimestampUrl({ ...base, sourceType: 'upload' })).toBe(null);
        expect(transcriptTimestampUrl({ ...base, sourceUrl: 'https://youtube.com.evil.test/watch?v=demo' })).toBe(null);
        expect(transcriptTimestampUrl({ ...base, sourceUrl: 'https://youtube-nocookie.com/embed/demo' })).toBe(null);
        expect(transcriptTimestampUrl({ ...base, sourceUrl: 'javascript:alert(1)' })).toBe(null);
        expect(transcriptTimestampUrl({ ...base, sourceUrl: 'not a url' })).toBe(null);
        expect(transcriptTimestampUrl({ ...base, startMs: null })).toBe(null);
        expect(transcriptTimestampUrl({ ...base, startMs: -1 })).toBe(null);
    });
});

describe('transcript blocks', () => {
    test('preserves source order, raw stored timing, and text', () => {
        const segments = [
            { startMs: 5_500, endMs: 9_250, text: '<b>first stored</b>', source: 'captions' },
            { startMs: 500, endMs: 2_750, text: 'second stored', source: 'captions' },
        ];
        expect(transcriptBlocks({ transcript: 'flattened fallback', segments })).toEqual(segments);
        expect(transcriptBlocks({ transcript: 'flattened fallback', segments })[0]).not.toBe(segments[0]);
    });

    test('keeps untimed legacy transcript text readable without fake timing', () => {
        expect(transcriptBlocks({ transcript: '<script>alert(1)</script>\n\nStill readable.', segments: [] })).toEqual([
            { startMs: null, endMs: null, text: '<script>alert(1)</script>' },
            { startMs: null, endMs: null, text: 'Still readable.' },
        ]);
        expect(transcriptBlocks({ transcript: '', segments: [] })).toEqual([]);
    });
});
