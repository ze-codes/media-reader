import { describe, expect, test } from 'bun:test';
import {
    GenerationError,
    GENERATION_ERROR_CODES,
    redactSecrets,
} from '../src/llm/providers/errors.mjs';
import { normalizeGenerationResult } from '../src/llm/providers/result.mjs';

describe('generation provider results', () => {
    test('normalizes reported usage and monetary cost', () => {
        expect(normalizeGenerationResult({
            text: 'answer',
            provider: 'openrouter',
            model: 'vendor/arbitrary-model:beta',
            usage: {
                inputTokens: 12,
                outputTokens: 7,
                costUsd: '0.0042',
            },
            durationMs: 19.8,
        })).toEqual({
            text: 'answer',
            provider: 'openrouter',
            model: 'vendor/arbitrary-model:beta',
            usage: {
                inputTokens: 12,
                outputTokens: 7,
                totalTokens: 19,
                costUsd: 0.0042,
                estimated: false,
            },
            durationMs: 20,
        });
    });

    test('estimates missing token counts without inventing monetary cost', () => {
        const result = normalizeGenerationResult({
            text: '12345678',
            provider: 'openai-compatible',
            model: 'local/custom',
            usage: null,
            inputText: '123456789',
            durationMs: 3,
        });

        expect(result.usage).toEqual({
            inputTokens: 3,
            outputTokens: 2,
            totalTokens: 5,
            costUsd: null,
            estimated: true,
        });
    });

    test('redacts every configured secret from errors and metadata', () => {
        const secrets = ['provider-test-secret-value', 'secondary-token'];
        const error = new GenerationError(
            GENERATION_ERROR_CODES.PROVIDER,
            'endpoint echoed provider-test-secret-value and secondary-token',
            {
                secrets,
                details: { body: 'provider-test-secret-value' },
                cause: new Error('upstream cause provider-test-secret-value'),
            },
        );

        expect(error.message).not.toContain(secrets[0]);
        expect(error.message).not.toContain(secrets[1]);
        expect(JSON.stringify(error.details)).not.toContain(secrets[0]);
        expect(error.cause.message).not.toContain(secrets[0]);
        expect(redactSecrets('token=provider-test-secret-value', secrets)).toBe('token=[REDACTED]');
    });
});
