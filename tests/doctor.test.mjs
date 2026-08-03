import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
    createDoctorChecks,
    hasRequiredFailures,
    renderDoctorHuman,
    resolveDoctorCookieDirectory,
    runDoctor,
} from '../src/doctor/index.mjs';

const temporaryDirectories = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function runtimePaths() {
    const root = mkdtempSync(join(tmpdir(), 'media-reader-doctor-'));
    temporaryDirectories.push(root);
    return {
        data: join(root, 'data'),
        databaseParent: join(root, 'database'),
        cache: join(root, 'cache'),
        upload: join(root, 'uploads'),
        modelData: join(root, 'models'),
    };
}

function successfulCommand() {
    return Promise.resolve({ exitCode: 0, stdout: 'version output', stderr: '' });
}

function dependencies(overrides = {}) {
    return {
        executeCommand: successfulCommand,
        resolveProviderConfig: () => ({
            provider: 'openrouter',
            model: 'private/model-name',
            apiKey: 'never-print-this-key',
        }),
        paths: runtimePaths(),
        cookieDirectory: join(tmpdir(), `missing-cookie-directory-${crypto.randomUUID()}`),
        ...overrides,
    };
}

describe('native doctor checks', () => {
    test('checks the configured cookie directory and preserves the container fallback', async () => {
        const cookieDirectory = mkdtempSync(join(tmpdir(), 'media-reader-doctor-cookies-'));
        temporaryDirectories.push(cookieDirectory);
        writeFileSync(join(cookieDirectory, 'youtube-test.json'), '[]');

        expect(resolveDoctorCookieDirectory({ MEDIA_READER_COOKIE_DIR: cookieDirectory })).toBe(cookieDirectory);
        expect(resolveDoctorCookieDirectory({})).toBe('/cookies');

        const checks = createDoctorChecks({
            env: {
                MEDIA_READER_COOKIE_DIR: cookieDirectory,
                YT_TRANSCRIBE_BACKEND: 'faster-whisper',
            },
            ...dependencies({ cookieDirectory: undefined }),
        });
        const results = await Promise.all(checks.map(check => check()));
        expect(results.find(result => result.id === 'cookies')).toMatchObject({
            status: 'pass',
            details: { required: false },
        });
    });

    test('runs composable required and optional checks with pass/warn/fail results', async () => {
        const checks = createDoctorChecks({
            env: {
                YT_TRANSCRIBE_BACKEND: 'faster-whisper',
                TRANSCRIPT_API_KEY: '',
            },
            ...dependencies(),
        });

        const results = await Promise.all(checks.map(check => check()));
        expect(results.every(result => (
            typeof result.id === 'string' &&
            ['pass', 'warn', 'fail'].includes(result.status) &&
            typeof result.message === 'string' &&
            result.details && typeof result.details.required === 'boolean'
        ))).toBe(true);
        expect(results.find(result => result.id === 'transcript-api')).toMatchObject({
            status: 'warn',
            details: { required: false },
        });
        expect(results.find(result => result.id === 'cookies')).toMatchObject({
            status: 'warn',
            details: { required: false },
        });
        expect(results.filter(result => result.details.required).every(result => result.status === 'pass')).toBe(true);
    });

    test('uses exact dependency and faster-whisper commands through the injected executor', async () => {
        const calls = [];
        const executeCommand = async (command, args) => {
            calls.push([command, args]);
            return { exitCode: 0, stdout: 'sensitive version text', stderr: '' };
        };

        await runDoctor({
            env: { YT_TRANSCRIBE_BACKEND: 'faster-whisper', YT_FAST_WHISPER_PYTHON: '/opt/python' },
            ...dependencies({ executeCommand }),
        });

        expect(calls).toContainEqual(['bun', ['--version']]);
        expect(calls).toContainEqual(['yt-dlp', ['--version']]);
        expect(calls).toContainEqual(['ffmpeg', ['-version']]);
        expect(calls).toContainEqual(['/opt/python', ['-c', 'import faster_whisper']]);
    });

    test('checks whisper.cpp with its selected binary instead of Python', async () => {
        const calls = [];
        await runDoctor({
            env: { YT_TRANSCRIBE_BACKEND: 'whisper.cpp' },
            ...dependencies({
                executeCommand: async (command, args) => {
                    calls.push([command, args]);
                    return { exitCode: 0, stdout: '', stderr: '' };
                },
            }),
        });

        expect(calls).toContainEqual(['whisper-cli', ['--help']]);
        expect(calls.some(([command]) => command === 'python3')).toBe(false);
    });

    test('uses only official Codex login status and returns no command output', async () => {
        const calls = [];
        const secretOutput = 'Logged in as identity@example.test token=super-secret';
        const report = await runDoctor({
            env: { YT_TRANSCRIBE_BACKEND: 'faster-whisper' },
            ...dependencies({
                resolveProviderConfig: () => ({
                    provider: 'codex-cli',
                    model: 'gpt-private',
                    binaryPath: '/opt/codex',
                }),
                executeCommand: async (command, args) => {
                    calls.push([command, args]);
                    if (command === '/opt/codex' && args[0] === 'login') {
                        return { exitCode: 0, stdout: secretOutput, stderr: 'private diagnostic' };
                    }
                    return { exitCode: 0, stdout: 'version', stderr: '' };
                },
            }),
        });

        expect(calls).toContainEqual(['/opt/codex', ['--version']]);
        expect(calls).toContainEqual(['/opt/codex', ['login', 'status']]);
        expect(JSON.stringify(report)).not.toContain(secretOutput);
        expect(JSON.stringify(report)).not.toContain('private diagnostic');
        expect(report.results.find(result => result.id === 'provider-login')).toMatchObject({
            status: 'pass',
            message: 'Selected provider CLI is authenticated.',
        });
    });

    test('extracts only loggedIn from Claude auth JSON and discards identity fields', async () => {
        const identityPayload = JSON.stringify({
            loggedIn: true,
            email: 'person@example.test',
            organizationId: 'org-private-123',
            subscriptionType: 'private-plan',
        });
        const report = await runDoctor({
            env: { YT_TRANSCRIBE_BACKEND: 'faster-whisper' },
            ...dependencies({
                resolveProviderConfig: () => ({
                    provider: 'claude-cli',
                    model: 'claude-private',
                    binaryPath: '/opt/claude',
                }),
                executeCommand: async (command, args) => {
                    if (command === '/opt/claude' && args[0] === 'auth') {
                        expect(args).toEqual(['auth', 'status']);
                        return { exitCode: 0, stdout: identityPayload, stderr: 'identity-bearing stderr' };
                    }
                    return { exitCode: 0, stdout: 'version', stderr: '' };
                },
            }),
        });

        const serialized = JSON.stringify(report);
        expect(serialized).not.toContain('person@example.test');
        expect(serialized).not.toContain('org-private-123');
        expect(serialized).not.toContain('private-plan');
        expect(serialized).not.toContain('identity-bearing stderr');
        expect(report.results.find(result => result.id === 'provider-login')).toEqual({
            id: 'provider-login',
            status: 'pass',
            message: 'Selected provider CLI is authenticated.',
            details: { required: true },
        });
    });

    test('fails Claude authentication when loggedIn is false despite a zero exit code', async () => {
        const report = await runDoctor({
            env: { YT_TRANSCRIBE_BACKEND: 'faster-whisper' },
            ...dependencies({
                resolveProviderConfig: () => ({ provider: 'claude-cli', model: 'model', binaryPath: 'claude' }),
                executeCommand: async (command, args) => {
                    if (command === 'claude' && args[0] === 'auth') {
                        return { exitCode: 0, stdout: JSON.stringify({ loggedIn: false, email: 'hidden@example.test' }), stderr: '' };
                    }
                    return { exitCode: 0, stdout: '', stderr: '' };
                },
            }),
        });

        expect(report.results.find(result => result.id === 'provider-login')).toMatchObject({
            status: 'fail',
            message: 'Selected provider CLI is not authenticated.',
        });
        expect(hasRequiredFailures(report.results)).toBe(true);
        expect(JSON.stringify(report)).not.toContain('hidden@example.test');
    });

    test('redacts provider configuration and command failures', async () => {
        const configSecret = 'configuration-secret-value';
        const commandSecret = 'command-secret-value';
        const report = await runDoctor({
            env: { YT_TRANSCRIBE_BACKEND: 'faster-whisper' },
            ...dependencies({
                resolveProviderConfig: () => {
                    throw new Error(`bad key ${configSecret}`);
                },
                executeCommand: async command => {
                    if (command === 'yt-dlp') throw new Error(`spawn failed ${commandSecret}`);
                    return { exitCode: 0, stdout: '', stderr: '' };
                },
            }),
        });

        const human = renderDoctorHuman(report);
        const serialized = JSON.stringify(report);
        for (const secret of [configSecret, commandSecret]) {
            expect(human).not.toContain(secret);
            expect(serialized).not.toContain(secret);
        }
        expect(report.results.find(result => result.id === 'provider-config').status).toBe('fail');
        expect(report.results.find(result => result.id === 'yt-dlp')).toMatchObject({
            status: 'fail',
            message: 'yt-dlp could not be executed.',
        });
    });

    test('writes no environment values or command output to human or JSON reports', async () => {
        const sensitiveValues = [
            'private/model-value',
            'https://private-provider.example.test/v1',
            'secret-api-key',
            '/private/provider/binary',
            'raw command output',
        ];
        const report = await runDoctor({
            env: { YT_TRANSCRIBE_BACKEND: 'faster-whisper' },
            ...dependencies({
                resolveProviderConfig: () => ({
                    provider: 'openai-compatible',
                    model: sensitiveValues[0],
                    baseUrl: sensitiveValues[1],
                    apiKey: sensitiveValues[2],
                    binaryPath: sensitiveValues[3],
                }),
                executeCommand: async () => ({ exitCode: 0, stdout: sensitiveValues[4], stderr: sensitiveValues[4] }),
            }),
        });
        const outputs = [renderDoctorHuman(report), JSON.stringify(report)];
        for (const output of outputs) {
            for (const value of sensitiveValues) expect(output).not.toContain(value);
        }
    });

    test('optional warnings do not cause failure, but required failures do', async () => {
        const warningOnly = await runDoctor({
            env: { YT_TRANSCRIBE_BACKEND: 'faster-whisper' },
            ...dependencies(),
        });
        expect(warningOnly.summary.warn).toBeGreaterThan(0);
        expect(hasRequiredFailures(warningOnly.results)).toBe(false);

        const requiredFailure = await runDoctor({
            env: { YT_TRANSCRIBE_BACKEND: 'faster-whisper' },
            ...dependencies({
                executeCommand: async command => ({
                    exitCode: command === 'ffmpeg' ? 127 : 0,
                    stdout: '',
                    stderr: 'sensitive shell error',
                }),
            }),
        });
        expect(hasRequiredFailures(requiredFailure.results)).toBe(true);
        expect(requiredFailure.summary.fail).toBeGreaterThan(0);
        expect(JSON.stringify(requiredFailure)).not.toContain('sensitive shell error');
    });

    test('reports an unwritable runtime location without exposing its path', async () => {
        const paths = runtimePaths();
        paths.cache = import.meta.path;
        const report = await runDoctor({
            env: { YT_TRANSCRIBE_BACKEND: 'faster-whisper' },
            ...dependencies({ paths }),
        });

        expect(report.results.find(result => result.id === 'cache-path')).toEqual({
            id: 'cache-path',
            status: 'fail',
            message: 'Cache path is not writable.',
            details: { required: true },
        });
        expect(renderDoctorHuman(report)).not.toContain(import.meta.path);
        expect(JSON.stringify(report)).not.toContain(import.meta.path);
    });
});
