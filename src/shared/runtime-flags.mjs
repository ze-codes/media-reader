function disabled(value) {
    return ['0', 'false', 'off', 'no'].includes(String(value || '').trim().toLowerCase());
}

function enabled(value) {
    return ['1', 'true', 'on', 'yes'].includes(String(value || '').trim().toLowerCase());
}

export function workerEnabled(env = process.env) {
    return !disabled(env.MEDIA_READER_WORKER_ENABLED);
}

export function maintenanceEnabled(env = process.env) {
    return enabled(env.MEDIA_READER_MAINTENANCE);
}

export function rejectMaintenanceMutation(req, res, next, env = process.env) {
    if (!maintenanceEnabled(env) || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return next();
    }
    return res.status(503).json({
        error: 'Media Reader is temporarily read-only for maintenance.',
        code: 'maintenance',
        retryable: true,
    });
}
