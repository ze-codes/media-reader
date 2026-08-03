import { describe, expect, test } from 'bun:test';
import { nextReaderChromeState } from '../public/reader-chrome.mjs';

describe('mobile reader chrome', () => {
    const visible = { hidden: false, lastY: 100 };

    test('hides after meaningful downward movement', () => {
        expect(nextReaderChromeState(visible, { y: 112, mobile: true })).toEqual({ hidden: true, lastY: 112 });
    });

    test('shows after upward movement or near the top', () => {
        expect(nextReaderChromeState({ hidden: true, lastY: 112 }, { y: 100, mobile: true })).toEqual({ hidden: false, lastY: 100 });
        expect(nextReaderChromeState({ hidden: true, lastY: 100 }, { y: 20, mobile: true })).toEqual({ hidden: false, lastY: 20 });
    });

    test('ignores jitter and disables hiding outside mobile reader mode', () => {
        expect(nextReaderChromeState(visible, { y: 106, mobile: true })).toEqual({ hidden: false, lastY: 100 });
        expect(nextReaderChromeState({ hidden: true, lastY: 100 }, { y: 130, mobile: false })).toEqual({ hidden: false, lastY: 130 });
    });
});
