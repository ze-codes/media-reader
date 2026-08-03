import { describe, expect, test } from 'bun:test';
import {
    articleHash,
    articleIdFromHash,
    readerRouteFromHash,
    transcriptHash,
} from '../public/router.mjs';

describe('client routes', () => {
    test('round-trips article ids through the hash route', () => {
        expect(articleIdFromHash(articleHash('video/id with spaces'))).toBe('video/id with spaces');
        expect(readerRouteFromHash(articleHash('video/id with spaces'))).toEqual({
            videoId: 'video/id with spaces',
            tab: 'article',
        });
    });

    test('round-trips transcript routes while retaining the article id compatibility helper', () => {
        const hash = transcriptHash('video/id with spaces');
        expect(hash).toBe('#/article/video%2Fid%20with%20spaces/transcript');
        expect(readerRouteFromHash(hash)).toEqual({
            videoId: 'video/id with spaces',
            tab: 'transcript',
        });
        expect(articleIdFromHash(hash)).toBe('video/id with spaces');
    });

    test('ignores library and malformed routes', () => {
        expect(articleIdFromHash('')).toBe(null);
        expect(articleIdFromHash('#/')).toBe(null);
        expect(articleIdFromHash('#/article/%E0%A4%A')).toBe(null);
        expect(readerRouteFromHash('#/article/demo/notes')).toBe(null);
        expect(readerRouteFromHash('#/article/demo/transcript/extra')).toBe(null);
    });
});
