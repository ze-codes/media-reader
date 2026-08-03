import { OPENROUTER_BASE_URL } from './config.mjs';
import { createOpenAICompatibleProvider } from './openai-compatible.mjs';

export function createOpenRouterProvider(options = {}) {
    return createOpenAICompatibleProvider({
        ...options,
        provider: 'openrouter',
        baseUrl: options.baseUrl || OPENROUTER_BASE_URL,
    });
}
