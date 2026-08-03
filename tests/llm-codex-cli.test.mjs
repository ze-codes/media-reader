import { describe, expect, test } from 'bun:test';
import { createCodexCliProvider } from '../src/llm/providers/codex-cli.mjs';
import { GenerationError } from '../src/llm/providers/errors.mjs';

describe('Codex CLI provider', () => {
    test('uses official noninteractive argv and sends the combined prompt over stdin', async () => {
        let invocation;
        const provider = createCodexCliProvider({
            binaryPath: '/fake/codex',
            model: 'openai/test-model',
            runProcess: async options => {
                invocation = options;
                return { stdout: 'generated article', stderr: '', exitCode: 0, durationMs: 17 };
            },
        });

        const result = await provider.generateText({
            systemPrompt: 'system-only text',
            userPrompt: 'user-only text',
            timeoutMs: 1234,
        });

        expect(invocation.command).toBe('/fake/codex');
        expect(invocation.args).toEqual([
            'exec', '--ephemeral', '--skip-git-repo-check', '--color', 'never', '--sandbox', 'read-only',
            '--model', 'openai/test-model', '-',
        ]);
        expect(invocation.args.join(' ')).not.toContain('system-only text');
        expect(invocation.args.join(' ')).not.toContain('user-only text');
        expect(invocation.input).toBe('System instructions:\nsystem-only text\n\nUser request:\nuser-only text');
        expect(invocation.timeoutMs).toBe(1234);
        expect(result).toMatchObject({
            text: 'generated article',
            provider: 'codex-cli',
            model: 'openai/test-model',
            usage: { costUsd: null, estimated: true },
            durationMs: 17,
        });
    });

    test('preserves stable runner errors', async () => {
        const provider = createCodexCliProvider({
            model: 'model',
            runProcess: async () => {
                throw new GenerationError('auth', 'CLI provider authentication failed');
            },
        });

        await expect(provider.generateText({ systemPrompt: 's', userPrompt: 'u' }))
            .rejects.toMatchObject({ code: 'auth' });
    });

    test('rejects empty successful output as an invalid response', async () => {
        const provider = createCodexCliProvider({
            model: 'model',
            runProcess: async () => ({ stdout: '  ', stderr: '', exitCode: 0, durationMs: 1 }),
        });

        await expect(provider.generateText({ systemPrompt: 's', userPrompt: 'u' }))
            .rejects.toMatchObject({ code: 'invalid_response' });
    });
});
