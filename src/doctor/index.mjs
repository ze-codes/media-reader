import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { APP_ROOT } from '../shared/paths.mjs';
import { resolveGenerationConfig } from '../llm/providers/config.mjs';
import {
    createCommandCheck,
    createCookieCheck,
    createProviderChecks,
    createTranscriptApiCheck,
    createWhisperCheck,
    createWritablePathCheck,
} from './checks.mjs';

const COMMAND_TIMEOUT_MS = 10_000;
const MAX_STATUS_OUTPUT_BYTES = 32 * 1024;

export function executeCommand(command, args, options = {}) {
    return new Promise(resolve => {
        const captureClaudeStatus = options.output === 'claude-auth-json';
        const child = spawn(command, args, {
            shell: false,
            stdio: ['ignore', captureClaudeStatus ? 'pipe' : 'ignore', 'ignore'],
        });
        let settled = false;
        let stdout = '';
        let oversized = false;

        if (captureClaudeStatus) {
            child.stdout.on('data', chunk => {
                if (oversized) return;
                if (Buffer.byteLength(stdout) + chunk.length > MAX_STATUS_OUTPUT_BYTES) {
                    stdout = '';
                    oversized = true;
                    return;
                }
                stdout += chunk;
            });
        }

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill('SIGTERM');
            const forceKill = setTimeout(() => child.kill('SIGKILL'), 1_000);
            forceKill.unref();
            resolve({ exitCode: null, loggedIn: false });
        }, COMMAND_TIMEOUT_MS);

        child.on('error', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ exitCode: null, loggedIn: false });
        });

        child.on('close', exitCode => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (!captureClaudeStatus) {
                resolve({ exitCode });
                return;
            }

            let loggedIn = false;
            if (!oversized) {
                try {
                    const parsed = JSON.parse(stdout, (key, value) => (
                        key === '' || key === 'loggedIn' ? value : undefined
                    ));
                    loggedIn = parsed?.loggedIn === true;
                } catch {}
            }
            stdout = '';
            resolve({ exitCode, loggedIn });
        });
    });
}

export function resolveDoctorPaths(env = process.env) {
    const data = env.MEDIA_READER_DATA_DIR || join(APP_ROOT, 'data');
    const database = env.MEDIA_READER_DB_PATH || join(data, 'media-reader.db');
    const backend = env.YT_TRANSCRIBE_BACKEND || 'faster-whisper';
    const modelData = backend === 'faster-whisper'
        ? (env.YT_FAST_WHISPER_MODEL_DIR || join(data, 'faster-whisper'))
        : join(data, 'models');
    return {
        data,
        databaseParent: dirname(database),
        cache: join(data, 'cache'),
        upload: join(data, 'uploads'),
        modelData,
    };
}

export function resolveDoctorCookieDirectory(env = process.env) {
    return env.MEDIA_READER_COOKIE_DIR || '/cookies';
}

export function createDoctorChecks({
    env = process.env,
    executeCommand: commandExecutor = executeCommand,
    resolveProviderConfig = resolveGenerationConfig,
    paths = resolveDoctorPaths(env),
    cookieDirectory = resolveDoctorCookieDirectory(env),
} = {}) {
    const provider = createProviderChecks({
        resolveProvider: () => resolveProviderConfig(env),
    });
    return [
        createCommandCheck({ id: 'bun', label: 'Bun', command: 'bun', args: ['--version'], executeCommand: commandExecutor }),
        createCommandCheck({ id: 'yt-dlp', label: 'yt-dlp', command: 'yt-dlp', args: ['--version'], executeCommand: commandExecutor }),
        createCommandCheck({ id: 'ffmpeg', label: 'ffmpeg', command: 'ffmpeg', args: ['-version'], executeCommand: commandExecutor }),
        createWhisperCheck({ env, executeCommand: commandExecutor }),
        provider.configuration,
        () => provider.binary({ executeCommand: commandExecutor }),
        () => provider.login({ executeCommand: commandExecutor }),
        createWritablePathCheck({ id: 'database-path', label: 'Database parent path', path: paths.databaseParent }),
        createWritablePathCheck({ id: 'cache-path', label: 'Cache path', path: paths.cache }),
        createWritablePathCheck({ id: 'upload-path', label: 'Upload path', path: paths.upload }),
        createWritablePathCheck({ id: 'model-data-path', label: 'Model data path', path: paths.modelData }),
        createTranscriptApiCheck(env),
        createCookieCheck(cookieDirectory),
    ];
}

export function hasRequiredFailures(results) {
    return results.some(item => item.status === 'fail' && item.details?.required === true);
}

export async function runDoctor(options = {}) {
    const results = [];
    for (const check of createDoctorChecks(options)) results.push(await check());
    const summary = { total: results.length, pass: 0, warn: 0, fail: 0 };
    for (const item of results) summary[item.status] += 1;
    return { results, summary, ok: !hasRequiredFailures(results) };
}

export function renderDoctorHuman(report) {
    const lines = ['Media Reader doctor'];
    for (const item of report.results) {
        lines.push(`[${item.status.toUpperCase()}] ${item.message}`);
    }
    lines.push(`Summary: ${report.summary.pass} passed, ${report.summary.warn} warnings, ${report.summary.fail} failed.`);
    return lines.join('\n');
}
