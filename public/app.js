import { LANGUAGE_LABELS, transcriptSourceLabel, videoStatusMessage } from './status-messages.mjs';
import {
    api,
    deleteChannelRequest,
    deleteVideoRequest,
    fetchChannelsRequest,
    fetchFullVideoRequest,
    fetchLibraryRequest,
    reloadYoutubeAccessRequest,
    retryVideoRequest,
    requestArticleVersionRequest,
    setReadingProgressRequest,
    setVideoReadRequest,
    submitChannel,
    submitVideo,
    CHUNKED_UPLOAD_THRESHOLD_BYTES,
    uploadLargeMediaRequest,
    uploadMediaRequest,
} from './api-client.mjs';
import {
    fullCache,
    setActiveFilter,
    setNavCollapsed,
    setSortOrder,
    state,
} from './state.mjs';
import { looksLikeSingleVideoUrl } from './source-detect.mjs';
import { createUploadProgress } from './upload-ui.mjs';
import { connectSSE } from './sse.mjs';
import {
    articleHash,
    readerRouteFromHash,
    transcriptHash,
} from './router.mjs';
import {
    clampReadingProgress,
    readingProgressFromScroll,
    scrollTopForReadingProgress,
} from './reading-progress.mjs';
import { nextReaderChromeState } from './reader-chrome.mjs';
import {
    formatTranscriptTimestamp,
    transcriptBlocks,
    transcriptTimestampUrl,
} from './transcript-reader.mjs';
import {
    escapeHtml,
    formatCost,
    formatDuration,
    formatInt,
    formatPublishedDate,
    renderBlockedNotice,
    renderGenerationMeta,
    renderMarkdown,
} from './render-helpers.mjs';

const PROCESSING_STEPS = {
    queued: { percent: 8, label: 'Queued' },
    fetching: { percent: 24, label: 'Finding transcript' },
    transcribing: { percent: 62, label: 'Transcribing audio' },
    writing: { percent: 88, label: 'Writing article' },
};
let searchTimer = null;
let readerProgressSession = null;
let readerChromeSession = null;

const ui = {
    channelList: document.getElementById('channel-list'),
    main: document.getElementById('main'),
    contentbar: document.getElementById('contentbar'),
    form: document.getElementById('add-form'),
    input: document.getElementById('channel-url'),
    addBtn: document.getElementById('add-btn'),
    uploadForm: document.getElementById('upload-form'),
    uploadInput: document.getElementById('media-file'),
    uploadBtn: document.getElementById('upload-btn'),
    uploadProgress: document.getElementById('upload-progress'),
    uploadProgressTrack: document.querySelector('#upload-progress .upload-progress-track'),
    uploadProgressBar: document.getElementById('upload-progress-bar'),
    uploadProgressLabel: document.getElementById('upload-progress-label'),
    uploadProgressPercent: document.getElementById('upload-progress-percent'),
    navCollapseBtn: document.getElementById('nav-collapse-btn'),
};

const uploadProgress = createUploadProgress(ui);
document.body.classList.toggle('nav-collapsed', state.navCollapsed);

function syncContentbarHeight() {
    document.documentElement.style.setProperty('--contentbar-height', `${ui.contentbar.getBoundingClientRect().height}px`);
}

syncContentbarHeight();
new ResizeObserver(syncContentbarHeight).observe(ui.contentbar);

function stopReaderChromeTracking() {
    if (readerChromeSession) {
        window.removeEventListener('scroll', readerChromeSession.onScroll);
        readerChromeSession.media.removeEventListener('change', readerChromeSession.onMediaChange);
        readerChromeSession = null;
    }
    document.body.classList.remove('reader-route', 'reader-chrome-hidden');
}

function startReaderChromeTracking() {
    stopReaderChromeTracking();
    const media = matchMedia('(max-width: 860px)');
    let chrome = { hidden: false, lastY: window.scrollY };
    const render = () => {
        document.body.classList.toggle('reader-chrome-hidden', media.matches && chrome.hidden);
    };
    const onScroll = () => {
        chrome = nextReaderChromeState(chrome, { y: window.scrollY, mobile: media.matches });
        render();
    };
    const onMediaChange = () => {
        chrome = { hidden: false, lastY: window.scrollY };
        render();
    };
    document.body.classList.add('reader-route');
    window.addEventListener('scroll', onScroll, { passive: true });
    media.addEventListener('change', onMediaChange);
    readerChromeSession = { media, onScroll, onMediaChange };
}

function toast(msg, kind = 'info') {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 5000);
}

async function fetchChannels() {
    try {
        const j = await fetchChannelsRequest();
        state.channels = j.channels || [];
        ensureValidFilter();
    } catch (err) {
        toast(`Could not load sources: ${err.message}`, 'error');
    } finally {
        state.loadingChannels = false;
        renderSidebar();
    }
}

function libraryRequestParams(offset = 0) {
    return {
        limit: state.libraryLimit,
        offset,
        filter: state.activeFilter.startsWith('src:') ? 'all' : state.activeFilter,
        channelId: state.activeFilter.startsWith('src:') ? state.activeFilter.slice(4) : '',
        query: state.searchQuery.trim(),
        sort: state.sortOrder,
    };
}

async function fetchLibrary({ reset = true, preserveSearchFocus = false, background = false } = {}) {
    const requestId = ++state.libraryRequestId;
    const offset = reset ? 0 : state.libraryVideos.length;
    const searchHadFocus = document.activeElement?.id === 'library-search';
    if (reset) {
        state.loadingLibrary = !background;
        if (!background) state.libraryVideos = [];
        state.libraryOffset = 0;
    } else {
        state.loadingMore = true;
    }
    if (!background && !state.readerVideoId) renderMain();

    try {
        const result = await fetchLibraryRequest(libraryRequestParams(offset));
        if (requestId !== state.libraryRequestId) return;
        state.libraryVideos = reset
            ? result.videos || []
            : [...state.libraryVideos, ...(result.videos || [])];
        state.libraryTotal = Number(result.total) || 0;
        state.libraryOffset = state.libraryVideos.length;
        state.libraryHasMore = state.libraryVideos.length < state.libraryTotal;
        state.libraryCounts = {
            all: Number(result.counts?.all_count) || 0,
            unread: Number(result.counts?.unread_count) || 0,
            processing: Number(result.counts?.processing_count) || 0,
            done: Number(result.counts?.done_count) || 0,
            error: Number(result.counts?.error_count) || 0,
        };
    } catch (err) {
        if (requestId === state.libraryRequestId) toast(`Could not load library: ${err.message}`, 'error');
    } finally {
        if (requestId === state.libraryRequestId) {
            state.loadingLibrary = false;
            state.loadingMore = false;
            renderSidebar();
            if (!background || !state.readerVideoId) renderMain();
            if (preserveSearchFocus || searchHadFocus) focusLibrarySearch();
        }
    }
}

async function addSource(url) {
    ui.addBtn.disabled = true;
    try {
        const isSingleVideo = looksLikeSingleVideoUrl(url);
        const result = isSingleVideo ? await submitVideo(url) : await submitChannel(url);
        if (!result.ok) {
            toast(`Failed: ${result.payload.error || result.status}`, 'error');
        } else {
            ui.input.value = '';
            toast(isSingleVideo ? 'Resolving video...' : 'Listing channel...');
        }
    } finally {
        ui.addBtn.disabled = false;
    }
}

async function uploadMedia(file) {
    if (!file) return;
    ui.uploadBtn.disabled = true;
    ui.uploadInput.disabled = true;
    const originalButtonText = ui.uploadBtn.textContent;
    ui.uploadBtn.textContent = 'Uploading';
    try {
        uploadProgress.setUploadProgress({ visible: true, percent: 0, label: 'Starting upload...' });
        let j;
        if (file.size > CHUNKED_UPLOAD_THRESHOLD_BYTES) {
            j = await uploadLargeMediaRequest(file, { onProgress: uploadProgress.onUploadProgress });
        } else {
            const body = new FormData();
            body.append('media', file);
            j = await uploadMediaRequest(body, { onProgress: uploadProgress.onUploadProgress });
        }
        uploadProgress.setUploadProgress({ visible: true, percent: 100, label: 'Upload complete; queued for transcription.' });

        ui.uploadInput.value = '';
        if (j.video?.id) state.trackedVideoIds.add(j.video.id);
        if (j.channel?.id) {
            setActiveFilter(`src:${j.channel.id}`);
            setLibraryRoute();
        }
        toast(`Uploaded file queued: ${j.video?.title || file.name}`);
        await Promise.all([fetchChannels(), fetchLibrary()]);
    } catch (err) {
        uploadProgress.setUploadProgress({ visible: true, percent: 100, label: 'Upload failed.' });
        toast(`Upload failed: ${err.message || 'unknown error'}`, 'error');
    } finally {
        ui.uploadBtn.disabled = false;
        ui.uploadInput.disabled = false;
        ui.uploadBtn.textContent = originalButtonText;
        uploadProgress.resetUploadProgressSoon();
    }
}

async function fetchFullVideo(videoId) {
    return fetchFullVideoRequest(videoId);
}

// ── Article languages ──────────────────────────────────
// The video's own article is in `article_language`; other languages are
// versions in `versions[language].state`: queued | writing | done | error.
const LANGUAGE_ICONS = {
    none: '<svg class="lang-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>',
    writing: '<svg class="lang-icon lang-spin" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke-opacity="0.25"/><path d="M8 2a6 6 0 0 1 6 6"/></svg>',
    error: '<svg class="lang-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><path d="M8 4.6v4.2M8 11.2v.2"/></svg>',
};
LANGUAGE_ICONS.queued = LANGUAGE_ICONS.writing;
const LANGUAGE_TITLES = {
    none: label => `Write the ${label} version`,
    queued: label => `The ${label} version is queued`,
    writing: label => `Writing the ${label} version`,
    error: label => `Writing the ${label} version failed`,
    done: label => `Read in ${label}`,
};

function mainLanguage(video) {
    return video.article_language || 'en';
}

function versionState(video, language) {
    if (language === mainLanguage(video)) return video.state === 'done' ? 'done' : 'writing';
    return video.versions?.[language]?.state || 'none';
}

// The language last read for this video, if that version still exists.
function readerLanguage(video) {
    let saved = null;
    try { saved = localStorage.getItem(`media-reader:language:${video.id}`); } catch {}
    return saved && video.versions?.[saved] ? saved : mainLanguage(video);
}

function rememberLanguage(videoId, language) {
    try { localStorage.setItem(`media-reader:language:${videoId}`, language); } catch {}
}

// The TL;DR and article to show in `language`, or null while it is not written.
function shownArticle(video, language) {
    if (language === mainLanguage(video)) return { tldr: video.tldr, article: video.article };
    const version = video.versions?.[language];
    return version?.state === 'done' ? { tldr: version.tldr, article: version.article } : null;
}

function renderLanguageSwitch(video, selected = null) {
    if (!video.article_language && video.state !== 'done') {
        return `<span class="lang-label">${LANGUAGE_ICONS.writing}Language: detecting</span>`;
    }
    const main = mainLanguage(video);
    const order = [main, ...Object.keys(LANGUAGE_LABELS).filter(language => language !== main)];
    const buttons = order.map(language => {
        const status = versionState(video, language);
        const label = LANGUAGE_LABELS[language];
        const isSelected = language === selected;
        const locked = language === main && status !== 'done';
        return `<button class="lang-seg state-${status}${isSelected ? ' is-selected' : ''}" data-id="${escapeHtml(video.id)}" data-language="${language}" type="button" aria-pressed="${isSelected}" title="${escapeHtml(LANGUAGE_TITLES[status](label))}" ${locked ? 'disabled' : ''}>${LANGUAGE_ICONS[status] || ''}${label}</button>`;
    }).join('');
    return `<span class="lang-switch" role="group" aria-label="Article language">${buttons}</span>`;
}

function findLoadedVideo(videoId) {
    return fullCache.get(videoId) || allVideos().find(video => video.id === videoId);
}

async function requestVersion(videoId, language) {
    const result = await requestArticleVersionRequest(videoId, language);
    if (!result.ok) {
        toast(`Could not write the ${LANGUAGE_LABELS[language]} version: ${result.payload.error || result.status}`, 'error');
        return false;
    }
    state.trackedVideoIds.add(videoId); // so its ready or failed toast shows
    // Show it queued right away; the server's events refresh it from here.
    for (const video of [fullCache.get(videoId), allVideos().find(item => item.id === videoId)]) {
        if (video) video.versions = { ...video.versions, [language]: { state: 'queued', updated_at: null } };
    }
    return true;
}

// A tap on a language: write it if it is missing, then read it. In the library
// a missing language is only queued, so the list stays where it is.
async function pickLanguage(videoId, language, { inReader = false } = {}) {
    const video = findLoadedVideo(videoId);
    if (!video) return;
    const missing = versionState(video, language) === 'none';
    if (missing && !(await requestVersion(videoId, language))) return;
    if (!inReader && (missing || video.state !== 'done')) {
        renderMain();
        return;
    }
    rememberLanguage(videoId, language);
    if (!inReader) {
        openReader(videoId);
        return;
    }
    if (state.readerVideoId !== videoId) return; // moved on while the request was out
    stopReadingProgressTracking({ flush: true });
    renderReader(videoId);
}

async function retryVersion(videoId, language) {
    if (await requestVersion(videoId, language) && state.readerVideoId === videoId) renderReader(videoId);
}

function formatClock(sqliteTime) {
    const date = new Date(`${String(sqliteTime || '').replace(' ', 'T')}Z`);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Shown in place of the article while a version is queued, being written, or failed.
function renderVersionPanel(full, language) {
    const version = full.versions?.[language] || {};
    const label = LANGUAGE_LABELS[language];
    const main = mainLanguage(full);
    const mainLabel = LANGUAGE_LABELS[main];
    const failed = version.state === 'error';
    const back = `<button class="textbtn lang-pick-btn" data-id="${escapeHtml(full.id)}" data-language="${main}" type="button">${failed ? `Back to ${mainLabel}` : `Read the ${mainLabel} version meanwhile`}</button>`;
    if (failed) {
        return `
          <div id="article-panel" role="tabpanel" aria-labelledby="article-tab">
            <section class="version-panel is-error" role="alert">
              <h2>${LANGUAGE_ICONS.error}Couldn't write the ${label} version</h2>
              <p class="error-msg">${escapeHtml(version.error || 'unknown error')}</p>
              <p>The ${mainLabel} version is untouched and the transcript is kept, so trying again starts straight at the writing step.</p>
              <div class="version-actions">
                <button class="textbtn version-retry-btn" data-id="${escapeHtml(full.id)}" data-language="${language}" type="button">Try again</button>
                ${back}
              </div>
            </section>
          </div>`;
    }
    const since = version.state === 'writing' ? formatClock(version.updated_at) : '';
    const status = version.state === 'writing'
        ? `Writing${since ? ` since ${since}` : ''}.`
        : 'Queued; it starts when the worker is free.';
    return `
      <div id="article-panel" role="tabpanel" aria-labelledby="article-tab">
        <section class="version-panel" aria-live="polite">
          <h2>${LANGUAGE_ICONS.writing}Writing the ${label} version</h2>
          <p>From the stored transcript, so nothing is downloaded or transcribed again. Usually about a minute. It appears here by itself; if you leave, a toast says when it is ready.</p>
          <p class="version-status">${escapeHtml(status)}</p>
          <div class="version-actions">${back}</div>
        </section>
        <div class="skeleton-lines" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
      </div>`;
}

// A version finished or failed while its video is open: redraw the reader in place.
// Events can overlap, so only the newest fetch may redraw.
let readerRefreshSeq = 0;
async function refreshOpenReader(videoId) {
    const seq = ++readerRefreshSeq;
    const progress = readerProgressSession?.videoId === videoId ? readingProgressForWindow() : null;
    const full = await fetchFullVideo(videoId);
    if (!full || seq !== readerRefreshSeq || state.readerVideoId !== videoId) return;
    if (progress != null) full.reading_progress = progress;
    fullCache.set(videoId, full);
    renderReader(videoId);
}

async function retryVideo(videoId) {
    await retryVideoRequest(videoId);
    await Promise.all([fetchChannels(), fetchLibrary()]);
}

async function reloadYoutubeAccess() {
    const button = document.getElementById('youtube-reload-btn');
    if (button) button.disabled = true;
    try {
        const result = await reloadYoutubeAccessRequest();
        const source = result.source === 'chrome' ? 'live Chromium' : result.source === 'file' ? 'uploaded cookie file' : 'no cookie source';
        toast(`YouTube access reloaded from ${source}. Retried ${result.retried || 0} blocked video${result.retried === 1 ? '' : 's'}.`, 'success');
        await Promise.all([fetchChannels(), fetchLibrary()]);
    } catch (err) {
        toast(`YouTube reload failed: ${err.message}`, 'error');
    } finally {
        if (button?.isConnected) button.disabled = false;
    }
}

async function deleteTranscript(videoId) {
    const video = allVideos().find(v => v.id === videoId);
    const label = video?.title || videoId;
    if (!confirm(`Delete transcript "${label}"? This removes its TL;DR and article and cannot be undone.`)) return;

    const r = await deleteVideoRequest(videoId);
    if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        toast(`Delete failed: ${j.error || r.status}`, 'error');
        return;
    }

    removeVideoFromState(videoId);
    fullCache.delete(videoId);
    if (state.readerVideoId === videoId) setLibraryRoute({ replace: true });
    toast('Transcript deleted');
    renderMain();
    await Promise.all([fetchChannels(), fetchLibrary()]);
}

async function deleteCurrentSource() {
    const channelId = state.activeFilter.startsWith('src:') ? state.activeFilter.slice(4) : null;
    if (!channelId) return;
    const channel = state.channels.find(c => c.id === channelId);
    const label = sourceTitle(channel);
    const total = channel?.videos_total || 0;
    if (!confirm(`Delete source "${label}" and ${total} transcript${total === 1 ? '' : 's'}? This cannot be undone.`)) return;

    const r = await deleteChannelRequest(channelId);
    if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        toast(`Delete failed: ${j.error || r.status}`, 'error');
        return;
    }
    state.channels = state.channels.filter(c => c.id !== channelId);
    setActiveFilter('all');
    toast('Source deleted');
    renderSidebar();
    renderMain();
    await Promise.all([fetchChannels(), fetchLibrary()]);
}

function removeVideoFromState(videoId) {
    state.libraryVideos = state.libraryVideos.filter(video => video.id !== videoId);
    state.libraryTotal = Math.max(0, state.libraryTotal - 1);
}

function ensureValidFilter() {
    if (!state.activeFilter.startsWith('src:')) return;
    const channelId = state.activeFilter.slice(4);
    if (!state.channels.some(c => c.id === channelId)) setActiveFilter('all');
}

function allVideos() {
    const channels = new Map(state.channels.map(channel => [channel.id, channel]));
    return state.libraryVideos.map(video => ({
        ...video,
        channel: channels.get(video.channel_id) || {
            id: video.channel_id,
            title: video.channel_title,
            handle: video.channel_handle,
        },
    }));
}

function visibleVideos() {
    return allVideos();
}

function sourceTitle(channel) {
    return channel?.title || channel?.handle || channel?.id || 'Source';
}

function sourceGlyph(channel) {
    const title = sourceTitle(channel);
    if (channel?.id === 'local-uploads' || /upload/i.test(title)) return '^';
    const handle = channel?.handle || title;
    return String(handle).replace(/^@/, '').slice(0, 1).toUpperCase() || '?';
}

function sourceKind(video) {
    if (video.source_type === 'upload') return 'Upload';
    if (/xiaohongshu/i.test(video.url || '')) return 'Xiaohongshu';
    return 'YouTube';
}

function renderPublishedMeta(video) {
    const date = formatPublishedDate(video?.published_at);
    return date
        ? `<span class="meta-dot">·</span><span class="meta-bit">Published ${escapeHtml(date)}</span>`
        : '';
}

function renderReadingProgressMeta(video) {
    const progress = clampReadingProgress(video?.reading_progress);
    if (progress < 0.01) return '';
    return `<span class="meta-dot">·</span><span class="meta-bit">${Math.round(progress * 100)}% read</span>`;
}

function counts() {
    const base = { ...state.libraryCounts };
    for (const channel of state.channels) {
        base[`src:${channel.id}`] = Number(channel.videos_total) || 0;
    }
    return base;
}

function renderSidebar() {
    const c = counts();
    const libraryItems = [
        ['all', 'All articles', '□'],
        ['unread', 'Unread', '•'],
        ['processing', 'Processing', '◌'],
        ['done', 'Ready', '✓'],
        ['error', 'Needs attention', '!'],
    ];

    ui.channelList.innerHTML = `
      <div class="side-group">
        <div class="side-label">Library</div>
        ${libraryItems.map(([id, label, icon]) => renderSideItem({
            id,
            label,
            icon,
            count: state.loadingLibrary ? null : c[id],
        })).join('')}
      </div>
      <div class="side-group side-access-group">
        <div class="side-label">YouTube access</div>
        <button class="side-item" id="youtube-reload-btn" type="button" title="Reload YouTube cookies and retry authentication failures">
          <span class="side-ic">↻</span>
          <span class="side-text">Reload cookies</span>
        </button>
      </div>
      <div class="side-group">
        <div class="side-label">Sources</div>
        ${state.loadingChannels ? renderSourceSkeletons() : ''}
        ${!state.loadingChannels && state.channels.length === 0 ? '<div class="side-empty">No sources yet</div>' : ''}
        ${state.channels.map(channel => renderSideItem({
            id: `src:${channel.id}`,
            label: sourceTitle(channel),
            icon: sourceGlyph(channel),
            count: c[`src:${channel.id}`],
            source: true,
        })).join('')}
      </div>
    `;
    ui.channelList.querySelectorAll('.side-item[data-filter]').forEach(el => {
        el.addEventListener('click', () => {
            setActiveFilter(el.dataset.filter);
            setLibraryRoute();
            state.navOpen = false;
            document.body.classList.remove('nav-open');
            renderSidebar();
            fetchLibrary();
        });
    });
    document.getElementById('youtube-reload-btn')?.addEventListener('click', reloadYoutubeAccess);
}

function renderSourceSkeletons() {
    return Array.from({ length: 6 }, () => `
      <div class="side-item side-skeleton" aria-hidden="true">
        <span class="side-glyph"></span><span class="skeleton-line"></span><span class="side-count">…</span>
      </div>
    `).join('');
}

function renderSideItem({ id, label, icon, count, source = false }) {
    const active = state.activeFilter === id;
    return `
      <button class="side-item ${active ? 'active' : ''}" data-filter="${escapeHtml(id)}" title="${escapeHtml(label)}">
        <span class="${source ? 'side-glyph' : 'side-ic'}">${escapeHtml(icon)}</span>
        <span class="side-text">${escapeHtml(label)}</span>
        <span class="side-count">${count == null ? '…' : count}</span>
      </button>
    `;
}

function renderMain() {
    if (state.readerVideoId) {
        renderReader(state.readerVideoId);
        return;
    }

    const videos = visibleVideos();
    const title = viewTitle();
    const c = counts();
    const displayedCount = state.searchQuery.trim()
        ? state.libraryTotal
        : (c[state.activeFilter] ?? state.libraryTotal);
    const sourceDelete = state.activeFilter.startsWith('src:')
        ? '<button class="textbtn" id="delete-source-btn" type="button">Delete source</button>'
        : '';

    ui.main.innerHTML = `
      <div class="feed-wrap">
        <div class="feedhead">
          <button class="menu-btn" id="menu-btn" type="button" title="Sources" aria-label="Open sources">☰</button>
          <h2 class="feedhead-title">${escapeHtml(title)} <span class="feedhead-count">${state.loadingLibrary ? '…' : displayedCount}</span></h2>
          <div class="feedhead-right">
            <label class="searchbox"><span aria-hidden="true">⌕</span><span class="sr-only">Search library</span><input id="library-search" type="search" placeholder="Search library" value="${escapeHtml(state.searchQuery)}"></label>
            <button class="sortbtn" id="sort-btn" type="button">${state.sortOrder === 'newest' ? 'Newest' : 'Oldest'} ↓</button>
            ${sourceDelete}
          </div>
        </div>
        <section class="feed">
          ${state.loadingLibrary ? renderCardSkeletons() : (videos.length === 0 ? renderEmptyState() : videos.map(renderVideoCard).join(''))}
        </section>
        ${!state.loadingLibrary && state.libraryHasMore ? `<div class="load-more-wrap"><button class="textbtn load-more-btn" id="load-more-btn" type="button" ${state.loadingMore ? 'disabled' : ''}>${state.loadingMore ? 'Loading…' : `Load more (${state.libraryVideos.length} of ${state.libraryTotal})`}</button></div>` : ''}
      </div>
    `;
    bindFeedEvents();
}

function renderCardSkeletons() {
    return Array.from({ length: 6 }, () => `
      <article class="card card-skeleton" aria-hidden="true">
        <div class="card-main"><div class="skeleton-title"></div><div class="skeleton-copy"></div><div class="skeleton-copy short"></div></div>
      </article>
    `).join('');
}

function viewTitle() {
    if (state.activeFilter === 'all') return 'All articles';
    if (state.activeFilter === 'unread') return 'Unread';
    if (state.activeFilter === 'processing') return 'Processing';
    if (state.activeFilter === 'done') return 'Ready';
    if (state.activeFilter === 'error') return 'Needs attention';
    if (state.activeFilter.startsWith('src:')) {
        const channel = state.channels.find(c => c.id === state.activeFilter.slice(4));
        return sourceTitle(channel);
    }
    return 'Library';
}

function renderEmptyState() {
    const message = state.searchQuery
        ? 'Nothing matches that search.'
        : 'Nothing here yet. Paste a link above or upload a media file to start reading.';
    return `<div class="empty"><div class="empty-glyph">◇</div><p>${escapeHtml(message)}</p></div>`;
}

function renderVideoCard(video) {
    if (video.state === 'error') return renderErrorCard(video);
    if (video.state !== 'done') return renderProcessingCard(video);
    return renderDoneCard(video);
}

function renderDoneCard(video) {
    const read = Boolean(video.read_at);
    const duration = video.duration_sec ? formatDuration(video.duration_sec) : '';
    const source = sourceTitle(video.channel);
    const preview = firstBullets(video.tldr, 2);
    const cost = formatCost(video.cost_usd_est || video.cost_usd);
    const tokens = video.total_tokens_est ? `${formatInt(video.total_tokens_est)} tok` : '';
    return `
      <article class="card ${read ? 'is-read' : ''}" data-id="${video.id}">
        <div class="card-main">
          <div class="card-top">
            ${read ? '' : '<span class="unread-pip"></span>'}
            <h3 class="card-title"><button class="card-title-button open-reader-btn" data-id="${video.id}" type="button">${escapeHtml(video.title || video.id)}</button></h3>
          </div>
          <div class="card-tldr">${preview ? renderMarkdown(preview) : '<p>Article ready. Open it to read the full generated version.</p>'}</div>
          <div class="card-lang">${renderLanguageSwitch(video, readerLanguage(video))}</div>
          <div class="card-meta">
            <span class="chip"><span class="chip-glyph"></span>${escapeHtml(source)}</span>
            ${renderPublishedMeta(video)}
            ${renderReadingProgressMeta(video)}
            ${duration ? `<span class="meta-dot">·</span><span class="meta-bit">${escapeHtml(duration)} source</span>` : ''}
            <span class="meta-dot">·</span><span class="meta-bit">${escapeHtml(sourceKind(video))}</span>
            ${video.transcript_source ? `<span class="meta-dot">·</span><span class="meta-bit">${escapeHtml(transcriptSourceLabel(video.transcript_source))}</span>` : ''}
            ${cost ? `<span class="meta-dot">·</span><span class="meta-bit">${escapeHtml(cost)}</span>` : ''}
            ${tokens ? `<span class="meta-dot">·</span><span class="meta-bit">${escapeHtml(tokens)}</span>` : ''}
          </div>
        </div>
        <div class="card-actions">
          <button class="iconbtn mark-read-btn" data-id="${video.id}" title="${read ? 'Mark unread' : 'Mark read'}" aria-label="${read ? 'Mark unread' : 'Mark read'}" type="button">✓</button>
          <button class="iconbtn copy-content-btn" data-id="${video.id}" data-copy-kind="tldr" title="Copy TL;DR" aria-label="Copy TL;DR" type="button">⧉</button>
          <button class="iconbtn danger delete-video-btn" data-id="${video.id}" title="Delete" aria-label="Delete article" type="button">×</button>
        </div>
      </article>
    `;
}

function renderProcessingCard(video) {
    const step = PROCESSING_STEPS[video.state] || PROCESSING_STEPS.queued;
    const stepLabel = video.state === 'writing' && video.article_language
        ? `Writing the ${LANGUAGE_LABELS[video.article_language] || ''} article`
        : step.label;
    const blocked = renderBlockedNotice(video);
    return `
      <article class="card" data-id="${video.id}">
        <div class="card-main">
          <div class="card-top">
            <span class="state-dot ${escapeHtml(video.state)}"></span>
            <h3 class="card-title">${escapeHtml(video.title || 'Resolving source...')}</h3>
          </div>
          <div class="video-process ${escapeHtml(video.state)}">
            <div class="video-process-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${step.percent}">
              <div class="video-process-bar" style="width:${step.percent}%"></div>
            </div>
            <div class="video-process-text">
              <span>${escapeHtml(stepLabel)}</span>
              <span>${step.percent}%</span>
            </div>
          </div>
          <div class="card-lang">${renderLanguageSwitch(video)}</div>
          ${blocked}
          <div class="card-meta">
            <span class="meta-bit work">${escapeHtml(step.label)}</span>
            <span class="meta-dot">·</span>
            <span class="chip"><span class="chip-glyph"></span>${escapeHtml(sourceTitle(video.channel))}</span>
            ${renderPublishedMeta(video)}
          </div>
        </div>
      </article>
    `;
}

function renderErrorCard(video) {
    const blocked = renderBlockedNotice(video);
    return `
      <article class="card" data-id="${video.id}">
        <div class="card-main">
          <div class="card-top">
            <span class="state-dot error"></span>
            <h3 class="card-title">${escapeHtml(video.title || video.id)}</h3>
          </div>
          ${blocked || `<div class="error-msg">${escapeHtml(video.error || 'unknown error')}</div>`}
          <div class="card-meta">
            <span class="chip"><span class="chip-glyph"></span>${escapeHtml(sourceTitle(video.channel))}</span>
            ${renderPublishedMeta(video)}
            <span class="meta-dot">·</span>
            <span class="meta-bit">Needs attention</span>
          </div>
        </div>
        <div class="card-actions">
          <button class="textbtn retry-btn" data-id="${video.id}" type="button">Retry</button>
          <button class="iconbtn danger delete-video-btn" data-id="${video.id}" title="Delete" aria-label="Delete article" type="button">×</button>
        </div>
      </article>
    `;
}

function bindFeedEvents() {
    document.getElementById('menu-btn')?.addEventListener('click', () => {
        state.navOpen = true;
        document.body.classList.add('nav-open');
        if (!document.querySelector('.nav-backdrop')) {
            const backdrop = document.createElement('div');
            backdrop.className = 'nav-backdrop';
            backdrop.addEventListener('click', () => {
                state.navOpen = false;
                document.body.classList.remove('nav-open');
                backdrop.remove();
            });
            document.body.appendChild(backdrop);
        }
    });
    document.getElementById('sort-btn')?.addEventListener('click', () => {
        setSortOrder(state.sortOrder === 'newest' ? 'oldest' : 'newest');
        fetchLibrary();
    });
    document.getElementById('load-more-btn')?.addEventListener('click', () => fetchLibrary({ reset: false }));
    document.getElementById('delete-source-btn')?.addEventListener('click', deleteCurrentSource);
    document.getElementById('library-search')?.addEventListener('input', (event) => {
        state.searchQuery = event.target.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => fetchLibrary({ preserveSearchFocus: true }), 250);
    });
    ui.main.querySelectorAll('.open-reader-btn').forEach(el => {
        el.addEventListener('click', () => openReader(el.dataset.id));
    });
    ui.main.querySelectorAll('.mark-read-btn').forEach(el => {
        el.addEventListener('click', () => updateVideoRead(el.dataset.id));
    });
    ui.main.querySelectorAll('.retry-btn').forEach(el => {
        el.addEventListener('click', () => retryVideo(el.dataset.id));
    });
    ui.main.querySelectorAll('.delete-video-btn').forEach(el => {
        el.addEventListener('click', () => deleteTranscript(el.dataset.id));
    });
    ui.main.querySelectorAll('.copy-content-btn').forEach(el => {
        el.addEventListener('click', () => copyGeneratedText(el.dataset.id, el.dataset.copyKind));
    });
    ui.main.querySelectorAll('.lang-seg').forEach(el => {
        el.addEventListener('click', () => pickLanguage(el.dataset.id, el.dataset.language));
    });
}

function showReader(videoId, tab = 'article') {
    stopReadingProgressTracking({ flush: true });
    stopReaderChromeTracking();
    state.readerVideoId = videoId;
    state.readerTab = tab === 'transcript' ? 'transcript' : 'article';
    const video = state.libraryVideos.find(item => item.id === videoId);
    if (video && !video.read_at) updateVideoRead(videoId, true, { render: false });
    renderSidebar();
    renderMain();
}

function readerHash(videoId, tab) {
    return tab === 'transcript' ? transcriptHash(videoId) : articleHash(videoId);
}

function openReader(videoId, tab = 'article') {
    const nextTab = tab === 'transcript' ? 'transcript' : 'article';
    history.pushState({ mediaReaderRoute: nextTab }, '', readerHash(videoId, nextTab));
    showReader(videoId, nextTab);
}

function switchReaderTab(tab) {
    if (!state.readerVideoId || tab === state.readerTab) return;
    openReader(state.readerVideoId, tab);
}

function setLibraryRoute({ replace = false } = {}) {
    stopReadingProgressTracking({ flush: true });
    stopReaderChromeTracking();
    const method = replace ? 'replaceState' : 'pushState';
    history[method]({ mediaReaderRoute: 'library' }, '', `${location.pathname}${location.search}`);
    state.readerVideoId = null;
    state.readerTab = 'article';
}

async function updateVideoRead(videoId, forceRead, { render = true } = {}) {
    const video = state.libraryVideos.find(item => item.id === videoId);
    if (!video) return;
    const previous = video.read_at;
    const read = forceRead ?? !previous;
    video.read_at = read ? new Date().toISOString() : null;
    if (video.state === 'done') {
        const delta = read && !previous ? -1 : !read && previous ? 1 : 0;
        state.libraryCounts.unread = Math.max(0, state.libraryCounts.unread + delta);
    }
    if (render) {
        renderSidebar();
        renderMain();
    }
    try {
        await setVideoReadRequest(videoId, read);
    } catch (err) {
        video.read_at = previous;
        toast(`Could not update read state: ${err.message}`, 'error');
        await fetchLibrary();
    }
}

function focusLibrarySearch() {
    const input = document.getElementById('library-search');
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
}

async function renderReader(videoId) {
    stopReaderChromeTracking();
    const readerTab = state.readerTab;
    let video = allVideos().find(v => v.id === videoId);
    let full = fullCache.get(videoId);
    if (!full) {
        ui.main.innerHTML = '<div class="reader"><div class="reader-bar"><button class="textbtn back-library-btn" type="button">Library</button></div><div class="empty"><div class="empty-glyph">◇</div><p>Loading reader...</p></div></div>';
        document.querySelector('.back-library-btn')?.addEventListener('click', backToLibrary);
        full = await fetchFullVideo(videoId);
        if (full) fullCache.set(videoId, full);
        if (state.readerVideoId !== videoId || state.readerTab !== readerTab) return;
    }

    if (!full) {
        ui.main.innerHTML = '<div class="empty"><div class="empty-glyph">!</div><p>Article not found.</p></div>';
        return;
    }

    if (!video) {
        const channel = state.channels.find(item => item.id === full.channel_id);
        video = {
            ...full,
            channel: channel || {
                id: full.channel_id,
                title: full.channel_title || '',
                handle: full.channel_handle || '',
            },
        };
    }

    const readable = visibleVideos().filter(v => v.state === 'done' && v.tldr);
    const index = readable.findIndex(v => v.id === videoId);
    const prev = readable[index - 1];
    const next = readable[index + 1];
    const duration = full.duration_sec ? formatDuration(full.duration_sec) : '';
    const initialProgress = clampReadingProgress(full.reading_progress);
    const initialProgressPercent = Math.round(initialProgress * 100);
    const isArticle = readerTab === 'article';
    const language = readerLanguage(full);
    const shown = isArticle ? shownArticle(full, language) : null;
    const readerContent = !isArticle
        ? renderTranscriptBody(full)
        : shown ? renderArticleBody({ ...full, ...shown }) : renderVersionPanel(full, language);
    const copyDisabled = shown ? '' : 'disabled';
    const copyActions = isArticle
        ? `
            <button class="textbtn copy-content-btn" data-id="${full.id}" data-copy-kind="tldr" type="button" aria-label="Copy TL;DR" ${copyDisabled}><span class="hide-sm">Copy </span>TL;DR</button>
            <button class="textbtn copy-content-btn" data-id="${full.id}" data-copy-kind="article" type="button" aria-label="Copy article" ${copyDisabled}><span class="hide-sm">Copy </span>Article</button>`
        : '<button class="textbtn copy-content-btn" data-id="' + escapeHtml(full.id) + '" data-copy-kind="transcript" type="button">Copy <span class="hide-sm">Transcript</span></button>';
    const languageControl = isArticle
        ? renderLanguageSwitch(full, language)
        : `<span class="lang-label">Spoken in ${LANGUAGE_LABELS[mainLanguage(full)]}</span>`;

    ui.main.innerHTML = `
      <article class="reader">
        <div class="reader-bar">
          <div class="reader-bar-left">
            <button class="textbtn back-library-btn" type="button">‹ Library</button>
            ${shown ? `<span class="reader-progress-label">${initialProgressPercent}% read</span>` : ''}
          </div>
          <div class="reader-center">
            <div class="reader-tabs" role="tablist" aria-label="Reader view">
              <button class="reader-tab-btn" id="article-tab" role="tab" aria-selected="${isArticle}" aria-controls="article-panel" tabindex="${isArticle ? '0' : '-1'}" data-reader-tab="article" type="button">Article</button>
              <button class="reader-tab-btn" id="transcript-tab" role="tab" aria-selected="${!isArticle}" aria-controls="transcript-panel" tabindex="${isArticle ? '-1' : '0'}" data-reader-tab="transcript" type="button">Transcript</button>
            </div>
            ${languageControl}
          </div>
          <div class="reader-bar-right">
            ${copyActions}
            <button class="iconbtn danger delete-video-btn" data-id="${full.id}" title="Delete" aria-label="Delete article" type="button">×</button>
          </div>
          ${shown ? `<div class="reader-progress-track" role="progressbar" aria-label="Article reading progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${initialProgressPercent}">
            <div class="reader-progress-fill" style="width: ${initialProgress * 100}%"></div>
          </div>` : ''}
        </div>
        ${shown ? `<div class="reader-progress-track reader-progress-track-fixed" role="progressbar" aria-label="Article reading progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${initialProgressPercent}" aria-hidden="true">
          <div class="reader-progress-fill" style="width: ${initialProgress * 100}%"></div>
        </div>` : ''}
        <div class="reader-col">
          <div class="reader-kicker">
            <span class="chip"><span class="chip-glyph"></span>${escapeHtml(sourceTitle(video.channel))}</span>
            ${renderPublishedMeta(full)}
            ${duration ? `<span class="meta-dot">·</span><span class="meta-bit">${escapeHtml(duration)} source</span>` : ''}
            ${full.transcript_source ? `<span class="meta-dot">·</span><span class="meta-bit">${escapeHtml(transcriptSourceLabel(full.transcript_source))}</span>` : ''}
          </div>
          <h1 class="reader-title">${escapeHtml(full.title || video.title || full.id)}</h1>
          ${readerContent}
        </div>
        <div class="reader-nav">
          <button class="textbtn nav-reader-btn" data-id="${prev?.id || ''}" ${prev ? '' : 'disabled'} type="button">‹ Previous</button>
          <button class="textbtn nav-reader-btn" data-id="${next?.id || ''}" ${next ? '' : 'disabled'} type="button">Next ›</button>
        </div>
      </article>
    `;
    document.querySelector('.back-library-btn')?.addEventListener('click', backToLibrary);
    ui.main.querySelectorAll('.reader-tab-btn').forEach(el => {
        el.addEventListener('click', () => switchReaderTab(el.dataset.readerTab));
        el.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
            event.preventDefault();
            switchReaderTab(el.dataset.readerTab === 'article' ? 'transcript' : 'article');
        });
    });
    ui.main.querySelectorAll('.copy-content-btn').forEach(el => {
        el.addEventListener('click', () => copyGeneratedText(el.dataset.id, el.dataset.copyKind, { fromReader: true }));
    });
    ui.main.querySelectorAll('.delete-video-btn').forEach(el => {
        el.addEventListener('click', () => deleteTranscript(el.dataset.id));
    });
    ui.main.querySelectorAll('.lang-seg, .lang-pick-btn').forEach(el => {
        el.addEventListener('click', () => pickLanguage(el.dataset.id, el.dataset.language, { inReader: true }));
    });
    ui.main.querySelectorAll('.version-retry-btn').forEach(el => {
        el.addEventListener('click', () => retryVersion(el.dataset.id, el.dataset.language));
    });
    ui.main.querySelectorAll('.nav-reader-btn').forEach(el => {
        el.addEventListener('click', () => {
            if (el.dataset.id) openReader(el.dataset.id, readerTab);
        });
    });
    if (shown) {
        startReadingProgressTracking(full);
    } else {
        window.scrollTo(0, 0);
        requestAnimationFrame(() => startReaderChromeTracking());
    }
}

function renderArticleBody(full) {
    return `
      <div id="article-panel" role="tabpanel" aria-labelledby="article-tab">
        <div class="tldr-box">
          <div class="tldr-label">TL;DR</div>
          <div class="markdown">${renderMarkdown(full.tldr || '')}</div>
        </div>
        <div class="markdown reader-body">${renderMarkdown(full.article || '')}</div>
        ${renderGenerationMeta(full)}
        ${renderOriginalLink(full)}
      </div>
    `;
}

function renderTranscriptBody(full) {
    const blocks = transcriptBlocks(full);
    const body = blocks.length > 0
        ? blocks.map(block => {
            const timestamp = formatTranscriptTimestamp(block.startMs);
            const timestampUrl = timestamp ? transcriptTimestampUrl({
                sourceType: full.source_type,
                sourceUrl: full.url,
                startMs: block.startMs,
            }) : null;
            const timestampHtml = !timestamp
                ? ''
                : timestampUrl
                    ? `<a class="transcript-time" href="${escapeHtml(timestampUrl)}" target="_blank" rel="noreferrer">${escapeHtml(timestamp)}</a>`
                    : `<span class="transcript-time">${escapeHtml(timestamp)}</span>`;
            return `<div class="transcript-block${timestamp ? '' : ' untimed'}">${timestampHtml}<p>${escapeHtml(block.text || '')}</p></div>`;
        }).join('')
        : '<div class="empty transcript-empty"><p>Transcript unavailable.</p></div>';
    return `
      <div class="transcript-body" id="transcript-panel" role="tabpanel" aria-labelledby="transcript-tab">
        ${body}
        ${renderOriginalLink(full)}
      </div>
    `;
}

function readingProgressForWindow() {
    return readingProgressFromScroll({
        scrollTop: window.scrollY,
        scrollHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
    });
}

function updateReadingProgressIndicator(progress) {
    const normalized = clampReadingProgress(progress);
    const percent = Math.round(normalized * 100);
    const tracks = ui.main.querySelectorAll('.reader-progress-track');
    const fills = ui.main.querySelectorAll('.reader-progress-fill');
    const label = ui.main.querySelector('.reader-progress-label');
    tracks.forEach(track => track.setAttribute('aria-valuenow', String(percent)));
    fills.forEach(fill => { fill.style.width = `${normalized * 100}%`; });
    if (label) label.textContent = `${percent}% read`;
}

function cacheReadingProgress(videoId, progress) {
    const video = state.libraryVideos.find(item => item.id === videoId);
    if (video) video.reading_progress = progress;
    const full = fullCache.get(videoId);
    if (full) full.reading_progress = progress;
}

function persistReadingProgress(videoId, progress, { keepalive = false } = {}) {
    cacheReadingProgress(videoId, progress);
    setReadingProgressRequest(videoId, progress, { keepalive }).catch(() => {});
}

function stopReadingProgressTracking({ flush = false } = {}) {
    const session = readerProgressSession;
    if (!session) return;
    window.removeEventListener('scroll', session.onScroll);
    clearTimeout(session.timer);
    if (flush && !session.restoring) {
        persistReadingProgress(session.videoId, readingProgressForWindow(), { keepalive: true });
    }
    readerProgressSession = null;
}

function startReadingProgressTracking(video) {
    stopReadingProgressTracking();
    const progress = clampReadingProgress(video.reading_progress);
    const session = {
        videoId: video.id,
        restoring: true,
        timer: null,
        onScroll: null,
    };
    session.onScroll = () => {
        if (session.restoring) return;
        const nextProgress = readingProgressForWindow();
        updateReadingProgressIndicator(nextProgress);
        cacheReadingProgress(session.videoId, nextProgress);
        clearTimeout(session.timer);
        session.timer = setTimeout(() => {
            persistReadingProgress(session.videoId, nextProgress);
        }, 750);
    };
    readerProgressSession = session;
    window.addEventListener('scroll', session.onScroll, { passive: true });

    requestAnimationFrame(() => requestAnimationFrame(() => {
        if (readerProgressSession !== session) return;
        window.scrollTo(0, scrollTopForReadingProgress(progress, {
            scrollHeight: document.documentElement.scrollHeight,
            viewportHeight: window.innerHeight,
        }));
        updateReadingProgressIndicator(progress);
        session.restoring = false;
        startReaderChromeTracking();
    }));
}

function backToLibrary() {
    setLibraryRoute();
    renderSidebar();
    renderMain();
}

function renderOriginalLink(video) {
    if (video.source_type === 'upload') {
        const size = video.file_size_bytes ? ` · ${formatBytes(video.file_size_bytes)}` : '';
        return `<div class="original-link">Uploaded file: ${escapeHtml(video.original_filename || video.title || 'local media')}${size}</div>`;
    }
    if (!video.url) return '';
    return `<div class="original-link"><a href="${escapeHtml(video.url)}" target="_blank" rel="noreferrer">Open original source</a></div>`;
}

function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
    return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function firstBullets(markdown, count) {
    const lines = String(markdown || '').split('\n').filter(line => line.trim().startsWith('-'));
    return lines.slice(0, count).join('\n');
}

async function copyGeneratedText(videoId, kind, { fromReader = false } = {}) {
    let fullData = fullCache.get(videoId);
    if (!fullData) {
        fullData = await fetchFullVideo(videoId);
        if (fullData) fullCache.set(videoId, fullData);
    }
    const shown = fullData ? shownArticle(fullData, fromReader ? readerLanguage(fullData) : mainLanguage(fullData)) : null;
    const text = kind === 'article'
        ? shown && `# ${fullData.title || ''}\n\n## TL;DR\n${shown.tldr || ''}\n\n${shown.article || ''}`
        : kind === 'transcript' ? fullData?.transcript : shown?.tldr;
    const label = kind === 'article' ? 'Article' : kind === 'transcript' ? 'Transcript' : 'TL;DR';
    if (!text) {
        toast(`${label} is not loaded yet`, 'error');
        return;
    }

    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
        } else {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.setAttribute('readonly', '');
            textarea.style.position = 'fixed';
            textarea.style.left = '-9999px';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            textarea.remove();
        }
        toast(`${label} copied`, 'success');
    } catch (err) {
        toast(`Copy failed: ${err.message || 'clipboard unavailable'}`, 'error');
    }
}

function onChannelChange() {
    Promise.all([fetchChannels(), fetchLibrary({ background: true })]);
}

function onChannelDeleted(e) {
    try {
        const d = JSON.parse(e.data);
        state.channels = state.channels.filter(c => c.id !== d.id);
        if (state.activeFilter === `src:${d.id}`) setActiveFilter('all');
    } catch {}
    Promise.all([fetchChannels(), fetchLibrary({ background: true })]);
}

let videoRefreshTimer = null;
function toastVideoStatus(eventType, data) {
    if (eventType === 'video:state' && data.single && data.id) {
        state.trackedVideoIds.add(data.id);
    }
    if (eventType === 'video:state' && data.source_type === 'upload' && data.id) {
        state.trackedVideoIds.add(data.id);
    }

    if (!data.id || !state.trackedVideoIds.has(data.id)) return;

    const status = videoStatusMessage(eventType, data);
    if (!status) return;

    const key = [
        eventType,
        data.id,
        data.state || '',
        data.transcript_source || '',
        data.error || '',
    ].join(':');
    if (state.seenVideoToastKeys.has(key)) return;
    state.seenVideoToastKeys.add(key);

    toast(status.message, status.kind);
}

function onVideoUpdate(e) {
    try {
        const data = JSON.parse(e.data);
        toastVideoStatus(e.type, data);
        if (data.id) fullCache.delete(data.id);
        if (data.version && data.id === state.readerVideoId) refreshOpenReader(data.id);
    } catch {}

    if (videoRefreshTimer) return;
    videoRefreshTimer = setTimeout(() => {
        videoRefreshTimer = null;
        Promise.all([fetchChannels(), fetchLibrary({ background: true })]);
    }, 500);
}

function onVideoDeleted(e) {
    try {
        const d = JSON.parse(e.data);
        removeVideoFromState(d.id);
        if (d.id === state.readerVideoId) setLibraryRoute({ replace: true });
        fullCache.delete(d.id);
        state.trackedVideoIds.delete(d.id);
    } catch {}
    onVideoUpdate(e);
}

ui.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = ui.input.value.trim();
    if (url) addSource(url);
});

ui.uploadBtn.addEventListener('click', () => {
    if (!ui.uploadBtn.disabled) ui.uploadInput.click();
});

ui.uploadInput.addEventListener('change', () => {
    const file = ui.uploadInput.files?.[0];
    if (file) uploadMedia(file);
});

for (const target of [ui.uploadBtn, ui.form]) {
    target.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer?.types?.includes('Files')) target.classList.add(target === ui.uploadBtn ? 'dragover' : 'drag');
    });
    target.addEventListener('dragleave', (e) => {
        if (e.currentTarget === e.target) target.classList.remove('dragover', 'drag');
    });
    target.addEventListener('drop', (e) => {
        e.preventDefault();
        target.classList.remove('dragover', 'drag');
        const file = e.dataTransfer?.files?.[0];
        if (file) uploadMedia(file);
    });
}

ui.navCollapseBtn.addEventListener('click', () => {
    setNavCollapsed(!state.navCollapsed);
    document.body.classList.toggle('nav-collapsed', state.navCollapsed);
});

function applyBrowserRoute() {
    const route = readerRouteFromHash(location.hash);
    if (route?.videoId === state.readerVideoId && route.tab === state.readerTab) return;
    if (route) showReader(route.videoId, route.tab);
    else {
        stopReadingProgressTracking({ flush: true });
        stopReaderChromeTracking();
        state.readerVideoId = null;
        state.readerTab = 'article';
        renderSidebar();
        renderMain();
    }
}

window.addEventListener('popstate', applyBrowserRoute);
window.addEventListener('pagehide', () => {
    stopReadingProgressTracking({ flush: true });
    stopReaderChromeTracking();
});

const initialRoute = readerRouteFromHash(location.hash);
state.readerVideoId = initialRoute?.videoId || null;
state.readerTab = initialRoute?.tab || 'article';
renderSidebar();
renderMain();
Promise.all([fetchChannels(), fetchLibrary()]);
connectSSE({
    api,
    onChannelChange,
    onChannelDeleted,
    onChannelError: (e) => {
        try { const d = JSON.parse(e.data); toast(`Error: ${d.error}`, 'error'); } catch {}
    },
    onVideoUpdate,
    onVideoDeleted,
});
