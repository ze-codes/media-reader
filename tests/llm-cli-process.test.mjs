import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    minimalCliEnvironment,
    runCliProcess,
} from '../src/llm/providers/cli-process.mjs';

const temporaryDirectories = [];

async function fakeExecutable(source) {
    const directory = await mkdtemp(join(tmpdir(), 'media-reader-cli-'));
    temporaryDirectories.push(directory);
    const executable = join(directory, 'fake-cli');
    await writeFile(executable, `#!/usr/bin/env bun\n${source}`);
    await chmod(executable, 0o755);
    return executable;
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('CLI process runner', () => {
    test('inherits only runtime and official CLI location settings', () => {
        expect(minimalCliEnvironment({
            PATH: '/usr/bin',
            HOME: '/home/reader',
            CODEX_HOME: '/home/reader/.codex-custom',
            CLAUDE_CONFIG_DIR: '/home/reader/.claude-custom',
            LLM_API_KEY: 'must-not-cross-process-boundary',
        })).toEqual({
            PATH: '/usr/bin',
            HOME: '/home/reader',
            CODEX_HOME: '/home/reader/.codex-custom',
            CLAUDE_CONFIG_DIR: '/home/reader/.claude-custom',
        });
    });

    test('passes exact argv separately and sends the prompt only through stdin', async () => {
        const executable = await fakeExecutable(`
            const input = await Bun.stdin.text();
            process.stderr.write('diagnostic');
            process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), input }));
        `);

        const result = await runCliProcess({
            command: executable,
            args: ['exec', '--model', 'vendor/model'],
            input: 'prompt that must not be argv',
        });

        expect(JSON.parse(result.stdout)).toEqual({
            argv: ['exec', '--model', 'vendor/model'],
            input: 'prompt that must not be argv',
        });
        expect(result.stderr).toBe('diagnostic');
        expect(result.exitCode).toBe(0);
    });

    test('maps missing executables and sanitized process failures to stable errors', async () => {
        await expect(runCliProcess({
            command: '/definitely/missing/media-reader-cli',
            input: 'do not echo this prompt',
        })).rejects.toMatchObject({ code: 'config', message: 'CLI executable was not found' });

        const executable = await fakeExecutable(`
            await Bun.stdin.text();
            process.stderr.write('Bearer sk-secret-value internal provider exploded');
            process.exit(2);
        `);
        try {
            await runCliProcess({ command: executable, input: 'full private prompt' });
            throw new Error('expected provider failure');
        } catch (error) {
            expect(error).toMatchObject({ code: 'provider', message: 'CLI provider process failed' });
            expect(JSON.stringify(error)).not.toContain('sk-secret-value');
            expect(JSON.stringify(error)).not.toContain('full private prompt');
        }
    });

    test.each([
        ['authentication required; run login', 'auth', 'CLI provider authentication failed'],
        ['429 too many requests rate limit reached', 'rate_limit', 'CLI provider rate limit reached'],
    ])('classifies stderr without exposing it: %s', async (stderr, code, message) => {
        const executable = await fakeExecutable(`
            await Bun.stdin.text();
            process.stderr.write(${JSON.stringify(stderr)});
            process.exit(1);
        `);

        await expect(runCliProcess({ command: executable, input: 'secret prompt' }))
            .rejects.toMatchObject({ code, message });
    });

    test('times out, honours external cancellation, and terminates the child', async () => {
        const executable = await fakeExecutable(`
            await Bun.stdin.text();
            await new Promise(resolve => setTimeout(resolve, 10_000));
        `);

        await expect(runCliProcess({ command: executable, input: 'x', timeoutMs: 20 }))
            .rejects.toMatchObject({ code: 'timeout', message: 'CLI provider process timed out' });

        const controller = new AbortController();
        setTimeout(() => controller.abort(), 20);
        await expect(runCliProcess({ command: executable, input: 'x', signal: controller.signal }))
            .rejects.toMatchObject({ code: 'cancelled', message: 'CLI provider process cancelled' });
    });

    test('rejects oversized stdout without including captured output', async () => {
        const executable = await fakeExecutable(`
            await Bun.stdin.text();
            process.stdout.write('sensitive-output-'.repeat(32));
        `);

        await expect(runCliProcess({
            command: executable,
            input: 'x',
            maxStdoutBytes: 32,
        })).rejects.toMatchObject({
            code: 'invalid_response',
            message: 'CLI provider output exceeded the allowed size',
        });
    });
});
