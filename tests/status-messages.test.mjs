import { describe, expect, test } from 'bun:test';
import { transcriptSourceLabel, videoStatusMessage } from '../public/status-messages.mjs';

describe('video status messages', () => {
    test('reports finished and failed language versions, and stays quiet while they are written', () => {
        expect(videoStatusMessage('video:done', { title: 'Talk', version: 'zh' }))
            .toEqual({ kind: 'success', message: '中文 version ready: Talk' });
        expect(videoStatusMessage('video:error', { title: 'Talk', version: 'en', error: 'timed out' }))
            .toEqual({ kind: 'error', message: "Couldn't write the English version of Talk: timed out" });
        expect(videoStatusMessage('video:state', { title: 'Talk', version: 'zh', state: 'writing' })).toBeNull();
    });

    test('labels transcript sources for users', () => {
        expect(transcriptSourceLabel('captions')).toBe('YouTube captions');
        expect(transcriptSourceLabel('transcriptapi')).toBe('TranscriptAPI');
        expect(transcriptSourceLabel('whisper')).toBe('Whisper transcription');
        expect(transcriptSourceLabel('manual')).toBe('manual');
    });

    test('reports queued and caption-backed generation states', () => {
        expect(videoStatusMessage('video:state', {
            id: 'abc',
            title: 'Demo video',
            state: 'queued',
        })).toEqual({
            kind: 'info',
            message: 'Video URL accepted; resolved and queued: Demo video',
        });

        expect(videoStatusMessage('video:state', {
            title: 'Demo video',
            state: 'writing',
            transcript_source: 'transcriptapi',
        })).toEqual({
            kind: 'info',
            message: 'TranscriptAPI transcript found; generating article for Demo video...',
        });

        expect(videoStatusMessage('video:state', {
            title: 'Demo video',
            state: 'writing',
            transcript_source: 'captions',
        })).toEqual({
            kind: 'info',
            message: 'YouTube captions found; generating article for Demo video...',
        });
    });

    test('reports existing videos without saying they were queued', () => {
        expect(videoStatusMessage('video:state', {
            id: 'abc',
            title: 'Demo video',
            state: 'exists',
            existing_state: 'done',
        })).toEqual({
            kind: 'info',
            message: 'Already in Media Reader (done): Demo video',
        });
    });

    test('reports whisper fallback and successful completion', () => {
        expect(videoStatusMessage('video:state', {
            title: 'Demo video',
            state: 'transcribing',
        })).toEqual({
            kind: 'info',
            message: 'No usable captions found; transcribing audio with Whisper for Demo video...',
        });

        expect(videoStatusMessage('video:done', {
            title: 'Demo video',
            transcript_source: 'whisper',
        })).toEqual({
            kind: 'success',
            message: 'Article ready from Whisper transcription: Demo video',
        });
    });

    test('distinguishes uploaded file progress from URL progress', () => {
        expect(videoStatusMessage('video:state', {
            title: 'Meeting clip',
            state: 'queued',
            source_type: 'upload',
        })).toEqual({
            kind: 'info',
            message: 'Uploaded file accepted and queued: Meeting clip',
        });

        expect(videoStatusMessage('video:state', {
            title: 'Meeting clip',
            state: 'fetching',
            source_type: 'upload',
        })).toEqual({
            kind: 'info',
            message: 'Preparing uploaded file for Meeting clip...',
        });

        expect(videoStatusMessage('video:state', {
            title: 'Meeting clip',
            state: 'transcribing',
            source_type: 'upload',
        })).toEqual({
            kind: 'info',
            message: 'Transcribing uploaded file with Whisper for Meeting clip...',
        });

        expect(videoStatusMessage('video:state', {
            title: 'Meeting clip',
            state: 'writing',
            source_type: 'upload',
            transcript_source: 'whisper',
        })).toEqual({
            kind: 'info',
            message: 'Uploaded file transcription complete; generating article for Meeting clip...',
        });

        expect(videoStatusMessage('video:done', {
            title: 'Meeting clip',
            source_type: 'upload',
            transcript_source: 'whisper',
        })).toEqual({
            kind: 'success',
            message: 'Article ready from uploaded file transcription: Meeting clip',
        });
    });

    test('preserves backend error text', () => {
        expect(videoStatusMessage('video:error', {
            title: 'Demo video',
            error: 'transcript too short',
        })).toEqual({
            kind: 'error',
            message: 'Failed: Demo video - transcript too short',
        });
    });
});
