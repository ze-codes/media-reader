import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getDb } from '../src/db/index.mjs';
import { generateText } from '../src/llm/providers/index.mjs';
import { DATA_DIR } from '../src/shared/paths.mjs';

const STOPWORDS = new Set([
    'about', 'after', 'again', 'against', 'because', 'before', 'being', 'between', 'could', 'every',
    'first', 'from', 'going', 'have', 'into', 'just', 'like', 'more', 'most', 'much', 'other',
    'really', 'right', 'should', 'their', 'there', 'these', 'thing', 'think', 'this', 'those',
    'through', 'today', 'under', 'where', 'which', 'while', 'would', 'youre',
]);

const BASE_JSON_RULE = [
    'Return a single JSON object and nothing else.',
    'The JSON must have exactly two string fields: `tldr` and `article`.',
    '`tldr` is 8-14 markdown bullets. `article` is markdown with `##` and `###` headings.',
    'Do not add facts, claims, examples, or conclusions that are not supported by the transcript.',
].join('\n');

const VARIANTS = {
    balanced: {
        label: 'Balanced complete article',
        system: [
            'You are an editor turning a long-form transcript into a complete, readable article.',
            'Preserve the speaker\'s reasoning, topic coverage, examples, named claims, caveats, and conclusions.',
            'Remove filler, repetition, false starts, sponsor reads, and off-topic chatter.',
            'Do not summarize narrowly or compress away major sections for brevity.',
            BASE_JSON_RULE,
        ].join('\n\n'),
    },
    substance_audit: {
        label: 'Substance audit, no numeric ratio',
        system: [
            'You are an editor producing a high-retention article from a long-form transcript.',
            'Your job is not to summarize. Your job is to preserve every distinct substantive claim, example, caveat, distinction, transition, named person, concrete number, causal explanation, prediction, and conclusion.',
            'Collapse only duplicated wording and remove only true verbal clutter: ums, restarts, repeated phrases, timestamp noise, sponsor reads, and unusable caption artifacts.',
            'If a point appears once and is meaningful, keep it. If a side point clarifies the speaker\'s reasoning, keep it. If the draft starts to feel like an overview, expand it.',
            'Do not use a fixed percentage target; use judgment based on how much real substance is in the transcript.',
            BASE_JSON_RULE,
        ].join('\n\n'),
    },
    edited_transcript: {
        label: 'Edited transcript with article structure',
        system: [
            'You are a transcript editor, not a summarizer.',
            'Convert the transcript into polished prose while keeping nearly all meaningful content in the same order.',
            'Add headings and paragraphs so it reads like an article, but treat the transcript as the manuscript. Edit out disfluencies, duplicate sentences, false starts, and caption glitches. Do not condense arguments just because they are long.',
            'Preserve supporting explanations, examples, objections, tangents that matter, and closing remarks. Prefer a long faithful article over a short elegant one.',
            BASE_JSON_RULE,
        ].join('\n\n'),
    },
};

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        videos: [],
        variants: Object.keys(VARIANTS),
        provider: process.env.LLM_PROVIDER || '',
        model: process.env.LLM_MODEL || '',
        maxChars: 0,
    };

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--videos') options.videos = args[++i].split(',').map(s => s.trim()).filter(Boolean);
        if (arg === '--variants') options.variants = args[++i].split(',').map(s => s.trim()).filter(Boolean);
        if (arg === '--provider') options.provider = args[++i];
        if (arg === '--model') options.model = args[++i];
        if (arg === '--max-chars') options.maxChars = Number(args[++i] || 0);
    }

    if (options.videos.length === 0) throw new Error('--videos is required and must contain at least one video ID');
    if (!options.provider) throw new Error('--provider or LLM_PROVIDER is required');
    if (!options.model) throw new Error('--model or LLM_MODEL is required');
    return options;
}

function extractJson(text) {
    const raw = String(text || '').trim();
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const s = fence ? fence[1].trim() : raw;
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first === -1 || last <= first) throw new Error('LLM response did not contain a JSON object');
    return JSON.parse(s.slice(first, last + 1));
}

function normalizedLength(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().length;
}

function words(text) {
    return String(text || '').toLowerCase().match(/[a-z][a-z'-]{3,}/g) || [];
}

function topTerms(text, limit = 80) {
    const counts = new Map();
    for (const word of words(text)) {
        const clean = word.replace(/^'+|'+$/g, '');
        if (clean.length < 5 || STOPWORDS.has(clean)) continue;
        counts.set(clean, (counts.get(clean) || 0) + 1);
    }
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([term]) => term);
}

function numbers(text) {
    return [...new Set(String(text || '').match(/\b\d+(?:[.,]\d+)?%?\b/g) || [])];
}

function coverage(transcript, article) {
    const articleLower = String(article || '').toLowerCase();
    const terms = topTerms(transcript);
    const nums = numbers(transcript);
    const termHits = terms.filter(term => articleLower.includes(term));
    const numberHits = nums.filter(num => articleLower.includes(num.toLowerCase()));
    return {
        topTermCoverage: terms.length ? termHits.length / terms.length : 1,
        numberCoverage: nums.length ? numberHits.length / nums.length : 1,
        missingTerms: terms.filter(term => !articleLower.includes(term)).slice(0, 20),
        missingNumbers: nums.filter(num => !articleLower.includes(num.toLowerCase())).slice(0, 20),
    };
}

function promptForVideo(video, transcript) {
    return [
        `Title: ${video.title || '(unknown)'}`,
        `Channel: ${video.channel_title || '(unknown)'}`,
        '',
        'Transcript:',
        transcript,
    ].join('\n');
}

function safeName(value) {
    return String(value || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
}

const options = parseArgs();
const generationEnv = {
    ...process.env,
    LLM_PROVIDER: options.provider,
    LLM_MODEL: options.model,
};
const db = getDb();
const outRoot = join(DATA_DIR, 'prompt-evals', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(outRoot, { recursive: true });

const summary = [];

for (const id of options.videos) {
    const video = db.prepare(`
        SELECT videos.*, channels.title AS channel_title
        FROM videos
        LEFT JOIN channels ON channels.id = videos.channel_id
        WHERE videos.id = ?
    `).get(id);

    if (!video?.transcript) {
        throw new Error(`No transcript found for video ${id}`);
    }

    const transcript = options.maxChars > 0 ? video.transcript.slice(0, options.maxChars) : video.transcript;

    for (const variantName of options.variants) {
        const variant = VARIANTS[variantName];
        if (!variant) throw new Error(`Unknown variant: ${variantName}`);

        const startedAt = Date.now();
        const result = await generateText({
            model: options.model,
            systemPrompt: variant.system,
            userPrompt: promptForVideo(video, transcript),
            timeoutMs: 10 * 60 * 1000,
        }, { env: generationEnv });
        const parsed = extractJson(result.text);
        if (typeof parsed.tldr !== 'string' || typeof parsed.article !== 'string') {
            throw new Error(`${variantName}/${id} returned invalid JSON shape`);
        }

        const metrics = {
            videoId: id,
            title: video.title,
            variant: variantName,
            label: variant.label,
            transcriptChars: normalizedLength(transcript),
            articleChars: normalizedLength(parsed.article),
            articlePct: Number((normalizedLength(parsed.article) * 100 / normalizedLength(transcript)).toFixed(1)),
            tldrChars: normalizedLength(parsed.tldr),
            durationMs: Date.now() - startedAt,
            cost: result.usage?.costUsd ?? null,
            ...coverage(transcript, parsed.article),
        };

        const dir = join(outRoot, safeName(id), safeName(variantName));
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'article.md'), parsed.article.trim() + '\n');
        writeFileSync(join(dir, 'tldr.md'), parsed.tldr.trim() + '\n');
        writeFileSync(join(dir, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n');
        writeFileSync(join(dir, 'system.md'), variant.system + '\n');

        summary.push(metrics);
        console.log(JSON.stringify(metrics));
    }
}

writeFileSync(join(outRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ outRoot, count: summary.length }, null, 2));
