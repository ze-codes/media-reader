import { getDb } from './db/index.mjs';
import { startServer, broadcastSSE } from './server/api.mjs';
import { workerLoop, resetInFlight, setBroadcaster } from './worker/worker.mjs';
import { log } from './shared/log.mjs';
import { workerEnabled } from './shared/runtime-flags.mjs';

async function main() {
    // Initialize DB (bootstraps schema on first run).
    getDb();
    log('info', 'main', 'database ready');

    const runWorker = workerEnabled();
    if (runWorker) {
        // Roll any interrupted work back to queued only when this process owns work.
        resetInFlight();
        setBroadcaster(broadcastSSE);
    }

    // Start HTTP server.
    const port = parseInt(process.env.PORT) || 8099;
    startServer(port);

    if (runWorker) {
        workerLoop().catch(err => {
            log('error', 'main', `worker loop crashed: ${err.message}`);
            process.exit(1);
        });
    } else {
        log('info', 'main', 'worker disabled by configuration');
    }

    log('info', 'main', 'media-reader up');
}

process.on('SIGINT', () => { log('info', 'main', 'shutting down'); process.exit(0); });
process.on('SIGTERM', () => { log('info', 'main', 'shutting down'); process.exit(0); });

main().catch(err => {
    console.error('fatal:', err);
    process.exit(1);
});
