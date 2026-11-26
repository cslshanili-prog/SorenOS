/**
 * 約定的完成判定（plans/bond-batch4.md 1.2、第 5 節）。純函式：給一條線一天的訊息，
 * 看出那天發生了哪些事（「事實」），再照約定的完成依據判有沒有做到、依據哪幾則。
 *
 * - 聊幾句：你至少 3 則、TA 至少 1 則（`min` 可以改你的則數）
 * - 深聊：你至少 20 則、TA 至少 10 則
 * - 晚安：雙方各有一則帶「晚安／good night／睡了」之類的
 * - 照片：有圖（你傳的、TA 的 SEND_PHOTO／SEND_SAVED_PHOTO）
 * - 通話：通話紀錄裡你至少說過一句
 * - 見面：有見面的訊息
 * - 一起聽歌：TA 決定一起聽的音樂卡
 * - 禮物：送出或收到的禮物單（購物中心送禮、TA 的 [[ACTION:GIFT]]）
 *
 * 聊天則數不算通話、見面、羈絆自動的通知、系統訊息。
 */
import type { BondTaskCheck, Message } from '../../types';

export type FactKind = 'chat' | 'deepChat' | 'goodnight' | 'photo' | 'call' | 'date' | 'music' | 'giftIn' | 'giftOut';
export const FACT_KINDS: FactKind[] = ['chat', 'deepChat', 'goodnight', 'photo', 'call', 'date', 'music', 'giftIn', 'giftOut'];

export const CHAT_MIN_USER = 3;
export const CHAT_MIN_CHAR = 1;
export const DEEP_MIN_USER = 20;
export const DEEP_MIN_CHAR = 10;

const GOODNIGHT_RE = /晚安|good\s*night|goodnite|nighty|night\s*night|おやすみ|睡了|去睡|要睡|先睡|睡覺了|睡吧|好夢|做個好夢|sweet\s*dreams/i;

type Msg = Pick<Message, 'id' | 'role' | 'type' | 'content' | 'metadata'>;

const sourceOf = (m: Msg): string => String(m.metadata?.source || '');
const isSystem = (m: Msg) => m.role === 'system' || m.type === 'system';
const isChatMsg = (m: Msg) => !isSystem(m) && !['call', 'date', 'bond-output'].includes(sourceOf(m)) && !m.metadata?.dateStoryId;
const textOf = (m: Msg): string => (typeof m.content === 'string' ? m.content : '');

export interface DayFacts {
    /** 每件事成立的話，依據哪幾則（沒成立就沒有這一格） */
    hits: Partial<Record<FactKind, number[]>>;
    /** 那天的聊天則數 */
    userCount: number;
    charCount: number;
}

export function dayFacts(messages: Msg[]): DayFacts {
    const hits: Partial<Record<FactKind, number[]>> = {};
    const chat = messages.filter(isChatMsg);
    const mine = chat.filter(m => m.role === 'user');
    const theirs = chat.filter(m => m.role === 'assistant');
    const ids = (ms: Msg[]) => ms.map(m => m.id).filter(id => typeof id === 'number' && id > 0);
    if (mine.length >= CHAT_MIN_USER && theirs.length >= CHAT_MIN_CHAR) hits.chat = ids([...mine.slice(0, CHAT_MIN_USER), ...theirs.slice(0, CHAT_MIN_CHAR)]);
    if (mine.length >= DEEP_MIN_USER && theirs.length >= DEEP_MIN_CHAR) hits.deepChat = ids([mine[0], theirs[0]]);
    const gnMine = chat.filter(m => m.role === 'user' && GOODNIGHT_RE.test(textOf(m)));
    const gnTheirs = chat.filter(m => m.role === 'assistant' && GOODNIGHT_RE.test(textOf(m)));
    if (gnMine.length && gnTheirs.length) hits.goodnight = ids([gnMine[gnMine.length - 1], gnTheirs[gnTheirs.length - 1]]);
    const photos = messages.filter(m => !isSystem(m) && m.type === 'image' && sourceOf(m) !== 'date');
    if (photos.length) hits.photo = ids(photos.slice(0, 3));
    const callMine = messages.filter(m => sourceOf(m) === 'call' && m.role === 'user');
    if (callMine.length) hits.call = ids(callMine.slice(0, 1));
    const dates = messages.filter(m => sourceOf(m) === 'date' && !isSystem(m));
    if (dates.length) hits.date = ids(dates.slice(0, 1));
    const music = messages.filter(m => m.type === 'music_card' && m.role === 'assistant' && ['join', 'join_and_add', undefined, ''].includes(m.metadata?.intent));
    if (music.length) hits.music = ids(music.slice(0, 1));
    const gifts = messages.filter(m => m.type === 'mall_order' && m.metadata?.mode === 'gift' && m.metadata?.status !== 'cancelled');
    const giftIn = gifts.filter(m => m.role === 'assistant');
    const giftOut = gifts.filter(m => m.role === 'user');
    if (giftIn.length) hits.giftIn = ids(giftIn.slice(0, 1));
    if (giftOut.length) hits.giftOut = ids(giftOut.slice(0, 1));
    return { hits, userCount: mine.length, charCount: theirs.length };
}

export interface CheckResult { done: boolean; messageIds: number[] }

const NOT_DONE: CheckResult = { done: false, messageIds: [] };

/** 照紀錄或關鍵字判一天；手動、AI 判讀回沒做到（另外處理） */
export function checkDay(check: BondTaskCheck, facts: DayFacts, messages: Msg[]): CheckResult {
    if (check.kind === 'record') {
        if (check.record === 'chat' && check.min && check.min !== CHAT_MIN_USER) {
            const chat = messages.filter(isChatMsg);
            const mine = chat.filter(m => m.role === 'user');
            const theirs = chat.filter(m => m.role === 'assistant');
            return mine.length >= check.min && theirs.length >= CHAT_MIN_CHAR
                ? { done: true, messageIds: [mine[0].id, theirs[0].id] } : NOT_DONE;
        }
        if (check.record === 'gift') {
            const ids = [...(facts.hits.giftIn || []), ...(facts.hits.giftOut || [])];
            return ids.length ? { done: true, messageIds: ids } : NOT_DONE;
        }
        const ids = facts.hits[check.record];
        return ids ? { done: true, messageIds: ids } : NOT_DONE;
    }
    if (check.kind === 'keyword') {
        const words = check.words.map(w => w.trim().toLowerCase()).filter(Boolean);
        if (!words.length) return NOT_DONE;
        const hit = (m: Msg) => words.some(w => textOf(m).toLowerCase().includes(w));
        const chat = messages.filter(m => !isSystem(m) && sourceOf(m) !== 'bond-output');
        const mine = chat.filter(m => m.role === 'user' && hit(m));
        const theirs = chat.filter(m => m.role === 'assistant' && hit(m));
        if (check.both ? (mine.length && theirs.length) : (mine.length || theirs.length)) {
            return { done: true, messageIds: [...mine.slice(0, 1), ...theirs.slice(0, 1)].map(m => m.id) };
        }
        return NOT_DONE;
    }
    return NOT_DONE;
}
