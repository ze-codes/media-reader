export const state = {
    channels: [],
    libraryVideos: [],
    libraryCounts: {
        all: 0,
        unread: 0,
        processing: 0,
        done: 0,
        error: 0,
    },
    libraryTotal: 0,
    libraryOffset: 0,
    libraryLimit: 50,
    libraryHasMore: false,
    loadingChannels: true,
    loadingLibrary: true,
    loadingMore: false,
    libraryRequestId: 0,
    activeFilter: localStorage.getItem('mr_filter') || 'all',
    searchQuery: '',
    sortOrder: localStorage.getItem('mr_sort') || 'newest',
    readerVideoId: null,
    readerTab: 'article',
    navCollapsed: localStorage.getItem('mr_nav') === 'collapsed',
    navOpen: false,
    trackedVideoIds: new Set(),
    seenVideoToastKeys: new Set(),
};

export const fullCache = new Map();

export function setActiveFilter(filter) {
    state.activeFilter = filter || 'all';
    localStorage.setItem('mr_filter', state.activeFilter);
}

export function setSortOrder(sortOrder) {
    state.sortOrder = sortOrder === 'oldest' ? 'oldest' : 'newest';
    localStorage.setItem('mr_sort', state.sortOrder);
}

export function setNavCollapsed(collapsed) {
    state.navCollapsed = Boolean(collapsed);
    localStorage.setItem('mr_nav', state.navCollapsed ? 'collapsed' : 'open');
}
