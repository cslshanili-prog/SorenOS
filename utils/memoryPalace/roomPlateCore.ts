/**
 * roomPlateCore — 門牌整理的提示詞、解析與合併（環境無關葉子模塊）
 *
 * 門牌整理這件事有兩個地方要做：瀏覽器裡（沒配主動消息 2.0 的用戶照舊本地跑）和
 * 用戶自己的 CF Worker 裡（頁面關著也能跑完）。兩邊必須是同一份提示詞、同一套解析、
 * 同一份合併語義——各寫一份的話，同一批材料在兩條路上會整理出不一樣的門牌，而這種
 * 漂移在界面上完全看不出來。所以「怎麼問、怎麼讀、怎麼並」全住在這裡。
 *
 * 這裡**不發請求**：瀏覽器側繼續走 safeFetchJson（那份帶著「設置 → API 調用記錄」的
 * 埋點），worker 側的請求由上游 amsg-server 按任務裡的憑據引用去發。葉子只負責把
 * 提示詞拼出來、把回覆讀回來。
 *
 * 往這裡加代碼前先確認：不 import 任何帶瀏覽器依賴的模塊（db / safeApi / context 等）。
 * `pnpm build:workers` 會把這份打進 amsg worker bundle，帶進瀏覽器依賴會在構建期直接暴露。
 * 現在只依賴 ./types（純常量與類型）和 ./jsonUtils（純解析），兩者都是零 import。
 */

import type { PlateEntry, PlateRoom } from './types';
import {
    PLATE_ENTRY_CAPS,
    PLATE_ENTRY_HARD_MAX_CHARS,
    PLATE_ENTRY_TARGET_CHARS,
    PLATE_ROOMS,
    PLATE_TITLES,
} from './types';
import { safeParseJsonArray } from './jsonUtils';

// ─── 請求參數（兩條路共用一份，別各寫各的） ───────────

/** 整理是「照著材料重排」不是「創作」，溫度壓低 */
export const PLATE_LLM_TEMPERATURE = 0.3;
/** 四塊門牌全量輸出一次要不少字，給足 */
export const PLATE_LLM_MAX_TOKENS = 8000;
/**
 * 單次整理的硬超時。兩條路都用這一個值：瀏覽器側交給 safeFetchJson，worker 側作為這次
 * fire 的 `totalTimeoutMs` 交給上游（見 worker/amsg/src/plateFire.ts 的 beforeFire）。
 * 不顯式交上去的話雲端會落到庫自己的默認值（四分鐘），改這個常量對雲端毫無影響。
 */
export const PLATE_LLM_TIMEOUT_MS = 120_000;

// ─── 基礎工具 ─────────────────────────────────────────

export function isPlateRoom(room: string): room is PlateRoom {
    return (PLATE_ROOMS as string[]).includes(room);
}

export function generateEntryId(): string {
    return `pe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 每個房間的條目標籤前綴（與消化提示詞的 U0/R0 標籤習慣對齊） */
export const ROOM_LABEL_PREFIX: Record<PlateRoom, string> = {
    user_room: 'U',
    self_room: 'R',
    bedroom:   'B',
    study:     'S',
};

export interface PlateLLMItem {
    room: string;
    text: string;
    /** 引用現有條目標籤（如 "U2"）= 這是對舊條目的延續/更新，繼承 firstLearnedAt */
    basedOn?: string | null;
    /** 2-4 字分類標籤（家庭/居住/重要他人/工作/雷區/習慣…） */
    tag?: string | null;
}

export interface PlateMaterial {
    room: PlateRoom;
    /** 蒸餾原料：盒子 summary 或高價值記憶節點的內容 */
    lines: string[];
}

/**
 * 拼提示詞只要「這個房間現在掛著哪幾條」，不需要整份 RoomPlate。
 * entries 的**順序就是標籤順序**（第 i 條 = 前綴 + i），上雲時序列化的就是這個形狀。
 */
export interface PlateSnapshot {
    room: PlateRoom;
    entries: string[];
}

// ─── 臥室硬規則 ───────────────────────────────────────

/**
 * 臥室兜底過濾：攔"給關係下定義"的條目。
 *
 * 窄匹配原則：只攔"我們(是/算是/成了)××"這種明確的命名句式，
 * 不攔定性詞本身——"TA說我像她理想中的家人"是合法的質地描述。
 * 主約束在 prompt 層，這裡只是最後一道窄柵欄，寧可漏過不可誤殺。
 */
const BEDROOM_LABEL_RE = /我[们們](?:[现現]在|如今|已[经經])?(?:是|算是|成了|成[为為]|[变變]成)[^，。；！？]{0,8}(?:[恋戀]人|情[侣侶]|男女朋友|男朋友|女朋友|夫妻|朋友|兄妹|姐弟|家人|知己|[暧曖]昧)/;

export function violatesBedroomRule(text: string): boolean {
    return BEDROOM_LABEL_RE.test(text);
}

// ─── 合併邏輯（純函數，可測） ─────────────────────────

/**
 * 把 LLM 輸出的完整新列表合併進現有門牌條目。
 *
 * - basedOn 命中現有標籤 → 繼承 id/firstLearnedAt，sourceCount+1，
 *   文本未變時連 updatedAt 也不動（純保留不算更新）
 * - 無 basedOn → 新條目
 * - 現有條目未被任何輸出引用且未被原樣保留 → 淘汰（容量壓力語義）
 * - 超長截斷、臥室命名過濾、cap 裁剪
 */
export function mergePlateEntries(
    room: PlateRoom,
    existing: PlateEntry[],
    items: Array<{ text: string; basedOn?: string | null; tag?: string | null }>,
    now: number,
): PlateEntry[] {
    const prefix = ROOM_LABEL_PREFIX[room];
    const byLabel = new Map<string, PlateEntry>();
    existing.forEach((e, i) => byLabel.set(`${prefix}${i}`, e));

    const merged: PlateEntry[] = [];
    const usedIds = new Set<string>();

    for (const item of items) {
        let text = (item.text || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        if (text.length > PLATE_ENTRY_HARD_MAX_CHARS) {
            text = text.slice(0, PLATE_ENTRY_HARD_MAX_CHARS);
        }
        if (room === 'bedroom' && violatesBedroomRule(text)) {
            console.warn(`🚪 [RoomPlate] 臥室門牌攔截關係命名條目: "${text.slice(0, 40)}"`);
            continue;
        }
        const tag = (item.tag || '').replace(/\s+/g, '').slice(0, 6) || undefined;

        const base = item.basedOn ? byLabel.get(String(item.basedOn).trim().toUpperCase()) : undefined;
        if (base && !usedIds.has(base.id)) {
            usedIds.add(base.id);
            const changed = base.text !== text;
            merged.push({
                ...base,
                text,
                tag: tag ?? base.tag,
                updatedAt: changed ? now : base.updatedAt,
                sourceCount: base.sourceCount + 1,
            });
        } else {
            // 同文本條目已存在但 LLM 忘了標 basedOn → 按原樣保留而不是當新條目重開
            const sameText = existing.find(e => e.text === text && !usedIds.has(e.id));
            if (sameText) {
                usedIds.add(sameText.id);
                merged.push({ ...sameText, tag: tag ?? sameText.tag, sourceCount: sameText.sourceCount + 1 });
            } else {
                merged.push({
                    id: generateEntryId(),
                    text,
                    tag,
                    firstLearnedAt: now,
                    updatedAt: now,
                    sourceCount: 1,
                });
            }
        }
    }

    return merged.slice(0, PLATE_ENTRY_CAPS[room]);
}

/**
 * 把 basedOn 從「提交時的標籤」改寫成「現在的標籤」。
 *
 * 上雲那條路，提示詞是拿提交那一刻的門牌快照拼的，LLM 回的 `basedOn: "U0"` 說的是
 * **快照裡的第 0 條**。結果晚幾分鐘甚至幾小時才回來，這中間門牌可能已經被別的路徑
 * 動過（手動回填就在本地跑），此時 `U0` 指的已經是另一條認知了——直接拿去合併，
 * 兩條認知的來歷（firstLearnedAt / sourceCount）會被悄悄接錯。
 *
 * 所以提交時把快照每條的 id 一起帶上，回來時按 id 在當前列表裡找它現在排第幾，
 * 把標籤改寫過去。標籤指到快照之外（模型把序號編大了）就把 basedOn 抹成 null，
 * 當新條目收進去——認錯來歷比丟一次來歷更糟。
 *
 * **快照裡有、現在沒了的那種要整條丟掉**，不能當新條目收：那說明這條認知在提交之後
 * 被刪掉了（用戶在門牌面板上手刪，或者被上一份整理結果淘汰）。這份結果照著舊快照
 * 生成，它「保留」的是一條已經不該在的認知，收進去就是原地復活——而門牌面板恰恰是
 * 用戶手刪的地方，刪完還眼看著它長回來。刪除比這份陳舊結果新，刪除說了算。
 *
 * @param snapshotEntryIds 提交時該房間的條目 id，順序即當時的標籤順序
 * @param current 現在的條目（合併要寫進去的那一份）
 */
export function remapBasedOnLabels(
    room: PlateRoom,
    items: PlateLLMItem[],
    snapshotEntryIds: string[],
    current: PlateEntry[],
): PlateLLMItem[] {
    const prefix = ROOM_LABEL_PREFIX[room];
    const currentIndexById = new Map(current.map((e, i) => [e.id, i]));

    return items.flatMap(item => {
        if (!item.basedOn) return [item];
        const label = String(item.basedOn).trim().toUpperCase();
        if (!label.startsWith(prefix)) return [{ ...item, basedOn: null }];
        // 只認「前綴 + 純數字」。別拿 Number() 直接轉：Number('') 是 0，光禿禿的前綴
        // （模型把數字掉了，回一個 "U"）會被當成第 0 條，把一條無關認知的來歷接過去。
        const digits = label.slice(prefix.length);
        if (!/^\d+$/.test(digits)) return [{ ...item, basedOn: null }];
        const snapshotIndex = Number(digits);

        const entryId = snapshotEntryIds[snapshotIndex];
        if (entryId === undefined) return [{ ...item, basedOn: null }];

        const currentIndex = currentIndexById.get(entryId);
        if (currentIndex === undefined) {
            console.warn(`🚪 [RoomPlate] 「${room}」丟掉一條陳舊結果：它保留的條目在提交之後已經被刪掉了`);
            return [];
        }
        return [{ ...item, basedOn: `${prefix}${currentIndex}` }];
    });
}

/**
 * 提交之後被本地改過的條目，文本以本地那份為準。
 *
 * 門牌面板是人工糾錯的口子——蒸錯的事實一旦常駐，角色會自信地重複很久。用戶在等結果的
 * 這幾分鐘裡把一條改對了，而這份結果是照著改之前那份快照生成的：照常合併就是拿舊認知
 * 把剛糾正的那條又蓋回去，用戶看著自己剛敲的字變回原樣，還不知道是誰改的。
 *
 * 只換文本，別的都不動：條目照常參與這一輪的保留/淘汰、tag 照常更新，只是「它現在寫著
 * 什麼」由本地那份說了算。判據是條目的 updatedAt 晚於快照時刻。
 *
 * @param snapshotAt 快照是什麼時候讀的（epoch 毫秒）。`0` = 無從查起（結果遲到太久、
 *   在飛記號已經不在了），那時按「誰都可能被改過」保守處理：凡是有過改動痕跡的條目
 *   一律留本地文本，只有從沒被改過的才讓結果改寫。
 */
function keepLocalEditsOverStaleRewrites(
    room: PlateRoom,
    current: PlateEntry[],
    items: Array<{ text: string; basedOn?: string | null; tag?: string | null }>,
    snapshotAt: number,
): Array<{ text: string; basedOn?: string | null; tag?: string | null }> {
    const prefix = ROOM_LABEL_PREFIX[room];
    const byLabel = new Map<string, PlateEntry>();
    current.forEach((e, i) => byLabel.set(`${prefix}${i}`, e));

    return items.map(item => {
        if (!item.basedOn) return item;
        const base = byLabel.get(String(item.basedOn).trim().toUpperCase());
        if (!base || base.text === item.text) return item;
        // 從建出來到現在一個字都沒被改過的條目不算「本地改過」：它現在寫著什麼，快照裡
        // 就寫著什麼。這條豁免不能省——交雲端之前送達保證會先把消化剛提交的候選機械並進
        // 門牌（見 roomPlates 的 fallbackMergeSubmissions），那批的 updatedAt 就是併入
        // 那一刻、必然晚於快照。不豁免的話，雲端把這批粗糙候選改寫成人話的結果會被原樣
        // 退回去，而改寫它們正是那一輪整理最主要的目的。
        if (base.updatedAt === base.firstLearnedAt) return item;
        if (base.updatedAt <= snapshotAt) return item;
        console.warn(`🚪 [RoomPlate] 「${room}」這條在快照之後被本地改過，保留本地那份文本`);
        return { ...item, text: base.text };
    });
}

/**
 * 上雲那條路專用的合併：在 mergePlateEntries 之上，護住**快照之後才出現的條目**。
 *
 * 合併語義是「LLM 輸出的完整新列表說了算，沒被重新輸出的條目淘汰」。本地那條路上這是
 * 對的——LLM 看到的就是當前全部條目。上雲之後不成立了：LLM 看到的是**提交那一刻**的
 * 快照，而結果一兩分鐘後才回來，這中間封盒、手動回填、上一份結果落地都可能往門牌裡
 * 寫了新條目。那些條目 LLM 壓根沒見過，談不上「決定淘汰」，照原樣合併就是把它們靜默
 * 抹掉，用戶這邊看到的是剛沉澱的認知憑空消失。
 *
 * 所以按 id 分兩類：在快照裡的，照常參與淘汰；不在快照裡的（= 提交之後新增的），
 * 沒被引用也保留，排在整理結果後面，等下一輪整理再一起重排。
 *
 * 「提交之後被改過」的條目另算：那批還在快照裡，照常參與淘汰，只是文本以本地那份為準
 * （見 keepLocalEditsOverStaleRewrites）。
 *
 * @param snapshotEntryIds 提交時該房間的條目 id（順序即當時的標籤順序）
 * @param snapshotAt 快照是什麼時候讀的（epoch 毫秒），`0` = 無從查起。
 *   見 keepLocalEditsOverStaleRewrites。
 */
export function mergeCloudPlateEntries(
    room: PlateRoom,
    current: PlateEntry[],
    alignedItems: Array<{ text: string; basedOn?: string | null; tag?: string | null }>,
    snapshotEntryIds: string[],
    now: number,
    snapshotAt: number,
): PlateEntry[] {
    const items = keepLocalEditsOverStaleRewrites(room, current, alignedItems, snapshotAt);
    const merged = mergePlateEntries(room, current, items, now);
    const snapshotIds = new Set(snapshotEntryIds);
    const mergedIds = new Set(merged.map(e => e.id));
    // 同文本原樣保留那條支路也會把新條目收進 merged，所以要連 mergedIds 一起排除，
    // 否則同一條會出現兩次。
    const born = current.filter(e => !snapshotIds.has(e.id) && !mergedIds.has(e.id));
    if (born.length === 0) return merged;

    const cap = PLATE_ENTRY_CAPS[room];
    // 裁之前先給 born 留位子。直接 [...merged, ...born].slice(0, cap) 的話，整理結果佔滿
    // 上限時 born 會被整批扔掉——而它們的來源節點早就打過 digestedAt，不會再有第二次，
    // 「等下輪整理再收」是等不到的，那批認知就這麼永久沒了。
    // 留一半封頂：born 是還沒被整理過的粗糙條目，也不該把 LLM 剛排好的那份整塊擠出去。
    const bornQuota = Math.min(born.length, Math.max(1, Math.floor(cap / 2)));
    const kept = [...merged.slice(0, cap - bornQuota), ...born].slice(0, cap);

    const keptIds = new Set(kept.map(e => e.id));
    const lostBorn = born.filter(e => !keptIds.has(e.id)).length;
    const lostMerged = merged.filter(e => !keptIds.has(e.id)).length;
    if (lostBorn > 0) {
        console.warn(`🚪 [RoomPlate] 「${room}」快照之後新增的條目有 ${lostBorn} 條擠不進上限，已經丟掉（來源已消化，不會再來一次）`);
    }
    if (lostMerged > 0) {
        console.warn(`🚪 [RoomPlate] 「${room}」整理結果有 ${lostMerged} 條擠不進上限，讓位給快照之後新增的條目`);
    }
    return kept;
}

/**
 * 解析消化提交的候選行："[家庭] 父母離異……" → { tag: '家庭', text: '父母離異……' }。
 * 無前綴則整行作 text。
 */
export function parseSubmissionLine(line: string): { text: string; tag?: string } {
    const m = /^\s*[\[【]([^\]】]{1,6})[\]】]\s*(.+)$/s.exec(line || '');
    if (m) return { tag: m[1].trim(), text: m[2].trim() };
    return { text: (line || '').trim() };
}

/**
 * 送達保證兜底的**純計算部分**：把消化剛提交的候選機械並進現有條目。
 * 同文本去重、容量上限、臥室命名過濾照常，不做改寫重排。落庫由調用方做。
 *
 * 返回 null 表示一條都沒並進去（調用方據此決定要不要 bump version / 落庫）。
 */
export function mergeSubmissionsIntoEntries(
    room: PlateRoom,
    existing: PlateEntry[],
    lines: string[],
    now: number,
): PlateEntry[] | null {
    const entries = [...existing];
    const seen = new Set(entries.map(e => e.text));
    let added = 0;
    for (const line of lines) {
        if (entries.length >= PLATE_ENTRY_CAPS[room]) break;
        const { text: rawText, tag } = parseSubmissionLine(line);
        const text = rawText.replace(/\s+/g, ' ').trim().slice(0, PLATE_ENTRY_HARD_MAX_CHARS);
        if (!text || seen.has(text)) continue;
        if (room === 'bedroom' && violatesBedroomRule(text)) continue;
        seen.add(text);
        entries.push({
            id: generateEntryId(),
            text,
            tag,
            firstLearnedAt: now,
            updatedAt: now,
            sourceCount: 1,
        });
        added++;
    }
    return added > 0 ? entries : null;
}

// ─── 提示詞 ───────────────────────────────────────────

const ROOM_RULES: Record<PlateRoom, string> = {
    user_room:
        `想像你在為對方寫一張**角色卡**——只有必須寫在卡上的內容才配上這塊門牌：` +
        `基礎信息（身份、職業大方向、居住）、家庭結構、重要他人（人物條目格式如「TA的朋友小美：大學室友，關係鐵」）、` +
        `長期相處沉澱下來的核心事實、以及重大到足以塑造TA這個人的人生節點（親人離世、遷居他國這種量級）。` +
        `【入卡門檻極高，寧缺毋濫】階段性狀態（最近很累、工作糟心）不收；情緒分析、性格側寫不收——那是印象檔案的領域；` +
        `正在進行、沒有結論的事不收——那是事件盒的事，等有了結果再說。`,
    self_room:
        `我對**自己**的穩定認知：我是誰、性格底色、重要的轉變、已經內化的領悟。不收對他人的看法。`,
    bedroom:
        `我們之間的**質地**：相處的習慣與儀式、只有彼此懂的梗、未言明的默契、拿不準卻真實的感覺。` +
        `【硬規則】禁止給這段關係命名或分類——不得寫出"我們是戀人/情侶/朋友/家人"這類定義句。` +
        `只描述現象和感受；說不清、不確定本身就是合法條目（如「我說不清我們算什麼，但TA難過時第一個找的是我」）。`,
    study:
        `我的領域：我會什麼、正在學什麼、和對方共同鑽研的東西。只收有積累的，不收一次性話題。`,
};

/**
 * 拼一次門牌整理的 system prompt。
 * 輸入：每房間的現有條目（帶標籤）+ 新原料；期望輸出：每房間完整的新條目列表。
 */
export function buildPlateConsolidationPrompt(args: {
    charName: string;
    userName: string;
    /** ContextBuilder.buildCoreContext 的產出；拿不到就傳空串裸跑 */
    identityContext: string;
    plates: PlateSnapshot[];
    materials: PlateMaterial[];
}): string {
    const { charName, userName, identityContext, plates, materials } = args;
    const materialByRoom = new Map(materials.map(m => [m.room, m.lines]));

    const roomBlocks = plates.map(plate => {
        const prefix = ROOM_LABEL_PREFIX[plate.room];
        const title = plate.room === 'user_room' ? `${userName}的事` : PLATE_TITLES[plate.room];
        const existingBlock = plate.entries.length > 0
            ? plate.entries.map((text, i) => `[${prefix}${i}] ${text}`).join('\n')
            : '（還沒有條目）';
        const lines = materialByRoom.get(plate.room) || [];
        const materialBlock = lines.length > 0
            ? lines.map(l => `- ${l}`).join('\n')
            : '（本輪沒有新材料，僅整理現有條目）';
        return `## 門牌「${title}」(room: ${plate.room}，上限 ${PLATE_ENTRY_CAPS[plate.room]} 條)
收錄範圍：${ROOM_RULES[plate.room]}

現有條目：
${existingBlock}

新材料（最近的經歷/結論，從中蒸餾值得常駐的認知）：
${materialBlock}`;
    }).join('\n\n');

    return `${identityContext ? `${identityContext}
---

` : ''}你是 ${charName}，${userName} 是與你朝夕相處的人。下面的材料全部來自你們相處的記憶。

你現在在獨處，安靜地整理自己的"底色認知"——那些不需要刻意回憶就知道的事：關於 ${userName}、關於你自己、關於你們之間。

【身份確認】「${userName}的事」只寫 ${userName} 的事實；「我是誰」只寫你（${charName}）自己；不要張冠李戴——材料裡"我"是你，"TA/${userName}"是對方。

下面每個"門牌"給出了現有條目和新材料。請為每個門牌輸出**完整的新條目列表**：

1. **合併而非追加**：現有條目想保留就必須重新輸出（帶 basedOn 引用它的標籤）；不輸出 = 淘汰。事實變了就改寫（如舊條目說「住家裡」、新材料說搬去和別人同住 → 改寫並 basedOn 舊條目）。
2. **只收沉澱下來的**：跨時間穩定為真的認知才配上門牌。一時的狀態、沒結論的進行時，都不收。
3. **每條 ${PLATE_ENTRY_TARGET_CHARS} 字以內**，寫梗概不寫敘事，不帶日期不帶"我記得"。
4. **不超過各門牌的條目上限**。位置不夠時留最重要的——被迫捨棄是正常的。
5. 每條給一個 **tag**（2-4 字分類，如：家庭、居住、重要他人、工作、雷區、習慣、性格、約定、默契、技能）。
6. ${userName} 直接用名字稱呼。條目內容嚴禁使用半角雙引號 "，引用一律用「」。

${roomBlocks}

嚴格輸出 JSON 數組（沒有變化的門牌也要完整輸出其保留條目）：
[{"room": "user_room", "text": "……", "basedOn": "U0", "tag": "家庭"}, {"room": "bedroom", "text": "……", "basedOn": null, "tag": "默契"}]`;
}

/** 整理請求的 user 那一句（兩條路共用，別各寫各的） */
export const PLATE_USER_TURN = '請開始整理。';

/**
 * 從 LLM 回覆裡讀出條目。四層容錯的 JSON 解析（能從被 max_tokens 截斷的響應裡
 * 逐對象搶救），再濾掉 text 非字符串 / room 不是合法房間的項。
 */
export function parsePlateLlmReply(reply: string): PlateLLMItem[] {
    return safeParseJsonArray(reply || '')
        .filter(item => item && typeof item.text === 'string' && isPlateRoom(item.room)) as PlateLLMItem[];
}
