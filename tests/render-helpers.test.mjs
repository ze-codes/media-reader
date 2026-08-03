import { describe, expect, test } from 'bun:test';
import { formatPublishedDate } from '../public/render-helpers.mjs';

describe('render helpers', () => {
    test('formats source publication dates consistently', () => {
        expect(formatPublishedDate('2026-07-12')).toBe('Jul 12, 2026');
        expect(formatPublishedDate('2026-07-12T23:30:00Z')).toBe('Jul 12, 2026');
    });

    test('omits missing or invalid publication dates', () => {
        expect(formatPublishedDate(null)).toBe('');
        expect(formatPublishedDate('not-a-date')).toBe('');
    });
});
