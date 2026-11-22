const SOURCE_LABELS = {
    captions: 'YouTube captions',
    transcriptapi: 'TranscriptAPI',
    whisper: 'Whisper transcription',
};

// Same labels as src/domain/language.mjs; the browser cannot import from src/.
export const LANGUAGE_LABELS = Object.freeze({ en: 'English', zh: '中文' });

export function transcriptSourceLabel(source) {
    return SOURCE_LABELS[source] || source || '';
}

function videoLabel(data = {}) {
    return data.title || data.id || 'video';
}

function isUpload(data = {}) {
    return data.source_type === 'upload' || data.upload === true;
}

export function videoStatusMessage(eventType, data = {}) {
    const label = videoLabel(data);
    const source = transcriptSourceLabel(data.transcript_source);
    const upload = isUpload(data);

    if (data.version) {
        const language = LANGUAGE_LABELS[data.version] || data.version;
        if (eventType === 'video:done') return { kind: 'success', message: `${language} version ready: ${label}` };
        if (eventType === 'video:error') {
            return { kind: 'error', message: `Couldn't write the ${language} version of ${label}: ${data.error || 'unknown error'}` };
        }
        return null;
    }

    if (eventType === 'video:error') {
        const error = data.error || 'unknown error';
        return { kind: 'error', message: `Failed: ${label} - ${error}` };
    }

    if (eventType === 'video:done') {
        if (upload) {
            return { kind: 'success', message: `Article ready from uploaded file transcription: ${label}` };
        }
        const suffix = source ? ` from ${source}` : '';
        return { kind: 'success', message: `Article ready${suffix}: ${label}` };
    }

    if (eventType !== 'video:state') return null;

    if (data.state === 'queued') {
        if (upload) return { kind: 'info', message: `Uploaded file accepted and queued: ${label}` };
        return { kind: 'info', message: `Video URL accepted; resolved and queued: ${label}` };
    }
    if (data.state === 'exists') {
        const existingState = data.existing_state ? ` (${data.existing_state})` : '';
        return { kind: 'info', message: `Already in Media Reader${existingState}: ${label}` };
    }
    if (data.state === 'fetching') {
        if (upload) return { kind: 'info', message: `Preparing uploaded file for ${label}...` };
        return { kind: 'info', message: `Checking YouTube captions for ${label}...` };
    }
    if (data.state === 'transcribing') {
        if (upload) return { kind: 'info', message: `Transcribing uploaded file with Whisper for ${label}...` };
        return { kind: 'info', message: `No usable captions found; transcribing audio with Whisper for ${label}...` };
    }
    if (data.state === 'writing') {
        if (upload) {
            return { kind: 'info', message: `Uploaded file transcription complete; generating article for ${label}...` };
        }
        if (data.transcript_source === 'captions') {
            return { kind: 'info', message: `YouTube captions found; generating article for ${label}...` };
        }
        if (data.transcript_source === 'transcriptapi') {
            return { kind: 'info', message: `TranscriptAPI transcript found; generating article for ${label}...` };
        }
        if (data.transcript_source === 'whisper') {
            return { kind: 'info', message: `Whisper transcription complete; generating article for ${label}...` };
        }
        return { kind: 'info', message: `Generating article for ${label}...` };
    }

    return null;
}
