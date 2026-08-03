import { configurationError } from './errors.mjs';

const PROVIDERS = new Set([
    'openrouter',
    'openai-compatible',
    'codex-cli',
    'claude-cli',
    'llm-engine',
]);
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

function firstDefined(...values) {
    return values.find(value => typeof value === 'string' && value.length > 0);
}

function requireNonBlank(value, variable) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw configurationError(`${variable} is required for the selected LLM provider`);
    }
    return value;
}

function requireHttpBaseUrl(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw configurationError('LLM_BASE_URL must be a valid HTTP(S) URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw configurationError('LLM_BASE_URL must be a valid HTTP(S) URL');
    }
    return value;
}

export function resolveGenerationConfig(env = process.env) {
    const legacyModel = firstDefined(
        env.LLM_MEDIA_READER_MODEL,
        env.MEDIA_READER_MODEL,
        env.YT_LLM_MODEL,
    );
    const explicitProvider = env.LLM_PROVIDER?.trim().toLowerCase();
    const privateSettingsPresent = Boolean(env.LLM_ENGINE_URL || legacyModel);
    const provider = explicitProvider || (privateSettingsPresent ? 'llm-engine' : '');

    if (!provider) {
        throw configurationError('LLM_PROVIDER is required when no private llm-engine settings are present');
    }
    if (!PROVIDERS.has(provider)) {
        throw configurationError('LLM_PROVIDER must be one of: openrouter, openai-compatible, codex-cli, claude-cli, llm-engine');
    }

    const model = firstDefined(env.LLM_MODEL, legacyModel);
    const apiKey = firstDefined(
        env.LLM_API_KEY,
        provider === 'openrouter' ? env.OPENROUTER_API_KEY : undefined,
    );
    const baseUrl = firstDefined(
        env.LLM_BASE_URL,
        provider === 'openrouter' ? OPENROUTER_BASE_URL : undefined,
    );

    if (provider === 'openrouter') {
        requireNonBlank(model, 'LLM_MODEL');
        requireNonBlank(apiKey, 'LLM_API_KEY or OPENROUTER_API_KEY');
    }
    if (provider === 'openai-compatible') {
        requireNonBlank(model, 'LLM_MODEL');
        requireNonBlank(baseUrl, 'LLM_BASE_URL');
    }
    if (provider === 'codex-cli' || provider === 'claude-cli') {
        requireNonBlank(model, 'LLM_MODEL');
    }
    if (provider === 'openrouter' || provider === 'openai-compatible') {
        requireHttpBaseUrl(baseUrl);
    }

    return {
        provider,
        model,
        baseUrl,
        apiKey,
        binaryPath: provider === 'codex-cli'
            ? firstDefined(env.LLM_CODEX_BIN, 'codex')
            : provider === 'claude-cli'
                ? firstDefined(env.LLM_CLAUDE_BIN, 'claude')
                : undefined,
        engineUrl: env.LLM_ENGINE_URL,
        appUrl: firstDefined(env.LLM_APP_URL, env.OPENROUTER_SITE_URL),
        appName: firstDefined(env.LLM_APP_NAME, env.OPENROUTER_APP_NAME),
    };
}

export function summarizeGenerationConfig(config) {
    return {
        provider: config.provider,
        model: config.model,
        baseUrl: config.baseUrl,
        hasApiKey: Boolean(config.apiKey),
    };
}

export { OPENROUTER_BASE_URL };
