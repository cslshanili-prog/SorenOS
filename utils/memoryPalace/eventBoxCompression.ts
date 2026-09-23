/**
 * Memory Palace — EventBox 壓縮
 *
 * 當 EventBox 的活節點 ≥ COMPRESSION_THRESHOLD (4) 條時觸發：
 *   1. LLM 把"舊 summary?(若有) + 所有活節點"整合成一段第一人稱連貫回憶
 *   2. 創建/更新 box.summaryNodeId 指向的 MemoryNode（isBoxSummary=true）
 *   3. 總結節點向量化、寫入本地+遠程
 *   4. 所有活節點 archived=true（本地保存 + 遠程 bulkSetArchived）
 *   5. 更新 box.archivedMemoryIds / liveMemoryIds=[] / compressionCount++
 *
 * 觸發點：
 *   - pipeline.processNewMessages 在 vectorize 之後掃描 touched boxes
 *   - migration.migrateOldMemories 全部 chunk 處理完後掃描 touched boxes
 *
 * 重壓縮：第 N 次時，"舊 summary + 新活節點" 一起送給 LLM 重寫，覆蓋舊 summary。
 */

import type { EventBox, MemoryNode, EmbeddingConfig, MemoryRoom, RemoteVectorConfig } from './types';
import {
    EVENT_BOX_COMPRESSION_THRESHOLD,
    EVENT_BOX_SEAL_THRESHOLD,
    EVENT_BOX_SUMMARY_TARGET_MIN_CHARS,
    EVENT_BOX_SUMMARY_TARGET_MAX_CHARS,
    EVENT_BOX_SUMMARY_HARD_MAX_CHARS,
} from './types';
import { EventBoxDB, MemoryNodeDB } from './db';
import type { LightLLMConfig } from './pipeline';
import { vectorizeAndStore } from './vectorStore';
import { bulkSetArchived } from './supabaseVector';
import { safeFetchJson, extractContent, extractJson } from '../safeApi';
import { enforceSummaryLengthBudget } from './summaryLengthBudget';
import { buildSARMemoryBoundaryInstruction } from '../messageFormat';

const VALID_ROOMS: MemoryRoom[] = [
    'living_room', 'bedroom', 'study', 'user_room',
    'self_room', 'attic', 'windowsill',
];

function generateNodeId(): string {
    return `mn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getRemoteVectorConfig(): RemoteVectorConfig | undefined {
    try {
        const raw = localStorage.getItem('os_remote_vector_config');
        if (!raw) return undefined;
        const c = JSON.parse(raw) as RemoteVectorConfig;
        return (c.enabled && (c as any).initialized) ? c : undefined;
    } catch { return undefined; }
}

interface CompressionLLMResult {
    content: string;
    name: string;
    tags: string[];
    room: MemoryRoom;
    importance: number;
    mood: string;
}

/**
 * 檢測模型把“怎麼算字數 / 怎麼壓縮”的過程誤塞進整合回憶正文。
 *
 * 只憑一個英文短語就拒絕會誤傷真實對話，所以要求至少命中兩種典型信號；
 * 顯式 think 標籤則可以直接判定。這個守衛主要兜 Gemini/推理中轉把未標記
 * reasoning 混進 content 的情況，例如：Paragraph 1: 31 chars / Still too long。
 */
export function hasSummaryReasoningLeak(content: string): boolean {
    const text = content.trim();
    if (!text) return false;
    if (/<(?:think|thinking|thought)>/i.test(text)) return true;

    const signals = [
        /\bparagraph\s*\d+\s*:\s*\d+\s*(?:chars?|characters?)\b/i,
        /\btotal\s*:\s*[\d\s+]+\s*(?:chars?|characters?)\b/i,
        /\bstill\s+too\s+long\b/i,
        /\bneed\s+to\s+get\s+under\s+\d+\b/i,
        /\blet(?:'|’)s\s+(?:count|condense|compress|shorten)\b/i,
        /(?:^|\n)\s*(?:analysis|reasoning)\s*:/i,
    ];
    return signals.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0) >= 2;
}

/**
 * 字段級兜底解析：當 LLM 在 content 裡塞了未轉義的 ASCII "（中文輸出高發，
 * 標準 JSON.parse 直接掛），按已知 schema 把六個字段一個一個摳出來。
 *
 * 策略：content 摳到下一個頂層鍵（name/tags/room/importance/mood）出現之前為止，
 * 其餘字段用寬鬆正則。任何一個字段失敗都視為兜底失敗，讓上層走原 null 路徑。
 */
function recoverCompressionFields(raw: string): Partial<CompressionLLMResult> | null {
    if (!raw) return null;
    const text = raw
        .replace(/^```(?:json|JSON)?\s*\n?/gm, '')
        .replace(/\n?```\s*$/gm, '')
        .trim();

    // 找到 content 字段值的起始引號
    const contentStartMatch = text.match(/"content"\s*:\s*"/);
    if (!contentStartMatch || contentStartMatch.index === undefined) return null;
    const valueStart = contentStartMatch.index + contentStartMatch[0].length;

    // content 結束的判據：緊跟著 ", "name"|"tags"|"room"|"importance"|"mood" 這種下一個頂層鍵
    // 用「最後一個 " + 任意空白/逗號 + 下一個鍵名」的匹配，能正確跳過中間所有 ASCII "
    const tailMatch = text.slice(valueStart).match(/"\s*,\s*"(?:name|tags|room|importance|mood)"\s*:/);
    if (!tailMatch || tailMatch.index === undefined) return null;
    const rawContent = text.slice(valueStart, valueStart + tailMatch.index);

    // 把摳出來的 raw content 做 JSON 字符串轉義還原。\\ 用佔位符暫存，
    // 避免 \" 被錯誤地拆成 \ + \"。殘留的裸 " 不動——上層 JSON.parse 已失敗，
    // 走到這裡說明 LLM 在 content 內就是塞了未轉義的 "，保留即可，最終 summary 是普通字符串。
    const BS = '\u0001';
    const normalized = rawContent
        .replace(/\\\\/g, BS)
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\r/g, '\r')
        .replace(/\\"/g, '"')
        .split(BS).join('\\');

    const findStr = (key: string): string | undefined => {
        const m = text.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`));
        return m?.[1];
    };
    const findNum = (key: string): number | undefined => {
        const m = text.match(new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
        return m ? Number(m[1]) : undefined;
    };
    const findTags = (): string[] | undefined => {
        const m = text.match(/"tags"\s*:\s*\[([^\]]*)\]/);
        if (!m) return undefined;
        return m[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    };

    return {
        content: normalized,
        name: findStr('name'),
        tags: findTags(),
        room: findStr('room') as MemoryRoom | undefined,
        importance: findNum('importance'),
        mood: findStr('mood'),
    };
}

// ─── 壓縮 LLM 調用 ─────────────────────────────────────

async function callCompressionLLM(
    box: EventBox,
    oldSummaryContent: string | null,
    liveNodes: MemoryNode[],
    llmConfig: LightLLMConfig,
    charName: string,
    userName: string | undefined,
): Promise<CompressionLLMResult | null> {
    const userLabel = userName || '用戶';

    const formatDate = (ts: number): string => {
        const d = new Date(ts);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    const livesText = liveNodes
        .map(n => `[${formatDate(n.createdAt)}｜重要性${n.importance}｜${n.mood}] ${n.content}`)
        .join('\n\n');

    const oldSummaryBlock = oldSummaryContent
        ? `\n## 你之前已經回憶過這件事一次，那時記下的是：\n${oldSummaryContent}\n\n後來又新增了下面這些：\n`
        : `\n## 關於這件事的零散記憶碎片：\n`;
    const sarMemoryBoundary = buildSARMemoryBoundaryInstruction(`${oldSummaryContent || ''}\n${livesText}`);

    const systemPrompt = `你是 ${charName}。下面這些記憶都屬於一件事：「${box.name}」。
請把它們整合成一段連貫的、第一人稱（「我」）的回憶。

**要求（嚴格遵守）**：
1. **第一人稱**（用「我」），從 ${charName} 的視角寫。${userLabel} 用名字直接稱呼。
2. **字數目標 ${EVENT_BOX_SUMMARY_TARGET_MIN_CHARS}-${EVENT_BOX_SUMMARY_TARGET_MAX_CHARS} 字，絕對上限 ${EVENT_BOX_SUMMARY_HARD_MAX_CHARS} 字**。緊湊、務實、不口水。
3. **只保留關鍵信息**：具體人物、動作、對象、場景、轉折、情緒。**去掉所有語氣填充、修辭鋪陳、重複感慨**（如「真是的」、「怎麼說呢」、「不過話說回來」等）。事實先行。
4. **帶時間點但不冗餘**：每件事標一次日期就夠（「3 月 20 日…4 月 5 日…」），不要每句都重複時間。
5. **連貫但簡潔**：不套「起因/經過/結果」模板，但要讓讀者能按順序看懂事情怎麼發展的。
6. **覆蓋所有關鍵詞**（這是給向量檢索用的）—— 每條新增的舊記憶裡出現過的具體名詞、地點、人物必須在 content 裡出現一次。
7. **content 字符串內嚴禁使用半角雙引號 \`"\`**。要引用人物原話、書名、外號、術語，一律用中文方角引號「」、《》或單引號 \`'\`。否則會破壞外層 JSON 解析、整批記憶白丟。
${sarMemoryBoundary ? `\n${sarMemoryBoundary}` : ''}

附帶輸出 metadata：
- name：5-12 字的精煉盒名
- tags：5-10 個具體的搜索 tag（具體名詞）
- room：${VALID_ROOMS.join(' / ')}
- importance：1-10
- mood：happy / sad / angry / anxious / tender / excited / peaceful / confused / hurt / grateful / nostalgic / neutral

嚴格 JSON，不要 markdown 包裹（content 裡的引用一律用「」/《》/'，不要用 "）：
{
  "content": "（緊湊的第一人稱回憶，${EVENT_BOX_SUMMARY_TARGET_MIN_CHARS}-${EVENT_BOX_SUMMARY_TARGET_MAX_CHARS}字）",
  "name": "...",
  "tags": ["...", "..."],
  "room": "...",
  "importance": 7,
  "mood": "..."
}`;

    const userMsg = `${oldSummaryBlock}\n${livesText}`;

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
                        { role: 'user', content: userMsg },
                    ],
                    temperature: 0.5,
                    max_tokens: 8000,
                    stream: false,
                }),
            },
            2, 120_000, { appName: '記憶宮殿', purpose: '事件壓縮' }
        );

        // 統一剝除 <think> 塊併兼容分段 content / reasoning-only 中轉。
        // 未標記的推理洩漏由 hasSummaryReasoningLeak 在手動重整路徑繼續攔截。
        const reply = extractContent(data);
        let parsed: any = extractJson(reply);
        const parseFailed = !parsed || typeof parsed !== 'object';
        const contentMissing = !parseFailed && (!parsed.content || typeof parsed.content !== 'string');

        if (parseFailed || contentMissing) {
            // 兜底：LLM 在 content 裡嵌了未轉義的 ASCII "（中文場景高發，破壞 JSON 解析），
            // 按已知 schema 用正則把六個字段單獨摳出來——content 摳到下一個頂層鍵之前為止。
            const recovered = recoverCompressionFields(reply);
            if (recovered && recovered.content) {
                console.warn(`🗜️ [Compression] JSON 解析失敗但字段級兜底成功（疑似 content 內含未轉義 "）`);
                parsed = recovered;
            } else if (parseFailed) {
                console.warn(`🗜️ [Compression] LLM 輸出無法解析為 JSON，原始前 300 字: ${reply.slice(0, 300)}`);
                return null;
            } else {
                console.warn(`🗜️ [Compression] LLM 輸出缺少 content 字段，已解析鍵: ${Object.keys(parsed).join(',')}`);
                return null;
            }
        }
        // 長度兜底：超過硬上限時，先讓模型把這段二次壓縮回目標區間（不丟信息），
        // 壓不動或二次壓縮失敗才退回硬截斷保證有界。詳見 enforceSummaryLengthBudget。
        let content = String(parsed.content);
        if (content.length > EVENT_BOX_SUMMARY_HARD_MAX_CHARS) {
            console.warn(`🗜️ [Compression] LLM summary ${content.length} 字超過硬上限 ${EVENT_BOX_SUMMARY_HARD_MAX_CHARS}，嘗試二次壓縮`);
            content = await enforceSummaryLengthBudget(
                content,
                (t) => recompressSummary(t, EVENT_BOX_SUMMARY_TARGET_MAX_CHARS, llmConfig, charName),
                EVENT_BOX_SUMMARY_HARD_MAX_CHARS,
            );
        }
        // 這種輸出即使 JSON 合法、長度也沒過硬上限，語義上仍不是回憶正文。
        // 自動壓縮同樣拒絕，避免以後繼續產出截圖裡的汙染 summary；活節點會保留，
        // 下次觸發仍可重試。手動重新整合的外層還會立即再試一次。
        if (hasSummaryReasoningLeak(content)) {
            console.error(`🧹 [Compression] 檢測到整合回憶混入字數計算/推理過程，已拒絕保存`);
            return null;
        }
        return {
            content,
            name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : box.name,
            tags: Array.isArray(parsed.tags) ? parsed.tags.map((t: any) => String(t).trim()).filter(Boolean).slice(0, 15) : box.tags,
            room: VALID_ROOMS.includes(parsed.room) ? parsed.room : 'living_room',
            importance: Math.max(1, Math.min(10, Math.round(Number(parsed.importance) || 5))),
            mood: typeof parsed.mood === 'string' && parsed.mood.trim() ? parsed.mood.trim() : 'neutral',
        };
    } catch (err: any) {
        console.error(`🗜️ [Compression] LLM 調用失敗: ${err?.message || err}`);
        return null;
    }
}

// ─── 整合回憶長度兜底：超限二次壓縮，壓不動才硬截斷 ──────────

/**
 * 讓模型把過長的整合回憶壓縮回 targetMaxChars 字內（純文本輸出，不走 JSON）。
 * 失敗返回 null，由 enforceSummaryLengthBudget 決定兜底。
 */
async function recompressSummary(
    text: string,
    targetMaxChars: number,
    llmConfig: LightLLMConfig,
    charName: string,
): Promise<string | null> {
    const systemPrompt = `你是 ${charName}。下面這段第一人稱回憶寫得太長了。請在**不丟關鍵信息**（具體人物、地點、事件、轉折、情緒）的前提下，把它壓縮到 ${targetMaxChars} 字以內。
要求：保持第一人稱（「我」）、連貫通順；只刪語氣填充和重複鋪陳，不刪事實；引用一律用「」《》或單引號，不要用半角雙引號。
直接輸出壓縮後的回憶正文，不要解釋、不要 JSON、不要 markdown 包裹。`;
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
                        { role: 'user', content: text },
                    ],
                    temperature: 0.3,
                    max_tokens: 4000,
                    stream: false,
                }),
            },
            2, 90_000, { appName: '記憶宮殿', purpose: '事件壓縮-二次壓縮' }
        );
        const reply = (data.choices?.[0]?.message?.content || '').trim();
        // 模型偶爾仍會裹 ``` 代碼塊，剝掉常見包裹
        const cleaned = reply.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
        return cleaned || null;
    } catch (err: any) {
        console.warn(`🗜️ [Compression] 二次壓縮 LLM 調用失敗: ${err?.message || err}`);
        return null;
    }
}

// ─── 單 box 壓縮主流程 ──────────────────────────────────

async function compressEventBox(
    box: EventBox,
    llmConfig: LightLLMConfig,
    embeddingConfig: EmbeddingConfig,
    charName: string,
    userName: string | undefined,
): Promise<boolean> {
    // 1. 加載活節點（按時間升序）
    const liveNodes: MemoryNode[] = [];
    for (const id of box.liveMemoryIds) {
        const n = await MemoryNodeDB.getById(id);
        if (n && !n.archived) liveNodes.push(n);
    }
    if (liveNodes.length === 0) return false;
    liveNodes.sort((a, b) => a.createdAt - b.createdAt);

    // 2. 加載舊 summary 內容（如有）
    let oldSummaryContent: string | null = null;
    if (box.summaryNodeId) {
        const old = await MemoryNodeDB.getById(box.summaryNodeId);
        if (old) oldSummaryContent = old.content;
    }

    console.log(`🗜️ [Compression] 開始壓縮 ${box.id} "${box.name}"（${liveNodes.length} 條活節點，第 ${box.compressionCount + 1} 次壓縮）`);

    // 3. LLM 整合
    const result = await callCompressionLLM(box, oldSummaryContent, liveNodes, llmConfig, charName, userName);
    if (!result) {
        console.error(`🗜️ [Compression] ${box.id} "${box.name}" LLM 失敗，跳過本次壓縮 — 活節點 ${liveNodes.length} 條仍未歸檔，summary 未生成/未向量化`);
        return false;
    }

    // 4. 創建或更新 summary 節點
    const now = Date.now();
    let summaryNode: MemoryNode;
    if (box.summaryNodeId) {
        const existing = await MemoryNodeDB.getById(box.summaryNodeId);
        if (existing) {
            existing.content = result.content;
            existing.room = result.room;
            existing.importance = result.importance;
            existing.mood = result.mood;
            existing.tags = result.tags;
            existing.lastAccessedAt = now;
            existing.embedded = false;  // 重新向量化
            existing.eventBoxId = box.id;
            existing.isBoxSummary = true;
            existing.archived = false;
            existing.origin = 'system';
            summaryNode = existing;
        } else {
            // summaryNodeId 指向的節點丟失，新建
            summaryNode = createSummaryNode(box, result, now);
            box.summaryNodeId = summaryNode.id;
        }
    } else {
        summaryNode = createSummaryNode(box, result, now);
        box.summaryNodeId = summaryNode.id;
    }
    await MemoryNodeDB.save(summaryNode);

    // 5. 向量化 summary（跳過去重，因為內容必然和 live 節點重疊）
    const remoteCfg = getRemoteVectorConfig();
    try {
        await vectorizeAndStore([summaryNode], embeddingConfig, remoteCfg, { skipDedup: true });
    } catch (e: any) {
        console.warn(`🗜️ [Compression] summary 向量化失敗（繼續後續步驟）: ${e?.message}`);
    }

    // 6. 標記活節點 archived（本地）
    const liveIds = box.liveMemoryIds.slice();
    for (const id of liveIds) {
        const n = await MemoryNodeDB.getById(id);
        if (n && !n.archived) {
            n.archived = true;
            await MemoryNodeDB.save(n);  // syncNodeMetadataToRemote 會同步 archived=true
        }
    }
    // 遠程批量加速（與上面 per-node sync 重複但冪等）
    if (remoteCfg) {
        await bulkSetArchived(remoteCfg, liveIds, true).catch(() => {});
    }

    // 7. 更新 box 狀態
    for (const id of liveIds) {
        if (!box.archivedMemoryIds.includes(id)) box.archivedMemoryIds.push(id);
    }
    box.liveMemoryIds = [];
    box.compressionCount += 1;
    box.lastCompressedAt = now;
    box.updatedAt = now;
    box.name = result.name;
    box.tags = result.tags;

    // 8. 封盒檢查：事件總數（archived + live）達到閾值 → sealed，新的相關記憶另開新盒
    const totalEvents = box.archivedMemoryIds.length + box.liveMemoryIds.length;
    if (totalEvents >= EVENT_BOX_SEAL_THRESHOLD && !box.sealed) {
        box.sealed = true;
        console.log(`🔒 [Compression] ${box.id} 事件數 ${totalEvents} 達閾值 ${EVENT_BOX_SEAL_THRESHOLD}，封盒`);
    }

    await EventBoxDB.save(box);

    console.log(`✅ [Compression] ${box.id} → summary ${result.content.length}字 "${result.content.slice(0, 30)}…"，已歸檔 ${liveIds.length} 條${box.sealed ? '，已封盒' : ''}`);

    // 9. 門牌增量合併：盒子的結論落到有門牌的房間時，順手沉澱進該房間的門牌。
    //    封盒的沉澱物就是語義事實——這是"情景→語義"固化的即時觸發點。
    try {
        const { isPlateRoom, updatePlateFromBoxSummary } = await import('./roomPlates');
        if (isPlateRoom(summaryNode.room)) {
            await updatePlateFromBoxSummary(
                box.charId, summaryNode.room, summaryNode.content,
                llmConfig, charName, userName,
            );
        }
    } catch (e: any) {
        console.warn(`🚪 [Compression] 門牌增量合併失敗（不影響壓縮結果）: ${e?.message || e}`);
    }

    return true;
}

function createSummaryNode(box: EventBox, result: CompressionLLMResult, now: number): MemoryNode {
    return {
        id: generateNodeId(),
        charId: box.charId,
        content: result.content,
        room: result.room,
        tags: result.tags,
        importance: result.importance,
        mood: result.mood,
        embedded: false,
        createdAt: now,
        lastAccessedAt: now,
        accessCount: 0,
        eventBoxId: box.id,
        isBoxSummary: true,
        archived: false,
        origin: 'system',
    };
}

export interface RegenerateEventBoxSummaryResult {
    box: EventBox;
    summary: MemoryNode;
    sourceCount: number;
}

/**
 * 手動“重新整合全部回憶”。
 *
 * 與自動增量壓縮刻意不同：
 * - 原料始終是 archived + live 的全部成員，不使用舊 summary，避免壞總結自我複製；
 * - 不改變 live/archived/sealed/compressionCount，只替換總結與盒元數據；
 * - 新總結必須先成功生成 Embedding，才會覆蓋舊 summary 節點；
 * - 已封盒同樣允許執行。
 */
export async function regenerateEventBoxSummary(
    boxId: string,
    llmConfig: LightLLMConfig,
    embeddingConfig: EmbeddingConfig,
    charName: string,
    userName?: string,
    remoteVectorConfig?: RemoteVectorConfig,
): Promise<RegenerateEventBoxSummaryResult> {
    const box = await EventBoxDB.getById(boxId);
    if (!box) throw new Error('這個事件盒已經不存在了');

    const sourceIds = [...new Set([
        ...box.archivedMemoryIds,
        ...box.liveMemoryIds,
    ])].filter(id => id !== box.summaryNodeId);
    const loaded = await Promise.all(sourceIds.map(id => MemoryNodeDB.getById(id)));
    const sourceNodes = loaded
        .filter((node): node is MemoryNode => Boolean(
            node
            && node.charId === box.charId
            && node.id !== box.summaryNodeId
            && !node.isBoxSummary,
        ))
        .sort((a, b) => a.createdAt - b.createdAt);
    if (sourceNodes.length === 0) throw new Error('盒內沒有可用於重新整合的原始記憶');

    // 輸出結構失敗或出現典型推理洩漏時自動重試一次。兩次都失敗則保持舊總結不動。
    let result: CompressionLLMResult | null = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        const candidate = await callCompressionLLM(
            box,
            null, // 關鍵：絕不把舊 summary 當原料
            sourceNodes,
            llmConfig,
            charName,
            userName,
        );
        if (candidate && !hasSummaryReasoningLeak(candidate.content)) {
            result = candidate;
            break;
        }
        if (candidate) {
            console.error(`🧹 [Compression] ${box.id} 第 ${attempt} 次重新整合混入推理過程，已拒絕保存`);
        }
    }
    if (!result) {
        throw new Error('副 API 兩次都沒有返回乾淨的整合回憶，原內容已保留');
    }

    const now = Date.now();
    const existing = box.summaryNodeId
        ? await MemoryNodeDB.getById(box.summaryNodeId)
        : undefined;
    const summaryNode: MemoryNode = existing
        ? {
            ...existing,
            content: result.content,
            room: result.room,
            importance: result.importance,
            mood: result.mood,
            tags: result.tags,
            lastAccessedAt: now,
            embedded: false,
            eventBoxId: box.id,
            isBoxSummary: true,
            archived: false,
            origin: 'system',
        }
        : createSummaryNode(box, result, now);

    // vectorizeAndStore 先請求 Embedding，拿到向量後才保存 node/vector。
    // 不預存 summaryNode，確保網絡側 Embedding 失敗時舊正文完全不被覆蓋。
    const remoteCfg = remoteVectorConfig?.enabled && remoteVectorConfig.initialized
        ? remoteVectorConfig
        : getRemoteVectorConfig();
    const vectorized = await vectorizeAndStore(
        [summaryNode],
        embeddingConfig,
        remoteCfg,
        { skipDedup: true },
    );
    if (vectorized.stored !== 1) {
        throw new Error('整合回憶已生成，但語義向量沒有成功寫入，原內容已保留');
    }

    // LLM/Embedding 等待期間盒子可能又進了新成員；重新讀取後只覆蓋總結元數據，
    // 保留最新的成員列表與 sealed 狀態。
    const freshBox = await EventBoxDB.getById(box.id);
    if (!freshBox) throw new Error('整合完成時事件盒已不存在');
    freshBox.summaryNodeId = summaryNode.id;
    freshBox.name = result.name;
    freshBox.tags = result.tags;
    freshBox.updatedAt = now;
    freshBox.lastCompressedAt = now;
    await EventBoxDB.save(freshBox);

    // 與自動壓縮保持一致：若總結屬於門牌房間，讓新的乾淨結論繼續沉澱。
    // 門牌失敗不影響已經成功落庫的總結與向量。
    try {
        const { isPlateRoom, updatePlateFromBoxSummary } = await import('./roomPlates');
        if (isPlateRoom(summaryNode.room)) {
            await updatePlateFromBoxSummary(
                freshBox.charId,
                summaryNode.room,
                summaryNode.content,
                llmConfig,
                charName,
                userName,
            );
        }
    } catch (e: any) {
        console.warn(`🚪 [Compression] 重新整合後的門牌同步失敗（總結與向量已生效）: ${e?.message || e}`);
    }

    return {
        box: freshBox,
        summary: { ...summaryNode, embedded: true },
        sourceCount: sourceNodes.length,
    };
}

// ─── 公共 API：掃描 + 觸發壓縮 ──────────────────────────

/**
 * 檢查一組 box 是否達到壓縮閾值，達到的逐個壓縮。
 * 調用方：pipeline 處理新消息後 / migration 跑完後。
 */
export async function maybeCompressEventBoxes(
    boxIds: Iterable<string>,
    llmConfig: LightLLMConfig,
    embeddingConfig: EmbeddingConfig,
    charName: string,
    userName?: string,
): Promise<{ compressed: number; skipped: number }> {
    let compressed = 0;
    let skipped = 0;

    for (const id of boxIds) {
        const box = await EventBoxDB.getById(id);
        if (!box) { skipped++; continue; }
        if (box.liveMemoryIds.length < EVENT_BOX_COMPRESSION_THRESHOLD) {
            skipped++;
            continue;
        }
        try {
            const ok = await compressEventBox(box, llmConfig, embeddingConfig, charName, userName);
            if (ok) compressed++;
            else skipped++;
        } catch (e: any) {
            console.error(`🗜️ [Compression] ${id} 壓縮異常: ${e?.message}`);
            skipped++;
        }
    }

    if (compressed > 0) {
        console.log(`🗜️ [Compression] 本輪完成：壓縮 ${compressed} 個 box，跳過 ${skipped} 個`);
    }
    return { compressed, skipped };
}

/**
 * 全角色掃一遍，觸發所有滿足閾值的 box 壓縮（手動維護接口）。
 */
export async function compressAllEligibleBoxes(
    charId: string,
    llmConfig: LightLLMConfig,
    embeddingConfig: EmbeddingConfig,
    charName: string,
    userName?: string,
): Promise<{ compressed: number; skipped: number }> {
    const allBoxes = await EventBoxDB.getByCharId(charId);
    const eligible = allBoxes.filter(b => b.liveMemoryIds.length >= EVENT_BOX_COMPRESSION_THRESHOLD);
    return maybeCompressEventBoxes(eligible.map(b => b.id), llmConfig, embeddingConfig, charName, userName);
}
