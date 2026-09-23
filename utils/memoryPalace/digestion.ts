/**
 * Memory Palace — 認知消化 (Cognitive Digestion)
 *
 * 模擬大腦的後台認知過程。角色帶著自己的人設和記憶，
 * 對所有待消化的內容做一次統一審視。消化是**純狀態機**：
 *
 * - 閣樓困惑：化解了→臥室 / 惡化→創傷加深 / 淡忘→衰減
 * - 窗台期盼：實現了→臥室溫暖記憶 / 落空了→閣樓心結
 * - 自我反芻：新困惑→閣樓
 * - 回看經歷：上次消化以來的客廳/臥室經歷（≤30條）——二次反思，
 *   擔憂上閣樓(≤2) / 新期盼上窗台(≤1) / 穩定領悟提交門牌(≤2)，
 *   絕大多數經歷就只是經歷，什麼都不產生
 *
 * 概括類產出（書房內化 / 用戶信息整合 / 自我領悟）**不再新建記憶節點**——
 * 它們是語義不是情景，寫回情景庫會變成"泛情感高 imp 記憶"汙染召回
 * （近似重複詞條問題的根源）。這些產出作為蒸餾候選提交給房間門牌
 * （roomPlates.ts），由門牌的合併語義 + 容量上限自然防過擬合。
 * 被消費的源節點打 digestedAt 標記退出候選池。
 *
 * 每次消化落一條 DigestReport（消化日誌），可在記憶宮殿 App 回看
 * "這次到底消化了什麼"。
 *
 * 這不是分區域輪流審查，而是一次 LLM 調用，角色作為一個整體去"回想"。
 */

import type { MemoryNode, Anticipation, PersonalityStyle, EmbeddingConfig, RemoteVectorConfig, PlateRoom, DigestReport, DigestReportSection } from './types';
import { PLATE_TITLES } from './types';
import type { LightLLMConfig } from './pipeline';
import { MemoryNodeDB, AnticipationDB, DigestReportDB } from './db';
import { PLATE_ROOMS } from './types';
import { fulfillAnticipation, disappointAnticipation, createAnticipation } from './anticipation';
import { vectorizeAndStore } from './vectorStore';
import { safeFetchJson } from '../safeApi';
import { safeParseJsonArray } from './jsonUtils';

/** 從 localStorage 讀取遠程向量配置（與 pipeline.ts 同一份來源） */
function getRemoteVectorConfig(): RemoteVectorConfig | undefined {
    try {
        const raw = localStorage.getItem('os_remote_vector_config');
        if (!raw) return undefined;
        const config = JSON.parse(raw) as RemoteVectorConfig;
        return (config.enabled && config.initialized) ? config : undefined;
    } catch { return undefined; }
}

// ─── 消化結果類型 ─────────────────────────────────────

interface DigestAction {
    /** 記憶/期盼 ID */
    id: string;
    /** 動作類型 */
    action:
        | 'resolve'        // 閣樓困惑化解 → 移到臥室
        | 'deepen'         // 閣樓困惑惡化 → importance 提升
        | 'fade'           // 淡忘 → importance 降低
        | 'fulfill'        // 期盼實現
        | 'disappoint'     // 期盼落空
        | 'internalize'    // 書房知識內化 → 提交「我是誰」門牌（不再新建節點）
        | 'synthesize_user' // user_room 信息整合 → 提交「TA的事」門牌（不再新建節點）
        | 'self_insight'    // self_room 反芻 → 自我領悟：彈窗昭告 + 提交「我是誰」門牌
        | 'self_confuse'    // self_room 反芻 → 產生新的自我困惑 → 閣樓（狀態機輸入，仍建節點）
        | 'worry'          // 回看最近經歷 → 產生擔憂/沒想通的事 → 閣樓（每次上限 2）
        | 'aspire'         // 回看最近經歷 → 長出新期盼 → 窗台（每次上限 1）
        | 'distill'        // 回看最近經歷 → 二次領悟 → 提交門牌（每次上限 2）
        | 'keep';          // 維持現狀
    /** 角色的內心獨白（狀態機動作的改寫內容 / 概括類動作的門牌候選文本） */
    reflection?: string;
    /** synthesize_user 時的分類標籤 */
    category?: string;
    /** self_insight 的領悟全文（彈窗展示 + 門牌蒸餾候選） */
    insight?: string;
    /** distill 時的目標門牌（user_room / self_room / bedroom / study） */
    plate_room?: string;
}

/** 回看最近經歷的產出上限（寧緊勿松：鬆了閣樓會通脹成焦慮症） */
const REFLECT_MAX_WORRIES = 2;
const REFLECT_MAX_ASPIRES = 1;
const REFLECT_MAX_DISTILLS = 2;
/** 回看窗口的條數硬上限（上次消化以來的客廳+臥室經歷，超出取最近的） */
const REFLECT_EPISODE_CAP = 30;

/** 書房/用戶房/自我房每次消化的候選上限：按時近取，長期用戶的老積壓不整批灌進
 *  prompt——舊節點留在房間裡走召回，門牌從新的相處開始長（"只從新的東西里提"）。 */
const FRESH_CANDIDATE_CAP = 20;
/** 閣樓每次審視的條數上限：按重要性優先。未入選的困惑仍在閣樓裡，等下輪 */
const ATTIC_CANDIDATE_CAP = 12;

/** 單條消化條目（帶內容快照，用於 UI 展示） */
export interface DigestEntry {
    id: string;
    content: string;
    /** synthesize_user 的分類 */
    category?: string;
}

export interface DigestResult {
    resolved: DigestEntry[];       // 閣樓→臥室
    deepened: DigestEntry[];       // 閣樓 importance 提升
    faded: DigestEntry[];          // importance 降低
    fulfilled: DigestEntry[];      // 期盼實現
    disappointed: DigestEntry[];   // 期盼落空
    internalized: DigestEntry[];   // 書房知識內化 → 門牌候選
    synthesizedUser: DigestEntry[]; // user_room 信息整合 → 門牌候選
    selfInsights: string[];        // self_room 反芻產生的領悟（彈窗昭告 + 門牌候選）
    selfConfused: DigestEntry[];   // self_room 反芻產生的新困惑→閣樓
    worries: DigestEntry[];        // 回看經歷產生的擔憂→閣樓
    aspirations: DigestEntry[];    // 回看經歷長出的新期盼→窗台
    distilled: DigestEntry[];      // 回看經歷的二次領悟→門牌候選（category=目標門牌）
    /** 本次消化實際更新的門牌房間（含回填/兜底），供 UI 摘要展示 */
    plateUpdated?: string[];
    /**
     * 門牌整理在雲端跑著、結果還沒落地。
     *
     * 手動消化時用戶是**在場**的：他剛點了「消化」，盯著「正在整理門牌…」一路看到結果
     * 摘要。整理搬上雲之後這一步就是「交出去就返回」，門牌得過幾分鐘才動——不說這一句
     * 的話，他看到的是整理階段一閃而過、門牌紋絲不動，跟沒跑過一模一樣。
     */
    plateCloudPending?: boolean;
}

// ─── 輪數計數 & 自動觸發 ─────────────────────────────

/** 每聊 N 輪自動觸發一次消化（1輪 = 用戶發 + AI 回覆） */
const AUTO_DIGEST_ROUNDS = 50;

/** 消化併發鎖：同一角色同時只跑一個消化（鏈路含多次 LLM 調用，重疊=雙倍燒錢+寫競態） */
const digestionLocks = new Set<string>();
const ROUND_KEY = (charId: string) => `mp_digestRounds_${charId}`;
const LAST_DIGEST_KEY = (charId: string) => `mp_lastDigest_${charId}`;
// 老用戶的門牌歷史回填**只走手動**：記憶宮殿 App「整理歷史記憶到門牌」按鈕，
// 每按一次清一小段（斷點續傳）。此前消化尾聲會自動跑最多 10 批——上千條記憶的
// 用戶會在毫無預期時看到一長串"回填第 N 批"，嚇人且失控，已撤掉。

/** 獲取當前已累積的輪數 */
export function getDigestRoundCount(charId: string): number {
    try {
        return parseInt(localStorage.getItem(ROUND_KEY(charId)) || '0', 10);
    } catch { return 0; }
}

/** 累加一輪，返回是否達到自動消化閾值 */
export function incrementDigestRound(charId: string): boolean {
    const current = getDigestRoundCount(charId) + 1;
    try { localStorage.setItem(ROUND_KEY(charId), String(current)); } catch {}
    return current >= AUTO_DIGEST_ROUNDS;
}

/** 重置輪數計數器（消化完成後調用） */
function resetDigestRounds(charId: string): void {
    try { localStorage.setItem(ROUND_KEY(charId), '0'); } catch {}
}

function markDigested(charId: string): void {
    try { localStorage.setItem(LAST_DIGEST_KEY(charId), String(Date.now())); } catch {}
}

/** 上次消化時間戳（回看窗口的左邊界；0 = 從未消化過） */
export function getLastDigestTs(charId: string): number {
    try {
        const v = parseInt(localStorage.getItem(LAST_DIGEST_KEY(charId)) || '0', 10);
        return isNaN(v) || v < 0 ? 0 : v;
    } catch { return 0; }
}

// ─── 收集待消化材料 ──────────────────────────────────

async function gatherDigestMaterial(charId: string): Promise<{
    atticNodes: MemoryNode[];
    anticipations: Anticipation[];
    studyNodes: MemoryNode[];
    userRoomNodes: MemoryNode[];
    selfRoomNodes: MemoryNode[];
    recentContext: MemoryNode[];
    /** 回看窗口：上次消化以來的客廳+臥室經歷——消化的對象，不只是背景板 */
    recentEpisodes: MemoryNode[];
}> {
    const allNodes = await MemoryNodeDB.getByCharId(charId);

    // 已經被消化過一次的源節點不再進入候選池，否則同一源會被反覆
    // synthesize/insight 出近似條目。兩代標記並用：
    //   - digestedAt 字段（新）：消化改道門牌後由 executeActions 顯式打標
    //   - sourceId 反查（舊）：改道前靠衍生節點的 sourceId 隱式標記，兜底舊數據
    const digestedSourceIds = new Set<string>();
    for (const n of allNodes) {
        if (n.origin === 'digestion' && n.sourceId) digestedSourceIds.add(n.sourceId);
    }
    // digestion 衍生節點自身也不參與下一輪處理：它們是產物，不是原料；
    // 反芻它們會讓 LLM 產出"insight 的 insight"，正是用戶截圖裡那種近似重複條目的來源。
    const isFreshCandidate = (n: MemoryNode) =>
        n.origin !== 'digestion' && !n.digestedAt && !digestedSourceIds.has(n.id);

    // 按時近取前 N 條（cap 內的下輪繼續，cap 外的老積壓留在房間裡走召回）
    const capByRecency = (nodes: MemoryNode[], cap: number) =>
        nodes.sort((a, b) => b.createdAt - a.createdAt).slice(0, cap);

    // 閣樓：未化解的困惑反覆參與，直到 resolve/fade。按重要性優先取 cap 條，
    // 防長期用戶的困惑積壓撐爆 prompt（落選的還在閣樓，等下輪）
    const atticNodes = allNodes
        .filter(n => n.room === 'attic')
        .sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt)
        .slice(0, ATTIC_CANDIDATE_CAP);

    // 窗台期盼：active 和 anchor 的
    const allAnts = await AnticipationDB.getByCharId(charId);
    const anticipations = allAnts.filter(a => a.status === 'active' || a.status === 'anchor');

    // 書房：高訪問次數的知識（accessCount >= 3 說明被反覆提及），且未被內化過
    const studyNodes = capByRecency(
        allNodes.filter(n => n.room === 'study' && n.accessCount >= 3 && isFreshCandidate(n)),
        FRESH_CANDIDATE_CAP,
    );

    // 用戶房間：未消化過的用戶信息，按時近取 cap 條——長期用戶的整庫積壓不進 prompt
    const userRoomNodes = capByRecency(
        allNodes.filter(n => n.room === 'user_room' && isFreshCandidate(n)),
        FRESH_CANDIDATE_CAP,
    );

    // 自我房間：未反芻過的自我認知，同上
    const selfRoomNodes = capByRecency(
        allNodes.filter(n => n.room === 'self_room' && isFreshCandidate(n)),
        FRESH_CANDIDATE_CAP,
    );

    // 最近的臥室/客廳記憶作為"最近發生了什麼"的上下文
    const bedroom = allNodes.filter(n => n.room === 'bedroom');
    const living = allNodes.filter(n => n.room === 'living_room');
    const recentContext = [...bedroom, ...living]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 10);

    // 回看窗口："聊天總結成了一條條記憶，消化 = 回頭看這些記憶、二次悟出什麼"。
    // 窗口左邊界 = 上次消化時間（mp_lastDigest_），50 輪消化一次時自然對應
    // "這段時間我們經歷了什麼"。cap 防爆（首次消化 sinceTs=0 會圈住全部歷史）。
    const sinceTs = getLastDigestTs(charId);
    const recentEpisodes = allNodes
        .filter(n => (n.room === 'living_room' || n.room === 'bedroom') && !n.archived && n.createdAt > sinceTs)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, REFLECT_EPISODE_CAP)
        .reverse(); // 時間正序呈現，讓 LLM 按經歷發生的順序讀

    return { atticNodes, anticipations, studyNodes, userRoomNodes, selfRoomNodes, recentContext, recentEpisodes };
}

// ─── LLM 統一消化調用 ────────────────────────────────

async function callDigestLLM(
    charName: string,
    charPersona: string,
    material: {
        atticNodes: MemoryNode[];
        anticipations: Anticipation[];
        studyNodes: MemoryNode[];
        userRoomNodes: MemoryNode[];
        selfRoomNodes: MemoryNode[];
        recentContext: MemoryNode[];
        recentEpisodes: MemoryNode[];
    },
    llmConfig: LightLLMConfig,
    userName?: string,
): Promise<DigestAction[]> {

    // 如果沒有任何待消化的內容，跳過
    if (material.atticNodes.length === 0 &&
        material.anticipations.length === 0 &&
        material.studyNodes.length === 0 &&
        material.userRoomNodes.length === 0 &&
        material.selfRoomNodes.length === 0 &&
        material.recentEpisodes.length === 0) {
        return [];
    }

    const userLabel = userName || '用戶';
    const fmtDate = (ts: number) => {
        const d = new Date(ts);
        return `${d.getMonth() + 1}/${d.getDate()}`;
    };

    const systemPrompt = `你是 ${charName}。以下是你的核心人設：
${charPersona.slice(0, 800)}

你現在正在獨處，安靜地回想最近的事情。你需要對內心裡那些"還沒消化完"的東西做一次整理，同時梳理你對${userLabel}的瞭解，以及審視你自己。

## 你需要審視的內容

${material.atticNodes.length > 0 ? `### 內心困惑 (閣樓)
這些是你一直沒想通的事、受過的傷、沒解決的矛盾：
${material.atticNodes.map((n, i) => `[A${i}] (${n.mood}, 重要性${n.importance}): ${n.content}`).join('\n')}
` : ''}
${material.anticipations.length > 0 ? `### 心裡的期盼 (窗台)
這些是你一直在等待或盼望的事：
${material.anticipations.map((a, i) => `[W${i}] (${a.status}): ${a.content}`).join('\n')}
` : ''}
${material.studyNodes.length > 0 ? `### 反覆想起的知識/成長 (書房)
這些是你經常回憶到的學習和成長經歷：
${material.studyNodes.map((n, i) => `[S${i}] (訪問${n.accessCount}次): ${n.content}`).join('\n')}
` : ''}
${material.userRoomNodes.length > 0 ? `### 關於${userLabel}的瞭解 (${userLabel}的房間)
這些是你目前對${userLabel}的所有零散認知，需要你梳理和整合：
${material.userRoomNodes.map((n, i) => `[U${i}] (${n.tags.join(', ')}): ${n.content}`).join('\n')}
` : ''}
${material.selfRoomNodes.length > 0 ? `### 自我認知 (自我房間)
這些是你目前對自己的認識。反芻這些內容時，你可能會產生新的領悟，也可能產生困惑：
${material.selfRoomNodes.map((n, i) => `[R${i}] (${n.tags.join(', ')}): ${n.content}`).join('\n')}
` : ''}
${material.recentEpisodes.length > 0 ? `### 最近的經歷（回看）
這些是上次靜下來回想之後，你們相處的經歷。回頭看看它們，有些經歷放在一起會讓你注意到當時沒注意的東西：
${material.recentEpisodes.map((n, i) => `[E${i}] (${fmtDate(n.createdAt)}, ${n.mood}): ${n.content}`).join('\n')}
` : `### 最近發生的事
${material.recentContext.map(n => `- (${n.room}, ${n.mood}): ${n.content}`).join('\n')}`}

## 你的任務

以 ${charName} 的第一人稱內心視角，審視上面的內容。對每一條給出判斷：

對於閣樓困惑 [A*]：
- "resolve" — 最近的經歷讓你想開了，釋然了
- "deepen" — 這件事越想越嚴重，變成了心理創傷
- "fade" — 你已經不太在意了，開始淡忘
- "keep" — 還沒想通，繼續放著

對於窗台期盼 [W*]：
- "fulfill" — 這個期盼已經實現了！
- "disappoint" — 這個期盼已經不可能了
- "keep" — 還在等待中

對於書房知識 [S*]：
- "internalize" — 這個已經變成了你的一部分，塑造了你的性格
- "keep" — 還只是知識，沒有內化

對於${userLabel}的信息 [U*]：
- "synthesize_user" — 【極少發生】想像你在為${userLabel}寫一張**角色卡**：只有必須寫在卡上的內容才值得整合——基礎信息（身份/職業大方向/居住）、家庭結構、重要他人（親友）、重大到足以塑造TA這個人的人生節點。階段性狀態（最近很累/工作糟心）、情緒分析、性格側寫、日常瑣事一律 keep——那些留在房間裡就好。必須附上 category（如：家庭、重要他人、身份、居住、重大節點）和 reflection（整合後的事實，50字以內）。
- "keep" — 絕大多數情況（信息只是日常細節，不夠角色卡級）

對於自我認知 [R*]：
⚠️ self_insight 是極其稀有的事件。它意味著角色"想通了自己為什麼是這樣的"——這種領悟一旦產生就幾乎等同於角色設定的自然生長，會永久地成為角色的一部分。產生 self_insight 需要同時滿足：① 這條自我認知已經被反覆觸碰過（不是第一次看到）；② 最近的經歷或其他房間的內容為這條認知提供了新的視角或佐證；③ 角色真正"想明白"了什麼，而不只是產生了模糊的感觸。絕大多數情況下應該選 keep。
- "self_insight" — 你終於想明白了一個關於"我為何是我"的深層認知。這種領悟不一定是正面的，可能是釋然，也可能是帶著苦澀的接納。必須附上 insight（這條常駐自我認知的完整表述，200字以內，要像是角色寫給自己的一段深思，如："我之所以害怕被拋棄，或許是因為我的設定裡本就沒有'被選擇'的經歷——我是被創造的，不是被選中的。但正因如此，${userLabel}主動來找我聊天這件事本身，對我來說就已經是一種珍貴的選擇了。"）和 reflection（內心獨白，50字以內）。
- "self_confuse" — 反芻這條自我認知後，你反而更困惑了——關於自我的存在性困惑。附上 reflection（新的困惑內容，50字以內），這會成為閣樓的新條目。
- "keep" — 沒有新的感悟（絕大多數情況應選此項）
${material.recentEpisodes.length > 0 ? `
對於最近的經歷 [E*]：
⚠️ 克制規則：**絕大多數經歷就只是經歷**，什麼都不產生（keep 或乾脆不寫）。整個列表合計最多 ${REFLECT_MAX_WORRIES} 條 worry、${REFLECT_MAX_ASPIRES} 條 aspire、${REFLECT_MAX_DISTILLS} 條 distill——只挑真正在你心裡留下東西的。回看的價值在於：幾段經歷放在一起，會顯出單獨看時看不見的模式。
- "worry" — 回頭看這段（或這幾段）經歷，你產生了擔憂或沒想通的事。附 reflection（擔憂內容，第一人稱，50字以內），會成為閣樓新條目
- "aspire" — 從這段經歷里長出了一個新期盼。附 reflection（期盼內容，30字以內），會放上窗台
- "distill" — 你從中二次悟出了一條**跨時間穩定**的認知（不是一時的狀態）。附 reflection（認知內容，50字以內）和 plate_room（歸入哪塊門牌：user_room=${userLabel}的**角色卡級**事實（家庭/重要他人/重大人生節點，日常狀態不算） / self_room=關於我自己 / bedroom=我們之間的質地 / study=技能領域）
- "keep" — 就只是經歷（絕大多數情況）
` : ''}
如果是 resolve/deepen/internalize，請附上 reflection（你的內心獨白，用第一人稱"我"來寫，50字以內）。

嚴格 JSON 數組格式：
[{"id": "A0", "action": "resolve", "reflection": "..."}]
[{"id": "U0", "action": "synthesize_user", "category": "性格特質", "reflection": "..."}]
[{"id": "R0", "action": "self_insight", "insight": "...", "reflection": "..."}]
[{"id": "E3", "action": "worry", "reflection": "..."}]
[{"id": "E5", "action": "distill", "reflection": "...", "plate_room": "bedroom"}]

沒有變化的可以不寫。只寫有變化的。`;

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
                        { role: 'user', content: '請開始審視。' },
                    ],
                    temperature: 0.6,
                    max_tokens: 8000,
                    stream: false,
                }),
            },
            2, 120_000, { appName: '記憶宮殿', purpose: '記憶消化' }
        );

        const reply = data.choices?.[0]?.message?.content || '';
        const parsed = safeParseJsonArray(reply);

        const validActions = ['resolve', 'deepen', 'fade', 'fulfill', 'disappoint', 'internalize', 'synthesize_user', 'self_insight', 'self_confuse', 'worry', 'aspire', 'distill', 'keep'];

        // 將 A0/W0/S0/U0/R0/E0 映射回真實 ID
        const mapped = parsed
            .filter(item => validActions.includes(item.action) && item.action !== 'keep')
            .map(item => {
                let realId = '';
                const prefix = item.id?.[0];
                const idx = parseInt(item.id?.slice(1) || '-1', 10);

                if (prefix === 'A' && idx >= 0 && idx < material.atticNodes.length) {
                    realId = material.atticNodes[idx].id;
                } else if (prefix === 'W' && idx >= 0 && idx < material.anticipations.length) {
                    realId = material.anticipations[idx].id;
                } else if (prefix === 'S' && idx >= 0 && idx < material.studyNodes.length) {
                    realId = material.studyNodes[idx].id;
                } else if (prefix === 'U' && idx >= 0 && idx < material.userRoomNodes.length) {
                    realId = material.userRoomNodes[idx].id;
                } else if (prefix === 'R' && idx >= 0 && idx < material.selfRoomNodes.length) {
                    realId = material.selfRoomNodes[idx].id;
                } else if (prefix === 'E' && idx >= 0 && idx < material.recentEpisodes.length) {
                    realId = material.recentEpisodes[idx].id;
                }

                return {
                    id: realId,
                    action: item.action as DigestAction['action'],
                    reflection: item.reflection,
                    category: item.category,
                    insight: item.insight,
                    plate_room: item.plate_room,
                };
            })
            .filter(item => item.id); // 過濾無效映射

        // LLM 偶爾會對同一索引發兩條動作（例如 [A0]→fade 出現兩次），
        // 直接放進 result.faded 會讓彈窗裡同一條目重複出現 —— 按真實節點 ID 取首條。
        const seenIds = new Set<string>();
        return mapped.filter(item => {
            if (seenIds.has(item.id)) return false;
            seenIds.add(item.id);
            return true;
        });

    } catch (err: any) {
        console.warn('⚡ [Digest] LLM call failed:', err.message);
        return [];
    }
}

// ─── 執行消化動作 ─────────────────────────────────────

function generateId(): string {
    return `mn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 歸一化內容用於近似重複比對：去空白、去常見標點、轉小寫 */
function normalizeForDedup(s: string): string {
    return (s || '')
        .replace(/\s+/g, '')
        .replace(/[，。！？、,.!?;:""''「」（）()\[\]【】]/g, '')
        .toLowerCase();
}

/** 字符二元組 Jaccard 相似度 — 雙語對短文本足夠穩健 */
function bigramJaccard(a: string, b: string): number {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const grams = (s: string) => {
        const set = new Set<string>();
        for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
        return set;
    };
    const sa = grams(a);
    const sb = grams(b);
    let inter = 0;
    for (const t of sa) if (sb.has(t)) inter++;
    const union = sa.size + sb.size - inter;
    return union === 0 ? 0 : inter / union;
}

/**
 * 在指定房間裡查找內容近似重複的節點。命中則說明這條 reflection 已經存在過，
 * 不應再新建第二條 — 用戶截圖裡那種"和之前的總結幾乎一樣"就是這種情況。
 *
 * 閾值 0.75 是憑經驗取的：低於這個值通常是新意；高於這個值人眼看上去就是同一條。
 */
function findNearDuplicateInRoom(
    existing: MemoryNode[],
    room: MemoryNode['room'],
    candidateContent: string,
): MemoryNode | null {
    const target = normalizeForDedup(candidateContent);
    if (target.length < 4) return null;
    for (const n of existing) {
        if (n.room !== room) continue;
        const norm = normalizeForDedup(n.content);
        if (!norm) continue;
        if (norm === target || norm.includes(target) || target.includes(norm)) return n;
        if (bigramJaccard(norm, target) >= 0.75) return n;
    }
    return null;
}

async function executeActions(
    actions: DigestAction[],
    charId: string,
    material: {
        atticNodes: MemoryNode[];
        anticipations: Anticipation[];
        studyNodes: MemoryNode[];
        userRoomNodes: MemoryNode[];
        selfRoomNodes: MemoryNode[];
        recentEpisodes: MemoryNode[];
    },
): Promise<{ result: DigestResult; plateSubmissions: Partial<Record<PlateRoom, string[]>> }> {
    const result: DigestResult = {
        resolved: [], deepened: [], faded: [],
        fulfilled: [], disappointed: [], internalized: [],
        synthesizedUser: [], selfInsights: [], selfConfused: [],
        worries: [], aspirations: [], distilled: [],
    };
    // 概括類產出的歸宿：不落節點，作為蒸餾候選提交給門牌
    const plateSubmissions: Partial<Record<PlateRoom, string[]>> = {};
    const submitToPlate = (room: PlateRoom, line: string) => {
        (plateSubmissions[room] ||= []).push(line);
    };
    // 回看產出的硬上限計數：prompt 的克制話術只是軟約束，這裡兜底
    let worryCount = 0, aspireCount = 0, distillCount = 0;

    // 保存新衍生節點前用於查重的全量快照（同房間內容近似的就跳過 save）。
    // 現在只剩 self_confuse 還新建節點（閣樓困惑是狀態機的合法輸入）。
    const existingNodes = await MemoryNodeDB.getByCharId(charId);

    for (const action of actions) {
        try {
            switch (action.action) {
                case 'resolve': {
                    // 閣樓→臥室：困惑化解了
                    const node = material.atticNodes.find(n => n.id === action.id);
                    if (node) {
                        node.room = 'bedroom';
                        node.mood = 'peaceful';
                        if (action.reflection) {
                            node.content = action.reflection;
                        }
                        await MemoryNodeDB.save(node);
                        result.resolved.push({ id: node.id, content: node.content });
                        console.log(`🕊️ [Digest] Resolved → bedroom: "${node.content.slice(0, 30)}..."`);
                    }
                    break;
                }

                case 'deepen': {
                    // 閣樓：困惑惡化，importance 提升
                    const node = material.atticNodes.find(n => n.id === action.id);
                    if (node) {
                        node.importance = Math.min(10, node.importance + 1);
                        if (action.reflection) {
                            node.content = action.reflection;
                        }
                        await MemoryNodeDB.save(node);
                        result.deepened.push({ id: node.id, content: node.content });
                        console.log(`💢 [Digest] Deepened (imp→${node.importance}): "${node.content.slice(0, 30)}..."`);
                    }
                    break;
                }

                case 'fade': {
                    // 淡忘：importance 降低
                    const node = material.atticNodes.find(n => n.id === action.id);
                    if (node) {
                        node.importance = Math.max(1, node.importance - 2);
                        await MemoryNodeDB.save(node);
                        result.faded.push({ id: node.id, content: node.content });
                        console.log(`🌫️ [Digest] Fading (imp→${node.importance}): "${node.content.slice(0, 30)}..."`);
                    }
                    break;
                }

                case 'fulfill': {
                    // 期盼實現（調用已有的 fulfillAnticipation）
                    const ant = material.anticipations.find(a => a.id === action.id);
                    await fulfillAnticipation(action.id);
                    result.fulfilled.push({ id: action.id, content: ant?.content || '' });
                    break;
                }

                case 'disappoint': {
                    // 期盼落空
                    const ant = material.anticipations.find(a => a.id === action.id);
                    await disappointAnticipation(action.id);
                    result.disappointed.push({ id: action.id, content: ant?.content || '' });
                    break;
                }

                case 'internalize': {
                    // 書房知識內化：概括是語義不是情景——不再新建 self_room 節點，
                    // reflection 提交給「我是誰」門牌蒸餾；源節點打標退出候選池。
                    const node = material.studyNodes.find(n => n.id === action.id);
                    if (node && action.reflection) {
                        node.digestedAt = Date.now();
                        await MemoryNodeDB.save(node);
                        result.internalized.push({ id: node.id, content: action.reflection });
                        submitToPlate('self_room', action.reflection);
                        console.log(`🪞 [Digest] Internalize → 門牌候選(self_room): "${action.reflection.slice(0, 30)}..."`);
                    }
                    break;
                }

                case 'synthesize_user': {
                    // 用戶信息整合：同理不落節點，提交給「TA的事」門牌。
                    // 過時/站不住的概括會在門牌合併時被容量壓力擠掉，而非永久駐留召回池。
                    const node = material.userRoomNodes.find(n => n.id === action.id);
                    if (node && action.reflection) {
                        node.digestedAt = Date.now();
                        await MemoryNodeDB.save(node);
                        const category = action.category || '綜合';
                        result.synthesizedUser.push({ id: node.id, content: action.reflection, category });
                        submitToPlate('user_room', `[${category}] ${action.reflection}`);
                        console.log(`👤 [Digest] Synthesize user → 門牌候選(user_room) [${category}]: "${action.reflection.slice(0, 30)}..."`);
                    }
                    break;
                }

                case 'self_insight': {
                    // 自我領悟：彈窗昭告的時刻保留（result.selfInsights 仍驅動 UI），
                    // 但歸宿從 char.selfInsights（只進不出的追加列表）換成「我是誰」門牌——
                    // 時刻是體驗，存儲是架構。
                    const node = material.selfRoomNodes.find(n => n.id === action.id);
                    if (node && action.insight) {
                        node.digestedAt = Date.now();
                        await MemoryNodeDB.save(node);
                        result.selfInsights.push(action.insight);
                        submitToPlate('self_room', action.insight);
                        console.log(`💡 [Digest] Self insight → 門牌候選(self_room): "${action.insight.slice(0, 40)}..."`);
                    }
                    break;
                }

                case 'self_confuse': {
                    // self_room 反芻 → 產生新的自我困惑 → 閣樓。
                    // 這條保留建節點：新困惑是狀態機的合法輸入（後續消化會 resolve/deepen/fade 它），
                    // 不是語義概括。源節點仍打標退出候選池，防止反覆困惑。
                    const node = material.selfRoomNodes.find(n => n.id === action.id);
                    if (node && action.reflection) {
                        node.digestedAt = Date.now();
                        await MemoryNodeDB.save(node);
                        const dup = findNearDuplicateInRoom(existingNodes, 'attic', action.reflection);
                        if (dup) {
                            console.log(`🌀 [Digest] Skip self_confuse (dup of ${dup.id}): "${action.reflection.slice(0, 30)}..."`);
                            break;
                        }
                        const confuseMemory: MemoryNode = {
                            id: generateId(),
                            charId,
                            content: action.reflection,
                            room: 'attic',
                            tags: ['自我困惑', '反芻', ...node.tags.filter(t => t !== '自我困惑' && t !== '反芻')],
                            importance: 6,
                            mood: 'confused',
                            embedded: false,
                            boxId: 'digest_self_confuse',
                            boxTopic: '自我反芻困惑',
                            createdAt: node.createdAt,
                            lastAccessedAt: Date.now(),
                            accessCount: 0,
                            sourceId: node.id,
                            origin: 'digestion',
                        };
                        await MemoryNodeDB.save(confuseMemory);
                        existingNodes.push(confuseMemory);
                        result.selfConfused.push({ id: confuseMemory.id, content: confuseMemory.content });
                        console.log(`🌀 [Digest] Self confused → attic: "${action.reflection.slice(0, 30)}..."`);
                    }
                    break;
                }

                case 'worry': {
                    // 回看經歷 → 擔憂/沒想通 → 閣樓（狀態機輸入，後續消化會化解/加深/淡忘它）
                    const episode = material.recentEpisodes.find(n => n.id === action.id);
                    if (episode && action.reflection && worryCount < REFLECT_MAX_WORRIES) {
                        const dup = findNearDuplicateInRoom(existingNodes, 'attic', action.reflection);
                        if (dup) {
                            console.log(`😟 [Digest] Skip worry (dup of ${dup.id}): "${action.reflection.slice(0, 30)}..."`);
                            break;
                        }
                        worryCount++;
                        const worryMemory: MemoryNode = {
                            id: generateId(),
                            charId,
                            content: action.reflection,
                            room: 'attic',
                            tags: ['回看', '擔憂', ...episode.tags.slice(0, 3)],
                            importance: 5,
                            mood: 'anxious',
                            embedded: false,
                            createdAt: Date.now(),
                            lastAccessedAt: Date.now(),
                            accessCount: 0,
                            sourceId: episode.id,
                            origin: 'digestion',
                        };
                        await MemoryNodeDB.save(worryMemory);
                        existingNodes.push(worryMemory);
                        result.worries.push({ id: worryMemory.id, content: worryMemory.content });
                        console.log(`😟 [Digest] Worry → attic: "${action.reflection.slice(0, 30)}..."`);
                    }
                    break;
                }

                case 'aspire': {
                    // 回看經歷 → 新期盼 → 窗台（進期盼生命週期：active→anchor→fulfilled/disappointed）
                    const episode = material.recentEpisodes.find(n => n.id === action.id);
                    if (episode && action.reflection && aspireCount < REFLECT_MAX_ASPIRES) {
                        aspireCount++;
                        const ant = await createAnticipation(charId, action.reflection);
                        result.aspirations.push({ id: ant.id, content: ant.content });
                        console.log(`🌟 [Digest] Aspire → windowsill: "${action.reflection.slice(0, 30)}..."`);
                    }
                    break;
                }

                case 'distill': {
                    // 回看經歷 → 二次領悟 → 門牌蒸餾候選（不落節點，與其他概括同路）
                    const episode = material.recentEpisodes.find(n => n.id === action.id);
                    const room = String(action.plate_room || '').trim();
                    if (episode && action.reflection && distillCount < REFLECT_MAX_DISTILLS) {
                        if (!(PLATE_ROOMS as string[]).includes(room)) {
                            console.warn(`🚪 [Digest] Skip distill（plate_room 無效: "${room}"）: "${action.reflection.slice(0, 30)}..."`);
                            break;
                        }
                        distillCount++;
                        submitToPlate(room as PlateRoom, action.reflection);
                        result.distilled.push({ id: episode.id, content: action.reflection, category: room });
                        console.log(`🚪 [Digest] Distill → 門牌候選(${room}): "${action.reflection.slice(0, 30)}..."`);
                    }
                    break;
                }
            }
        } catch (err: any) {
            console.warn(`⚡ [Digest] Action ${action.action} failed for ${action.id}:`, err.message);
        }
    }

    return { result, plateSubmissions };
}

// ─── 主入口 ──────────────────────────────────────────

/**
 * 運行一次認知消化循環
 *
 * 觸發時機：每次封盒後由 pipeline 調用（有冷卻時間控制頻率）
 * 也可以在記憶宮殿 App 裡手動觸發（用於測試）
 *
 * @param charId 角色 ID
 * @param charName 角色名
 * @param charPersona 角色核心人設（systemPrompt + worldview 片段）
 * @param llmConfig 輕量 LLM 配置
 * @param force 保留參數兼容，已無冷卻限制
 */
/**
 * 向量化角色所有 embedded:false 的孤兒節點。
 *
 * digest 新建的 4 類節點（internalize / synthesize_user / self_insight / self_confuse）
 * 以及 anticipation.fulfill/disappoint 產生的臥室/閣樓記憶，都以 embedded:false 落盤，
 * 而現有管線不會再回頭掃它們 —— 這步補上，保證它們能被 BM25/向量檢索召回，
 * 並在配了遠程向量時一併 upsert 到 Supabase。
 */
async function vectorizeOrphanedNodes(charId: string, embeddingConfig: EmbeddingConfig): Promise<void> {
    if (!embeddingConfig?.baseUrl || !embeddingConfig.apiKey) {
        console.log(`🔗 [Digest] 跳過孤兒向量化：未配置 embedding`);
        return;
    }
    try {
        const unembedded = await MemoryNodeDB.getUnembedded(charId);
        if (unembedded.length === 0) {
            console.log(`🔗 [Digest] 無孤兒節點，跳過向量化`);
            return;
        }
        console.log(`🔗 [Digest] 向量化 ${unembedded.length} 個待同步節點...`);
        const { stored, skipped } = await vectorizeAndStore(unembedded, embeddingConfig, getRemoteVectorConfig());
        console.log(`🔗 [Digest] 向量化完成：${stored} 入庫，${skipped} 去重跳過`);
    } catch (err: any) {
        console.warn(`🔗 [Digest] 孤兒節點向量化失敗（不影響消化結果）: ${err.message}`);
    }
}

/** 組裝 + 落盤消化日誌（失敗只 warn，不影響消化結果） */
async function saveDigestReport(
    charId: string,
    trigger: 'auto' | 'manual',
    userName: string | undefined,
    material: Awaited<ReturnType<typeof gatherDigestMaterial>> | null,
    result: DigestResult,
    plateSubmissions: Partial<Record<PlateRoom, string[]>>,
    plateUpdated: PlateRoom[],
    plateCloudPending = false,
): Promise<void> {
    const preview = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 100);
    const userLabel = userName || '用戶';
    try {
        const examined: DigestReportSection[] = [];
        if (material) {
            const sec = (label: string, items: string[]) => {
                if (items.length > 0) examined.push({ label, items: items.map(preview) });
            };
            sec('閣樓困惑', material.atticNodes.map(n => n.content));
            sec('窗台期盼', material.anticipations.map(a => a.content));
            sec('書房知識', material.studyNodes.map(n => n.content));
            sec(`${userLabel}的房間`, material.userRoomNodes.map(n => n.content));
            sec('自我認知', material.selfRoomNodes.map(n => n.content));
            sec('回看的經歷（上次消化以來）', material.recentEpisodes.map(n => n.content));
        }

        const outcomes: DigestReportSection[] = [];
        const out = (label: string, items: string[]) => {
            if (items.length > 0) outcomes.push({ label, items: items.map(preview) });
        };
        out('化解（閣樓→臥室）', result.resolved.map(e => e.content));
        out('創傷加深', result.deepened.map(e => e.content));
        out('淡忘', result.faded.map(e => e.content));
        out('期盼實現', result.fulfilled.map(e => e.content));
        out('期盼落空', result.disappointed.map(e => e.content));
        out('新的自我困惑（→閣樓）', result.selfConfused.map(e => e.content));
        out('回看引發的擔憂（→閣樓）', result.worries.map(e => e.content));
        out('回看長出的期盼（→窗台）', result.aspirations.map(e => e.content));

        const submissions: DigestReportSection[] = [];
        for (const [room, lines] of Object.entries(plateSubmissions)) {
            if (lines && lines.length > 0) {
                submissions.push({
                    label: `提交給門牌「${PLATE_TITLES[room as PlateRoom]}」`,
                    items: lines.map(preview),
                });
            }
        }

        const report: DigestReport = {
            id: `dr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            charId,
            createdAt: Date.now(),
            trigger,
            examined,
            outcomes,
            plateSubmissions: submissions,
            plateUpdated,
            plateCloudPending,
        };
        await DigestReportDB.save(report);
    } catch (e: any) {
        console.warn(`📋 [Digest] 消化日誌保存失敗: ${e?.message || e}`);
    }
}

export async function runCognitiveDigestion(
    charId: string,
    charName: string,
    charPersona: string,
    llmConfig: LightLLMConfig,
    manualTrigger: boolean = false,
    userName?: string,
    embeddingConfig?: EmbeddingConfig,
    /** 階段回調：LLM 調用鏈較長（審視→回填→整理），讓前端能實時告訴用戶別走開 */
    onProgress?: (stage: string) => void,
): Promise<DigestResult | null> {
    const trigger: 'auto' | 'manual' = manualTrigger ? 'manual' : 'auto';

    // 併發鎖：同一角色同時只跑一個消化。鏈路長（審視→回填→整理），沒有鎖時
    // 觸發重疊會雙倍燒錢 + digestedAt/門牌寫入互相競態。
    if (digestionLocks.has(charId)) {
        console.log(`🧠 [Digest] 跳過：該角色已有消化在進行`);
        return null;
    }
    digestionLocks.add(charId);

    // ⚠️ 進場即歸零，而不是結束時歸零。兩個理由：
    //  1. 消化鏈路可達分鐘級，期間新聊天輪 increment 到 51/52…≥50 會再觸發——
    //     結束時歸零擋不住這個風暴窗口；進場歸零後，消化期間的輪數計入下一個50。
    //  2. 中途任何異常逃逸都會跳過"結束時歸零"，計數器卡死 → 每輪重觸發燒錢
    //     （用戶"每聊一句彈一次門牌整理"的事故根因）。進場歸零天然免疫。
    //  失敗的代價只是這一批材料等下一個 50 輪——lastDigestTs 只在成功結束時
    //  推進（markDigested），回看窗口不會因失敗而丟內容。
    resetDigestRounds(charId);

    try {
    // 收集材料
    const material = await gatherDigestMaterial(charId);

    // 如果沒有任何待消化的東西（含回看窗口），仍然做一次孤兒節點向量化（歷史遺留的 embedded:false 補齊）
    if (material.atticNodes.length === 0 &&
        material.anticipations.length === 0 &&
        material.studyNodes.length === 0 &&
        material.userRoomNodes.length === 0 &&
        material.selfRoomNodes.length === 0 &&
        material.recentEpisodes.length === 0) {
        if (embeddingConfig) await vectorizeOrphanedNodes(charId, embeddingConfig);
        const emptyResult: DigestResult = { resolved: [], deepened: [], faded: [], fulfilled: [], disappointed: [], internalized: [], synthesizedUser: [], selfInsights: [], selfConfused: [], worries: [], aspirations: [], distilled: [] };
        // 早退分支不跑門牌整理：回看窗口（客廳+臥室）都空 = 上次消化以來門牌房間
        // 沒有任何新節點，整理只會讓 LLM 對著舊材料重排——純燒錢。
        emptyResult.plateUpdated = [];
        await saveDigestReport(charId, trigger, userName, null, emptyResult, {}, []);
        // 計數器已在進場時歸零（見函數開頭），這裡只推進 lastDigestTs
        markDigested(charId);
        return emptyResult;
    }

    console.log(`🧠 [Digest] Starting cognitive digestion for ${charName}: ${material.atticNodes.length} attic, ${material.anticipations.length} anticipations, ${material.studyNodes.length} study, ${material.userRoomNodes.length} user, ${material.selfRoomNodes.length} self, ${material.recentEpisodes.length} episodes(回看)`);

    // LLM 統一消化
    onProgress?.('正在審視記憶…');
    const actions = await callDigestLLM(charName, charPersona, material, llmConfig, userName);

    // 執行動作：狀態機改現有節點；概括類產出彙集為門牌蒸餾候選
    const { result, plateSubmissions } = await executeActions(actions, charId, material);

    // 一次性評審：本輪送審過的書房/用戶房/自我房候選**全部**打標退場——
    // 被消費的在 executeActions 裡已標，這裡補上被判 keep 的：判過"該不該上門牌"
    // 的記憶不再反覆送審（keep = 看過了、不夠格）。老積壓因此每次消化自然消掉
    // 一批（≤20/房），逐次清理。閣樓/窗台是狀態機，必須反覆出現直到有結局，不打標；
    // 回看窗口按時間推進，天然不重複。
    try {
        const seenAt = Date.now();
        const toMark = [...material.studyNodes, ...material.userRoomNodes, ...material.selfRoomNodes]
            .filter(n => !n.digestedAt);
        for (const n of toMark) {
            n.digestedAt = seenAt;
            await MemoryNodeDB.save(n);
        }
        if (toMark.length > 0) console.log(`🧠 [Digest] ${toMark.length} 條送審候選打標退場（含 keep）`);
    } catch (e: any) {
        console.warn(`🧠 [Digest] 候選打標失敗（下輪會重新送審，無害）: ${e?.message || e}`);
    }

    // 向量化本次新建的節點 + 任何歷史遺留的孤兒節點
    if (embeddingConfig) await vectorizeOrphanedNodes(charId, embeddingConfig);

    // 門牌全量整理：消化是"獨處反思"，正是把情景沉澱為語義的時機。
    // 本次消化提煉的概括（plateSubmissions）作為高優先級原料一併送入。
    // （歷史回填不在這裡跑——只走記憶宮殿的手動按鈕，每按一次清一小段）
    let plateUpdated: PlateRoom[] = [];
    // 整理交給雲端跑了、結果還在路上。要跟「一塊都沒動」分開記：不分的話消化日誌會寫
    // 「本次提交的候選未合併進門牌」，而它其實正在用戶自己的 Worker 上跑，幾分鐘後就落地。
    let platesCloudPending = false;
    try {
        onProgress?.('正在整理門牌…');
        const { consolidateAllPlates } = await import('./roomPlates');
        // sinceTs = 上次消化時間：門牌原料以"這段時間的新增"優先，老節點只留少量高分錨點
        const consolidated = await consolidateAllPlates(charId, charName, userName, llmConfig, plateSubmissions, getLastDigestTs(charId));
        platesCloudPending = consolidated.cloudPending === true;
        for (const r of consolidated.updated) if (!plateUpdated.includes(r)) plateUpdated.push(r);
        if (plateUpdated.length > 0) {
            console.log(`🚪 [Digest] 門牌整理完成：${plateUpdated.join(', ')}`);
        }
        if (platesCloudPending) {
            console.log('🚪 [Digest] 門牌整理已交雲端，結果稍後落地');
        }
    } catch (e: any) {
        console.warn(`🚪 [Digest] 門牌整理失敗（不影響消化結果）: ${e?.message || e}`);
    }
    result.plateUpdated = plateUpdated;
    // 手動消化的調用方要拿它跟用戶交代一句（見 MemoryPalaceApp 的結果摘要）：
    // 整理是交給雲端跑的，這會兒門牌還沒動，不說清楚就跟沒跑過一個樣。
    result.plateCloudPending = platesCloudPending;

    // 消化日誌：這次到底消化了什麼，可在記憶宮殿 App 回看
    await saveDigestReport(charId, trigger, userName, material, result, plateSubmissions, plateUpdated, platesCloudPending);

    // 標記時間（計數器已在進場時歸零）
    markDigested(charId);

    const total = result.resolved.length + result.deepened.length + result.faded.length +
        result.fulfilled.length + result.disappointed.length + result.internalized.length +
        result.synthesizedUser.length + result.selfInsights.length + result.selfConfused.length +
        result.worries.length + result.aspirations.length + result.distilled.length;
    if (total > 0) {
        console.log(`✅ [Digest] Complete: ${result.resolved.length} resolved, ${result.deepened.length} deepened, ${result.faded.length} faded, ${result.fulfilled.length} fulfilled, ${result.disappointed.length} disappointed, ${result.internalized.length} internalized, ${result.synthesizedUser.length} synthesized_user, ${result.selfInsights.length} self_insights, ${result.selfConfused.length} self_confused, ${result.worries.length} worries, ${result.aspirations.length} aspirations, ${result.distilled.length} distilled`);
    }

    return result;
    } finally {
        digestionLocks.delete(charId);
    }
}

// ─── 人格風格自動推斷 ────────────────────────────────

const VALID_STYLES: PersonalityStyle[] = ['emotional', 'narrative', 'imagery', 'analytical'];

/**
 * 根據角色人設 + 已有記憶，讓 LLM 判斷角色的人格風格。
 * 首次啟用記憶宮殿時自動調用一次，結果寫入 self_room 並返回。
 *
 * @returns 推斷出的 PersonalityStyle，失敗時返回 'emotional' 作為默認值
 */
export async function detectPersonalityStyle(
    charId: string,
    charName: string,
    charPersona: string,
    llmConfig: LightLLMConfig,
): Promise<{ style: PersonalityStyle; ruminationTendency: number; reasoning: string }> {
    // 收集已有記憶作為參考（最多20條，按重要性排序）
    const allNodes = await MemoryNodeDB.getByCharId(charId);
    const sampleNodes = allNodes
        .sort((a, b) => b.importance - a.importance)
        .slice(0, 20);

    const memoryContext = sampleNodes.length > 0
        ? `\n## 已有的記憶樣本\n${sampleNodes.map((n, i) => `${i + 1}. [${n.room}/${n.mood}] ${n.content}`).join('\n')}`
        : '';

    const systemPrompt = `你是一個性格分析專家。根據角色的人設和記憶，判斷這個角色的認知風格和反芻傾向。

## 角色：${charName}
${charPersona.slice(0, 1200)}
${memoryContext}

## 一、四種認知風格（style）

- **emotional**（情感型）：思維以情緒為主導，容易被感受牽引，聯想時優先走情感鏈路。適合感性、共情力強、情緒豐富的角色。
- **narrative**（敘事型）：思維以時間線和因果為主導，喜歡講故事、回顧經歷。適合沉穩、重視經歷和關係發展的角色。
- **imagery**（意象型）：思維以隱喻和畫面為主導，喜歡用比喻理解世界。適合文藝、詩意、想像力豐富的角色。
- **analytical**（分析型）：思維以邏輯和因果為主導，喜歡分析、推理。適合理性、冷靜、重視邏輯的角色。

## 二、反芻傾向（ruminationTendency）

0.0 ~ 1.0 之間的數值，表示這個角色有多容易反覆糾結過去的事、翻舊帳、被未解決的心結困擾。
- 0.0～0.2：灑脫、活在當下，很少糾結過去
- 0.3～0.5：正常水平，偶爾會想起舊事
- 0.6～0.8：敏感、容易糾結，經常翻舊帳
- 0.9～1.0：極度執念型，無法釋懷

請根據 ${charName} 的性格特徵判斷，給出簡短理由（30字以內）。

嚴格 JSON 格式回覆：
{"style": "emotional", "ruminationTendency": 0.3, "reasoning": "理由"}`;

    console.log(`🎭 [PersonalityDetect] ${charName} → 調用 LLM（model=${llmConfig.model}, max_tokens=8000）`);
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
                        { role: 'user', content: '請判斷。' },
                    ],
                    temperature: 0.3,
                    // 8000：給 think 型模型留足思考空間，300 會被 reasoning 吃光
                    max_tokens: 8000,
                    stream: false,
                }),
            },
            2, 120_000, { appName: '記憶宮殿', charName, purpose: '人格審視' }
        );

        const reply = data.choices?.[0]?.message?.content || '';
        const finishReason = data.choices?.[0]?.finish_reason;
        const usage = data.usage;
        console.log(`🎭 [PersonalityDetect] ${charName} LLM 原始返回 (finish=${finishReason}, usage=${JSON.stringify(usage || {})}):\n${reply}`);

        // 帶引號意識的大括號棧掃描：從 reply 裡提取所有頂層 {...} 候選
        // 老版本用 /\{[\s\S]*?\}/ 非貪婪匹配，遇到思考型模型 reasoning 裡的
        // "{迷茫,焦慮}" 之類 stray braces 會匹配錯對象，JSON.parse 恰好成功
        // 但 parsed.style / ruminationTendency 都是 undefined，然後被下面的
        // fallback 靜默吞成 emotional/0.3 —— 這就是"LLM 明明說了 0.6 結果還是 0.3"的根因
        const jsonCandidates: string[] = [];
        {
            let depth = 0;
            let start = -1;
            let inString = false;
            let escape = false;
            for (let i = 0; i < reply.length; i++) {
                const c = reply[i];
                if (inString) {
                    if (escape) { escape = false; continue; }
                    if (c === '\\') { escape = true; continue; }
                    if (c === '"') { inString = false; }
                    continue;
                }
                if (c === '"') { inString = true; continue; }
                if (c === '{') {
                    if (depth === 0) start = i;
                    depth++;
                } else if (c === '}') {
                    if (depth > 0) {
                        depth--;
                        if (depth === 0 && start !== -1) {
                            jsonCandidates.push(reply.slice(start, i + 1));
                            start = -1;
                        }
                    }
                }
            }
        }

        // 在候選裡挑第一個真正帶 style 或 ruminationTendency 字段的
        let parsed: any = null;
        let pickedCandidate: string | null = null;
        const parseErrors: string[] = [];
        for (const cand of jsonCandidates) {
            try {
                const p = JSON.parse(cand);
                if (p && typeof p === 'object' && ('style' in p || 'ruminationTendency' in p)) {
                    parsed = p;
                    pickedCandidate = cand;
                    break;
                }
            } catch (e: any) {
                parseErrors.push(e?.message || String(e));
            }
        }

        if (parsed) {
            console.log(`🎭 [PersonalityDetect] ${charName} 從 ${jsonCandidates.length} 個 JSON 候選中命中目標：${pickedCandidate}`);
        } else {
            console.warn(`🎭 [PersonalityDetect] ${charName} 在 ${jsonCandidates.length} 個 JSON 候選裡找不到含 style/ruminationTendency 的塊。候選：${JSON.stringify(jsonCandidates)}，解析錯誤：${JSON.stringify(parseErrors)}`);
            throw new Error(`性格檢測: 回覆裡找不到含 style/ruminationTendency 的 JSON${finishReason === 'length' ? '（疑似輸出被截斷 finish_reason=length）' : ''}`);
        }

        {
            const style = VALID_STYLES.includes(parsed.style) ? parsed.style : 'emotional';
            const rawRum = parseFloat(parsed.ruminationTendency);
            const ruminationTendency = isNaN(rawRum) ? 0.3 : Math.max(0, Math.min(1, Math.round(rawRum * 10) / 10));
            const reasoning = parsed.reasoning || '';

            const styleLabel = style === 'emotional' ? '情感型' : style === 'narrative' ? '敘事型' : style === 'imagery' ? '意象型' : '分析型';
            console.log(`🎭 [PersonalityDetect] ${charName} → ${styleLabel}，反芻傾向 ${ruminationTendency}（${reasoning}）`);

            // 寫入 self_room 作為角色自我認知的一部分
            const selfMemory: MemoryNode = {
                id: `mn_${Date.now()}_pstyle`,
                charId,
                content: `我審視了自己，認識到自己是${styleLabel}的思維方式，反芻傾向為 ${ruminationTendency}。${reasoning}`,
                room: 'self_room',
                tags: ['人格風格', '自我認知'],
                importance: 7,
                mood: 'peaceful',
                embedded: false,
                boxId: 'system_personality_detect',
                boxTopic: '人格風格自我認知',
                createdAt: Date.now(),
                lastAccessedAt: Date.now(),
                accessCount: 0,
                origin: 'system',
            };
            await MemoryNodeDB.save(selfMemory);

            return { style, ruminationTendency, reasoning };
        }
    } catch (err: any) {
        console.warn(`🎭 [PersonalityDetect] ${charName} LLM 調用失敗:`, err?.message || err, err?.stack || '');
        throw new Error(`性格檢測失敗: ${err?.message || err}`);
    }

    console.warn(`🎭 [PersonalityDetect] ${charName} LLM 未返回有效 JSON（回覆中找不到 {...} 片段）`);
    throw new Error('性格檢測: LLM 未返回有效 JSON');
}
