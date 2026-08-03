import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = join(__dirname, '..', '..');
export const PUBLIC_DIR = join(APP_ROOT, 'public');

export function dataDir() {
    return process.env.MEDIA_READER_DATA_DIR || join(APP_ROOT, 'data');
}

export function dbPath() {
    return process.env.MEDIA_READER_DB_PATH || join(dataDir(), 'media-reader.db');
}

export function cacheDir() {
    return join(dataDir(), 'cache');
}

export function uploadDir() {
    return join(dataDir(), 'uploads');
}

export const DATA_DIR = dataDir();
export const CACHE_DIR = cacheDir();
export const UPLOAD_DIR = uploadDir();
