import { describe, expect, test } from 'bun:test';
import { articleTransformStrategy, splitTranscriptByWords, transformTranscript } from '../src/llm/index.mjs';

describe('llm transcript transforms', () => {
    test('writes in the transcript language by default and in the requested language on every prompt', async () => {
        const prompts = [];
        const llm = async (systemPrompt) => {
            prompts.push(systemPrompt);
            const tldrOnly = systemPrompt.startsWith('You are consolidating');
            return { text: JSON.stringify(tldrOnly ? { tldr: '- t' } : { tldr: '- t', article: 'A.' }), usage: {} };
        };

        await transformTranscript({ title: 'T', channel: 'C', transcript: '今天我们谈论彩礼', llm });
        expect(prompts[0]).toContain('main language spoken in the transcript');
        expect(prompts[0]).not.toContain('{{LANGUAGE_INSTRUCTION}}');

        prompts.length = 0;
        const long = Array.from({ length: 6001 }, (_, index) => `word${index + 1}`).join(' ');
        await transformTranscript({ title: 'T', channel: 'C', transcript: long, language: 'zh', llm });
        expect(prompts.length).toBe(4); // three sections plus the TLDR merge
        for (const prompt of prompts) expect(prompt).toContain('Simplified Chinese');
    });

    test('converts normalized provider usage to article cost without inventing prices', async () => {
        const result = await transformTranscript({
            title: 'Portable Provider',
            channel: 'Test Channel',
            transcript: 'a useful transcript',
            llm: async () => ({
                text: JSON.stringify({ tldr: '- portable', article: 'Portable article.' }),
                provider: 'openai-compatible',
                model: 'owner/model',
                usage: {
                    inputTokens: 10,
                    outputTokens: 4,
                    totalTokens: 14,
                    costUsd: null,
                    estimated: true,
                },
                durationMs: 12,
            }),
        });

        expect(result.cost).toEqual({
            provider: 'openai-compatible',
            model: 'owner/model',
            costUsd: null,
            inputTokens: 10,
            outputTokens: 4,
            totalTokens: 14,
            durationMs: 12,
            estimated: true,
            estimateMethod: 'estimated: ceil(characters / 4)',
        });
    });

    test('keeps sectioned article cost unknown when any provider call omits monetary cost', async () => {
        const transcript = Array.from({ length: 6001 }, (_, index) => `word${index + 1}`).join(' ');

        const result = await transformTranscript({
            title: 'Unknown Section Costs',
            channel: 'Test Channel',
            transcript,
            llm: async systemPrompt => ({
                text: systemPrompt.includes('consolidating ordered TLDR notes')
                    ? JSON.stringify({ tldr: '- consolidated' })
                    : JSON.stringify({ tldr: '- section', article: '## Section\nArticle.' }),
                provider: 'openai-compatible',
                model: 'owner/model',
                usage: {
                    inputTokens: 10,
                    outputTokens: 5,
                    totalTokens: 15,
                    costUsd: null,
                    estimated: false,
                },
                durationMs: 2,
            }),
        });

        expect(result.cost).toMatchObject({
            costUsd: null,
            inputTokens: 40,
            outputTokens: 20,
            totalTokens: 60,
        });
    });

    test('does not echo invalid provider output from article parsing errors', async () => {
        const credentialLikeOutput = 'provider-echoed-sensitive-value invalid response';

        try {
            await transformTranscript({
                title: 'Bad Output',
                channel: 'Test Channel',
                transcript: 'a useful transcript',
                llm: async () => ({ text: credentialLikeOutput, cost: null }),
            });
            throw new Error('expected article parsing error');
        } catch (error) {
            expect(error.message).toContain('invalid JSON');
            expect(error.message).not.toContain(credentialLikeOutput);
            expect(error.message).not.toContain('provider-echoed-sensitive-value');
        }
    });

    test('splits transcripts into ordered word chunks', () => {
        const transcript = Array.from({ length: 13 }, (_, i) => `w${i + 1}`).join(' ');

        expect(splitTranscriptByWords(transcript, 5)).toEqual([
            'w1 w2 w3 w4 w5',
            'w6 w7 w8 w9 w10',
            'w11 w12 w13',
        ]);
    });

    test('keeps short transcripts on the direct article path', async () => {
        const calls = [];
        const result = await transformTranscript({
            title: 'Short Episode',
            channel: 'Test Channel',
            transcript: 'short transcript with enough words to transform',
            llm: async (systemPrompt, userPrompt) => {
                calls.push({ systemPrompt, userPrompt });
                return { text: JSON.stringify({ tldr: '- direct', article: 'direct article' }), cost: { costUsd: 1 } };
            },
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].userPrompt).toContain('Transcript:');
        expect(result).toMatchObject({ tldr: '- direct', article: 'direct article' });
    });

    test('routes transcripts by explicit word-count strategy', () => {
        expect(articleTransformStrategy(6000)).toBe('direct');
        expect(articleTransformStrategy(6001)).toBe('sectioned');
    });

    test('uses section articles instead of a full-transcript final pass for very long transcripts', async () => {
        const transcript = Array.from({ length: 24001 }, (_, i) => `word${i + 1}`).join(' ');
        const calls = [];

        const result = await transformTranscript({
            title: 'Very Long Episode',
            channel: 'Test Channel',
            transcript,
            llm: async (systemPrompt, userPrompt) => {
                calls.push({ systemPrompt, userPrompt });
                if (systemPrompt.includes('consolidating ordered TLDR notes')) {
                    expect(userPrompt).toContain('Ordered section TLDRs:');
                    return { text: JSON.stringify({ tldr: '- consolidated' }), cost: { costUsd: 5 } };
                }
                expect(userPrompt).toContain('Transcript slice:');
                expect(userPrompt).not.toContain('Full transcript:');
                return {
                    text: JSON.stringify({
                        tldr: `- slice ${calls.length}`,
                        article: `## Slice ${calls.length}\nArticle section ${calls.length}.`,
                    }),
                    cost: { costUsd: 1 },
                };
            },
        });

        expect(calls).toHaveLength(10);
        expect(calls.slice(0, 9).map(call => call.userPrompt.match(/Transcript slice: \d+ of 9/)?.[0])).toEqual([
            'Transcript slice: 1 of 9',
            'Transcript slice: 2 of 9',
            'Transcript slice: 3 of 9',
            'Transcript slice: 4 of 9',
            'Transcript slice: 5 of 9',
            'Transcript slice: 6 of 9',
            'Transcript slice: 7 of 9',
            'Transcript slice: 8 of 9',
            'Transcript slice: 9 of 9',
        ]);
        expect(result.tldr).toBe('- consolidated');
        expect(result.article).toContain('## Slice 1');
        expect(result.article).toContain('## Slice 9');
        expect(result.cost).toMatchObject({ costUsd: 14 });
    });

    test('retries section generation when a very long slice is not strict JSON', async () => {
        const transcript = Array.from({ length: 6001 }, (_, i) => `word${i + 1}`).join(' ');
        const calls = [];

        const result = await transformTranscript({
            title: 'Retry Episode',
            channel: 'Test Channel',
            transcript,
            llm: async (systemPrompt, userPrompt) => {
                calls.push({ systemPrompt, userPrompt });
                if (systemPrompt.includes('consolidating ordered TLDR notes')) {
                    return { text: JSON.stringify({ tldr: '- consolidated' }), cost: { costUsd: 1 } };
                }
                if (calls.length === 1) {
                    return { text: 'This is not JSON.', cost: { costUsd: 1 } };
                }
                return {
                    text: JSON.stringify({ tldr: '- recovered', article: '## Recovered\nSection article.' }),
                    cost: { costUsd: 2 },
                };
            },
        });

        expect(calls).toHaveLength(5);
        expect(calls[1].userPrompt).toContain('Your previous response was invalid');
        expect(result.tldr).toBe('- consolidated');
        expect(result.article).toContain('## Recovered');
        expect(result.cost).toMatchObject({ costUsd: 7 });
    });

    test('preserves malformed section prose after strict JSON retry fails', async () => {
        const transcript = Array.from({ length: 6001 }, (_, i) => `word${i + 1}`).join(' ');
        const prose = `${'Preserved prose section. '.repeat(30)}\\"}`;
        const calls = [];

        const result = await transformTranscript({
            title: 'Fallback Episode',
            channel: 'Test Channel',
            transcript,
            llm: async (systemPrompt, userPrompt) => {
                calls.push({ systemPrompt, userPrompt });
                if (systemPrompt.includes('consolidating ordered TLDR notes')) {
                    return { text: JSON.stringify({ tldr: '- consolidated' }), cost: { costUsd: 1 } };
                }
                if (calls.length <= 2) {
                    return { text: prose, cost: { costUsd: 1 } };
                }
                return {
                    text: JSON.stringify({ tldr: '- ok', article: '## OK\nSection article.' }),
                    cost: { costUsd: 2 },
                };
            },
        });

        expect(calls).toHaveLength(5);
        expect(result.tldr).toBe('- consolidated');
        expect(result.article).toContain('Preserved prose section.');
        expect(result.article).not.toContain('\\"}');
    });

});
