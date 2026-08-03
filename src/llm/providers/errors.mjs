export const GENERATION_ERROR_CODES = Object.freeze({
    CONFIG: 'config',
    AUTH: 'auth',
    RATE_LIMIT: 'rate_limit',
    TIMEOUT: 'timeout',
    CANCELLED: 'cancelled',
    INVALID_RESPONSE: 'invalid_response',
    PROVIDER: 'provider',
});

function usableSecrets(secrets = []) {
    return secrets
        .filter(secret => typeof secret === 'string' && secret.length > 0)
        .sort((left, right) => right.length - left.length);
}

export function redactSecrets(value, secrets = []) {
    let redacted = String(value ?? '');
    for (const secret of usableSecrets(secrets)) {
        redacted = redacted.split(secret).join('[REDACTED]');
    }
    return redacted;
}

function redactValue(value, secrets) {
    if (typeof value === 'string') return redactSecrets(value, secrets);
    if (Array.isArray(value)) return value.map(item => redactValue(item, secrets));
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, redactValue(item, secrets)]),
        );
    }
    return value;
}

export class GenerationError extends Error {
    constructor(code, message, { cause, details, secrets = [] } = {}) {
        const safeCause = cause
            ? new Error(redactSecrets(cause?.message || cause, secrets))
            : undefined;
        super(redactSecrets(message, secrets), safeCause ? { cause: safeCause } : undefined);
        this.name = 'GenerationError';
        this.code = code;
        this.details = redactValue(details ?? null, secrets);
    }
}

export function providerErrorCode(error, { signal } = {}) {
    if (error instanceof GenerationError) return error.code;
    const status = Number(error?.status || error?.statusCode);
    if (status === 401 || status === 403) return GENERATION_ERROR_CODES.AUTH;
    if (status === 429) return GENERATION_ERROR_CODES.RATE_LIMIT;
    if (signal?.aborted || error?.name === 'AbortError') return GENERATION_ERROR_CODES.CANCELLED;
    if (
        error?.code === 'ETIMEDOUT' ||
        error?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
        /timed?\s*out|timeout/i.test(error?.message || '')
    ) return GENERATION_ERROR_CODES.TIMEOUT;
    return GENERATION_ERROR_CODES.PROVIDER;
}

export function configurationError(message) {
    return new GenerationError(GENERATION_ERROR_CODES.CONFIG, message);
}
