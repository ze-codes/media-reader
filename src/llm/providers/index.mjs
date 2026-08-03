import { resolveGenerationConfig } from './config.mjs';
import { createOpenAICompatibleProvider } from './openai-compatible.mjs';
import { createOpenRouterProvider } from './openrouter.mjs';
import { createPrivateEngineProvider } from './private-engine.mjs';
import { createCodexCliProvider } from './codex-cli.mjs';
import { createClaudeCliProvider } from './claude-cli.mjs';
import { runCliProcess as defaultRunCliProcess } from './cli-process.mjs';

export function createGenerationProvider({
    env = process.env,
    fetchImpl = globalThis.fetch,
    runCliProcess = defaultRunCliProcess,
} = {}) {
    const config = resolveGenerationConfig(env);
    if (config.provider === 'openrouter') {
        return createOpenRouterProvider({ ...config, fetchImpl });
    }
    if (config.provider === 'openai-compatible') {
        return createOpenAICompatibleProvider({ ...config, fetchImpl });
    }
    if (config.provider === 'codex-cli') {
        return createCodexCliProvider({ ...config, runProcess: runCliProcess });
    }
    if (config.provider === 'claude-cli') {
        return createClaudeCliProvider({ ...config, runProcess: runCliProcess });
    }
    return createPrivateEngineProvider({ ...config, fetchImpl });
}

export async function generateText(input, dependencies) {
    const provider = createGenerationProvider(dependencies);
    const config = resolveGenerationConfig(dependencies?.env || process.env);
    return provider.generateText({
        ...input,
        model: input.model || config.model,
    });
}
