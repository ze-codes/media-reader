function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function tokenCount(value) {
    const parsed = finiteNumber(value);
    return parsed === null ? null : Math.round(parsed);
}

function estimateTokens(text) {
    return Math.ceil(String(text ?? '').length / 4);
}

export function normalizeGenerationResult({
    text,
    provider,
    model,
    usage,
    durationMs,
    inputText = '',
}) {
    const reportedInput = tokenCount(usage?.inputTokens);
    const reportedOutput = tokenCount(usage?.outputTokens);
    const inputTokens = reportedInput ?? estimateTokens(inputText);
    const outputTokens = reportedOutput ?? estimateTokens(text);
    const reportedTotal = tokenCount(usage?.totalTokens);
    const estimated = Boolean(usage?.estimated || reportedInput === null || reportedOutput === null);

    return {
        text: String(text ?? ''),
        provider: String(provider || 'unknown'),
        model: String(model || 'provider-default'),
        usage: {
            inputTokens,
            outputTokens,
            totalTokens: reportedTotal ?? inputTokens + outputTokens,
            costUsd: finiteNumber(usage?.costUsd),
            estimated,
        },
        durationMs: Math.max(0, Math.round(finiteNumber(durationMs) ?? 0)),
    };
}
