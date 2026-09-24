import type { QuietHoursSlot, ReadNoReplySettings, ScheduleSlot } from '../types';
import { scriptKey } from './scriptKey';

/**
 * 聊天設定 · Scenario ·「已讀不回」的純邏輯（判斷、文字、標籤、提示詞），介面與接線在：
 * - hooks/useChatAI.ts 的 triggerAI：強制已讀不回時不發主回覆請求，直接落自動回覆＋旁白；
 * - utils/chatPrompts.ts：「由角色決定」時把忙碌狀況告訴角色，讓它選擇回不回；剛已讀不回過的，
 *   下一次真的回覆時補一句「你剛才沒回」；
 * - utils/applyAssistantPostProcessing.ts：角色選擇不回時輸出 [[ACTION:NO_REPLY]]，在這裡剝掉並落自動回覆。
 *
 * 忙碌／睡覺是從日程時段的文字判斷的（日程沒有獨立的勿擾欄位），比對簡繁都認。
 */

export type ReadNoReplyState = 'busy' | 'sleep' | 'normal';

export interface ReadNoReplyDecision {
    /** force = 系統直接已讀不回；charDecides = 告訴角色它在忙，讓它自己決定。 */
    mode: 'force' | 'charDecides';
    state: ReadNoReplyState;
    /** 忙什麼（日程活動名）或不回訊時段的標題；可能是空字串。 */
    reason: string;
}

const SLEEP_KEYWORDS = ['睡', '就寢', '入眠', '夢鄉', '補眠', '打盹', 'sleep', 'nap', '💤', '😴', '🛌'];
// 睡前、睡醒都還醒著，先剝掉再比
const SLEEP_FALSE_POSITIVES = ['睡前', '睡醒', '醒來', '起床'];
const BUSY_KEYWORDS = [
    '開會', '會議', '上課', '考試', '手術', '值班', '加班', '排練', '演出', '表演', '拍攝', '錄音', '錄製',
    '比賽', '面試', '開車', '駕駛', '直播', '談判', '閉關', '趕稿', '趕工', '勿擾', '忙',
    'meeting', 'class', 'exam', 'surgery', 'rehearsal', 'busy', 'driving',
];

// 「不忙」「幫忙」「忙完」都不是在忙
const BUSY_FALSE_POSITIVES = ['不忙', '幫忙', '忙完', '不太忙'];

const SLEEP_KEYS = SLEEP_KEYWORDS.map(k => scriptKey(k.toLowerCase()));
const SLEEP_FP_KEYS = SLEEP_FALSE_POSITIVES.map(k => scriptKey(k));
const BUSY_KEYS = BUSY_KEYWORDS.map(k => scriptKey(k.toLowerCase()));
const BUSY_FP_KEYS = BUSY_FALSE_POSITIVES.map(k => scriptKey(k));

/** 日程時段是睡覺、在忙，還是都不是。只看活動名、描述和 emoji，不看內心獨白（獨白常提到別的事）。 */
export function classifyScheduleSlot(slot: Pick<ScheduleSlot, 'activity' | 'description' | 'emoji'> | null | undefined): 'sleep' | 'busy' | null {
    if (!slot) return null;
    let blob = scriptKey(`${slot.activity || ''} ${slot.description || ''} ${slot.emoji || ''}`.toLowerCase());
    for (const fp of SLEEP_FP_KEYS) blob = blob.split(fp).join(' ');
    if (SLEEP_KEYS.some(k => blob.includes(k))) return 'sleep';
    for (const fp of BUSY_FP_KEYS) blob = blob.split(fp).join(' ');
    if (BUSY_KEYS.some(k => blob.includes(k))) return 'busy';
    return null;
}

const toMinutes = (hhmm: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
};

/** 現在（角色那邊的牆上時鐘）落在哪個不回訊時段；end 早於 start 視為跨夜，start 等於 end 視為整天。 */
export function findActiveQuietSlot(slots: QuietHoursSlot[] | undefined, wallClock: Date): QuietHoursSlot | null {
    if (!slots?.length) return null;
    const day = wallClock.getDay();
    const prevDay = (day + 6) % 7;
    const now = wallClock.getHours() * 60 + wallClock.getMinutes();
    for (const slot of slots) {
        const start = toMinutes(slot.start);
        const end = toMinutes(slot.end);
        if (start === null || end === null || !slot.days?.length) continue;
        if (start === end) {
            if (slot.days.includes(day)) return slot;
        } else if (start < end) {
            if (slot.days.includes(day) && now >= start && now < end) return slot;
        } else {
            if (slot.days.includes(day) && now >= start) return slot;
            if (slot.days.includes(prevDay) && now < end) return slot;
        }
    }
    return null;
}

/**
 * 這一刻要不要已讀不回。沒開、或都沒命中回 null。
 * 用戶設的不回訊時段一律強制；日程判定的忙碌／睡覺在「由角色決定」開著時交給角色。
 */
export function resolveReadNoReply(
    settings: ReadNoReplySettings | undefined,
    currentSlot: Pick<ScheduleSlot, 'activity' | 'description' | 'emoji'> | null | undefined,
    wallClock: Date,
): ReadNoReplyDecision | null {
    if (!settings?.enabled) return null;
    const quiet = findActiveQuietSlot(settings.quietSlots, wallClock);
    if (quiet) return { mode: 'force', state: 'normal', reason: quiet.title?.trim() || '' };
    const kind = classifyScheduleSlot(currentSlot);
    if (!kind) return null;
    return {
        mode: settings.charDecides ? 'charDecides' : 'force',
        state: kind,
        reason: currentSlot?.activity?.trim() || '',
    };
}

export const DEFAULT_AUTO_REPLY: Record<ReadNoReplyState, string> = {
    busy: '[自動回覆]現在在忙，稍後回覆',
    sleep: '[自動回覆]睡了，醒來再回',
    normal: '[自動回覆]現在不方便，稍後回覆',
};

/** 固定文字：該狀態的 → 普通狀態的 → 內建預設。 */
export function pickAutoReplyText(settings: ReadNoReplySettings | undefined, state: ReadNoReplyState): string {
    const own = state === 'busy' ? settings?.busyText : state === 'sleep' ? settings?.sleepText : settings?.normalText;
    return own?.trim() || settings?.normalText?.trim() || DEFAULT_AUTO_REPLY[state];
}

/** 給旁白和提示詞用的「為什麼沒回」。 */
export function describeNoReplyReason(decision: Pick<ReadNoReplyDecision, 'state' | 'reason'>): string {
    if (decision.state === 'sleep') return '在睡覺';
    if (decision.state === 'busy') return decision.reason ? `正在${decision.reason}` : '在忙';
    return decision.reason ? `在「${decision.reason}」時段` : '現在不方便回訊息';
}

/** 已讀不回時落在聊天裡的灰色旁白。 */
export function buildNoReplyNarration(charName: string, decision: Pick<ReadNoReplyDecision, 'state' | 'reason'>): string {
    return `[系統: ${charName} 已讀，${describeNoReplyReason(decision)}，暫時沒有回覆]`;
}

/** 角色選擇不回：[[ACTION:NO_REPLY]] 或 [[ACTION:NO_REPLY|自動回覆內容]]，也認「已讀不回」。 */
// 自動回覆內容本身可能帶一層中括號（「[會議中] 稍後回」），所以內容容許內嵌一層 [...]
const NO_REPLY_TAG_RE = /\[\[\s*ACTION\s*[:：]\s*(?:NO_REPLY|已讀不回|已读不回)\s*(?:[|｜]\s*((?:[^\[\]\n]|\[[^\[\]\n]*\])*?))?\s*\]\]/gi;
export const AUTO_REPLY_MAX_LENGTH = 40;

export function extractNoReplyDirective(text: string): { cleanedText: string; noReply: boolean; autoReply?: string } {
    let noReply = false;
    let autoReply: string | undefined;
    const stripped = text.replace(NO_REPLY_TAG_RE, (_m, body?: string) => {
        noReply = true;
        const v = (body || '').trim().replace(/^[「『"“]|[」』"”]$/g, '').trim();
        if (v && v.length <= AUTO_REPLY_MAX_LENGTH) autoReply = v;
        return '';
    });
    if (!noReply) return { cleanedText: text, noReply: false };
    return { cleanedText: stripped.trim(), noReply: true, ...(autoReply ? { autoReply } : {}) };
}

/** 「由角色決定」：把此刻的忙碌狀況告訴角色，讓它選擇回不回。放易變段。 */
export function buildCharDecidesPrompt(decision: ReadNoReplyDecision, aiGenerated: boolean): string {
    const doing = decision.state === 'sleep' ? '正在睡覺' : `正在忙${decision.reason ? `（${decision.reason}）` : ''}`;
    const tagHint = aiGenerated
        ? '[[ACTION:NO_REPLY|自動回覆內容]]（自動回覆像手機的自動回覆，15 字以內，貼合你此刻在做的事）'
        : '[[ACTION:NO_REPLY]]';
    return `\n### 已讀不回\n你此刻${doing}，剛收到對方的訊息。要不要回由你依你們現在的狀況決定：想回（例如正在吵架、對方有急事、你本來就想理他）就照常回覆；決定先不回，整則回覆只輸出 ${tagHint}，不要輸出其他任何文字。\n`;
}

/** 上一則角色訊息是已讀不回的自動回覆時，這一次真的回覆前提醒角色。 */
export function buildResumeAfterNoReplyNote(lastAssistantMeta: unknown): string {
    const info = (lastAssistantMeta as { readNoReply?: { state?: ReadNoReplyState; reason?: string } } | undefined)?.readNoReply;
    if (!info?.state) return '';
    return `\n（你剛才${describeNoReplyReason({ state: info.state, reason: info.reason || '' })}，只發了自動回覆、沒有真的回。現在你看到了這段時間的訊息，自然地接上就好，不用解釋自動回覆本身。）\n`;
}

/** 強制已讀不回＋「AI 生成自動回覆」：請副 API 寫一句自動回覆的提示詞。 */
export function buildAutoReplyGenPrompt(opts: {
    charName: string;
    persona: string;
    decision: Pick<ReadNoReplyDecision, 'state' | 'reason'>;
    location?: string;
    recentLines: string[];
}): string {
    const where = opts.location ? `，在${opts.location}` : '';
    return `你是${opts.charName}。${opts.persona ? `人設摘要：${opts.persona.slice(0, 400)}\n` : ''}
你此刻${describeNoReplyReason(opts.decision)}${where}，沒空回訊息。剛才的對話：
${opts.recentLines.join('\n') || '（沒有）'}

以你的口吻寫一句手機自動回覆（像「[會議中] 稍後回」這種），15 字以內，貼合你此刻在做的事。只輸出這一句，不要引號、不要解釋。`;
}

/** 副 API 回來的自動回覆：取第一行、去引號、限長；不能用就回 null 讓調用方退回固定文字。 */
export function cleanGeneratedAutoReply(raw: string | null | undefined): string | null {
    const line = (raw || '').split('\n').map(l => l.trim()).find(Boolean) || '';
    const v = line.replace(/^[「『"“]|[」』"”]$/g, '').trim();
    if (!v || v.length > AUTO_REPLY_MAX_LENGTH || v.includes('[[')) return null;
    return v;
}
