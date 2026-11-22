import { upsertChannel, upsertVideoQueued } from '../db/index.mjs';
import { CHANNEL_STATUSES, SSE_EVENTS, VIDEO_STATES } from '../domain/constants.mjs';
import {
    deleteUploadedMedia,
    LOCAL_UPLOADS_CHANNEL_ID,
    LOCAL_UPLOADS_CHANNEL_TITLE,
    LOCAL_UPLOADS_CHANNEL_URL,
    appendUploadChunk,
    finishChunkedUpload,
    parseMediaUploadRequest,
    startChunkedUpload,
    sweepIdleChunkedSessions,
    UPLOAD_SOURCE,
} from '../uploads/index.mjs';
import { log } from '../shared/log.mjs';

export function uploadStatePayload(upload) {
    return {
        id: upload.id,
        state: VIDEO_STATES.QUEUED,
        channelId: LOCAL_UPLOADS_CHANNEL_ID,
        title: upload.title,
        source_type: UPLOAD_SOURCE,
    };
}

export async function queueUploadedMedia(req, { broadcast = () => {} } = {}) {
    return queueStoredUpload(await parseMediaUploadRequest(req), { broadcast });
}

export { startChunkedUpload, appendUploadChunk, sweepIdleChunkedSessions };

export function queueChunkedUpload(uploadId, { broadcast = () => {} } = {}) {
    return queueStoredUpload(finishChunkedUpload(uploadId), { broadcast });
}

function queueStoredUpload(upload, { broadcast }) {
    try {
        upsertChannel({
            id: LOCAL_UPLOADS_CHANNEL_ID,
            handle: null,
            title: LOCAL_UPLOADS_CHANNEL_TITLE,
            url: LOCAL_UPLOADS_CHANNEL_URL,
            status: CHANNEL_STATUSES.READY,
        });

        const inserted = upsertVideoQueued({
            id: upload.id,
            channelId: LOCAL_UPLOADS_CHANNEL_ID,
            title: upload.title,
            publishedAt: null,
            durationSec: null,
            url: upload.url,
            sourceType: UPLOAD_SOURCE,
            originalFilename: upload.originalFilename,
            uploadedPath: upload.storedPath,
            mimeType: upload.mimeType,
            fileSizeBytes: upload.sizeBytes,
        });

        if (!inserted) {
            deleteUploadedMedia({
                source_type: UPLOAD_SOURCE,
                url: upload.url,
                uploaded_path: upload.storedPath,
            });
            const err = new Error('upload already exists; try again');
            err.status = 409;
            throw err;
        }

        log('info', 'api', `uploaded media queued: ${upload.originalFilename} (${upload.id})`);
        broadcast(SSE_EVENTS.CHANNEL_ADDED, {
            id: LOCAL_UPLOADS_CHANNEL_ID,
            title: LOCAL_UPLOADS_CHANNEL_TITLE,
            source_type: UPLOAD_SOURCE,
        });
        broadcast(SSE_EVENTS.VIDEO_STATE, uploadStatePayload(upload));

        return upload;
    } catch (err) {
        deleteUploadedMedia({
            source_type: UPLOAD_SOURCE,
            url: upload.url,
            uploaded_path: upload.storedPath,
        });
        throw err;
    }
}

export function uploadResponse(upload) {
    return {
        ok: true,
        channel: {
            id: LOCAL_UPLOADS_CHANNEL_ID,
            title: LOCAL_UPLOADS_CHANNEL_TITLE,
        },
        video: {
            id: upload.id,
            channelId: LOCAL_UPLOADS_CHANNEL_ID,
            title: upload.title,
            state: VIDEO_STATES.QUEUED,
            source_type: UPLOAD_SOURCE,
            original_filename: upload.originalFilename,
            file_size_bytes: upload.sizeBytes,
        },
    };
}
