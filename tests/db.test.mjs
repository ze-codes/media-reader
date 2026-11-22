import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const tmp = mkdtempSync(join(tmpdir(), 'media-reader-db-test-'));
process.env.MEDIA_READER_DB_PATH = join(tmp, 'test.db');

const {
    getDb,
    getVideo,
    getTranscriptSegments,
    libraryCounts,
    listLibraryVideos,
    listVideosForChannel,
    setVideoPublishedAtIfMissing,
    setVideoReadingProgress,
    setVideoRead,
    setVideoState,
    replaceVideoTranscript,
    deleteChannel,
    deleteVideo,
    upsertChannel,
    upsertVideoQueued,
    listArticleVersions,
    nextQueuedArticleVersion,
    requestArticleVersion,
    setArticleVersion,
} = await import('../src/db/index.mjs');

afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
});

describe('video queue persistence', () => {
    test('reports whether a single video insert was new or already present', () => {
        upsertChannel({
            id: 'UCdemo',
            title: 'Demo channel',
            url: 'https://example.com/channel',
            status: 'single',
        });

        expect(upsertVideoQueued({
            id: 'qVFEcg-RIAk',
            channelId: 'UCdemo',
            title: 'Original title',
            url: 'https://www.youtube.com/watch?v=qVFEcg-RIAk',
        })).toBe(true);

        expect(upsertVideoQueued({
            id: 'qVFEcg-RIAk',
            channelId: 'UCdemo',
            title: 'Duplicate title',
            url: 'https://www.youtube.com/watch?v=qVFEcg-RIAk',
        })).toBe(false);

        expect(getVideo('qVFEcg-RIAk').title).toBe('Original title');
    });

    test('persists local upload metadata with queued jobs', () => {
        upsertChannel({
            id: 'local:uploads',
            title: 'Local uploads',
            url: 'upload://local',
            status: 'ready',
        });

        expect(upsertVideoQueued({
            id: 'upload:demo',
            channelId: 'local:uploads',
            title: 'Demo clip',
            url: 'upload://demo/demo.wav',
            sourceType: 'upload',
            originalFilename: 'demo.wav',
            uploadedPath: join(tmp, 'demo.wav'),
            mimeType: 'audio/wav',
            fileSizeBytes: 1234,
        })).toBe(true);

        const video = getVideo('upload:demo');
        expect(video.source_type).toBe('upload');
        expect(video.original_filename).toBe('demo.wav');
        expect(video.uploaded_path).toBe(join(tmp, 'demo.wav'));
        expect(video.file_size_bytes).toBe(1234);

        const listed = listVideosForChannel('local:uploads').find(v => v.id === 'upload:demo');
        expect(listed.source_type).toBe('upload');
        expect(listed.original_filename).toBe('demo.wav');
        expect(listed.uploaded_path).toBeUndefined();
    });

    test('backfills a publication date without replacing an existing date', () => {
        expect(setVideoPublishedAtIfMissing('qVFEcg-RIAk', '2026-07-12')).toBe(true);
        expect(setVideoPublishedAtIfMissing('qVFEcg-RIAk', '2026-07-13')).toBe(false);
        expect(getVideo('qVFEcg-RIAk').published_at).toBe('2026-07-12');
    });

    test('returns paginated library cards without article or transcript bodies', () => {
        setVideoState('qVFEcg-RIAk', 'done', {
            transcript: 'private transcript body',
            tldr: '- concise preview',
            article: 'full article body',
        });
        setVideoState('upload:demo', 'error', { error: 'demo failure' });

        const firstPage = listLibraryVideos({ limit: 1, filter: 'all' });
        expect(firstPage.total).toBe(2);
        expect(firstPage.videos).toHaveLength(1);
        expect(firstPage.videos[0].transcript).toBeUndefined();
        expect(firstPage.videos[0].segments).toBeUndefined();
        expect(firstPage.videos[0].transcript_segments).toBeUndefined();
        expect(firstPage.videos[0].article).toBeUndefined();

        const ready = listLibraryVideos({ filter: 'done' });
        expect(ready.total).toBe(1);
        expect(ready.videos[0].tldr).toBe('- concise preview');
    });

    test('persists read state and reports aggregate library counts', () => {
        expect(libraryCounts()).toMatchObject({
            all_count: 2,
            unread_count: 1,
            done_count: 1,
            error_count: 1,
        });

        expect(setVideoRead('qVFEcg-RIAk', true)).toBe(true);
        expect(getVideo('qVFEcg-RIAk').read_at).toBeTruthy();
        expect(libraryCounts().unread_count).toBe(0);
        expect(listLibraryVideos({ filter: 'unread' }).total).toBe(0);

        expect(setVideoRead('qVFEcg-RIAk', false)).toBe(true);
        expect(getVideo('qVFEcg-RIAk').read_at).toBeNull();
    });

    test('persists normalized article reading progress', () => {
        expect(setVideoReadingProgress('qVFEcg-RIAk', 0.42)).toBe(true);
        expect(getVideo('qVFEcg-RIAk').reading_progress).toBeCloseTo(0.42);
        expect(setVideoReadingProgress('qVFEcg-RIAk', 2)).toBe(true);
        expect(getVideo('qVFEcg-RIAk').reading_progress).toBe(1);
    });

    test('atomically replaces transcript text, source, and ordered segments', () => {
        replaceVideoTranscript('qVFEcg-RIAk', {
            text: 'first replacement',
            source: 'captions',
            segments: [
                { startMs: 500, endMs: 900, text: 'later source cue' },
                { startMs: 0, endMs: 400, text: 'earlier source cue' },
            ],
        });
        expect(getVideo('qVFEcg-RIAk')).toMatchObject({
            transcript: 'first replacement',
            transcript_source: 'captions',
        });
        expect(getTranscriptSegments('qVFEcg-RIAk')).toEqual([
            { startMs: 500, endMs: 900, text: 'later source cue', source: 'captions' },
            { startMs: 0, endMs: 400, text: 'earlier source cue', source: 'captions' },
        ]);

        replaceVideoTranscript('qVFEcg-RIAk', {
            text: 'untimed replacement',
            source: 'whisper',
            segments: [],
        });
        expect(getVideo('qVFEcg-RIAk')).toMatchObject({
            transcript: 'untimed replacement',
            transcript_source: 'whisper',
        });
        expect(getTranscriptSegments('qVFEcg-RIAk')).toEqual([]);
    });

    test('legacy rows return no transcript segments', () => {
        expect(getTranscriptSegments('upload:demo')).toEqual([]);
    });

    test('video and channel deletion cascade transcript segments', () => {
        upsertChannel({ id: 'UCcascade', title: 'Cascade', url: 'https://example.com/cascade', status: 'ready' });
        for (const id of ['cascade-one', 'cascade-two']) {
            upsertVideoQueued({ id, channelId: 'UCcascade', title: id, url: `https://example.com/${id}` });
            replaceVideoTranscript(id, {
                text: `${id} transcript`,
                source: 'captions',
                segments: [{ startMs: 0, endMs: 100, text: id }],
            });
        }

        expect(deleteVideo('cascade-one')).toBeTruthy();
        expect(getDb().prepare('SELECT COUNT(*) AS count FROM transcript_segments WHERE video_id = ?').get('cascade-one').count).toBe(0);
        expect(deleteChannel('UCcascade')).toBeTruthy();
        expect(getDb().prepare('SELECT COUNT(*) AS count FROM transcript_segments WHERE video_id = ?').get('cascade-two').count).toBe(0);
    });
});

describe('article versions in other languages', () => {
    test('queue once, keep finished text, retry only failures, wait for the video, go with it', () => {
        upsertChannel({ id: 'UClang', title: 'Lang channel', url: 'https://example.com/lang', status: 'single' });
        upsertVideoQueued({ id: 'lang-video', channelId: 'UClang', title: 'Talk', url: 'https://www.youtube.com/watch?v=langvideo1' });

        // Asked for while the video is still processing: queued, but not picked yet.
        expect(requestArticleVersion('lang-video', 'zh').state).toBe('queued');
        expect(nextQueuedArticleVersion()).toBeNull();

        setVideoState('lang-video', 'done', { article: 'An article.', tldr: '- t', article_language: 'en' });
        expect(nextQueuedArticleVersion()).toMatchObject({ video_id: 'lang-video', language: 'zh' });

        setArticleVersion('lang-video', 'zh', { state: 'done', tldr: '- 中', article: '中文文章。' });
        expect(requestArticleVersion('lang-video', 'zh')).toMatchObject({ state: 'done', article: '中文文章。' });
        expect(nextQueuedArticleVersion()).toBeNull();

        setArticleVersion('lang-video', 'zh', { state: 'error', error: 'timed out' });
        expect(requestArticleVersion('lang-video', 'zh')).toMatchObject({ state: 'queued', error: null });

        const listed = listLibraryVideos({ query: 'Talk' }).videos.find(video => video.id === 'lang-video');
        expect(JSON.parse(listed.version_states)).toEqual({ zh: 'queued' });
        expect(listed.article_language).toBe('en');

        deleteVideo('lang-video');
        expect(listArticleVersions('lang-video')).toEqual([]);
    });
});
