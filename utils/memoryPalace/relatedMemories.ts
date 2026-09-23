/**
 * Memory Palace — 取相關記憶的共享 helper
 *
 * 在記憶提取流程中（聊天 buffer 路徑 + 舊聊天遷移路徑），
 * 我們需要讓 LLM 看到一些"已經存在的、可能相關的舊記憶"，
 * 這樣它才能：
 *   ① 避免誤解隱式指代
 *   ② 輸出 relatedTo 標記，把新記憶和舊事件綁成同一個 EventBox
 *
 * 核心策略：**細粒度 per-event 查詢**，而不是把大段文本切 3 段 embed。
 * - 遷移路徑：把 YAML 列表 (`- 事件X`) 拆成每個 bullet 一個 query
 * - 聊天 buffer 路徑：每條 ≥4 字的 user 消息獨立 query
 * - 切不出細粒度（非 YAML / 全是短消息）時自動 fallback 到舊的 3 段切法
 *
 * 結果合併：同一記憶取最高相似度；按相似度降序取 top N。
 */

import type { EmbeddingConfig, RemoteVectorConfig } from './types';
import type { RelatedMemoryRef } from './extraction';
import { getEmbeddings } from './embedding';
import { vectorSearch, isRemoteSearchBroken } from './vectorSearch';
import { ensureFloat32 } from './db';

/** 從 localStorage 讀取遠程向量配置，判斷本次是走遠程還是本地路徑。
 *  關鍵：enabled=false 或未完成 initialized 時必須視為"沒有遠程配置"，
 *  否則用戶在 UI 裡關掉 Supabase 之後，這條路徑還會把舊配置餵給 vectorSearch，
 *  繼續嘗試連遠程 → 報連不上。其他模塊（pipeline / digestion / db /
 *  eventBoxCompression）都是這個寫法，這裡是歷史漏檢。 */
function getLocalRemoteConfig(): RemoteVectorConfig | undefined {
    try {
        const raw = localStorage.getItem('os_remote_vector_config');
        if (!raw) return undefined;
        const config = JSON.parse(raw) as RemoteVectorConfig;
        return (config.enabled && config.initialized) ? config : undefined;
    } catch { return undefined; }
}

export interface FetchRelatedOptions {
    /** 單段查詢的相似度閾值，默認 0.40（細粒度 query 下給點寬鬆度） */
    threshold?: number;
    /** 單段查詢取 top 幾條，默認 3（太少會錯過稍微改寫的同事件） */
    perQueryTopK?: number;
    /** 合併後最多返回多少條，默認 15 */
    maxTotal?: number;
    /** 內容截斷長度，默認 100 字 */
    contentTruncate?: number;
}

/**
 * 用一組文本片段搜出相關舊記憶。
 *
 * 使用場景：
 * - 緩衝區提取：傳每條 ≥4 字的 user 消息
 * - 舊記憶遷移：傳拆分後的 bullet 列表
 *
 * @param snippets 用於做向量查詢的文本片段（精細粒度，一條事件/一條消息一段）
 */
export async function fetchRelatedMemoriesForExtraction(
    snippets: string[],
    charId: string,
    embeddingConfig: EmbeddingConfig,
    opts: FetchRelatedOptions = {},
): Promise<RelatedMemoryRef[]> {
    const validSnippets = snippets.map(s => s.trim()).filter(s => s.length > 0);
    if (validSnippets.length === 0) return [];

    // 防禦性 cap：即便調用方傳入一大堆 snippet（比如 bullets 路徑 80+），也不要全跑
    // 否則 embedding/vectorSearch/內存都會炸。均勻抽樣降到 MAX 條。
    //
    // 歷史：曾經死扣到 15。原因是當時遠程 Supabase RPC 一旦 CORS 失敗會被
    // 每條 query 各踩一次 + 回退本地全量加載，30 條 query 直接撕碎 V8
    // typed-array arena。後來加了會話級遠程熔斷 + 本地批處理一次加載、
    // 內存串行打分（vectorSearch.ts / relatedMemories.ts 遠程熔斷分支），
    // 30 條已經不再是問題。
    //
    // 提到 25 是為了換召回質量：被抽樣跳過的 bullet 沒機會讓 LLM 看到
    // "新事件 vs 舊事件"的關聯提示，跨 sub-batch 的事件盒合併率會偏低。
    // 25 比 15 多覆蓋 67% 的 bullet，每 sub-batch 代價約 +5-10s embedding/打分。
    const HARD_MAX_SNIPPETS = 25;
    let workingSnippets = validSnippets;
    if (validSnippets.length > HARD_MAX_SNIPPETS) {
        const step = validSnippets.length / HARD_MAX_SNIPPETS;
        workingSnippets = [];
        for (let i = 0; i < HARD_MAX_SNIPPETS; i++) {
            workingSnippets.push(validSnippets[Math.floor(i * step)]);
        }
        console.log(`🏰 [RelatedMemories] ${validSnippets.length} 段 snippet 降採樣到 ${HARD_MAX_SNIPPETS}（防主線程阻塞）`);
    }

    const threshold = opts.threshold ?? 0.40;
    const perQueryTopK = opts.perQueryTopK ?? 3;
    const maxTotal = opts.maxTotal ?? 15;
    const contentTruncate = opts.contentTruncate ?? 100;

    try {
        // 並行 batch embedding（一次請求拿回所有向量，便宜）
        const vectors = await getEmbeddings(workingSnippets, embeddingConfig);

        const searchResults: Array<{ node: any; similarity: number }[]> = [];

        // 本地 vs 遠程分路：本地路徑之前每個 query 都獨立 getAllByCharId 加載全量向量庫，
        // 30 次冗餘加載 500+ × 1024 維 Float32Array 瞬間 60MB 分配，GC 跟不上就 OOM 崩 tab。
        // 改成：本地路徑**一次性**加載向量 + 節點索引，內存裡串行打分；遠程路徑保留
        // concurrency 4 的 Promise.all（每個 query 是獨立 HTTP 無法合併）。
        //
        // ⚠️ 遠程熔斷：isRemoteSearchBroken() 在首次 Supabase RPC 拋網絡錯誤
        //（CORS / 500 無 CORS 頭）後會置 true，從那一刻起本會話直接跳過遠程
        // 走"一次性加載、內存裡串行打分"的本地快路徑 —— 否則遷移批量
        // 查詢會每條都踩一次 CORS 失敗 + 回退到本地 getAllByCharId，15 次冗餘
        // 全量加載能把 tab 凍住好幾秒直到 GC。
        const remoteCfg = getLocalRemoteConfig();
        let usingRemote = !!(remoteCfg?.enabled && remoteCfg?.initialized) && !isRemoteSearchBroken();

        // 本地快路徑的 state（remote 中途熔斷時複用，避免重複加載）
        let localVectors: any[] | null = null;
        let localNodeMap: Map<string, any> | null = null;
        const { cosineSimilarity } = await import('./embedding');
        async function ensureLocalIndex(): Promise<boolean> {
            if (localVectors && localNodeMap) return localVectors.length > 0;
            const { MemoryVectorDB, MemoryNodeDB } = await import('./db');
            localVectors = await MemoryVectorDB.getAllByCharId(charId);
            if (localVectors.length === 0) {
                localNodeMap = new Map();
                return false;
            }
            const allNodes = await MemoryNodeDB.getByCharId(charId);
            localNodeMap = new Map(allNodes.map(n => [n.id, n]));
            return true;
        }
        function localScoreOne(qv: Float32Array): { node: any; similarity: number }[] {
            const scored: { memoryId: string; similarity: number }[] = [];
            for (const ev of localVectors!) {
                // ensureFloat32 兼容三種存儲形態，防禦式兜底；正常情況下
                // ev.vector 出 DB 時已是 Float32Array，這一支幾乎是 no-op。
                const sim = cosineSimilarity(qv, ensureFloat32(ev.vector));
                if (sim >= threshold) {
                    scored.push({ memoryId: ev.memoryId, similarity: sim });
                }
            }
            scored.sort((a, b) => b.similarity - a.similarity);
            const top = scored.slice(0, perQueryTopK);
            const hits: { node: any; similarity: number }[] = [];
            for (const s of top) {
                const node = localNodeMap!.get(s.memoryId);
                if (node && !node.archived) hits.push({ node, similarity: s.similarity });
            }
            return hits;
        }

        if (usingRemote) {
            const CONCURRENCY = 4;
            let consumed = 0;
            for (let i = 0; i < vectors.length; i += CONCURRENCY) {
                // 每輪開始前重新檢查熔斷：只要前一批裡有任何一條觸發 markRemoteBroken，
                // 剩餘查詢就立刻切到本地快路徑，不再踩 CORS。
                if (isRemoteSearchBroken()) {
                    usingRemote = false;
                    break;
                }
                const batch = vectors.slice(i, i + CONCURRENCY);
                const batchResults = await Promise.all(
                    batch.map(vec => vectorSearch(vec, charId, threshold, perQueryTopK, remoteCfg))
                );
                searchResults.push(...batchResults);
                consumed = i + batch.length;
                await new Promise(r => setTimeout(r, 0)); // 讓出主線程
            }
            if (!usingRemote) {
                // 遠程中途掛了：剩餘 query 走本地快路徑（不丟棄已拿到的 batchResults）
                const hasLocal = await ensureLocalIndex();
                if (!hasLocal) {
                    // 本地沒東西：剩餘全補空即可（保持 searchResults 長度與 vectors 對齊不是硬需求，
                    // 因為後面是合併去重，空批次不會引入錯誤）
                } else {
                    console.log(`🏰 [RelatedMemories] 遠程熔斷後切本地：剩 ${vectors.length - consumed} 條 query 走本地路徑`);
                    for (let qi = consumed; qi < vectors.length; qi++) {
                        searchResults.push(localScoreOne(vectors[qi]));
                        if ((qi + 1) % 5 === 0 && qi < vectors.length - 1) {
                            await new Promise(r => setTimeout(r, 0));
                        }
                    }
                }
            }
        } else {
            // 本地路徑：一次性加載，內存裡打分
            const hasLocal = await ensureLocalIndex();
            if (!hasLocal) return [];
            for (let qi = 0; qi < vectors.length; qi++) {
                searchResults.push(localScoreOne(vectors[qi]));
                // 每 5 條 query 讓一下主線程
                if ((qi + 1) % 5 === 0 && qi < vectors.length - 1) {
                    await new Promise(r => setTimeout(r, 0));
                }
            }
        }

        // 合併去重：同一記憶保留最高相似度
        const seen = new Map<string, { node: any; similarity: number }>();
        for (const results of searchResults) {
            for (const r of results) {
                const existing = seen.get(r.node.id);
                if (!existing || r.similarity > existing.similarity) {
                    seen.set(r.node.id, r);
                }
            }
        }

        // 按相似度降序
        const related = [...seen.values()]
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, maxTotal);

        return related.map(r => ({
            id: r.node.id,
            room: r.node.room,
            content: (r.node.content || '').slice(0, contentTruncate),
        }));
    } catch (e: any) {
        console.warn(`🏰 [RelatedMemories] 檢索失敗（不影響主流程）: ${e?.message || e}`);
        return [];
    }
}

// ─── 細粒度拆分：YAML bullets（遷移路徑用） ──────────────

/**
 * 把 YAML 列表格式的總結文本拆成每個 bullet 一個片段。
 *
 * 典型輸入：
 *   - 今天吃了蛋糕，很開心
 *   - 晚上和媽媽吵架了
 *   - 決定明天去跑步
 * 輸出：[
 *   "今天吃了蛋糕，很開心",
 *   "晚上和媽媽吵架了",
 *   "決定明天去跑步",
 * ]
 *
 * 兼容 "- " / "-  " / "- \t" 以及以連字符開頭的多行內容（僅切行首的 -）。
 *
 * @returns bullet 片段數組；如果切不出 ≥ 2 條，返回空數組表示"不是列表格式"
 */
/**
 * 支持的 bullet 字符：ASCII hyphen、Chinese 全角破折號 －、em dash —、bullet
 * dot •、middle dot ·、asterisk *。LLM / Markdown 渲染器可能產出任一種，
 * 只認 ASCII `-` 會漏掉很多真實列表。
 */
const BULLET_LEAD_RE = /[-－—•·*]/;
const BULLET_SPLIT_RE = /\n(?=[-－—•·*][\s\u3000])/;      // 換行後緊跟任一 bullet 字符 + 空白
const BULLET_STRIP_RE = /^[-－—•·*][\s\u3000]+/;           // 行首 bullet 字符 + 空白

export function splitYamlBullets(text: string): string[] {
    if (!text) return [];
    const normalized = text.replace(/\r\n/g, '\n').trim();
    if (!normalized) return [];
    // 若整段根本沒有任一 bullet 字符 → 必然不是列表
    if (!BULLET_LEAD_RE.test(normalized)) return [];
    // 按"換行 + 行首 bullet"切
    const parts = normalized.split(BULLET_SPLIT_RE);
    const bullets: string[] = [];
    for (const part of parts) {
        const s = part.replace(BULLET_STRIP_RE, '').trim();
        if (s.length >= 4) bullets.push(s);
    }
    // 至少 2 條才算有效列表
    return bullets.length >= 2 ? bullets : [];
}

/**
 * 給遷移路徑用的細粒度拆分：
 * 把一批 daily logs 拍平成 bullet 列表。
 * 每條 bullet 前綴上日期，方便 embedding 時保留時間線索。
 *
 * 如果無法拆出 bullets（有些用戶可能改過歸檔模板），返回空數組；
 * 調用方應 fallback 到傳統的 3 段切法。
 */
export function splitLogsToBullets(
    logs: { date: string; summary: string }[],
): string[] {
    const bullets: string[] = [];
    let usedBulletFormat = 0;
    for (const log of logs) {
        const items = splitYamlBullets(log.summary);
        if (items.length > 0) {
            usedBulletFormat++;
            for (const it of items) {
                bullets.push(`[${log.date}] ${it}`);
            }
        } else {
            // 整條日誌作為一個片段兜底
            if (log.summary.trim().length >= 4) {
                bullets.push(`[${log.date}] ${log.summary.trim().slice(0, 300)}`);
            }
        }
    }
    // 只有"大部分日誌都是 bullet 格式"才認為這個策略有效
    const ok = usedBulletFormat >= Math.max(1, Math.floor(logs.length * 0.3));
    return ok ? bullets : [];
}

// ─── 細粒度拆分：per-message（buffer 路徑用） ─────────────

/**
 * Buffer 路徑：每條 ≥ MIN_LEN 字的 user 消息獨立作為 query。
 * 短語氣詞/純標點/URL 過濾掉。
 *
 * 如果可用消息數 < 2，返回空數組，讓調用方 fallback 到傳統 3 段切法。
 */
export function splitMessagesToSpikes(
    messages: { role: string; content: string }[],
    minLen: number = 4,
    maxPerMsg: number = 300,
): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const m of messages) {
        if (m.role !== 'user') continue;
        let text = (m.content || '').trim();
        if (!text) continue;
        // 剝離 URL（embedding 裡是隨機噪聲）
        text = text.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
        // 有意義字符數判斷
        const meaningful = text.replace(/[\s\p{P}]/gu, '');
        if (meaningful.length < minLen) continue;
        const key = text.slice(0, 100);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text.slice(0, maxPerMsg));
    }
    return out.length >= 2 ? out : [];
}

// ─── 兜底：傳統 3 段切法（保留做 fallback） ──────────────

/**
 * 從一段消息列表中切出頭/中/尾 3 段文本片段。
 * 兜底：當 per-message / per-bullet 拆分失敗時用。
 */
export function sampleSnippetsFromMessages(
    messages: { content: string }[],
    sampleSize: number = 5,
    snippetCharLimit: number = 300,
): string[] {
    const len = messages.length;
    if (len === 0) return [];

    const ranges = [
        messages.slice(0, sampleSize),
        messages.slice(
            Math.max(0, Math.floor(len / 2) - Math.floor(sampleSize / 2)),
            Math.floor(len / 2) + Math.ceil(sampleSize / 2),
        ),
        messages.slice(Math.max(0, len - sampleSize)),
    ];

    const snippets: string[] = [];
    for (const range of ranges) {
        const text = range.map(m => m.content).join('\n').slice(0, snippetCharLimit);
        if (text.trim()) snippets.push(text);
    }
    return snippets;
}
