import { describe, expect, test } from 'bun:test';
import {
    maintenanceEnabled,
    rejectMaintenanceMutation,
    workerEnabled,
} from '../src/shared/runtime-flags.mjs';

describe('runtime operational flags', () => {
    test('runs the worker and allows writes by default', () => {
        expect(workerEnabled({})).toBe(true);
        expect(maintenanceEnabled({})).toBe(false);
    });

    test('accepts explicit worker-disable and maintenance-enable values', () => {
        expect(workerEnabled({ MEDIA_READER_WORKER_ENABLED: 'false' })).toBe(false);
        expect(maintenanceEnabled({ MEDIA_READER_MAINTENANCE: 'yes' })).toBe(true);
    });

    test('maintenance rejects mutations but permits reads', () => {
        const response = {
            statusCode: null,
            body: null,
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; },
        };
        let nextCalls = 0;
        const next = () => { nextCalls += 1; };
        const env = { MEDIA_READER_MAINTENANCE: '1' };

        rejectMaintenanceMutation({ method: 'POST' }, response, next, env);
        expect(response.statusCode).toBe(503);
        expect(response.body).toMatchObject({ code: 'maintenance', retryable: true });
        expect(nextCalls).toBe(0);

        rejectMaintenanceMutation({ method: 'GET' }, response, next, env);
        expect(nextCalls).toBe(1);
    });
});
