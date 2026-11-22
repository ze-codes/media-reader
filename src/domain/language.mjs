// Languages an article can be written in, labelled as the reader shows them.
export const LANGUAGE_LABELS = Object.freeze({ en: 'English', zh: '中文' });

// Chinese characters against Latin words; a Chinese character is roughly one word.
// shortcut: only tells Chinese from English, the two languages the reader offers; add a detector for others.
export function guessLanguage(text) {
    const value = String(text || '');
    const cjk = (value.match(/[\u4e00-\u9fff]/g) || []).length;
    const latinWords = (value.match(/[A-Za-z]+/g) || []).length;
    return cjk > latinWords ? 'zh' : 'en';
}
