import { GenerationError, GENERATION_ERROR_CODES } from './errors.mjs';
import { normalizeGenerationResult } from './result.mjs';

function resolveEngineEndpoint(engineUrl) {
    let url;
    try {
        url = new URL(engineUrl);
    } catch {
        throw new GenerationError(
            GENERATION_ERROR_CODES.CONFIG,
            'LLM_ENGINE_URL must be a valid HTTP(S) URL',
        );
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new GenerationError(
            GENERATION_ERROR_CODES.CONFIG,
            'LLM_ENGINE_URL must be a valid HTTP(S) URL',
        );
    }
    return `${url.toString().replace(/\/+$/, '')}/v1/text`;
}

function combineAbortSignals(externalSignal, timeoutMs) {
    const controller = new AbortController();
    let reason = null;
    let timer = null;

    const cancel = () => {
        reason = 'cancelled';
        controller.abort(externalSignal?.reason);
    };
    if (externalSignal) {
        if (externalSignal.aborted) cancel();
        else externalSignal.addEventListener('abort', cancel, { once: true });
    }
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
            reason = 'timeout';
            controller.abort(new Error('generation timed out'));
        }, timeoutMs);
    }

    return {
        signal: controller.signal,
        reason: () => reason,
        cleanup() {
            if (timer) clearTimeout(timer);
            externalSignal?.removeEventListener('abort', cancel);
        },
    };
}

function engineErrorCode(error, status) {
    const kind = error?.kind;
    const rawRemoteStatus = error?.status;
    const remoteStatus = typeof rawRemoteStatus === 'number'
        ? rawRemoteStatus
        : typeof rawRemoteStatus === 'string' && rawRemoteStatus.trim().length > 0
            ? Number(rawRemoteStatus)
            : Number.NaN;
    const engineStatus = Number.isFinite(remoteStatus) ? remoteStatus : Number(status);
    if (kind === 'configuration') {
        return GENERATION_ERROR_CODES.CONFIG;
    }
    if (kind === 'auth' || engineStatus === 401 || engineStatus === 403) {
        return GENERATION_ERROR_CODES.AUTH;
    }
    if (kind === 'rate_limit' || engineStatus === 429) {
        return GENERATION_ERROR_CODES.RATE_LIMIT;
    }
    if (kind === 'timeout' || engineStatus === 408 || engineStatus === 504) {
        return GENERATION_ERROR_CODES.TIMEOUT;
    }
    if (kind === 'aborted' || kind === 'cancelled') {
        return GENERATION_ERROR_CODES.CANCELLED;
    }
    if (kind === 'parse') {
        return GENERATION_ERROR_CODES.INVALID_RESPONSE;
    }
    return GENERATION_ERROR_CODES.PROVIDER;
}

function safeEngineErrorMessage(code) {
    if (code === GENERATION_ERROR_CODES.CONFIG) return 'llm-engine configuration failed';
    if (code === GENERATION_ERROR_CODES.AUTH) return 'llm-engine authentication failed';
    if (code === GENERATION_ERROR_CODES.RATE_LIMIT) return 'llm-engine rate limit exceeded';
    if (code === GENERATION_ERROR_CODES.TIMEOUT) return 'llm-engine request timed out';
    if (code === GENERATION_ERROR_CODES.CANCELLED) return 'generation cancelled';
    if (code === GENERATION_ERROR_CODES.INVALID_RESPONSE) return 'llm-engine returned an invalid response';
    return 'llm-engine request failed';
}

export function createPrivateEngineProvider({
    model,
    engineUrl,
    fetchImpl = globalThis.fetch,
}) {
    const endpoint = resolveEngineEndpoint(engineUrl);

    return {
        async generateText({ systemPrompt, userPrompt, model: requestModel = model, timeoutMs, signal }) {
            const startedAt = Date.now();
            const combined = combineAbortSignals(signal, timeoutMs);
            if (combined.reason() === 'cancelled') {
                combined.cleanup();
                throw new GenerationError(GENERATION_ERROR_CODES.CANCELLED, 'generation cancelled');
            }

            try {
                const response = await fetchImpl(endpoint, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        task: 'media_reader',
                        tier: 'balanced',
                        model: requestModel,
                        systemPrompt,
                        prompt: userPrompt,
                        timeoutMs,
                    }),
                    signal: combined.signal,
                });

                let payload;
                try {
                    payload = await response.json();
                } catch {
                    if (!response.ok) {
                        throw new GenerationError(
                            GENERATION_ERROR_CODES.PROVIDER,
                            'llm-engine request failed',
                            { details: { status: response.status } },
                        );
                    }
                    throw new GenerationError(
                        GENERATION_ERROR_CODES.INVALID_RESPONSE,
                        'llm-engine returned malformed JSON',
                    );
                }

                if (!response.ok) {
                    const code = engineErrorCode(payload?.error, response.status);
                    throw new GenerationError(
                        code,
                        safeEngineErrorMessage(code),
                        {
                            details: { status: response.status },
                        },
                    );
                }
                if (typeof payload?.text !== 'string') {
                    throw new GenerationError(
                        GENERATION_ERROR_CODES.INVALID_RESPONSE,
                        'llm-engine response is missing generated text',
                    );
                }

                const cost = payload.cost || {};
                return normalizeGenerationResult({
                    text: payload.text,
                    provider: cost.provider || payload.provider || 'llm-engine',
                    model: cost.model || payload.model || requestModel,
                    usage: {
                        inputTokens: cost.inputTokens ?? payload.usage?.inputTokens,
                        outputTokens: cost.outputTokens ?? payload.usage?.outputTokens,
                        totalTokens: cost.totalTokens ?? payload.usage?.totalTokens,
                        costUsd: cost.costUsd ?? payload.usage?.costUsd,
                        estimated: cost.estimated ?? payload.usage?.estimated,
                    },
                    inputText: `${systemPrompt}\n\n${userPrompt}`,
                    durationMs: cost.durationMs ?? payload.durationMs ?? Date.now() - startedAt,
                });
            } catch (error) {
                if (error instanceof GenerationError) throw error;
                if (combined.reason() === 'timeout') {
                    throw new GenerationError(GENERATION_ERROR_CODES.TIMEOUT, 'llm-engine request timed out');
                }
                if (combined.reason() === 'cancelled' || signal?.aborted) {
                    throw new GenerationError(GENERATION_ERROR_CODES.CANCELLED, 'generation cancelled');
                }
                throw new GenerationError(
                    GENERATION_ERROR_CODES.PROVIDER,
                    'llm-engine request failed',
                );
            } finally {
                combined.cleanup();
            }
        },
    };
}
