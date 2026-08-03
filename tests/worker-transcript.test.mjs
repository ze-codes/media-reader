import { describe, expect, test } from 'bun:test';
import { storedTranscriptResult } from '../src/worker/worker.mjs';

const longText = 'A deterministic stored transcript with enough meaningful words to satisfy the existing quality gate. '.repeat(5).trim();

describe('worker transcript reuse', () => {
    test('reuses stored transcript segment rows', () => {
        const segments = [{ startMs: 0, endMs: 500, text: 'A deterministic stored transcript' }];
        expect(storedTranscriptResult({
            id: 'stored-video',
            url: 'https://www.youtube.com/watch?v=storedvideo',
            transcript: longText,
            transcript_source: 'captions',
        }, segments)).toEqual({ text: longText, source: 'captions', segments });
    });

    test('keeps legacy stored transcripts with zero segments', () => {
        expect(storedTranscriptResult({
            id: 'legacy-video',
            url: 'https://www.youtube.com/watch?v=legacyvideo',
            transcript: longText,
            transcript_source: null,
        }, [])).toEqual({ text: longText, source: 'stored', segments: [] });
    });
});
