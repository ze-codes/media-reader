import { getDb } from './db/index.mjs';
import { startServer, broadcastSSE } from './server/api.mjs';
import { workerLoop, resetInFlight, setBroadcaster } from './worker/worker.mjs';
import { log } from './shared/log.mjs';

async function main() {
    // Initialize DB (bootstraps schema on first run).
    getDb();
    log('info', 'main', 'database ready');

    // Roll any in-flight jobs back to queued.
    resetInFlight();

    // Wire the worker's broadcaster to the SSE fan-out.
    setBroadcaster(broadcastSSE);

    // Start HTTP server.
    const port = parseInt(process.env.PORT) || 8099;
    startServer(port);

    // Kick off the worker loop — runs forever.
    workerLoop().catch(err => {
        log('error', 'main', `worker loop crashed: ${err.message}`);
        process.exit(1);
    });

    log('info', 'main', 'media-reader up');
}

process.on('SIGINT', () => { log('info', 'main', 'shutting down'); process.exit(0); });
process.on('SIGTERM', () => { log('info', 'main', 'shutting down'); process.exit(0); });

main().catch(err => {
    console.error('fatal:', err);
    process.exit(1);
});
