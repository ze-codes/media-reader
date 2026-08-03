import { YOUTUBE_AUDIO_BLOCKED_REASON } from '../domain/constants.mjs';
import { detectVideoSource } from '../ingest/index.mjs';

const AUDIO_BLOCKED_MESSAGE = 'YouTube audio download is blocked by authentication/bot checks.';

function hasAudioFallbackBlock(video) {
    return String(video?.error || '').includes(AUDIO_BLOCKED_MESSAGE);
}

export function workerStatusForVideos(videos) {
    const queuedYoutube = videos.filter(v => (
        v.state === 'queued' && detectVideoSource(v.url) === 'youtube'
    )).length;
    return {
        youtube_paused: false,
        queued_youtube: queuedYoutube,
        reason: null,
        message: null,
    };
}

export function enrichVideoStatus(video, workerStatus) {
    const safe = publicVideo(video);
    if (
        safe.state === 'error' &&
        detectVideoSource(safe.url) === 'youtube' &&
        hasAudioFallbackBlock(safe)
    ) {
        return {
            ...safe,
            blocked_reason: YOUTUBE_AUDIO_BLOCKED_REASON,
            blocked_message: safe.error,
        };
    }
    return safe;
}

export function publicVideo(video, {
    includeTranscript = false,
    includeSegments = false,
    segments = [],
} = {}) {
    if (!video) return video;
    const {
        uploaded_path,
        transcript,
        segments: attachedSegments,
        transcript_segments,
        ...safe
    } = video;
    if (includeTranscript) safe.transcript = transcript;
    if (includeSegments) safe.segments = segments;
    return safe;
}
