export const READER_CHROME_DELTA = 8;
export const READER_CHROME_TOP = 48;

export function nextReaderChromeState(state, { y, mobile }) {
    const nextY = Math.max(0, Number(y) || 0);
    if (!mobile || nextY <= READER_CHROME_TOP) return { hidden: false, lastY: nextY };
    const delta = nextY - state.lastY;
    if (Math.abs(delta) < READER_CHROME_DELTA) return state;
    return { hidden: delta > 0, lastY: nextY };
}
