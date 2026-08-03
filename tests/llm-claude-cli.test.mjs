import { describe, expect, test } from 'bun:test';
import { createClaudeCliProvider } from '../src/llm/providers/claude-cli.mjs';

describe('Claude CLI provider', () => {
    test('uses official stateless JSON argv and normalizes the result', async () => {
        let invocation;
        const provider = createClaudeCliProvider({
            binaryPath: '/fake/claude',
            model: 'claude-test-model',
            runProcess: async options => {
                invocation = options;
                return {
                    stdout: JSON.stringify({
                        type: 'result',
                        subtype: 'success',
                        is_error: false,
                        result: 'generated article',
                        duration_ms: 91,
                        total_cost_usd: 0.012,
                        usage: {
                            input_tokens: 11,
                            cache_creation_input_tokens: 5,
                            cache_read_input_tokens: 3,
                            output_tokens: 7,
                            total_tokens: 29,
                        },
                    }),
                    stderr: '',
                    exitCode: 0,
                    durationMs: 100,
                };
            },
        });

        const result = await provider.generateText({
            systemPrompt: 'system-only text',
            userPrompt: 'user-only text',
            signal: new AbortController().signal,
        });

        expect(invocation.command).toBe('/fake/claude');
        expect(invocation.args).toEqual([
            '--print', '--output-format', 'json', '--no-session-persistence',
            '--tools', '', '--model', 'claude-test-model',
        ]);
        expect(invocation.args.join(' ')).not.toContain('system-only text');
        expect(invocation.args.join(' ')).not.toContain('user-only text');
        expect(invocation.input).toBe('System instructions:\nsystem-only text\n\nUser request:\nuser-only text');
        expect(result).toEqual({
            text: 'generated article',
            provider: 'claude-cli',
            model: 'claude-test-model',
            usage: {
                inputTokens: 19,
                outputTokens: 7,
                totalTokens: 29,
                costUsd: 0.012,
                estimated: false,
            },
            durationMs: 91,
        });
    });

    test('rejects malformed and error JSON without echoing provider content', async () => {
        const malformed = createClaudeCliProvider({
            model: 'model',
            runProcess: async () => ({ stdout: '{secret prompt', durationMs: 1 }),
        });
        await expect(malformed.generateText({ systemPrompt: 's', userPrompt: 'u' }))
            .rejects.toMatchObject({ code: 'invalid_response', message: 'Claude CLI returned malformed JSON' });

        const failed = createClaudeCliProvider({
            model: 'model',
            runProcess: async () => ({
                stdout: JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'sk-secret detail' }),
                durationMs: 1,
            }),
        });
        try {
            await failed.generateText({ systemPrompt: 'full private prompt', userPrompt: 'u' });
            throw new Error('expected failure');
        } catch (error) {
            expect(error).toMatchObject({ code: 'provider', message: 'Claude CLI generation failed' });
            expect(JSON.stringify(error)).not.toContain('sk-secret');
            expect(JSON.stringify(error)).not.toContain('full private prompt');
        }
    });

    test('rejects success JSON without result text', async () => {
        const provider = createClaudeCliProvider({
            model: 'model',
            runProcess: async () => ({ stdout: JSON.stringify({ type: 'result', subtype: 'success' }), durationMs: 1 }),
        });

        await expect(provider.generateText({ systemPrompt: 's', userPrompt: 'u' }))
            .rejects.toMatchObject({ code: 'invalid_response' });
    });
});
