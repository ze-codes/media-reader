import { describe, expect, test } from 'bun:test';
import {
    buildTranscriptResult,
    flattenTranscriptSegments,
    normalizeTranscriptSegments,
} from '../src/transcripts/segments.mjs';

describe('transcript segment normalization', () => {
    test('normalizes whitespace and milliseconds without reordering source cues', () => {
        expect(normalizeTranscriptSegments([
            { startMs: 2300.4, endMs: 3100.6, text: '  second\n cue ' },
            { startMs: 10.6, endMs: 125.2, text: ' first\tcue ' },
        ])).toEqual([
            { startMs: 2300, endMs: 3101, text: 'second cue' },
            { startMs: 11, endMs: 125, text: 'first cue' },
        ]);
    });

    test('rejects empty, negative, non-finite, and backwards cues', () => {
        expect(normalizeTranscriptSegments([
            { startMs: 0, endMs: 50, text: 'kept' },
            { startMs: -1, endMs: 2, text: 'negative' },
            { startMs: Number.NaN, endMs: 2, text: 'nan' },
            { startMs: null, endMs: 2, text: 'null start' },
            { startMs: '', endMs: 2, text: 'empty start' },
            { startMs: 20, endMs: 10, text: 'backwards' },
            { startMs: 20, endMs: Number.POSITIVE_INFINITY, text: 'infinite' },
            { startMs: 20, endMs: 30, text: '   ' },
        ])).toEqual([{ startMs: 0, endMs: 50, text: 'kept' }]);
    });

    test('flattens normalized cues deterministically', () => {
        const segments = [
            { startMs: 0, endMs: 500, text: ' First line ' },
            { startMs: 500, endMs: null, text: 'second\nline' },
        ];
        expect(flattenTranscriptSegments(segments)).toBe('First line second line');
    });

    test('keeps valid provider text when all timings are malformed', () => {
        expect(buildTranscriptResult({
            text: ' Provider\n text remains readable. ',
            source: 'transcriptapi',
            segments: [{ startMs: -10, endMs: 20, text: 'bad timing' }],
        })).toEqual({
            text: 'Provider text remains readable.',
            source: 'transcriptapi',
            segments: [],
        });
    });

    test('uses source segments as text only when provider text is absent', () => {
        expect(buildTranscriptResult({
            source: 'captions',
            segments: [{ startMs: 0, endMs: 100, text: 'cue text' }],
        })).toEqual({
            text: 'cue text',
            source: 'captions',
            segments: [{ startMs: 0, endMs: 100, text: 'cue text' }],
        });
    });
});
