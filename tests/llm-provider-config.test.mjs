import { describe, expect, test } from 'bun:test';
import { resolveGenerationConfig, summarizeGenerationConfig } from '../src/llm/providers/config.mjs';

describe('generation provider configuration', () => {
    test('resolves OpenRouter aliases and keeps arbitrary model IDs verbatim', () => {
        const config = resolveGenerationConfig({
            LLM_PROVIDER: 'openrouter',
            LLM_MODEL: 'publisher/model-with+symbols:free',
            OPENROUTER_API_KEY: 'or-test-secret',
        });

        expect(config).toMatchObject({
            provider: 'openrouter',
            model: 'publisher/model-with+symbols:free',
            baseUrl: 'https://openrouter.ai/api/v1',
            apiKey: 'or-test-secret',
        });
    });

    test('uses neutral settings before migration aliases', () => {
        const config = resolveGenerationConfig({
            LLM_PROVIDER: 'openai-compatible',
            LLM_MODEL: 'neutral-model',
            LLM_BASE_URL: 'https://models.example.test/v1',
            LLM_API_KEY: 'neutral-key',
            LLM_MEDIA_READER_MODEL: 'legacy-model',
        });

        expect(config.model).toBe('neutral-model');
        expect(config.apiKey).toBe('neutral-key');
    });

    test('accepts existing model names as private-engine migration aliases', () => {
        const config = resolveGenerationConfig({
            LLM_PROVIDER: 'llm-engine',
            MEDIA_READER_MODEL: 'legacy/private-model',
        });

        expect(config).toMatchObject({ provider: 'llm-engine', model: 'legacy/private-model' });
    });

    test('requires model and endpoint for generic HTTP providers', () => {
        expect(() => resolveGenerationConfig({
            LLM_PROVIDER: 'openai-compatible',
            LLM_API_KEY: 'secret',
        })).toThrow(/LLM_MODEL/);

        expect(() => resolveGenerationConfig({
            LLM_PROVIDER: 'openai-compatible',
            LLM_MODEL: 'model',
            LLM_API_KEY: 'secret',
        })).toThrow(/LLM_BASE_URL/);
    });

    test.each(['codex-cli', 'claude-cli'])('resolves %s with a required model and optional binary override', provider => {
        const variable = provider === 'codex-cli' ? 'LLM_CODEX_BIN' : 'LLM_CLAUDE_BIN';
        const config = resolveGenerationConfig({
            LLM_PROVIDER: provider,
            LLM_MODEL: 'user/chosen-model',
            [variable]: `/opt/bin/${provider}`,
        });

        expect(config).toMatchObject({
            provider,
            model: 'user/chosen-model',
            binaryPath: `/opt/bin/${provider}`,
        });
        expect(config.apiKey).toBeUndefined();
    });

    test.each(['codex-cli', 'claude-cli'])('requires LLM_MODEL for %s', provider => {
        expect(() => resolveGenerationConfig({ LLM_PROVIDER: provider })).toThrow(/LLM_MODEL/);
    });

    test('normalizes invalid HTTP base URLs as configuration errors', () => {
        try {
            resolveGenerationConfig({
                LLM_PROVIDER: 'openai-compatible',
                LLM_MODEL: 'model',
                LLM_BASE_URL: 'not a valid URL',
            });
            throw new Error('expected configuration error');
        } catch (error) {
            expect(error).toMatchObject({ code: 'config' });
            expect(error.message).toContain('LLM_BASE_URL');
        }
    });

    test('rejects unknown providers and does not expose API keys in summaries', () => {
        expect(() => resolveGenerationConfig({ LLM_PROVIDER: 'mystery' }))
            .toThrow(/openrouter.*openai-compatible.*codex-cli.*claude-cli.*llm-engine/i);

        const config = resolveGenerationConfig({
            LLM_PROVIDER: 'openrouter',
            LLM_MODEL: 'vendor/model',
            LLM_API_KEY: 'never-show-this',
        });
        expect(JSON.stringify(summarizeGenerationConfig(config))).not.toContain('never-show-this');
        expect(summarizeGenerationConfig(config)).toEqual({
            provider: 'openrouter',
            model: 'vendor/model',
            baseUrl: 'https://openrouter.ai/api/v1',
            hasApiKey: true,
        });
    });

    test('defaults to the private adapter only when private settings are present', () => {
        expect(resolveGenerationConfig({ LLM_ENGINE_URL: 'http://llm-engine:8790' }).provider).toBe('llm-engine');
        expect(() => resolveGenerationConfig({})).toThrow(/LLM_PROVIDER/);
    });
});
