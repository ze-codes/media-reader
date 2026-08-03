import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Busboy from 'busboy';
import createDOMPurify from 'dompurify';
import express from 'express';
import { marked } from 'marked';

import { detectVideoSource, youtubeVideoIdFromUrl } from '../src/domain/source-detect.mjs';
import { resolveGenerationConfig } from '../src/llm/providers/config.mjs';
import { buildTranscriptResult } from '../src/transcripts/segments.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

assert.equal(typeof Busboy, 'function');
assert.equal(typeof createDOMPurify, 'function');
assert.equal(typeof express, 'function');
assert.equal(typeof marked, 'function');

const openRouter = resolveGenerationConfig({
    LLM_PROVIDER: 'openrouter',
    LLM_MODEL: 'example/model',
    LLM_API_KEY: 'smoke-placeholder-not-a-real-key',
});
assert.equal(openRouter.provider, 'openrouter');
assert.equal(openRouter.model, 'example/model');

const localEndpoint = resolveGenerationConfig({
    LLM_PROVIDER: 'openai-compatible',
    LLM_MODEL: 'local-model',
    LLM_BASE_URL: 'http://127.0.0.1:11434/v1',
});
assert.equal(localEndpoint.baseUrl, 'http://127.0.0.1:11434/v1');

assert.equal(detectVideoSource('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'youtube');
assert.equal(youtubeVideoIdFromUrl('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
assert.deepEqual(buildTranscriptResult({
    source: 'captions',
    segments: [{ startMs: 0, endMs: 1200, text: 'Public smoke.' }],
}), {
    text: 'Public smoke.',
    source: 'captions',
    segments: [{ startMs: 0, endMs: 1200, text: 'Public smoke.' }],
});

for (const path of [
    'public/index.html',
    'public/vendor/marked.umd.js',
    'public/vendor/purify.min.js',
    'src/db/schema.sql',
    'src/llm/prompts/article.md',
]) {
    await access(join(root, path));
}

const markedBundle = await readFile(join(root, 'public/vendor/marked.umd.js'), 'utf8');
const purifyBundle = await readFile(join(root, 'public/vendor/purify.min.js'), 'utf8');
assert.match(markedBundle.slice(0, 500), /marked v17\.0\.1/);
assert.match(purifyBundle.slice(0, 500), /DOMPurify 3\.3\.1/);

console.log('Public smoke passed: dependencies, configuration, core modules, and browser assets load without credentials.');
