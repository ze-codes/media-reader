import {
    GenerationError,
    GENERATION_ERROR_CODES,
    redactSecrets,
} from './errors.mjs';
import { normalizeGenerationResult } from './result.mjs';

export function resolveChatCompletionsUrl(baseUrl) {
    const url = new URL(baseUrl);
    const path = url.pathname.replace(/\/+$/, '');
    if (path.endsWith('/chat/completions')) return url.toString().replace(/\/$/, '');
    url.pathname = `${path || '/v1'}/chat/completions`;
    return url.toString();
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

async function errorMessage(response) {
    const body = await response.text();
    try {
        const parsed = JSON.parse(body);
        return parsed?.error?.message || parsed?.message || body;
    } catch {
        return body;
    }
}

function httpErrorCode(status) {
    if (status === 401 || status === 403) return GENERATION_ERROR_CODES.AUTH;
    if (status === 429) return GENERATION_ERROR_CODES.RATE_LIMIT;
    return GENERATION_ERROR_CODES.PROVIDER;
}

function responseText(payload) {
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        const text = content
            .filter(part => part?.type === 'text' && typeof part.text === 'string')
            .map(part => part.text)
            .join('');
        return text || null;
    }
    return null;
}

export function createOpenAICompatibleProvider({
    provider = 'openai-compatible',
    baseUrl,
    apiKey,
    appUrl,
    appName,
    fetchImpl = globalThis.fetch,
}) {
    const endpoint = resolveChatCompletionsUrl(baseUrl);
    const secrets = [apiKey];

    return {
        async generateText({ systemPrompt, userPrompt, model, timeoutMs, signal }) {
            const startedAt = Date.now();
            const combined = combineAbortSignals(signal, timeoutMs);
            if (combined.reason() === 'cancelled') {
                combined.cleanup();
                throw new GenerationError(GENERATION_ERROR_CODES.CANCELLED, 'generation cancelled');
            }

            try {
                const headers = { 'content-type': 'application/json' };
                if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
                if (appUrl) headers['HTTP-Referer'] = appUrl;
                if (appName) headers['X-Title'] = appName;

                const response = await fetchImpl(endpoint, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        model,
                        messages: [
                            { role: 'system', content: systemPrompt },
                            { role: 'user', content: userPrompt },
                        ],
                    }),
                    signal: combined.signal,
                });

                if (!response.ok) {
                    const message = redactSecrets(await errorMessage(response), secrets);
                    throw new GenerationError(
                        httpErrorCode(response.status),
                        message || `provider request failed with HTTP ${response.status}`,
                        { secrets, details: { status: response.status } },
                    );
                }

                let payload;
                try {
                    payload = await response.json();
                } catch (cause) {
                    throw new GenerationError(
                        GENERATION_ERROR_CODES.INVALID_RESPONSE,
                        'provider returned malformed JSON',
                        { cause },
                    );
                }
                const text = responseText(payload);
                if (text === null) {
                    throw new GenerationError(
                        GENERATION_ERROR_CODES.INVALID_RESPONSE,
                        'provider response is missing generated text',
                    );
                }

                return normalizeGenerationResult({
                    text,
                    provider,
                    model: payload.model || model,
                    usage: {
                        inputTokens: payload.usage?.prompt_tokens,
                        outputTokens: payload.usage?.completion_tokens,
                        totalTokens: payload.usage?.total_tokens,
                        costUsd: payload.usage?.cost,
                    },
                    inputText: `${systemPrompt}\n\n${userPrompt}`,
                    durationMs: Date.now() - startedAt,
                });
            } catch (error) {
                if (error instanceof GenerationError) throw error;
                if (combined.reason() === 'timeout') {
                    throw new GenerationError(GENERATION_ERROR_CODES.TIMEOUT, 'generation request timed out', { cause: error });
                }
                if (combined.reason() === 'cancelled' || signal?.aborted) {
                    throw new GenerationError(GENERATION_ERROR_CODES.CANCELLED, 'generation cancelled', { cause: error });
                }
                throw new GenerationError(
                    GENERATION_ERROR_CODES.PROVIDER,
                    redactSecrets(error?.message || 'provider request failed', secrets),
                    { cause: error, secrets },
                );
            } finally {
                combined.cleanup();
            }
        },
    };
}
