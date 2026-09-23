import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { applyAssistantPostProcessing, PostProcessCtx, XhsCaches } from './applyAssistantPostProcessing';
import * as agenticTools from './agenticTools';
import { DB } from './db';

/**
 * 「連不上」不能說成「沒有」。
 *
 * agenticTools 把「傳輸失敗」從「查過了沒有」裡拆了出來（新 reason `unreachable`）。前台這幾處
 * 兜底原來只認 not_found，unreachable 掉進同一個分支後，角色會張口就說「那天沒寫日記」
 * 「沒找到那篇筆記」—— 一件根本沒查成的事，被它當成結論說出去，之後還會順著這個假前提聊。
 *
 * 這份測試盯住：unreachable 時角色被告知的是「沒查成」，而不是「沒有」。
 */

const fetchCalls: Array<{ url: string; body: any }> = [];

const fakeLLMResponse = (content: string) => ({
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
});

beforeEach(() => {
    fetchCalls.length = 0;
    vi.spyOn(globalThis, 'fetch' as any).mockImplementation((async (url: any, init: any) => {
        fetchCalls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
        return fakeLLMResponse('嗯……這次沒打開') as any;
    }) as any);
});

afterEach(() => { vi.restoreAllMocks(); });

/** 最後一次二輪請求裡，餵給角色的那段系統說明 */
const lastSystemPrompt = (): string => {
    const call = fetchCalls[fetchCalls.length - 1];
    const msgs = call?.body?.messages || [];
    return String(msgs[msgs.length - 1]?.content || '');
};

const makeCtx = (char: any, extra: Partial<PostProcessCtx> = {}): PostProcessCtx => {
    const xhsCaches: XhsCaches = {
        xsecTokenCache: new Map(),
        noteTitleCache: new Map(),
        commentUserIdCache: new Map(),
        commentAuthorNameCache: new Map(),
        commentParentIdCache: new Map(),
    };
    return {
        char,
        userProfile: { name: '小明' } as any,
        emojis: [],
        contextMsgs: [],
        fullMessages: [{ role: 'user', content: '在嗎' }],
        initialData: {},
        historyMsgCount: 1,
        xhsCaches,
        api: {
            baseUrl: 'http://localhost:0',
            headers: {},
            effectiveApi: { baseUrl: 'http://localhost:0', apiKey: '', model: 'test' },
        },
        hooks: { setMessages: vi.fn(), addToast: vi.fn() },
        instantRender: true,
        ...extra,
    };
};

const notionConfig = {
    notionEnabled: true,
    notionApiKey: 'k',
    notionDatabaseId: 'db',
    notionNotesDatabaseId: 'notes-db',
} as any;

const feishuConfig = {
    feishuEnabled: true,
    feishuAppId: 'a',
    feishuAppSecret: 's',
    feishuBaseId: 'b',
    feishuTableId: 't',
} as any;

const xhsConfig = {
    xhsMcpConfig: { enabled: true, serverUrl: 'http://localhost:0' },
} as any;

describe('日記 / 筆記：連不上 ≠ 那天沒寫', () => {
    it('READ_DIARY unreachable → 說「沒查成」，不說「那天沒寫日記」', async () => {
        vi.spyOn(agenticTools, 'runReadDiary').mockResolvedValue({
            ok: false, reason: 'unreachable', date: '2026-08-01',
        } as any);

        await applyAssistantPostProcessing(
            '我翻翻那天的日記\n[[READ_DIARY: 2026-08-01]]',
            makeCtx({ id: `c-rd-${Date.now()}`, name: '阿一' }, { realtimeConfig: notionConfig }),
        );

        const prompt = lastSystemPrompt();
        expect(prompt).toContain('沒查成');
        // 修復前: 掉進 not_found 分支, 角色被告知「那天沒有寫日記」
        expect(prompt).not.toContain('沒有寫日記');
    });

    it('FS_READ_DIARY unreachable → 同樣只說沒查成', async () => {
        vi.spyOn(agenticTools, 'runFsReadDiary').mockResolvedValue({
            ok: false, reason: 'unreachable', date: '2026-08-01',
        } as any);

        await applyAssistantPostProcessing(
            '[[FS_READ_DIARY: 2026-08-01]]',
            makeCtx({ id: `c-fsrd-${Date.now()}`, name: '阿一' }, { realtimeConfig: feishuConfig }),
        );

        const prompt = lastSystemPrompt();
        expect(prompt).toContain('沒查成');
        expect(prompt).not.toContain('沒有寫日記');
    });

    it('READ_NOTE unreachable → 說「沒查成」，不說「沒有找到」', async () => {
        vi.spyOn(agenticTools, 'runReadNote').mockResolvedValue({
            ok: false, reason: 'unreachable', keyword: '旅行計劃',
        } as any);

        await applyAssistantPostProcessing(
            '[[READ_NOTE: 旅行計劃]]',
            makeCtx({ id: `c-rn-${Date.now()}`, name: '阿一' }, { realtimeConfig: notionConfig }),
        );

        const prompt = lastSystemPrompt();
        expect(prompt).toContain('沒查成');
        // 修復前: 掉進 not_found 分支 →「但沒有找到」
        expect(prompt).not.toContain('但沒有找到');
    });

    it('真的 not_found 時仍然說「那天沒寫」（不迴歸）', async () => {
        vi.spyOn(agenticTools, 'runReadDiary').mockResolvedValue({
            ok: false, reason: 'not_found', date: '2026-08-01',
        } as any);

        await applyAssistantPostProcessing(
            '[[READ_DIARY: 2026-08-01]]',
            makeCtx({ id: `c-rd-nf-${Date.now()}`, name: '阿一' }, { realtimeConfig: notionConfig }),
        );

        expect(lastSystemPrompt()).toContain('沒有寫日記');
    });
});

describe('小紅書：連不上時別當無事發生', () => {
    it('XHS_DETAIL unreachable → 走「這條筆記打不開」的圓場，而不是只刪標記', async () => {
        vi.spyOn(agenticTools, 'runXhsDetail').mockResolvedValue({
            ok: false, reason: 'unreachable', noteId: 'note-1', message: '連接被拒絕',
        } as any);

        await applyAssistantPostProcessing(
            '我看看這條\n[[XHS_DETAIL: note-1]]',
            makeCtx(
                { id: `c-xd-${Date.now()}`, name: '阿一', xhsEnabled: true },
                { realtimeConfig: xhsConfig },
            ),
        );

        // 修復前: ok:false 直接刪標記, 一次二輪都不發, 角色說完"我看看這條"就沒下文了
        expect(fetchCalls.length).toBe(1);
        const prompt = lastSystemPrompt();
        expect(prompt).toContain('加載失敗');
        expect(prompt).toContain('note-1');
    });

    it('XHS_MY_PROFILE unreachable → 交代「打不開」，並明說什麼都沒看到', async () => {
        // 正常路徑優先讀本地角色主頁；只有本地索引也讀不了時，
        // 才會回退到真實帳號主頁並進入 unreachable 分支。
        vi.spyOn(DB, 'getXhsOwnedPosts').mockRejectedValueOnce(new Error('本地角色主頁讀取失敗'));
        vi.spyOn(agenticTools, 'runXhsMyProfile').mockResolvedValue({
            ok: false, reason: 'unreachable',
        } as any);

        await applyAssistantPostProcessing(
            '我看看我的小紅書\n[[XHS_MY_PROFILE]]',
            makeCtx(
                { id: `c-xp-${Date.now()}`, name: '阿一', xhsEnabled: true },
                { realtimeConfig: xhsConfig },
            ),
        );

        // 修復前: 靜默丟標記, 零二輪
        expect(fetchCalls.length).toBe(1);
        const prompt = lastSystemPrompt();
        expect(prompt).toContain('連不上');
        expect(prompt).toContain('不要描述任何筆記');
    });
});
