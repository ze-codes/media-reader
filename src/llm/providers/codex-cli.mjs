import { GenerationError, GENERATION_ERROR_CODES } from './errors.mjs';
import { combineCliPrompt, runCliProcess } from './cli-process.mjs';
import { normalizeGenerationResult } from './result.mjs';

export function createCodexCliProvider({
    model,
    binaryPath = 'codex',
    runProcess = runCliProcess,
}) {
    return {
        async generateText({ systemPrompt, userPrompt, model: requestedModel, timeoutMs, signal }) {
            const selectedModel = requestedModel || model;
            const input = combineCliPrompt(systemPrompt, userPrompt);
            const result = await runProcess({
                command: binaryPath,
                args: [
                    'exec',
                    '--ephemeral',
                    '--skip-git-repo-check',
                    '--color',
                    'never',
                    '--sandbox',
                    'read-only',
                    '--model',
                    selectedModel,
                    '-',
                ],
                input,
                timeoutMs,
                signal,
            });
            const text = result.stdout.trim();
            if (!text) {
                throw new GenerationError(
                    GENERATION_ERROR_CODES.INVALID_RESPONSE,
                    'Codex CLI returned no generated text',
                );
            }
            return normalizeGenerationResult({
                text,
                provider: 'codex-cli',
                model: selectedModel,
                inputText: input,
                durationMs: result.durationMs,
            });
        },
    };
}
