import {
    setChannelStatus,
    setVideoPublishedAtIfMissing,
    upsertChannel,
    upsertVideoQueued,
} from '../db/index.mjs';
import { CHANNEL_STATUSES, SSE_EVENTS } from '../domain/constants.mjs';
import { isSingleVideoUrl, listChannel } from '../ingest/index.mjs';
import { log } from '../shared/log.mjs';
import { resolveAndQueueSingleVideo } from './video-submissions.mjs';

export async function importChannelOrSingleVideo(url, { broadcast = () => {} } = {}) {
    if (isSingleVideoUrl(url)) {
        log('info', 'api', `single video submitted through channel endpoint ${url}`);
        return {
            type: 'video',
            result: await resolveAndQueueSingleVideo(url, { broadcast }),
        };
    }

    log('info', 'api', `listing channel ${url}`);
    const info = await listChannel(url);
    if (!info.channelId) throw new Error('could not resolve channel id');

    upsertChannel({
        id: info.channelId,
        handle: info.channelHandle,
        title: info.channelTitle,
        url,
        status: CHANNEL_STATUSES.LISTING,
    });
    broadcast(SSE_EVENTS.CHANNEL_ADDED, { id: info.channelId, title: info.channelTitle });

    let inserted = 0;
    for (const video of info.videos) {
        const wasInserted = upsertVideoQueued({
            id: video.id,
            channelId: info.channelId,
            title: video.title,
            publishedAt: video.publishedAt,
            durationSec: video.durationSec,
            url: video.url,
        });
        if (wasInserted) inserted++;
        else setVideoPublishedAtIfMissing(video.id, video.publishedAt);
    }

    setChannelStatus(info.channelId, CHANNEL_STATUSES.READY, info.videos.length);
    broadcast(SSE_EVENTS.CHANNEL_READY, {
        id: info.channelId,
        videoCount: info.videos.length,
        inserted,
    });
    log('info', 'api', `channel ready: ${info.channelTitle} (${info.videos.length} videos)`);

    return { type: 'channel', info, inserted };
}
