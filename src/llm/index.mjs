import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generateText } from './providers/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = readFileSync(join(__dirname, 'prompts', 'article.md'), 'utf8');

const TIMEOUT_MS = 10 * 60 * 1000; // long transcripts can take a few minutes
const SECTIONED_TRANSCRIPT_WORDS = 6000;
const SECTION_CHUNK_WORDS = 3000;
export const ARTICLE_PROMPT_VERSION = 'edited-transcript-v5';
const TOKEN_ESTIMATE_METHOD = 'estimated: ceil(characters / 4)';

const TLDR_PROMPT = [
    'You are consolidating ordered TLDR notes from sections of a long article.',
    '',
    'Return a single JSON object and nothing else with exactly one field:',
    '- `tldr`: a markdown string with 8-14 bullets. Start each bullet with `- `.',
    '',
    'Preserve the main arguments, concrete claims, named concepts, people, numbers, caveats, and conclusions.',
    'Do not add facts that are not in the section TLDRs.',
].join('\n');

async function transformWithLLM(systemPrompt, userPrompt) {
    return generateText({
        systemPrompt,
        userPrompt,
        timeoutMs: TIMEOUT_MS,
    });
}

// Extract the first JSON object from a string — tolerates leading/trailing
// prose or code fences even though the prompt asks for strict JSON.
function extractJson(text) {
    if (!text) return null;
    let s = text.trim();
    // Strip ```json ... ``` fences if present
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    // Find first { and match to last }
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first === -1 || last === -1 || last <= first) return null;
    const candidate = s.slice(first, last + 1);
    try { return JSON.parse(candidate); } catch { return null; }
}

export function estimateTokenCount(text) {
    return Math.ceil(String(text || '').length / 4);
}

function wordCount(text) {
    return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

export function splitTranscriptByWords(transcript, chunkWords = SECTION_CHUNK_WORDS) {
    const words = String(transcript || '').trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const chunks = [];
    for (let i = 0; i < words.length; i += chunkWords) {
        chunks.push(words.slice(i, i + chunkWords).join(' '));
    }
    return chunks;
}

function parseArticleResponse(text) {
    const parsed = extractJson(text);
    if (!parsed || typeof parsed.tldr !== 'string' || typeof parsed.article !== 'string') {
        throw new Error(`LLM returned invalid JSON (missing tldr/article). len=${(text || '').length}`);
    }
    return parsed;
}

function parseTldrResponse(text) {
    const parsed = extractJson(text);
    if (!parsed || typeof parsed.tldr !== 'string') {
        throw new Error(`LLM returned invalid JSON (missing tldr). len=${(text || '').length}`);
    }
    return parsed;
}

function combineCosts(costs) {
    const realCosts = costs.filter(Boolean);
    if (realCosts.length === 0) return null;
    const allMonetaryCostsKnown = realCosts.every(cost => Number.isFinite(cost.costUsd));
    return realCosts.reduce((acc, cost) => ({
        provider: acc.provider || cost.provider,
        model: acc.model || cost.model,
        costUsd: allMonetaryCostsKnown ? (acc.costUsd || 0) + cost.costUsd : null,
        inputTokens: (acc.inputTokens || 0) + (cost.inputTokens || 0),
        outputTokens: (acc.outputTokens || 0) + (cost.outputTokens || 0),
        totalTokens: (acc.totalTokens || 0) + (cost.totalTokens || 0),
        durationMs: (acc.durationMs || 0) + (cost.durationMs || 0),
        estimated: Boolean(acc.estimated || cost.estimated),
        estimateMethod: acc.estimateMethod || cost.estimateMethod,
    }), {});
}

function providerUsageToCost(result) {
    if (result.cost !== undefined) return result.cost;
    if (!result.usage) return null;
    return {
        provider: result.provider,
        model: result.model,
        costUsd: result.usage.costUsd,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.totalTokens,
        durationMs: result.durationMs || 0,
        estimated: Boolean(result.usage.estimated),
        estimateMethod: result.usage.estimated ? TOKEN_ESTIMATE_METHOD : 'reported',
    };
}

async function invokeArticleLlm(llm, systemPrompt, userPrompt) {
    const result = await llm(systemPrompt, userPrompt);
    return {
        ...result,
        cost: providerUsageToCost(result),
    };
}

function sectionSystemPrompt() {
    return [
        SYSTEM_PROMPT,
        '',
        'Additional instruction for this request: the user will provide only one ordered slice of a larger transcript.',
        'Write the article content for this slice only. Preserve the slice order and details.',
        'Do not write a global introduction or global conclusion unless that material appears in this slice.',
        'Use headings that make this slice easy to merge with adjacent sections.',
    ].join('\n');
}

function normalizeSectionArticle(article, index) {
    const text = String(article || '').trim();
    if (!text) return '';
    if (/^#{1,3}\s/m.test(text)) return text;
    return `### Section ${index + 1}\n\n${text}`;
}

function combineSectionArticles(sections) {
    return sections
        .map((section, index) => normalizeSectionArticle(section.article, index))
        .filter(Boolean)
        .join('\n\n');
}

function cleanMalformedArticleText(text) {
    return String(text || '')
        .trim()
        .replace(/^```(?:json|markdown)?\s*/i, '')
        .replace(/```\s*$/i, '')
        .replace(/^{"article"\s*:\s*"/i, '')
        .replace(/^{"tldr"\s*:\s*"[^"]*"\s*,\s*"article"\s*:\s*"/i, '')
        .replace(/\\"}\s*$/i, '')
        .replace(/"}\s*$/i, '')
        .replace(/\\n/g, '\n')
        .trim();
}

async function generateSectionArticle({ sectionPrompt, userPrompt, llm }) {
    let lastError = null;
    let lastText = '';
    let lastCost = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const prompt = attempt === 0 ? userPrompt : [
            userPrompt,
            '',
            'Your previous response was invalid because it was not a single JSON object with string fields `tldr` and `article`.',
            'Try again. Return only valid JSON. Escape newlines inside JSON strings. Do not include prose before or after the JSON object.',
        ].join('\n');

        const { text, cost } = await invokeArticleLlm(llm, sectionPrompt, prompt);
        lastText = text;
        lastCost = cost;
        try {
            return { parsed: parseArticleResponse(text), cost };
        } catch (err) {
            lastError = err;
        }
    }
    const article = cleanMalformedArticleText(lastText);
    if (article.length > 500) {
        return {
            parsed: {
                tldr: '- Section returned prose instead of JSON; article text was preserved.',
                article,
            },
            cost: lastCost,
        };
    }
    throw lastError;
}

async function transformVeryLongTranscript({ title, channel, transcript, llm }) {
    const chunks = splitTranscriptByWords(transcript, SECTION_CHUNK_WORDS);
    const sections = [];
    const costs = [];
    const sectionPrompt = sectionSystemPrompt();

    for (let i = 0; i < chunks.length; i += 1) {
        const userPrompt = [
            `Title: ${title || '(unknown)'}`,
            `Channel: ${channel || '(unknown)'}`,
            `Transcript slice: ${i + 1} of ${chunks.length}`,
            '',
            'Transcript slice:',
            chunks[i],
            '',
            'Write only the article material for this slice, plus a slice TLDR. Preserve all meaningful details from this slice. Return strict JSON with `tldr` and `article`.',
        ].join('\n');

        const { parsed, cost } = await generateSectionArticle({ sectionPrompt, userPrompt, llm });
        sections.push({
            tldr: parsed.tldr,
            article: parsed.article,
        });
        costs.push(cost);
    }

    const article = combineSectionArticles(sections);
    const tldrPrompt = [
        `Title: ${title || '(unknown)'}`,
        `Channel: ${channel || '(unknown)'}`,
        '',
        'Ordered section TLDRs:',
        sections.map((section, index) => `## Section ${index + 1} of ${sections.length}\n${section.tldr}`).join('\n\n'),
    ].join('\n');
    const { text, cost } = await invokeArticleLlm(llm, TLDR_PROMPT, tldrPrompt);
    costs.push(cost);
    const parsed = parseTldrResponse(text);

    return {
        tldr: parsed.tldr,
        article,
        cost: combineCosts(costs),
    };
}

export async function transformTranscript({ title, channel, transcript, llm = transformWithLLM }) {
    const transcriptWords = wordCount(transcript);
    if (articleTransformStrategy(transcriptWords) === 'sectioned') {
        return transformVeryLongTranscript({ title, channel, transcript, llm });
    }

    const userPrompt = [
        `Title: ${title || '(unknown)'}`,
        `Channel: ${channel || '(unknown)'}`,
        '',
        'Transcript:',
        transcript,
    ].join('\n');

    const { text, cost } = await invokeArticleLlm(llm, SYSTEM_PROMPT, userPrompt);
    const parsed = parseArticleResponse(text);
    return {
        tldr: parsed.tldr,
        article: parsed.article,
        cost,
    };
}

export function articleTransformStrategy(transcriptWords) {
    return transcriptWords > SECTIONED_TRANSCRIPT_WORDS ? 'sectioned' : 'direct';
}
