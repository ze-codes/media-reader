import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

async function loadPlaywright() {
    try {
        return await import('playwright');
    } catch (error) {
        throw new Error('Playwright is required for browser QA; install it as a development dependency', { cause: error });
    }
}

const baseUrl = process.env.MEDIA_READER_BASE_URL || 'http://127.0.0.1:8099';
const existingVideoUrl = process.env.MEDIA_READER_TEST_VIDEO_URL;
if (!existingVideoUrl) throw new Error('MEDIA_READER_TEST_VIDEO_URL is required for the add-video QA scenario');
const artifactsDir = process.env.MEDIA_READER_QA_ARTIFACTS || join(process.cwd(), 'ops', 'artifacts');
const uploadFixtureName = process.env.MEDIA_READER_UPLOAD_FIXTURE_NAME || 'media-reader-upload-smoke.wav';
const uploadFixturePath = join(artifactsDir, uploadFixtureName);

function entryUrl(rawUrl) {
    const url = new URL(rawUrl);
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.toString();
}

mkdirSync(artifactsDir, { recursive: true });

function writeSilentWav(path, { sampleRate = 16000, seconds = 1 } = {}) {
    const channels = 1;
    const bitsPerSample = 16;
    const bytesPerSample = bitsPerSample / 8;
    const frames = sampleRate * seconds;
    const dataSize = frames * channels * bytesPerSample;
    const buffer = Buffer.alloc(44 + dataSize);

    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
    buffer.writeUInt16LE(channels * bytesPerSample, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    writeFileSync(path, buffer);
}

writeSilentWav(uploadFixturePath);

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const consoleErrors = [];
page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', error => {
    consoleErrors.push(error.message);
});

try {
    await page.goto(entryUrl(baseUrl), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.getByRole('heading', { name: 'Media Reader' }).waitFor({ timeout: 10_000 });
    await page.locator('#channel-url').waitFor({ timeout: 10_000 });
    await page.locator('#media-file').waitFor({ state: 'attached', timeout: 10_000 });

    await page.fill('#channel-url', existingVideoUrl);
    await page.click('#add-btn');
    await page.getByText(/Already in Media Reader|Resolving video|Listing channel/).first().waitFor({ timeout: 15_000 });

    await page.setInputFiles('#media-file', uploadFixturePath);
    await page.getByText(/Uploaded file queued: media-reader-upload-smoke|Uploaded file accepted and queued: media-reader-upload-smoke/).first().waitFor({ timeout: 45_000 });
    await page.getByRole('heading', { name: 'Local uploads' }).waitFor({ timeout: 45_000 });
    await page.getByText('media-reader-upload-smoke').first().waitFor({ timeout: 45_000 });

    const screenshotPath = join(artifactsDir, 'media-reader-ui.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });

    if (consoleErrors.length) {
        console.error('console errors:');
        for (const error of consoleErrors) console.error('-', error);
        process.exitCode = 1;
    } else {
        console.log('ui ok:', baseUrl);
        console.log('upload fixture:', uploadFixturePath);
        console.log('screenshot:', screenshotPath);
    }
} finally {
    await browser.close();
}
