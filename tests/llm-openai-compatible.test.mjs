import { describe, expect, test } from 'bun:test';
import { createOpenAICompatibleProvider, resolveChatCompletionsUrl } from '../src/llm/providers/openai-compatible.mjs';

const input = {
    systemPrompt: 'system instructions',
    userPrompt: 'user request',
    model: 'owner/arbitrary:model',
    timeoutMs: 1000,
};

function response(body, status = 200) {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

describe('OpenAI-compatible provider', () => {
    test('safely resolves host and v1 base URLs', () => {
        expect(resolveChatCompletionsUrl('https://models.example.test')).toBe('https://models.example.test/v1/chat/completions');
        expect(resolveChatCompletionsUrl('https://models.example.test/v1/')).toBe('https://models.example.test/v1/chat/completions');
        expect(resolveChatCompletionsUrl('https://models.example.test/custom/v1')).toBe('https://models.example.test/custom/v1/chat/completions');
    });

    test('posts prompts and verbatim model with header-only credentials', async () => {
        const requests = [];
        const provider = createOpenAICompatibleProvider({
            provider: 'openai-compatible',
            baseUrl: 'https://models.example.test/v1',
            apiKey: 'header-only-secret',
            fetchImpl: async (url, init) => {
                requests.push({ url: String(url), init });
                return response({
                    model: 'served/model',
                    choices: [{ message: { content: 'generated text' } }],
                    usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
                });
            },
        });

        const result = await provider.generateText(input);
        const payload = JSON.parse(requests[0].init.body);
        expect(requests[0].url).toBe('https://models.example.test/v1/chat/completions');
        expect(requests[0].url).not.toContain('header-only-secret');
        expect(requests[0].init.headers.Authorization).toBe('Bearer header-only-secret');
        expect(payload).toEqual({
            model: 'owner/arbitrary:model',
            messages: [
                { role: 'system', content: 'system instructions' },
                { role: 'user', content: 'user request' },
            ],
        });
        expect(result).toMatchObject({
            text: 'generated text',
            provider: 'openai-compatible',
            model: 'served/model',
            usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13, costUsd: null, estimated: false },
        });
    });

    test.each([
        [401, 'auth'],
        [403, 'auth'],
        [429, 'rate_limit'],
        [500, 'provider'],
    ])('normalizes HTTP %i as %s and redacts echoed secrets', async (status, code) => {
        const provider = createOpenAICompatibleProvider({
            provider: 'openai-compatible',
            baseUrl: 'https://models.example.test',
            apiKey: 'echoed-secret-key',
            fetchImpl: async () => response({ error: { message: `failure echoed-secret-key` } }, status),
        });

        try {
            await provider.generateText(input);
            throw new Error('expected provider error');
        } catch (error) {
            expect(error.code).toBe(code);
            expect(error.message).not.toContain('echoed-secret-key');
        }
    });

    test('normalizes malformed JSON and missing content', async () => {
        const malformed = createOpenAICompatibleProvider({
            provider: 'openai-compatible', baseUrl: 'https://models.example.test', apiKey: 'x',
            fetchImpl: async () => response('{broken'),
        });
        await expect(malformed.generateText(input)).rejects.toMatchObject({ code: 'invalid_response' });

        const missing = createOpenAICompatibleProvider({
            provider: 'openai-compatible', baseUrl: 'https://models.example.test', apiKey: 'x',
            fetchImpl: async () => response({ choices: [{ message: {} }] }),
        });
        await expect(missing.generateText(input)).rejects.toMatchObject({ code: 'invalid_response' });
    });

    test('distinguishes timeout from external cancellation and removes the abort listener', async () => {
        const hangingFetch = (_url, { signal }) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        const provider = createOpenAICompatibleProvider({
            provider: 'openai-compatible', baseUrl: 'https://models.example.test', apiKey: 'x', fetchImpl: hangingFetch,
        });
        await expect(provider.generateText({ ...input, timeoutMs: 5 })).rejects.toMatchObject({ code: 'timeout' });

        const controller = new AbortController();
        const originalAdd = controller.signal.addEventListener.bind(controller.signal);
        const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
        let added = 0;
        let removed = 0;
        controller.signal.addEventListener = (...args) => { added += 1; return originalAdd(...args); };
        controller.signal.removeEventListener = (...args) => { removed += 1; return originalRemove(...args); };
        const promise = provider.generateText({ ...input, signal: controller.signal });
        controller.abort();
        await expect(promise).rejects.toMatchObject({ code: 'cancelled' });
        expect(removed).toBe(added);
    });
});
