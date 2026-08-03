import { transcriptSourceLabel } from './status-messages.mjs';

export const STATE_ORDER = ['writing', 'transcribing', 'fetching', 'queued', 'done', 'error'];
export const STATE_LABEL = {
    queued: 'Queued',
    fetching: 'Fetching',
    transcribing: 'Transcribing',
    writing: 'Writing',
    done: 'Done',
    error: 'Error',
};

const UPLOAD_PROCESS_STEPS = {
    queued: { percent: 8, label: 'Waiting to transcribe' },
    fetching: { percent: 22, label: 'Preparing uploaded file' },
    transcribing: { percent: 62, label: 'Transcribing with Whisper' },
    writing: { percent: 88, label: 'Generating article' },
};

export function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

export function renderMarkdown(md) {
    try {
        const html = window.marked.parse(md || '');
        return window.DOMPurify.sanitize(html, {
            USE_PROFILES: { html: true },
            FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed'],
            FORBID_ATTR: ['style'],
        });
    } catch {
        return escapeHtml(md || '');
    }
}

export function formatInt(n) {
    const value = Number(n);
    return Number.isFinite(value) && value > 0 ? value.toLocaleString() : '';
}

export function formatPublishedDate(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw);
    if (!Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
    }).format(date);
}

export function formatCost(n) {
    const value = Number(n);
    return Number.isFinite(value) && value > 0 ? `$${value.toFixed(value < 0.01 ? 4 : 3)}` : '';
}

export function renderGenerationMeta(v) {
    const rows = [
        ['Model', v.llm_model],
        ['Transcript tokens', formatInt(v.transcript_tokens_est)],
        ['Input tokens', formatInt(v.input_tokens_est)],
        ['Output tokens', formatInt(v.output_tokens_est)],
        ['Total tokens', formatInt(v.total_tokens_est)],
        ['Estimated cost', formatCost(v.cost_usd_est || v.cost_usd)],
    ].filter(([, value]) => value);
    if (rows.length === 0) return '';
    return `<div class="generation-meta">
      ${rows.map(([label, value]) => `<div><span>${label}</span><strong>${escapeHtml(String(value))}</strong></div>`).join('')}
      ${v.cost_estimate_method ? `<p>${escapeHtml(v.cost_estimate_method)}</p>` : ''}
    </div>`;
}

export function renderOriginalMediaLink(v) {
    if (v.source_type === 'upload') {
        const name = v.original_filename || v.title || 'local media';
        const size = formatBytes(v.file_size_bytes);
        return `<div style="margin-top:14px;color:var(--text-mute);font-size:11px">Uploaded file: ${escapeHtml(name)}${size ? ` · ${size}` : ''}</div>`;
    }
    return `<div style="margin-top:14px"><a href="${v.url}" target="_blank" style="color:var(--text-mute);font-size:11px">Open original on ${escapeHtml(sourceNameFromUrl(v.url))} ↗</a></div>`;
}

export function renderUploadProcessingProgress(v) {
    if (v.source_type !== 'upload') return '';
    const step = UPLOAD_PROCESS_STEPS[v.state];
    if (!step) return '';

    const percent = Math.max(0, Math.min(100, step.percent));
    return `<div class="video-process ${escapeHtml(v.state)}">
      <div class="video-process-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-label="${escapeHtml(step.label)}">
        <div class="video-process-bar" style="width:${percent}%"></div>
      </div>
      <div class="video-process-text">
        <span>${escapeHtml(step.label)}</span>
        <span>${percent}%</span>
      </div>
    </div>`;
}

export function renderWorkerPauseBanner(workerStatus) {
    if (!workerStatus?.youtube_paused) return '';
    const queued = Number(workerStatus.queued_youtube) || 0;
    const count = queued > 0 ? `${queued} queued YouTube ${queued === 1 ? 'video is' : 'videos are'}` : 'Queued YouTube videos are';
    const message = workerStatus.message || 'Upload or refresh cookies, then retry the queued video.';
    return `<div class="pause-banner">
      <strong>YouTube processing paused</strong>
      <span>${count} waiting. ${escapeHtml(message)}</span>
    </div>`;
}

export function renderBlockedNotice(v) {
    if (!v.blocked_reason) return '';
    return `<div class="blocked-notice">
      <strong>Paused by YouTube authentication</strong>
      <span>${escapeHtml(v.blocked_message || 'Refresh YouTube cookies, then retry this queued video.')}</span>
    </div>`;
}

export function groupVideos(videos) {
    const groups = {};
    for (const video of videos) {
        (groups[video.state] ||= []).push(video);
    }
    return STATE_ORDER
        .filter(state => groups[state]?.length)
        .map(state => ({ state, videos: groups[state] }));
}

export function sourceNameFromUrl(url) {
    if (/^upload:/i.test(String(url || ''))) return 'uploaded file';
    if (/xiaohongshu\.com/i.test(String(url || ''))) return 'Xiaohongshu';
    if (/youtu\.be|youtube\.com/i.test(String(url || ''))) return 'YouTube';
    return 'source';
}

export function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
    return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDuration(s) {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
}

export { transcriptSourceLabel };
