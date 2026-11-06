import { describe, expect, it } from 'vitest';
import {
    buildDateRecap, buildDateSummaryMessages, resolveDateSummaryConfig, runDateSummary, shouldAutoSummarize,
    summaryMessageText, unsummarizedMessages, updateDateSummary, deleteDateSummary,
} from './dateSummary';
import { DB } from './db';
import type { CharacterProfile, DateStory, DateStorySummary, Message } from '../types';

const char = (over: Partial<CharacterProfile> = {}) => ({ id: 'c1', name: '凱恩', ...over } as CharacterProfile);
const story = (over: Partial<DateStory> = {}): DateStory => ({ id: 's1', charId: 'c1', status: 'ongoing', createdAt: 1, updatedAt: 1, ...over });
let nextId = 1;
const msg = (role: 'user' | 'assistant', content: string, over: Partial<Message> = {}): Message =>
    ({ id: nextId++, charId: 'c1', role, type: 'text', content, timestamp: nextId * 1000, metadata: { source: 'date', dateStoryId: 's1' }, ...over } as Message);
const summary = (text: string, over: Partial<DateStorySummary> = {}): DateStorySummary =>
    ({ id: `x${text}`, text, fromMessageId: 1, toMessageId: 2, messageCount: 2, createdAt: 1, kind: 'auto', ...over });

describe('設定', () => {
    it('預設：自動、每 10 輪、只有完結送宮殿；亂填的收回範圍', () => {
        expect(resolveDateSummaryConfig(char())).toMatchObject({ auto: true, trigger: 'rounds', rounds: 10, palaceMode: 'final', dailyTime: '23:30' });
        expect(resolveDateSummaryConfig(char({ dateSummaryConfig: { rounds: 0, dailyTime: '9點', palaceMode: 'x' as any } }))).toMatchObject({ rounds: 1, dailyTime: '23:30', palaceMode: 'final' });
        expect(resolveDateSummaryConfig(char({ dateSummaryConfig: { auto: false, trigger: 'daily', prompt: '  ' } }))).toMatchObject({ auto: false, trigger: 'daily' });
        expect(resolveDateSummaryConfig(char({ dateSummaryConfig: { prompt: '  ' } })).prompt).toBeUndefined();
    });
});

describe('什麼時候自動總結', () => {
    const list = [msg('assistant', 'a'), msg('user', 'b'), msg('assistant', 'c'), msg('user', 'd'), msg('assistant', 'e')];
    it('按輪數：只數還沒總結的角色回覆', () => {
        const config = resolveDateSummaryConfig(char({ dateSummaryConfig: { rounds: 3 } }));
        expect(shouldAutoSummarize(config, story(), list)).toBe(true);
        expect(shouldAutoSummarize(config, story({ summarizedThroughId: list[0].id }), list)).toBe(false);
        expect(unsummarizedMessages(list, story({ summarizedThroughId: list[2].id })).map(m => m.content)).toEqual(['d', 'e']);
        expect(shouldAutoSummarize(resolveDateSummaryConfig(char({ dateSummaryConfig: { rounds: 3, auto: false } })), story(), list)).toBe(false);
        expect(shouldAutoSummarize(config, story({ status: 'completed' }), list)).toBe(false);
        // 別場的、聊天的不算
        const other = [msg('assistant', 'x', { metadata: { source: 'date', dateStoryId: 's2' } }), msg('assistant', 'y', { metadata: { source: 'chat' } })];
        expect(shouldAutoSummarize(resolveDateSummaryConfig(char({ dateSummaryConfig: { rounds: 1 } })), story(), other)).toBe(false);
    });

    it('每天：過了時間點、今天這個點之後還沒自動總結過、有新回覆', () => {
        const config = resolveDateSummaryConfig(char({ dateSummaryConfig: { trigger: 'daily', dailyTime: '21:00' } }));
        const at = (h: number, m = 0) => new Date(2026, 10, 6, h, m).getTime();
        expect(shouldAutoSummarize(config, story(), list, at(20, 59))).toBe(false);
        expect(shouldAutoSummarize(config, story(), list, at(21, 1))).toBe(true);
        expect(shouldAutoSummarize(config, story({ summaries: [summary('早', { createdAt: at(21, 0) })] }), list, at(23))).toBe(false);
        expect(shouldAutoSummarize(config, story({ summaries: [summary('昨', { createdAt: at(21) - 86_400_000 })] }), list, at(23))).toBe(true);
        // 手動總結過不算今天的自動那次
        expect(shouldAutoSummarize(config, story({ summaries: [summary('手', { createdAt: at(22), kind: 'all' })] }), list, at(23))).toBe(true);
    });
});

describe('總結的內容', () => {
    it('給模型看的文字拿掉語氣標籤和 HTML', () => {
        expect(summaryMessageText(msg('assistant', '他笑了。\n[soft] 「早安」\n<meow_FM>摘要</meow_FM>'))).toBe('他笑了。\n「早安」\n摘要');
    });

    it('提示詞帶大綱、上一段、要求和對話', () => {
        const [sys, user] = buildDateSummaryMessages({ charName: '凱恩', userName: '小雨', scenario: '雨夜書店', previous: '上一段的事', messages: [msg('user', '「嗨」'), msg('assistant', '「你來了」')], prompt: '用第一人稱' });
        expect(sys.content).toContain('雨夜書店');
        expect(sys.content).toContain('上一段的事');
        expect(sys.content).toContain('用第一人稱');
        expect(user.content).toContain('【小雨】\n「嗨」');
        expect(user.content).toContain('【凱恩】\n「你來了」');
    });

    it('前情提要照順序接，太長留最近的並說省略了幾段', () => {
        expect(buildDateRecap(null)).toBe('');
        expect(buildDateRecap(story())).toBe('');
        const recap = buildDateRecap(story({ summaries: [summary('一'.repeat(10)), summary('二'.repeat(10)), summary('三'.repeat(10))] }), 25);
        expect(recap).toContain('### 前情提要');
        expect(recap).toContain('（更早的 1 段省略）');
        expect(recap.indexOf('二')).toBeLessThan(recap.indexOf('三'));
        expect(recap).not.toContain('一');
        // 只有一段、又超長也照帶
        expect(buildDateRecap(story({ summaries: [summary('長'.repeat(50))] }), 10)).toContain('長'.repeat(50));
    });
});

describe('runDateSummary（走真庫）', () => {
    const fakeFetch = (reply: string, seen: any[] = []) => (async (_url: any, init: any) => {
        seen.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const api = { baseUrl: 'https://x.test/v1', apiKey: 'k', model: 'm' };

    it('總結還沒總結的部分、推進進度；選範圍不動進度；接上一段', async () => {
        const s = story({ id: 'run1', scenario: '雨夜' });
        await DB.saveDateStory(s);
        const tag = { metadata: { source: 'date', dateStoryId: 'run1' } } as Partial<Message>;
        const list = [msg('assistant', '開場', tag), msg('user', '「嗨」', tag), msg('assistant', '「你好」', tag)];
        const first = await runDateSummary({ char: char(), story: s, userName: '小雨', api, messages: list, kind: 'auto', fetchImpl: fakeFetch('第一段') });
        expect(first?.summary).toMatchObject({ text: '第一段', fromMessageId: list[0].id, toMessageId: list[2].id, messageCount: 3, kind: 'auto' });
        expect(first?.story.summarizedThroughId).toBe(list[2].id);
        // 沒新的就不跑
        expect(await runDateSummary({ char: char(), story: first!.story, userName: '小雨', api, messages: list, kind: 'all', fetchImpl: fakeFetch('不該出現') })).toBeNull();

        const more = [...list, msg('user', '「走吧」', tag), msg('assistant', '他們走了。', tag)];
        const seen: any[] = [];
        const second = await runDateSummary({ char: char(), story: first!.story, userName: '小雨', api, messages: more, kind: 'all', fetchImpl: fakeFetch('第二段', seen) });
        expect(second?.summary.fromMessageId).toBe(more[3].id);
        expect(seen[0].messages[0].content).toContain('第一段');
        expect(seen[0].stream).toBe(false);

        const range = await runDateSummary({ char: char(), story: second!.story, userName: '小雨', api, messages: more, kind: 'range', range: { fromMessageId: more[1].id, toMessageId: more[2].id }, fetchImpl: fakeFetch('選的') });
        expect(range?.story.summarizedThroughId).toBe(more[4].id);
        const saved = await DB.getDateStory('run1');
        expect(saved?.summaries?.map(x => x.text)).toEqual(['第一段', '選的', '第二段']);

        await updateDateSummary('run1', saved!.summaries![1].id, { text: '改過', palaceAt: 5 });
        await deleteDateSummary('run1', saved!.summaries![0].id);
        expect((await DB.getDateStory('run1'))?.summaries?.map(x => [x.text, x.palaceAt])).toEqual([['改過', 5], ['第二段', undefined]]);
    });

    it('模型出錯就丟錯、不存半份', async () => {
        const s = story({ id: 'run2' });
        await DB.saveDateStory(s);
        const bad = (async () => new Response('nope', { status: 500 })) as typeof fetch;
        await expect(runDateSummary({ char: char(), story: s, userName: '', api, messages: [msg('assistant', 'a', { metadata: { source: 'date', dateStoryId: 'run2' } })], kind: 'auto', fetchImpl: bad })).rejects.toThrow('500');
        expect((await DB.getDateStory('run2'))?.summaries).toBeUndefined();
    });
});

describe('前情提要進提示詞', () => {
    it('內建模式在劇情大綱後、場景上下文前；自訂預設補在聊天記錄前', async () => {
        const { DatePrompts } = await import('./datePrompts');
        const { buildMeetingPresetPayload } = await import('./meetingPresetSession');
        const c = { id: 'c1', name: '凱恩', avatar: '', description: '', systemPrompt: '你是凱恩。', memories: [], dateScenario: '雨夜' } as unknown as CharacterProfile;
        const recap = buildDateRecap(story({ summaries: [summary('他們在書店躲雨。')] }));
        const history = [msg('user', '「嗨」', { metadata: { source: 'date' } })];
        const { messages } = await DatePrompts.buildSessionPayload({ char: c, userProfile: { name: '小雨' } as any, allMsgs: history, emojis: [], userText: '「嗨」', variant: 'send', recap });
        const sys = String(messages[0].content);
        expect(sys.indexOf('### 當前劇情大綱')).toBeLessThan(sys.indexOf('### 前情提要'));
        expect(sys.indexOf('他們在書店躲雨。')).toBeLessThan(sys.indexOf('### 場景上下文'));

        const doc = { schema: 'soren.meeting-preset', version: 1, name: 't', generation: {}, regexScripts: [], groups: [], globalVars: {},
            prompts: [{ id: 'main', name: 'main', enabled: true, role: 'system', content: '主' }, { id: 'chatHistory', name: 'h', enabled: true, role: 'system', content: '', slot: 'chatHistory' }] } as any;
        const preset = await buildMeetingPresetPayload({ preset: doc, char: c, userProfile: { name: '小雨' } as any, allMsgs: history, emojis: [], userText: '「嗨」', recap });
        const at = preset.messages.findIndex(m => m.content.includes('他們在書店躲雨。'));
        expect(at).toBeGreaterThan(0);
        expect(at).toBeLessThan(preset.messages.findIndex(m => m.role === 'user'));
    });
});

describe('送進記憶宮殿的設定', () => {
    it('角色沒開宮殿或沒設 Embedding 就不送；副 API 沒設用主 API', async () => {
        const { resolveDatePalaceConfig } = await import('./dateSummaryPalace');
        const emb = { baseUrl: 'https://e.test', apiKey: 'k', model: 'e', dimensions: 1024 };
        const main = { baseUrl: 'https://m.test', apiKey: 'mk', model: 'main' };
        expect(resolveDatePalaceConfig(char(), { embedding: emb }, main)).toBeNull();
        expect(resolveDatePalaceConfig(char({ memoryPalaceEnabled: true }), { embedding: { ...emb, apiKey: '' } }, main)).toBeNull();
        expect(resolveDatePalaceConfig(char({ memoryPalaceEnabled: true }), { embedding: emb }, main)?.llm).toEqual(main);
        const light = { baseUrl: 'https://l.test', apiKey: 'lk', model: 'light' };
        expect(resolveDatePalaceConfig(char({ memoryPalaceEnabled: true }), { embedding: emb, lightLLM: light }, main)?.llm).toEqual(light);
    });
});

describe('importDateStorySummary（走真庫）', () => {
    it('一段總結就是一條記憶：大總結進臥室、比較重要；建鏈失敗不影響寫入', async () => {
        const { vi } = await import('vitest');
        const { importDateStorySummary } = await import('./memoryPalace/pipeline');
        const { MemoryNodeDB } = await import('./memoryPalace/db');
        const realFetch = globalThis.fetch;
        globalThis.fetch = vi.fn(async (url: any) => String(url).includes('/embeddings')
            ? new Response(JSON.stringify({ data: [{ index: 0, embedding: Array.from({ length: 8 }, (_, i) => (i + 1) / 10) }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
            : new Response('down', { status: 503 })) as any;
        try {
            const emb = { baseUrl: 'https://e.test/v1', apiKey: 'k', model: 'emb', dimensions: 8 };
            const llm = { baseUrl: 'https://l.test/v1', apiKey: 'k', model: 'l' };
            const result = await importDateStorySummary({ charId: 'palace1', content: ' 他們在雨夜的書店和好了。 ', happenedAt: 1234, final: true, tags: ['雨夜書店'] }, emb, llm);
            expect(result).toEqual({ stored: 1, skipped: 0 });
            const nodes = await MemoryNodeDB.getByCharId('palace1');
            expect(nodes).toHaveLength(1);
            expect(nodes[0]).toMatchObject({ content: '他們在雨夜的書店和好了。', room: 'bedroom', importance: 8, createdAt: 1234, embedded: true });
            expect(nodes[0].tags).toEqual(['見面', '線下故事', '雨夜書店']);
            expect((await importDateStorySummary({ charId: 'palace1', content: '  ', happenedAt: 1 }, emb, llm)).error).toBe('empty');
        } finally {
            globalThis.fetch = realFetch;
        }
    });
});
