import { getDb } from '../src/db/index.mjs';
import { ARTICLE_PROMPT_VERSION, estimateTokenCount, transformTranscript } from '../src/llm/index.mjs';

const USAGE = 'Usage: bun scripts/regenerate-articles.mjs [--dry-run | --write] [--force] [--limit N] [--ids ID,ID] [--exclude-channel ID]';

function usageError(message) {
    throw new Error(`${message}\n${USAGE}`);
}

function optionValue(args, index, flag) {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
        usageError(`${flag} requires a value`);
    }
    return value;
}

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        force: false,
        dryRun: true,
        limit: 0,
        ids: [],
        excludedChannelIds: [],
    };
    let writeRequested = false;
    let dryRunRequested = false;

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--force') options.force = true;
        else if (arg === '--write') writeRequested = true;
        else if (arg === '--dry-run') dryRunRequested = true;
        else if (arg === '--limit') {
            const value = optionValue(args, i, arg);
            i += 1;
            if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
                usageError('--limit requires a non-negative integer');
            }
            options.limit = Number(value);
        } else if (arg === '--ids') {
            const value = optionValue(args, i, arg);
            i += 1;
            options.ids = value.split(',').map(item => item.trim()).filter(Boolean);
            if (options.ids.length === 0) usageError('--ids requires at least one nonblank ID');
        } else if (arg === '--exclude-channel') {
            const value = optionValue(args, i, arg).trim();
            i += 1;
            if (!value) usageError('--exclude-channel requires a nonblank ID');
            options.excludedChannelIds.push(value);
        } else {
            usageError(`Unknown argument: ${arg}`);
        }
    }

    options.dryRun = dryRunRequested || !writeRequested;
    options.excludedChannelIds = [...new Set(options.excludedChannelIds.map(value => value?.trim()).filter(Boolean))];
    return options;
}

function combineWhere(options) {
    const where = [
        'videos.transcript IS NOT NULL',
        "length(videos.transcript) > 0",
    ];
    const params = [];

    if (!options.force) {
        where.push('(videos.article_prompt_version IS NULL OR videos.article_prompt_version != ?)');
        params.push(ARTICLE_PROMPT_VERSION);
    }

    if (options.ids.length > 0) {
        where.push(`videos.id IN (${options.ids.map(() => '?').join(',')})`);
        params.push(...options.ids);
    }

    if (options.excludedChannelIds.length > 0) {
        where.push(`videos.channel_id NOT IN (${options.excludedChannelIds.map(() => '?').join(',')})`);
        params.push(...options.excludedChannelIds);
    }

    return { where: where.join(' AND '), params };
}

function selectRows(db, options) {
    const { where, params } = combineWhere(options);
    const limit = options.limit > 0 ? `LIMIT ${Math.floor(options.limit)}` : '';
    return db.prepare(`
        SELECT videos.*, channels.title AS channel_title
        FROM videos
        LEFT JOIN channels ON channels.id = videos.channel_id
        WHERE ${where}
        ORDER BY videos.updated_at DESC, videos.id DESC
        ${limit}
    `).all(...params);
}

function ratio(article, transcript) {
    const a = String(article || '').replace(/\s+/g, ' ').trim().length;
    const t = String(transcript || '').replace(/\s+/g, ' ').trim().length;
    return t ? Number((a * 100 / t).toFixed(1)) : null;
}

function updateVideo(db, video, result) {
    const cost = result.cost || {};
    db.prepare(`
        UPDATE videos SET
            tldr = ?,
            article = ?,
            state = 'done',
            cost_usd = ?,
            llm_model = ?,
            transcript_tokens_est = ?,
            input_tokens_est = ?,
            output_tokens_est = ?,
            total_tokens_est = ?,
            cost_usd_est = ?,
            cost_estimate_method = ?,
            article_prompt_version = ?,
            article_regenerated_at = datetime('now'),
            error = NULL,
            updated_at = datetime('now')
        WHERE id = ?
    `).run(
        result.tldr,
        result.article,
        cost.costUsd || 0,
        cost.model || null,
        estimateTokenCount(video.transcript),
        cost.inputTokens || null,
        cost.outputTokens || null,
        cost.totalTokens || null,
        cost.costUsd || null,
        cost.estimated ? cost.estimateMethod || 'estimated' : 'reported',
        ARTICLE_PROMPT_VERSION,
        video.id,
    );
}

const options = parseArgs();
const db = getDb();
const rows = selectRows(db, options);

console.log(JSON.stringify({
    promptVersion: ARTICLE_PROMPT_VERSION,
    mode: options.dryRun ? 'dry-run' : 'write',
    force: options.force,
    excludedChannelIds: options.excludedChannelIds,
    count: rows.length,
    ids: rows.slice(0, 20).map(row => row.id),
}, null, 2));

if (options.dryRun) process.exit(0);

let completed = 0;
for (const video of rows) {
    const started = Date.now();
    console.log(JSON.stringify({
        event: 'start',
        index: completed + 1,
        total: rows.length,
        id: video.id,
        title: video.title,
        transcriptChars: video.transcript.length,
    }));

    try {
        const result = await transformTranscript({
            title: video.title,
            channel: video.channel_title || video.channel_id,
            transcript: video.transcript,
        });
        updateVideo(db, video, result);
        completed += 1;
        console.log(JSON.stringify({
            event: 'done',
            index: completed,
            total: rows.length,
            id: video.id,
            articleChars: result.article.length,
            articlePct: ratio(result.article, video.transcript),
            costUsd: result.cost?.costUsd || 0,
            model: result.cost?.model || null,
            durationMs: Date.now() - started,
        }));
    } catch (err) {
        db.prepare(`
            UPDATE videos SET
                error = ?,
                updated_at = datetime('now')
            WHERE id = ?
        `).run(`article regeneration failed: ${err.message}`.slice(0, 2000), video.id);
        console.log(JSON.stringify({
            event: 'error',
            id: video.id,
            message: err.message,
            durationMs: Date.now() - started,
        }));
    }
}

console.log(JSON.stringify({
    event: 'complete',
    completed,
    total: rows.length,
    promptVersion: ARTICLE_PROMPT_VERSION,
}, null, 2));
