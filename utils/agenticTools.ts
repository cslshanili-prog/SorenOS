/**
 * agenticTools — 二輪 LLM 數據工具的純函數封裝
 *
 * 把 "read 類" 工具的 data-fetch 部分集中起來: 本地聊天的 applyAssistantPostProcessing
 * 直接 import 具體 run* 函數, 主動消息 2.0 的 worker 工具循環走 dispatchAgenticTool。
 *
 * - 每個 run* 返回 `{ ok: true, ... } | { ok: false, reason, message? }`
 * - 不調 2nd-pass LLM (這是 applyAssistantPostProcessing / worker 工具循環的事)
 * - 不修改 aiContent (調用方負責)
 * - 不 toast / setStatus (調用方負責)
 * - XHS 工具會修改 ctx.xhsCaches + ctx.lastXhsNotesRef (跨 tool 共享狀態)
 */

// 值 import 只允許環境無關葉子（realtimeFetchCore / xhsMcpClient / localDate）——這份文件會被
// amsg worker bundle 原樣打包跑在服務端工具循環裡；類型統一 import type，不進 bundle。
import type { CharacterProfile, RealtimeConfig, UserProfile } from '../types';
import type { XhsNote } from './realtimeContext';
import {
    performSearch,
    notionGetDiaryByDate,
    notionReadDiaryContent,
    notionReadNoteContent,
    notionSearchUserNotes,
    feishuGetDiaryByDate,
} from './realtimeFetchCore';
import {
    XhsMcpClient,
    extractNotesFromMcpData,
    normalizeNote,
    normalizeXhsComments,
    normalizeXhsLiteDetail,
} from './xhsMcpClient';
import { getLocalDateKey } from './localDate';
import { includesAnyScript } from './scriptKey';

// ─── 共用類型 ────────────────────────────────────────────────────────────────

/** XHS 跨 tool 共享狀態 — useRef 持有, 在同一會話內累積 */
export interface XhsCaches {
    xsecTokenCache: Map<string, string>;
    noteTitleCache: Map<string, string>;
    commentUserIdCache: Map<string, string>;
    commentAuthorNameCache: Map<string, string>;
    commentParentIdCache: Map<string, string>;
}

/** 解析 char + realtimeConfig 拿到當前 XHS 配置 (per-character override) */
export interface XhsConfig {
    enabled: boolean;
    mcpUrl: string;
    loggedInUserId?: string;
    loggedInNickname?: string;
    userXsecToken?: string;
}

/**
 * 這些工具真正會讀的實時配置字段（RealtimeConfig 的憑據子集）。
 *
 * 與 AgenticToolChar 同一個道理：amsg worker 到點只有雲端 tool_config 那點數據，拼不出
 * 完整的 RealtimeConfig。聲明成窄接口後，瀏覽器側傳完整 RealtimeConfig 天然滿足（結構化
 * 類型，調用點不用改），worker 側直接把 AmsgToolConfig 遞進來也能被類型檢查到。
 *
 * 上雲的 AmsgToolConfig 直接 extends 這個接口（見 utils/amsgToolPack.ts），所以這裡加字段
 * 那邊自動跟上——兩份字段表靠人工對齊的話，漏一個就是 worker 側運行時靜默拿 undefined。
 */
export interface AgenticToolRealtimeConfig {
    newsEnabled: boolean;
    newsApiKey?: string;
    notionEnabled: boolean;
    notionApiKey?: string;
    notionDatabaseId?: string;
    notionNotesDatabaseId?: string;
    feishuEnabled: boolean;
    feishuAppId?: string;
    feishuAppSecret?: string;
    feishuBaseId?: string;
    feishuTableId?: string;
    xhsMcpConfig?: {
        enabled?: boolean;
        serverUrl?: string;
        loggedInUserId?: string;
        loggedInNickname?: string;
        userXsecToken?: string;
    };
}

// 只讀 char.xhsEnabled 一個字段，所以參數就按這個聲明（原來要整個 CharacterProfile，
// 聲明的依賴比真實的寬太多，amsg worker 那種拼不出完整角色的調用方就只能硬轉）。
export function resolveXhsConfig(
    char: { xhsEnabled?: boolean },
    realtimeConfig?: AgenticToolRealtimeConfig,
): XhsConfig {
    const mcpConfig = realtimeConfig?.xhsMcpConfig;
    const mcpAvailable = !!(mcpConfig?.enabled && mcpConfig?.serverUrl);
    const mcpUrl = mcpConfig?.serverUrl || '';
    const loggedInUserId = mcpConfig?.loggedInUserId;
    const loggedInNickname = mcpConfig?.loggedInNickname;
    const userXsecToken = mcpConfig?.userXsecToken;

    // 必須由角色自己的開關顯式打開（UI 默認關閉）；不回退到全局 realtimeConfig.xhsEnabled，
    // 與 chatPrompts.ts 的提示詞注入門控保持一致。
    return { enabled: !!char.xhsEnabled && mcpAvailable, mcpUrl, loggedInUserId, loggedInNickname, userXsecToken };
}

/**
 * 這些工具真正會讀的角色字段（CharacterProfile 的子集）。
 *
 * 為什麼單獨聲明：amsg worker 到點只有雲端 tool_pack 那點數據，拼不出完整的
 * CharacterProfile。以前 worker 側用 `as unknown as CharacterProfile` 硬轉，等於把編譯器
 * 關掉——這邊哪天多讀一個字段，worker 側就悄悄拿到 undefined，還不會報錯。聲明成窄接口後
 * 瀏覽器側傳完整 CharacterProfile 天然滿足（結構化類型，調用點不用改），worker 側拼的
 * 對象也終於能被類型檢查到。加字段時記得同步 utils/amsgToolPack.ts 的 AmsgToolPack。
 */
export interface AgenticToolChar {
    name: string;
    xhsEnabled?: boolean;
    activeMemoryMonths?: string[];
    memories?: AgenticToolMemory[];
}

/** runRecall 會讀的月度總結字段（上雲的 AmsgToolPack.memories 也是這個形狀）。 */
export interface AgenticToolMemory {
    date: string;
    summary: string;
    mood?: string;
}

export interface AgenticToolCtx {
    char: AgenticToolChar;
    userProfile: UserProfile;
    realtimeConfig?: AgenticToolRealtimeConfig;
    /** XHS 跨 tool 共享緩存; XHS_SEARCH/BROWSE 寫, XHS_DETAIL/COMMENT/REPLY 讀 */
    xhsCaches?: XhsCaches;
    /** 上次瀏覽/搜索得到的筆記列表 (XHS_DETAIL retry 時複用) */
    lastXhsNotesRef?: { current: XhsNote[] };
    /** 工具內部多步操作 (XHS_DETAIL retry / XHS_MY_PROFILE fallback / DIARY read-loop) 透傳狀態文案 給調用方 UI. 不傳則 noop. */
    onProgress?: (channel: 'xhs' | 'diary', text: string) => void;
}

// ─── RECALL ─────────────────────────────────────────────────────────────────

export type RecallResult =
    | { ok: true; alreadyActive: boolean; yearMonth: string; logsText: string | null }
    | { ok: false; reason: 'no_logs'; yearMonth: string };

/**
 * 記憶庫裡到底存了哪些月份（`YYYY-MM`，升序去重）。
 *
 * 提示詞裡 `[[RECALL: 年-月]]` 是無條件注入的，但從來沒告訴過角色「哪些月份查得到」。
 * 結果就是它不知道有貨，多半懶得查，直接憑空編一段"回憶"——要一句一句點名讓它查
 * 某個月，它才會去調。把清單擺出來，它自己就知道什麼時候該伸手。
 *
 * 匹配的兩種日期寫法要跟 runRecall 保持一致（`2026-06-15` 和 `2026年6月15日`），
 * 否則會報出一個查不到的月份，比不報還糟。這兩個函數放在同一個文件裡就是為了這個。
 */
export function listRecallableMonths(memories: AgenticToolMemory[] | undefined): string[] {
    if (!memories?.length) return [];
    const months = new Set<string>();
    for (const mem of memories) {
        const iso = /(\d{4})-(\d{1,2})/.exec(mem.date);
        if (iso) months.add(`${iso[1]}-${iso[2].padStart(2, '0')}`);
        const cn = /(\d{4})年\s*(\d{1,2})\s*月/.exec(mem.date);
        if (cn) months.add(`${cn[1]}-${cn[2].padStart(2, '0')}`);
    }
    return [...months].sort();
}

export async function runRecall(
    args: { year: string; month: string },
    ctx: AgenticToolCtx,
): Promise<RecallResult> {
    const { char } = ctx;
    const targetMonth = `${args.year}-${args.month.padStart(2, '0')}`;
    const alreadyActive = !!char.activeMemoryMonths?.includes(targetMonth);

    if (alreadyActive) {
        return { ok: true, alreadyActive: true, yearMonth: targetMonth, logsText: null };
    }

    if (!char.memories) {
        return { ok: false, reason: 'no_logs', yearMonth: targetMonth };
    }
    const logs = char.memories.filter(mem => {
        return mem.date.includes(targetMonth) || mem.date.includes(`${args.year}年${parseInt(args.month)}月`);
    });
    if (logs.length === 0) {
        return { ok: false, reason: 'no_logs', yearMonth: targetMonth };
    }
    const logsText = logs.map(mem => `[${mem.date}] (${mem.mood || 'normal'}): ${mem.summary}`).join('\n');
    return { ok: true, alreadyActive: false, yearMonth: targetMonth, logsText };
}

// ─── SEARCH ─────────────────────────────────────────────────────────────────

export type SearchResult =
    | { ok: true; query: string; resultsText: string; rawResultCount: number }
    | { ok: false; reason: 'no_api_key' | 'unreachable' | 'no_results'; query: string; message?: string };

/** 不拋異常：performSearch 連網絡異常都會 catch 成 success:false（見 realtimeFetchCore）。 */
export async function runSearch(
    args: { query: string },
    ctx: AgenticToolCtx,
): Promise<SearchResult> {
    const { realtimeConfig } = ctx;
    if (!realtimeConfig?.newsEnabled || !realtimeConfig?.newsApiKey) {
        return { ok: false, reason: 'no_api_key', query: args.query };
    }
    const searchResult = await performSearch(args.query, realtimeConfig.newsApiKey);
    // 「請求沒跑通」和「搜過了但沒結果」得分開（同 runXhsSearch）。performSearch 的
    // success:false 兩種都包：斷網、代理 5xx、返回不是 JSON，跟真的零結果混在一起。
    // 都歸 no_results 的話，角色會把一次根本沒發出去的搜索說成「我剛搜了下，沒什麼新鮮的」。
    if (!searchResult.reached) {
        return { ok: false, reason: 'unreachable', query: args.query, message: searchResult.message };
    }
    if (!searchResult.success || searchResult.results.length === 0) {
        return { ok: false, reason: 'no_results', query: args.query, message: searchResult.message };
    }
    const resultsText = searchResult.results.map((r, i) =>
        `${i + 1}. ${r.title}\n   ${r.description}`
    ).join('\n\n');
    return { ok: true, query: args.query, resultsText, rawResultCount: searchResult.results.length };
}

// ─── READ_DIARY (Notion) ────────────────────────────────────────────────────

export type ReadDiaryResult =
    | { ok: true; date: string; diaryText: string; entryCount: number }
    | { ok: false; reason: 'not_configured' | 'parse_error' | 'unreachable' | 'not_found' | 'empty_content'; date?: string; dateInput?: string };

/** 不拋異常：notion* 系列連網絡異常都會 catch 成 success:false（見 realtimeFetchCore）。 */
export async function runReadDiary(
    args: { date: string },
    ctx: AgenticToolCtx,
): Promise<ReadDiaryResult> {
    const { char, realtimeConfig } = ctx;

    if (!realtimeConfig?.notionEnabled || !realtimeConfig?.notionApiKey || !realtimeConfig?.notionDatabaseId) {
        return { ok: false, reason: 'not_configured', dateInput: args.date };
    }

    const targetDate = parseDiaryDate(args.date);
    if (!targetDate) {
        return { ok: false, reason: 'parse_error', dateInput: args.date };
    }

    const findResult = await notionGetDiaryByDate(
        realtimeConfig.notionApiKey,
        realtimeConfig.notionDatabaseId,
        char.name,
        targetDate,
    );

    // 「查不動」和「那天真沒寫」是兩回事：Notion 憑據過期 / 代理掛了都會走 success:false，
    // 跟沒寫日記歸成同一個 not_found 的話，角色張口就是「你昨天沒寫日記呀」——把一次
    // 根本沒查成的事說成查過了，還順帶替用戶斷言了一件沒發生的事。
    if (!findResult.success) {
        return { ok: false, reason: 'unreachable', date: targetDate };
    }
    if (findResult.entries.length === 0) {
        return { ok: false, reason: 'not_found', date: targetDate };
    }

    ctx.onProgress?.('diary', `找到 ${findResult.entries.length} 篇日記，正在閱讀...`);

    const diaryContents: string[] = [];
    for (const entry of findResult.entries) {
        const readResult = await notionReadDiaryContent(
            realtimeConfig.notionApiKey,
            entry.id,
        );
        if (readResult.success) {
            diaryContents.push(`📔「${entry.title}」(${entry.date})\n${readResult.content}`);
        }
    }

    // 走到這裡說明條目找到了、但一篇正文都沒讀回來 = 全部讀取失敗。真的空白日記會帶著
    // 「（空白日記）」正常入列，到不了這一步。所以 empty_content 的意思是"讀失敗"，
    // 不是"日記是空的"——agenticToolFeedback 把它當"這次沒跑成"處理就是為了這個。
    if (diaryContents.length === 0) {
        return { ok: false, reason: 'empty_content', date: targetDate };
    }

    const diaryText = diaryContents.join('\n\n---\n\n');
    return { ok: true, date: targetDate, diaryText, entryCount: findResult.entries.length };
}

// ─── FS_READ_DIARY (Feishu) ─────────────────────────────────────────────────

// 沒有 empty_content：飛書那邊正文跟著條目一起返回，找到條目就一定有內容
// （Notion 要逐篇再讀一次正文，才會出現「條目找到了、一篇都沒讀回來」）。
export type FsReadDiaryResult =
    | { ok: true; date: string; diaryText: string; entryCount: number }
    | { ok: false; reason: 'not_configured' | 'parse_error' | 'unreachable' | 'not_found'; date?: string; dateInput?: string };

/** 不拋異常：feishuGetDiaryByDate 連網絡異常都會 catch 成 success:false（見 realtimeFetchCore）。 */
export async function runFsReadDiary(
    args: { date: string },
    ctx: AgenticToolCtx,
): Promise<FsReadDiaryResult> {
    const { char, realtimeConfig } = ctx;

    if (!realtimeConfig?.feishuEnabled || !realtimeConfig?.feishuAppId || !realtimeConfig?.feishuAppSecret || !realtimeConfig?.feishuBaseId || !realtimeConfig?.feishuTableId) {
        return { ok: false, reason: 'not_configured', dateInput: args.date };
    }

    const targetDate = parseDiaryDate(args.date);
    if (!targetDate) {
        return { ok: false, reason: 'parse_error', dateInput: args.date };
    }

    const findResult = await feishuGetDiaryByDate(
        realtimeConfig.feishuAppId,
        realtimeConfig.feishuAppSecret,
        realtimeConfig.feishuBaseId,
        realtimeConfig.feishuTableId,
        char.name,
        targetDate,
    );

    // 同 runReadDiary：飛書 token 拿不到 / 接口報錯都是 success:false，跟「那天沒寫」分開。
    if (!findResult.success) {
        return { ok: false, reason: 'unreachable', date: targetDate };
    }
    if (findResult.entries.length === 0) {
        return { ok: false, reason: 'not_found', date: targetDate };
    }

    ctx.onProgress?.('diary', `找到 ${findResult.entries.length} 篇飛書日記，正在閱讀...`);

    // 飛書那邊正文是跟著條目一起返回的，不用再逐篇去讀。
    const diaryText = findResult.entries
        .map(entry => `📒「${entry.title}」(${entry.date})\n${entry.content}`)
        .join('\n\n---\n\n');
    return { ok: true, date: targetDate, diaryText, entryCount: findResult.entries.length };
}

// ─── READ_NOTE (Notion notes DB) ────────────────────────────────────────────

export type ReadNoteResult =
    | { ok: true; keyword: string; noteText: string; entryCount: number }
    | { ok: false; reason: 'not_configured' | 'unreachable' | 'not_found' | 'empty_content'; keyword: string };

/** 不拋異常：notion* 系列連網絡異常都會 catch 成 success:false（見 realtimeFetchCore）。 */
export async function runReadNote(
    args: { keyword: string },
    ctx: AgenticToolCtx,
): Promise<ReadNoteResult> {
    const { realtimeConfig } = ctx;

    if (!realtimeConfig?.notionEnabled || !realtimeConfig?.notionApiKey || !realtimeConfig?.notionNotesDatabaseId) {
        return { ok: false, reason: 'not_configured', keyword: args.keyword };
    }

    const findResult = await notionSearchUserNotes(
        realtimeConfig.notionApiKey,
        realtimeConfig.notionNotesDatabaseId,
        args.keyword,
        3,
    );

    // 同 runReadDiary：搜不動 ≠ 對方沒寫過這篇筆記。
    if (!findResult.success) {
        return { ok: false, reason: 'unreachable', keyword: args.keyword };
    }
    if (findResult.entries.length === 0) {
        return { ok: false, reason: 'not_found', keyword: args.keyword };
    }

    ctx.onProgress?.('diary', `找到 ${findResult.entries.length} 篇筆記，正在閱讀...`);

    const noteContents: string[] = [];
    for (const entry of findResult.entries) {
        const readResult = await notionReadNoteContent(
            realtimeConfig.notionApiKey,
            entry.id,
        );
        if (readResult.success) {
            noteContents.push(`📝「${entry.title}」(${entry.date})\n${readResult.content}`);
        }
    }

    // 同 runReadDiary：找到條目卻一篇都沒讀回來 = 全部讀取失敗，不是"筆記是空的"。
    if (noteContents.length === 0) {
        return { ok: false, reason: 'empty_content', keyword: args.keyword };
    }

    const noteText = noteContents.join('\n\n---\n\n');
    return { ok: true, keyword: args.keyword, noteText, entryCount: findResult.entries.length };
}

// ─── XHS helpers (private, used by run* below) ──────────────────────────────

async function xhsSearchImpl(conf: { mcpUrl: string }, keyword: string): Promise<{ success: boolean; notes: XhsNote[]; message?: string }> {
    const r = await XhsMcpClient.search(conf.mcpUrl, keyword);
    if (!r.success) return { success: false, notes: [], message: r.error };
    const raw = extractNotesFromMcpData(r.data);
    return { success: true, notes: raw.map(n => normalizeNote(n) as XhsNote) };
}

async function xhsBrowseImpl(conf: { mcpUrl: string }): Promise<{ success: boolean; notes: XhsNote[]; message?: string }> {
    const r = await XhsMcpClient.getRecommend(conf.mcpUrl);
    if (!r.success) return { success: false, notes: [], message: r.error };
    const unwrapped = r.data?.data && typeof r.data.data === 'object' && !Array.isArray(r.data.data) ? r.data.data : r.data;
    console.log(`📕 [XHS] getRecommend 響應類型: ${typeof r.data}, 是否有 data 嵌套: ${unwrapped !== r.data}, unwrapped keys: ${unwrapped && typeof unwrapped === 'object' ? Object.keys(unwrapped).join(',') : 'N/A'}`);
    const raw = extractNotesFromMcpData(unwrapped);
    if (raw.length === 0 && unwrapped !== r.data) {
        console.log(`📕 [XHS] getRecommend unwrapped 提取為空，用原始數據重試`);
        const raw2 = extractNotesFromMcpData(r.data);
        return { success: true, notes: raw2.map(n => normalizeNote(n) as XhsNote) };
    }
    return { success: true, notes: raw.map(n => normalizeNote(n) as XhsNote) };
}

/** 將筆記列表的 xsecToken 和 title 存入 xhsCaches */
function cacheXsecTokensImpl(caches: XhsCaches | undefined, notes: XhsNote[]): void {
    if (!caches) return;
    for (const n of notes) {
        if (n.noteId && n.xsecToken) caches.xsecTokenCache.set(n.noteId, n.xsecToken);
        if (n.noteId && n.title) caches.noteTitleCache.set(n.noteId, n.title);
    }
}

/** 從 xhsCaches 或 lastXhsNotes 中查找 xsecToken */
function findXsecToken(caches: XhsCaches | undefined, lastXhsNotes: XhsNote[], noteId: string): string | undefined {
    const fromNotes = lastXhsNotes.find(n => n.noteId === noteId)?.xsecToken;
    if (fromNotes) return fromNotes;
    return caches?.xsecTokenCache.get(noteId);
}

// ─── XHS_SEARCH ─────────────────────────────────────────────────────────────

export type XhsSearchResult =
    | { ok: true; keyword: string; notesText: string; notes: XhsNote[] }
    | { ok: false; reason: 'not_enabled' | 'unreachable' | 'no_results'; keyword: string; message?: string };

/** Throws on network/transport error. */
export async function runXhsSearch(
    args: { keyword: string },
    ctx: AgenticToolCtx,
): Promise<XhsSearchResult> {
    const xhsConf = resolveXhsConfig(ctx.char, ctx.realtimeConfig);
    if (!xhsConf.enabled) {
        return { ok: false, reason: 'not_enabled', keyword: args.keyword };
    }
    const result = await xhsSearchImpl(xhsConf, args.keyword);
    // 「連不上」和「搜過了但沒結果」得分開：兩者都歸成 no_results 的話，角色會把一次
    // 根本沒發生的搜索說成「我剛在小紅書搜了下，沒啥好東西」——一句沒發生的事說成
    // 發生過。後台觸發時服務器多半就在用戶自己電腦上（關機 / 不在同一網絡），這條最常走。
    if (!result.success) {
        return { ok: false, reason: 'unreachable', keyword: args.keyword, message: result.message };
    }
    if (result.notes.length === 0) {
        return { ok: false, reason: 'no_results', keyword: args.keyword, message: result.message };
    }
    if (ctx.lastXhsNotesRef) ctx.lastXhsNotesRef.current = result.notes;
    cacheXsecTokensImpl(ctx.xhsCaches, result.notes);
    const notesText = result.notes.map((n, i) =>
        `${i + 1}. [noteId=${n.noteId}]「${n.title}」by ${n.author} (${n.likes}贊)\n   ${n.desc}`
    ).join('\n\n');
    return { ok: true, keyword: args.keyword, notesText, notes: result.notes };
}

// ─── XHS_BROWSE ─────────────────────────────────────────────────────────────

export type XhsBrowseResult =
    | { ok: true; category?: string; notesText: string; notes: XhsNote[] }
    | { ok: false; reason: 'not_enabled' | 'unreachable' | 'no_results'; category?: string; message?: string };

/** Throws on network/transport error. */
export async function runXhsBrowse(
    args: { category?: string },
    ctx: AgenticToolCtx,
): Promise<XhsBrowseResult> {
    const xhsConf = resolveXhsConfig(ctx.char, ctx.realtimeConfig);
    if (!xhsConf.enabled) {
        return { ok: false, reason: 'not_enabled', category: args.category };
    }
    const result = await xhsBrowseImpl(xhsConf);
    console.log('📕 [XHS] 瀏覽結果:', result.success, result.message, result.notes?.length || 0);
    // 同 runXhsSearch：連不上 ≠ 刷了但首頁是空的。
    if (!result.success) {
        return { ok: false, reason: 'unreachable', category: args.category, message: result.message };
    }
    if (result.notes.length === 0) {
        return { ok: false, reason: 'no_results', category: args.category, message: result.message };
    }
    if (ctx.lastXhsNotesRef) ctx.lastXhsNotesRef.current = result.notes;
    cacheXsecTokensImpl(ctx.xhsCaches, result.notes);
    const notesText = result.notes.map((n, i) =>
        `${i + 1}. [noteId=${n.noteId}]「${n.title}」by ${n.author} (${n.likes}贊)\n   ${n.desc}`
    ).join('\n\n');
    return { ok: true, category: args.category, notesText, notes: result.notes };
}

// ─── XHS_MY_PROFILE ─────────────────────────────────────────────────────────

export type XhsMyProfileResult =
    | { ok: true; nickname: string; userId: string; profileStr: string; feedsStr: string; gotProfile: boolean; notes: XhsNote[] }
    | { ok: false; reason: 'not_enabled' | 'no_identity' | 'unreachable'; message?: string };

/** getUserProfile 掛了會降級去搜暱稱；主頁和降級搜索都沒跑通時回 unreachable（見下面的註釋）。 */
export async function runXhsMyProfile(
    _args: Record<string, never>,
    ctx: AgenticToolCtx,
): Promise<XhsMyProfileResult> {
    const xhsConf = resolveXhsConfig(ctx.char, ctx.realtimeConfig);
    if (!xhsConf.enabled) return { ok: false, reason: 'not_enabled' };

    const nickname = xhsConf.loggedInNickname || '';
    const userId = xhsConf.loggedInUserId || '';

    if (!nickname && !userId) {
        return { ok: false, reason: 'no_identity' };
    }

    let profileStr = '';
    let feedsStr = '（獲取筆記失敗）';
    let gotProfile = false;
    let collectedNotes: XhsNote[] = [];

    if (userId) {
            console.log(`📕 [XHS] 用 getUserProfile(${userId}) 獲取主頁...`);
            ctx.onProgress?.('xhs', '正在獲取主頁信息...');
            try {
                const profileResult = await XhsMcpClient.getUserProfile(xhsConf.mcpUrl, userId, xhsConf.userXsecToken);
                if (profileResult.success && profileResult.data) {
                    const d = profileResult.data;
                    if (typeof d === 'string') {
                        profileStr = d.slice(0, 3000);
                        gotProfile = true;
                    } else {
                        const basicInfo = d.data?.basic_info || d.basic_info;
                        if (basicInfo) {
                            profileStr = JSON.stringify(basicInfo, null, 2).slice(0, 2000);
                        } else {
                            const { notes: _n, ...rest } = (d.data && typeof d.data === 'object' ? d.data : d) as any;
                            profileStr = Object.keys(rest).length > 0
                                ? JSON.stringify(rest, null, 2).slice(0, 2000)
                                : '（主頁基本信息暫時無法獲取）';
                        }
                        gotProfile = true;
                        const unwrapped = d.data && typeof d.data === 'object' && !Array.isArray(d.data) ? d.data : d;
                        console.log(`📕 [XHS] profile unwrapped keys:`, Object.keys(unwrapped), 'notes isArray:', Array.isArray(unwrapped.notes), 'notes length:', unwrapped.notes?.length);
                        const notes = extractNotesFromMcpData(unwrapped);
                        console.log(`📕 [XHS] extractNotesFromMcpData 返回 ${notes.length} 條筆記`);
                        if (notes.length > 0) {
                            console.log(`📕 [XHS] 第一條筆記原始 keys:`, Object.keys(notes[0]), 'noteCard?', !!notes[0].noteCard, 'id?', notes[0].id || notes[0].noteId);
                            const normalized = notes.map(n => normalizeNote(n) as XhsNote);
                            console.log(`📕 [XHS] 歸一化後第一條:`, JSON.stringify(normalized[0]).slice(0, 300));
                            const validNotes = normalized.filter(n => n.noteId);
                            if (validNotes.length === 0) {
                                console.warn(`📕 [XHS] ⚠️ 所有筆記歸一化後 noteId 為空！原始數據:`, JSON.stringify(notes[0]).slice(0, 500));
                            }
                            collectedNotes = validNotes.length > 0 ? validNotes : normalized;
                            cacheXsecTokensImpl(ctx.xhsCaches, collectedNotes);
                            feedsStr = collectedNotes.slice(0, 8).map((n, i) =>
                                `${i + 1}. [noteId=${n.noteId}]「${n.title || '無標題'}」by ${n.author || '未知'} (${n.likes || 0}贊)\n   ${n.desc || '（無描述）'}`
                            ).join('\n\n');
                            console.log(`📕 [XHS] feedsStr 預覽:`, feedsStr.slice(0, 300));
                        } else {
                            console.warn(`📕 [XHS] ⚠️ extractNotesFromMcpData 返回空數組! unwrapped:`, JSON.stringify(unwrapped).slice(0, 500));
                        }
                    }
                    console.log(`📕 [XHS] getUserProfile 成功，數據長度: ${profileStr.length}`);
                }
            } catch (e) {
                console.warn('📕 [XHS] getUserProfile 失敗，降級到搜索:', e);
            }
        }

    // 主頁沒打開成功時的退路：拿暱稱去搜。這裡必須把「搜不動」和「搜過了沒有」分開——
    // 以前兩種都寫成 feedsStr='（沒有搜到相關筆記）' 再回 ok:true，護欄只認 ok:false，
    // 於是角色照著說「我翻了下我的小紅書，一條都沒找到」。小紅書服務器多半在用戶自己
    // 電腦上，後台到點時人睡了機器關了，這條走得最勤，也就騙得最勤。
    if (!gotProfile) {
        if (!nickname) {
            // 只有 userId，主頁請求又掛了，連降級都沒得降 —— 這一趟什麼都沒讀到。
            return { ok: false, reason: 'unreachable' };
        }
        console.log(`📕 [XHS] 降級: 用暱稱「${nickname}」搜索...`);
        ctx.onProgress?.('xhs', '正在搜索你的筆記...');
        const searchResult = await xhsSearchImpl(xhsConf, nickname);
        if (!searchResult.success) {
            return { ok: false, reason: 'unreachable', message: searchResult.message };
        }
        if (searchResult.notes.length > 0) {
            collectedNotes = searchResult.notes;
            cacheXsecTokensImpl(ctx.xhsCaches, searchResult.notes);
            feedsStr = searchResult.notes.slice(0, 8).map((n, i) =>
                `${i + 1}. [noteId=${n.noteId}]「${n.title}」by ${n.author} (${n.likes}贊)\n   ${n.desc || '（無描述）'}`
            ).join('\n\n');
        } else {
            // 真的搜了、真的一條都沒有，這句才說得出口
            feedsStr = '（沒有搜到相關筆記）';
        }
    }

    if (ctx.lastXhsNotesRef && collectedNotes.length > 0) {
        ctx.lastXhsNotesRef.current = collectedNotes;
    }

    return { ok: true, nickname, userId, profileStr, feedsStr, gotProfile, notes: collectedNotes };
}

// ─── XHS_DETAIL ─────────────────────────────────────────────────────────────

export type XhsDetailResult =
    | { ok: true; noteId: string; detailText: string; commentsUnavailable: boolean }
    | { ok: false; reason: 'not_enabled' | 'unreachable'; noteId: string; message?: string };

/** 詳情沒讀到時（一個字都沒拿回來 / 回了 200 但正文是一句報錯）一律回 unreachable。 */
export async function runXhsDetail(
    args: { noteId: string },
    ctx: AgenticToolCtx,
): Promise<XhsDetailResult> {
    const xhsConf = resolveXhsConfig(ctx.char, ctx.realtimeConfig);
    if (!xhsConf.enabled) return { ok: false, reason: 'not_enabled', noteId: args.noteId };

    const lastNotes = ctx.lastXhsNotesRef?.current ?? [];
    let xsecToken = findXsecToken(ctx.xhsCaches, lastNotes, args.noteId);
    console.log(`📕 [XHS] AI要查看筆記詳情:`, args.noteId, xsecToken ? '(有xsecToken)' : '(無xsecToken)');

    let result = await XhsMcpClient.getNoteDetail(xhsConf.mcpUrl, args.noteId, xsecToken, { loadAllComments: true });

        if (!result.success || !result.data) {
            const cachedTitle = ctx.xhsCaches?.noteTitleCache.get(args.noteId);
            if (cachedTitle) {
                console.log(`📕 [XHS] 詳情失敗，嘗試重新搜索「${cachedTitle}」以刷新 xsecToken...`);
                ctx.onProgress?.('xhs', '正在刷新訪問憑證...');
                const refreshResult = await xhsSearchImpl(xhsConf, cachedTitle);
                if (refreshResult.success && refreshResult.notes.length > 0) {
                    cacheXsecTokensImpl(ctx.xhsCaches, refreshResult.notes);
                    if (ctx.lastXhsNotesRef) ctx.lastXhsNotesRef.current = refreshResult.notes;
                    const refreshedNote = refreshResult.notes.find(n => n.noteId === args.noteId);
                    if (refreshedNote?.xsecToken) {
                        xsecToken = refreshedNote.xsecToken;
                        console.log(`📕 [XHS] 拿到新 xsecToken，重試 detail...`);
                        ctx.onProgress?.('xhs', '正在查看筆記詳情...');
                        result = await XhsMcpClient.getNoteDetail(xhsConf.mcpUrl, args.noteId, xsecToken, { loadAllComments: true });
                    } else {
                        console.warn(`📕 [XHS] 重新搜索結果中未找到 noteId=${args.noteId}`);
                    }
                } else {
                    console.warn(`📕 [XHS] 重新搜索「${cachedTitle}」失敗:`, refreshResult.message);
                }
            } else {
                console.warn(`📕 [XHS] 詳情失敗且無緩存標題，無法重試`);
            }
        }

        // detail 自帶的 xsecToken / 評論結構 寫回緩存
        if (result.success && result.data && typeof result.data === 'object') {
            const d = result.data;
            const noteObj = (d as any).data?.note || (d as any).note || d;
            const detailToken = noteObj?.xsecToken || noteObj?.xsec_token
                || (d as any).data?.xsecToken || (d as any).data?.xsec_token
                || (d as any).xsecToken || (d as any).xsec_token;
            if (detailToken && args.noteId && ctx.xhsCaches) {
                ctx.xhsCaches.xsecTokenCache.set(args.noteId, detailToken);
                console.log(`📕 [XHS] 從 detail 緩存 xsecToken: ${args.noteId}`);
            }

            const normalizedComments = normalizeXhsComments(d);
            if (ctx.xhsCaches) {
                const caches = ctx.xhsCaches;
                const cacheComments = (comments: ReturnType<typeof normalizeXhsComments>) => {
                    for (const c of comments) {
                        if (c.commentId && c.userId) caches.commentUserIdCache.set(c.commentId, c.userId);
                        if (c.commentId && c.author) caches.commentAuthorNameCache.set(c.commentId, c.author);
                        if (c.commentId && c.parentCommentId) {
                            caches.commentParentIdCache.set(c.commentId, c.parentCommentId);
                        }
                        cacheComments(c.subComments);
                    }
                };
                if (normalizedComments.length > 0) {
                    cacheComments(normalizedComments);
                    console.log(`📕 [XHS] 緩存了 ${caches.commentUserIdCache.size} 條評論的 userId, ${caches.commentAuthorNameCache.size} 條 authorName`);
                } else {
                    console.warn(`📕 [XHS] 未找到評論數組, d keys:`, Object.keys(d as any), 'd.note keys:', (d as any).note ? Object.keys((d as any).note) : 'N/A');
                }
            }

            // XHS_DETAIL 已經拿到正文和評論，補回搜索結果中的同一張卡。
            // 後續 XHS_SHARE 直接複用這裡的數據，不額外發起詳情請求。
            if (ctx.lastXhsNotesRef) {
                const detailNote = normalizeXhsLiteDetail(d);
                const matched = ctx.lastXhsNotesRef.current.find(n => n.noteId === args.noteId);
                const enriched: XhsNote = {
                    ...matched,
                    ...detailNote,
                    noteId: detailNote.noteId || args.noteId,
                    title: detailNote.title || matched?.title || '',
                    desc: detailNote.desc || matched?.desc || '',
                    author: detailNote.author || matched?.author || '',
                    authorId: detailNote.authorId || matched?.authorId || '',
                    xsecToken: detailNote.xsecToken || detailToken || xsecToken || matched?.xsecToken,
                    comments: detailNote.comments || matched?.comments,
                };
                const index = ctx.lastXhsNotesRef.current.findIndex(n => n.noteId === args.noteId);
                if (index >= 0) {
                    ctx.lastXhsNotesRef.current = ctx.lastXhsNotesRef.current.map((note, i) =>
                        i === index ? enriched : note
                    );
                }
            }
        }

        const detailData = result.success ? result.data : null;
        let detailText: string;
        let commentsUnavailable = false;
        if (detailData) {
            if (typeof detailData === 'string') {
                // 服務器回了 200，正文本身卻是一句報錯。這跟「一個字都沒拿回來」是同一件事：
                // 這次沒讀到筆記。走同一條 unreachable，別包成「成功但正文是一句報錯」。
                if (includesAnyScript(detailData, '失败') || detailData.includes('not found')) {
                    return {
                        ok: false,
                        reason: 'unreachable',
                        noteId: args.noteId,
                        message: detailData.slice(0, 200),
                    };
                }
                detailText = detailData.slice(0, 5000);
            } else {
                const innerData = (detailData as any).data && typeof (detailData as any).data === 'object' ? (detailData as any).data : null;
                const note = innerData?.note || (detailData as any).note || detailData;
                const normalizedNote = normalizeNote(note);
                const noteTitle = normalizedNote.title;
                const noteDesc = normalizedNote.desc.slice(0, 1500);
                const noteAuthor = normalizedNote.author;
                const noteLikes = normalizedNote.likes;
                const noteCollects = normalizedNote.collects;
                const noteShareCount = normalizedNote.shareCount;
                const noteCommentCount = normalizedNote.commentCount;
                const noteTime = note.time ? new Date(note.time).toLocaleString('zh-CN') : '';
                const noteIp = note.ipLocation || note.ip_location || '';

                let noteSection = `📝 筆記詳情:\n標題: ${noteTitle}\n作者: ${noteAuthor}`;
                if (noteTime) noteSection += `\n發佈時間: ${noteTime}`;
                if (noteIp) noteSection += `\n IP: ${noteIp}`;
                noteSection += `\n互動: ${noteLikes}贊 ${noteCollects}收藏 ${noteCommentCount}評論 ${noteShareCount}分享`;
                noteSection += `\n\n正文:\n${noteDesc}`;

                const commentArr = normalizeXhsComments(detailData);
                const commentsStatus = innerData?.comments_status
                    || (detailData as any).comments_status
                    || innerData?.comment_read_status
                    || (detailData as any).comment_read_status;
                commentsUnavailable = commentsStatus === 'unavailable'
                    || !!innerData?.comments_error
                    || !!(detailData as any).comments_error;

                let commentsSection = '';
                if (commentArr.length > 0) {
                    const formatComment = (c: any, indent = '') => {
                        const name = c.author || '匿名';
                        const content = c.content || '';
                        const likes = c.likes || 0;
                        const cid = c.commentId || '';
                        let line = `${indent}${name}: ${content} (${likes}贊) [commentId=${cid}]`;
                        const subs = c.subComments || [];
                        if (Array.isArray(subs) && subs.length > 0) {
                            line += '\n' + subs.slice(0, 10).map((s: any) => formatComment(s, indent + '  ↳ ')).join('\n');
                        }
                        return line;
                    };
                    commentsSection = `\n\n💬 評論區 (${commentArr.length}條):\n` +
                        commentArr.slice(0, 30).map((c: any) => formatComment(c)).join('\n');
                } else if (commentsUnavailable) {
                    commentsSection = '\n\n💬 評論區: （讀取失敗；不能據此判斷為沒有評論，也不要編造評論內容）';
                } else {
                    commentsSection = '\n\n💬 評論區: （暫無評論）';
                }

                detailText = (noteSection + commentsSection).slice(0, 8000);
            }
        } else {
            // 詳情一個字都沒拿回來（連不上 / 沒權限 / 刷新 xsecToken 重試後依然是空）。
            // 以前這裡回 ok:true，正文塞一句「[加載失敗: …]」：護欄只認 ok:false，於是這條
            // 失敗被當成正常結果餵給模型——輕則把報錯原文抄進消息，重則直接說「我看了這條筆記」。
            return {
                ok: false,
                reason: 'unreachable',
                noteId: args.noteId,
                message: result.error || '無法獲取筆記詳情，可能需要先在搜索/瀏覽結果中看到這條筆記',
            };
        }

    // 走到這裡 detailText 一定是真讀到的內容：拿不回來和「正文是一句報錯」都已經在上面
    // 回了 ok:false。
    return { ok: true, noteId: args.noteId, detailText, commentsUnavailable };
}

// ─── 共用日期解析 (READ_DIARY / FS_READ_DIARY 共用) ─────────────────────────

export function parseDiaryDate(dateInput: string): string {
    const now = new Date();
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) return dateInput;
    if (dateInput === '今天') return getLocalDateKey(now);
    if (dateInput === '昨天') { const d = new Date(now); d.setDate(d.getDate() - 1); return getLocalDateKey(d); }
    if (dateInput === '前天') { const d = new Date(now); d.setDate(d.getDate() - 2); return getLocalDateKey(d); }
    const daysAgo = dateInput.match(/^(\d+)天前$/);
    if (daysAgo) { const d = new Date(now); d.setDate(d.getDate() - parseInt(daysAgo[1])); return getLocalDateKey(d); }
    const monthDay = dateInput.match(/(\d{1,2})月(\d{1,2})/);
    if (monthDay) return `${now.getFullYear()}-${monthDay[1].padStart(2, '0')}-${monthDay[2].padStart(2, '0')}`;
    const parsed = new Date(dateInput);
    if (!isNaN(parsed.getTime())) return getLocalDateKey(parsed);
    return '';
}

// ─── Dispatch (worker 工具循環用) ───────────────────────────────────────────

/**
 * 按 tool name 調度。主動消息 2.0 的 worker 工具循環（worker/amsg/src/index.ts）走這裡；
 * 本地聊天不經過此入口, 直接 import 具體 run* 函數。
 */
export async function dispatchAgenticTool(
    toolName: string,
    args: any,
    ctx: AgenticToolCtx,
): Promise<unknown> {
    switch (toolName) {
        case 'recall': return runRecall(args, ctx);
        case 'web_search': return runSearch(args, ctx);
        case 'notion_read_diary': return runReadDiary(args, ctx);
        case 'feishu_read_diary': return runFsReadDiary(args, ctx);
        case 'read_note': return runReadNote(args, ctx);
        case 'xhs_search': return runXhsSearch(args, ctx);
        case 'xhs_browse': return runXhsBrowse(args, ctx);
        case 'xhs_my_profile': return runXhsMyProfile(args, ctx);
        case 'xhs_detail': return runXhsDetail(args, ctx);
        default:
            throw new Error(`Unknown agentic tool: ${toolName}`);
    }
}
