import { getChannel, getVideo, upsertChannel, upsertVideoQueued } from '../db/index.mjs';
import { CHANNEL_STATUSES, SSE_EVENTS } from '../domain/constants.mjs';
import { isYoutubeShortUrl, resolveVideo } from '../ingest/index.mjs';
import { log } from '../shared/log.mjs';

export async function resolveAndQueueSingleVideo(url, { broadcast = () => {} } = {}) {
    if (isYoutubeShortUrl(url)) throw new Error('YouTube Shorts are not imported.');
    log('info', 'api', `resolving video ${url}`);
    const info = await resolveVideo(url);
    if (!info.channelId) throw new Error('could not resolve channel id from video');

    const existing = getChannel(info.channelId);
    if (!existing) {
        upsertChannel({
            id: info.channelId,
            handle: info.channelHandle,
            title: info.channelTitle,
            url: info.channelUrl || info.url,
            status: CHANNEL_STATUSES.SINGLE,
        });
        broadcast(SSE_EVENTS.CHANNEL_ADDED, { id: info.channelId, title: info.channelTitle });
    }

    const inserted = upsertVideoQueued({
        id: info.id,
        channelId: info.channelId,
        title: info.title,
        publishedAt: info.publishedAt,
        durationSec: info.durationSec,
        url: info.url,
    });
    const existingVideo = inserted ? null : getVideo(info.id);
    const payload = {
        id: info.id,
        state: inserted ? 'queued' : 'exists',
        channelId: existingVideo?.channel_id || info.channelId,
        title: existingVideo?.title || info.title,
        existing_state: existingVideo?.state,
        transcript_source: existingVideo?.transcript_source,
        single: true,
    };
    broadcast(SSE_EVENTS.VIDEO_STATE, payload);

    if (inserted) {
        log('info', 'api', `video queued: ${info.title} (${info.id})`);
    } else {
        log('info', 'api', `video already exists: ${(existingVideo?.title || info.title)} (${info.id})`);
    }

    return { info, inserted, existingVideo, payload };
}
