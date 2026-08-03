import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { CACHE_DIR } from '../shared/paths.mjs';

export function videoCacheDir(videoId) {
    const dir = join(CACHE_DIR, videoId);
    mkdirSync(dir, { recursive: true });
    return dir;
}

export function clearVideoCache(videoId) {
    const dir = join(CACHE_DIR, videoId);
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
