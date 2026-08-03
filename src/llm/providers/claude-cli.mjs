import { GenerationError, GENERATION_ERROR_CODES } from './errors.mjs';
import { combineCliPrompt, runCliProcess } from './cli-process.mjs';
import { normalizeGenerationResult } from './result.mjs';

function parseResult(stdout) {
    let payload;
    try {
        payload = JSON.parse(stdout);
    } catch {
        throw new GenerationError(
            GENERATION_ERROR_CODES.INVALID_RESPONSE,
            'Claude CLI returned malformed JSON',
        );
    }
    if (payload?.is_error || payload?.subtype === 'error') {
        throw new GenerationError(
            GENERATION_ERROR_CODES.PROVIDER,
            'Claude CLI generation failed',
        );
    }
    if (payload?.type !== 'result' || typeof payload.result !== 'string' || !payload.result.trim()) {
        throw new GenerationError(
            GENERATION_ERROR_CODES.INVALID_RESPONSE,
            'Claude CLI response is missing generated text',
        );
    }
    return payload;
}

function inputTokensWithCache(usage) {
    const values = [
        usage?.input_tokens,
        usage?.cache_creation_input_tokens,
        usage?.cache_read_input_tokens,
    ];
    const reported = values.filter(value => Number.isFinite(Number(value)) && Number(value) >= 0);
    if (reported.length === 0) return undefined;
    return reported.reduce((total, value) => total + Number(value), 0);
}

export function createClaudeCliProvider({
    model,
    binaryPath = 'claude',
    runProcess = runCliProcess,
}) {
    return {
        async generateText({ systemPrompt, userPrompt, model: requestedModel, timeoutMs, signal }) {
            const selectedModel = requestedModel || model;
            const input = combineCliPrompt(systemPrompt, userPrompt);
            const processResult = await runProcess({
                command: binaryPath,
                args: [
                    '--print',
                    '--output-format',
                    'json',
                    '--no-session-persistence',
                    '--tools',
                    '',
                    '--model',
                    selectedModel,
                ],
                input,
                timeoutMs,
                signal,
            });
            const payload = parseResult(processResult.stdout);
            return normalizeGenerationResult({
                text: payload.result.trim(),
                provider: 'claude-cli',
                model: payload.model || selectedModel,
                usage: {
                    inputTokens: inputTokensWithCache(payload.usage),
                    outputTokens: payload.usage?.output_tokens,
                    totalTokens: payload.usage?.total_tokens,
                    costUsd: payload.total_cost_usd,
                },
                inputText: input,
                durationMs: payload.duration_ms ?? processResult.durationMs,
            });
        },
    };
}
