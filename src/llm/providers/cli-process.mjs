import { GenerationError, GENERATION_ERROR_CODES } from './errors.mjs';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_STDOUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_STDERR_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 250;

const INHERITED_ENVIRONMENT = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
    'LANG',
    'LC_ALL',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
];

class OutputLimitError extends Error {}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function minimalCliEnvironment(source = process.env, overrides = {}) {
    const environment = {};
    for (const key of INHERITED_ENVIRONMENT) {
        if (typeof source[key] === 'string') environment[key] = source[key];
    }
    return { ...environment, ...overrides };
}

export function combineCliPrompt(systemPrompt, userPrompt) {
    return `System instructions:\n${String(systemPrompt ?? '')}\n\nUser request:\n${String(userPrompt ?? '')}`;
}

async function readBounded(stream, maximumBytes) {
    const reader = stream.getReader();
    const chunks = [];
    let bytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > maximumBytes) throw new OutputLimitError();
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    const output = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(output);
}

function processError(stderr) {
    if (/rate[ -]?limit|too many requests|\b429\b|quota exceeded/i.test(stderr)) {
        return new GenerationError(
            GENERATION_ERROR_CODES.RATE_LIMIT,
            'CLI provider rate limit reached',
        );
    }
    if (/authentication|unauthori[sz]ed|forbidden|not logged in|log in|login required|invalid api key/i.test(stderr)) {
        return new GenerationError(
            GENERATION_ERROR_CODES.AUTH,
            'CLI provider authentication failed',
        );
    }
    return new GenerationError(
        GENERATION_ERROR_CODES.PROVIDER,
        'CLI provider process failed',
    );
}

async function terminateProcess(processHandle) {
    if (processHandle.exitCode !== null) return;
    try {
        processHandle.kill('SIGTERM');
    } catch {}

    const exited = await Promise.race([
        processHandle.exited.then(() => true, () => true),
        delay(TERMINATION_GRACE_MS).then(() => false),
    ]);
    if (!exited && processHandle.exitCode === null) {
        try {
            processHandle.kill('SIGKILL');
        } catch {}
        await processHandle.exited.catch(() => {});
    }
}

function spawnFailure(error) {
    if (error?.code === 'ENOENT' || /no such file|not found/i.test(error?.message || '')) {
        return new GenerationError(
            GENERATION_ERROR_CODES.CONFIG,
            'CLI executable was not found',
        );
    }
    return new GenerationError(
        GENERATION_ERROR_CODES.PROVIDER,
        'CLI provider process could not start',
    );
}

export async function runCliProcess({
    command,
    args = [],
    input = '',
    cwd,
    env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    maxStdoutBytes = DEFAULT_STDOUT_BYTES,
    maxStderrBytes = DEFAULT_STDERR_BYTES,
    spawnImpl = Bun.spawn,
}) {
    if (signal?.aborted) {
        throw new GenerationError(
            GENERATION_ERROR_CODES.CANCELLED,
            'CLI provider process cancelled',
        );
    }

    const startedAt = Date.now();
    let processHandle;
    try {
        processHandle = spawnImpl({
            cmd: [command, ...args],
            cwd,
            env: minimalCliEnvironment(process.env, env),
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe',
            shell: false,
        });
    } catch (error) {
        throw spawnFailure(error);
    }

    let stopReason = null;
    let resolveStopped;
    const stopped = new Promise(resolve => {
        resolveStopped = resolve;
    });
    const stop = reason => {
        if (stopReason) return;
        stopReason = reason;
        resolveStopped(reason);
        try {
            processHandle.kill('SIGTERM');
        } catch {}
    };
    const cancel = () => stop('cancelled');
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => stop('timeout'), timeoutMs)
        : null;

    const stdoutPromise = readBounded(processHandle.stdout, maxStdoutBytes);
    const stderrPromise = readBounded(processHandle.stderr, maxStderrBytes);
    stdoutPromise.catch(error => {
        if (error instanceof OutputLimitError) stop('stdout-limit');
    });
    stderrPromise.catch(error => {
        if (error instanceof OutputLimitError) stop('stderr-limit');
    });

    try {
        processHandle.stdin.write(String(input));
        processHandle.stdin.end();

        await Promise.race([processHandle.exited, stopped]);
        if (stopReason) await terminateProcess(processHandle);

        const [stdout, stderr, exitCode] = await Promise.all([
            stdoutPromise,
            stderrPromise,
            processHandle.exited,
        ]);

        if (stopReason === 'timeout') {
            throw new GenerationError(
                GENERATION_ERROR_CODES.TIMEOUT,
                'CLI provider process timed out',
            );
        }
        if (stopReason === 'cancelled') {
            throw new GenerationError(
                GENERATION_ERROR_CODES.CANCELLED,
                'CLI provider process cancelled',
            );
        }
        if (exitCode !== 0) throw processError(stderr);

        return {
            stdout,
            stderr,
            exitCode,
            durationMs: Date.now() - startedAt,
        };
    } catch (error) {
        if (error instanceof GenerationError) throw error;
        if (error instanceof OutputLimitError || stopReason?.endsWith('-limit')) {
            throw new GenerationError(
                GENERATION_ERROR_CODES.INVALID_RESPONSE,
                'CLI provider output exceeded the allowed size',
            );
        }
        throw new GenerationError(
            GENERATION_ERROR_CODES.PROVIDER,
            'CLI provider process failed',
        );
    } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (processHandle.exitCode === null) await terminateProcess(processHandle);
    }
}
