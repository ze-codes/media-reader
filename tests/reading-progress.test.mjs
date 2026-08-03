import { describe, expect, test } from 'bun:test';
import {
    clampReadingProgress,
    readingProgressFromScroll,
    scrollTopForReadingProgress,
} from '../public/reading-progress.mjs';

describe('reading progress', () => {
    test('normalizes document scroll position', () => {
        expect(readingProgressFromScroll({ scrollTop: 600, scrollHeight: 2000, viewportHeight: 800 })).toBe(0.5);
        expect(readingProgressFromScroll({ scrollTop: 5000, scrollHeight: 2000, viewportHeight: 800 })).toBe(1);
    });

    test('restores a normalized position against the current layout', () => {
        expect(scrollTopForReadingProgress(0.5, { scrollHeight: 3000, viewportHeight: 1000 })).toBe(1000);
        expect(scrollTopForReadingProgress(2, { scrollHeight: 3000, viewportHeight: 1000 })).toBe(2000);
    });

    test('clamps invalid values', () => {
        expect(clampReadingProgress(-1)).toBe(0);
        expect(clampReadingProgress('invalid')).toBe(0);
    });
});
