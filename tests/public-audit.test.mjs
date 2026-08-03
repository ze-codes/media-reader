import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
    formatFindings,
    main,
    scanContent,
    scanCurrentTree,
    scanHistory,
} from '../ops/audit-public.mjs';

const execFileAsync = promisify(execFile);
const temporaryDirectories = [];

function assignment(nameParts, value) {
    return `${nameParts.join('')}=${value}`;
}

function syntheticSecrets() {
    return {
        apiKey: ['s', 'k', '-', 'A'.repeat(32)].join(''),
        openRouterKey: ['s', 'k', '-or-v1-', 'b'.repeat(32)].join(''),
        transcriptApiKey: ['s', 'k', '_', 'T'.repeat(32)].join(''),
        telegram: ['123456789', ':', 'C'.repeat(35)].join(''),
        jwt: [['e', 'y', 'J'].join('') + 'hZWFkZXI', 'cGF5bG9hZA', 'D'.repeat(20)].join('.'),
        pem: [
            ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
            'payload',
            ['-----END', 'PRIVATE KEY-----'].join(' '),
        ].join('\n'),
        password: 'actual-password-value',
    };
}

async function git(cwd, ...args) {
    const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
    return stdout.trim();
}

async function createRepository() {
    const cwd = await mkdtemp(join(tmpdir(), 'media-reader-public-audit-'));
    temporaryDirectories.push(cwd);
    await git(cwd, 'init', '-q');
    await git(cwd, 'config', 'user.name', 'Audit Test');
    await git(cwd, 'config', 'user.email', 'audit@example.test');
    return cwd;
}

async function commitAll(cwd, message) {
    await git(cwd, 'add', '.');
    await git(cwd, 'commit', '-qm', message);
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('public secret audit rules', () => {
    test('detects each high-confidence secret class', () => {
        const secret = syntheticSecrets();
        const content = [
            secret.apiKey,
            secret.openRouterKey,
            secret.telegram,
            secret.transcriptApiKey,
            secret.jwt,
            secret.pem,
            [['https', '://'].join(''), 'real-user', ':', secret.password, '@database.example.test/app'].join(''),
            assignment(['OPEN', 'AI', '_API', '_KEY'], secret.password),
        ].join('\n');

        expect(scanContent(content, { path: 'fixture.txt' }).map(finding => finding.rule)).toEqual([
            'credential_url',
            'jwt',
            'openai_or_openrouter_key',
            'pem_private_key',
            'secret_assignment',
            'telegram_bot_token',
            'transcript_api_key',
        ]);
    });

    test('tolerates explicit placeholders without ignoring populated assignments', () => {
        const placeholders = [
            assignment(['OPEN', 'AI', '_API', '_KEY'], ''),
            assignment(['OPEN', 'ROUTER', '_API', '_KEY'], 'your-key-here'),
            assignment(['AUTH', '_TOKEN'], '${AUTH_TOKEN}'),
            assignment(['TRANSCRIPT', '_API', '_KEY'], '${TRANSCRIPT_API_KEY:-}'),
            assignment(['TG', '_BOT', '_TOKEN'], 'replace-with-token'),
            assignment(['LLM', '_API', '_KEY'], 'smoke-placeholder-not-a-real-key'),
            assignment(['OPEN', 'AI', '_API', '_KEY'], ['s', 'k', '-your-placeholder-key-value'].join('')),
            'https://example:placeholder@database.example.test/app',
        ].join('\n');
        expect(scanContent(placeholders, { path: '.env.example' })).toEqual([]);

        const populated = assignment(['TG', '_BOT', '_TOKEN'], syntheticSecrets().password);
        expect(scanContent(populated, { path: 'config.txt' })).toEqual([
            { rule: 'secret_assignment', path: 'config.txt' },
        ]);
    });

    test('detects populated assignments in test paths while tolerating explicit fixture values', () => {
        const fixture = assignment(['LLM', '_API', '_KEY'], 'fixture-value');
        expect(scanContent(fixture, { path: 'tests/provider.test.mjs' })).toEqual([]);

        const populated = assignment(['LLM', '_API', '_KEY'], syntheticSecrets().password);
        expect(scanContent(populated, { path: 'tests/provider.test.mjs' })).toEqual([
            { rule: 'secret_assignment', path: 'tests/provider.test.mjs' },
        ]);
        expect(scanContent(syntheticSecrets().transcriptApiKey, { path: 'tests/provider.test.mjs' })).toEqual([
            { rule: 'transcript_api_key', path: 'tests/provider.test.mjs' },
        ]);
    });

    test('skips binary content', () => {
        const content = Buffer.concat([
            Buffer.from([0, 1, 2, 3]),
            Buffer.from(syntheticSecrets().apiKey),
        ]);
        expect(scanContent(content, { path: 'asset.bin' })).toEqual([]);
    });

    test('formats deterministic findings without matched values', () => {
        const secret = syntheticSecrets().apiKey;
        const findings = scanContent(secret, { path: 'z.txt', commit: 'abc123' });
        const output = formatFindings(findings);

        expect(output).toContain('openai_or_openrouter_key');
        expect(output).toContain('abc123');
        expect(output).toContain('z.txt');
        expect(output).not.toContain(secret);
    });

    test('documents that new files require staging before tree audit', async () => {
        let stdout = '';
        const exitCode = await main({
            args: ['--help'],
            stdout: { write: chunk => { stdout += chunk; } },
            stderr: { write: () => {} },
        });

        expect(exitCode).toBe(0);
        expect(stdout).toContain('staged with git add');
    });
});

describe('public Git audit', () => {
    test('scans current tracked content and newly staged files but not untracked files', async () => {
        const cwd = await createRepository();
        const secret = syntheticSecrets().apiKey;
        await writeFile(join(cwd, 'worktree.txt'), 'safe\n');
        await commitAll(cwd, 'initial');

        await writeFile(join(cwd, 'worktree.txt'), `${secret}\n`);
        await writeFile(join(cwd, 'newly-staged.txt'), `${secret}\n`);
        await git(cwd, 'add', 'newly-staged.txt');
        await writeFile(join(cwd, 'untracked.txt'), `${secret}\n`);

        const findings = await scanCurrentTree({ cwd });
        expect(findings).toEqual([
            { rule: 'openai_or_openrouter_key', path: 'newly-staged.txt' },
            { rule: 'openai_or_openrouter_key', path: 'worktree.txt' },
        ]);

        let stdout = '';
        let stderr = '';
        const exitCode = await main({
            args: [],
            cwd,
            stdout: { write: chunk => { stdout += chunk; } },
            stderr: { write: chunk => { stderr += chunk; } },
        });
        expect(exitCode).toBe(1);
        expect(stderr).toBe('');
        expect(stdout).not.toContain(secret);
        expect(JSON.parse(stdout)).toEqual(findings);
    });

    test('does not scan obsolete index content after a tracked secret is removed', async () => {
        const cwd = await createRepository();
        await writeFile(join(cwd, 'config.txt'), `${syntheticSecrets().apiKey}\n`);
        await commitAll(cwd, 'secret fixture');

        await writeFile(join(cwd, 'config.txt'), 'safe replacement\n');
        expect(await scanCurrentTree({ cwd })).toEqual([]);
    });

    test('scans a staged secret even after safe unstaged worktree replacement', async () => {
        const cwd = await createRepository();
        const path = join(cwd, 'config.txt');
        await writeFile(path, 'safe initial content\n');
        await commitAll(cwd, 'initial');

        await writeFile(path, `${syntheticSecrets().apiKey}\n`);
        await git(cwd, 'add', 'config.txt');
        await writeFile(path, 'safe unstaged replacement\n');

        expect(await scanCurrentTree({ cwd })).toEqual([
            { rule: 'openai_or_openrouter_key', path: 'config.txt' },
        ]);
    });

    test('treats a deleted tracked file as absent from the current tree', async () => {
        const cwd = await createRepository();
        const path = join(cwd, 'deleted.txt');
        await writeFile(path, `${syntheticSecrets().apiKey}\n`);
        await commitAll(cwd, 'secret fixture');

        await rm(path);
        expect(await scanCurrentTree({ cwd })).toEqual([]);
    });

    test('handles staged deletion without scanning the deleted index path', async () => {
        const cwd = await createRepository();
        const path = join(cwd, 'deleted.txt');
        await writeFile(path, `${syntheticSecrets().apiKey}\n`);
        await commitAll(cwd, 'secret fixture');

        await git(cwd, 'rm', 'deleted.txt');
        expect(await scanCurrentTree({ cwd })).toEqual([]);
    });

    test('fails closed when tracked content exceeds the bounded read limit', async () => {
        const cwd = await createRepository();
        await writeFile(join(cwd, 'large.txt'), 'bounded content\n');
        await commitAll(cwd, 'large fixture');

        let stdout = '';
        let stderr = '';
        const exitCode = await main({
            args: [],
            cwd,
            maxContentBytes: 4,
            stdout: { write: chunk => { stdout += chunk; } },
            stderr: { write: chunk => { stderr += chunk; } },
        });
        expect(exitCode).toBe(2);
        expect(stdout).toBe('');
        expect(stderr).toBe('Public audit could not complete.\n');
        expect(stderr).not.toContain('bounded content');
    });

    test('finds secrets in every reachable history snapshot without changing checkout state', async () => {
        const cwd = await createRepository();
        const secret = syntheticSecrets().telegram;
        await writeFile(join(cwd, 'config.txt'), `${secret}\n`);
        await commitAll(cwd, 'contains fixture');
        const secretCommit = await git(cwd, 'rev-parse', 'HEAD');

        await writeFile(join(cwd, 'config.txt'), 'safe\n');
        await commitAll(cwd, 'remove fixture');
        const headBefore = await git(cwd, 'rev-parse', 'HEAD');

        expect(await scanCurrentTree({ cwd })).toEqual([]);
        expect(await scanHistory({ cwd })).toEqual([
            { rule: 'telegram_bot_token', commit: secretCommit, path: 'config.txt' },
        ]);
        expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(headBefore);
        expect(await git(cwd, 'status', '--short')).toBe('');
    });
});
