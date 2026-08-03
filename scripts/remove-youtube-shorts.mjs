import { deleteVideo, getDb } from '../src/db/index.mjs';
import { clearVideoCache } from '../src/ingest/index.mjs';

const videos = getDb().prepare(`
    SELECT id
    FROM videos
    WHERE url LIKE '%youtube.com/shorts/%'
`).all();

let removed = 0;
for (const video of videos) {
    if (!deleteVideo(video.id)) continue;
    clearVideoCache(video.id);
    removed++;
}

console.log(JSON.stringify({ removed }));
