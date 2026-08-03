import { describe, expect, test } from 'bun:test';
import {
    parseFasterWhisperOutput,
    parseFastWhisperVadFilter,
    parseWhisperCppOutput,
} from '../src/transcripts/transcribe.mjs';

describe('faster-whisper VAD config', () => {
    test('enables VAD by default to avoid no-speech hallucinations', () => {
        expect(parseFastWhisperVadFilter(undefined)).toBe(true);
    });

    test('allows explicit opt-out for difficult recordings', () => {
        expect(parseFastWhisperVadFilter('0')).toBe(false);
    });

    test('keeps explicit opt-in enabled', () => {
        expect(parseFastWhisperVadFilter('1')).toBe(true);
    });
});

describe('native whisper timing parsers', () => {
    test('parses faster-whisper native second-based segments', () => {
        expect(parseFasterWhisperOutput({
            text: 'One two',
            segments: [
                { start: 0.125, end: 0.75, text: ' One ' },
                { start: 0.75, end: 1.5, text: 'two' },
            ],
        })).toEqual({
            text: 'One two',
            segments: [
                { startMs: 125, endMs: 750, text: 'One' },
                { startMs: 750, endMs: 1500, text: 'two' },
            ],
        });
    });

    test('parses whisper.cpp JSON transcription offsets as milliseconds', () => {
        expect(parseWhisperCppOutput({
            transcription: [
                { text: ' First ', offsets: { from: 250, to: 1000 } },
                { text: 'second', offsets: { from: 1000, to: 1750 } },
            ],
        })).toEqual({
            text: 'First second',
            segments: [
                { startMs: 250, endMs: 1000, text: 'First' },
                { startMs: 1000, endMs: 1750, text: 'second' },
            ],
        });
    });

    test('preserves valid whisper text with zero segments when timing is malformed', () => {
        expect(parseWhisperCppOutput({
            transcription: [{ text: 'Readable fallback', offsets: { from: -1, to: 50 } }],
        })).toEqual({ text: 'Readable fallback', segments: [] });
    });

    test('uses untimed CLI text when whisper.cpp JSON is unavailable or malformed', () => {
        expect(parseWhisperCppOutput('{malformed json', ' Plain text output remains readable. '))
            .toEqual({ text: 'Plain text output remains readable.', segments: [] });
    });
});
