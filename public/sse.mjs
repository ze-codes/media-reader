export function connectSSE({
    api,
    onChannelChange,
    onChannelDeleted,
    onChannelError,
    onVideoUpdate,
    onVideoDeleted,
}) {
    const es = new EventSource(api('/stream'));
    es.addEventListener('channel:added', onChannelChange);
    es.addEventListener('channel:ready', onChannelChange);
    es.addEventListener('channel:deleted', onChannelDeleted);
    es.addEventListener('channel:error', onChannelError);
    es.addEventListener('video:state', onVideoUpdate);
    es.addEventListener('video:done', onVideoUpdate);
    es.addEventListener('video:error', onVideoUpdate);
    es.addEventListener('video:deleted', onVideoDeleted);
    es.onerror = () => {
        es.close();
        setTimeout(() => connectSSE({
            api,
            onChannelChange,
            onChannelDeleted,
            onChannelError,
            onVideoUpdate,
            onVideoDeleted,
        }), 3000);
    };
    return es;
}
