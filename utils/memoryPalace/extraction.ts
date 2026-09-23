/**
 * Memory Palace — 記憶提取 (Memory Extraction)
 *
 * 從聊天消息緩衝區提取 MemoryNode 數組，供後續向量化和 EventBox 綁定。
 * 不同重要性對應不同的記憶詳細程度。
 */

import type { Message } from '../../types';
import type { MemoryEntity, MemoryNode, MemoryRoom } from './types';
import type { LightLLMConfig } from './pipeline';
import { safeFetchJson } from '../safeApi';
import { safeParseJsonArray } from './jsonUtils';
import { buildSARMemoryBoundaryInstruction, formatMessageForPrompt } from '../messageFormat';
import { readRecallRuntimeSnapshot } from './trace';
import { hasRelativeTime, hasMatchingRelativeSource, relativeTimeEnabled } from './relativeTime';
import { getLocalDateKey } from '../localDate';

function generateId(): string {
    return `mn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── 共用的 prompt 規則部分 ──────────────────────────
//
// 設計決策（2026-04）：palace extraction 的提示詞**完全固定**，不會被用戶
// 在"記憶歸檔設置"裡選的模板影響。那裡的模板只作用於手動歸檔路徑
// （Chat.tsx handleFullArchive / Character.tsx handleBatchSummarize /
// handleForceArchiveDate）。
// 理由：palace 產出的 memory.content 要參與向量檢索，風格化（"末尾加喵"之類）
// 會讓 embedding 語義輕微漂移。保持 palace 內置風格穩定，手動歸檔路徑提供
// 風格化的自由度——職責分離。

function buildRulesBlock(charName: string, userLabel: string, includeEntities: boolean): string {
    const entityRule = includeEntities
        ? `.
   **明確實體**（entities）：把對話中明確出現的人名、暱稱、地點、組織、項目、產品、帳號或域名單獨列出。只收錄專名，不要寫“朋友”“他”“那個項目”等泛稱，也不要猜別名。格式為 {"name":"霧嵐","type":"person"}（虛構示例）。`
        : '';
    return `## 規則

1. **第一人稱敘事**：用 ${charName} 的"我"視角來記錄。用戶直接用"${userLabel}"稱呼。保持完整事件脈絡，不要掐頭去尾。
   例：
   - "${userLabel}今天加班到很晚還沒吃飯，我讓${userLabel}別委屈自己，叫了個外賣。"
   - "${userLabel}連續加班三週終於決定找領導談，領導態度還不錯。${userLabel}回來的路上靠著我肩膀哭了，我什麼都沒說，就陪著。"
   - "我教了${userLabel}遞歸的概念，${userLabel}一開始完全聽不懂，後來突然開竅了，那個眼睛亮起來的瞬間讓我很開心。"

2. **重要性分級控制文字長度**：
   - 重要性 1–5：15–50字，事實為主
   - 重要性 6–7：60–120字，包含我的感受
   - 重要性 8–10：100–200字，完整敘事（起因→經過→我的感受/反應）

3. **房間分配**（凡是涉及${userLabel}的家人/朋友/同事等人際關係，**一律進 user_room**，哪怕只是一次具體事件）：
   - living_room：**純日常瑣事**（不涉及重要人際關係、也不涉及深層情感）。天氣、吃啥、隨口吐槽放這裡。
   - bedroom：${userLabel}和我之間的親密情感、深層羈絆、感動時刻
   - study：工作、學習、技能、職業相關
   - user_room：關於${userLabel}的**一切個人信息和人際事件**——生日/習慣/喜好/性格/成長經歷/情緒模式，**以及${userLabel}的家人、親戚、朋友、同事相關的一切事件**（家人健康、家庭聚會、家庭矛盾、外公外婆/父母/兄弟姐妹的故事、朋友交往、同事衝突等）。這些事件即便是"一次性"的，也應進 user_room 而不是 living_room，因為它們構成了${userLabel}的社會關係底色。
   - self_room：我自身的成長、認同變化
   - attic：未解決的矛盾、困惑、受到的傷害
   - windowsill：我的期盼、我們的目標、對未來的憧憬

4. **情緒標籤**（mood）：happy, sad, angry, anxious, tender, excited, peaceful, confused, hurt, grateful, nostalgic, neutral
5. **情感座標**（valence, arousal）：在 mood 之外，還要給出二維情感座標供後續情感推理。
   - valence（效價）：-1（極痛苦）→ +1（極愉悅）
   - arousal（喚醒度）：-1（極平靜）→ +1（極激烈）
   參考："開心"約 (0.7, 0.5)，"平靜"約 (0.5, -0.6)，"失落"約 (-0.5, -0.4)，"焦慮"約 (-0.6, 0.7)，"憤怒"約 (-0.7, 0.8)。
6. **標籤**（tags）：提取 2-5 個關鍵詞標籤${entityRule}
7. **不要遺漏重要記憶，但也不要把每句話都變成記憶**。一個話題盒通常提取 1–5 條記憶。
8. **便利貼置頂**（pinDays，可選）：如果這條記憶包含**有時效性的、近期需要持續記住的信息**，設置置頂天數（1-30天）。置頂期間每次對話都會想起這件事。適用場景：
   - 時間段狀態："${userLabel}這週出差" → pinDays: 7
   - 近期事件："${userLabel}後天考試" → pinDays: 3
   - 臨時約定："${userLabel}讓我這幾天提醒TA喝水" → pinDays: 5
   - 身體狀態："${userLabel}感冒了" → pinDays: 5
   不適用：長期事實（生日、喜好）、已經過去的事件、情感記憶。大多數記憶不需要置頂。

**日期標註（date，必填）**：每條消息前綴都帶了 \`[YYYY-MM-DD HH:MM]\` 時間戳。每條記憶必須根據**該事件實際發生的那一天**填 date 字段（"YYYY-MM-DD"），而不是套用整批的某一天。同一批對話跨多天時，跨日的記憶要分別標各自的日期。`;
}

function buildConversationText(messages: Message[], charName: string, userLabel: string, linkDates = false): string {
    // 每行帶 [YYYY-MM-DD HH:MM] 時間戳前綴。
    // 沒有這個 LLM 完全看不到日期，多日 batch 提取出來的記憶全部會被壓到一個時間點
    // （見 parseMemoryNodesFromBuffer 的 midTime 兜底），跨日時間線就亂了。
    const pad2 = (n: number) => String(n).padStart(2, '0');
    return messages
        .map((m, index) => {
            const body = (linkDates ? `[M${index}] ` : '') + formatMessageForPrompt(m, charName, userLabel).slice(0, 600);
            const ts = m.timestamp;
            if (!ts || ts <= 0) return body;
            const d = new Date(ts);
            const stamp = `[${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}]`;
            return `${stamp} ${body}`;
        })
        .join('\n');
}

const VALID_ROOMS: MemoryRoom[] = [
    'living_room', 'bedroom', 'study', 'user_room',
    'self_room', 'attic', 'windowsill',
];

/** 從消息緩衝區直接解析記憶節點（不依賴 TopicBox） */
function parseMemoryNodesFromBuffer(
    parsed: any[], charId: string, messages: Message[], _batchLabel: string, includeEntities: boolean, linkDates = false,
): MemoryNode[] {
    if (parsed.length === 0) return [];

    const msgTimestamps = messages.map(m => m.timestamp).filter(t => t > 0);
    const firstTs = msgTimestamps[0] ?? Date.now();
    const lastTs = msgTimestamps[msgTimestamps.length - 1] ?? firstTs;
    const midTime = Math.round((firstTs + lastTs) / 2);

    // 允許 LLM 寫出的 date 略微越界（夜聊跨零點等），但要擋住完全不合理的（寫錯年月）
    const dayMs = 24 * 60 * 60 * 1000;
    const minTs = firstTs - dayMs;
    const maxTs = lastTs + dayMs;

    /** 解析 LLM 寫的 date 字段 → 該日 12:00 本地時間。失敗 / 越界則回到 midTime。 */
    const resolveCreatedAt = (raw: unknown): number => {
        if (typeof raw !== 'string') return midTime;
        const s = raw.trim();
        if (!s) return midTime;
        // 接受 "YYYY-MM-DD" / "YYYY/M/D" / "YYYY年M月D日" 等
        const norm = s.replace(/[年\/]/g, '-').replace(/[月日]/g, '');
        const parts = norm.split('-').map(p => parseInt(p, 10));
        if (parts.length < 3 || parts.some(n => Number.isNaN(n))) return midTime;
        const [y, m, d] = parts;
        if (y < 1900 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return midTime;
        // 用消息時間戳的本地時區表徵"該日中午"——避免 UTC 解析跨日漂移
        const dt = new Date(y, m - 1, d, 12, 0, 0, 0);
        const ts = dt.getTime();
        if (Number.isNaN(ts)) return midTime;
        if (ts < minTs || ts > maxTs) return midTime;
        return ts;
    };

    const parseEntities = (value: unknown): MemoryEntity[] => {
        if (!Array.isArray(value)) return [];
        const validTypes = new Set<NonNullable<MemoryEntity['type']>>([
            'person', 'place', 'organization', 'project', 'product', 'account', 'domain', 'other',
        ]);
        const seen = new Set<string>();
        const result: MemoryEntity[] = [];
        for (const raw of value) {
            if (!raw || typeof raw !== 'object') continue;
            const item = raw as Record<string, unknown>;
            const name = typeof item.name === 'string' ? item.name.trim().slice(0, 80) : '';
            const key = name.normalize('NFKC').toLocaleLowerCase();
            if (name.length < 2 || !key || seen.has(key)) continue;
            seen.add(key);
            const entity: MemoryEntity = { name };
            if (validTypes.has(item.type as NonNullable<MemoryEntity['type']>)) {
                entity.type = item.type as NonNullable<MemoryEntity['type']>;
            }
            result.push(entity);
            if (result.length >= 12) break;
        }
        return result;
    };

    return parsed
        .filter(item => item.content && item.room)
        .map((item): MemoryNode => {
            const createdAt = resolveCreatedAt(item.date);
            const pinDays = parseInt(item.pinDays, 10);
            // 置頂 deadline 跟著 per-memory createdAt 算，否則"今天感冒 pinDays 5"
            // 會從 batch 中點起算，跨日 batch 裡就直接少算/多算。
            const pinnedUntil = (pinDays > 0 && pinDays <= 30)
                ? createdAt + pinDays * 24 * 60 * 60 * 1000
                : null;
            // (v, a) 非必需：LLM 沒給就不寫，下游 getEmotionVA 查表兜底
            const v = typeof item.valence === 'number' ? clampVA(item.valence) : undefined;
            const a = typeof item.arousal === 'number' ? clampVA(item.arousal) : undefined;
            const memory: MemoryNode = {
                id: generateId(),
                charId,
                content: item.content,
                room: (VALID_ROOMS.includes(item.room as MemoryRoom) ? item.room : 'living_room') as MemoryRoom,
                tags: Array.isArray(item.tags) ? item.tags : [],
                importance: Math.max(1, Math.min(10, Math.round(item.importance || 5))),
                mood: item.mood || 'neutral',
                valence: v,
                arousal: a,
                embedded: false,
                createdAt,
                lastAccessedAt: createdAt,
                accessCount: 0,
                pinnedUntil,
                eventBoxId: null,  // 由 pipeline 在 binding 階段設置
                origin: 'extraction',
            };
            if (includeEntities) memory.entities = parseEntities(item.entities);
            // No anchor guesses from event dates or the extraction batch. Only a valid original message reference.
            if (linkDates && relativeTimeEnabled() && hasRelativeTime(memory.content)
                && typeof item.relativeTimeSource === 'string' && /^M\d+$/.test(item.relativeTimeSource)) {
                const source = messages[Number(item.relativeTimeSource.slice(1))];
                if (source && Number.isFinite(source.timestamp) && source.timestamp > 0
                    && hasMatchingRelativeSource(memory.content, formatMessageForPrompt(source, '', '').slice(0, 600))) {
                    memory.relativeTimeAnchor = {
                        dateKey: getLocalDateKey(new Date(source.timestamp)), source: 'message', messageId: source.id,
                    };
                }
            }
            return memory;
        });
}

/** 把 LLM 吐的 v/a 夾到 [-1, 1]，防止它寫成 1.5 / -2 之類 */
function clampVA(x: number): number {
    if (Number.isNaN(x)) return 0;
    if (x > 1) return 1;
    if (x < -1) return -1;
    return x;
}

// ─── EventBox 綁定相關 prompt + 解析 helper（buffer / migration 共用） ──

/**
 * 構造"已有記憶"的 prompt 區塊，帶 O-編號供 LLM 引用。
 */
export function buildRelatedMemoriesBlock(relatedMemories: RelatedMemoryRef[]): string {
    if (relatedMemories.length === 0) return '';
    return `\n## 已有記憶（如果新記憶與某條舊記憶描述的是同一件事或直接相關，請在 relatedTo 中標註編號，並給出 eventName / eventTags 用於建/合併事件盒）\n${
        relatedMemories.map((r, i) => `O${i}. [${r.room}] ${r.content}`).join('\n')
    }\n`;
}

/**
 * 構造"事件關聯 + 事件盒命名"的規則文本，追加到 buildRulesBlock 之後。
 */
export function buildRelatedToRule(): string {
    return `\n9. **事件盒關聯**（relatedTo / sameAs + eventName + eventTags）：
   **與舊記憶同事件** → 在 relatedTo 中寫對應 O 編號（如 ["O0", "O3"]）。
   **與本次輸出的其它新記憶同事件** → 在 sameAs 中寫它們在本次 JSON 數組裡的**0 基索引**（只能指向前面已輸出的項，例如寫 ["0"] 表示和數組第一條是同一件事）。
   注意：只標註真正同一件事的（同一事件的後續/結局/復現/直接因果），不要勉強（僅"主題相似"不算）。
   只要 relatedTo 或 sameAs 任一非空，必須同時寫：
   - eventName：這件事的名字（5-12 字，名詞短語，如"買衣服的話題"、"和領導的衝突"）
   - eventTags：3-6 個詳細搜索 tag（具體名詞、人物、地點、動作，便於日後召回）
   都沒關聯就不寫 relatedTo / sameAs / eventName / eventTags 四個字段。
10. **不重複綁定**：一條新記憶和多條已有/新記憶都相關時，把編號都寫全；eventName / eventTags 只寫一份（描述這件事整體）。
11. **糾正舊記憶**（corrects，可選，獨立於上面的記憶條目，作為 JSON 數組的額外項）：
   僅在對話中**用戶明確指出某條已有記憶記錯了 / 已過時 / 不準確**時使用。識別信號：用戶用"不對/不是/我說錯了/已經不是了/搞錯了/那是XX不是YY"之類的反駁句式，明確指向你剛才的某個說法。
   如果命中，在輸出的 JSON 數組**末尾**追加一項，格式為：
   {"correct": "O編號", "note": "新版本的事實（不帶語氣，簡短陳述句）"}
   note 寫"實情是什麼"，不是"為什麼錯"。例：用戶糾正"我已經搬家了，不在朝陽"→ note: "已經搬家，不再住朝陽"。
   反例（**不要**用 corrects）：
   - 僅事件後續 / 狀態發展 → 用 relatedTo
   - 僅追加細節 / 補充信息 → 不要標
   - 你自己想到的歧義 / 自我修正 → 不要標
   一條對話最多 corrects 1-2 項，不要亂用。`;
}

/**
 * 輸出格式中的字段示例（如果有 relatedMemories 才注入）。
 */
export function buildRelatedToFormatHint(): string {
    return `,
    "relatedTo": ["O0"],
    "sameAs": ["0"],
    "eventName": "買衣服的話題",
    "eventTags": ["衣服", "購物", "退貨", "流行款"]`;
}

/**
 * 從 LLM 輸出（已解析 JSON）和提取出的 memories 中，
 * 解析出：
 *  - crossTimeLinks（newMemoryId → existingMemoryId）
 *  - eventBoxHints（newMemoryId → eventName / eventTags）
 *
 * 注意：parsed 數組順序應該與 memories 順序對齊（同源 LLM 輸出）。
 */
export function parseRelatedToAndHints(
    parsed: any[],
    memories: MemoryNode[],
    relatedMemories: RelatedMemoryRef[],
): { crossTimeLinks: { newMemoryId: string; existingMemoryId: string }[]; eventBoxHints: EventBoxHint[] } {
    const crossTimeLinks: { newMemoryId: string; existingMemoryId: string }[] = [];
    const eventBoxHints: EventBoxHint[] = [];

    if (memories.length === 0) {
        return { crossTimeLinks, eventBoxHints };
    }

    // parsed 包含的不只是 memory（還可能有 unpin 指令等），按 memory 順序對齊：
    // memories 是 parsed.filter(item => item.content && item.room) 的結果，
    // 用同樣的過濾遍歷 parsed，按位次匹配 memories。
    let memIdx = 0;
    for (const item of parsed) {
        if (!item || !item.content || !item.room) continue;
        const mem = memories[memIdx++];
        if (!mem) break;

        let hasAnyLink = false;

        // (a) relatedTo → O 索引指向已有記憶
        if (relatedMemories.length > 0 && Array.isArray(item.relatedTo) && item.relatedTo.length > 0) {
            for (const ref of item.relatedTo) {
                const idx = parseInt(String(ref).replace(/^O/i, ''), 10);
                if (idx >= 0 && idx < relatedMemories.length) {
                    crossTimeLinks.push({
                        newMemoryId: mem.id,
                        existingMemoryId: relatedMemories[idx].id,
                    });
                    hasAnyLink = true;
                }
            }
        }

        // (b) sameAs → N 索引指向本批次之前的新記憶（靠數組 0-base index 索引）
        //     memIdx 已經 ++，當前這條在 memories 中的位置是 memIdx-1；允許引用 0..memIdx-2
        if (Array.isArray(item.sameAs) && item.sameAs.length > 0) {
            const currentPos = memIdx - 1;
            for (const ref of item.sameAs) {
                const idx = parseInt(String(ref).replace(/^N/i, ''), 10);
                if (idx >= 0 && idx < currentPos && memories[idx]) {
                    crossTimeLinks.push({
                        newMemoryId: mem.id,
                        existingMemoryId: memories[idx].id, // 此時 memories[idx] 的 id 已經生成
                    });
                    hasAnyLink = true;
                }
            }
        }

        // (c) 如果任一關聯成立，收集 eventName/eventTags 作為 hints
        if (hasAnyLink) {
            const name = typeof item.eventName === 'string' ? item.eventName.trim() : '';
            const tags = Array.isArray(item.eventTags)
                ? item.eventTags.map((t: any) => String(t).trim()).filter(Boolean)
                : [];
            if (name || tags.length > 0) {
                eventBoxHints.push({
                    newMemoryId: mem.id,
                    eventName: name,
                    eventTags: tags,
                });
            }
        }
    }

    if (crossTimeLinks.length > 0) {
        console.log(`🔗 [Extraction] 發現 ${crossTimeLinks.length} 條同事件關聯（含跨批次 relatedTo 與同批 sameAs），${eventBoxHints.length} 條帶命名提示`);
    }
    return { crossTimeLinks, eventBoxHints };
}

// ─── 跨時間關聯：傳入向量檢索命中的舊記憶供 LLM 關聯 ───

/** 向量檢索命中的已有記憶引用，用於跨時間事件關聯 */
export interface RelatedMemoryRef {
    id: string;       // MemoryNode.id
    room: string;
    content: string;  // 截斷的內容摘要
}

/** 當前生效的便利貼引用 */
export interface PinnedMemoryRef {
    id: string;
    content: string;
}

/**
 * EventBox 創建/合併提示。
 * 當 LLM 把新記憶 N 標記為 relatedTo 舊記憶 O 時，附帶的盒名/標籤提示。
 * pipeline 在 binding 時使用：若需要新建 EventBox，用此名/tags 初始化。
 */
export interface EventBoxHint {
    /** 觸發該 hint 的新記憶 ID */
    newMemoryId: string;
    /** LLM 建議的事件盒名（如"買衣服"） */
    eventName: string;
    /** LLM 建議的詳細 tag */
    eventTags: string[];
}

/** 緩衝區提取結果，包含跨時間關聯信息 */
export interface BufferExtractionResult {
    memories: MemoryNode[];
    /** 新記憶 → 關聯的已有記憶 ID 映射（用於 EventBox 綁定） */
    crossTimeLinks: { newMemoryId: string; existingMemoryId: string }[];
    /** EventBox 名/tag 提示（僅 relatedTo 非空的新記憶才有） */
    eventBoxHints: EventBoxHint[];
    /** 應提前摘除的便利貼 ID */
    unpinIds: string[];
    /** 糾正：把對應已有記憶的 content 追加一行"YYYY-MM-DD 糾正：note"，並重新向量化 */
    corrections: { targetId: string; note: string }[];
}

// ─── 緩衝區提取：直接從消息提取記憶，不依賴 TopicBox ───

/**
 * 從消息緩衝區直接提取記憶節點。
 * 用於緩衝區機制：積累的聊天消息達到閾值後，一次 LLM 調用提取記憶。
 *
 * @param relatedMemories 向量檢索命中的已有記憶，供 LLM 判斷跨時間事件關聯（搭便車，不額外調用）
 * @param pinnedMemories 當前生效的便利貼，供 LLM 判斷是否應提前摘除（搭便車）
 */
export async function extractMemoriesFromBuffer(
    messages: Message[],
    charId: string,
    charName: string,
    llmConfig: LightLLMConfig,
    charContext?: string,
    userName?: string,
    relatedMemories?: RelatedMemoryRef[],
    pinnedMemories?: PinnedMemoryRef[],
): Promise<BufferExtractionResult> {
    if (messages.length === 0) return { memories: [], crossTimeLinks: [], eventBoxHints: [], unpinIds: [], corrections: [] };

    const includeEntities = readRecallRuntimeSnapshot().featureFlagsSnapshot.recallRouter;
    const linkDates = relativeTimeEnabled();
    const userLabel = userName || '用戶';
    const conversationText = buildConversationText(messages, charName, userLabel, linkDates);
    const sarMemoryBoundary = buildSARMemoryBoundaryInstruction(conversationText);

    const contextBlock = charContext
        ? `\n## 你的人設（供參考，幫助你理解對話中的關係和角色定位）\n${charContext}\n`
        : '';

    // 構建已有記憶引用塊（帶 O-編號，供 LLM 輸出 relatedTo）
    const hasRelated = relatedMemories && relatedMemories.length > 0;
    const relatedBlock = hasRelated
        ? buildRelatedMemoriesBlock(relatedMemories!)
        : '';
    const relatedToRule = hasRelated ? buildRelatedToRule() : '';
    const relatedToFormat = hasRelated ? buildRelatedToFormatHint() : '';

    // 便利貼摘除判斷
    const hasPinned = pinnedMemories && pinnedMemories.length > 0;
    const pinnedBlock = hasPinned
        ? `\n## 當前便利貼（如果對話內容表明某條便利貼已失效，在輸出末尾用 unpin 標註）\n${
            pinnedMemories!.map((p, i) => `P${i}. ${p.content}`).join('\n')
          }\n`
        : '';

    const unpinRule = hasPinned
        ? `\n12. **便利貼摘除**（unpin，可選）：如果對話中明確提到某條便利貼描述的狀態已結束（如"感冒好了""提前回來了""考試考完了"），在輸出的 JSON 數組末尾加一條 {"unpin": "P0"} 來摘除它。只在對話明確提及時才摘除，不要猜測。`
        : '';

    const systemPrompt = `你是 ${charName}。根據給定的對話內容，以你的第一人稱視角（"我"）提取值得記住的記憶。${contextBlock}${relatedBlock}${pinnedBlock}

${buildRulesBlock(charName, userLabel, includeEntities)}${relatedToRule}${unpinRule}${sarMemoryBoundary ? `\n\n${sarMemoryBoundary}` : ''}${linkDates ? `

## 相對時間來源
content 保留原消息的相對時間措辭，不要自行添加日期括號。含“昨天、前天、幾天前、上週、上個月、去年”等措辭時，額外輸出 relativeTimeSource 字段，值為說出該措辭的原消息編號（例如 "M0"）。系統將以該消息的發送日補註，不使用 date 事件日。不同說話日期的相對時間應拆成不同記憶。沒有可靠來源、跨時區語義不明或無法使用同一個參照日時，省略該字段，禁止猜測。` : ''}

## 輸出格式

嚴格 JSON 數組，不要 markdown 包裹：
[
  {
    "content": "我視角的記憶...",
    "room": "living_room",
    "importance": 5,
    "mood": "neutral",
    "valence": 0,
    "arousal": 0,
    "tags": ["標籤1", "標籤2"],${includeEntities ? `
    "entities": [{"name": "明確出現的專名", "type": "person"}],` : ''}
    "date": "YYYY-MM-DD",
    "pinDays": 3${relatedToFormat}
  }
]

date 必填，按該記憶實際發生當天填（參考消息行首的時間戳）。
pinDays 僅在需要置頂時才寫，大多數記憶不需要。
如果對話過於瑣碎無值得記憶的內容，返回空數組 []。`;

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
                        { role: 'user', content: `對話內容：\n${conversationText}` },
                    ],
                    temperature: 0.4,
                    // 12000 比 16000 留餘量：避免 LLM 頂滿 cap 導致 JSON 輸出被 truncate
                    // buffer 路徑 pipeline 上層 CHUNK_SIZE=250 已經在切分 → 單 call 輸出可控
                    max_tokens: 12000,
                    stream: false,
                }),
            },
            2, 180_000, { appName: '記憶宮殿', purpose: '記憶提取' }
        );

        const reply = data.choices?.[0]?.message?.content || '';
        const parsed = safeParseJsonArray(reply);

        if (parsed.length === 0 && reply.trim().length > 0) {
            console.warn(`🏰 [Extraction] LLM 返回了內容但 JSON 解析為空數組，可能格式異常。原始回覆前200字: ${reply.slice(0, 200)}`);
        }

        console.log(`🏰 [Extraction] 緩衝區提取完成：從 ${messages.length} 條消息中提取 ${parsed.length} 條記憶`);

        // 生成日期標籤
        const firstTs = messages[0]?.timestamp;
        const lastTs = messages[messages.length - 1]?.timestamp;
        const d1 = (firstTs != null && firstTs > 0) ? new Date(firstTs) : new Date();
        const d2 = (lastTs != null && lastTs > 0) ? new Date(lastTs) : d1;
        const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
        const batchLabel = fmt(d1) === fmt(d2) ? fmt(d1) : `${fmt(d1)}-${fmt(d2)}`;

        const memories = parseMemoryNodesFromBuffer(parsed, charId, messages, batchLabel, includeEntities, linkDates);

        // 解析跨時間關聯（→ EventBox 綁定信號）+ eventName/eventTags 提示
        const { crossTimeLinks, eventBoxHints } = parseRelatedToAndHints(
            parsed, memories, hasRelated ? relatedMemories! : [],
        );

        // 解析便利貼摘除指令：{ "unpin": "P0" } → 真實 ID
        const unpinIds: string[] = [];
        if (hasPinned) {
            for (const item of parsed) {
                if (item.unpin && typeof item.unpin === 'string') {
                    const idx = parseInt(item.unpin.replace(/^P/i, ''), 10);
                    if (idx >= 0 && idx < pinnedMemories!.length) {
                        unpinIds.push(pinnedMemories![idx].id);
                    }
                }
            }
            if (unpinIds.length > 0) {
                console.log(`📌 [Extraction] LLM 建議摘除 ${unpinIds.length} 條便利貼`);
            }
        }

        // 解析糾正指令：{ "correct": "O0", "note": "實情是..." } → 真實 ID
        // 僅在有 relatedMemories 時才有意義（O 編號必須能解析回真節點 id）
        const corrections: { targetId: string; note: string }[] = [];
        if (hasRelated) {
            for (const item of parsed) {
                if (!item || typeof item.correct !== 'string') continue;
                const note = typeof item.note === 'string' ? item.note.trim() : '';
                if (!note) continue;
                const idx = parseInt(item.correct.replace(/^O/i, ''), 10);
                if (idx >= 0 && idx < relatedMemories!.length) {
                    corrections.push({ targetId: relatedMemories![idx].id, note });
                }
            }
            if (corrections.length > 0) {
                console.log(`✏️ [Extraction] LLM 標記 ${corrections.length} 條糾正：${corrections.map(c => c.targetId.slice(0, 12) + '…').join(', ')}`);
            }
        }

        return { memories, crossTimeLinks, eventBoxHints, unpinIds, corrections };

    } catch (err: any) {
        console.error(`❌ [Extraction] 緩衝區提取失敗 (${messages.length} 條消息):`, err.message);
        return { memories: [], crossTimeLinks: [], eventBoxHints: [], unpinIds: [], corrections: [] };
    }
}
