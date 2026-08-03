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

function exactClone(value) {
    return JSON.parse(JSON.stringify(value));
}

const baseUrl = process.env.MEDIA_READER_BASE_URL || 'http://127.0.0.1:8099';
const routedUrl = new URL(baseUrl);
const appPath = routedUrl.pathname.replace(/\/$/, '');
const youtubeId = 'MAI410fixture';
const escapedTimedText = '<img src=x onerror="window.__mai410Pwned=1"> & "escaped"';
const escapedUntimedText = '<script>window.__mai410Pwned=2</script> Untimed & readable.';
const longArticle = Array.from({ length: 72 }, (_, index) => (
    `## Article section ${index + 1}\n\nThis fixture paragraph makes reading progress deterministic without using a live record or database.`
)).join('\n\n');

function makeTimedSegments(firstText) {
    return Array.from({ length: 36 }, (_, index) => ({
        startMs: index === 0 ? 62_999 : 70_000 + (index * 4_000),
        endMs: index === 0 ? 66_000 : 73_000 + (index * 4_000),
        text: index === 0 ? firstText : `Timed fixture segment ${index + 1}.`,
        source: 'captions',
    }));
}

const initialRecords = [
    {
        id: 'mai410-timed-url',
        channel_id: 'mai410-fixtures',
        channel_title: 'MAI-410 fixtures',
        channel_handle: '@mai410',
        title: 'Timed URL transcript',
        published_at: '2026-08-03T00:00:00.000Z',
        duration_sec: 300,
        url: `https://www.youtube.com/watch?v=${youtubeId}&list=retained`,
        source_type: 'url',
        transcript_source: 'captions',
        state: 'done',
        error: null,
        read_at: '2026-08-01T12:00:00.000Z',
        reading_progress: 0.37,
        tldr: '- Isolated transcript reader fixture',
        article: longArticle,
        transcript: [escapedTimedText, ...Array.from({ length: 35 }, (_, index) => `Timed fixture segment ${index + 2}.`)].join(' '),
        segments: makeTimedSegments(escapedTimedText),
    },
    {
        id: 'mai410-upload',
        channel_id: 'mai410-fixtures',
        channel_title: 'MAI-410 fixtures',
        channel_handle: '@mai410',
        title: 'Timed upload transcript',
        published_at: '2026-08-02T00:00:00.000Z',
        duration_sec: 60,
        url: 'upload://mai410/upload.wav',
        source_type: 'upload',
        original_filename: 'upload.wav',
        uploaded_path: '/private/fixture/upload.wav',
        file_size_bytes: 4096,
        transcript_source: 'whisper',
        state: 'done',
        error: null,
        read_at: '2026-08-01T12:00:00.000Z',
        reading_progress: 0.125,
        tldr: '- Upload fixture',
        article: longArticle,
        transcript: 'Timed upload text.',
        segments: [{ startMs: 5_000, endMs: 7_000, text: 'Timed upload text.', source: 'whisper' }],
    },
    {
        id: 'mai410-untimed',
        channel_id: 'mai410-fixtures',
        channel_title: 'MAI-410 fixtures',
        channel_handle: '@mai410',
        title: 'Untimed legacy transcript',
        published_at: '2026-08-01T00:00:00.000Z',
        duration_sec: 45,
        url: `https://youtu.be/${youtubeId}`,
        source_type: 'url',
        transcript_source: 'legacy',
        state: 'done',
        error: null,
        read_at: '2026-08-01T12:00:00.000Z',
        reading_progress: 0.5,
        tldr: '- Untimed fixture',
        article: longArticle,
        transcript: `${escapedUntimedText}\n\nSecond untimed paragraph.`,
        segments: [],
    },
];

const records = new Map(initialRecords.map(record => [record.id, exactClone(record)]));
const requestLog = [];

function publicRecord(record, { transcript = false, segments = false } = {}) {
    const { uploaded_path, transcript: body, segments: storedSegments, ...safe } = record;
    if (transcript) safe.transcript = body;
    if (segments) safe.segments = exactClone(storedSegments);
    return safe;
}

function json(payload, status = 200) {
    return Response.json(payload, { status });
}

async function apiResponse(request, url) {
    requestLog.push({ method: request.method, pathname: url.pathname, search: url.search });
    if (url.pathname === '/api/channels') {
        return json({
            channels: [{
                id: 'mai410-fixtures',
                handle: '@mai410',
                title: 'MAI-410 fixtures',
                url: 'https://www.youtube.com/@mai410',
                status: 'ready',
                videos_total: records.size,
                videos_done: records.size,
                videos_error: 0,
            }],
        });
    }
    if (url.pathname === '/api/library') {
        const videos = [...records.values()].map(record => publicRecord(record));
        return json({
            videos,
            total: videos.length,
            limit: 50,
            offset: 0,
            counts: {
                all_count: videos.length,
                unread_count: 0,
                processing_count: 0,
                done_count: videos.length,
                error_count: 0,
            },
        });
    }
    const match = url.pathname.match(/^\/api\/videos\/([^/]+)(?:\/(read|progress))?$/);
    if (!match) return json({ error: 'not found' }, 404);
    const videoId = decodeURIComponent(match[1]);
    const action = match[2];
    const record = records.get(videoId);
    if (!record) return json({ error: 'not found' }, 404);

    if (request.method === 'GET' && !action) {
        return json({
            video: publicRecord(record, {
                transcript: url.searchParams.get('transcript') === '1',
                segments: url.searchParams.get('segments') === '1',
            }),
        });
    }
    if (request.method === 'POST' && action === 'read') {
        const body = await request.json();
        record.read_at = body.read === false ? null : '2026-08-03T12:00:00.000Z';
        return json({ ok: true, read: body.read !== false, read_at: record.read_at });
    }
    if (request.method === 'POST' && action === 'progress') {
        const body = await request.json();
        const progress = Number(body.progress);
        if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
            return json({ error: 'progress must be a number from 0 to 1' }, 400);
        }
        record.reading_progress = progress;
        return json({ ok: true, progress });
    }
    return json({ error: 'not found' }, 404);
}

function entryUrl() {
    const url = new URL(baseUrl);
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.toString();
}

function fixtureApiUrl(rawUrl) {
    const url = new URL(rawUrl);
    if (appPath && url.pathname.startsWith(`${appPath}/api/`)) {
        url.pathname = url.pathname.slice(appPath.length);
    }
    return url;
}

async function installFixtureRoutes(context) {
    await context.route('**/api/**', async route => {
        const playwrightRequest = route.request();
        const url = fixtureApiUrl(playwrightRequest.url());
        if (url.pathname === '/api/stream') {
            requestLog.push({ method: playwrightRequest.method(), pathname: url.pathname, search: url.search });
            await route.fulfill({
                status: 200,
                contentType: 'text/event-stream',
                body: `event: hello\ndata: ${JSON.stringify({ fixture: true })}\n\n`,
            });
            return;
        }

        const init = {
            method: playwrightRequest.method(),
            headers: playwrightRequest.headers(),
        };
        const postData = playwrightRequest.postData();
        if (postData !== null && !['GET', 'HEAD'].includes(init.method)) init.body = postData;
        const response = await apiResponse(new Request(url, init), url);
        await route.fulfill({
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            body: Buffer.from(await response.arrayBuffer()),
        });
    });
}

function recordState() {
    return [...records.values()].map(({ id, read_at, reading_progress }) => ({ id, read_at, reading_progress }));
}

function restoreRecordState(snapshot) {
    for (const saved of snapshot) {
        const record = records.get(saved.id);
        record.read_at = saved.read_at;
        record.reading_progress = saved.reading_progress;
    }
    assert(JSON.stringify(recordState()) === JSON.stringify(snapshot), 'Fixture persisted state was not restored exactly');
}

function assertProjection(payload, { transcript, segments }, label) {
    assert(!Object.hasOwn(payload, 'uploaded_path'), `${label} leaked uploaded_path`);
    assert(Object.hasOwn(payload, 'transcript') === transcript, `${label} transcript projection was incorrect`);
    assert(Object.hasOwn(payload, 'segments') === segments, `${label} segment projection was incorrect`);
}

async function projectionEvidence(page) {
    const evidence = await page.evaluate(async videoId => {
        const scriptUrl = document.querySelector('script[src*="app.js"]')?.src || location.href;
        const base = new URL('.', scriptUrl).pathname.replace(/\/$/, '');
        async function request(path) {
            const response = await fetch(`${base}${path}`);
            const text = await response.text();
            return { bytes: new TextEncoder().encode(text).byteLength, payload: JSON.parse(text) };
        }
        return {
            library: await request('/api/library?limit=50&offset=0&filter=all&sort=newest'),
            plain: await request(`/api/videos/${encodeURIComponent(videoId)}`),
            transcript: await request(`/api/videos/${encodeURIComponent(videoId)}?transcript=1`),
            segments: await request(`/api/videos/${encodeURIComponent(videoId)}?segments=1`),
            full: await request(`/api/videos/${encodeURIComponent(videoId)}?transcript=1&segments=1`),
        };
    }, 'mai410-timed-url');

    for (const video of evidence.library.payload.videos) assertProjection(video, { transcript: false, segments: false }, 'library video');
    assertProjection(evidence.plain.payload.video, { transcript: false, segments: false }, 'default reader payload');
    assertProjection(evidence.transcript.payload.video, { transcript: true, segments: false }, 'transcript-only reader payload');
    assertProjection(evidence.segments.payload.video, { transcript: false, segments: true }, 'segments-only reader payload');
    assertProjection(evidence.full.payload.video, { transcript: true, segments: true }, 'full reader payload');
    const libraryVideo = evidence.library.payload.videos.find(video => video.id === 'mai410-timed-url');
    const libraryVideoBytes = new TextEncoder().encode(JSON.stringify(libraryVideo)).byteLength;
    const fullReaderBytes = new TextEncoder().encode(JSON.stringify(evidence.full.payload.video)).byteLength;
    assert(libraryVideoBytes < fullReaderBytes, 'Library video projection was not smaller than the explicit full reader projection');
    return { libraryBytes: evidence.library.bytes, libraryVideoBytes, fullReaderBytes };
}

function isKnownConsoleNoise(message) {
    const text = String(message || '');
    const cloudflareBeaconCsp = text.includes('Content Security Policy')
        && text.includes('static.cloudflareinsights.com/beacon.min.js');
    const fixtureAbort = text.includes('net::ERR_ABORTED') && text.includes('MAI410fixture');
    const sseAbort = text.includes('net::ERR_ABORTED') && text.includes('/api/stream');
    return cloudflareBeaconCsp || fixtureAbort || sseAbort;
}

async function assertToolbarLayout(page, mobile) {
    const layout = await page.evaluate(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
        return {
            viewportWidth: innerWidth,
            bar: rect('.reader-bar'),
            left: rect('.reader-bar-left'),
            tabs: rect('.reader-tabs'),
            right: rect('.reader-bar-right'),
        };
    });
    for (const item of [layout.left, layout.tabs, layout.right]) {
        assert(item.left >= layout.bar.left - 0.5 && item.right <= layout.bar.right + 0.5, 'Reader toolbar content overflowed horizontally');
        assert(item.left >= -0.5 && item.right <= layout.viewportWidth + 0.5, 'Reader toolbar content left the viewport');
    }
    if (mobile) {
        assert(layout.tabs.top >= Math.max(layout.left.bottom, layout.right.bottom) - 0.5, 'Mobile tabs overlapped toolbar actions');
        assert(layout.left.right <= layout.right.left + 0.5, 'Mobile toolbar actions overlapped each other');
    } else {
        assert(layout.left.right <= layout.tabs.left + 0.5, 'Desktop left toolbar content overlapped tabs');
        assert(layout.tabs.right <= layout.right.left + 0.5, 'Desktop tabs overlapped right toolbar content');
    }
}

async function waitForReader(page, panelSelector) {
    await page.locator(panelSelector).waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForFunction(() => document.body.classList.contains('reader-route'));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function exerciseViewport(browser, viewport) {
    const mobile = viewport.width === 390;
    const stateSnapshot = exactClone(recordState());
    const context = await browser.newContext({ viewport });
    await installFixtureRoutes(context);
    const consoleErrors = [];
    context.on('page', popup => {
        popup.on('pageerror', error => consoleErrors.push(error.message));
    });
    await context.route('https://www.youtube.com/**', route => route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><title>isolated external target</title>',
    }));
    const page = await context.newPage();
    page.on('console', message => {
        if (message.type() === 'error' && !isKnownConsoleNoise(message.text())) consoleErrors.push(message.text());
    });
    page.on('pageerror', error => consoleErrors.push(error.message));

    let evidence;
    try {
        await page.goto(entryUrl(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.locator('.open-reader-btn[data-id="mai410-timed-url"]').waitFor({ state: 'visible', timeout: 10_000 });
        const projection = await projectionEvidence(page);
        const documentMarker = await page.evaluate(() => {
            window.__mai410DocumentMarker = crypto.randomUUID();
            return window.__mai410DocumentMarker;
        });
        const navigationCount = await page.evaluate(() => performance.getEntriesByType('navigation').length);

        await page.locator('.open-reader-btn[data-id="mai410-timed-url"]').click();
        await waitForReader(page, '#article-panel');
        assert(page.url().endsWith('#/article/mai410-timed-url'), 'Article route hash was incorrect');
        await assertToolbarLayout(page, mobile);

        const savedProgress = await page.evaluate(() => (
            scrollY / (document.documentElement.scrollHeight - innerHeight)
        ));
        assert(Math.abs(savedProgress - 0.37) < 0.001, 'Article did not restore the fixture progress near 0.37');
        const progressPostsBefore = requestLog.filter(entry => (
            entry.method === 'POST' && entry.pathname === '/api/videos/mai410-timed-url/progress'
        )).length;
        const progressResponse = page.waitForResponse(response => (
            response.request().method() === 'POST'
            && response.url().includes('/api/videos/mai410-timed-url/progress')
        ), { timeout: 10_000 });
        await page.getByRole('tab', { name: 'Transcript' }).click();
        assert((await progressResponse).ok(), 'Article progress flush failed while entering Transcript');
        await waitForReader(page, '#transcript-panel');
        assert(page.url().endsWith('#/article/mai410-timed-url/transcript'), 'Transcript route hash was incorrect');
        assert(records.get('mai410-timed-url').reading_progress === savedProgress, 'Flushed article progress did not preserve the exact computed value');
        assert(await page.evaluate(marker => window.__mai410DocumentMarker === marker, documentMarker), 'Article/Transcript switch replaced the document');
        assert(await page.evaluate(() => performance.getEntriesByType('navigation').length) === navigationCount, 'Article/Transcript switch added a document navigation');
        assert(await page.locator('.reader-progress-label, .reader-progress-track').count() === 0, 'Transcript exposed article progress UI');
        await assertToolbarLayout(page, mobile);

        const firstText = page.locator('.transcript-block p').first();
        assert(await firstText.textContent() === escapedTimedText, 'Escaped transcript text was not rendered verbatim');
        assert(await firstText.locator('img, script').count() === 0, 'Untrusted transcript text became executable markup');
        assert(await page.evaluate(() => window.__mai410Pwned) === undefined, 'Untrusted transcript markup executed');
        const timedLink = page.locator('a.transcript-time').first();
        const expectedHref = `https://www.youtube.com/watch?v=${youtubeId}&list=retained&t=62`;
        assert(await timedLink.getAttribute('href') === expectedHref, 'Timed source link did not contain the exact floored start second');
        assert(await timedLink.textContent() === '1:02', 'Timed source link label was incorrect');
        assert(await timedLink.getAttribute('target') === '_blank', 'Timed source link did not target a new tab');
        assert((await timedLink.getAttribute('rel'))?.split(/\s+/).includes('noreferrer'), 'Timed source link did not suppress referrers');
        const popupPromise = page.waitForEvent('popup', { timeout: 10_000 });
        await timedLink.click();
        const popup = await popupPromise;
        await popup.waitForLoadState('domcontentloaded');
        assert(popup.url() === expectedHref, 'Timed source link did not open the exact external URL');
        await popup.close();

        if (mobile) {
            await page.evaluate(() => scrollTo(0, 500));
            await page.waitForFunction(() => document.body.classList.contains('reader-chrome-hidden'));
            assert(await page.locator('.reader-progress-track-fixed').count() === 0, 'Transcript created a fixed article progress mirror');
            await page.evaluate(() => scrollTo(0, 300));
            await page.waitForFunction(() => !document.body.classList.contains('reader-chrome-hidden'));
        }

        await page.locator('.nav-reader-btn', { hasText: 'Next' }).click();
        await waitForReader(page, '#transcript-panel');
        assert(page.url().endsWith('#/article/mai410-upload/transcript'), 'Next did not preserve the Transcript tab for the upload');
        assert(await page.locator('.transcript-time').first().textContent() === '0:05', 'Upload timestamp text was missing');
        assert(await page.locator('.transcript-block a').count() === 0, 'Timed upload fabricated an external timestamp link');

        await page.locator('.nav-reader-btn', { hasText: 'Next' }).click();
        await waitForReader(page, '#transcript-panel');
        assert(page.url().endsWith('#/article/mai410-untimed/transcript'), 'Next did not preserve the Transcript tab for untimed text');
        assert(await page.locator('.transcript-block a, .transcript-time').count() === 0, 'Untimed transcript fabricated timestamp UI or links');
        assert((await page.locator('.transcript-block p').first().textContent()) === escapedUntimedText, 'Untimed escaped text was not readable verbatim');
        assert(await page.locator('.transcript-block script').count() === 0, 'Untimed transcript text became executable markup');
        assert(await page.evaluate(() => window.__mai410Pwned) === undefined, 'Untimed transcript markup executed');

        await page.goBack();
        await waitForReader(page, '#transcript-panel');
        assert(page.url().endsWith('#/article/mai410-upload/transcript'), 'First Back did not restore the upload Transcript route');
        await page.goBack();
        await waitForReader(page, '#transcript-panel');
        assert(page.url().endsWith('#/article/mai410-timed-url/transcript'), 'Second Back did not restore the timed Transcript route');
        await page.goBack();
        await waitForReader(page, '#article-panel');
        assert(page.url().endsWith('#/article/mai410-timed-url'), 'Back did not restore the Article route');
        assert(await page.evaluate(marker => window.__mai410DocumentMarker === marker, documentMarker), 'Back restored Article through a document navigation');
        assert(await page.evaluate(() => performance.getEntriesByType('navigation').length) === navigationCount, 'Back changed the document navigation count');
        const restored = await page.evaluate(() => ({
            scrollY,
            maximum: document.documentElement.scrollHeight - innerHeight,
            label: document.querySelector('.reader-progress-label')?.textContent,
        }));
        assert(Math.abs(restored.scrollY - (savedProgress * restored.maximum)) <= 2, 'Back did not restore the saved Article scroll position');
        assert(restored.label === `${Math.round(savedProgress * 100)}% read`, 'Back did not restore the saved Article progress label');
        const progressPostsAfter = requestLog.filter(entry => (
            entry.method === 'POST' && entry.pathname === '/api/videos/mai410-timed-url/progress'
        )).length;
        assert(progressPostsAfter - progressPostsBefore === 1, 'Article/Transcript flow did not issue exactly one progress POST');

        const fullRequests = requestLog.filter(entry => (
            entry.method === 'GET'
            && entry.pathname.startsWith('/api/videos/')
            && entry.search === '?transcript=1&segments=1'
        ));
        assert(fullRequests.some(entry => entry.pathname.endsWith('/mai410-timed-url')), 'Timed reader fetch omitted explicit transcript projection flags');
        assert(fullRequests.some(entry => entry.pathname.endsWith('/mai410-upload')), 'Upload reader fetch omitted explicit transcript projection flags');
        assert(fullRequests.some(entry => entry.pathname.endsWith('/mai410-untimed')), 'Untimed reader fetch omitted explicit transcript projection flags');
        assert(consoleErrors.length === 0, `Browser console errors: ${consoleErrors.join(' | ')}`);

        evidence = {
            viewport: `${viewport.width}x${viewport.height}`,
            savedProgress,
            restoredProgress: records.get('mai410-timed-url').reading_progress,
            projection,
        };
    } finally {
        if (!page.isClosed()) {
            await page.close({ runBeforeUnload: true }).catch(() => {});
            await Bun.sleep(50);
        }
        restoreRecordState(stateSnapshot);
        await context.close();
    }
    return evidence;
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true });

try {
    const results = [];
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
        results.push(await exerciseViewport(browser, viewport));
    }
    console.log('transcript reader ui ok:', baseUrl);
    console.log('isolated fixture state restored:', JSON.stringify(recordState()));
    console.log('viewport evidence:', JSON.stringify(results));
} finally {
    await browser.close();
}
