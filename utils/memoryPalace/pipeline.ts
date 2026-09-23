import { loadRangeMessageContents } from './rangeMessagePage';
import { loadCharacterContextMessages } from '../chatContextRange';
/**
 * Memory Palace — 集成管線 (Pipeline)
 *
 * 對外暴露兩個主要函數：
 * 1. retrieveMemories() — 檢索管線，AI 回覆前調用
 * 2. processNewMessages() — 緩衝區機制，AI 回覆後後台調用
 *
 * 緩衝區機制（替代舊的 TopicLoom + 封盒方案）：
 * - 熱區：按角色檔位保留最近一段消息在聊天上下文
 * - 緩衝區：熱區之前、高水位之後的消息
 * - 緩衝區達到角色檔位閾值時觸發：LLM 提取記憶 → Embedding → 更新高水位
 * - 保留緩衝區尾部 15% 作為下次提取的上下文銜接
 *
 * LLM 調用策略：
 * - 記憶提取 → 用 LightLLMConfig（來自 memoryPalaceConfig.lightLLM 全局副 API，
 *   與情緒 API emotionConfig.api 完全獨立）
 * - retrieveMemories() 本身仍是純檢索；ChatApp 每輪只做純本地 Context Analyzer，
 *   幫主模型理解當下話語的承接方式，不額外調用 LLM，也不改變舊召回排序
 */

import type { CharacterAccommodationPolicy, MemoryPalaceWaterlineConfig, Message } from '../../types';
import type { EmbeddingConfig, EventBox, MemoryNode, PersonalityStyle, RemoteVectorConfig, ScoredMemory } from './types';
import {
    countOneShotPendingMessages,
    countUnprocessedBufferMessages,
    getOneShotTargetHighWaterMark,
} from './bufferCount';
import {
    DEFAULT_MEMORY_PALACE_WATERLINE,
    resolveMemoryPalaceWaterline,
} from './waterline';

/** 從 localStorage 讀取遠程向量配置（避免在每個調用點都傳參） */
function getRemoteVectorConfig(): RemoteVectorConfig | undefined {
    try {
        const raw = localStorage.getItem('os_remote_vector_config');
        if (!raw) return undefined;
        const config = JSON.parse(raw) as RemoteVectorConfig;
        return (config.enabled && config.initialized) ? config : undefined;
    } catch { return undefined; }
}

/** 從 localStorage 讀取 rerank 配置。關閉或未配齊時返回 undefined，調用方跳過。 */
interface StoredRerankConfig {
    enabled?: boolean;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    topN?: number;
}
function getRerankConfig(): { baseUrl: string; apiKey: string; model: string; topN: number } | undefined {
    try {
        const raw = localStorage.getItem('os_memory_palace_config');
        if (!raw) return undefined;
        const parsed = JSON.parse(raw);
        const r: StoredRerankConfig | undefined = parsed?.rerank;
        if (!r?.enabled || !r.baseUrl || !r.apiKey || !r.model) return undefined;
        return {
            baseUrl: r.baseUrl,
            apiKey: r.apiKey,
            model: r.model,
            topN: Math.max(1, Math.min(20, r.topN ?? 5)),
        };
    } catch { return undefined; }
}
import { extractMemoriesFromBuffer } from './extraction';
import type { RelatedMemoryRef, PinnedMemoryRef } from './extraction';
import { fetchRelatedMemoriesForExtraction, sampleSnippetsFromMessages, splitMessagesToSpikes } from './relatedMemories';
import { getReceiptIdsInRange } from './recallReceipts';
import { vectorizeAndStore, checkModelConsistency, rebuildAllVectors } from './vectorStore';
import { buildLinks, strengthenCoActivated } from './links';
import { hybridSearch } from './hybridSearch';
import { getEmbeddings } from './embedding';
import { isRemoteSearchBroken } from './vectorSearch';
import { spreadActivation } from './activation';
import { applyPriming, checkRumination } from './priming';
import { expandAndFormat } from './formatter';
import { runConsolidation } from './consolidation';
import { rerankDocuments } from './rerank';
// 認知消化由用戶在記憶宮殿 App 手動觸發，不在聊天管線中自動運行
import { MemoryNodeDB, MemoryVectorDB, MemoryLinkDB, AnticipationDB, EventBoxDB } from './db';
import { DB } from '../db';
import { isMessageSemanticallyRelevant, formatMessageForPrompt } from '../messageFormat';
import { sanitizeQuerySourceMessages } from './querySanitizer';
import { getLocalDateKey } from '../localDate';
import { extractExternalMemoryText } from './externalMemory';
import {
    analyzeLocalContext,
    RECALL_GATE_ROUTE_THRESHOLD,
    type RecallPlan,
} from './recallRouter';
import {
    analyzeExplicitEntitySignals,
    lookupExplicitEntityCandidates,
    mergeExplicitEntityCandidates,
    type ExplicitEntityAnalysis,
} from './explicitEntityRecall';
import {
    buildEventBoxLightIndex,
    lookupEventBoxLightCandidates,
    mergeEventBoxLightCandidates,
} from './eventBoxLightIndex';
import { analyzeUserInteraction } from './interactionAdaptation';
import { analyzeDeepEngagement } from './deepEngagement';
import {
    analyzeConversationEngagement,
    clearConversationEngagementState,
    shouldUseLegacyDeepEngagement,
} from './conversationEngagement';
import {
    createRecallTrace,
    finishRecallTrace,
    type RecallEntryPoint,
    type RecallRetrievalTelemetry,
    type RecallTrace,
    type RecallTraceStage,
} from './trace';
import {
    getLocalMemoryPalaceHighWaterMark,
    getReliableMemoryPalaceHighWaterMark,
    setReliableMemoryPalaceHighWaterMark,
} from './highWaterMark';

// ─── 輕量 LLM 配置類型 ───────────────────────────────

/**
 * 輕量 LLM 配置，用於記憶提取等後台任務。
 * 來源是 memoryPalaceConfig.lightLLM（全局副 API），與情緒 API（emotionConfig.api）獨立。
 * 這樣可以用便宜快速的小模型（如 DeepSeek-V2-Lite、GLM-4-Flash）
 * 而不是主聊天模型。
 */
export interface LightLLMConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

// ─── 日期區間記憶加載 ────────────────────────────────

/**
 * 按 createdAt 區間從本地取記憶節點。
 * - 過濾當前 charId、僅 embedded、非 summary
 * - archived 節點也參與匹配（它們保留原事件的 createdAt）；命中後路由到其 EventBox 的 summary
 * - 每個 range 最多返回 5 條，整體去重
 */
async function loadMemoriesByDateRanges(
    charId: string,
    ranges: Array<{ start: number; end: number }>,
): Promise<import('./types').MemoryNode[]> {
    if (ranges.length === 0) return [];
    const all = await MemoryNodeDB.getByCharId(charId);
    const out: import('./types').MemoryNode[] = [];
    const seen = new Set<string>();
    for (const range of ranges) {
        const inRange = all.filter(n => n.createdAt >= range.start && n.createdAt < range.end && n.embedded !== false);
        const sorted = inRange.sort((a, b) => b.importance - a.importance).slice(0, 5);
        for (const n of sorted) {
            // archived 節點 → 路由到其 box 的 summary（如果有）
            if (n.archived && n.eventBoxId) {
                const { EventBoxDB } = await import('./db');
                const box = await EventBoxDB.getById(n.eventBoxId);
                if (box?.summaryNodeId) {
                    if (seen.has(box.summaryNodeId)) continue;
                    const sum = await MemoryNodeDB.getById(box.summaryNodeId);
                    if (sum && !sum.archived) {
                        seen.add(sum.id);
                        out.push(sum);
                        continue;
                    }
                }
                // 沒有 summary 就跳過（archived 獨行條不該返回）
                continue;
            }
            if (seen.has(n.id)) continue;
            seen.add(n.id);
            out.push(n);
        }
    }
    return out;
}

// ─── 自動歸檔建議構造 ────────────────────────────────

/**
 * 把一批 MemoryNode 按 createdAt 日期 group，合成 YAML bullets 格式的 MemoryFragment 候選。
 *
 * 格式：
 *   date: "2026-04-17"
 *   summary: "- 我今天看 user 跟朋友吵架，心裡擔了好一會兒\n- 我今晚和 user 聊到了編程"
 *   mood: 'palace'
 *
 * 同日期多條記憶會合併成一條 MemoryFragment（summary 裡多行 bullets）。
 * caller 拿到後還要和 char.memories 裡已存在的同日期 'palace' 條目 merge，
 * 避免一天多次 buffer 觸發產生重複條目。
 *
 * 返回 null：memories 為空（沒有新記憶，不需要歸檔動作）。
 */
export function buildAutoArchiveFragments(
    memories: { id: string; content: string; createdAt: number }[],
    hideBeforeMessageId: number,
    linkToPalace = false,
): NonNullable<PipelineResult['autoArchive']> | null {
    if (memories.length === 0) return null;
    if (linkToPalace) return {
        hideBeforeMessageId,
        fragments: memories.map(memory => ({
            id: `mp_link_${memory.id}`,
            date: getLocalDateKey(new Date(memory.createdAt)),
            summary: memory.content,
            mood: 'palace',
            palaceMemoryId: memory.id,
        })),
    };

    const fmtDate = (ts: number): string => {
        const d = new Date(ts);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    // 按日期 group；同一天內按 createdAt 升序
    // 零 LLM 調用：palace extraction 那 1 次已經按"基礎規則 + 用戶追加風格"產出了
    // 第一人稱、控制字數的 content（見 extraction.ts 的 buildRulesBlock + 追加風格），
    // 這裡直接拼 bullets 就行。想要自定義風格 → 在"記憶歸檔設置"裡選模板即可，
    // extraction 階段就會把用戶模板作為額外風格偏好塞進 palace LLM 系統提示詞。
    const byDate = new Map<string, string[]>();
    const sortedMems = [...memories].sort((a, b) => a.createdAt - b.createdAt);
    for (const m of sortedMems) {
        const date = fmtDate(m.createdAt);
        const arr = byDate.get(date) || [];
        arr.push(`- ${m.content.replace(/\n/g, ' ').trim()}`);
        byDate.set(date, arr);
    }

    const fragments: { id: string; date: string; summary: string; mood: string }[] = [];
    for (const [date, bullets] of byDate) {
        fragments.push({
            id: `mp_auto_${date}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            date,
            summary: bullets.join('\n'),
            mood: 'palace',
        });
    }

    fragments.sort((a, b) => a.date.localeCompare(b.date));
    return { fragments, hideBeforeMessageId };
}


/**
 * 把新產出的 palace MemoryFragment 合併進已有 char.memories。
 *
 * 策略：
 *  - 已有同日期的 mood='palace' 條目 → 把新的 bullets 追加到它的 summary 裡（合併）
 *  - 沒有同日期的 mood='palace' → 作為新條目追加
 *  - 其它 mood（手動歸檔 'archive' 等）的同日期條目不碰，讓它們並存
 *
 * 好處：同一天多次 buffer 觸發不會產生多條 palace 記錄；手動歸檔和自動歸檔互不衝突。
 */
export function mergePalaceFragmentsIntoMemories(
    existing: import('../../types').MemoryFragment[],
    incoming: { id: string; date: string; summary: string; mood: string; palaceMemoryId?: string }[],
): import('../../types').MemoryFragment[] {
    if (incoming.length === 0) return existing;

    // 先按 date 建 index：只關心 mood='palace' 的
    const palaceByDate = new Map<string, number>(); // date → index in result
    const result = existing.slice();
    for (let i = 0; i < result.length; i++) {
        const m = result[i];
        if (m.mood === 'palace' && !m.palaceMemoryId) palaceByDate.set(m.date, i);
    }

    for (const frag of incoming) {
        if (frag.palaceMemoryId) {
            // Never merge a new link into a pre-upgrade daily snapshot, even on the same date.
            if (!result.some(memory => memory.palaceMemoryId === frag.palaceMemoryId)) result.push(frag);
            continue;
        }
        const existingIdx = palaceByDate.get(frag.date);
        if (existingIdx !== undefined) {
            // merge：把新 bullets 直接追加到 summary。
            // 不做字符串去重——LLM 偶爾寫出相同短句的合法情況會被誤殺，
            // high-water-mark 已保證消息不會被重複處理；尾部 15% 回滾那幾條
            // 即使被重提，多一條 bullet 比丟數據強。
            const old = result[existingIdx];
            const existingBullets = old.summary.split('\n').map(s => s.trim()).filter(Boolean);
            const newBullets = frag.summary.split('\n').map(s => s.trim()).filter(Boolean);
            result[existingIdx] = {
                ...old,
                summary: [...existingBullets, ...newBullets].join('\n'),
            };
        } else {
            result.push(frag);
            palaceByDate.set(frag.date, result.length - 1);
        }
    }

    return result;
}

// ─── 檢索管線（AI 回覆前） ────────────────────────────

/**
 * 從消息列表末尾拆分"當前一輪"的兩個語義部分：
 *
 * 調用時機是 AI 回覆前，所以消息末尾通常是：
 *   ... [user] [user] [assistant] [user] [user] [user]
 *                                     └─── userIntent ───┘
 *                   └──────── contextTurns ────────┘
 *
 * - userIntent：末尾連續 user 消息 —— 用戶剛說的話，是本次檢索的真正主語。
 *   作為**主 query**，短而關鍵的詞（"外公"、"2025年11月29日"）不會被
 *   char 的長回覆稀釋。
 *
 * - contextTurns：更早的 assistant 回覆 + 上一輪 user 消息 —— 話題延續語境。
 *   作為**副 query**，提供背景召回，但分數會被折扣，永遠不會壓過 userIntent。
 *
 * 總計 cap 在 15 條，user 最多佔 10 條留出 context 預算。
 */
function splitLastTurnQueries(messages: Message[]): {
    userIntent: Message[];
    contextTurns: Message[];
    /** 舊版拼接形式，僅用於兜底（userIntent 為空時） */
    fallbackAll: Message[];
} {
    if (messages.length === 0) return { userIntent: [], contextTurns: [], fallbackAll: [] };

    const MAX = 15;
    const USER_CAP = 10;
    const userIntent: Message[] = [];
    const contextTurns: Message[] = [];
    let i = messages.length - 1;

    // Phase 1: 末尾連續 user 消息（用戶剛發的）→ userIntent
    while (i >= 0 && messages[i].role === 'user' && userIntent.length < USER_CAP) {
        userIntent.unshift(messages[i]);
        i--;
    }

    const contextBudget = MAX - userIntent.length;

    // Phase 2: 緊鄰的 assistant 回覆（上一輪角色回答）→ contextTurns
    while (i >= 0 && messages[i].role === 'assistant' && contextTurns.length < contextBudget) {
        contextTurns.unshift(messages[i]);
        i--;
    }

    // Phase 3: 再往回收集連續 user 消息（上一輪用戶輸入）→ contextTurns
    while (i >= 0 && messages[i].role === 'user' && contextTurns.length < contextBudget) {
        contextTurns.unshift(messages[i]);
        i--;
    }

    const fallbackAll = [...contextTurns, ...userIntent];
    return {
        userIntent,
        contextTurns,
        fallbackAll: fallbackAll.length > 0 ? fallbackAll : messages.slice(-3),
    };
}

/**
 * 檢索記憶並格式化為可注入 System Prompt 的 Markdown
 *
 * 注意：檢索管線全程純計算 + Embedding API，不調 LLM。
 *
 * @param queryOverride App 自定義上下文（場景、題目等），會與最近一輪對話拼接後一起檢索
 */
export interface RecallRetrievalOptions {
    explicitEntityAnalysis?: ExplicitEntityAnalysis;
    /** 預留 Resolver 補救 query：只增加檢索支路，不替換原始 user spikes。 */
    recallPlan?: RecallPlan;
    /** 調用方專用的最終召回/格式化上限；默認聊天仍保持 15。 */
    formatterMaxOutputItems?: number;
}

export async function retrieveMemories(
    recentMessages: Message[],
    charId: string,
    embeddingConfig: EmbeddingConfig,
    currentMood?: string,
    personalityStyle: PersonalityStyle = 'emotional',
    ruminationTendency: number = 0.3,
    queryOverride?: string,
    userName?: string,
    remoteVectorConfig?: RemoteVectorConfig,
    charName?: string,
    onTelemetry?: (telemetry: RecallRetrievalTelemetry) => void,
    recallOptions?: RecallRetrievalOptions,
): Promise<string> {
    // ── 分段計時：定位 memoryPalace 到底是網絡慢還是計算慢 ──
    // tag: NET = 遠端 API RTT；IDB = IndexedDB 讀寫；CPU = 純本地計算
    const perfRetrieveT0 = performance.now();
    const retrieveTimings: Array<{ label: string; ms: number; kind: 'NET' | 'IDB' | 'CPU' }> = [];
    const tRetrieve = async <T>(label: string, kind: 'NET' | 'IDB' | 'CPU', p: Promise<T>): Promise<T> => {
        const t0 = performance.now();
        try { return await p; }
        finally { retrieveTimings.push({ label, kind, ms: Math.round(performance.now() - t0) }); }
    };
    let explicitEntityTelemetry: RecallRetrievalTelemetry['explicitEntity'];
    let eventBoxMetadataTelemetry: RecallRetrievalTelemetry['eventBoxMetadata'];
    try {
        // 1. 構建查詢 —— per-message 多路檢索策略：
        //
        //    問題：任何形式的"把多條 user 消息 join 成一段 embedding"都會出現
        //          稀釋問題。無論真正的意圖在 burst 的開頭、中間還是結尾，
        //          短而精的信號都會被周圍的閒語/寒暄/語氣詞淹沒。
        //
        //    方案：每條有意義的 user 消息（≥ 4 字，去重）獨立跑一次 hybridSearch。
        //          合併時同一條記憶取所有 per-msg 搜索中的最高分，這樣：
        //          - "今天我要回家看家人啦" 作為獨立 query 時 embedding 質心
        //            直接落在"家/家人"語義空間，命中家庭類記憶
        //          - "晚上好" / "你在做什麼" 這些獨立 query 只會命中寒暄類
        //            記憶（分數低），不會干擾真正意圖的召回
        //
        //    context query：assistant 回覆 + 更早 user 消息 + queryOverride。
        //                  （背景話題延續，分數 × 0.5 折扣，不會壓過 user 意圖）
        //
        //    query 源清洗（querySanitizer）：圖片/表情包/語音不進 query——
        //    圖片 content 是幾萬字符的 base64 data URI，URL_RE 剝不掉，
        //    切進 spike/rerank/context 會把 Embedding 批量請求頂爆
        //    （硅基流動 400 code 20015）。卡片類翻成可讀文本再參與檢索。
        const querySourceMessages = sanitizeQuerySourceMessages(recentMessages, charName, userName);
        const { userIntent, contextTurns, fallbackAll } = splitLastTurnQueries(querySourceMessages);

        // 抽取每條有意義的 user 消息作為獨立 spike + 二次拆分子 spike
        //
        // 過濾原則：
        // 1. 剝離 URL（表情包/圖片/外鏈 URL 在 embedding 裡是隨機噪聲，沒有語義）
        // 2. 剝離 URL 後，再剝掉所有標點和空白來計算"有意義字符數"
        // 3. 有意義字符數 < MIN_SPIKE_LEN 的 pass（純標點/單字語氣詞/"……"等）
        // 4. 同內容去重
        //
        // MIN_SPIKE_LEN=2 而不是 4：中文裡 2 字已經可以成詞（"晚安""回家""想你"
        // "外公""生氣"），如果閾值設 4 會誤傷大量短而關鍵的中文測試性輸入。
        // 被過濾的只有 1 字的"嗯""好""?""哦""哈"類純語氣詞，以及"……""。。。"
        // 這類純標點輸入——它們 embedding 方向隨機，BM25 也匹配不上任何東西。
        //
        // 注意：query 文本仍然用"剝 URL 後"的原始 trim 版本（保留標點），
        // 只在判長度時才看"剝光標點的有意義字符數"。這樣"晚安……"這種
        // 帶尾隨省略號的合法輸入能進池，且 query 裡完整保留上下文。
        //
        // 二次拆分（sub-spike）：
        //   一條消息內部如果有標點/空格分隔多段語義（DateApp 見面模式的
        //   敘述格式 `"對白" 旁白 "對白"`、或者用戶在一條消息裡用逗號/
        //   句號串了多件事），單一 spike 會讓真實意圖被氣泡內的其他片段
        //   稀釋。把消息按 [\s\p{P}]+ 拆成子片段，每個 ≥ MIN_SPIKE_LEN 的
        //   子片段也作為獨立 spike 入池（label 後綴 a/b/c/...）。原消息
        //   仍保留作 u<N>，捕獲跨片段的整體語境。
        //
        //   這不是"擴搜索面"——子 spike 比原 spike 更短更專注，每路 query
        //   質心更精準（不是更寬），所以不會出現 joined / 候選池擴大那種
        //   "泛情感記憶借寬匹配反超"的問題。機制方向相反。
        const MIN_SPIKE_LEN = 2;
        const MAX_SPIKES = 10;
        const MAX_SUB_SPIKES_PER_MSG = 5;
        const URL_RE = /https?:\/\/\S+/gi;
        const PUNCT_WS_RE = /[\s\p{P}]/gu;
        const SPLIT_RE = /[\s\p{P}]+/gu;
        const seenSpike = new Set<string>();
        const userSpikes: { label: string; text: string; originalIdx: number }[] = [];
        userIntent.forEach((m, idx) => {
            const stripped = m.content.replace(URL_RE, ' ').trim();
            const text = stripped.slice(0, 2000);
            const meaningfulChars = text.replace(PUNCT_WS_RE, '');
            if (meaningfulChars.length < MIN_SPIKE_LEN) return;
            if (seenSpike.has(text)) return;
            seenSpike.add(text);
            const baseLabel = `u${idx + 1}`;
            userSpikes.push({ label: baseLabel, text, originalIdx: idx });

            // 二次拆分：消息內部有多段語義時，每段也作為子 spike
            const segments = text.split(SPLIT_RE)
                .map(s => s.trim())
                .filter(s => s.length > 0 && s !== text && s.replace(PUNCT_WS_RE, '').length >= MIN_SPIKE_LEN);
            let subIdx = 0;
            for (const seg of segments) {
                if (subIdx >= MAX_SUB_SPIKES_PER_MSG) break;
                if (seenSpike.has(seg)) continue;
                seenSpike.add(seg);
                subIdx++;
                const subLabel = `${baseLabel}${String.fromCharCode(96 + subIdx)}`; // a,b,c,...
                userSpikes.push({ label: subLabel, text: seg, originalIdx: idx });
            }
        });
        // 保留最後 MAX_SPIKES 條（如果超過上限，優先保留最近的）
        const effectiveSpikes = userSpikes.slice(-MAX_SPIKES);
        const routerSpikes = recallOptions?.recallPlan?.route
            ? recallOptions.recallPlan.queries.map((query, index) => ({
                label: `r${index + 1}`,
                text: query.text,
                scope: query.scope,
                weight: query.weight,
                source: query.source,
            }))
            : [];
        const eventBoxRouterSpikes = routerSpikes.filter(spike => spike.scope === 'event_box');

        const contextQuery = [queryOverride, contextTurns.map(m => m.content).join('\n')]
            .filter(Boolean)
            .join('\n')
            .slice(0, 2000);
        const userQueryJoined = userIntent.map(m => m.content).join('\n'); // 僅用於日誌顯示原始 userIntent 文本

        // 兜底：極端情況下末尾沒有任何可用的 user spike（如冷啟動首輪，或全是語氣詞）
        const fallbackQuery = effectiveSpikes.length > 0
            ? ''
            : [queryOverride, fallbackAll.map(m => m.content).join('\n')]
                  .filter(Boolean)
                  .join('\n')
                  .slice(0, 2000);

        if (effectiveSpikes.length === 0 && !contextQuery.trim() && !fallbackQuery.trim()) {
            onTelemetry?.({ outcome: 'empty', reason: 'no_effective_query' });
            return '';
        }

        // ─── 調試日誌：打印所有 query ─────────────────────────
        console.groupCollapsed(`🏰 [Retrieve] ═══ 檢索開始 ═══`);
        console.log(`👤 userIntent: ${userIntent.length} 條消息，其中 ${effectiveSpikes.length} 條進入 per-msg 搜索`);
        if (userQueryJoined && effectiveSpikes.length < userIntent.length) {
            console.log(`   (被過濾的 ${userIntent.length - effectiveSpikes.length} 條：長度 < ${MIN_SPIKE_LEN} 字或重複內容)`);
        }
        effectiveSpikes.forEach(s => {
            console.log(`  🎯 ${s.label} (${s.text.length} 字): ${s.text.replace(/\n/g, ' ↵ ')}`);
        });
        routerSpikes.forEach(s => {
            console.log(`  🧭 ${s.label} [${s.scope}|w=${s.weight.toFixed(2)}${s.source ? `|${s.source}` : ''}] (${s.text.length} 字): ${s.text.replace(/\n/g, ' ↵ ')}`);
        });
        console.log(`📄 context query (${contextQuery.length} 字，${contextTurns.length} 條 context 消息):`);
        console.log(contextQuery || '(空)');
        if (fallbackQuery) {
            console.log(`⚠️  fallback query (${fallbackQuery.length} 字):`);
            console.log(fallbackQuery);
        }
        console.groupEnd();

        // 2. 混合搜索（並行）
        //    - 每條 user spike：原樣打分（權重 1.0）
        //    - context：分數 × CONTEXT_DISCOUNT 折扣
        //    合併時同一條記憶取 max(所有 spike 分, context 分×折扣)
        //
        //    per-query 返回 30 條，最終合併按調用方上限裁剪（普通聊天 15）。
        //    原因：如果每路只返回最終上限，同一類主題（如"外公"）的多條
        //    記憶中，排名較低的幾條會在 per-query 階段就被切掉，永遠
        //    進不到合併池。擴大 per-query 容量讓"同主題的次要記憶"
        //    也有機會競爭最終名次。
        const CONTEXT_DISCOUNT = 0.5;
        const PER_QUERY_TOP_K = 30;
        const FINAL_TOP_K = Math.max(1, Math.min(30, Math.floor(recallOptions?.formatterMaxOutputItems ?? 15)));

        // 輔助：把 ScoredMemory 格式化成一行摘要
        const now = Date.now();
        const fmt = (r: ScoredMemory, prefix: string = '') => {
            const ageDays = Math.floor((now - r.node.createdAt) / (1000 * 60 * 60 * 24));
            const preview = r.node.content.slice(0, 50).replace(/\n/g, ' ');
            return `${prefix}[${r.node.room}|imp=${r.node.importance}|${ageDays}d前] `
                + `sim=${r.similarity.toFixed(3)} bm25=${r.bm25Score.toFixed(3)} `
                + `→ final=${r.finalScore.toFixed(3)}  "${preview}${r.node.content.length > 50 ? '...' : ''}"`;
        };

        let results: ScoredMemory[] = [];
        let explicitNodesSnapshot: MemoryNode[] | undefined;
        let explicitEventBoxesSnapshot: EventBox[] | undefined;
        // 記錄每條記憶被哪些 spike / context 命中以及各自分數
        type TraceEntry = {
            spikeScores: Map<string, number>; // label → finalScore
            contextScore?: number; // 原始分（未折扣）
        };
        const sourceTrace = new Map<string, TraceEntry>();

        // ── Rerank 並行準備 ──
        // Rerank 原本是主召回徹底跑完才串行啟動的獨立管線，拖後腿嚴重。
        // 現在把 rerank 的 embedding 塞進主 prefetch 批、pool hybridSearch 塞進主 Promise.all、
        // rerankDocuments 在 pool 就緒時立即 fire，只在最後 tail 等一下 dedup。
        // 這樣 rerank 幾乎整段都跟主路後半段並行跑。
        const rerankConfig = getRerankConfig();
        const joinedUserQuery = (rerankConfig && userIntent.length > 0)
            ? userIntent.map(m => m.content).join(' ').trim().slice(0, 2000)
            : '';
        const doRerank = !!(rerankConfig && joinedUserQuery);
        const RERANK_POOL_SIZE = 50;
        type RerankApiResult = {
            pool: ScoredMemory[];
            rrResults: Array<{ index: number; relevance_score: number }>;
        };
        // 由下面的 spike / fallback 分支各自賦值；tail 只 await 這個拿最終結果
        let rerankApiPromise: Promise<RerankApiResult | null> = Promise.resolve(null);

        if (effectiveSpikes.length > 0) {
            // 並行：每條 spike + context
            //
            // 歷史教訓：曾經加過 joined query 路徑（所有 spike 拼成一條長 query
            // 並行檢索）期望"BM25 跨氣泡疊加"能提升主題收斂場景的召回。但
            // 實測反而變差——長 query 的 BM25 會被**泛情感高 imp 記憶**的
            // 隨機 token 碰撞累積到虛高分，擠掉 per-message 本來精準的焦點
            // 命中。這和之前候選池 30→60 被回滾是同一類錯誤：任何"擴大
            // 搜索面"的機制都讓泛情感記憶憑 imp/recency 反超 topic-specific
            // 記憶。回滾。

            // ─── Prefetch：把 K 路 hybridSearch 各自會做的公共 IO 抽上來一次性做完 ───
            //
            // 原實現：每路 hybridSearch 各自 ①調一次 embedding API ②掃一遍
            //         memory_nodes 索引 ③掃一遍 memory_vectors 索引。
            //         K 路 = 3K 倍重複 IO，Embedding API 還每路一次 RTT。
            //
            // 優化：
            //   1. 所有 query 文本合批一次 getEmbeddings → 省 (K-1) 次 RTT。
            //      Embedding API 對 input: [] 數組裡的每條獨立打向量，數學上等價。
            //   2. allNodes / allVectors 在 pipeline 一次性預取，透傳給每路
            //      hybridSearch → K 路看同一份快照，retrieve 內部一致性反而更好。
            //   3. 遠程向量路徑不消費 allVectors，所以遠程開啟且沒熔斷時跳過
            //      allVectors 預取，避免無效 IO。
            const contextQueryTrimmed = contextQuery.trim();
            const searchPaths = [
                ...effectiveSpikes.map(spike => ({
                    label: spike.label,
                    text: spike.text,
                    kind: 'user' as const,
                    scope: 'memory' as const,
                    multiplier: 1,
                })),
                ...routerSpikes.map(spike => ({
                    label: spike.label,
                    text: spike.text,
                    kind: 'router' as const,
                    scope: spike.scope,
                    // Resolver 是補充信號：高權重時接近原始支路，低權重時仍保守降權。
                    multiplier: 0.65 + 0.35 * spike.weight,
                })),
            ];
            // 把 rerank 的 joined query 也塞進同一次 getEmbeddings，共享 embedding RTT
            const queriesToEmbed: string[] = [
                ...searchPaths.map(path => path.text),
                ...(contextQueryTrimmed ? [contextQuery] : []),
                ...(doRerank ? [joinedUserQuery] : []),
            ];
            const useRemoteVector = !!(
                remoteVectorConfig?.enabled && remoteVectorConfig.initialized && !isRemoteSearchBroken()
            );
            const [queryVectors, allNodes, allVectors, allEventBoxes] = await Promise.all([
                tRetrieve(`getEmbeddings(${queriesToEmbed.length})`, 'NET', getEmbeddings(queriesToEmbed, embeddingConfig)),
                tRetrieve('MemoryNodeDB.getByCharId', 'IDB', MemoryNodeDB.getByCharId(charId)),
                useRemoteVector
                    ? Promise.resolve(undefined)
                    : tRetrieve('MemoryVectorDB.getAllByCharId', 'IDB', MemoryVectorDB.getAllByCharId(charId)),
                recallOptions?.explicitEntityAnalysis?.hasSignals || eventBoxRouterSpikes.length > 0
                    ? tRetrieve('EventBoxDB.getByCharId(recall)', 'IDB', EventBoxDB.getByCharId(charId))
                    : Promise.resolve(undefined),
            ]);
            explicitNodesSnapshot = allNodes;
            explicitEventBoxesSnapshot = allEventBoxes;

            const pathPromises = searchPaths.map((path, i) =>
                hybridSearch(path.text, charId, embeddingConfig, PER_QUERY_TOP_K, remoteVectorConfig, {
                    queryVector: queryVectors[i],
                    allNodes,
                    allVectors,
                }).then(pathResults => path.scope === 'event_box'
                    ? pathResults.filter(result => Boolean(result.node.eventBoxId || result.node.isBoxSummary))
                    : pathResults)
            );
            const contextPromise = contextQueryTrimmed
                ? hybridSearch(contextQuery, charId, embeddingConfig, PER_QUERY_TOP_K, remoteVectorConfig, {
                    queryVector: queryVectors[searchPaths.length],
                    allNodes,
                    allVectors,
                })
                : Promise.resolve([] as ScoredMemory[]);

            // Rerank 的 pool hybridSearch 跟主路一起發（共享 backend RTT）
            // 不放進主 Promise.all —— 我們要把 pool 回來這事做成獨立管線，
            // pool 一到就 fire rerankDocuments，不被主路 post-search 阻塞。
            //
            // ⚠️ 隱式契約：這裡和 spikePromises / contextPromise 複用同一份
            //    prefetched allVectors，N 路併發共享一個 ArrayBuffer 池。
            //    這能成立是因為 vectorSearch.ts 的 canTransferCandidates =
            //    !prefetchedVectors 守衛在 prefetch 場景下禁用了 postMessage
            //    的 Transferable 路徑，避免首個路徑 transfer 把 buffer neuter
            //    成全 0 讓後續路徑靜默返空。如果動 vectorSearch 那段邏輯，
            //    grep 這條註釋 —— rerank pool 會是第一個崩的。
            const rerankPoolPromise: Promise<ScoredMemory[]> = doRerank
                ? hybridSearch(joinedUserQuery, charId, embeddingConfig, RERANK_POOL_SIZE, remoteVectorConfig, {
                    queryVector: queryVectors[queriesToEmbed.length - 1],
                    allNodes,
                    allVectors,
                }).catch(e => {
                    console.warn(`🎯 [Rerank] pool 檢索失敗（主召回不受影響）: ${e?.message || e}`);
                    return [] as ScoredMemory[];
                })
                : Promise.resolve([] as ScoredMemory[]);

            if (doRerank) {
                rerankApiPromise = (async (): Promise<RerankApiResult | null> => {
                    const rrT0 = performance.now();
                    try {
                        const pool = await rerankPoolPromise;
                        if (pool.length === 0) {
                            console.log(`🎯 [Rerank] 獨立檢索候選池為空，跳過 rerank`);
                            retrieveTimings.push({ label: 'rerankDocuments(skip)', kind: 'NET', ms: Math.round(performance.now() - rrT0) });
                            return null;
                        }
                        const rerankWanted = rerankConfig!.topN;
                        const rerankAskForN = Math.min(pool.length, rerankWanted + 10);
                        const rrResults = await rerankDocuments(
                            { baseUrl: rerankConfig!.baseUrl, apiKey: rerankConfig!.apiKey, model: rerankConfig!.model },
                            joinedUserQuery,
                            pool.map(p => p.node.content),
                            rerankAskForN,
                        );
                        retrieveTimings.push({ label: 'rerankDocuments', kind: 'NET', ms: Math.round(performance.now() - rrT0) });
                        return { pool, rrResults };
                    } catch (e: any) {
                        console.warn(`🎯 [Rerank] 失敗（主召回不受影響）: ${e?.message || e}`);
                        retrieveTimings.push({ label: 'rerankDocuments(err)', kind: 'NET', ms: Math.round(performance.now() - rrT0) });
                        return null;
                    }
                })();
            }

            const hybridKind: 'NET' | 'CPU' = useRemoteVector ? 'NET' : 'CPU';
            const [contextResults, ...spikeResultsArr] = await tRetrieve(
                `hybridSearch×${pathPromises.length + (contextQueryTrimmed ? 1 : 0)}`,
                hybridKind,
                Promise.all([contextPromise, ...pathPromises]),
            );

            // ─── 調試日誌：每條 spike 的完整結果 ─────────────────
            spikeResultsArr.forEach((spikeResults, idx) => {
                const s = searchPaths[idx];
                const icon = s.kind === 'router' ? '🧭' : '🎯';
                console.groupCollapsed(`🏰 [Retrieve] ${icon} ${s.label} 搜命中 ${spikeResults.length} 條 ("${s.text.slice(0, 30).replace(/\n/g, ' ')}${s.text.length > 30 ? '...' : ''}")`);
                spikeResults.forEach((r, i) => console.log(fmt(r, `#${i + 1} `)));
                console.groupEnd();
            });

            if (contextResults.length > 0) {
                console.groupCollapsed(`🏰 [Retrieve] 📄 context 搜命中 ${contextResults.length} 條（下方為折扣前原始分）`);
                contextResults.forEach((r, i) => {
                    console.log(fmt(r, `#${i + 1} `) + `  → 折扣後=${(r.finalScore * CONTEXT_DISCOUNT).toFixed(3)}`);
                });
                console.groupEnd();
            } else {
                console.log(`🏰 [Retrieve] context 搜跳過（context query 為空）`);
            }

            // 合併：每條記憶取 max(所有 spike 分, context 分×折扣)
            const merged = new Map<string, ScoredMemory>();
            spikeResultsArr.forEach((spikeResults, idx) => {
                const path = searchPaths[idx];
                const label = path.label;
                for (const r of spikeResults) {
                    const weighted = path.multiplier === 1 ? r : {
                        ...r,
                        finalScore: r.finalScore * path.multiplier,
                        roomScore: r.roomScore * path.multiplier,
                    };
                    const trace = sourceTrace.get(r.node.id) ?? { spikeScores: new Map<string, number>() } as TraceEntry;
                    trace.spikeScores.set(label, weighted.finalScore);
                    sourceTrace.set(r.node.id, trace);
                    const existing = merged.get(r.node.id);
                    if (!existing || weighted.finalScore > existing.finalScore) {
                        merged.set(r.node.id, weighted);
                    }
                }
            });
            for (const r of contextResults) {
                const trace = sourceTrace.get(r.node.id) ?? { spikeScores: new Map<string, number>() } as TraceEntry;
                trace.contextScore = r.finalScore;
                sourceTrace.set(r.node.id, trace);
                const discounted: ScoredMemory = {
                    ...r,
                    finalScore: r.finalScore * CONTEXT_DISCOUNT,
                    roomScore: r.roomScore * CONTEXT_DISCOUNT,
                };
                const existing = merged.get(r.node.id);
                if (!existing || discounted.finalScore > existing.finalScore) {
                    merged.set(r.node.id, discounted);
                }
            }

            results = [...merged.values()]
                .sort((a, b) => b.finalScore - a.finalScore)
                .slice(0, FINAL_TOP_K);

            // ─── 調試日誌：合併後最終 top K ───────────────────
            console.groupCollapsed(`🏰 [Retrieve] 合併後 top ${results.length}（擴散激活/啟動效應前）`);
            results.forEach((r, i) => {
                const t = sourceTrace.get(r.node.id) ?? { spikeScores: new Map<string, number>() } as TraceEntry;
                const spikeLabels = [...t.spikeScores.keys()];
                const srcTags = spikeLabels.map(l => `🎯${l}`);
                if (t.contextScore !== undefined) srcTags.push('📄');
                const tag = srcTags.join('+');
                const details: string[] = [];
                for (const [label, score] of t.spikeScores) {
                    details.push(`${label}=${score.toFixed(3)}`);
                }
                if (t.contextScore !== undefined) {
                    details.push(`ctx=${t.contextScore.toFixed(3)}×0.5=${(t.contextScore * CONTEXT_DISCOUNT).toFixed(3)}`);
                }
                console.log(fmt(r, `#${i + 1} [${tag}] `) + ` (${details.join(', ')})`);
            });
            console.groupEnd();

            console.log(`🏰 [Retrieve] 多路檢索彙總：${effectiveSpikes.length} 個原始 spike + ${routerSpikes.length} 個 Resolver 補救 query + ${contextResults.length > 0 ? 'context' : '無 context'} → 合併 top ${results.length}`);
        } else {
            // 冷啟動兜底：僅用 fallback 單 query
            const useRemoteVector = !!(
                remoteVectorConfig?.enabled && remoteVectorConfig.initialized && !isRemoteSearchBroken()
            );
            // 先 fire fallback 主搜 + rerank pipeline，兩個獨立管線並行
            const fallbackSearchPromise = hybridSearch(fallbackQuery, charId, embeddingConfig, FINAL_TOP_K, remoteVectorConfig);
            if (doRerank) {
                rerankApiPromise = (async (): Promise<RerankApiResult | null> => {
                    const rrT0 = performance.now();
                    try {
                        const pool = await hybridSearch(joinedUserQuery, charId, embeddingConfig, RERANK_POOL_SIZE, remoteVectorConfig, undefined);
                        if (pool.length === 0) {
                            console.log(`🎯 [Rerank] 獨立檢索候選池為空，跳過 rerank`);
                            retrieveTimings.push({ label: 'rerankDocuments(skip)', kind: 'NET', ms: Math.round(performance.now() - rrT0) });
                            return null;
                        }
                        const rerankWanted = rerankConfig!.topN;
                        const rerankAskForN = Math.min(pool.length, rerankWanted + 10);
                        const rrResults = await rerankDocuments(
                            { baseUrl: rerankConfig!.baseUrl, apiKey: rerankConfig!.apiKey, model: rerankConfig!.model },
                            joinedUserQuery,
                            pool.map(p => p.node.content),
                            rerankAskForN,
                        );
                        retrieveTimings.push({ label: 'rerankDocuments', kind: 'NET', ms: Math.round(performance.now() - rrT0) });
                        return { pool, rrResults };
                    } catch (e: any) {
                        console.warn(`🎯 [Rerank] 失敗（主召回不受影響）: ${e?.message || e}`);
                        retrieveTimings.push({ label: 'rerankDocuments(err)', kind: 'NET', ms: Math.round(performance.now() - rrT0) });
                        return null;
                    }
                })();
            }
            results = await tRetrieve(
                'hybridSearch(fallback)',
                useRemoteVector ? 'NET' : 'CPU',
                fallbackSearchPromise,
            );
            console.groupCollapsed(`🏰 [Retrieve] 單 query 兜底命中 ${results.length} 條（無末尾 user 消息）`);
            results.forEach((r, i) => console.log(fmt(r, `#${i + 1} `)));
            console.groupEnd();
        }

        // 2.4 EventBox 本地輕索引：Resolver 的 event_box query 已經走完上面的舊 hybrid recall，
        //     這裡再補查 box.name/tags/summary/live metadata。兩路合流，不替換舊結果、不額外調 API。
        if (eventBoxRouterSpikes.length > 0) {
            const eventBoxT0 = performance.now();
            try {
                if (!explicitNodesSnapshot || !explicitEventBoxesSnapshot) {
                    [explicitNodesSnapshot, explicitEventBoxesSnapshot] = await Promise.all([
                        MemoryNodeDB.getByCharId(charId),
                        EventBoxDB.getByCharId(charId),
                    ]);
                }
                const index = buildEventBoxLightIndex(explicitNodesSnapshot, explicitEventBoxesSnapshot);
                const lookup = lookupEventBoxLightCandidates(index, eventBoxRouterSpikes);
                results = mergeEventBoxLightCandidates(
                    results,
                    lookup.candidates,
                    recallOptions?.recallPlan?.confidence ?? 0,
                );
                eventBoxMetadataTelemetry = {
                    status: lookup.candidates.length > 0 ? 'hit' : 'miss',
                    durationMs: Math.round(performance.now() - eventBoxT0),
                    queryCount: eventBoxRouterSpikes.length,
                    indexedBoxCount: index.indexedBoxCount,
                    matchedBoxCount: lookup.matchedBoxCount,
                    candidateCount: lookup.candidates.length,
                    matchSources: [...new Set(lookup.candidates.map(candidate => candidate.matchSource))],
                };
                console.log(
                    `📦 [EventBoxRecall] ${eventBoxMetadataTelemetry.status}: `
                    + `${index.indexedBoxCount} indexed / ${lookup.matchedBoxCount} matched → `
                    + `${lookup.candidates.length} additive candidates`,
                );
            } catch (e: any) {
                eventBoxMetadataTelemetry = {
                    status: 'error',
                    durationMs: Math.round(performance.now() - eventBoxT0),
                    queryCount: eventBoxRouterSpikes.length,
                    indexedBoxCount: 0,
                    matchedBoxCount: 0,
                    candidateCount: 0,
                    matchSources: [],
                };
                console.warn(`📦 [EventBoxRecall] 本地索引失敗（舊召回不受影響）: ${e?.message || e}`);
            }
        }

        // 2.5 明確實體路徑：精確查找獨立於 vector/BM25 分數，命中項保底進入 formatter。
        //     舊節點沒有 entities 時，lookup 會回退到 tags/content；EventBox 同時查 name/tags。
        const explicitAnalysis = recallOptions?.explicitEntityAnalysis;
        if (explicitAnalysis?.hasSignals) {
            const explicitT0 = performance.now();
            try {
                if (!explicitNodesSnapshot || !explicitEventBoxesSnapshot) {
                    [explicitNodesSnapshot, explicitEventBoxesSnapshot] = await Promise.all([
                        MemoryNodeDB.getByCharId(charId),
                        EventBoxDB.getByCharId(charId),
                    ]);
                }
                const lookup = lookupExplicitEntityCandidates(
                    explicitAnalysis,
                    explicitNodesSnapshot,
                    explicitEventBoxesSnapshot,
                );
                results = mergeExplicitEntityCandidates(results, lookup.candidates);
                explicitEntityTelemetry = {
                    status: lookup.candidates.length > 0 ? 'hit' : 'miss',
                    durationMs: Math.round(performance.now() - explicitT0),
                    signalCount: explicitAnalysis.signals.length,
                    matchedMemoryCount: lookup.matchedMemoryCount,
                    matchedEventBoxCount: lookup.matchedEventBoxCount,
                    guaranteedCount: lookup.candidates.length,
                };
                console.log(
                    `🔎 [EntityRecall] ${explicitEntityTelemetry.status}: `
                    + `${lookup.matchedMemoryCount} memory / ${lookup.matchedEventBoxCount} box → `
                    + `${lookup.candidates.length} guaranteed`,
                );
            } catch (e: any) {
                explicitEntityTelemetry = {
                    status: 'error',
                    durationMs: Math.round(performance.now() - explicitT0),
                    signalCount: explicitAnalysis.signals.length,
                    matchedMemoryCount: 0,
                    matchedEventBoxCount: 0,
                    guaranteedCount: 0,
                };
                console.warn(`🔎 [EntityRecall] 精確查找失敗（普通召回不受影響）: ${e?.message || e}`);
            }
        }

        // 2.6 日期引用路徑：從 user 意圖裡抽"去年12月""3月4號""上週"這類
        //     日期引用，直接按 createdAt 撈對應區間的記憶（vector/BM25 都對不準日期）。
        //     archived 節點參與日期匹配 → 路由到其 EventBox summary 返回。
        const dateT0 = performance.now();
        try {
            const { resolveDateReferences } = await import('./dateResolver');
            const queryForDates = [userQueryJoined, contextQuery, fallbackQuery].filter(Boolean).join('\n');
            const ranges = resolveDateReferences(queryForDates);
            if (ranges.length > 0) {
                console.log(`📅 [Retrieve] 檢測到日期引用 ${ranges.length} 個：${ranges.map(r => `${r.label}→[${new Date(r.start).toLocaleDateString('zh-CN')}..${new Date(r.end - 1).toLocaleDateString('zh-CN')}]`).join('、')}`);
                const dateHits = await loadMemoriesByDateRanges(charId, ranges);
                const DATE_BOOST = 0.3;
                const DATE_BASE = 0.5;
                const resultIdx = new Map(results.map((r, i) => [r.node.id, i]));
                let boosted = 0, added = 0;
                for (const node of dateHits) {
                    const idx = resultIdx.get(node.id);
                    if (idx !== undefined) {
                        results[idx].finalScore += DATE_BOOST;
                        results[idx].roomScore += DATE_BOOST;
                        boosted++;
                    } else {
                        results.push({
                            node,
                            finalScore: DATE_BASE + DATE_BOOST,
                            similarity: 0,
                            bm25Score: 0,
                            roomScore: DATE_BASE + DATE_BOOST,
                        });
                        added++;
                    }
                }
                if (boosted + added > 0) {
                    console.log(`📅 [Retrieve] 日期命中加權：${boosted} 條已命中 +${DATE_BOOST}，${added} 條新增`);
                }
            }
        } catch (e: any) {
            console.warn(`📅 [Retrieve] 日期解析失敗（不影響常規召回）: ${e?.message || e}`);
        }
        retrieveTimings.push({ label: 'dateResolver', kind: 'IDB', ms: Math.round(performance.now() - dateT0) });

        if (results.length === 0) {
            console.log(`🏰 [Retrieve] 混合搜索 + 日期路徑均無結果，跳過記憶注入`);
            onTelemetry?.({
                outcome: 'empty',
                reason: 'no_results',
                explicitEntity: explicitEntityTelemetry,
                eventBoxMetadata: eventBoxMetadataTelemetry,
            });
            return '';
        }

        // 3. 擴散激活
        const beforeActivation = results.length;
        results = await tRetrieve('spreadActivation', 'IDB', spreadActivation(results, charId, personalityStyle));
        if (results.length !== beforeActivation) {
            console.log(`🏰 [Retrieve] 擴散激活後：${beforeActivation} → ${results.length} 條`);
        }

        // 4. 啟動效應
        if (currentMood) {
            results = applyPriming(results, currentMood);
            console.log(`🏰 [Retrieve] 啟動效應（mood=${currentMood}）已應用`);
        }

        // 重新排序
        results.sort((a, b) => b.finalScore - a.finalScore);

        // ─── 調試日誌：擴散+啟動後的候選排序
        //    formatter 會按調用方上限再砍一刀；普通聊天默認 15，活動可單獨覆蓋。
        //    多出來的會被標 "✂️ cut"。
        let formatterCap = FINAL_TOP_K;
        const FORMATTER_CUT = formatterCap;
        console.groupCollapsed(
            `🏰 [Retrieve] 擴散+啟動後 ${results.length} 條候選（formatter 只注入前 ${Math.min(FORMATTER_CUT, results.length)} 條）`
        );
        results.forEach((r, i) => {
            const marker = i < FORMATTER_CUT ? '✅ 注入' : '✂️ cut';
            console.log(fmt(r, `#${i + 1} [${marker}] `));
        });
        console.groupEnd();

        // 5. 反芻
        const ruminatedNode = await tRetrieve('checkRumination', 'IDB', checkRumination(charId, ruminationTendency));
        if (ruminatedNode) {
            const avgScore = results.length > 0
                ? results.reduce((s, r) => s + r.finalScore, 0) / results.length
                : 0.5;
            results.push({
                node: ruminatedNode,
                finalScore: avgScore * 0.8,
                similarity: 0,
                bm25Score: 0,
                roomScore: avgScore * 0.8,
            });
        }

        // 6+7. 更新訪問記錄 + 共同激活加強（併發寫 IDB）
        const writeT0 = performance.now();
        const retrievedIds = results.map(r => r.node.id);
        await Promise.all([
            ...retrievedIds.map(id => MemoryNodeDB.touchAccess(id)),
            retrievedIds.length >= 2 ? strengthenCoActivated(retrievedIds.slice(0, 5)) : Promise.resolve(),
        ]);
        retrieveTimings.push({ label: `idbWrites(${retrievedIds.length})`, kind: 'IDB', ms: Math.round(performance.now() - writeT0) });

        // 8. Rerank 通道（獨立檢索 + cross-encoder 二次排序，可選）
        //
        //   Rerank 的 pool hybridSearch 和 rerankDocuments 已經在前面跟主路
        //   一起發射了（見上文 rerankApiPromise）。tail 這裡只等它並做最後的
        //   dedup / merge，絕大多數情況下 rerank 已經先主路完成了。
        //
        //   注入層面不做特別對待：rerank 追加的幾條直接混入主 results，formatter
        //   按 finalScore 排序渲染。用戶/LLM 不會感知是 rerank 推薦的，F12 裡能看。
        if (doRerank) {
            const rerankTailT0 = performance.now();
            const rrData = await rerankApiPromise;
            if (rrData) {
                const { pool, rrResults } = rrData;
                const rerankWanted = rerankConfig!.topN;
                const mainIds = new Set(results.map(r => r.node.id));
                const rerankPicks: Array<{ sm: typeof pool[number]; rerankScore: number }> = [];
                for (const rr of rrResults) {
                    const cand = pool[rr.index];
                    if (!cand || mainIds.has(cand.node.id)) continue;
                    rerankPicks.push({ sm: cand, rerankScore: rr.relevance_score });
                    if (rerankPicks.length >= rerankWanted) break;
                }

                // F12 調試日誌：能看到 rerank 選了哪幾條、模型打的相關性分、
                // 以及它們原本在 hybrid 裡的 finalScore
                console.groupCollapsed(
                    `🎯 [Rerank] ${rerankConfig!.model} · 獨立檢索池 ${pool.length} 條 · 去重後追加 ${rerankPicks.length} 條 ("${joinedUserQuery.slice(0, 40).replace(/\n/g, ' ')}${joinedUserQuery.length > 40 ? '…' : ''}")`
                );
                rerankPicks.forEach((p, i) => {
                    const preview = p.sm.node.content.slice(0, 50).replace(/\n/g, ' ');
                    const ageDays = Math.floor((Date.now() - p.sm.node.createdAt) / (1000 * 60 * 60 * 24));
                    console.log(
                        `#${i + 1} [${p.sm.node.room}|imp=${p.sm.node.importance}|${ageDays}d前] `
                        + `rerank=${p.rerankScore.toFixed(3)} hybrid=${p.sm.finalScore.toFixed(3)}  `
                        + `"${preview}${p.sm.node.content.length > 50 ? '...' : ''}"`
                    );
                });
                if (rerankPicks.length === 0) {
                    console.log('（rerank 返回的全部 top N 都已在主召回 15 條裡，無新增）');
                }
                console.groupEnd();

                // touch 一下讓 rerank 選中的也走 accessCount / lastAccessedAt 更新（併發）
                await Promise.all(rerankPicks.map(p => MemoryNodeDB.touchAccess(p.sm.node.id)));

                // 追加到 results；formatter 的 MAX_OUTPUT_ITEMS 上調到 15 + N
                // 不改 finalScore：保留 rerank pick 自己 hybridSearch 裡的原始分，
                // 排序自然落位；但通過 formatterCap 保證它們不被切掉。
                if (rerankPicks.length > 0) {
                    results = [...results, ...rerankPicks.map(p => p.sm)];
                    formatterCap = Math.max(formatterCap, 15 + rerankPicks.length);
                }
            }
            // rerank_tail = 等 rerankApiPromise 落地 + dedup + touch，理想值接近 0
            retrieveTimings.push({ label: 'rerank_tail', kind: 'NET', ms: Math.round(performance.now() - rerankTailT0) });
        }

        // 9. 獲取期盼
        const anticipations = await tRetrieve('AnticipationDB.getByCharId', 'IDB', AnticipationDB.getByCharId(charId));

        // 10. 格式化
        const formatted = await tRetrieve('expandAndFormat', 'IDB', expandAndFormat(results, charId, anticipations, userName, formatterCap));

        // ── 彙總打印 ──
        const perfTotal = Math.round(performance.now() - perfRetrieveT0);
        const byKind: Record<'NET' | 'IDB' | 'CPU', number> = { NET: 0, IDB: 0, CPU: 0 };
        retrieveTimings.forEach(t => { byKind[t.kind] += t.ms; });
        const detail = retrieveTimings
            .sort((a, b) => b.ms - a.ms)
            .map(t => `${t.label}[${t.kind}]=${t.ms}ms`)
            .join(' ');
        console.log(`⏱ [retrieveMemories] total=${perfTotal}ms | NET=${byKind.NET}ms IDB=${byKind.IDB}ms CPU=${byKind.CPU}ms | ${detail}`);

        onTelemetry?.({
            outcome: formatted ? 'success' : 'empty',
            reason: formatted ? undefined : 'formatted_empty',
            explicitEntity: explicitEntityTelemetry,
            eventBoxMetadata: eventBoxMetadataTelemetry,
        });
        return formatted;

    } catch (err: any) {
        console.error(`❌ [Retrieve] 檢索記憶失敗:`, err.message);
        onTelemetry?.({
            outcome: 'error',
            reason: 'exception',
            explicitEntity: explicitEntityTelemetry,
            eventBoxMetadata: eventBoxMetadataTelemetry,
        });
        return '';
    }
}

/**
 * 便捷函數：檢索記憶並掛到 char.memoryPalaceInjection 上。
 *
 * 各 App 在構建 System Prompt 前調用一次即可，
 * 之後 buildCoreContext 會自動讀取並注入。
 *
 * @param recentMessages 可選，不傳則自動從 DB 加載
 * @param queryHint 可選，App 自定義檢索詞（如場景描述、遊戲敘事）。
 *                  傳了就直接用這個檢索，不走 getLastTurnMessages。
 */
/**
 * 獲取全局記憶宮殿 embedding 配置。
 * 優先使用全局配置（localStorage），如果沒有則回退到角色級別配置。
 */
function getEmbeddingConfig(charEmbeddingConfig?: any): EmbeddingConfig | null {
    try {
        const raw = localStorage.getItem('os_memory_palace_config');
        if (raw) {
            const global = JSON.parse(raw);
            if (global.embedding?.baseUrl && global.embedding?.apiKey) {
                return global.embedding as EmbeddingConfig;
            }
        }
    } catch {}
    // 回退到角色級別（兼容舊數據）
    if (charEmbeddingConfig?.baseUrl && charEmbeddingConfig?.apiKey) {
        return charEmbeddingConfig as EmbeddingConfig;
    }
    return null;
}

export async function injectMemoryPalace(
    char: { memoryPalaceEnabled?: boolean; embeddingConfig?: any; activeBuffs?: any[]; personalityStyle?: string; ruminationTendency?: number; interactionAccommodation?: CharacterAccommodationPolicy; id: string; name?: string; memoryPalaceInjection?: string; roomPlatesInjection?: string },
    recentMessages?: Message[],
    queryHint?: string,
    userName?: string,
    traceContext?: { entryPoint?: RecallEntryPoint; formatterMaxOutputItems?: number },
): Promise<RecallTrace> {
    const hadPreviousMemory = Boolean(char.memoryPalaceInjection);
    const hadPreviousRoomPlates = Boolean(char.roomPlatesInjection);
    const trace = createRecallTrace({
        charId: char.id,
        entryPoint: traceContext?.entryPoint,
        recentMessageCount: recentMessages?.length ?? null,
        hasQueryHint: Boolean(queryHint?.trim()),
        clearedPreviousMemory: false,
        clearedPreviousRoomPlates: false,
    });
    const legacyCompatibilityMode = !trace.featureFlagsSnapshot.recallRouter
        && !trace.featureFlagsSnapshot.interactionAdaptation
        && !trace.featureFlagsSnapshot.deepEngagement;

    // 總開關關閉時保留 master 的覆蓋語義：只有本輪真的召回到內容才替換臨時注入。
    // 新管線開啟後才主動歸零，避免新分析失敗時複用上一輪的上下文。
    if (!legacyCompatibilityMode) {
        const clearStartedAt = performance.now();
        char.memoryPalaceInjection = '';
        char.roomPlatesInjection = '';
        trace.injection.clearedPreviousMemory = hadPreviousMemory;
        trace.injection.clearedPreviousRoomPlates = hadPreviousRoomPlates;
        trace.stages.push({
            name: 'clear_previous_injection',
            durationMs: Math.round(performance.now() - clearStartedAt),
            outcome: 'ok',
        });
    }

    let explicitEntityAnalysis: ExplicitEntityAnalysis | undefined;
    const interactiveRecall = trace.entryPoint === 'chat_app' || trace.entryPoint === 'collaboration';
    if (!trace.featureFlagsSnapshot.recallRouter) {
        trace.explicitEntityRecall = { status: 'disabled' };
        trace.eventBoxMetadataRecall = { status: 'disabled' };
        trace.recallResolver = { status: 'disabled' };
    } else if (!interactiveRecall) {
        trace.explicitEntityRecall = { status: 'out_of_scope' };
        trace.eventBoxMetadataRecall = { status: 'out_of_scope' };
        trace.recallResolver = { status: 'out_of_scope' };
    } else {
        trace.eventBoxMetadataRecall = { status: 'no_query' };
        const explicitStartedAt = performance.now();
        explicitEntityAnalysis = analyzeExplicitEntitySignals(recentMessages || [], char.name, userName);
        trace.stages.push({
            name: 'explicit_signal',
            durationMs: Math.round(performance.now() - explicitStartedAt),
            outcome: 'ok',
        });
        if (explicitEntityAnalysis.hasSignals) {
            trace.recallIntent = 'explicit_entity';
            trace.explicitEntityRecall = {
                status: 'signaled',
                signalCount: explicitEntityAnalysis.signals.length,
                signalSources: [...new Set(explicitEntityAnalysis.signals.map(signal => signal.source))],
            };
        } else {
            trace.explicitEntityRecall = { status: 'no_signal' };
        }

        const analyzerStartedAt = performance.now();
        const analysis = analyzeLocalContext(
            recentMessages || [],
            char.name,
            userName,
            explicitEntityAnalysis.hasSignals,
        );
        trace.contextAnalyzer = analysis;
        trace.recallResolver = { status: 'deferred' };
        if (!explicitEntityAnalysis.hasSignals) {
            trace.recallIntent = analysis.shouldGuide ? 'implicit_reference' : 'semantic';
        }
        console.log(
            `🧭 [ContextAnalyzer] ${analysis.shouldGuide ? 'guide' : 'observe'}: `
            + `continuation=${analysis.signals.continuationNeed.toFixed(2)} `
            + `ambiguity=${analysis.signals.ambiguity.toFixed(2)} `
            + `self=${analysis.signals.selfSufficiency.toFixed(2)} `
            + `result=${analysis.signals.resultUpdate.toFixed(2)} `
            + `energy=${analysis.signals.energy.toFixed(2)} | `
            + `threshold=${RECALL_GATE_ROUTE_THRESHOLD.toFixed(2)} reasons=${analysis.reasons.join(',')}`,
        );
        trace.stages.push({
            name: 'context_analyzer',
            durationMs: Math.round(performance.now() - analyzerStartedAt),
            outcome: analysis.analyzable ? 'ok' : 'empty',
        });
    }

    if (!trace.featureFlagsSnapshot.interactionAdaptation) {
        trace.interactionAdaptation = { status: 'disabled' };
    } else if (!interactiveRecall) {
        trace.interactionAdaptation = { status: 'out_of_scope' };
    } else {
        const interactionStartedAt = performance.now();
        const interaction = analyzeUserInteraction(
            recentMessages || [],
            char.interactionAccommodation,
            char.name,
            userName,
        );
        trace.interactionAdaptation = {
            status: interaction.analyzable ? 'observed' : 'no_signal',
            analysis: interaction,
        };
        console.log(
            `🎚️ [InteractionAdaptation] ${interaction.analyzable ? 'observed' : 'no_signal'}: `
            + `impulse=${JSON.stringify(interaction.impulse)} `
            + `trend=${JSON.stringify(interaction.trend)} `
            + `policy=${JSON.stringify(interaction.policy)}`,
        );
        trace.stages.push({
            name: 'interaction_adaptation',
            durationMs: Math.round(performance.now() - interactionStartedAt),
            outcome: interaction.analyzable ? 'ok' : 'empty',
        });
    }

    if (!trace.featureFlagsSnapshot.deepEngagement) {
        trace.deepEngagement = { status: 'disabled' };
    } else if (!interactiveRecall) {
        trace.deepEngagement = { status: 'out_of_scope' };
    } else {
        const depthStartedAt = performance.now();
        const legacyRequested = shouldUseLegacyDeepEngagement();
        let engine: 'conversation_v2' | 'legacy_depth' = legacyRequested ? 'legacy_depth' : 'conversation_v2';
        let depth: ReturnType<typeof analyzeDeepEngagement> | ReturnType<typeof analyzeConversationEngagement>;
        try {
            depth = legacyRequested
                ? analyzeDeepEngagement(recentMessages || [], char.name, userName)
                : analyzeConversationEngagement(char.id, recentMessages || [], char.name, userName);
        } catch (error) {
            // M3 是質量增強層。v2 狀態損壞或邊界輸入出錯時，當輪回退舊分析，不能阻斷聊天。
            console.warn('[ConversationEngagement] v2 failed, falling back to legacy depth:', error);
            clearConversationEngagementState(char.id);
            engine = 'legacy_depth';
            depth = analyzeDeepEngagement(recentMessages || [], char.name, userName);
        }
        trace.deepEngagement = {
            status: depth.analyzable ? 'observed' : 'no_signal',
            engine,
            analysis: depth,
        };
        if (engine === 'conversation_v2') {
            const engagement = depth as ReturnType<typeof analyzeConversationEngagement>;
            console.log(
                `🧭 [ConversationEngagement] core=on overlay=${engagement.shouldGuide ? 'on' : 'off'} ${engagement.conversationAct}: `
                + `${engagement.previousEngagementState}->${engagement.engagementState} `
                + `mode=${engagement.interactionMode} `
                + `act=${engagement.responsePlan.primary}${engagement.responsePlan.secondary ? `+${engagement.responsePlan.secondary}` : ''} `
                + `subject=${engagement.subject.active ? 'active' : 'idle'} `
                + `openness=${engagement.subject.openness.toFixed(2)} `
                + `stance=${engagement.stance.confidence.toFixed(2)} `
                + `reasons=${engagement.reasons.join(',')}`,
            );
        } else {
            const legacy = depth as ReturnType<typeof analyzeDeepEngagement>;
            console.log(
                `🪞 [DeepEngagement:legacy] ${legacy.analyzable ? legacy.mode : 'no_signal'}: `
                + `depth=${legacy.state.analyticalDepth.toFixed(2)} `
                + `confidence=${legacy.confidence.toFixed(2)}`,
            );
        }
        trace.stages.push({
            name: 'deep_engagement',
            durationMs: Math.round(performance.now() - depthStartedAt),
            outcome: depth.analyzable ? 'ok' : 'empty',
        });
    }

    if (!char.memoryPalaceEnabled) {
        trace.stages.push({ name: 'finalize', durationMs: 0, outcome: 'skipped' });
        return finishRecallTrace(trace, 'skipped_palace_disabled');
    }
    const embeddingConfig = getEmbeddingConfig(char.embeddingConfig);
    if (!embeddingConfig) {
        trace.stages.push({ name: 'finalize', durationMs: 0, outcome: 'skipped' });
        return finishRecallTrace(trace, 'skipped_embedding_unconfigured');
    }
    try {
        const loadStartedAt = performance.now();
        const msgs = recentMessages ?? await loadCharacterContextMessages(char.id);
        trace.stages.push({
            name: 'load_messages',
            durationMs: Math.round(performance.now() - loadStartedAt),
            outcome: 'ok',
        });
        const currentMood = char.activeBuffs?.[0]?.name;
        // 調用方沒顯式傳 userName 時，兜底從全局用戶檔案取，保證各入口
        // （群聊/通話/事件/學習等）召回的房間名都統一顯示「{用戶名}的房間」，
        // 而不是回退成「用戶房間」。
        let resolvedUserName = userName;
        if (!resolvedUserName) {
            try { resolvedUserName = (await DB.getUserProfile())?.name || undefined; } catch {}
        }

        // 門牌（常駐語義層）：純 IDB 讀 + 格式化，不調 LLM。
        // 無條件賦值（包括 ''）—— 門牌被清空/刪除後，persist 過的舊注入必須被沖掉。
        const roomPlatesStartedAt = performance.now();
        let roomPlateOutcome: RecallTraceStage['outcome'] = 'ok';
        try {
            const { buildRoomPlatesInjection } = await import('./roomPlates');
            char.roomPlatesInjection = await buildRoomPlatesInjection(char.id, resolvedUserName);
        } catch {
            char.roomPlatesInjection = '';
            roomPlateOutcome = 'error';
        }
        trace.injection.roomPlateChars = char.roomPlatesInjection.length;
        trace.stages.push({
            name: 'room_plates',
            durationMs: Math.round(performance.now() - roomPlatesStartedAt),
            outcome: roomPlateOutcome,
        });

        const retrieveStartedAt = performance.now();
        let retrievalTelemetry: RecallRetrievalTelemetry | undefined;
        const context = await retrieveMemories(
            msgs, char.id, embeddingConfig,
            currentMood,
            (char.personalityStyle as PersonalityStyle) || 'emotional',
            char.ruminationTendency ?? 0.3,
            queryHint,
            resolvedUserName,
            getRemoteVectorConfig(),
            char.name,
            telemetry => { retrievalTelemetry = telemetry; },
            { explicitEntityAnalysis, formatterMaxOutputItems: traceContext?.formatterMaxOutputItems },
        );
        if (context || !legacyCompatibilityMode) {
            char.memoryPalaceInjection = context || '';
        }
        trace.retrievalReason = retrievalTelemetry?.reason;
        if (retrievalTelemetry?.explicitEntity) {
            const entity = retrievalTelemetry.explicitEntity;
            trace.explicitEntityRecall = {
                ...trace.explicitEntityRecall,
                status: entity.status,
                signalCount: entity.signalCount,
                matchedMemoryCount: entity.matchedMemoryCount,
                matchedEventBoxCount: entity.matchedEventBoxCount,
                guaranteedCount: entity.guaranteedCount,
            };
            trace.stages.push({
                name: 'entity_lookup',
                durationMs: entity.durationMs,
                outcome: entity.status === 'error' ? 'error' : entity.status === 'miss' ? 'empty' : 'ok',
            });
        }
        if (retrievalTelemetry?.eventBoxMetadata) {
            const eventBox = retrievalTelemetry.eventBoxMetadata;
            trace.eventBoxMetadataRecall = {
                status: eventBox.status,
                queryCount: eventBox.queryCount,
                indexedBoxCount: eventBox.indexedBoxCount,
                matchedBoxCount: eventBox.matchedBoxCount,
                candidateCount: eventBox.candidateCount,
                matchSources: eventBox.matchSources,
            };
            trace.stages.push({
                name: 'event_box_lookup',
                durationMs: eventBox.durationMs,
                outcome: eventBox.status === 'error' ? 'error' : eventBox.status === 'miss' ? 'empty' : 'ok',
            });
        }
        trace.injection.memoryChars = char.memoryPalaceInjection.length;
        trace.stages.push({
            name: 'retrieve',
            durationMs: Math.round(performance.now() - retrieveStartedAt),
            outcome: context ? 'ok' : retrievalTelemetry?.outcome === 'error' ? 'error' : 'empty',
        });
        const finalStageOutcome: RecallTraceStage['outcome'] = context
            ? 'ok'
            : retrievalTelemetry?.outcome === 'error' ? 'error' : 'empty';
        trace.stages.push({ name: 'finalize', durationMs: 0, outcome: finalStageOutcome });
        if (retrievalTelemetry?.outcome === 'error') {
            return finishRecallTrace(trace, 'error', 'retrieval_exception');
        }
        return finishRecallTrace(trace, context ? 'success' : 'empty');
    } catch (e: any) {
        console.warn(`🏰 [MemoryPalace] injectMemoryPalace failed: ${e.message}`);
        if (!legacyCompatibilityMode) char.memoryPalaceInjection = '';
        trace.injection.memoryChars = 0;
        trace.injection.roomPlateChars = char.roomPlatesInjection.length;
        trace.stages.push({ name: 'finalize', durationMs: 0, outcome: 'error' });
        return finishRecallTrace(trace, 'error', 'injection_exception');
    }
}

// ─── 外部摘要 / 日記一次性吞吐 ────────────────────────

/**
 * 把"交換日記"一次性塞進記憶宮殿。
 * 跟 processNewMessages 用的同一套抽取 + 向量化邏輯（lightLLM 副 API、extractMemoriesFromBuffer、
 * vectorizeAndStore），但不走緩衝區/高水位機制 —— 因為日記不是普通聊天消息，
 * 是一篇獨立的、用戶主動觸發的歸檔。
 *
 * 關鍵差異（對比 chat 自動歸檔）：
 *  - 時間戳來自 diary.date，不是 Date.now() —— 這樣向量記憶按 createdAt 排序時
 *    日記會落在它真正發生的那天而不是歸檔的那天
 *  - 不動 mp_lastMsgId_ 高水位 —— 防止把後續聊天處理跳過
 *  - 不寫 EventBox 跨時間鏈接（日記是孤立事件，綁鏈接需要再過一遍消息流，價值不大）
 *
 * @param char 至少要 id / name / memoryPalaceEnabled / embeddingConfig
 * @param dateStr 日記日期 YYYY-MM-DD，決定 MemoryNode.createdAt
 * @param userDiaryText 用戶那頁的正文
 * @param charDiaryText 角色那頁的正文（可空）
 * @param lightLLMConfig 記憶宮殿副 API
 * @param userName 用戶暱稱
 */
/** 一次日記歸檔對宮殿的具體影響, 用 status 區分各種"為什麼沒入宮"的情況, 供 UI 彈窗直接展示 */
export type DiaryIngestResult =
    | { status: 'palace_disabled' }
    | { status: 'lightllm_missing' }
    | { status: 'embedding_missing' }
    | { status: 'empty_input' }
    | { status: 'extracted_none'; stored: 0; skipped: 0 }
    | {
        status: 'done';
        stored: number;
        skipped: number;
        nodes: { content: string; room: import('./types').MemoryRoom; importance: number; mood: string; tags: string[] }[];
    };

export async function ingestDiaryToPalace(
    char: { id: string; name: string; memoryPalaceEnabled?: boolean; embeddingConfig?: any; systemPrompt?: string; worldview?: string },
    dateStr: string,
    userDiaryText: string,
    charDiaryText: string,
    lightLLMConfig: LightLLMConfig | null | undefined,
    userName: string,
): Promise<DiaryIngestResult> {
    if (!char.memoryPalaceEnabled) return { status: 'palace_disabled' };
    if (!lightLLMConfig?.baseUrl || !lightLLMConfig?.apiKey) {
        console.warn(`🏰 [DiaryIngest] 跳過：lightLLM 未配置`);
        return { status: 'lightllm_missing' };
    }
    const embeddingConfig = getEmbeddingConfig(char.embeddingConfig);
    if (!embeddingConfig) {
        console.warn(`🏰 [DiaryIngest] 跳過：embedding 配置未就緒`);
        return { status: 'embedding_missing' };
    }

    // 構造時間戳：YYYY-MM-DD → 當地中午 12:00（避免時區把日期撇到前一天）
    let createdAt = Date.now();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
    if (m) {
        const d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]), 12, 0, 0);
        if (!isNaN(d.getTime())) createdAt = d.getTime();
    }

    // 把日記偽裝成兩條 Message 餵給 extractMemoriesFromBuffer（id 給負數，不入庫不衝突）
    const fakeMessages: Message[] = [];
    if (userDiaryText?.trim()) {
        fakeMessages.push({
            id: -Math.floor(Math.random() * 1e9),
            charId: char.id,
            role: 'user',
            type: 'text',
            content: `【交換日記 ${dateStr}】我今天寫道：\n${userDiaryText.trim()}`,
            timestamp: createdAt,
        } as Message);
    }
    if (charDiaryText?.trim()) {
        fakeMessages.push({
            id: -Math.floor(Math.random() * 1e9),
            charId: char.id,
            role: 'assistant',
            type: 'text',
            content: `【交換日記 ${dateStr}】我（${char.name}）的回覆日記：\n${charDiaryText.trim()}`,
            timestamp: createdAt + 1000,
        } as Message);
    }
    if (fakeMessages.length === 0) return { status: 'empty_input' };

    // 角色 / 用戶檔案給 LLM 當上下文
    let charContext = `[角色檔案]\n名字: ${char.name}\n核心設定:\n${char.systemPrompt || '無'}\n`;
    if (char.worldview?.trim()) charContext += `世界觀: ${char.worldview}\n`;
    charContext += `\n[用戶檔案]\n名字: ${userName || '用戶'}\n\n[來源說明]\n這是來自【交換日記】app 的一次歸檔，不是普通聊天，是一篇雙方各寫一頁的正式日記。\n`;

    const extracted = await extractMemoriesFromBuffer(
        fakeMessages,
        char.id,
        char.name,
        lightLLMConfig,
        charContext,
        userName || '用戶',
        [], // 不喂相關記憶，避免一次歸檔把 LLM 拉去做跨時間糾正
        [], // 不喂便利貼
    );

    if (extracted.memories.length === 0) {
        console.log(`🏰 [DiaryIngest] LLM 未提取出記憶節點`);
        return { status: 'extracted_none', stored: 0, skipped: 0 };
    }

    // 把 createdAt 改成日記日期，origin 標 system（用戶主動觸發的歸檔）
    for (const node of extracted.memories) {
        node.createdAt = createdAt;
        node.lastAccessedAt = createdAt;
        node.origin = 'system';
    }

    const remoteConfig = getRemoteVectorConfig();
    const result = await vectorizeAndStore(extracted.memories, embeddingConfig, remoteConfig);
    console.log(`🏰 [DiaryIngest] 日記 ${dateStr} 入宮：提取 ${extracted.memories.length} 條，存儲 ${result.stored}，去重跳過 ${result.skipped}`);
    return {
        status: 'done',
        stored: result.stored,
        skipped: result.skipped,
        nodes: extracted.memories.map(n => ({
            content: n.content,
            room: n.room,
            importance: n.importance,
            mood: n.mood,
            tags: n.tags,
        })),
    };
}

// ─── 輸入管線（AI 回覆後，後台） ──────────────────────

// ─── 高水位標記：記錄每個角色處理到的最後消息 ID ────────


/** 獲取當前高水位標記（供外部上下文過濾使用） */
export function getMemoryPalaceHighWaterMark(charId: string): number {
    return getLocalMemoryPalaceHighWaterMark(charId);
}

// ─── 緩衝區配置 ─────────────────────────────────────

/** 處理比例：取緩衝區前 85%，保留尾部 15% 作為下次總結的上下文 */
const PROCESS_RATIO = 0.85;

/**
 * 水位節奏的唯一讀取入口。配置跟隨 CharacterProfile 存在 IndexedDB；調用方無需
 * 判斷消息來自私聊、見面、通話還是劇情，整個 charId 時間線統一使用同一份檔位。
 */
async function loadCharacterWaterline(
    charId: string,
    override?: MemoryPalaceWaterlineConfig,
) {
    if (override) return resolveMemoryPalaceWaterline(override);
    try {
        const characters = await DB.getAllCharacters();
        const character = characters.find(item => item.id === charId);
        return resolveMemoryPalaceWaterline(character?.memoryPalaceWaterline);
    } catch (error) {
        console.warn('🏰 [Pipeline] 讀取角色水位檔位失敗，回退默認 200/100', error);
        return { ...DEFAULT_MEMORY_PALACE_WATERLINE };
    }
}

/**
 * 計算當前"真正可被 pipeline 處理"的緩衝區消息數。
 *
 * 與 processNewMessages 的口徑完全一致：
 *   - 只數語義相關消息（排除純圖片/表情和無轉寫的純音頻；保留有文字的語音與卡片）
 *   - 排除角色檔位指定的最後 N 條（熱區永遠不會被處理）
 *   - 只數 id > 高水位標記的部分
 *
 * 切勿用"id > hwm"裸過濾——那會把當前熱區也算進未同步，
 * 導致 UI 顯示的"未同步條數"遠大於 pipeline 實際能處理的量
 * （表現：彈窗說有幾百條未同步，點立即追平卻跑不出新 hwm）。
 */
export async function getMemoryPalaceUnprocessedBufferCount(
    charId: string,
    waterlineOverride?: MemoryPalaceWaterlineConfig,
): Promise<number> {
    const allMessages = await DB.getMessagesByCharId(charId, true);
    const semantic = allMessages.filter(m => !m.groupId && isMessageSemanticallyRelevant(m));
    const highWaterMark = await getReliableMemoryPalaceHighWaterMark(charId);
    const waterline = await loadCharacterWaterline(charId, waterlineOverride);
    return countUnprocessedBufferMessages(semantic, highWaterMark, waterline.hotZoneSize);
}

/**
 * 聊天設置「一鍵存入」專用統計。與日常後台管線不同，它允許把熱區也納入本次處理，
 * 並按全部原文精確保留 0 或 10 條。
 */
export async function getMemoryPalaceOneShotPendingCount(
    charId: string,
    retainRecentMessages: number = 0,
): Promise<number> {
    const allMessages = await DB.getMessagesByCharId(charId, true);
    const privateMessages = allMessages.filter(message => !message.groupId);
    const semantic = privateMessages.filter(message => isMessageSemanticallyRelevant(message));
    const highWaterMark = await getReliableMemoryPalaceHighWaterMark(charId);
    return countOneShotPendingMessages(
        semantic,
        privateMessages,
        highWaterMark,
        retainRecentMessages,
    );
}

/** 併發鎖：防止多次 AI 回覆同時觸發 processNewMessages 產生競態 */
const processingLocks = new Set<string>();

/**
 * 緩衝區機制處理聊天消息：
 *
 * 1. 熱區 = 角色檔位指定的最近 N 條消息（留在聊天上下文，不處理）
 * 2. 緩衝區 = 高水位標記之後、熱區之前的消息
 * 3. 緩衝區 >= 閾值時：取前 85% → LLM 提取記憶 → Embedding → 更新高水位
 * 4. 保留尾部 15%，避免下次總結時事件沒有起因
 *
 * 相比舊方案（每輪 TopicLoom + 封盒），LLM 調用頻率大幅降低：
 * 只在緩衝區滿時觸發，且只需 1 次 LLM 提取 + Embedding。
 */
/** Pipeline 處理結果 */
export interface PipelineResult {
    stored: number;
    skipped: number;
    /** 本輪 pipeline 從緩衝區取出處理的消息條數（caller 用於進度展示） */
    processedMessages?: number;
    memories: { content: string; room: string; importance: number; mood: string; tags: string[] }[];
    batches: { index: number; total: number; extracted: number; ok: boolean; error?: string }[];
    /**
     * 自動歸檔建議（供 React 層調用 updateCharacter 應用到 char.memories + hideBeforeMessageId）。
     * null = 本輪沒產出新記憶或沒更新水位線，caller 不需要做任何事。
     */
    autoArchive?: {
        /** 按日期切好的新 MemoryFragment 列表，id 已生成，mood='palace' */
        fragments: { id: string; date: string; summary: string; mood: string; palaceMemoryId?: string }[];
        /** 這一批 buffer 處理完後的水位線（= 最後一條被處理 Message.id），應設到 char.hideBeforeMessageId */
        hideBeforeMessageId: number;
    } | null;
    /**
     * 軟跳過原因（非錯誤）：LLM 根本沒跑，原因可能是緩衝區未到閾值 / 熱區還沒被擠出 / 已有任務在跑。
     * caller 看到這個字段就應當提示"聊天還不夠，繼續聊"，而不是報"LLM 提取失敗"。
     */
    skipReason?: 'lock' | 'hot_zone' | 'threshold';
}

/** 構造一個"軟跳過"結果，統一 caller 的分支處理 */
function makeSkipResult(reason: 'lock' | 'hot_zone' | 'threshold'): PipelineResult {
    return { stored: 0, skipped: 0, memories: [], batches: [], skipReason: reason };
}

/** extractAndStoreMemories 的產出：供 caller 決定是否更新水位線 / 跑副作用 */
interface ExtractCoreResult {
    /** 向量化真正存庫的條數 */
    stored: number;
    /** 因語義去重跳過的條數 */
    skipped: number;
    /** 本輪提取出的全部記憶節點（去重命中的不入庫，但仍在此數組裡——建鏈按庫實存過濾，安全） */
    memories: import('./types').MemoryNode[];
    batches: PipelineResult['batches'];
    crossTimeLinks: { newMemoryId: string; existingMemoryId: string }[];
    eventBoxHints: import('./extraction').EventBoxHint[];
    corrections: { targetId: string; note: string }[];
}

/**
 * 核心：把一批消息 → 構建上下文 → LLM 提取 → 向量化入庫。
 *
 * 從 processNewMessages 抽出，供「自動緩衝區總結」與「手動區間總結」兩條路徑共用。
 * **不碰水位線、不做自動歸檔**——這些是 caller（路徑專屬）的職責。
 *
 * @param skipDedup true=不去重（自動路徑：消息靠水位線保證不重複處理，cosine 去重誤傷大）；
 *                  false=去重（手動保底路徑：用戶可能重複總結同一區間，靠去重避免刷出重複記憶）
 */
async function extractAndStoreMemories(
    toProcess: Message[],
    charId: string,
    charName: string,
    embeddingConfig: EmbeddingConfig,
    llmConfig: LightLLMConfig,
    userName: string,
    onProgress: ((stage: string) => void) | undefined,
    skipDedup: boolean,
    requireAllBatches: boolean = false,
): Promise<ExtractCoreResult> {
        // 5. 構建精簡上下文：角色檔案 + 用戶檔案 + 相關已有記憶
        let charContext = '';
        let relatedMemoryRefs: RelatedMemoryRef[] = [];
        try {
            const chars = await DB.getAllCharacters();
            const charProfile = chars.find(c => c.id === charId);
            const userProfile = await DB.getUserProfile();

            // 5a. 精簡角色檔案（姓名、設定、世界觀）
            if (charProfile) {
                charContext += `[角色檔案]\n`;
                charContext += `名字: ${charProfile.name}\n`;
                charContext += `核心設定:\n${charProfile.systemPrompt || '無'}\n`;
                if (charProfile.worldview?.trim()) {
                    charContext += `世界觀: ${charProfile.worldview}\n`;
                }
                charContext += `\n`;
            }

            // 5b. 精簡用戶檔案（姓名、設定）
            if (userProfile) {
                charContext += `[用戶檔案]\n`;
                charContext += `名字: ${userProfile.name}\n`;
                charContext += `設定: ${userProfile.bio || '無'}\n\n`;
            }

            // 5c. 向量檢索相關已有記憶，用於兩個目的：
            //     ① 為 LLM 提取提供上下文（防止誤解隱式指代）
            //     ② 收集結構化引用供 LLM 標註 relatedTo → EventBox 綁定
            //     細粒度策略：每條 ≥4 字的 user 消息獨立 query（和 retrieval spike 對齊，避免把
            //     一整段 chat 揉成 3 段 embed 導致語義平均稀釋）；消息太少時 fallback 3 段切法
            let snippets = splitMessagesToSpikes(toProcess);
            let strategy = 'per-msg';
            if (snippets.length === 0) {
                snippets = sampleSnippetsFromMessages(toProcess, 5, 300);
                strategy = 'fallback-3seg';
            }
            relatedMemoryRefs = await fetchRelatedMemoriesForExtraction(snippets, charId, embeddingConfig);
            if (relatedMemoryRefs.length > 0) {
                console.log(`🏰 [Pipeline] 檢索到 ${relatedMemoryRefs.length} 條相關記憶作為提取上下文（${strategy}，${snippets.length} 段 query）`);
            }

            // 5d. 召回回執補強：路徑①召回時被實際注入 prompt 的 memoryId 一定
            //     參與了角色這段對話——這是判斷"用戶糾正了哪條舊記憶"的可靠線索。
            //     向量召回經常漏掉這類目標（糾正話題離原記憶語義已偏移），所以用
            //     回執查表保底。配額 5 條優先，剩餘格子留給向量召回。
            try {
                const RECEIPT_QUOTA = 5;
                const RECEIPT_TIME_TOLERANCE_MS = 10 * 60 * 1000; // 消息 ts 與 receipt ts 的容差
                const tsList = toProcess.map(m => m.timestamp).filter(t => t > 0);
                if (tsList.length > 0) {
                    const fromTs = Math.min(...tsList) - RECEIPT_TIME_TOLERANCE_MS;
                    const toTs = Math.max(...tsList) + RECEIPT_TIME_TOLERANCE_MS;
                    const receiptIds = getReceiptIdsInRange(charId, fromTs, toTs, RECEIPT_QUOTA);
                    if (receiptIds.length > 0) {
                        // 已經在向量召回裡出現的就不重複加
                        const existingIds = new Set(relatedMemoryRefs.map(r => r.id));
                        const receiptRefs: RelatedMemoryRef[] = [];
                        for (const id of receiptIds) {
                            if (existingIds.has(id)) continue;
                            const node = await MemoryNodeDB.getById(id);
                            // 不喂 archived 節點（早被壓縮歸檔了，糾正它沒意義；該糾正
                            // 的是 box 的 summary，summary 是非 archived，能正常進來）
                            if (!node || node.archived) continue;
                            receiptRefs.push({
                                id: node.id,
                                room: node.room,
                                content: (node.content || '').slice(0, 100),
                            });
                        }
                        if (receiptRefs.length > 0) {
                            // 回執優先放前面（O0..On），向量召回繼續往後排
                            relatedMemoryRefs = [...receiptRefs, ...relatedMemoryRefs];
                            console.log(`🧾 [Pipeline] 召回回執補強：從最近注入歷史拉回 ${receiptRefs.length} 條記憶作為高優先級 relatedMemories`);
                        }
                    }
                }
            } catch (e: any) {
                console.warn(`🧾 [Pipeline] 召回回執查詢失敗（不影響提取）: ${e.message}`);
            }
        } catch (e: any) {
            console.warn(`🏰 [Pipeline] 加載角色上下文失敗（不影響提取）: ${e.message}`);
        }

        // 6. 收集當前便利貼（供 LLM 判斷是否需要提前摘除）
        const now = Date.now();
        const allCharNodes = await MemoryNodeDB.getByCharId(charId);
        const pinnedRefs: PinnedMemoryRef[] = allCharNodes
            .filter(n => n.pinnedUntil && n.pinnedUntil > now)
            .map(n => ({ id: n.id, content: n.content.slice(0, 80) }));

        // 7. LLM 提取記憶 — 大緩衝區分批處理（每批 ~250 條消息）
        //    避免一次喂太多消息導致 LLM 偷懶只提取幾條
        const CHUNK_SIZE = 250;
        const chunks: Message[][] = [];
        for (let i = 0; i < toProcess.length; i += CHUNK_SIZE) {
            chunks.push(toProcess.slice(i, i + CHUNK_SIZE));
        }

        console.log(`🏰 [Pipeline] 開始提取記憶：${toProcess.length} 條消息，分 ${chunks.length} 批（每批 ~${CHUNK_SIZE} 條）`);

        const allMemories: import('./types').MemoryNode[] = [];
        const allCrossTimeLinks: { newMemoryId: string; existingMemoryId: string }[] = [];
        const allEventBoxHints: import('./extraction').EventBoxHint[] = [];
        const allCorrections: { targetId: string; note: string }[] = [];
        const allUnpinIds = new Set<string>();
        const batchResults: PipelineResult['batches'] = [];

        for (let ci = 0; ci < chunks.length; ci++) {
            const chunk = chunks[ci];
            onProgress?.(`正在提取記憶 (${ci + 1}/${chunks.length})...`);
            console.log(`🏰 [Pipeline] 調用 LLM 提取 batch ${ci + 1}/${chunks.length}（${chunk.length} 條消息 → ${llmConfig.model}）`);

            try {
                const extractionResult = await extractMemoriesFromBuffer(
                    chunk, charId, charName, llmConfig, charContext, userName, relatedMemoryRefs, pinnedRefs,
                );
                allMemories.push(...extractionResult.memories);
                allCrossTimeLinks.push(...extractionResult.crossTimeLinks);
                allEventBoxHints.push(...extractionResult.eventBoxHints);
                allCorrections.push(...extractionResult.corrections);
                extractionResult.unpinIds.forEach(id => allUnpinIds.add(id));
                batchResults.push({ index: ci + 1, total: chunks.length, extracted: extractionResult.memories.length, ok: true });
            } catch (e: any) {
                console.warn(`🏰 [Pipeline] batch ${ci + 1} 提取失敗: ${e.message}（繼續下一批）`);
                batchResults.push({ index: ci + 1, total: chunks.length, extracted: 0, ok: false, error: e.message });
            }
        }

        if (requireAllBatches && batchResults.some(batch => !batch.ok)) {
            console.warn('🏰 [Pipeline] 一鍵存入存在失敗批次：不寫向量、不推進水位線，保留原文供下次重試');
            return {
                stored: 0,
                skipped: 0,
                memories: [],
                batches: batchResults,
                crossTimeLinks: [],
                eventBoxHints: [],
                corrections: [],
            };
        }

        // 所有需要保留的批次均提取成功後再摘除便利貼；嚴格模式下避免半成功副作用。
        for (const unpinId of allUnpinIds) {
            const node = allCharNodes.find(n => n.id === unpinId);
            if (node) {
                node.pinnedUntil = null;
                await MemoryNodeDB.save(node);
            }
        }
        if (allUnpinIds.size > 0) {
            console.log(`📌 [Pipeline] 摘除 ${allUnpinIds.size} 條便利貼`);
        }

        const memories = allMemories;

        if (memories.length === 0) {
            console.warn(`🏰 [Pipeline] 所有批次共提取 0 條記憶（${toProcess.length} 條消息），不更新高水位，下次重試`);
            return { stored: 0, skipped: 0, memories: [], batches: batchResults, crossTimeLinks: allCrossTimeLinks, eventBoxHints: allEventBoxHints, corrections: allCorrections };
        }

        console.log(`🏰 [Pipeline] 提取完成：${chunks.length} 批共 ${memories.length} 條記憶`);

        // 7b. 檢測 embedding 模型是否變更，如果變了則重建所有已有向量
        try {
            const consistency = await checkModelConsistency(charId, embeddingConfig.model);
            if (consistency === 'mismatch') {
                console.warn(`🔄 [Pipeline] 檢測到 embedding 模型變更，開始重建已有向量...`);
                const result = await rebuildAllVectors(charId, embeddingConfig, getRemoteVectorConfig());
                console.log(`🔄 [Pipeline] 重建完成：${result.rebuilt} 條向量已更新`);
            }
        } catch (e: any) {
            console.warn(`🔄 [Pipeline] 模型一致性檢查失敗（不影響新記憶存儲）: ${e.message}`);
        }

        // 8. 向量化（Embedding API，按批次）。向量化失敗 → stored=0，caller 據此決定不更新水位。
        console.log(`🏰 [Pipeline] 開始向量化 ${memories.length} 條記憶...`);
        onProgress?.(`正在向量化 ${memories.length} 條記憶...`);
        const vectorResult = await vectorizeAndStore(memories, embeddingConfig, getRemoteVectorConfig(), { skipDedup });
        console.log(`🏰 [Pipeline] 向量化完成：${vectorResult.stored} 條存儲, ${vectorResult.skipped} 條去重跳過`);

        return {
            stored: vectorResult.stored,
            skipped: vectorResult.skipped,
            memories,
            batches: batchResults,
            crossTimeLinks: allCrossTimeLinks,
            eventBoxHints: allEventBoxHints,
            corrections: allCorrections,
        };
}

/**
 * 核心：記憶入庫後的副作用——建鏈 / EventBox 綁定+壓縮 / 應用糾正 / 鞏固。
 *
 * 從 processNewMessages 抽出，自動路徑與手動路徑共用。每一步獨立 try/catch，
 * 失敗不影響已保存的記憶。
 */
async function applyMemorySideEffects(
    charId: string,
    charName: string,
    memories: import('./types').MemoryNode[],
    crossTimeLinks: { newMemoryId: string; existingMemoryId: string }[],
    eventBoxHints: import('./extraction').EventBoxHint[],
    corrections: { targetId: string; note: string }[],
    embeddingConfig: EmbeddingConfig,
    llmConfig: LightLLMConfig,
    userName: string,
): Promise<void> {
        // 10. 建關聯（僅規則，不調 LLM，省錢）— 失敗不影響已保存的記憶
        try {
            const existingNodes = await MemoryNodeDB.getByCharId(charId);
            const justStored = existingNodes.filter(n => memories.some(nn => nn.id === n.id));
            const others = existingNodes.filter(n => !memories.some(nn => nn.id === n.id));
            await buildLinks(justStored, others);
            console.log(`🏰 [Pipeline] 關聯建立完成（${justStored.length} 新節點 vs ${Math.min(others.length, 50)} 已有節點）`);
        } catch (e: any) {
            console.warn(`🏰 [Pipeline] 關聯建立失敗（不影響已保存記憶）: ${e.message}`);
        }

        // 10b. EventBox 綁定：把 LLM 標註的 relatedTo 轉為 EventBox 收納
        //      （舊邏輯：轉 causal MemoryLink 已廢棄，讓位給更強的 EventBox 機制）
        const touchedBoxIds = new Set<string>();
        if (crossTimeLinks.length > 0) {
            try {
                const { bindMemoriesIntoEventBox } = await import('./eventBox');
                const touched = await bindMemoriesIntoEventBox(charId, crossTimeLinks, eventBoxHints);
                for (const id of touched) touchedBoxIds.add(id);
                console.log(`📦 [Pipeline] EventBox 綁定：${crossTimeLinks.length} 條關聯 → 觸達 ${touched.size} 個事件盒`);
            } catch (e: any) {
                console.warn(`📦 [Pipeline] EventBox 綁定失敗（不影響已保存記憶）: ${e.message}`);
            }
        }

        // 10c. EventBox 壓縮：掃描剛被觸達的盒，活節點 ≥ 4 → LLM 二次總結
        if (touchedBoxIds.size > 0) {
            try {
                const { maybeCompressEventBoxes } = await import('./eventBoxCompression');
                await maybeCompressEventBoxes(touchedBoxIds, llmConfig, embeddingConfig, charName, userName);
            } catch (e: any) {
                console.warn(`🗜️ [Pipeline] EventBox 壓縮失敗（不影響已保存記憶）: ${e.message}`);
            }
        }

        // 10d. 應用糾正：把 LLM 標的"用戶糾正了 OX"翻譯成對原節點 content 的追加。
        //     設計：不新增節點、不動 EventBox 結構、不刪原內容——只在 content 末尾
        //     追加一行"（YYYY-MM-DD 糾正：xxx）"，重新向量化即可。下次召回時 LLM
        //     看到帶糾正標籤的內容會自然採用新版本。
        //     放在壓縮之後：避免剛改完 content 的節點被同輪壓縮當 live 節點吞掉。
        if (corrections.length > 0) {
            try {
                // 同一目標多次糾正：合併成一條多分號 note，避免追加多次
                const merged = new Map<string, string[]>();
                for (const c of corrections) {
                    const arr = merged.get(c.targetId) || [];
                    arr.push(c.note);
                    merged.set(c.targetId, arr);
                }

                const dateStr = getLocalDateKey();
                const toRevectorize: import('./types').MemoryNode[] = [];
                for (const [targetId, notes] of merged) {
                    const node = await MemoryNodeDB.getById(targetId);
                    if (!node) {
                        console.warn(`✏️ [Pipeline] 糾正目標 ${targetId} 已不存在，跳過`);
                        continue;
                    }
                    if (node.archived) {
                        // archived 節點不參與召回，糾正它沒意義
                        console.warn(`✏️ [Pipeline] 糾正目標 ${targetId} 已歸檔，跳過`);
                        continue;
                    }
                    const noteText = notes.map(n => n.trim()).filter(Boolean).join('；');
                    if (!noteText) continue;
                    node.content = `${node.content}\n（${dateStr} 糾正：${noteText}）`;
                    node.embedded = false; // 觸發重新向量化
                    node.lastAccessedAt = Date.now();
                    await MemoryNodeDB.save(node);
                    toRevectorize.push(node);
                    console.log(`✏️ [Pipeline] 糾正應用 ${targetId}: "${noteText.slice(0, 40)}…"`);
                }

                if (toRevectorize.length > 0) {
                    // skipDedup：內容剛改的節點必然和原向量"很像"，去重會誤殺自己
                    await vectorizeAndStore(toRevectorize, embeddingConfig, getRemoteVectorConfig(), { skipDedup: true });
                    console.log(`✏️ [Pipeline] ${toRevectorize.length} 條糾正記憶已重新向量化`);
                }
            } catch (e: any) {
                console.warn(`✏️ [Pipeline] 應用糾正失敗（不影響已保存記憶）: ${e.message}`);
            }
        }

        // 11. 鞏固（純計算）— 失敗不影響已保存的記憶
        //     傳 remoteConfig 讓 room 變更同步到 Supabase，跨設備一致
        try {
            await runConsolidation(charId, getRemoteVectorConfig());
        } catch (e: any) {
            console.warn(`🏰 [Pipeline] 鞏固失敗（不影響已保存記憶）: ${e.message}`);
        }
}

export interface ProcessNewMessagesOptions {
    /** 一鍵存入後仍保留為聊天原文的最近消息數；只在 drainBuffer=true 時生效。 */
    retainRecentMessages?: number;
    /** 處理水位線到目標邊界之間的全部內容，不套用日常檔位熱區與 85% 尾部保留。 */
    drainBuffer?: boolean;
    /** 任一 LLM 提取批次失敗時整輪不寫向量、不推進水位線。 */
    requireAllBatches?: boolean;
    /** 測試或剛完成設置寫入時可顯式覆蓋；常規路徑會按 charId 從 IndexedDB 讀取。 */
    waterline?: MemoryPalaceWaterlineConfig;
}

export async function processNewMessages(
    _allRecentMessages: Message[], // 保留參數兼容，但內部直接從 DB 加載
    charId: string,
    charName: string,
    embeddingConfig: EmbeddingConfig,
    llmConfig: LightLLMConfig,
    userName: string = '',
    /** 強制模式：跳過緩衝區閾值檢查，用於一鍵向量化 */
    force: boolean = false,
    /** 進度回調：通知調用方當前階段 */
    onProgress?: (stage: string) => void,
    options: ProcessNewMessagesOptions = {},
): Promise<PipelineResult | null> {
    // 併發鎖：同一角色同時只能跑一次
    if (processingLocks.has(charId)) {
        console.log(`🏰 [Pipeline] 跳過：${charName} 已有處理任務在運行`);
        return makeSkipResult('lock');
    }
    processingLocks.add(charId);

    try {
        // 1. 加載全部消息（含已處理的），計算熱區和緩衝區
        //    過濾：保留任何有語義的消息類型（文字、帶轉寫的語音、卡片、系統事件等），
        //    只排除純視覺資源和無轉寫的純音頻，避免 URL / base64 汙染 LLM。
        const allMessages = await DB.getMessagesByCharId(charId, true);
        const privateMessages = allMessages
            .filter(message => !message.groupId)
            .sort((a, b) => a.id - b.id);
        const textMessages = privateMessages
            .filter(m => isMessageSemanticallyRelevant(m))
            .sort((a, b) => a.id - b.id);

        const totalCount = textMessages.length;
        const lastProcessedId = await getReliableMemoryPalaceHighWaterMark(charId);
        const drainBuffer = options.drainBuffer === true;
        const waterline = await loadCharacterWaterline(charId, options.waterline);
        const hotZoneSize = waterline.hotZoneSize;
        const bufferThreshold = waterline.bufferThreshold;
        const retainedCount = Math.max(0, Math.floor(options.retainRecentMessages || 0));
        const targetHighWaterMark = drainBuffer
            ? getOneShotTargetHighWaterMark(privateMessages, retainedCount)
            : 0;

        let buffer: Message[];
        let hotZoneSizeForLog = hotZoneSize;

        if (drainBuffer) {
            // 一鍵存入的邊界按全部原文計算，真正送給記憶提取的仍只包含有語義的內容。
            // 目標水位可能落在圖片/卡片消息上，這是刻意的：原文範圍必須精確保留 0/10 條。
            buffer = textMessages.filter(message => (
                message.id > lastProcessedId && message.id <= targetHighWaterMark
            ));
            hotZoneSizeForLog = retainedCount;

            if (targetHighWaterMark <= lastProcessedId) {
                console.log(`🏰 [Pipeline] 一鍵存入無需處理：目標水位 ${targetHighWaterMark} <= 當前水位 ${lastProcessedId}`);
                return {
                    stored: 0,
                    skipped: 0,
                    processedMessages: 0,
                    memories: [],
                    batches: [],
                    autoArchive: null,
                };
            }

            // 邊界內只有純媒體/系統殼時沒有內容需要送 LLM，但這些原文本身也無需繼續注入。
            if (buffer.length === 0) {
                await setReliableMemoryPalaceHighWaterMark(charId, targetHighWaterMark);
                onProgress?.('聊天原文邊界已同步');
                return {
                    stored: 0,
                    skipped: 0,
                    processedMessages: 0,
                    memories: [],
                    batches: [],
                    autoArchive: null,
                };
            }
        } else {
            if (totalCount <= hotZoneSize) {
                console.log(`🏰 [Pipeline] 跳過：消息總數 ${totalCount} <= 熱區 ${hotZoneSize}（${waterline.preset}），無需處理`);
                return makeSkipResult('hot_zone');
            }

            // 日常後台路徑：熱區 = 角色檔位指定的最近 N 條。
            const hotZoneStartIdx = totalCount - hotZoneSize;
            const hotZoneStartId = textMessages[hotZoneStartIdx].id;
            buffer = textMessages.filter(m => m.id > lastProcessedId && m.id < hotZoneStartId);
        }

        const minThreshold = drainBuffer ? 1 : (force ? 10 : bufferThreshold);
        if (buffer.length < minThreshold) {
            console.log(`🏰 [Pipeline] 跳過：緩衝區 ${buffer.length} 條 < 閾值 ${minThreshold}（hwm=${lastProcessedId}）`);
            return makeSkipResult('threshold');
        }

        // 日常路徑保留尾部 15% 銜接；一鍵存入嚴格處理到選定邊界。
        const processCount = drainBuffer
            ? buffer.length
            : Math.ceil(buffer.length * PROCESS_RATIO);
        const toProcess = buffer.slice(0, processCount);
        const keptTail = buffer.length - processCount;

        if (toProcess.length === 0) return makeSkipResult('threshold');

        console.log(`🏰 [Pipeline] 開始處理緩衝區：${toProcess.length} 條消息（保留尾部 ${keptTail} 條）`);
        console.log(`🏰 [Pipeline]   消息ID範圍: ${toProcess[0].id} ~ ${toProcess[toProcess.length - 1].id}`);
        console.log(`🏰 [Pipeline]   總消息: ${totalCount}, 熱區: ${hotZoneSizeForLog}, 緩衝區: ${buffer.length}, hwm: ${lastProcessedId}`);
        // 全局廣播：聊天/見面/通話共用同一條消息流與水位線，觸發整理的可能是
        // 任何一個入口。OS 層監聽此事件統一彈「xx正在整理記憶」，用戶不管在哪個
        // App 都能立刻看到。只在真正進入處理路徑後才廣播——skip 不打擾。
        try {
            if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('memory-palace-processing', {
                    detail: { charId, charName, count: toProcess.length },
                }));
            }
        } catch { /* 非瀏覽器環境（測試）無 window */ }
        onProgress?.(`正在整理 ${toProcess.length} 條對話...`);

        // 5–8. 構建上下文 → LLM 提取 → 向量化（共用 extractAndStoreMemories）。
        //       skipDedup=true：聊天總結裡"上週擔心工作 / 這週擔心工作"cosine 完全可能 > 0.9
        //       但是兩件不同時間的事，cosine 去重會精準誤殺；而 high-water-mark 已保證
        //       消息不會被重複處理，去重在這條路徑上收益小、誤傷大。
        const core = await extractAndStoreMemories(
            toProcess, charId, charName, embeddingConfig, llmConfig, userName, onProgress, true,
            options.requireAllBatches === true,
        );

        if (core.memories.length === 0) {
            const allBatchesSucceeded = core.batches.length > 0 && core.batches.every(batch => batch.ok);
            if (drainBuffer && options.requireAllBatches && allBatchesSucceeded) {
                // LLM 成功讀完但判斷沒有值得長期保存的記憶，仍可視為完成了本次記憶處理。
                await setReliableMemoryPalaceHighWaterMark(charId, targetHighWaterMark);
                onProgress?.('記憶整理完成，本段沒有新增長期記憶');
                return {
                    stored: 0,
                    skipped: 0,
                    processedMessages: toProcess.length,
                    memories: [],
                    batches: core.batches,
                    autoArchive: null,
                };
            }
            // helper 內已打印"提取 0 條"或失敗批次日誌；嚴格模式不會推進水位線。
            return { stored: 0, skipped: 0, processedMessages: toProcess.length, memories: [], batches: core.batches };
        }

        // 9. 只有真的存成功了才更新高水位
        if (core.stored === 0) {
            console.warn(`🏰 [Pipeline] 向量化後 0 條存儲成功，不更新高水位`);
            return { stored: 0, skipped: core.skipped, memories: [], batches: core.batches };
        }
        const newHighWaterMark = drainBuffer
            ? targetHighWaterMark
            : toProcess[toProcess.length - 1].id;
        // Resolve committed nodes before advancing the waterline; read failures must not hide messages.
        const storedNodes = (await Promise.all(core.memories.map(memory => MemoryNodeDB.getById(memory.id))))
            .filter((node): node is import('./types').MemoryNode => !!node);
        const autoArchive = buildAutoArchiveFragments(storedNodes, newHighWaterMark, true);
        await setReliableMemoryPalaceHighWaterMark(charId, newHighWaterMark);
        console.log(`✅ [Pipeline] 緩衝區處理完成：${core.stored} 條記憶, hwm ${lastProcessedId} → ${newHighWaterMark}`);
        onProgress?.(`記憶整理完成！新增 ${core.stored} 條記憶`);

        // 自動歸檔只關聯實際落庫的節點；去重跳過的候選不會生成懸空鏈接。
        // 讀取與建議構造在推進水位前完成，不額外調用 LLM / Embedding。

        // 構建返回結果
        const pipelineResult: PipelineResult = {
            stored: core.stored,
            skipped: core.skipped,
            processedMessages: toProcess.length,
            memories: core.memories.map(m => ({ content: m.content, room: m.room, importance: m.importance, mood: m.mood, tags: m.tags })),
            batches: core.batches,
            autoArchive,
        };

        // 10–11. 建鏈 / EventBox / 糾正 / 鞏固（共用 applyMemorySideEffects）
        await applyMemorySideEffects(
            charId, charName, core.memories, core.crossTimeLinks, core.eventBoxHints, core.corrections,
            embeddingConfig, llmConfig, userName,
        );

        return pipelineResult;

    } catch (err: any) {
        console.error(`❌ [Pipeline] processNewMessages 失敗 (charId=${charId}):`, err.message, err.stack?.split('\n')[1] || '');
        return null;
    } finally {
        processingLocks.delete(charId);
    }
}

/** 手動區間總結的結果 */
export interface RangeProcessResult {
    stored: number;
    skipped: number;
    /** 區間內實際送 LLM 的消息條數 */
    processedMessages: number;
    memories: { content: string; room: string; importance: number; mood: string; tags: string[] }[];
    batches: PipelineResult['batches'];
    /**
     * 失敗/空跑原因：
     * - 'lock'        該角色已有處理任務在跑（自動總結或另一次手動總結）
     * - 'empty'       選定區間沒有可處理的語義消息
     * - 'no_memories' LLM 一條記憶都沒提取出來
     * - 其它字符串    異常信息
     */
    error?: 'lock' | 'empty' | 'no_memories' | string;
}

/** 外部文本搬家到記憶宮殿的結果。 */
export interface ExternalMemoryImportResult {
    stored: number;
    skipped: number;
    extracted: number;
    /** 與本次真正寫入向量庫的節點完全同源，供 caller 回寫神經鏈接裡的傳統記憶檔案。 */
    archiveFragments: NonNullable<PipelineResult['autoArchive']>['fragments'];
    /** 記憶宮殿內部的節點關聯邊；不要和“神經鏈接 App”混為一談。 */
    links: number;
    batches: import('./externalMemory').ExternalMemoryBatchResult[];
    error?: 'lock' | 'empty' | 'no_memories' | string;
}

/**
 * 把其它應用/設備導出的原始記憶文字直接遷入當前角色的記憶宮殿。
 *
 * 與聊天緩衝區不同，這條路徑不碰消息水位線：
 * 外部文本 → 保真清洗/整理時間 → 分配房間 → embedding 入庫 → 宮殿內部建鏈/鞏固
 *          → 同源 MemoryFragment 回寫神經鏈接角色檔案（不推進聊天水位線）。
 */
export async function importExternalMemoryText(
    rawText: string,
    charId: string,
    charName: string,
    embeddingConfig: EmbeddingConfig,
    llmConfig: LightLLMConfig,
    userName: string = '',
    onProgress?: (stage: string) => void,
): Promise<ExternalMemoryImportResult> {
    if (processingLocks.has(charId)) {
        return { stored: 0, skipped: 0, extracted: 0, archiveFragments: [], links: 0, batches: [], error: 'lock' };
    }
    processingLocks.add(charId);

    try {
        if (!rawText.trim()) {
            return { stored: 0, skipped: 0, extracted: 0, archiveFragments: [], links: 0, batches: [], error: 'empty' };
        }

        const existingBefore = await MemoryNodeDB.getByCharId(charId);
        const extraction = await extractExternalMemoryText(
            rawText,
            charId,
            charName,
            userName,
            llmConfig,
            onProgress,
        );
        const failedBatch = extraction.batches.find(batch => !batch.ok);
        if (failedBatch) {
            return {
                stored: 0,
                skipped: 0,
                extracted: 0,
                archiveFragments: [],
                links: 0,
                batches: extraction.batches,
                error: `第 ${failedBatch.index}/${failedBatch.total} 批未能無損清洗：${failedBatch.error || '完整性校驗失敗'}。本次沒有寫入任何記憶`,
            };
        }
        if (extraction.memories.length === 0) {
            return {
                stored: 0,
                skipped: 0,
                extracted: 0,
                archiveFragments: [],
                links: 0,
                batches: extraction.batches,
                error: 'no_memories',
            };
        }

        try {
            const consistency = await checkModelConsistency(charId, embeddingConfig.model);
            if (consistency === 'mismatch') {
                onProgress?.('檢測到向量模型已更換，正在重建已有向量…');
                await rebuildAllVectors(charId, embeddingConfig, getRemoteVectorConfig());
            }
        } catch (error: any) {
            console.warn(`🏰 [ExternalImport] 模型一致性檢查失敗（繼續導入）: ${error?.message || error}`);
        }

        onProgress?.(`正在生成 ${extraction.memories.length} 條向量記憶…`);
        const vectorResult = await vectorizeAndStore(
            extraction.memories,
            embeddingConfig,
            getRemoteVectorConfig(),
            { skipDedup: false },
        );

        // 只拿本次真正寫入的節點建鏈；被向量去重跳過的候選不能留下懸空邊。
        const storedIdSet = new Set(extraction.memories.map(memory => memory.id));
        const allAfter = await MemoryNodeDB.getByCharId(charId);
        const justStored = allAfter.filter(node => storedIdSet.has(node.id));

        // 神經鏈接橋接只依賴真正寫入的同批節點；先生成，避免可選關聯步驟失敗時丟掉雙寫。
        const archiveFragments = buildAutoArchiveFragments(justStored, 0)?.fragments || [];
        onProgress?.(`正在建立 ${justStored.length} 條記憶的宮殿內部關聯…`);
        let links: Awaited<ReturnType<typeof buildLinks>> = [];
        try {
            links = await buildLinks(justStored, existingBefore, llmConfig);
        } catch (error: any) {
            console.warn(`🏰 [ExternalImport] 建立關聯失敗，記憶與神經鏈接雙寫仍繼續: ${error?.message || error}`);
        }
        try {
            await runConsolidation(charId, getRemoteVectorConfig());
        } catch (error: any) {
            console.warn(`🏰 [ExternalImport] 鞏固失敗，已寫入記憶不受影響: ${error?.message || error}`);
        }
        // 與全自動總結水位線共用同一個橋接器：同一批 MemoryNode 按日期組成
        // mood='palace' 的 MemoryFragment，交給 UI 合併進當前角色的神經鏈接檔案。
        // 外部導入沒有聊天 Message ID，因此這裡只雙寫記憶，不推進/偽造聊天水位線。
        onProgress?.(`搬家完成：新增 ${vectorResult.stored} 條向量記憶`);

        return {
            stored: vectorResult.stored,
            skipped: vectorResult.skipped,
            extracted: extraction.memories.length,
            archiveFragments,
            links: links.length,
            batches: extraction.batches,
        };
    } catch (error: any) {
        console.error(`❌ [ExternalImport] ${charName} 外部記憶導入失敗:`, error);
        return {
            stored: 0,
            skipped: 0,
            extracted: 0,
            archiveFragments: [],
            links: 0,
            batches: [],
            error: error?.message || String(error),
        };
    } finally {
        processingLocks.delete(charId);
    }
}

/**
 * 手動區間總結與向量化（保底機制）。
 *
 * 用戶在「手動總結與向量化」面板裡圈定 [fromMsgId, toMsgId] 區間，這條路徑：
 *   - **完全不讀、不寫水位線**（mp_lastMsgId_*）—— 和自動總結井水不犯河水，
 *     重複跑同一區間也不會"吃掉"消息、不會打亂自動總結進度；
 *   - **開啟去重**（skipDedup=false）—— 用戶可能重複總結已總結過的區間（"不知道上次成沒成"），
 *     去重保證不會刷出一堆重複記憶，stored/skipped 也如實反饋"這次新增幾條 / 幾條早就有了"；
 *   - 不做自動歸檔（buildAutoArchiveFragments）—— 那條路徑會推聊天水位線/隱藏消息，與"不碰水位線"衝突。
 *
 * 與 processNewMessages 共用 extractAndStoreMemories + applyMemorySideEffects，
 * 提取質量、建鏈、EventBox、鞏固邏輯完全一致。
 */
export async function processMessageRange(
    charId: string,
    charName: string,
    embeddingConfig: EmbeddingConfig,
    llmConfig: LightLLMConfig,
    fromMsgId: number,
    toMsgId: number,
    userName: string = '',
    onProgress?: (stage: string) => void,
): Promise<RangeProcessResult> {
    // 複用同一把併發鎖：避免和自動總結 / 另一次手動總結同時寫同角色記憶產生競態
    if (processingLocks.has(charId)) {
        console.log(`🏰 [Pipeline] 手動區間總結跳過：${charName} 已有處理任務在運行`);
        return { stored: 0, skipped: 0, processedMessages: 0, memories: [], batches: [], error: 'lock' };
    }
    processingLocks.add(charId);

    try {
        const lo = Math.min(fromMsgId, toMsgId);
        const hi = Math.max(fromMsgId, toMsgId);

        // 只加載用戶選區內的正文，含已處理消息，不推進水位線。
        const allMessages = await loadRangeMessageContents(charId, lo, hi);
        const toProcess = allMessages
            .filter(m => isMessageSemanticallyRelevant(m))
            .filter(m => m.id >= lo && m.id <= hi)
            .sort((a, b) => a.id - b.id);

        if (toProcess.length === 0) {
            console.log(`🏰 [Pipeline] 手動區間總結：區間 [${lo}, ${hi}] 內沒有可處理的消息`);
            return { stored: 0, skipped: 0, processedMessages: 0, memories: [], batches: [], error: 'empty' };
        }

        console.log(`🏰 [Pipeline] 手動區間總結開始：${toProcess.length} 條消息（id ${toProcess[0].id} ~ ${toProcess[toProcess.length - 1].id}），不碰水位線`);
        onProgress?.(`正在整理 ${toProcess.length} 條對話...`);

        // 提取 + 向量化（去重開啟）
        const core = await extractAndStoreMemories(
            toProcess, charId, charName, embeddingConfig, llmConfig, userName, onProgress, false,
        );

        if (core.memories.length === 0) {
            return { stored: 0, skipped: 0, processedMessages: toProcess.length, memories: [], batches: core.batches, error: 'no_memories' };
        }

        // 關鍵：不更新水位線、不做自動歸檔。只跑入庫後的副作用。
        await applyMemorySideEffects(
            charId, charName, core.memories, core.crossTimeLinks, core.eventBoxHints, core.corrections,
            embeddingConfig, llmConfig, userName,
        );

        console.log(`✅ [Pipeline] 手動區間總結完成：新增 ${core.stored} 條，去重跳過 ${core.skipped} 條（水位線未改動）`);
        onProgress?.(`完成！新增 ${core.stored} 條記憶${core.skipped > 0 ? `，${core.skipped} 條因重複跳過` : ''}`);

        return {
            stored: core.stored,
            skipped: core.skipped,
            processedMessages: toProcess.length,
            memories: core.memories.map(m => ({ content: m.content, room: m.room, importance: m.importance, mood: m.mood, tags: m.tags })),
            batches: core.batches,
        };
    } catch (err: any) {
        console.error(`❌ [Pipeline] processMessageRange 失敗 (charId=${charId}):`, err.message, err.stack?.split('\n')[1] || '');
        return { stored: 0, skipped: 0, processedMessages: 0, memories: [], batches: [], error: err.message || '未知錯誤' };
    } finally {
        processingLocks.delete(charId);
    }
}
