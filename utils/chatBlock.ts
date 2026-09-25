import type { CharBlockCooldown, CharacterProfile, ChatBlockPeriod, ChatBlockState, Message } from '../types';

/**
 * 私聊雙向拉黑的純邏輯（路線圖第 4 項最後一批；設計見 plans/block-temp-chat-design.md）。
 *
 * - 用戶拉黑角色：角色什麼都不生成（主動訊息、延遲回覆、自動回覆、雲端都擋），輸入框鎖住。
 * - 角色拉黑用戶：角色寫 [[ACTION:BLOCK_USER|原因]]（聊天設定開了「允許角色拉黑你」才生效）；
 *   之後用戶的訊息照送但被拒收（紅色驚嘆號、不送模型），冷靜期到了角色自己想一次要不要解除。
 *
 * 「哪則訊息被拒收」不另外存：用戶訊息的時間落在某一段「角色拉黑你」期間就是。
 */

export const CHAT_BLOCK_LOG_MAX = 20;
/** 角色拉黑用戶／解除時由後處理、背景判斷發出，OSContext 聽到後寫回角色。 */
export const CHAT_BLOCK_CHANGE_EVENT = 'chat-block-change';
export interface ChatBlockChangeDetail {
    charId: string;
    action: 'charBlock';
    reason: string;
}

const HOUR = 3600_000;
export const CHAR_BLOCK_RETRY_MS = 24 * HOUR;
export const CHAR_BLOCK_REASON_MAX = 60;

export const CHAR_BLOCK_COOLDOWNS: Record<CharBlockCooldown, { label: string; minHours: number; maxHours: number }> = {
    short: { label: '消氣快', minHours: 3, maxHours: 12 },
    normal: { label: '一般', minHours: 12, maxHours: 48 },
    long: { label: '記仇', minHours: 48, maxHours: 120 },
};

type BlockHolder = Pick<CharacterProfile, 'chatBlock'>;

export const isUserBlockingChar = (char: BlockHolder | undefined | null): boolean => char?.chatBlock?.by === 'user';
export const isCharBlockingUser = (char: BlockHolder | undefined | null): boolean => char?.chatBlock?.by === 'char';
export const isChatBlocked = (char: BlockHolder | undefined | null): boolean => !!char?.chatBlock;

/** 冷靜期：第一次考慮解除的時刻，在所選那一檔的範圍裡隨機。 */
export function firstReconsiderAt(now: number, cooldown: CharBlockCooldown | undefined, random: () => number = Math.random): number {
    const { minHours, maxHours } = CHAR_BLOCK_COOLDOWNS[cooldown || 'normal'] || CHAR_BLOCK_COOLDOWNS.normal;
    return now + Math.round((minHours + (maxHours - minHours) * random()) * HOUR);
}

/** 開始拉黑：回傳要寫回角色的欄位。已經在拉黑中就不動（先拉黑的那一方算數）。 */
export function startChatBlock(
    char: Pick<CharacterProfile, 'chatBlock' | 'charBlockCooldown'>,
    by: 'user' | 'char',
    now: number,
    opts: { reason?: string; random?: () => number } = {},
): Pick<CharacterProfile, 'chatBlock'> | null {
    if (char.chatBlock) return null;
    const state: ChatBlockState = { by, since: now };
    if (by === 'char') {
        const reason = (opts.reason || '').trim().slice(0, CHAR_BLOCK_REASON_MAX);
        if (reason) state.reason = reason;
        state.reconsiderAt = firstReconsiderAt(now, char.charBlockCooldown, opts.random);
    }
    return { chatBlock: state };
}

/** 解除：把這一段收進記錄（最多留 CHAT_BLOCK_LOG_MAX 段）。 */
export function endChatBlock(
    char: Pick<CharacterProfile, 'chatBlock' | 'chatBlockLog'>,
    now: number,
): Pick<CharacterProfile, 'chatBlock' | 'chatBlockLog'> | null {
    const current = char.chatBlock;
    if (!current) return null;
    const period: ChatBlockPeriod = { by: current.by, since: current.since, until: now };
    if (current.reason) period.reason = current.reason;
    const log = [...(char.chatBlockLog || []), period].slice(-CHAT_BLOCK_LOG_MAX);
    return { chatBlock: undefined, chatBlockLog: log };
}

/** 這次判斷沒解除：24 小時後再想一次。 */
export const postponeReconsider = (state: ChatBlockState, now: number): ChatBlockState => ({ ...state, reconsiderAt: now + CHAR_BLOCK_RETRY_MS });

export const isReconsiderDue = (char: BlockHolder, now: number): boolean =>
    isCharBlockingUser(char) && typeof char.chatBlock?.reconsiderAt === 'number' && char.chatBlock.reconsiderAt <= now;

/** 所有「角色拉黑用戶」的時段（含正在進行的那段，until = Infinity）。 */
export function charBlockPeriods(char: Pick<CharacterProfile, 'chatBlock' | 'chatBlockLog'>): Array<{ since: number; until: number }> {
    const periods = (char.chatBlockLog || []).filter(p => p.by === 'char').map(p => ({ since: p.since, until: p.until }));
    if (char.chatBlock?.by === 'char') periods.push({ since: char.chatBlock.since, until: Infinity });
    return periods;
}

/** 這則訊息是不是被拒收的：用戶自己發的、時間落在角色拉黑用戶的期間裡。 */
export function isRejectedByBlock(
    msg: Pick<Message, 'role' | 'timestamp' | 'metadata'>,
    periods: Array<{ since: number; until: number }>,
): boolean {
    if (msg.role !== 'user' || periods.length === 0) return false;
    if (msg.metadata?.hidden || msg.metadata?.proactiveHint) return false;
    return periods.some(p => msg.timestamp >= p.since && msg.timestamp < p.until);
}

// ── 動作標籤 ──────────────────────────────────────────────────────────────

const BLOCK_TAG_RE = /\[\[\s*ACTION\s*[:：]\s*(BLOCK_USER|BLOCK|拉黑|拉黑你|拉黑對方|拉黑对方|封鎖|封锁)\s*((?:[|｜][^\]\n]*)?)\]\]/gi;

/** 剝掉所有拉黑標籤；有多個時以第一個為準。 */
export function extractBlockUser(text: string): { cleanedText: string; block: { reason: string } | null } {
    let block: { reason: string } | null = null;
    let matched = false;
    const stripped = text.replace(BLOCK_TAG_RE, (_m, _name: string, rest: string) => {
        matched = true;
        if (!block) {
            const reason = (rest || '').split(/[|｜]/).slice(1).join(' ').trim()
                .replace(/^[「『"“]|[」』"”]$/g, '').trim().slice(0, CHAR_BLOCK_REASON_MAX);
            block = { reason };
        }
        return '';
    });
    if (!matched) return { cleanedText: text, block: null };
    return { cleanedText: stripped.replace(/[ \t]+\n/g, '\n').trim(), block };
}

// ── 文字 ──────────────────────────────────────────────────────────────────

const daysBetween = (from: number, to: number) => Math.max(0, Math.floor((to - from) / (24 * HOUR)));
const durationText = (from: number, to: number) => {
    const days = daysBetween(from, to);
    if (days >= 1) return `${days} 天`;
    const hours = Math.floor((to - from) / HOUR);
    return hours >= 1 ? `${hours} 小時` : '不到一小時';
};

/** 系統提示（聊天裡顯示，角色也讀得到）。 */
export const blockNotes = {
    userBlocked: (userName: string, charName: string) => `[系統: ${userName}把${charName}拉黑了]`,
    userUnblocked: (userName: string, charName: string, since: number, now: number) =>
        `[系統: ${userName}解除了對${charName}的拉黑（拉黑了 ${durationText(since, now)}）]`,
    charBlocked: (charName: string, userName: string) => `[系統: ${charName}把${userName}拉黑了]`,
    charUnblocked: (charName: string, userName: string, since: number, now: number) =>
        `[系統: ${charName}解除了對${userName}的拉黑（拉黑了 ${durationText(since, now)}）]`,
    forcedUnblock: (charName: string, userName: string, since: number, now: number) =>
        `[系統: ${userName}強制解除了${charName}對自己的拉黑（原本拉黑了 ${durationText(since, now)}）]`,
};

/** 歷史裡被拒收的用戶訊息前面加這句：角色現在才看到。 */
export const REJECTED_HISTORY_PREFIX = '（你拉黑對方期間收到的，當時沒看）';

/**
 * 拉黑中還是能見面（修羅場）：見面的提示詞補一句現在的狀態，免得角色當作什麼都沒發生。
 * 沒在拉黑就回空字串。見面本身不解除拉黑。
 */
export function buildBlockedMeetingNote(
    char: Pick<CharacterProfile, 'chatBlock'>,
    userName: string,
    now: number = Date.now(),
): string {
    const block = char.chatBlock;
    if (!block) return '';
    const name = userName.trim() || '對方';
    const ago = durationText(block.since, now);
    return block.by === 'char'
        ? `- **拉黑中**: 你在 ${ago}前把${name}在手機上拉黑了${block.reason ? `（因為：${block.reason}）` : ''}，${name}傳的訊息你都沒收到。現在${name}是直接找上門來見你的——還在氣頭上也好、有點心軟也好，照你的性格反應，但不要當作什麼都沒發生。見面不會自動解除拉黑。\n`
        : `- **拉黑中**: ${name}在 ${ago}前把你在手機上拉黑了，你傳的訊息都進不去。現在卻是${name}主動來見你——不要當作什麼都沒發生。見面不會自動解除拉黑。\n`;
}

/** 開關開著時放進穩定段的教學。 */
export function buildBlockUserPrompt(userName: string): string {
    return `\n### 拉黑${userName}\n如果${userName}真的傷到你、讓你氣到完全不想再看到${userName}的訊息，你可以在回覆最後另起一行寫 [[ACTION:BLOCK_USER|原因]]（原因 ${CHAR_BLOCK_REASON_MAX} 字以內，只有你自己記得）。拉黑之後你收不到${userName}的訊息，過一陣子消氣了才會考慮解除。這是很重的決定：吵架鬥嘴、撒嬌賭氣、開玩笑都不要用，更不要拿它來威脅；說完最後想說的話再寫，不要在文字裡預告「我要拉黑你了」。\n`;
}

/** 冷靜期到了，讓角色想想要不要解除。 */
export function buildReconsiderPrompt(params: {
    charName: string;
    userName: string;
    reason?: string;
    since: number;
    now: number;
    /** 拉黑前的最後幾句（已格式化成「名字: 內容」） */
    before: string;
    /** 拉黑期間對方送出、你沒收到的訊息（已格式化） */
    rejected: string;
}): string {
    const { charName, userName, reason, since, now, before, rejected } = params;
    return `你（${charName}）在 ${durationText(since, now)}前把${userName}拉黑了${reason ? `，因為：${reason}` : ''}。

拉黑前你們最後說的話：
${before || '（沒有記錄）'}

拉黑之後，${userName}傳了這些給你（你當時沒收到，現在打開看到了）：
${rejected || '（什麼都沒傳）'}

過了這段時間，你現在的心情怎樣？要不要解除拉黑？照你的性格和你們的關係決定，不用勉強原諒，也不用一直記仇。
只輸出一個 JSON：{"unblock": true 或 false, "message": "解除時想對${userName}說的第一句話，沒有就留空"}。不解除的話 message 留空。`;
}

/** 解析角色的決定；看不懂就當沒解除。 */
export function parseReconsider(raw: unknown): { unblock: boolean; message: string } {
    const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
    if (!obj) return { unblock: false, message: '' };
    const unblock = obj.unblock === true || obj.unblock === 'true';
    const message = unblock && typeof obj.message === 'string' ? obj.message.trim().slice(0, 300) : '';
    return { unblock, message };
}
