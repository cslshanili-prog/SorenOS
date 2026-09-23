// utils/agenticTools.failures.test.ts
//
// 迴歸守衛：工具「沒跑成」不能被說成「跑了但沒結果」。
//
// 這一組 bug 長得都一樣——數據源的 success:false 裡混著兩種完全不同的事（連不上 / 真的
// 沒有），工具卻把它們歸成同一個 reason。護欄（agenticToolFeedback 的 NEVER_RAN_REASONS）
// 只認得出「沒跑成」那一類，混過去之後角色就會把沒發生的事說成發生過：Notion 憑據過期
// 時張口就是「你昨天沒寫日記呀」。
//
// 所以每條用例除了斷 reason，還會把結果餵給回喂層，確認模型收到的是「這件事沒有發生」。
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./realtimeFetchCore', () => ({
  performSearch: vi.fn(),
  notionGetDiaryByDate: vi.fn(),
  notionReadDiaryContent: vi.fn(),
  notionReadNoteContent: vi.fn(),
  notionSearchUserNotes: vi.fn(),
  feishuGetDiaryByDate: vi.fn(),
}));

import {
  runSearch,
  runReadDiary,
  runFsReadDiary,
  runReadNote,
  runXhsMyProfile,
  type AgenticToolCtx,
} from './agenticTools';
import * as core from './realtimeFetchCore';
import { XhsMcpClient } from './xhsMcpClient';
import { buildToolResultMessage } from './agenticToolFeedback';

const mocked = core as unknown as Record<string, ReturnType<typeof vi.fn>>;

const ctx = (realtimeConfig: Record<string, unknown>): AgenticToolCtx => ({
  char: { name: '測試角色' },
  userProfile: { name: '用戶' } as any,
  realtimeConfig: realtimeConfig as any,
});

const notionCtx = ctx({
  notionEnabled: true,
  notionApiKey: 'key',
  notionDatabaseId: 'db',
  notionNotesDatabaseId: 'notes-db',
});

const feishuCtx = ctx({
  feishuEnabled: true,
  feishuAppId: 'app',
  feishuAppSecret: 'secret',
  feishuBaseId: 'base',
  feishuTableId: 'table',
});

const xhsCtx = (mcp: Record<string, unknown>): AgenticToolCtx => ({
  char: { name: '測試角色', xhsEnabled: true },
  userProfile: { name: '用戶' } as any,
  realtimeConfig: { xhsMcpConfig: { enabled: true, serverUrl: 'https://example.test/xhs', ...mcp } } as any,
});

/** 回喂層有沒有跟模型說死「這件事沒有發生」——護欄真正生效的那一層。 */
const feedbackSaysNeverHappened = (name: string, result: unknown): boolean =>
  buildToolResultMessage({ name, result, history: [{ name, fingerprint: 'x' }] })
    .includes('這件事**沒有發生**');

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('runSearch', () => {
  it('搜索服務連不上 → unreachable，回喂明說沒發生', async () => {
    mocked.performSearch.mockResolvedValue({ success: false, results: [], message: '搜索出錯: fetch failed', reached: false });
    const r = await runSearch({ query: '今天有什麼新聞' }, ctx({ newsEnabled: true, newsApiKey: 'key' }));
    expect(r).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(feedbackSaysNeverHappened('web_search', r)).toBe(true);
  });

  it('搜過了但沒結果 → no_results，這時角色說「沒搜到」是實話', async () => {
    mocked.performSearch.mockResolvedValue({ success: false, results: [], message: '沒有找到相關結果', reached: true });
    const r = await runSearch({ query: '冷門詞' }, ctx({ newsEnabled: true, newsApiKey: 'key' }));
    expect(r).toMatchObject({ ok: false, reason: 'no_results' });
    expect(feedbackSaysNeverHappened('web_search', r)).toBe(false);
  });

  it('搜到了 → ok', async () => {
    mocked.performSearch.mockResolvedValue({
      success: true,
      results: [{ title: '標題', description: '摘要', url: 'https://x.test' }],
      message: '搜索成功',
      reached: true,
    });
    expect(await runSearch({ query: '貓' }, ctx({ newsEnabled: true, newsApiKey: 'key' })))
      .toMatchObject({ ok: true, rawResultCount: 1 });
  });
});

describe('runReadDiary（Notion 日記）', () => {
  it('查詢沒跑通（憑據過期 / 代理掛了）→ unreachable，不能說成「那天沒寫」', async () => {
    mocked.notionGetDiaryByDate.mockResolvedValue({ success: false, entries: [], message: '查詢失敗: 401' });
    const r = await runReadDiary({ date: '2026-08-01' }, notionCtx);
    expect(r).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(feedbackSaysNeverHappened('notion_read_diary', r)).toBe(true);
  });

  it('查到了、那天真沒寫 → not_found', async () => {
    mocked.notionGetDiaryByDate.mockResolvedValue({ success: true, entries: [], message: '沒有找到' });
    const r = await runReadDiary({ date: '2026-08-01' }, notionCtx);
    expect(r).toMatchObject({ ok: false, reason: 'not_found' });
    expect(feedbackSaysNeverHappened('notion_read_diary', r)).toBe(false);
  });

  // 「找到條目、正文一篇都沒讀回來」是讀取失敗，不是"日記是空的"。真的空白日記
  // notionReadDiaryContent 會 success:true 帶回「（空白日記）」，走不到這條分支。
  it('條目找到了但正文全沒讀回來 → 回喂也得說沒發生', async () => {
    mocked.notionGetDiaryByDate.mockResolvedValue({
      success: true,
      entries: [{ id: 'p1', title: '標題', date: '2026-08-01', url: '' }],
      message: '找到 1 篇日記',
    });
    mocked.notionReadDiaryContent.mockResolvedValue({ success: false, content: '', message: '讀取失敗: 401' });
    const r = await runReadDiary({ date: '2026-08-01' }, notionCtx);
    expect(r).toMatchObject({ ok: false, reason: 'empty_content' });
    expect(feedbackSaysNeverHappened('notion_read_diary', r)).toBe(true);
  });

  it('真的空白日記照舊算讀到了', async () => {
    mocked.notionGetDiaryByDate.mockResolvedValue({
      success: true,
      entries: [{ id: 'p1', title: '標題', date: '2026-08-01', url: '' }],
      message: '找到 1 篇日記',
    });
    mocked.notionReadDiaryContent.mockResolvedValue({ success: true, content: '（空白日記）', message: '日記內容為空' });
    expect(await runReadDiary({ date: '2026-08-01' }, notionCtx)).toMatchObject({ ok: true, entryCount: 1 });
  });
});

describe('runFsReadDiary（飛書日記）', () => {
  it('拿不到 token / 接口報錯 → unreachable', async () => {
    mocked.feishuGetDiaryByDate.mockResolvedValue({ success: false, entries: [], message: '獲取token失敗: 400' });
    const r = await runFsReadDiary({ date: '2026-08-01' }, feishuCtx);
    expect(r).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(feedbackSaysNeverHappened('feishu_read_diary', r)).toBe(true);
  });

  it('查到了、那天真沒寫 → not_found', async () => {
    mocked.feishuGetDiaryByDate.mockResolvedValue({ success: true, entries: [], message: '沒有找到' });
    const r = await runFsReadDiary({ date: '2026-08-01' }, feishuCtx);
    expect(r).toMatchObject({ ok: false, reason: 'not_found' });
    expect(feedbackSaysNeverHappened('feishu_read_diary', r)).toBe(false);
  });
});

describe('runReadNote（Notion 筆記）', () => {
  it('搜不動 → unreachable，不能說成「對方沒寫過這篇」', async () => {
    mocked.notionSearchUserNotes.mockResolvedValue({ success: false, entries: [], message: '搜索失敗: 502' });
    const r = await runReadNote({ keyword: '旅行' }, notionCtx);
    expect(r).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(feedbackSaysNeverHappened('read_note', r)).toBe(true);
  });

  it('搜過了沒這篇 → not_found', async () => {
    mocked.notionSearchUserNotes.mockResolvedValue({ success: true, entries: [], message: '沒有找到' });
    const r = await runReadNote({ keyword: '旅行' }, notionCtx);
    expect(r).toMatchObject({ ok: false, reason: 'not_found' });
    expect(feedbackSaysNeverHappened('read_note', r)).toBe(false);
  });

  it('條目找到了但正文全沒讀回來 → 回喂也得說沒發生', async () => {
    mocked.notionSearchUserNotes.mockResolvedValue({
      success: true,
      entries: [{ id: 'n1', title: '旅行計劃', date: '2026-07-30', url: '' }],
      message: '找到 1 篇筆記',
    });
    mocked.notionReadNoteContent.mockResolvedValue({ success: false, content: '', message: '讀取失敗: 401' });
    const r = await runReadNote({ keyword: '旅行' }, notionCtx);
    expect(r).toMatchObject({ ok: false, reason: 'empty_content' });
    expect(feedbackSaysNeverHappened('read_note', r)).toBe(true);
  });
});

describe('runXhsMyProfile', () => {
  // 主頁打不開就降級搜暱稱，搜索也連不上時以前照樣回 ok:true，筆記那欄寫「（沒有搜到相關
  // 筆記）」——角色於是說「我翻了下我的小紅書，一條都沒找到」。小紅書服務器多半在用戶
  // 自己電腦上，後台到點時人睡了機器關了，這條走得最勤。
  it('主頁打不開、降級搜索也連不上 → unreachable', async () => {
    vi.spyOn(XhsMcpClient, 'search').mockResolvedValue({ success: false, error: 'connect ECONNREFUSED' } as any);
    const r = await runXhsMyProfile({}, xhsCtx({ loggedInNickname: '小明' }));
    expect(r).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(feedbackSaysNeverHappened('xhs_my_profile', r)).toBe(true);
  });

  it('降級搜索跑通了、真的一條都沒有 → 照舊 ok，可以說「沒搜到」', async () => {
    vi.spyOn(XhsMcpClient, 'search').mockResolvedValue({ success: true, data: { notes: [] } } as any);
    const r = await runXhsMyProfile({}, xhsCtx({ loggedInNickname: '小明' }));
    expect(r).toMatchObject({ ok: true, gotProfile: false });
    expect(r.ok && r.feedsStr).toBe('（沒有搜到相關筆記）');
  });

  it('只有 userId、主頁請求掛了又沒暱稱可降級 → unreachable', async () => {
    vi.spyOn(XhsMcpClient, 'getUserProfile').mockResolvedValue({ success: false, error: 'timeout' } as any);
    const r = await runXhsMyProfile({}, xhsCtx({ loggedInUserId: 'uid-1' }));
    expect(r).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(feedbackSaysNeverHappened('xhs_my_profile', r)).toBe(true);
  });
});
