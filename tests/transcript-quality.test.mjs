import { describe, expect, test } from 'bun:test';
import { isPlaceholderTranscript, isUsableTranscript } from '../src/domain/transcript-quality.mjs';

describe('transcript quality checks', () => {
    test('rejects repeated foreign-language placeholders', () => {
        const transcript = Array.from({ length: 20 }, () => '(speaking in foreign language)').join(' ');

        expect(isPlaceholderTranscript(transcript)).toBe(true);
        expect(isUsableTranscript(transcript, { minLength: 50 })).toBe(false);
    });

    test('allows isolated mentions of foreign-language captions', () => {
        const transcript = 'The caption says (speaking in foreign language), then the presenter explains the chip architecture in English with enough detail to be useful.';

        expect(isPlaceholderTranscript(transcript)).toBe(false);
        expect(isUsableTranscript(transcript, { minLength: 50 })).toBe(true);
    });
});
