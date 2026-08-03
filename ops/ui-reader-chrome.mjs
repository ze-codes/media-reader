import { mkdirSync } from 'fs';
import { join } from 'path';

async function loadPlaywright() {
    try {
        return await import('playwright');
    } catch (error) {
        throw new Error('Playwright is required for browser QA; install it as a development dependency', { cause: error });
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const baseUrl = process.env.MEDIA_READER_BASE_URL || 'http://127.0.0.1:8099';
const artifactsDir = process.env.MEDIA_READER_QA_ARTIFACTS || join(process.cwd(), 'ops', 'artifacts');
mkdirSync(artifactsDir, { recursive: true });

function entryUrl() {
    const url = new URL(baseUrl);
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.toString();
}

function videoApiPath(videoId, suffix = '') {
    return { videoId, suffix };
}

async function requestVideoProgress(page, request) {
    return page.evaluate(async ({ videoId, suffix, method, progress }) => {
        const scriptUrl = document.querySelector('script[src*="app.js"]')?.src || location.href;
        const base = new URL('.', scriptUrl).pathname.replace(/\/$/, '');
        const response = await fetch(`${base}/api/videos/${encodeURIComponent(videoId)}${suffix}`, {
            method,
            headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
            body: method === 'POST' ? JSON.stringify({ progress }) : undefined,
        });
        if (!response.ok) throw new Error(`Progress API request failed (${response.status})`);
        return response.json();
    }, request);
}

async function captureCompletedArticle(page) {
    await page.goto(entryUrl(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const openButton = page.locator('.open-reader-btn').first();
    await openButton.waitFor({ state: 'visible', timeout: 20_000 });
    const videoId = await openButton.getAttribute('data-id');
    assert(videoId, 'The selected completed article has no video ID');
    const payload = await requestVideoProgress(page, {
        ...videoApiPath(videoId),
        method: 'GET',
    });
    const initialProgress = payload.video?.reading_progress;
    assert(typeof initialProgress === 'number', 'The selected article has no numeric persisted reading progress');
    return { videoId, initialProgress };
}

async function openCompletedArticle(page, videoId) {
    const openButton = page.locator(`.open-reader-btn[data-id="${videoId}"]`);
    await openButton.click();
    await page.locator('.reader-body').waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForFunction(() => document.body.classList.contains('reader-route'));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForFunction(() => window.scrollY === 0 && !document.body.classList.contains('reader-chrome-hidden'));
}

async function restoreReadingProgress(page, snapshot) {
    const readerActive = await page.evaluate(() => document.body.classList.contains('reader-route'));
    let flushStatus = 'not-needed';
    if (readerActive) {
        const flushResponse = page.waitForResponse(response => (
            response.request().method() === 'POST'
            && /\/api\/videos\/[^/]+\/progress$/.test(new URL(response.url()).pathname)
        ), { timeout: 10_000 });
        await page.locator('.back-library-btn').click();
        await page.waitForFunction(() => !document.body.classList.contains('reader-route'));
        const response = await flushResponse;
        flushStatus = String(response.status());
    } else {
        await page.evaluate(() => {
            if (!location.hash) return;
            history.pushState({ mediaReaderRoute: 'library' }, '', `${location.pathname}${location.search}`);
            window.dispatchEvent(new PopStateEvent('popstate'));
        });
        await page.waitForFunction(() => !location.hash && !document.body.classList.contains('reader-route'));
    }

    const restorePayload = await requestVideoProgress(page, {
        ...videoApiPath(snapshot.videoId, '/progress'),
        method: 'POST',
        progress: snapshot.initialProgress,
    });
    assert(restorePayload.progress === snapshot.initialProgress, 'Progress restore response did not preserve the exact initial value');

    const verifyPayload = await requestVideoProgress(page, {
        ...videoApiPath(snapshot.videoId),
        method: 'GET',
    });
    const restoredProgress = verifyPayload.video?.reading_progress;
    assert(restoredProgress === snapshot.initialProgress, 'Persisted reading progress did not exactly match its initial value after restoration');
    return {
        videoId: snapshot.videoId,
        initialProgress: snapshot.initialProgress,
        restoredProgress,
        exitFlushStatus: flushStatus,
    };
}

async function exerciseChrome(page, { reducedMotion }) {
    const snapshot = await captureCompletedArticle(page);
    let restorationEvidence;

    try {
        await openCompletedArticle(page, snapshot.videoId);

        const initial = await page.evaluate(() => ({
            contentbar: document.querySelector('.contentbar').getBoundingClientRect().toJSON(),
            readerBar: document.querySelector('.reader-bar').getBoundingClientRect().toJSON(),
            documentHeight: document.documentElement.scrollHeight,
            viewportHeight: window.innerHeight,
            transitionDuration: getComputedStyle(document.querySelector('.reader-bar')).transitionDuration,
        }));
        assert(initial.documentHeight > initial.viewportHeight + 500, 'The selected article is too short to exercise a 500px scroll');
        if (reducedMotion) {
            assert(initial.transitionDuration.split(',').every(value => value.trim() === '0s'), 'Reduced motion did not disable reader chrome transitions');
        }

        await page.evaluate(() => window.scrollTo(0, 500));
        await page.waitForFunction(() => document.body.classList.contains('reader-chrome-hidden'));
        if (!reducedMotion) await page.waitForTimeout(220);

        const hidden = await page.evaluate(() => {
            const progress = document.querySelector('.reader-progress-track-fixed');
            const progressBox = progress.getBoundingClientRect();
            return {
                contentbar: document.querySelector('.contentbar').getBoundingClientRect().toJSON(),
                readerBar: document.querySelector('.reader-bar').getBoundingClientRect().toJSON(),
                documentHeight: document.documentElement.scrollHeight,
                progress: progressBox.toJSON(),
                progressDisplay: getComputedStyle(progress).display,
                progressOpacity: getComputedStyle(progress).opacity,
            };
        });
        assert(hidden.contentbar.top < initial.contentbar.top - 50, 'Content bar did not move out of the viewport');
        assert(hidden.readerBar.top < initial.readerBar.top - 50, 'Reader bar did not move out of the viewport');
        assert(hidden.documentHeight === initial.documentHeight, 'Hiding chrome changed document height');
        assert(hidden.progressDisplay !== 'none' && hidden.progressOpacity === '1', 'Reading progress is not visible while chrome is hidden');
        assert(Math.abs(hidden.progress.top) < 0.5 && hidden.progress.height > 0, 'Reading progress is not fixed at the viewport top');

        await page.screenshot({
            path: join(artifactsDir, reducedMotion ? 'reader-chrome-hidden-reduced.png' : 'reader-chrome-hidden.png'),
        });

        await page.evaluate(() => window.scrollBy(0, -100));
        await page.waitForFunction(() => !document.body.classList.contains('reader-chrome-hidden'));
        if (!reducedMotion) await page.waitForTimeout(220);

        const restored = await page.evaluate(() => ({
            contentbar: document.querySelector('.contentbar').getBoundingClientRect().toJSON(),
            readerBar: document.querySelector('.reader-bar').getBoundingClientRect().toJSON(),
            fixedProgressDisplay: getComputedStyle(document.querySelector('.reader-progress-track-fixed')).display,
        }));
        assert(Math.abs(restored.contentbar.top - initial.contentbar.top) < 0.5, 'Content bar did not restore after upward scrolling');
        assert(Math.abs(restored.readerBar.top - initial.readerBar.top) < 0.5, 'Reader bar did not restore after upward scrolling');
        assert(restored.fixedProgressDisplay === 'none', 'Fixed progress mirror remained after chrome restoration');
    } finally {
        restorationEvidence = await restoreReadingProgress(page, snapshot);
    }

    return restorationEvidence;
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true });

try {
    const restorationEvidence = [];
    for (const reducedMotion of [false, true]) {
        const context = await browser.newContext({
            viewport: { width: 390, height: 844 },
            reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
        });
        try {
            const page = await context.newPage();
            restorationEvidence.push(await exerciseChrome(page, { reducedMotion }));
        } finally {
            await context.close();
        }
    }
    console.log('reader chrome ui ok:', baseUrl);
    console.log('viewport: 390x844');
    console.log('reading progress restored:', JSON.stringify(restorationEvidence));
    console.log('screenshots:', artifactsDir);
} finally {
    await browser.close();
}
