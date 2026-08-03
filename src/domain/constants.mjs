export const SOURCES = Object.freeze({
    YOUTUBE: 'youtube',
    XIAOHONGSHU: 'xiaohongshu',
    UPLOAD: 'upload',
});

export const VIDEO_STATES = Object.freeze({
    QUEUED: 'queued',
    FETCHING: 'fetching',
    TRANSCRIBING: 'transcribing',
    WRITING: 'writing',
    DONE: 'done',
    ERROR: 'error',
});

export const ACTIVE_VIDEO_STATES = new Set([
    VIDEO_STATES.FETCHING,
    VIDEO_STATES.TRANSCRIBING,
    VIDEO_STATES.WRITING,
]);

export const CHANNEL_STATUSES = Object.freeze({
    LISTING: 'listing',
    READY: 'ready',
    SINGLE: 'single',
    ERROR: 'error',
});

export const TRANSCRIPT_SOURCES = Object.freeze({
    STORED: 'stored',
    CAPTIONS: 'captions',
    TRANSCRIPT_API: 'transcriptapi',
    WHISPER: 'whisper',
});

export const SSE_EVENTS = Object.freeze({
    CHANNEL_ADDED: 'channel:added',
    CHANNEL_READY: 'channel:ready',
    CHANNEL_DELETED: 'channel:deleted',
    CHANNEL_ERROR: 'channel:error',
    VIDEO_STATE: 'video:state',
    VIDEO_DONE: 'video:done',
    VIDEO_ERROR: 'video:error',
    VIDEO_DELETED: 'video:deleted',
});

export const YOUTUBE_COOKIE_BLOCKED_REASON = 'youtube_cookies_invalid';
export const YOUTUBE_AUDIO_BLOCKED_REASON = 'youtube_audio_auth_blocked';
