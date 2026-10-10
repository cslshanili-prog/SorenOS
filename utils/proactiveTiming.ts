/**
 * 主動消息（1.0，本地計時那條）的時間彈性與閃電「讓 TA 主動說一句」（2026-10-08）。
 *
 * 以前是死板的固定間隔：從上一次觸發起算，到點就發，不管你們剛聊完沒有。現在：
 * - 間隔可以是範圍（最短～最長），每次觸發後在範圍裡隨機抽下一次的時間；
 * - 「從最後一次聊天起算」（預設開）：到點時如果你們最近才聊過（不到最短間隔），
 *   這次先不發，改成從最後一則訊息起再抽一次；
 * - 閃電在最後一則是角色自己說的時候，改成「主動再說一句」，提示詞告訴角色對方還沒回。
 * 計時本身在 utils/proactiveChat.ts，這裡只放能單測的純邏輯。
 */

const MINUTE = 60_000;

/**
 * 設置頁雙頭拉桿的刻度（2026-10-10，取代上游那排固定格子）：前密後疏，
 * 短的間隔能細調、長的也拉得到底。15 分鐘起跳——每次主動消息都是一次 API 請求。
 *   15 分～1 小時每 5 分、1～3 小時每 15 分、3～8 小時每 30 分、8～24 小時每 1 小時。
 * 舊設定（30／60／120…1440）都落在刻度上，不用搬。
 */
export const PROACTIVE_INTERVAL_STOPS: number[] = (() => {
    const out: number[] = [];
    for (let m = 15; m <= 60; m += 5) out.push(m);
    for (let m = 75; m <= 180; m += 15) out.push(m);
    for (let m = 210; m <= 480; m += 30) out.push(m);
    for (let m = 540; m <= 1440; m += 60) out.push(m);
    return out;
})();
export const PROACTIVE_MIN_MINUTES = PROACTIVE_INTERVAL_STOPS[0];
export const PROACTIVE_MAX_MINUTES = PROACTIVE_INTERVAL_STOPS[PROACTIVE_INTERVAL_STOPS.length - 1];

/** 最接近的刻度序號（導入的備份、老版本寫進去的任意整數都收斂到刻度上）。 */
export function proactiveStopIndex(minutes: number): number {
    if (!Number.isFinite(minutes)) return PROACTIVE_INTERVAL_STOPS.indexOf(60);
    let best = 0;
    for (let i = 1; i < PROACTIVE_INTERVAL_STOPS.length; i++) {
        if (Math.abs(PROACTIVE_INTERVAL_STOPS[i] - minutes) < Math.abs(PROACTIVE_INTERVAL_STOPS[best] - minutes)) best = i;
    }
    return best;
}

/** 最短、最長都收斂到刻度上；最長不得小於最短，沒給就是固定間隔。 */
export function normalizeProactiveRange(minMinutes: number, maxMinutes?: number): { minMinutes: number; maxMinutes: number } {
    const min = PROACTIVE_INTERVAL_STOPS[proactiveStopIndex(Number.isFinite(minMinutes) ? minMinutes : 60)];
    const max = typeof maxMinutes === 'number' && Number.isFinite(maxMinutes)
        ? Math.max(min, PROACTIVE_INTERVAL_STOPS[proactiveStopIndex(maxMinutes)])
        : min;
    return { minMinutes: min, maxMinutes: max };
}

/** 在 [minMs, maxMs] 裡隨機抽一個延遲，取整到分鐘；固定間隔時就是 minMs。 */
export function rollProactiveDelayMs(minMs: number, maxMs: number | undefined, rand: () => number = Math.random): number {
    const max = typeof maxMs === 'number' && maxMs > minMs ? maxMs : minMs;
    if (max === minMs) return minMs;
    const spanMinutes = Math.floor((max - minMs) / MINUTE);
    return minMs + Math.min(spanMinutes, Math.floor(rand() * (spanMinutes + 1))) * MINUTE;
}

/**
 * 「從最後一次聊天起算」：最後一則真實訊息離現在還不到最短間隔，就回傳延後到的時刻
 * （最後一則訊息＋重新抽的間隔，一定晚於現在）；夠久了或沒有聊天記錄就是 null，照常發。
 */
export function followChatDeferral(
    lastActivityAt: number | undefined,
    now: number,
    minMs: number,
    maxMs?: number,
    rand: () => number = Math.random,
): number | null {
    if (!lastActivityAt || lastActivityAt > now) return null;
    if (now - lastActivityAt >= minMs) return null;
    return lastActivityAt + rollProactiveDelayMs(minMs, maxMs, rand);
}

/** 整點或半點的小時數（2、1.5）；不是的話 null。 */
const plainHours = (minutes: number): string | null =>
    minutes >= 60 && minutes % 30 === 0 ? String(minutes / 60) : null;

const oneDuration = (m: number): string => {
    if (m < 60) return `${m} 分鐘`;
    const h = plainHours(m);
    return h ? `${h} 小時` : `${Math.floor(m / 60)} 小時 ${m % 60} 分`;
};

/** 「30 分鐘」「2 小時」「1～3 小時」「45 分鐘～2 小時」「1 小時 15 分～3 小時」 */
export function formatProactiveRange(minMinutes: number, maxMinutes?: number): string {
    if (!maxMinutes || maxMinutes <= minMinutes) return oneDuration(minMinutes);
    const a = plainHours(minMinutes);
    const b = plainHours(maxMinutes);
    if (a && b) return `${a}～${b} 小時`;
    return `${oneDuration(minMinutes)}～${oneDuration(maxMinutes)}`;
}

/** 「12分鐘」「3小時5分鐘」「2天4小時」，跟主動消息原本的寫法一致。 */
export function formatGapZh(ms: number): string {
    const gapMin = Math.max(0, Math.floor(ms / MINUTE));
    if (gapMin < 60) return `${gapMin}分鐘`;
    if (gapMin < 1440) return `${Math.floor(gapMin / 60)}小時${gapMin % 60 > 0 ? `${gapMin % 60}分鐘` : ''}`;
    return `${Math.floor(gapMin / 1440)}天${Math.floor((gapMin % 1440) / 60)}小時`;
}

/** 角色剛說完多久以內，閃電算「追一句」；再久就是「主動找對方」。 */
export const NUDGE_FOLLOW_UP_WINDOW_MS = 60 * MINUTE;

export interface ManualNudgeInput {
    userName: string;
    /** 角色那邊「現在是」的字串 */
    timeStr: string;
    now: number;
    /** 最後一則真實訊息（角色自己說的）的時間；完全沒聊過是 undefined */
    lastCharMessageAt?: number;
    /** 用戶最後一次說話的時間 */
    lastUserMessageAt?: number;
}

/**
 * 閃電在「最後一則是角色自己說的」時塞的隱藏提示（metadata.proactiveHint，用戶看不到）。
 * 不寫的話模型只看到對話停在自己身上，常常把用戶上一句再回一遍、或換個說法重複自己。
 */
export function buildManualNudgeHint(input: ManualNudgeInput): string {
    const { userName, timeStr, now, lastCharMessageAt, lastUserMessageAt } = input;
    const head = `[系統提示（非${userName}發言）: 現在是 ${timeStr}。`;
    const noRepeat = '不要重複、也不要換個說法重講你剛才已經說過的話。一兩句話就好。]';
    if (!lastCharMessageAt) {
        return `${head}你們還沒怎麼聊過，你想主動傳訊息給${userName}。像真人一樣自然地開個頭，看你的性格決定怎麼打招呼、聊什麼。一兩句話就好。]`;
    }
    const sinceChar = now - lastCharMessageAt;
    if (sinceChar < NUDGE_FOLLOW_UP_WINDOW_MS) {
        return `${head}你上一則訊息是 ${formatGapZh(sinceChar)}前傳的，${userName}還沒回。你想再傳一句：可以追問、補上剛才沒說完的、分享突然想到的事，或者換個話題；要不要在意對方沒回、語氣怎麼拿捏，看你的性格和你們當下的狀況。${noRepeat}`;
    }
    const sinceUser = lastUserMessageAt && lastUserMessageAt <= now ? now - lastUserMessageAt : undefined;
    return `${head}${sinceUser !== undefined ? `${userName}已經 ${formatGapZh(sinceUser)}沒有找你說話了，` : ''}你上一則訊息之後${userName}也沒回。你想主動找${userName}：可以分享剛發生的事、隨手拍到的東西、突然想到的話題，或者單純好奇${userName}在幹嘛。不要刻意，不要像在彙報近況。${noRepeat}`;
}

interface NudgeMessage {
    role: string;
    timestamp: number;
    metadata?: { hidden?: boolean; proactiveHint?: boolean } | null;
}

/**
 * 閃電該照常回覆，還是讓角色主動說一句：看最後一則真實的用戶／角色訊息是誰說的
 * （系統卡片、隱藏提示不算）。是用戶說的就照常回；是角色自己、或根本還沒聊過，就是 nudge。
 */
export function resolveManualTriggerMode(messages: NudgeMessage[]): {
    mode: 'reply' | 'nudge';
    lastCharMessageAt?: number;
    lastUserMessageAt?: number;
} {
    let lastUserMessageAt: number | undefined;
    let lastCharMessageAt: number | undefined;
    let lastRole: string | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.metadata?.hidden || m.metadata?.proactiveHint) continue;
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        if (!lastRole) lastRole = m.role;
        if (m.role === 'user' && lastUserMessageAt === undefined) lastUserMessageAt = m.timestamp;
        if (m.role === 'assistant' && lastCharMessageAt === undefined) lastCharMessageAt = m.timestamp;
        if (lastUserMessageAt !== undefined && lastCharMessageAt !== undefined) break;
    }
    return { mode: lastRole === 'user' ? 'reply' : 'nudge', lastCharMessageAt, lastUserMessageAt };
}
