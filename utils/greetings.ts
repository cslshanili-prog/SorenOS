/**
 * 角色的開場白清單（CharacterProfile.greetings）：神經鏈接編輯頁和見面劇情設定共用一份，每段勾私聊／見面。
 * 舊資料只有 dateGreetings（見面開場白）：讀的時候當成勾了見面的，寫的時候一律寫 greetings、清掉 dateGreetings，
 * 不用另外跑搬遷。
 */
import type { CharacterGreeting, CharacterProfile } from '../types';

type WithGreetings = Pick<CharacterProfile, 'greetings' | 'dateGreetings'>;

export const makeGreetingId = () => `gr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

/** 整份清單（舊的 dateGreetings 轉成勾了見面的） */
export function greetingsOf(char: WithGreetings | null | undefined): CharacterGreeting[] {
    if (!char) return [];
    if (char.greetings) return char.greetings;
    return (char.dateGreetings || []).map(g => ({ id: g.id, text: g.text, date: true }));
}

export const chatGreetingsOf = (char: WithGreetings | null | undefined) => greetingsOf(char).filter(g => g.chat);
export const dateGreetingsOf = (char: WithGreetings | null | undefined) => greetingsOf(char).filter(g => g.date);

/** 寫回角色的欄位：空白的拿掉，沒有就整欄清掉；舊欄位一起清 */
export function greetingsPatch(list: CharacterGreeting[], opts: { keepBlank?: boolean } = {}): Pick<CharacterProfile, 'greetings' | 'dateGreetings'> {
    const cleaned = opts.keepBlank ? list : list.filter(g => g.text.trim());
    return { greetings: cleaned.length ? cleaned : undefined, dateGreetings: undefined };
}

/**
 * 見面劇情設定只看得到勾了見面的那幾段；在那裡改完，併回整份清單：
 * 改字的照原位換、新增的補在後面（勾見面）、在見面那邊刪掉的——還勾著私聊就只取消見面，不然整段刪掉。
 */
export function mergeDateEdits(all: CharacterGreeting[], edited: Array<{ id: string; text: string }>): CharacterGreeting[] {
    const byId = new Map(edited.map(g => [g.id, g]));
    const out: CharacterGreeting[] = [];
    for (const g of all) {
        if (!g.date) { out.push(g); continue; }
        const e = byId.get(g.id);
        if (e) out.push({ ...g, text: e.text });
        else if (g.chat) out.push({ ...g, date: false });
    }
    const known = new Set(all.map(g => g.id));
    for (const e of edited) if (!known.has(e.id)) out.push({ id: e.id, text: e.text, date: true });
    return out;
}
