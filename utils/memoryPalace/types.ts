/**
 * Memory Palace (記憶宮殿) — 類型定義
 *
 * 模擬人腦七個腦區的記憶系統。
 * 所有類型定義集中在此文件，供其他模塊導入。
 */

// ─── 七個房間 ─────────────────────────────────────────

export type MemoryRoom =
    | 'living_room'   // 客廳 — 日常閒聊、近期互動（海馬體）
    | 'bedroom'       // 臥室 — 親密情感、深層羈絆（新皮層）
    | 'study'         // 書房 — 工作學習、技能成長（前額葉）
    | 'user_room'     // 用戶房間 — 用戶個人信息、習慣（顳頂聯合區）
    | 'self_room'     // 自我房間 — 角色自我認同、演變（默認模式網絡）
    | 'attic'         // 閣樓 — 未消化的困惑、潛意識（杏仁核–海馬體）
    | 'windowsill';   // 窗台 — 期盼、目標、憧憬（多巴胺獎賞系統）

export interface RoomConfig {
    capacity: number | null;    // null = 無限
    decayRate: number | null;   // null = 永不遺忘，數值為每小時衰減基數
    description: string;
}

export const ROOM_CONFIGS: Record<MemoryRoom, RoomConfig> = {
    living_room: { capacity: 200,  decayRate: 0.9972, description: '日常閒聊、近期互動' },
    bedroom:     { capacity: null, decayRate: 0.9995, description: '親密情感、深層羈絆' },
    study:       { capacity: null, decayRate: 0.9995, description: '工作學習、技能成長' },
    user_room:   { capacity: null, decayRate: 0.9995, description: '用戶個人信息、習慣' },
    self_room:   { capacity: null, decayRate: null,   description: '角色自我認同、演變' },
    attic:       { capacity: null, decayRate: null,   description: '未消化的困惑、潛意識' },
    windowsill:  { capacity: null, decayRate: null,   description: '期盼、目標、憧憬' },
};

export const ROOM_LABELS: Record<MemoryRoom, string> = {
    living_room: '客廳',
    bedroom:     '臥室',
    study:       '書房',
    user_room:   '用戶房間',
    self_room:   '自我房間',
    attic:       '閣樓',
    windowsill:  '窗台',
};

/**
 * 獲取房間的動態顯示標籤。
 * user_room 在有用戶名時顯示為"【用戶名】的房間"，其餘房間返回靜態標籤。
 */
export function getRoomLabel(room: MemoryRoom, userName?: string): string {
    if (room === 'user_room' && userName) {
        return `${userName}的房間`;
    }
    return ROOM_LABELS[room];
}

// ─── 記憶節點 ─────────────────────────────────────────

export interface MemoryEntity {
    /** 記憶中明確出現的專名；不收錄“他 / 朋友 / 那個項目”這類泛稱。 */
    name: string;
    type?: 'person' | 'place' | 'organization' | 'project' | 'product' | 'account' | 'domain' | 'other';
    /** 第一版不自動推斷別名，只消費已經明確存下來的別名。 */
    aliases?: string[];
}

export interface MemoryNode {
    /** 可選補註的固定說話日期，不是 createdAt 事件日。原文始終不含系統補註。 */
    relativeTimeAnchor?: { dateKey: string; source: 'message'; messageId?: number };
    id: string;
    charId: string;
    content: string;            // 記憶內容（提取記憶為第三人稱敘事，消化衍生記憶為第一人稱內心獨白）
    room: MemoryRoom;
    tags: string[];
    /** 用於顯式實體精確召回；舊數據沒有此字段時會回退到 tags/content 精確匹配。 */
    entities?: MemoryEntity[];
    importance: number;         // 1–10
    mood: string;               // 情緒標籤，如 'happy', 'sad', 'angry'
    /** Russell 環形情感模型 · 效價：-1 極痛苦 → +1 極愉悅。未填則由 emotionSpace.getEmotionVA() 查表兜底 */
    valence?: number;
    /** Russell 環形情感模型 · 喚醒度：-1 極平靜 → +1 極激烈 */
    arousal?: number;
    embedded: boolean;          // 是否已向量化
    createdAt: number;          // timestamp ms
    lastAccessedAt: number;     // timestamp ms
    accessCount: number;
    pinnedUntil?: number | null; // 便利貼置頂截止時間（timestamp ms），null/undefined = 不置頂
    sourceId?: string | null;   // 消化衍生記憶的源記憶 ID，null = 非衍生記憶
    origin?: 'extraction' | 'digestion' | 'system'; // 記憶來源：extraction=聊天提取, digestion=認知消化衍生, system=系統生成
    /**
     * 消化已消費標記：synthesize_user / internalize / self_insight / self_confuse
     * 消費過的源節點打上時間戳，不再進入後續消化的候選池。
     * 歷史上這個"已消費"信息靠衍生節點的 sourceId 反查——消化改道門牌後
     * 不再新建衍生節點，改用此字段顯式標記（舊數據仍走 sourceId 反查兜底）。
     */
    digestedAt?: number | null;

    /**
     * 歷史版本曾遷移過的第三方語義元數據。當前已不再提供對應導入能力；保留該字段僅為
     * 兼容已經落進用戶本機數據庫的舊記錄，避免升級後讀取異常。
     */
    legacyCsy?: {
        originalId: string;
        title: string;
        originalContent: string;
        emotionalJourney?: string;
        source?: 'auto' | 'manual' | 'import';
        sourceMessageIds?: number[];
        deprecated?: boolean;
        deprecatedReason?: string;
        hormoneSnapshot?: Record<string, number | undefined>;
        salienceScore?: number;
        updatedAt?: number;
        modelId?: string;
    };

    // ─── EventBox 綁定（新） ─────────────────
    eventBoxId?: string | null;  // 所屬事件盒 ID，null/undefined = 獨立記憶（"地上的球"）
    archived?: boolean;          // true = 已被壓入 box summary，不再參與召回（可復活）
    isBoxSummary?: boolean;      // true = 此節點是某 EventBox 的壓縮總結

    // ─── 群聊記憶來源（獨立管線，私聊代碼不感知這兩個字段） ─────────────
    /** 這條記憶來自哪個群（groupPipeline 提取時打上）；undefined = 來自私聊 */
    groupId?: string;
    /** 群名快照（用於群被刪除後仍能在 UI 裡識別這條記憶來自哪個群） */
    groupName?: string;

    // ─── 已棄用字段（保留以兼容歷史數據讀取，新代碼不應寫入） ───
    /** @deprecated 舊話題盒 ID，已由 eventBoxId 替代 */
    boxId?: string;
    /** @deprecated 舊話題摘要，已廢棄 */
    boxTopic?: string;
}

// ─── 向量存儲 ─────────────────────────────────────────

export interface MemoryVector {
    memoryId: string;           // 關聯 MemoryNode.id
    charId: string;             // 冗餘角色 ID，用於 IndexedDB 索引直查，避免全表掃描
    // 1024 維向量。三種形態：
    //   - 在內存裡檢索時是 Float32Array（4 bytes / dim）
    //   - 寫入 IndexedDB 時是 Uint8Array（Float32 的原始字節，4 bytes / dim）
    //   - 舊數據是 number[]（每個 number ~50 字節，驚人浪費），讀取時會被透明
    //     地轉換並在下次寫入時持久化為 Uint8Array。
    // 出 DB 層之後調用方拿到的永遠是 Float32Array。
    vector: number[] | Float32Array | Uint8Array;
    dimensions: number;
    model?: string;             // 生成此向量的 embedding 模型名（用於換模型檢測）
}

// ─── 關聯網絡 ─────────────────────────────────────────

export type LinkType =
    | 'temporal'    // 時間關聯 — 24h 內創建的記憶
    | 'emotional'   // 情感關聯 — 相同情緒標籤
    | 'causal'      // 因果關聯
    | 'person'      // 人物關聯 — 提到同一人
    | 'metaphor';   // 隱喻關聯

export interface MemoryLink {
    id: string;
    sourceId: string;           // MemoryNode.id
    targetId: string;           // MemoryNode.id
    type: LinkType;
    strength: number;           // 0–1，共同激活時 +0.05
}

// ─── 事件盒 (EventBox) ─────────────────────────────────

/**
 * EventBox —— 把同一件事的多條記憶綁在一起。
 *
 * 創建方式：
 * - LLM 在提取新記憶時，通過 relatedTo 指向舊記憶 → 自動建盒/加盒/合併
 * - 用戶在 UI 裡手動"+ 添加關聯"
 *
 * 召回方式：命中盒內任一"活"節點 → 整盒（summary + 所有活節點）一起出，算 1 個名額
 *
 * 壓縮：活節點達到 COMPRESSION_THRESHOLD (4) 條 →
 * LLM 把"舊 summary? + 新活節點"整合成一個新 summary MemoryNode，
 * 原活節點全部 archived=true 不再參與召回，box.compressionCount++
 */
export interface EventBox {
    id: string;                     // eb_xxx
    charId: string;
    name: string;                   // 盒名（LLM 生成，首次創建時給）
    tags: string[];                 // 詳細 tag，便於搜索（LLM 生成）
    summaryNodeId: string | null;   // 壓縮總結節點的 MemoryNode.id；null = 未壓縮過
    liveMemoryIds: string[];        // 活節點：參與召回的原始記憶
    archivedMemoryIds: string[];    // 灰節點：已被壓入 summary，不參與召回（可復活）
    compressionCount: number;       // 壓縮過幾次
    createdAt: number;
    updatedAt: number;
    lastCompressedAt: number | null;
    /** 是否已封盒。封盒後不再接收新成員，新相關記憶會另建一個盒。召回仍正常。 */
    sealed?: boolean;
    /** 封盒後若有新相關記憶，新建盒會把舊盒 id 記在這裡供追溯（非召回路徑使用）。 */
    predecessorBoxId?: string | null;
}

/** 活節點達到此條數時觸發壓縮 */
export const EVENT_BOX_COMPRESSION_THRESHOLD = 4;

/** 活節點數硬上限：binding 時如果當前開盒已達此數，視作滿員，另開新盒
 *  （帶 predecessorBoxId）。防禦屏障：LLM 壓縮連續失敗不會讓單盒無限膨脹
 *  到 40+ 條活節點，後果是整盒再也壓不動（token 爆、UI 卡）。
 *  比 COMPRESSION_THRESHOLD 大很多是為了給正常的"多批次待壓縮"留出緩衝。 */
export const EVENT_BOX_LIVE_HARD_CAP = 15;

/** 盒內事件總數（archived + live）達到此值後封盒，之後的相關記憶另開新盒 */
export const EVENT_BOX_SEAL_THRESHOLD = 12;

/** summary 目標字數區間（prompt 引導，讓模型儘量落在區間內）+ 硬上限（超過強制截斷兜底）。
 *  目標上界低於硬上限，給「模型數不準字數」留緩衝——模型瞄著上界寫、稍微超一點也不會被砍出「……」。 */
export const EVENT_BOX_SUMMARY_TARGET_MIN_CHARS = 400;
export const EVENT_BOX_SUMMARY_TARGET_MAX_CHARS = 700;
export const EVENT_BOX_SUMMARY_HARD_MAX_CHARS = 900;

// ─── 舊話題盒（已廢棄，代碼路徑已摘除，類型保留以兼容殘留數據讀取） ──

/** @deprecated */
export type BoxStatus = 'open' | 'sealed';

/** @deprecated 舊 TopicLoom 話題盒，已由 EventBox 替代 */
export interface TopicBox {
    id: string;
    charId: string;
    messageIds: number[];
    status: BoxStatus;
    topic: string;
    events: string[];
    keywords: string[];
    createdAt: number;
    sealedAt: number | null;
}

/** @deprecated */
export type TopicContinuity = 'continuous' | 'partial_shift' | 'discontinuous';

// ─── 房間門牌（Room Plate — 情景→語義的固化終點） ──────

/**
 * 門牌：每個房間頭上那層常駐的"蒸餾物"。
 *
 * 房間裝的是情景記憶（一條條帶時間戳的事件），門牌寫的是這些經歷沉澱出的
 * 認知——不走向量召回、不衰減、每輪常駐注入 System Prompt。
 * 對應人腦裡"海馬體情景記憶固化為新皮質語義知識"的那一步。
 *
 * 四個房間有門牌：
 * - user_room「TA的事」  — 用戶的穩定事實（家庭、居住、重要他人、雷區）
 * - self_room「我是誰」  — 角色對自己的穩定認知
 * - bedroom  「我們之間」— 關係的質地。硬規則：只描述現象，禁止給關係命名
 * - study    「我的領域」— 會什麼、在學什麼
 *
 * 客廳天生短暫不配門牌；閣樓/窗台已有各自的生命週期機制（本質上就是它們的門牌）。
 *
 * 更新時機：
 * - EventBox 壓縮/封盒時 → 本盒所屬房間的門牌做一次增量合併
 * - 認知消化（50輪）時  → 四塊門牌做一次全量整理
 *
 * 條目是"合併語義"而非"追加語義"：事實會變（搬家、換工作、和某人和好），
 * 每次 LLM 整理輸出的是完整的新條目列表，舊條目不被重新輸出即被淘汰——
 * 硬容量上限讓不重要/過時的條目在合併時被自然擠出（gist 記憶的容量壓力）。
 */

export type PlateRoom = 'user_room' | 'self_room' | 'bedroom' | 'study';

export const PLATE_ROOMS: PlateRoom[] = ['user_room', 'self_room', 'bedroom', 'study'];

export interface PlateEntry {
    id: string;             // pe_xxx
    text: string;           // 梗概條目，目標 ≤ PLATE_ENTRY_TARGET_CHARS 字
    firstLearnedAt: number; // 首次蒸餾出這條認知的時間（"你是第三個月才跟我說家裡的事"）
    updatedAt: number;      // 最近一次被合併/改寫的時間
    sourceCount: number;    // 被印證的次數（提過一次 vs 反覆出現）
    /** 2-4 字分類標籤（家庭/居住/重要他人/工作/雷區/習慣…），LLM 整理時給出，UI 渲染 chip 與圖標 */
    tag?: string;
}

export interface RoomPlate {
    id: string;             // `${charId}:${room}`
    charId: string;
    room: PlateRoom;
    entries: PlateEntry[];
    updatedAt: number;
    version: number;        // 每次合併 +1
}

/** 每塊門牌的條目硬上限（容量壓力 = 天然的邊界糾錯器） */
export const PLATE_ENTRY_CAPS: Record<PlateRoom, number> = {
    user_room: 12,
    self_room: 10,
    bedroom:   10,
    study:     8,
};

/** 單條目標字數（prompt 引導）與硬上限（超出截斷兜底） */
export const PLATE_ENTRY_TARGET_CHARS = 50;
export const PLATE_ENTRY_HARD_MAX_CHARS = 90;

export const PLATE_TITLES: Record<PlateRoom, string> = {
    user_room: 'TA的事',
    self_room: '我是誰',
    bedroom:   '我們之間',
    study:     '我的領域',
};

// ─── 消化日誌（DigestReport — 認知消化的可回看記錄） ───

/**
 * 每次認知消化落一條報告，回答"這次到底消化了什麼"：
 * 審視了哪些材料 → 狀態機改了什麼 → 往門牌提交了什麼 → 門牌實際更新了哪幾塊。
 * 通用 section 結構讓 UI 保持傻瓜渲染；每角色只保留最近 DIGEST_REPORT_KEEP 條。
 */
export interface DigestReportSection {
    label: string;      // 如「閣樓困惑」「化解」「提交給門牌·TA的事」
    items: string[];    // 內容預覽（已截斷）
}

export interface DigestReport {
    id: string;                         // dr_xxx
    charId: string;
    createdAt: number;
    trigger: 'auto' | 'manual';
    examined: DigestReportSection[];    // 本次審視的材料
    outcomes: DigestReportSection[];    // 狀態機結果（化解/加深/淡忘/實現/落空/新困惑）
    plateSubmissions: DigestReportSection[]; // 提交給門牌的蒸餾候選
    plateUpdated: string[];             // 門牌實際更新的房間（PlateRoom）
    /**
     * 這次的門牌整理交給雲端跑了，結果還在路上（幾分鐘後落地）。
     * 缺字段 = 這條日誌是這個標記出現之前記的，當 false 看。
     */
    plateCloudPending?: boolean;
}

/** 每角色保留的消化報告條數上限 */
export const DIGEST_REPORT_KEEP = 30;

// ─── 期盼（窗台） ─────────────────────────────────────

export type AnticipationStatus = 'active' | 'anchor' | 'fulfilled' | 'disappointed';

export interface Anticipation {
    id: string;
    charId: string;
    content: string;
    status: AnticipationStatus;
    createdAt: number;
    anchoredAt: number | null;  // active → anchor 的時間
    resolvedAt: number | null;  // fulfilled / disappointed 的時間
}

// ─── 處理批次日誌 ─────────────────────────────────────

export interface MemoryBatch {
    id: string;
    charId: string;
    boxId: string;
    status: 'pending' | 'processing' | 'done' | 'error';
    nodesCreated: number;
    error: string | null;
    createdAt: number;
    completedAt: number | null;
}

// ─── 人格風格（影響擴散激活權重） ─────────────────────

export type PersonalityStyle = 'emotional' | 'narrative' | 'imagery' | 'analytical';

/** 每種人格風格對五種關聯類型的權重 */
export const PERSONALITY_WEIGHTS: Record<PersonalityStyle, Record<LinkType, number>> = {
    emotional:  { emotional: 1.0, person: 0.6, metaphor: 0.5, temporal: 0.3, causal: 0.2 },
    narrative:  { temporal: 1.0, person: 0.8, causal: 0.4, emotional: 0.3, metaphor: 0.2 },
    imagery:    { metaphor: 1.0, emotional: 0.5, temporal: 0.3, person: 0.3, causal: 0.2 },
    analytical: { causal: 1.0, temporal: 0.4, person: 0.3, emotional: 0.2, metaphor: 0.2 },
};

// ─── Embedding 配置（獨立於聊天 API） ─────────────────

export interface EmbeddingConfig {
    baseUrl: string;            // OpenAI 兼容端點，如 https://api.siliconflow.cn/v1
    apiKey: string;
    model: string;              // 默認 text-embedding-3-small
    dimensions: number;         // 默認 1024
}

// ─── 遠程向量存儲配置 (Supabase pgvector) ────────────

export interface RemoteVectorConfig {
    enabled: boolean;
    supabaseUrl: string;        // e.g. https://xxxxx.supabase.co
    supabaseAnonKey: string;    // anon / public key
    initialized: boolean;       // 是否已建表
}

// ─── 檢索結果 ─────────────────────────────────────────

export interface ScoredMemory {
    node: MemoryNode;
    finalScore: number;
    similarity: number;         // 向量餘弦相似度
    bm25Score: number;          // BM25 分數
    roomScore: number;          // 房間評分後的最終分
    /** 精確信號的硬保底；formatter 會在普通分數排序前優先保留。 */
    recallGuarantee?: 'explicit_entity';
}
