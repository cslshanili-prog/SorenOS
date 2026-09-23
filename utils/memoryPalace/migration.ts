/**
 * Memory Palace — 舊記憶遷移工具 (Migration)
 *
 * 按月把舊的 MemoryFragment[] 日度總結送給 LLM，
 * 以角色第一人稱視角重新提取為 MemoryNode。
 * 月度總結（refinedMemories）不需要，日度總結信息更完整。
 * 舊數據不刪不改。
 */

import type { MemoryFragment } from '../../types';
import type { MemoryNode, MemoryRoom, EmbeddingConfig } from './types';
import type { LightLLMConfig } from './pipeline';
import { MemoryNodeDB } from './db';
import { vectorizeAndStore } from './vectorStore';
import { buildLinks } from './links';
import { runConsolidation } from './consolidation';
import { safeFetchJson } from '../safeApi';
import { safeParseJsonArray } from './jsonUtils';
import {
    buildRelatedMemoriesBlock, buildRelatedToRule, buildRelatedToFormatHint,
    parseRelatedToAndHints,
} from './extraction';
import type { RelatedMemoryRef, EventBoxHint } from './extraction';
import { fetchRelatedMemoriesForExtraction, splitLogsToBullets, sampleSnippetsFromMessages } from './relatedMemories';
import { bindMemoriesIntoEventBox } from './eventBox';
import { maybeCompressEventBoxes } from './eventBoxCompression';

function generateId(): string {
    return `mn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 把 LLM 吐的 v/a 夾到 [-1, 1]，防止它寫成 1.5 / -2 之類 */
function clampVA(x: number): number {
    if (Number.isNaN(x)) return 0;
    if (x > 1) return 1;
    if (x < -1) return -1;
    return x;
}

// ─── 按月分組 ────────────────────────────────────────

function groupByMonth(memories: MemoryFragment[]): Map<string, MemoryFragment[]> {
    const groups = new Map<string, MemoryFragment[]>();
    for (const mem of memories) {
        // 日期格式可能是 "2026-01-27", "2026/1/27", "2026年1月27日" 等
        let monthKey = 'unknown';
        try {
            const normalized = mem.date.replace(/[年\/]/g, '-').replace(/[月日]/g, '');
            const parts = normalized.split('-');
            if (parts.length >= 2) {
                monthKey = `${parts[0]}-${parts[1].padStart(2, '0')}`;
            }
        } catch { /* keep unknown */ }

        const existing = groups.get(monthKey) || [];
        existing.push(mem);
        groups.set(monthKey, existing);
    }
    return groups;
}

// ─── LLM 按月提取記憶 ────────────────────────────────

interface ChunkExtractionResult {
    /** 提取出的"待安頓"節點（已帶 charId 和 createdAt，待補充 id/embedded 等字段後存盤） */
    items: (Omit<MemoryNode, 'id' | 'charId' | 'embedded' | 'lastAccessedAt' | 'accessCount'> & { _parsedIdx: number })[];
    /** LLM 標註的 relatedTo（指向已有記憶 O0..）/ sameAs（指向本批次內其它新記憶 0-base）引用；binding 階段映射成真實 id */
    rawRelated: {
        itemIdx: number;
        refs: string[];           // O 編號 → 已有記憶
        sameAsRefs: string[];     // N 或純數字 → 本批次新記憶（只能指向 itemIdx 之前的條目）
        eventName?: string;
        eventTags?: string[];
    }[];
}

async function extractMonthMemories(
    monthKey: string,
    dailyLogs: MemoryFragment[],
    charName: string,
    charContext: string,
    llmConfig: LightLLMConfig,
    userName: string | undefined,
    relatedMemories: RelatedMemoryRef[],
): Promise<ChunkExtractionResult> {

    // 拼接該月所有日度總結，不截斷
    const logsText = dailyLogs
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(m => `[${m.date}] (${m.mood || 'neutral'}): ${m.summary}`)
        .join('\n\n');

    const contextBlock = charContext
        ? `\n## 你的人設\n${charContext}\n`
        : '';

    const userLabel = userName || 'TA';

    const hasRelated = relatedMemories.length > 0;
    const relatedBlock = hasRelated ? buildRelatedMemoriesBlock(relatedMemories) : '';
    const relatedToRule = hasRelated ? buildRelatedToRule() : '';
    const relatedToFormat = hasRelated ? buildRelatedToFormatHint() : '';

    const systemPrompt = `你是 ${charName}。以下是你 ${monthKey} 這個月的日常記錄。請以你的第一人稱視角（"我"），從中提取值得長期記住的記憶。${contextBlock}${relatedBlock}

## 規則

1. **第一人稱敘事**：用"我"的視角記錄，用戶用"${userLabel}"指代。保持完整事件脈絡，不要掐頭去尾。
2. **重要性分級**：
   - 1–5：日常瑣事（15–50字）
   - 6–7：有情感價值的事件（60–120字），包含我的感受
   - 8–10：重大事件（100–200字），完整因果+我的反應
3. **房間分配**（凡是涉及${userLabel}的家人/朋友/同事等人際關係，**一律進 user_room**，哪怕只是一次具體事件）：
   - living_room：**純日常瑣事**（不涉及重要人際關係、也不涉及深層情感）
   - bedroom：${userLabel}和我之間的親密情感、深層羈絆、感動時刻
   - study：工作、學習、技能
   - user_room：關於${userLabel}的**一切個人信息和人際事件**——生日/習慣/喜好/性格/成長經歷/情緒模式，**以及${userLabel}的家人、親戚、朋友、同事相關的一切事件**（家人健康、家庭聚會、家庭矛盾、外公外婆/父母/兄弟姐妹的故事、朋友交往、同事衝突等）。這些事件即便是"一次性"的，也應進 user_room 而不是 living_room。
   - self_room：我自身的成長、認同變化
   - attic：未解決的矛盾、困惑、傷害
   - windowsill：期盼、目標、憧憬
4. **情緒標籤**：happy, sad, angry, anxious, tender, excited, peaceful, confused, hurt, grateful, nostalgic, neutral
5. **情感座標**（valence, arousal）：在 mood 之外，還要給出二維情感座標供後續情感推理。
   - valence（效價）：-1（極痛苦）→ +1（極愉悅）
   - arousal（喚醒度）：-1（極平靜）→ +1（極激烈）
   參考："開心"約 (0.7, 0.5)，"平靜"約 (0.5, -0.6)，"失落"約 (-0.5, -0.4)，"焦慮"約 (-0.6, 0.7)，"憤怒"約 (-0.7, 0.8)。
6. **不要遺漏任何事件**。這些日度總結本身已經是精華，每一件事都值得保留為獨立記憶。一條日度總結裡如果有3件事，就提取3條記憶。寧可多提取，不要壓縮遺漏。
7. **必須保留精確日期**：date 字段填該事件發生的具體日期（從日誌的日期標籤讀取）。內容中也自然提及時間。${relatedToRule}

## 輸出

嚴格 JSON 數組，不要用 markdown 包裹，直接輸出 JSON：
[{"content": "...", "room": "...", "importance": 5, "mood": "...", "valence": 0, "arousal": 0, "tags": ["..."], "date": "YYYY-MM-DD"${relatedToFormat}}]

注意：content 中的引號必須用中文引號（""）而不是英文引號，避免 JSON 解析出錯。

date 字段填記憶對應的大概日期。`;

    try {
        const data = await safeFetchJson(
            `${llmConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${llmConfig.apiKey}`,
                },
                body: JSON.stringify({
                    model: llmConfig.model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: logsText },
                    ],
                    temperature: 0.5,
                    // 12000 比 16000 留餘量，避免 LLM 貼著 cap 產出被截斷；
                    // 配合外層 sub-batch 切分（≤6 天/call），輸出 token 一般在 3k-6k，12k 充分夠
                    max_tokens: 12000,
                    stream: false,
                }),
            },
            1,         // 失敗只再試 1 次（整體 3 次 × 5min = 15min 太久）
            5 * 60_000, // 單次 5 分鐘硬超時：第一批 142s 就過了，若超過 5min 基本是 provider 卡死，
                       // 繼續等只會讓用戶誤以為整頁凍住（實際主線程閒著等 fetch），主動 abort 切下一批。
            { appName: '記憶宮殿', purpose: '記憶遷移' }
        );

        const reply = data.choices?.[0]?.message?.content || '';
        const parsed = safeParseJsonArray(reply);

        if (!Array.isArray(parsed) || parsed.length === 0) {
            if (reply.trim().length > 0) {
                console.warn(`🏰 [Migration] ${monthKey}: LLM 返回了內容但解析為空，原始回覆前200字: ${reply.slice(0, 200)}`);
            } else {
                console.warn(`🏰 [Migration] ${monthKey}: LLM 返回空內容`);
            }
            return { items: [], rawRelated: [] };
        }

        const validRooms: MemoryRoom[] = [
            'living_room', 'bedroom', 'study', 'user_room',
            'self_room', 'attic', 'windowsill',
        ];

        const items: ChunkExtractionResult['items'] = [];
        const rawRelated: ChunkExtractionResult['rawRelated'] = [];

        let itemIdx = 0;
        for (let parsedIdx = 0; parsedIdx < parsed.length; parsedIdx++) {
            const item = parsed[parsedIdx];
            if (!item || !item.content) continue;

            // 解析日期
            let createdAt = Date.now();
            try {
                if (item.date) {
                    const d = new Date(item.date);
                    if (!isNaN(d.getTime())) createdAt = d.getTime();
                }
            } catch { /* use now */ }

            // (v, a) 非必需：LLM 沒給就不寫，下游 getEmotionVA 查表兜底
            const vRaw = typeof item.valence === 'number' ? item.valence : undefined;
            const aRaw = typeof item.arousal === 'number' ? item.arousal : undefined;
            const valence = vRaw !== undefined ? clampVA(vRaw) : undefined;
            const arousal = aRaw !== undefined ? clampVA(aRaw) : undefined;

            items.push({
                content: item.content,
                room: (validRooms.includes(item.room as MemoryRoom) ? item.room : 'living_room') as MemoryRoom,
                tags: Array.isArray(item.tags) ? item.tags : [],
                importance: Math.max(1, Math.min(10, Math.round(item.importance || 5))),
                mood: item.mood || 'neutral',
                valence,
                arousal,
                createdAt,
                _parsedIdx: parsedIdx,
            });

            // 收集 relatedTo（跨批次）+ sameAs（本批次內）+ eventName/eventTags
            const relatedTo = Array.isArray(item.relatedTo)
                ? item.relatedTo.map((r: any) => String(r)) : [];
            const sameAsRefs = Array.isArray(item.sameAs)
                ? item.sameAs.map((r: any) => String(r)) : [];
            if (relatedTo.length > 0 || sameAsRefs.length > 0) {
                rawRelated.push({
                    itemIdx,
                    refs: relatedTo,
                    sameAsRefs,
                    eventName: typeof item.eventName === 'string' ? item.eventName.trim() : undefined,
                    eventTags: Array.isArray(item.eventTags)
                        ? item.eventTags.map((t: any) => String(t).trim()).filter(Boolean)
                        : undefined,
                });
            }
            itemIdx++;
        }

        return { items, rawRelated };

    } catch (err: any) {
        console.error(`❌ [Migration] ${monthKey} LLM 提取失敗:`, err.message);
        return { items: [], rawRelated: [] };
    }
}

// ─── 主遷移函數 ─────────────────────────────────────

export interface MigrationProgress {
    phase: 'grouping' | 'extracting' | 'vectorizing' | 'linking' | 'done';
    current: number;
    total: number;
    currentMonth?: string;
}

/**
 * 按月把舊記憶送給 LLM 重新提取，然後向量化存入記憶宮殿
 *
 * @param charName 角色名（LLM 用第一人稱時需要知道自己是誰）
 * @param memories 舊的 MemoryFragment[]（日度總結）
 * @param llmConfig 輕量 LLM 配置
 * @param embeddingConfig Embedding 配置
 * @param onProgress 進度回調
 */
/**
 * 獲取舊記憶的可用月份列表（供 UI 選擇）
 */
export function getAvailableMonths(memories: MemoryFragment[]): string[] {
    const monthGroups = groupByMonth(memories);
    return Array.from(monthGroups.keys()).sort();
}

/**
 * 將一個月的日誌拆成上旬/中旬/下旬 3 個分塊
 */
function splitMonthToThirds(monthKey: string, dailyLogs: MemoryFragment[]): { key: string; logs: MemoryFragment[] }[] {
    const sorted = dailyLogs.sort((a, b) => a.date.localeCompare(b.date));
    const upper: MemoryFragment[] = [];   // 1-10 日
    const middle: MemoryFragment[] = [];  // 11-20 日
    const lower: MemoryFragment[] = [];   // 21-31 日

    for (const log of sorted) {
        let day = 15; // 默認歸中旬
        try {
            const normalized = log.date.replace(/[年\/]/g, '-').replace(/[月日]/g, '');
            const parts = normalized.split('-');
            if (parts.length >= 3) day = parseInt(parts[2], 10) || 15;
        } catch { /* default middle */ }

        if (day <= 10) upper.push(log);
        else if (day <= 20) middle.push(log);
        else lower.push(log);
    }

    const result: { key: string; logs: MemoryFragment[] }[] = [];
    if (upper.length > 0) result.push({ key: `${monthKey} 上旬`, logs: upper });
    if (middle.length > 0) result.push({ key: `${monthKey} 中旬`, logs: middle });
    if (lower.length > 0) result.push({ key: `${monthKey} 下旬`, logs: lower });

    // 如果因為日期解析問題全部落入同一個分塊或為空，直接返回整月
    if (result.length === 0) result.push({ key: monthKey, logs: sorted });

    return result;
}

/**
 * 獲取可用的分塊列表（每月拆上旬/中旬/下旬），供 UI 逐塊選擇
 * 返回 { key: "2026-03 上旬", count: 12 }[]
 */
export function getAvailableChunks(memories: MemoryFragment[]): { key: string; count: number }[] {
    const monthGroups = groupByMonth(memories);
    const months = Array.from(monthGroups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const chunks: { key: string; count: number }[] = [];
    for (const [monthKey, dailyLogs] of months) {
        const parts = splitMonthToThirds(monthKey, dailyLogs);
        for (const part of parts) {
            chunks.push({ key: part.key, count: part.logs.length });
        }
    }
    return chunks;
}

export async function migrateOldMemories(
    charId: string,
    charName: string,
    memories: MemoryFragment[],
    refinedMemories: Record<string, string> | undefined,
    llmConfig: LightLLMConfig,
    embeddingConfig: EmbeddingConfig,
    onProgress?: (p: MigrationProgress) => void,
    charContext?: string,
    selectedMonths?: string[],
    userName?: string,
    /** 可選：傳入則遷移尾部的 consolidation room 變更會同步到 Supabase */
    remoteConfig?: import('./types').RemoteVectorConfig,
): Promise<{ migrated: number; skipped: number; months: number }> {

    if (memories.length === 0) return { migrated: 0, skipped: 0, months: 0 };

    // 1. 按月分組
    onProgress?.({ phase: 'grouping', current: 0, total: memories.length });
    const monthGroups = groupByMonth(memories);
    let months = Array.from(monthGroups.entries())
        .sort((a, b) => a[0].localeCompare(b[0]));

    // 2. 每月拆成上旬/中旬/下旬 3 個分塊
    const allNodes: MemoryNode[] = [];

    const chunks: { key: string; logs: MemoryFragment[] }[] = [];
    for (const [monthKey, dailyLogs] of months) {
        const parts = splitMonthToThirds(monthKey, dailyLogs);
        chunks.push(...parts);
    }

    // 如果指定了分塊，只處理選中的分塊
    let filteredChunks = chunks;
    if (selectedMonths && selectedMonths.length > 0) {
        const selected = new Set(selectedMonths);
        filteredChunks = chunks.filter(c => selected.has(c.key));
        console.log(`🏰 [Migration] 已選分塊: [${selectedMonths.join(', ')}]，共 ${filteredChunks.length} 個分塊`);
    } else {
        console.log(`🏰 [Migration] 全量遷移：${memories.length} 條日度總結 → ${months.length} 個月 → ${filteredChunks.length} 個分塊`);
    }

    const total = filteredChunks.length;
    console.log(`🏰 [Migration] 待處理 ${total} 個分塊（每月拆上旬/中旬/下旬）`);

    // 累計：所有分塊產生的 EventBox 觸達 ID（最後統一壓縮）
    const allTouchedBoxIds = new Set<string>();
    let migrated = 0;
    let skipped = 0;

    for (let i = 0; i < filteredChunks.length; i++) {
        const { key: chunkKey, logs: allChunkLogs } = filteredChunks[i];
        // 再次切分：避免一次餵給 LLM 太多日度總結導致輸出 token 被 cap 截斷
        // （16000 max_tokens 聽起來很多，但 LLM 要輸出 60-80 條 JSON 記憶 + 每條帶
        // sameAs/relatedTo/eventName/eventTags 字段，很容易撐爆。thinking 模型還要
        // 額外吞 reasoning tokens。）
        const MAX_LOGS_PER_LLM_CALL = 6;
        const subBatches: { logs: MemoryFragment[]; label: string }[] = [];
        for (let off = 0; off < allChunkLogs.length; off += MAX_LOGS_PER_LLM_CALL) {
            const part = allChunkLogs.slice(off, off + MAX_LOGS_PER_LLM_CALL);
            const label = allChunkLogs.length > MAX_LOGS_PER_LLM_CALL
                ? `${chunkKey} (${off + 1}-${off + part.length}/${allChunkLogs.length})`
                : chunkKey;
            subBatches.push({ logs: part, label });
        }

        for (let sbIdx = 0; sbIdx < subBatches.length; sbIdx++) {
            const { logs: dailyLogs, label: currentLabel } = subBatches[sbIdx];
            onProgress?.({ phase: 'extracting', current: i + 1, total, currentMonth: currentLabel });

        // 1) 取相關舊記憶（含本次遷移已落地的較早 chunk，所以"3 月上旬→3 月中旬"能跨 chunk 關聯）
        //    細粒度策略：日誌歸檔是 YAML 列表 (`- 事件X`)，按 bullet 拆成每條事件一個 query；
        //    切不出列表（模板被改過）時 fallback 到舊的 3 段切法
        const sortedLogs = dailyLogs.slice().sort((a, b) => a.date.localeCompare(b.date));
        let logSnippets = splitLogsToBullets(sortedLogs);
        let strategy = 'bullets';
        if (logSnippets.length === 0) {
            logSnippets = buildLogSnippets(sortedLogs);
            strategy = 'per-sentence';
        }
        // 遷移場景：候選池必須夠大，LLM 才能在"新記憶 B"旁看到"舊記憶 A"
        // 做匹配。threshold 放鬆一些，maxTotal 翻倍到 30。
        const relatedRefs = await fetchRelatedMemoriesForExtraction(logSnippets, charId, embeddingConfig, {
            threshold: 0.30,
            perQueryTopK: 3,
            maxTotal: 30,
        });
        if (relatedRefs.length > 0) {
            console.log(`🏰 [Migration] [${i + 1}/${total}] 檢索到 ${relatedRefs.length} 條相關已有記憶（${strategy}，${logSnippets.length} 段 query）`);
        } else {
            console.log(`🏰 [Migration] [${i + 1}/${total}] 候選池為空（${strategy}，${logSnippets.length} 段 query） —— 可能本批次是最早的遷移批次，沒舊記憶可匹配`);
        }

        // 2) LLM 提取（帶 relatedTo 提示）
        console.log(`🏰 [Migration] [${i + 1}/${total}] 開始 LLM 提取 → ${currentLabel}（${dailyLogs.length} 條日度總結），模型: ${llmConfig.model}`);
        const llmStart = Date.now();
        const { items, rawRelated } = await extractMonthMemories(
            currentLabel, dailyLogs, charName, charContext || '', llmConfig, userName, relatedRefs,
        );
        const llmElapsed = ((Date.now() - llmStart) / 1000).toFixed(1);
        console.log(`🏰 [Migration] [${i + 1}/${total}] LLM 提取完成 ← ${currentLabel}: ${items.length} 條記憶，耗時 ${llmElapsed}s`);

        if (items.length === 0) continue;

        // 3) 組裝 MemoryNode 並立即向量化（讓後續 chunk 能搜到）
        const chunkNodes: MemoryNode[] = [];
        for (const item of items) {
            chunkNodes.push({
                id: generateId(),
                charId,
                content: item.content,
                room: item.room,
                tags: item.tags,
                importance: item.importance,
                mood: item.mood,
                valence: item.valence,
                arousal: item.arousal,
                embedded: false,
                createdAt: item.createdAt,
                lastAccessedAt: item.createdAt,
                accessCount: 0,
                eventBoxId: null,
                origin: 'extraction',
            });
            await new Promise(r => setTimeout(r, 2)); // 避免 ID 碰撞
        }

        onProgress?.({ phase: 'vectorizing', current: i + 1, total, currentMonth: currentLabel });
        const vecStart = Date.now();
        // 走 0.9 cosine 去重：之前遷移路徑關去重是因為懷疑加載全量 Float32Array 導致
        // tab 凍死，後來查出真兇是 Supabase RPC CORS 放大 + Worker 併發 handler 覆蓋
        //（見 vectorSearch.ts / relatedMemories.ts 的熔斷邏輯），跟這裡的去重無關。
        // 語義去重能擋掉"7-12 號某天又提到 3 號那件事"這種跨 sub-batch 重複。
        //
        // 遠程同步：以前這裡傳 undefined 導致遷移寫入的新節點只落本地 IDB，
        // 跨設備或本地清空後就徹底丟失。現在跟著 pipeline.ts processNewMessages 一樣
        // 透傳 remoteConfig，讓每條新節點的向量也 fire-and-forget upsert 到 Supabase。
        const vecResult = await vectorizeAndStore(chunkNodes, embeddingConfig, remoteConfig);
        const vecElapsed = ((Date.now() - vecStart) / 1000).toFixed(1);
        migrated += vecResult.stored;
        skipped += vecResult.skipped;
        console.log(`🏰 [Migration] [${i + 1}/${total}] 向量化完成：存儲 ${vecResult.stored}，跳過 ${vecResult.skipped}，耗時 ${vecElapsed}s`);

        // 4) EventBox 綁定：rawRelated 引用 → 真實 memoryId 鏈接 + hints
        //    同時處理跨批次 O 引用 (refs) 和本批次 N 引用 (sameAsRefs)
        //    本批次內 A 和 B 同事件（比如 4.5 和 4.9 在同一 chunk 但同一件事）就在這裡捕獲
        if (rawRelated.length > 0) {
            const crossLinks: { newMemoryId: string; existingMemoryId: string }[] = [];
            const hints: EventBoxHint[] = [];
            for (const r of rawRelated) {
                const newNode = chunkNodes[r.itemIdx];
                if (!newNode) continue;
                // (a) 跨批次 O 引用（指向已有記憶）
                for (const ref of r.refs) {
                    const idx = parseInt(String(ref).replace(/^O/i, ''), 10);
                    if (idx >= 0 && idx < relatedRefs.length) {
                        crossLinks.push({
                            newMemoryId: newNode.id,
                            existingMemoryId: relatedRefs[idx].id,
                        });
                    }
                }
                // (b) 本批次 sameAs 引用（指向 itemIdx 之前的新記憶）
                for (const ref of r.sameAsRefs) {
                    const idx = parseInt(String(ref).replace(/^N/i, ''), 10);
                    if (idx >= 0 && idx < r.itemIdx && chunkNodes[idx]) {
                        crossLinks.push({
                            newMemoryId: newNode.id,
                            existingMemoryId: chunkNodes[idx].id,
                        });
                    }
                }
                if (r.eventName || (r.eventTags && r.eventTags.length > 0)) {
                    hints.push({
                        newMemoryId: newNode.id,
                        eventName: r.eventName || '',
                        eventTags: r.eventTags || [],
                    });
                }
            }
            if (crossLinks.length > 0) {
                try {
                    const touched = await bindMemoriesIntoEventBox(charId, crossLinks, hints);
                    for (const id of touched) allTouchedBoxIds.add(id);
                    console.log(`📦 [Migration] [${i + 1}/${total}] EventBox 綁定：${crossLinks.length} 條 → 觸達 ${touched.size} 個事件盒`);
                } catch (e: any) {
                    console.warn(`📦 [Migration] [${i + 1}/${total}] EventBox 綁定失敗（不影響已存記憶）: ${e.message}`);
                }
            }
        }
        // 每個 sub-batch 跑完：短暫 idle，讓 V8 回收本輪產生的 Float32Array / LLM 響應串
        // （單 chunk 跨多個 sub-batch 時避免堆壓力累積導致後面分塊崩 tab）
        if (sbIdx < subBatches.length - 1) {
            await new Promise(r => setTimeout(r, 200));
        }
        } // end of inner sub-batch loop

        // 每個 chunk 跑完：更長的 idle，給瀏覽器充足時間做一次 minor/major GC
        // 觀察到"第一 chunk OK 第二 chunk 卡爆"是典型的堆碎片化症狀，GC 只要有時間就能回收
        if (i < filteredChunks.length - 1) {
            await new Promise(r => setTimeout(r, 600));
        }
    }

    if (migrated === 0 && skipped === 0) {
        onProgress?.({ phase: 'done', current: 0, total: 0 });
        return { migrated: 0, skipped: 0, months: filteredChunks.length };
    }

    // 5) EventBox 壓縮：所有 chunk 處理完後統一掃一遍觸達的 box
    if (allTouchedBoxIds.size > 0) {
        console.log(`🗜️ [Migration] 開始壓縮 ${allTouchedBoxIds.size} 個被觸達的事件盒...`);
        try {
            await maybeCompressEventBoxes(allTouchedBoxIds, llmConfig, embeddingConfig, charName, userName);
        } catch (e: any) {
            console.warn(`🗜️ [Migration] 壓縮失敗（不影響已存記憶）: ${e.message}`);
        }
    }

    // 6) buildLinks：保留 temporal/co-activation 弱關聯（不影響 EventBox）
    console.log(`🏰 [Migration] 開始建立 MemoryLink 弱關聯...`);
    const linkStart = Date.now();
    onProgress?.({ phase: 'linking', current: 0, total: migrated });

    const allStored = await MemoryNodeDB.getByCharId(charId);
    const migratedNodes = allStored.filter(n =>
        n.origin === 'extraction' && !n.archived && !n.isBoxSummary
    );

    if (migratedNodes.length >= 2) {
        const linkBatchSize = 30;
        for (let i = 0; i < migratedNodes.length; i += linkBatchSize) {
            const batch = migratedNodes.slice(i, i + linkBatchSize);
            const rest = migratedNodes.filter(n => !batch.some(b => b.id === n.id));
            await buildLinks(batch, rest.slice(0, 50));
        }
    }

    const linkElapsed = ((Date.now() - linkStart) / 1000).toFixed(1);
    console.log(`🏰 [Migration] 弱關聯建立完成，耗時 ${linkElapsed}s`);

    // 7) 補跑鞏固：遷移寫入的節點沒經過日常聊天管線的 processNewMessages，
    //    也就沒跑過 runConsolidation。高 imp（≥8）和 imp≥6 且年代較老的節點
    //    按規則本應從 living_room 晉升到 bedroom，不做這一步，它們會永遠卡在
    //    living_room（similarity 權重 0.50 + recency 幾乎歸零），導致檢索時
    //    高相關老家庭記憶排不上來。失敗不影響遷移結果。
    //    remoteConfig 已在 vectorizeAndStore 階段把新節點推到 Supabase，
    //    這裡 consolidation 內部的 bulkSetRoom 會把 room 字段一併同步過去。
    try {
        const consolidationResult = await runConsolidation(charId, remoteConfig);
        if (consolidationResult.promoted.length > 0 || consolidationResult.evicted.length > 0) {
            console.log(`✅ [Migration] 遷移後鞏固：${consolidationResult.promoted.length} 條晉升到 bedroom，${consolidationResult.evicted.length} 條因客廳容量轉入 attic`);
        }
    } catch (e: any) {
        console.warn(`🏰 [Migration] 鞏固失敗（不影響已存記憶）: ${e.message}`);
    }

    onProgress?.({ phase: 'done', current: migrated, total: migrated + skipped });

    console.log(`✅ [Migration] 遷移完成：${migrated} 條存儲, ${skipped} 條去重跳過, 來自 ${filteredChunks.length} 個分塊（${months.length} 個月），觸發 ${allTouchedBoxIds.size} 個 EventBox 壓縮掃描`);
    return { migrated, skipped, months: filteredChunks.length };
}

/**
 * Fallback query 構造：當 splitLogsToBullets 失敗（用戶總結不是 YAML 列表）時，
 * 用"按句切分 + 每個句子一個 query"代替原來的"頭/中/尾 3 段"。
 * 原因：3 段把幾十天的總結壓成 3 個質心，召回候選只有 3-9 條，A 常被漏掉。
 * 按句切後 20-40 個 query，每個 top 3 → 候選池豐富，LLM 才有機會發現"B 和 A
 * 是同一件事"。
 */
function buildLogSnippets(sortedLogs: MemoryFragment[]): string[] {
    if (sortedLogs.length === 0) return [];
    const MIN_FRAG_CHARS = 10;   // 過濾"好的"/"嗯"這種無效短句
    const MAX_FRAG_CHARS = 300;  // 單句過長（極少見）截斷
    const MAX_SNIPPETS = 20;     // 單 chunk 最多這麼多 query，避免並行 vectorSearch 擊穿瀏覽器
    const snippets: string[] = [];
    for (const log of sortedLogs) {
        const summary = (log.summary || '').trim();
        if (!summary) continue;
        // 按中英文句末標點、換行切分；保留標點讓語義完整。
        // 不用後行斷言 (?<=…): iOS Safari <16.4 的 JSC 不支持, 舊設備 new RegExp 會拋
        // "invalid group specifier name". 改成「句末標點後插哨兵(標點留前句) + 換行換哨兵」再 split,
        // 與原 (?<=[標點])\s*|\n+ 字節等價 (見 utils/lookbehindFree.test.ts)。
        const SPLIT = String.fromCharCode(1);
        const parts = summary
            .replace(/([。！？!?])\s*/g, `$1${SPLIT}`)
            .replace(/\n+/g, SPLIT)
            .split(SPLIT)
            .map(s => s.trim())
            .filter(Boolean);
        for (const p of parts) {
            if (p.replace(/[\s\p{P}]/gu, '').length < MIN_FRAG_CHARS) continue;
            snippets.push(`[${log.date}] ${p.slice(0, MAX_FRAG_CHARS)}`);
            if (snippets.length >= MAX_SNIPPETS) return snippets;
        }
    }
    // 回兜：如果切完一條句子都沒有（全是短句語氣詞），用整段 summary 做 query
    if (snippets.length === 0) {
        for (const log of sortedLogs.slice(0, 10)) {
            const text = `[${log.date}] ${log.summary.slice(0, MAX_FRAG_CHARS)}`;
            if (text.trim()) snippets.push(text);
        }
    }
    return snippets;
}
