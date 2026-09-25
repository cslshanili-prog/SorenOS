import type { CharacterProfile, Message, TempChatLimits } from '../types';

/**
 * 臨時會話（路線圖第 4 項最後一批之二；設計見 plans/block-temp-chat-design.md）：
 * 拉黑期間雙方唯一的窄管道。每天各 N 次、每次最多 M 字（聊天設定可調，預設 3 次、50 字），
 * 次數按角色那邊的日期算。
 *
 * 訊息就存在一般的私聊訊息表裡，metadata.tempChat 標記；拉黑中私聊畫面把它們藏起來、只在臨時會話
 * 那頁顯示，解除後自然併回私聊（歷史裡標「臨時會話」）。
 */

/** 臨時會話多了一句（角色傳話、回話）：聊天頁的入口徽章、會話頁聽到就重讀。detail = { charId } */
export const TEMP_CHAT_CHANGED_EVENT = 'temp-chat-changed';

export const DEFAULT_TEMP_CHAT_LIMITS: TempChatLimits = { daily: 3, maxChars: 50 };
export const TEMP_CHAT_LIMIT_RANGES = {
    daily: { min: 1, max: 10 },
    maxChars: { min: 20, max: 200, step: 10 },
} as const;

export interface TempChatMeta {
    from: 'user' | 'char';
    /** 角色那邊的日期（YYYY-MM-DD），數今天用了幾次 */
    dayKey: string;
}

const clamp = (v: unknown, min: number, max: number, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;

export function normalizeTempChatLimits(raw: Partial<TempChatLimits> | undefined | null): TempChatLimits {
    return {
        daily: clamp(raw?.daily, TEMP_CHAT_LIMIT_RANGES.daily.min, TEMP_CHAT_LIMIT_RANGES.daily.max, DEFAULT_TEMP_CHAT_LIMITS.daily),
        maxChars: clamp(raw?.maxChars, TEMP_CHAT_LIMIT_RANGES.maxChars.min, TEMP_CHAT_LIMIT_RANGES.maxChars.max, DEFAULT_TEMP_CHAT_LIMITS.maxChars),
    };
}

export const tempChatMetaOf = (m: Pick<Message, 'metadata'>): TempChatMeta | null => {
    const meta = m.metadata?.tempChat;
    return meta && (meta.from === 'user' || meta.from === 'char') && typeof meta.dayKey === 'string' ? meta : null;
};

export const isTempChatMessage = (m: Pick<Message, 'metadata'>): boolean => !!tempChatMetaOf(m);

/** 這段拉黑期間的臨時會話（依時間排好）。 */
export function tempChatThread<T extends Pick<Message, 'metadata' | 'timestamp'>>(messages: T[], since: number): T[] {
    return messages.filter(m => isTempChatMessage(m) && m.timestamp >= since).sort((a, b) => a.timestamp - b.timestamp);
}

/** 某一方今天還剩幾次。 */
export function tempChatRemaining(
    messages: Array<Pick<Message, 'metadata'>>,
    from: 'user' | 'char',
    dayKey: string,
    limits: TempChatLimits,
): number {
    const used = messages.filter(m => {
        const meta = tempChatMetaOf(m);
        return meta?.from === from && meta.dayKey === dayKey;
    }).length;
    return Math.max(0, limits.daily - used);
}

/** 把一段文字截到上限（照「字」算，emoji 也算一個）。 */
export const clipToChars = (text: string, maxChars: number): string => Array.from(text.trim()).slice(0, maxChars).join('');
export const charCount = (text: string): number => Array.from(text).length;

/** 臨時會話在角色歷史裡的標記（解除後併回私聊時）。 */
export const TEMP_CHAT_HISTORY_PREFIX = '（臨時會話）';

// ── 角色被拉黑時自己傳話的節奏 ──────────────────────────────────────────

const HOUR = 3600_000;

/** 用戶剛拉黑角色：第一次試著傳話在 1–4 小時後。 */
export const firstTempAttemptAt = (since: number, random: () => number = Math.random) => since + Math.round((1 + 3 * random()) * HOUR);
/** 之後每次隔 3–8 小時（今天用完了就等到隔天，照樣用這個間隔，到點再數一次）。 */
export const nextTempAttemptAt = (now: number, random: () => number = Math.random) => now + Math.round((3 + 5 * random()) * HOUR);

// ── 提示詞 ────────────────────────────────────────────────────────────

type PromptChar = Pick<CharacterProfile, 'name' | 'chatBlock'>;

/**
 * 角色在臨時會話裡開口（或回話）的提示詞。
 * - 角色拉黑了用戶（by 'char'）：對方剛從臨時會話傳來一句，要不要回、要不要順便解除。
 * - 用戶拉黑了角色（by 'user'）：你的訊息都進不去，只有這條窄管道；想說就說，不想說留空。
 */
export function buildTempChatPrompt(params: {
    char: PromptChar;
    userName: string;
    /** 拉黑前最後幾句（已格式化） */
    before: string;
    /** 這段拉黑期間的臨時會話（已格式化，最後一句可能是對方剛傳的） */
    thread: string;
    /** 角色拉黑用戶時，對方在私聊裡送出、被拒收的訊息（已格式化） */
    rejected?: string;
    remaining: number;
    maxChars: number;
    /** 這次是回對方剛傳的那句 */
    replying: boolean;
}): string {
    const { char, userName, before, thread, rejected, remaining, maxChars, replying } = params;
    const name = userName.trim() || '對方';
    const block = char.chatBlock;
    const rules = `臨時會話是拉黑期間唯一的窄管道：雙方每天各只有幾次機會，每次最多 ${maxChars} 字。你今天還剩 ${remaining} 次（這次算一次）。挑最想說的講，一句話就好。`;
    const shared = `拉黑前你們最後說的話：
${before || '（沒有記錄）'}

臨時會話到目前為止：
${thread || '（還沒有人說話）'}`;
    if (block?.by === 'char') {
        return `你（${char.name}）把${name}拉黑了${block.reason ? `，因為：${block.reason}` : ''}。${name}現在透過「臨時會話」傳話給你。
${rules}

${shared}
${rejected ? `\n拉黑期間${name}在私聊裡傳了這些（被拒收了，你現在也看得到）：\n${rejected}\n` : ''}
照你的性格和你們的關係決定：要不要回這一句？要不要順便解除拉黑？不用勉強原諒，也不用一直記仇。
只輸出一個 JSON：{"message": "回${name}的話，${maxChars} 字以內；不想回就留空", "unblock": true 或 false}`;
    }
    return `${name}在手機上把你（${char.name}）拉黑了，你在私聊傳的訊息都進不去。唯一還通的是「臨時會話」。
${rules}

${shared}

${replying ? `${name}剛在臨時會話回了你一句。` : '你現在拿起手機，想透過臨時會話傳話給對方。'}照你的性格和你們的關係決定要說什麼——道歉、解釋、賭氣、想念都可以，也可以這次什麼都不說。
只輸出一個 JSON：{"message": "要傳的話，${maxChars} 字以內；不想說就留空"}`;
}

/** 解析角色的輸出；解析不出 JSON 時把整段當成要說的話（去掉引號）。 */
export function parseTempChatReply(raw: unknown, rawText: string, maxChars: number): { message: string; unblock: boolean } {
    const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
    if (obj) {
        const message = typeof obj.message === 'string' ? clipToChars(obj.message, maxChars) : '';
        return { message, unblock: obj.unblock === true || obj.unblock === 'true' };
    }
    const text = (rawText || '').trim();
    if (!text || text.startsWith('{')) return { message: '', unblock: false };
    return { message: clipToChars(text.replace(/^[「『"“]|[」』"”]$/g, ''), maxChars), unblock: false };
}
