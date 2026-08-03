import { describe, expect, test } from 'bun:test';
import { createGenerationProvider, generateText } from '../src/llm/providers/index.mjs';

describe('generation provider factory', () => {
    test.each([
        ['codex-cli', 'LLM_CODEX_BIN', '/fake/codex', 'codex output'],
        ['claude-cli', 'LLM_CLAUDE_BIN', '/fake/claude', JSON.stringify({ type: 'result', subtype: 'success', result: 'claude output' })],
    ])('creates the %s provider with its configured binary', async (providerName, binaryVariable, binaryPath, stdout) => {
        let invocation;
        const provider = createGenerationProvider({
            env: {
                LLM_PROVIDER: providerName,
                LLM_MODEL: 'user/model',
                [binaryVariable]: binaryPath,
            },
            runCliProcess: async options => {
                invocation = options;
                return { stdout, stderr: '', exitCode: 0, durationMs: 3 };
            },
        });

        const result = await provider.generateText({ systemPrompt: 's', userPrompt: 'u' });
        expect(invocation.command).toBe(binaryPath);
        expect(result.provider).toBe(providerName);
    });

    test('creates a generic compatible provider from environment settings', async () => {
        const provider = createGenerationProvider({
            env: {
                LLM_PROVIDER: 'openai-compatible',
                LLM_MODEL: 'custom/model',
                LLM_BASE_URL: 'https://models.example.test/v1',
                LLM_API_KEY: 'test-key',
            },
            fetchImpl: async () => new Response(JSON.stringify({
                choices: [{ message: { content: 'ok' } }],
                usage: { prompt_tokens: 2, completion_tokens: 1 },
            }), { status: 200 }),
        });

        expect((await provider.generateText({ systemPrompt: 's', userPrompt: 'u' })).text).toBe('ok');
    });

    test('calls the private engine over HTTP and normalizes its result', async () => {
        let request;
        const result = await generateText({ systemPrompt: 's', userPrompt: 'u', timeoutMs: 20 }, {
            env: {
                LLM_PROVIDER: 'llm-engine',
                LLM_MODEL: 'private/model',
                LLM_ENGINE_URL: 'http://engine.example.test/',
            },
            fetchImpl: async (url, options) => {
                request = { url, options, body: JSON.parse(options.body) };
                return Response.json({
                    text: 'media_reader:u',
                    cost: {
                        provider: 'claude-cli',
                        model: 'private/model',
                        inputTokens: 3,
                        outputTokens: 2,
                        totalTokens: 5,
                        costUsd: 0.1,
                        durationMs: 12,
                    },
                });
            },
        });

        expect(request.url).toBe('http://engine.example.test/v1/text');
        expect(request.options).toMatchObject({
            method: 'POST',
            headers: { 'content-type': 'application/json' },
        });
        expect(request.options.signal).toBeInstanceOf(AbortSignal);
        expect(request.body).toEqual({
            task: 'media_reader',
            tier: 'balanced',
            model: 'private/model',
            systemPrompt: 's',
            prompt: 'u',
            timeoutMs: 20,
        });
        expect(result).toMatchObject({
            text: 'media_reader:u',
            provider: 'claude-cli',
            model: 'private/model',
            usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, costUsd: 0.1 },
            durationMs: 12,
        });
    });

    test.each([
        [401, { message: 'token secret-token rejected', kind: 'auth', status: 401 }, 'auth'],
        [502, { message: 'upstream quota at https://secret.example', kind: 'rate_limit', status: 429 }, 'rate_limit'],
        [504, { message: 'provider timed out', kind: 'timeout', status: 504 }, 'timeout'],
        [500, { message: 'provider configuration leaked secret-token', kind: 'configuration', status: 500 }, 'config'],
        [502, { message: 'unparseable provider output', kind: 'parse', status: 502 }, 'invalid_response'],
        [502, { message: 'upstream failed at https://secret.example', kind: 'provider_error', status: 502 }, 'provider'],
    ])('normalizes private engine HTTP %s failures', async (status, engineError, code) => {
        const provider = createGenerationProvider({
            env: {
                LLM_PROVIDER: 'llm-engine',
                LLM_ENGINE_URL: 'https://engine.example.test',
            },
            fetchImpl: async () => Response.json({ error: engineError }, { status }),
        });

        try {
            await provider.generateText({ systemPrompt: 's', userPrompt: 'u' });
            throw new Error('expected generation to fail');
        } catch (error) {
            expect(error).toMatchObject({ code, details: { status } });
            expect(error.message).not.toContain(engineError.message);
            expect(error.message).not.toContain('secret-token');
            expect(error.message).not.toContain('https://');
        }
    });

    test('does not retain remote error metadata while preserving HTTP classification', async () => {
        const remoteError = {
            message: 'remote-message-secret',
            kind: 'remote-kind-secret',
            status: 'remote-status-secret',
        };
        const provider = createGenerationProvider({
            env: {
                LLM_PROVIDER: 'llm-engine',
                LLM_ENGINE_URL: 'https://engine.example.test',
            },
            fetchImpl: async () => Response.json({ error: remoteError }, { status: 429 }),
        });

        try {
            await provider.generateText({ systemPrompt: 's', userPrompt: 'u' });
            throw new Error('expected generation to fail');
        } catch (error) {
            expect(error).toMatchObject({ code: 'rate_limit', details: { status: 429 } });
            const serialized = JSON.stringify(error);
            expect(serialized).not.toContain(remoteError.message);
            expect(serialized).not.toContain(remoteError.kind);
            expect(serialized).not.toContain(remoteError.status);
        }
    });

    test('falls back to HTTP status when the remote status is null', async () => {
        const provider = createGenerationProvider({
            env: {
                LLM_PROVIDER: 'llm-engine',
                LLM_ENGINE_URL: 'https://engine.example.test',
            },
            fetchImpl: async () => Response.json({
                error: {
                    message: 'remote-message-secret',
                    kind: 'remote-kind-secret',
                    status: null,
                },
            }, { status: 429 }),
        });

        await expect(provider.generateText({ systemPrompt: 's', userPrompt: 'u' }))
            .rejects.toMatchObject({ code: 'rate_limit', details: { status: 429 } });
    });

    test.each([
        [undefined],
        ['not-a-url'],
        ['file:///infra/llm-engine'],
    ])('rejects non-HTTP private engine URL %p', engineUrl => {
        expect(() => createGenerationProvider({
            env: { LLM_PROVIDER: 'llm-engine', LLM_ENGINE_URL: engineUrl },
            fetchImpl: async () => {
                throw new Error('fetch must not run');
            },
        })).toThrow(expect.objectContaining({
            code: 'config',
            message: 'LLM_ENGINE_URL must be a valid HTTP(S) URL',
        }));
    });

    test('normalizes malformed engine JSON without exposing its response body', async () => {
        const provider = createGenerationProvider({
            env: { LLM_PROVIDER: 'llm-engine', LLM_ENGINE_URL: 'https://engine.example.test' },
            fetchImpl: async () => new Response('secret malformed body', { status: 200 }),
        });

        try {
            await provider.generateText({ systemPrompt: 's', userPrompt: 'u' });
            throw new Error('expected generation to fail');
        } catch (error) {
            expect(error).toMatchObject({ code: 'invalid_response' });
            expect(error.message).not.toContain('secret malformed body');
        }
    });

    test('normalizes network failures without exposing their URL or response details', async () => {
        const provider = createGenerationProvider({
            env: { LLM_PROVIDER: 'llm-engine', LLM_ENGINE_URL: 'https://engine.example.test' },
            fetchImpl: async () => {
                throw new Error('request to https://engine.example.test?token=secret-token failed');
            },
        });

        await expect(provider.generateText({ systemPrompt: 's', userPrompt: 'u' }))
            .rejects.toEqual(expect.objectContaining({
                code: 'provider',
                message: 'llm-engine request failed',
            }));
    });

    test('aborts a private engine request when its timeout expires', async () => {
        const provider = createGenerationProvider({
            env: { LLM_PROVIDER: 'llm-engine', LLM_ENGINE_URL: 'https://engine.example.test' },
            fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            }),
        });

        await expect(provider.generateText({ systemPrompt: 's', userPrompt: 'u', timeoutMs: 5 }))
            .rejects.toMatchObject({ code: 'timeout' });
    });

    test('forwards cancellation to the private engine request', async () => {
        const controller = new AbortController();
        let receivedSignal;
        const provider = createGenerationProvider({
            env: { LLM_PROVIDER: 'llm-engine', LLM_ENGINE_URL: 'https://engine.example.test' },
            fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
                receivedSignal = signal;
                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            }),
        });
        const generation = provider.generateText({
            systemPrompt: 's',
            userPrompt: 'u',
            signal: controller.signal,
        });
        controller.abort();

        await expect(generation).rejects.toMatchObject({ code: 'cancelled' });
        expect(receivedSignal.aborted).toBe(true);
    });
});
