import { logEvent } from '../db/index.mjs';

export function log(level, component, message, data = null) {
    const line = `[${level}] [${component}] ${message}${data ? ' ' + JSON.stringify(data) : ''}`;
    console.log(line);
    try {
        logEvent(level, `[${component}] ${message}`, {
            videoId: data?.videoId || null,
            channelId: data?.channelId || null,
        });
    } catch {}
}
