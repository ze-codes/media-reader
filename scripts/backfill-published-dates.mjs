import { getDb, setVideoPublishedAtIfMissing } from '../src/db/index.mjs';
import { detectVideoSource, listChannel, resolveVideo } from '../src/ingest/index.mjs';

const db = getDb();
const channels = db.prepare(`
    SELECT DISTINCT c.id, c.title, c.url
    FROM channels c
    JOIN videos v ON v.channel_id = c.id
    WHERE (v.published_at IS NULL OR trim(v.published_at) = '')
      AND v.url NOT LIKE '%youtube.com/shorts/%'
    ORDER BY c.title
`).all().filter(channel => detectVideoSource(channel.url) === 'youtube');

let updated = 0;
const failures = [];

function updateFromListing(result) {
    let count = 0;
    for (const video of result.videos) {
        if (setVideoPublishedAtIfMissing(video.id, video.publishedAt)) count++;
    }
    return count;
}

for (const channel of channels) {
    try {
        const result = await listChannel(channel.url);
        const channelUpdated = updateFromListing(result);

        updated += channelUpdated;
        console.log(`${channel.title}: ${channelUpdated} date(s) added`);
    } catch (error) {
        failures.push({ channel: channel.title, error: error.message });
        console.error(`${channel.title}: ${error.message}`);
    }
}

const missingVideos = db.prepare(`
    SELECT id, url
    FROM videos
    WHERE (published_at IS NULL OR trim(published_at) = '')
      AND url LIKE '%youtube.com/%'
      AND url NOT LIKE '%youtube.com/shorts/%'
    ORDER BY added_at DESC
`).all();

let individuallyChecked = 0;
for (const video of missingVideos) {
    try {
        const metadata = await resolveVideo(video.url);
        if (setVideoPublishedAtIfMissing(video.id, metadata.publishedAt)) updated++;
    } catch (error) {
        failures.push({ video: video.id, error: error.message });
    }
    individuallyChecked++;
    if (individuallyChecked % 10 === 0 || individuallyChecked === missingVideos.length) {
        console.log(`Individual metadata: ${individuallyChecked}/${missingVideos.length}`);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
}

const remaining = db.prepare(`
    SELECT COUNT(*) AS count
    FROM videos
    WHERE (published_at IS NULL OR trim(published_at) = '')
      AND url LIKE '%youtube.com/%'
      AND url NOT LIKE '%youtube.com/shorts/%'
`).get().count;

console.log(JSON.stringify({ updated, remaining, failures }, null, 2));
if (failures.length) process.exitCode = 1;
