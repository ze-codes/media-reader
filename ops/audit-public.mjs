import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

export const DEFAULT_MAX_CONTENT_BYTES = 8 * 1024 * 1024;

const SECRET_VARIABLES = [
    'ANTHROPIC_API_KEY',
    'AUTH_TOKEN',
    'AWS_SECRET_ACCESS_KEY',
    'CLIENT_SECRET',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'JWT_SECRET',
    'LINEAR_API_KEY',
    'LLM_API_KEY',
    'MEDIA_READER_AUTH_TOKEN',
    'OAUTH_CLIENT_SECRET',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'SESSION_SECRET',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'SUPABASE_SERVICE_ROLE_KEY',
    'TELEGRAM_BOT_TOKEN',
    'TG_BOT_TOKEN',
    'TRANSCRIPT_API_KEY',
];

const secretVariablePattern = SECRET_VARIABLES.join('|');

function regexes() {
    const keyPrefix = ['s', 'k'].join('') + '-';
    const jwtPrefix = ['e', 'y', 'J'].join('');
    const pemBegin = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');

    return [
        {
            rule: 'openai_or_openrouter_key',
            pattern: new RegExp(`\\b${keyPrefix}(?:(?:or-v1|proj|svcacct)-)?[A-Za-z0-9_-]{20,}\\b`, 'g'),
        },
        {
            rule: 'transcript_api_key',
            pattern: new RegExp(`\\b${['s', 'k', '_'].join('')}[A-Za-z0-9_-]{20,}\\b`, 'g'),
        },
        {
            rule: 'telegram_bot_token',
            pattern: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g,
        },
        {
            rule: 'jwt',
            pattern: new RegExp(`\\b${jwtPrefix}[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{10,}\\b`, 'g'),
        },
        {
            rule: 'pem_private_key',
            pattern: new RegExp(`${pemBegin}|-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )PRIVATE KEY-----`, 'g'),
        },
    ];
}

function stripValueSyntax(rawValue) {
    let value = rawValue.trim().replace(/[,;]\s*$/, '').trim();
    if (
        value.length >= 2
        && ((value.startsWith('"') && value.endsWith('"'))
            || (value.startsWith("'") && value.endsWith("'"))
            || (value.startsWith('`') && value.endsWith('`')))
    ) {
        value = value.slice(1, -1).trim();
    }
    return value;
}

export function isPlaceholderValue(rawValue) {
    const value = stripValueSyntax(rawValue);
    const normalized = value.toLowerCase();

    if (!value) return true;
    if (/^(?:null|undefined|none|false)$/i.test(value)) return true;
    if (/^(?:x+|\*+|\.+)$/.test(value)) return true;
    if (/^(?:\$\w+|\$\{[A-Za-z_]\w*(?::?[-+?=][^}]*)?\}|\{\{[^}]+\}\}|<[^>]+>)$/.test(value)) return true;
    if (/^(?:process|bun|deno)\.env(?:\.|\[)/i.test(value)) return true;
    if (/^(?:env|secrets?)\./i.test(value)) return true;
    return [
        'changeme',
        'dummy',
        'example',
        'fixture',
        'must-not-',
        'neutral-key',
        'never-show-',
        'not-a-real',
        'placeholder',
        'replace-me',
        'replace-with',
        'test-',
        'your-',
        'your_',
    ].some(marker => normalized.includes(marker)) || normalized === 'secret';
}

function contentRuleNames(text) {
    const names = new Set();

    for (const { rule, pattern } of regexes()) {
        for (const match of text.matchAll(pattern)) {
            if (!isPlaceholderValue(match[0])) {
                names.add(rule);
                break;
            }
        }
    }

    const credentialUrlPattern = /https?:\/\/([^\s/:@]+):([^\s/@]+)@[^\s/]+/gi;
    for (const match of text.matchAll(credentialUrlPattern)) {
        if (!isPlaceholderValue(match[1]) && !isPlaceholderValue(match[2])) {
            names.add('credential_url');
            break;
        }
    }

    const assignmentPattern = new RegExp(
        `^\\s*(?:[-]\\s*)?(?:export\\s+)?["']?(${secretVariablePattern})["']?\\s*(?:=|:)\\s*(.*?)\\s*$`,
        'i',
    );
    for (const line of text.split(/\r?\n/)) {
        const match = assignmentPattern.exec(line);
        if (match && !isPlaceholderValue(match[2])) {
            names.add('secret_assignment');
            break;
        }
    }

    return [...names].sort();
}

function isBinary(buffer) {
    return buffer.includes(0);
}

export function scanContent(content, { path = '<memory>', commit } = {}) {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
    if (isBinary(buffer)) return [];

    return contentRuleNames(buffer.toString('utf8')).map(rule => ({
        rule,
        ...(commit ? { commit } : {}),
        path,
    }));
}

function sortFindings(findings) {
    return [...findings].sort((left, right) => (
        left.rule.localeCompare(right.rule)
        || (left.commit || '').localeCompare(right.commit || '')
        || left.path.localeCompare(right.path)
    ));
}

function deduplicateFindings(findings) {
    const unique = new Map();
    for (const finding of findings) {
        const key = `${finding.rule}\0${finding.commit || ''}\0${finding.path}`;
        unique.set(key, finding);
    }
    return sortFindings(unique.values());
}

async function runGit(args, { cwd, maxBuffer = 64 * 1024 * 1024 } = {}) {
    try {
        const { stdout } = await execFileAsync('git', args, {
            cwd,
            encoding: 'buffer',
            maxBuffer,
            windowsHide: true,
        });
        return stdout;
    } catch {
        throw new Error('Git inspection failed');
    }
}

async function readBlob(oid, { cwd, maxContentBytes }) {
    const sizeOutput = await runGit(['cat-file', '-s', oid], { cwd, maxBuffer: 128 * 1024 });
    const size = Number.parseInt(sizeOutput.toString('ascii').trim(), 10);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Git blob size was invalid');
    if (size > maxContentBytes) throw new Error('Tracked content exceeds the audit read limit');
    return runGit(['cat-file', 'blob', oid], { cwd, maxBuffer: maxContentBytes + 1 });
}

async function readTrackedWorktreeFile(root, path, maxContentBytes) {
    const segments = path.split('/');
    if (path.startsWith('/') || segments.includes('..')) throw new Error('Git path was invalid');

    let absolutePath = root;
    let metadata;
    for (const [index, segment] of segments.entries()) {
        absolutePath = join(absolutePath, segment);
        try {
            metadata = await lstat(absolutePath);
        } catch (error) {
            if (error?.code === 'ENOENT') return { kind: 'absent' };
            throw new Error('Tracked worktree content could not be inspected');
        }
        if (index < segments.length - 1 && metadata.isSymbolicLink()) return { kind: 'absent' };
    }

    if (metadata.isSymbolicLink()) {
        const target = Buffer.from(await readlink(absolutePath));
        if (target.length > maxContentBytes) throw new Error('Tracked content exceeds the audit read limit');
        return { kind: 'content', content: target };
    }
    if (!metadata.isFile()) return { kind: 'absent' };
    if (metadata.size > maxContentBytes) throw new Error('Tracked content exceeds the audit read limit');

    const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const openedMetadata = await handle.stat();
        if (!openedMetadata.isFile()) return { kind: 'absent' };
        if (openedMetadata.size > maxContentBytes) throw new Error('Tracked content exceeds the audit read limit');
        const buffer = Buffer.alloc(maxContentBytes + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > maxContentBytes) throw new Error('Tracked content exceeds the audit read limit');
        return { kind: 'content', content: buffer.subarray(0, bytesRead) };
    } finally {
        await handle.close();
    }
}

function parseIndexEntries(output) {
    const entries = [];
    for (const record of output.toString('utf8').split('\0')) {
        if (!record) continue;
        const separator = record.indexOf('\t');
        if (separator < 0) throw new Error('Git index output was invalid');
        const [mode, oid, stage] = record.slice(0, separator).split(' ');
        if (!mode || !oid || !stage) throw new Error('Git index output was invalid');
        entries.push({ mode, oid, path: record.slice(separator + 1) });
    }
    return entries;
}

function parseTreeEntries(output) {
    const entries = [];
    for (const record of output.toString('utf8').split('\0')) {
        if (!record) continue;
        const separator = record.indexOf('\t');
        if (separator < 0) throw new Error('Git tree output was invalid');
        const [mode, type, oid] = record.slice(0, separator).split(' ');
        if (!mode || !type || !oid) throw new Error('Git tree output was invalid');
        entries.push({ mode, type, oid, path: record.slice(separator + 1) });
    }
    return entries;
}

function parseNullSeparatedPaths(output) {
    return output.toString('utf8').split('\0').filter(Boolean);
}

export async function scanCurrentTree({ cwd = process.cwd(), maxContentBytes = DEFAULT_MAX_CONTENT_BYTES } = {}) {
    const root = resolve(cwd);
    const [indexOutput, stagedOutput] = await Promise.all([
        runGit(['ls-files', '--cached', '--stage', '-z'], { cwd: root }),
        runGit([
            'diff',
            '--cached',
            '--name-only',
            '--no-renames',
            '--no-ext-diff',
            '--no-textconv',
            '--diff-filter=ACMRTUXB',
            '-z',
            '--',
        ], { cwd: root }),
    ]);
    const entries = parseIndexEntries(indexOutput);
    const stagedPaths = new Set(parseNullSeparatedPaths(stagedOutput));
    const findings = [];
    const worktreePaths = new Set(entries.filter(entry => entry.mode !== '160000').map(entry => entry.path));
    const blobContents = new Map();

    for (const path of [...worktreePaths].sort()) {
        const result = await readTrackedWorktreeFile(root, path, maxContentBytes);
        if (result.kind !== 'content') continue;
        findings.push(...scanContent(result.content, { path }));
    }

    for (const entry of entries) {
        if (entry.mode === '160000' || !stagedPaths.has(entry.path)) continue;
        if (!blobContents.has(entry.oid)) {
            blobContents.set(entry.oid, await readBlob(entry.oid, { cwd: root, maxContentBytes }));
        }
        findings.push(...scanContent(blobContents.get(entry.oid), { path: entry.path }));
    }

    return deduplicateFindings(findings);
}

export async function scanHistory({ cwd = process.cwd(), maxContentBytes = DEFAULT_MAX_CONTENT_BYTES } = {}) {
    const root = resolve(cwd);
    const revisionOutput = await runGit(['rev-list', '--all'], { cwd: root });
    const commits = revisionOutput.toString('ascii').split(/\r?\n/).filter(Boolean).sort();
    const blobContents = new Map();
    const findings = [];

    for (const commit of commits) {
        const treeOutput = await runGit(['ls-tree', '-r', '-z', '--full-tree', commit], { cwd: root });
        for (const entry of parseTreeEntries(treeOutput)) {
            if (entry.type !== 'blob') continue;
            if (!blobContents.has(entry.oid)) {
                const content = await readBlob(entry.oid, { cwd: root, maxContentBytes });
                blobContents.set(entry.oid, isBinary(content) ? null : content.toString('utf8'));
            }
            const text = blobContents.get(entry.oid);
            if (text === null) continue;
            for (const rule of contentRuleNames(text)) {
                findings.push({ rule, commit, path: entry.path });
            }
        }
    }

    return deduplicateFindings(findings);
}

export function formatFindings(findings) {
    return `${JSON.stringify(sortFindings(findings), null, 2)}\n`;
}

const HELP_TEXT = [
    'Usage: bun ops/audit-public.mjs [--history]',
    '',
    'Without --history, scans current worktree content for Git-tracked paths.',
    'New files become part of the current-tree audit after they are staged with git add.',
    'With --history, scans every blob path in every reachable commit.',
    '',
].join('\n');

export async function main({
    args = process.argv.slice(2),
    cwd = process.cwd(),
    maxContentBytes = DEFAULT_MAX_CONTENT_BYTES,
    stdout = process.stdout,
    stderr = process.stderr,
} = {}) {
    if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
        stdout.write(HELP_TEXT);
        return 0;
    }
    if (args.some(argument => argument !== '--history')) {
        stderr.write(HELP_TEXT);
        return 2;
    }

    try {
        const findings = args.includes('--history')
            ? await scanHistory({ cwd, maxContentBytes })
            : await scanCurrentTree({ cwd, maxContentBytes });
        stdout.write(formatFindings(findings));
        return findings.length === 0 ? 0 : 1;
    } catch {
        stderr.write('Public audit could not complete.\n');
        return 2;
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = await main();
}
