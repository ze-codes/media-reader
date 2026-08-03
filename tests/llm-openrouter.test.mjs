import { describe, expect, test } from 'bun:test';
import { createOpenRouterProvider } from '../src/llm/providers/openrouter.mjs';

describe('OpenRouter provider', () => {
    test('uses its default endpoint, attribution headers, and reported cost', async () => {
        const requests = [];
        const provider = createOpenRouterProvider({
            apiKey: 'router-secret',
            appUrl: 'https://reader.example.test',
            appName: 'Media Reader',
            fetchImpl: async (url, init) => {
                requests.push({ url: String(url), init });
                return new Response(JSON.stringify({
                    model: 'vendor/model',
                    choices: [{ message: { content: 'router answer' } }],
                    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.003 },
                }), { status: 200 });
            },
        });

        const result = await provider.generateText({
            systemPrompt: 'system', userPrompt: 'user', model: 'vendor/model', timeoutMs: 100,
        });

        expect(requests[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
        expect(requests[0].init.headers['HTTP-Referer']).toBe('https://reader.example.test');
        expect(requests[0].init.headers['X-Title']).toBe('Media Reader');
        expect(result).toMatchObject({
            provider: 'openrouter',
            usage: { costUsd: 0.003, estimated: false },
        });
    });
});
