import { describe, expect, it, vi } from 'vitest';
import { buildDateFinalSummaryMessages, finishDateStoryWithSummary, writeDateFinalSummary } from './dateStoryFinish';
import { DB } from './db';
import { MemoryNodeDB } from './memoryPalace/db';
import type { CharacterProfile, DateStory, Message } from '../types';

const api = { baseUrl: 'https://x.test/v1', apiKey: 'k', model: 'm' };
let nextId = 5000;
const msg = (storyId: string, role: 'user' | 'assistant', content: string): Message =>
    ({ id: nextId++, charId: 'cf', role, type: 'text', content, timestamp: nextId * 1000, metadata: { source: 'date', dateStoryId: storyId } } as Message);
const reply = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const char = (over: Partial<CharacterProfile> = {}) => ({ id: 'cf', name: '凱恩', ...over } as CharacterProfile);

/** 假模型：總結請求回「段N」，整場回顧回「整場」；記下送了什麼 */
const fakeModel = (seen: any[]) => vi.fn(async (url: any, init: any) => {
    if (String(url).includes('/embeddings')) return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3, 0.4] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const body = JSON.parse(init.body);
    seen.push(body);
    if (String(body.messages[1]?.content || '').startsWith('以下是這場故事的分段總結')) return reply('整場回顧');
    if (String(body.messages[0]?.content || '').includes('記錄者')) return reply(`段${seen.length}`);
    return new Response('no', { status: 503 }); // 建鏈的副 API：失敗也不影響
}) as unknown as typeof fetch;

describe('整場總結', () => {
    it('提示詞帶各段總結和用戶的文風', () => {
        const [sys, user] = buildDateFinalSummaryMessages({ charName: '凱恩', userName: '小雨', scenario: '雨夜', summaries: ['一', '二'], style: '第一人稱' });
        expect(sys.content).toContain('雨夜');
        expect(sys.content).toContain('第一人稱');
        expect(user.content).toContain('（第 1 段）\n一');
        expect(user.content).toContain('（第 2 段）\n二');
    });

    it('先總結尾巴，再把各段收成整場回顧；只有一段就直接用', async () => {
        const seen: any[] = [];
        const s1: DateStory = { id: 'fin1', charId: 'cf', status: 'ongoing', createdAt: 1, updatedAt: 1 };
        await DB.saveDateStory(s1);
        const one = [msg('fin1', 'assistant', '開場'), msg('fin1', 'user', '「嗨」')];
        const single = await writeDateFinalSummary({ char: char(), story: s1, userName: '小雨', api, messages: one, fetchImpl: fakeModel(seen) });
        expect(single?.finalSummary?.text).toBe('段1');
        expect(seen).toHaveLength(1);

        const s2: DateStory = { id: 'fin2', charId: 'cf', status: 'ongoing', createdAt: 1, updatedAt: 1, summaries: [{ id: 'a', text: '前面那段', fromMessageId: 1, toMessageId: 2, messageCount: 2, createdAt: 1, kind: 'auto' }], summarizedThroughId: 2 };
        await DB.saveDateStory(s2);
        const tail = [msg('fin2', 'assistant', '後來的事')];
        const seen2: any[] = [];
        const both = await writeDateFinalSummary({ char: char(), story: s2, userName: '小雨', api, messages: tail, fetchImpl: fakeModel(seen2) });
        expect(seen2).toHaveLength(2);
        expect(String(seen2[1].messages[1].content)).toContain('前面那段');
        expect(both?.finalSummary?.text).toBe('整場回顧');
        expect(both?.summaries).toHaveLength(2);
        expect(both?.status).toBe('ongoing');
    });

    it('完結並總結：標成已完結、照設定送宮殿（手動就不送）', async () => {
        const seen: any[] = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = fakeModel(seen);
        try {
            const s: DateStory = { id: 'fin3', charId: 'cf', status: 'ongoing', createdAt: 1, updatedAt: 1, title: '雨夜書店' };
            await DB.saveDateStory(s);
            const list = [msg('fin3', 'assistant', '開場'), msg('fin3', 'user', '「再見」')];
            const palace = { embedding: { baseUrl: 'https://e.test/v1', apiKey: 'k', model: 'emb', dimensions: 4 }, llm: api };
            const done = await finishDateStoryWithSummary({ char: char({ memoryPalaceEnabled: true }), story: s, userName: '小雨', api, messages: list, palace });
            expect(done.charPatch).toEqual({ activeDateStoryId: undefined, savedDateState: undefined });
            expect(done.story.status).toBe('completed');
            expect(done.palace).toBe('stored');
            expect(done.story.finalSummary?.palaceAt).toBeGreaterThan(0);
            const nodes = await MemoryNodeDB.getByCharId('cf');
            expect(nodes.map(n => [n.room, n.tags.includes('完結'), n.tags.includes('雨夜書店')])).toEqual([['bedroom', true, true]]);

            const m: DateStory = { id: 'fin4', charId: 'cf2', status: 'ongoing', createdAt: 1, updatedAt: 1 };
            await DB.saveDateStory(m);
            const manual = await finishDateStoryWithSummary({ char: char({ id: 'cf2', dateSummaryConfig: { palaceMode: 'manual' } }), story: m, userName: '', api, messages: [msg('fin4', 'assistant', '開場')], palace });
            expect(manual.palace).toBe('skipped');
            expect(manual.story.finalSummary?.palaceAt).toBeUndefined();
        } finally {
            globalThis.fetch = realFetch;
        }
    });

    it('模型失敗就不完結', async () => {
        const s: DateStory = { id: 'fin5', charId: 'cf', status: 'ongoing', createdAt: 1, updatedAt: 1 };
        await DB.saveDateStory(s);
        const bad = (async () => new Response('down', { status: 500 })) as typeof fetch;
        await expect(finishDateStoryWithSummary({ char: char(), story: s, userName: '', api, messages: [msg('fin5', 'assistant', 'x')], palace: null, fetchImpl: bad })).rejects.toThrow();
        expect((await DB.getDateStory('fin5'))?.status).toBe('ongoing');
    });
});
