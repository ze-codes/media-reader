import { constants } from 'fs';
import { access, mkdir, open, readdir, unlink } from 'fs/promises';
import { join } from 'path';

const CLI_PROVIDERS = new Set(['codex-cli', 'claude-cli']);

function result(id, status, message, required = true) {
    return { id, status, message, details: { required } };
}

function commandSucceeded(commandResult) {
    return commandResult?.exitCode === 0;
}

function claudeLoggedIn(commandResult) {
    if (typeof commandResult?.loggedIn === 'boolean') return commandResult.loggedIn;
    try {
        const parsed = JSON.parse(String(commandResult?.stdout || ''), (key, value) => (
            key === '' || key === 'loggedIn' ? value : undefined
        ));
        return parsed?.loggedIn === true;
    } catch {
        return false;
    }
}

export function createCommandCheck({ id, label, command, args, executeCommand }) {
    return async function checkCommand() {
        try {
            const commandResult = await executeCommand(command, args);
            if (commandSucceeded(commandResult)) {
                return result(id, 'pass', `${label} is available.`);
            }
            return result(id, 'fail', `${label} is unavailable.`);
        } catch {
            return result(id, 'fail', `${label} could not be executed.`);
        }
    };
}

export function createWhisperCheck({ env, executeCommand }) {
    return async function checkWhisper() {
        const backend = env.YT_TRANSCRIBE_BACKEND || 'faster-whisper';
        let command;
        let args;
        if (backend === 'faster-whisper') {
            command = env.YT_FAST_WHISPER_PYTHON || 'python3';
            args = ['-c', 'import faster_whisper'];
        } else if (backend === 'whisper.cpp') {
            command = 'whisper-cli';
            args = ['--help'];
        } else {
            return result('whisper-backend', 'fail', 'The selected Whisper backend is not supported.');
        }

        try {
            const commandResult = await executeCommand(command, args);
            if (commandSucceeded(commandResult)) {
                return result('whisper-backend', 'pass', 'The selected Whisper backend is available.');
            }
            return result('whisper-backend', 'fail', 'The selected Whisper backend is unavailable.');
        } catch {
            return result('whisper-backend', 'fail', 'The selected Whisper backend could not be executed.');
        }
    };
}

export function createProviderChecks({ resolveProvider }) {
    const configState = Promise.resolve().then(resolveProvider).then(
        config => ({ ok: true, config }),
        () => ({ ok: false }),
    );

    const configuration = async () => {
        const state = await configState;
        if (!state.ok) {
            return result('provider-config', 'fail', 'Generation provider configuration is invalid.');
        }
        return result('provider-config', 'pass', 'Generation provider configuration is valid.');
    };

    const binary = async ({ executeCommand }) => {
        const state = await configState;
        if (!state.ok) {
            return result('provider-binary', 'fail', 'The selected provider binary could not be checked.');
        }
        if (!CLI_PROVIDERS.has(state.config.provider)) {
            return result('provider-binary', 'pass', 'The selected provider does not require a local CLI binary.');
        }
        const fallback = state.config.provider === 'codex-cli' ? 'codex' : 'claude';
        const command = state.config.binaryPath || fallback;
        try {
            const commandResult = await executeCommand(command, ['--version']);
            if (commandSucceeded(commandResult)) {
                return result('provider-binary', 'pass', 'The selected provider binary is available.');
            }
            return result('provider-binary', 'fail', 'The selected provider binary is unavailable.');
        } catch {
            return result('provider-binary', 'fail', 'The selected provider binary could not be executed.');
        }
    };

    const login = async ({ executeCommand }) => {
        const state = await configState;
        if (!state.ok) {
            return result('provider-login', 'fail', 'Provider authentication could not be checked.');
        }
        if (!CLI_PROVIDERS.has(state.config.provider)) {
            return result('provider-login', 'pass', 'The selected provider does not use native CLI authentication.');
        }

        const isCodex = state.config.provider === 'codex-cli';
        const command = state.config.binaryPath || (isCodex ? 'codex' : 'claude');
        const args = isCodex ? ['login', 'status'] : ['auth', 'status'];
        try {
            const commandResult = await executeCommand(command, args, {
                output: isCodex ? 'discard' : 'claude-auth-json',
            });
            let loggedIn;
            if (isCodex) {
                loggedIn = commandSucceeded(commandResult);
            } else {
                loggedIn = commandSucceeded(commandResult) && claudeLoggedIn(commandResult);
            }

            if (loggedIn) {
                return result('provider-login', 'pass', 'Selected provider CLI is authenticated.');
            }
            return result('provider-login', 'fail', 'Selected provider CLI is not authenticated.');
        } catch {
            return result('provider-login', 'fail', 'Provider authentication status could not be checked.');
        }
    };

    return { configuration, binary, login };
}

export function createWritablePathCheck({ id, label, path }) {
    return async function checkWritablePath() {
        let probe;
        try {
            await mkdir(path, { recursive: true });
            probe = join(path, `.media-reader-doctor-${process.pid}-${crypto.randomUUID()}`);
            const handle = await open(probe, 'wx', 0o600);
            try {
                await handle.writeFile('doctor');
            } finally {
                await handle.close();
            }
            await unlink(probe);
            probe = undefined;
            return result(id, 'pass', `${label} is writable.`);
        } catch {
            if (probe) {
                try { await unlink(probe); } catch {}
            }
            return result(id, 'fail', `${label} is not writable.`);
        }
    };
}

export function createTranscriptApiCheck(env) {
    return async function checkTranscriptApi() {
        if (typeof env.TRANSCRIPT_API_KEY === 'string' && env.TRANSCRIPT_API_KEY.trim()) {
            return result('transcript-api', 'pass', 'Optional TranscriptAPI access is configured.', false);
        }
        return result('transcript-api', 'warn', 'Optional TranscriptAPI access is not configured.', false);
    };
}

export function createCookieCheck(cookieDirectory) {
    return async function checkCookies() {
        try {
            await access(cookieDirectory, constants.R_OK);
            const entries = await readdir(cookieDirectory);
            if (entries.length > 0) {
                return result('cookies', 'pass', 'Optional cookie access is available.', false);
            }
        } catch {}
        return result('cookies', 'warn', 'Optional cookie access is not available.', false);
    };
}
