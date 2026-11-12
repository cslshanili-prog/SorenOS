/**
 * 群裡在場的身份（關係線第 5 批，plans/persona-line-batch5.md）：純邏輯，不碰資料庫。
 *
 * - 在場可以是一張、好幾張，或一張都沒有（旁觀，群裡沒有你）。
 * - 每位成員照自己認識誰看在場的你：認識的就是那條線上的那個人，不認識的是群友。
 * - 旁觀時你打的字記 metadata.offstage，之後你回到群裡也不給角色看。
 */
import type { CharacterProfile, GroupProfile, Message, UserProfile } from '../../types';
import { knowsPersona } from '../chatLine';
import { personaKeyForGroup, personaNameForKey, REAL_IDENTITY_PERSONA_ID } from '../userPersona';
import { isPersonaLinesEnabled } from '../devDebug';

type PresenceGroup = Pick<GroupProfile, 'id' | 'members'> & Partial<Pick<GroupProfile, 'userLurkMode'>>;
type PresenceChar = Pick<CharacterProfile, 'id' | 'groupId'>;

const validKey = (profileBase: UserProfile, key: string) =>
    key === REAL_IDENTITY_PERSONA_ID || !!profileBase.personas?.some(p => p.id === key);

/**
 * 這個群裡在場的身份：
 * 1. groupPresence 有設：濾掉已刪的卡照用（原本不是空、濾完變空 ＝ 卡都刪了，當作沒設）；
 * 2. 沒設、群開著舊的隱身圍觀：[]（旁觀）；
 * 3. 都沒有：自動一張（personaKeyForGroup：群指定 > 成員多數 > 全域）。
 * 關係線預覽關著（multi=false）時不看 groupPresence，照舊一張或旁觀開關。
 */
export function presentPersonaKeys(
    profileBase: UserProfile,
    group: PresenceGroup,
    characters: PresenceChar[] = [],
    multi: boolean = isPersonaLinesEnabled(),
): string[] {
    const set = multi ? profileBase.groupPresence?.[group.id] : undefined;
    if (set) {
        const keys = [...new Set(set.filter(k => validKey(profileBase, k)))];
        if (keys.length || !set.length) return keys;
    } else if (group.userLurkMode) {
        return [];
    }
    return [personaKeyForGroup(profileBase, group, characters)];
}

/** 這個群有沒有單獨設過在場的身份（沒設 ＝ 自動或舊的旁觀開關）。 */
export function hasExplicitPresence(profileBase: UserProfile, groupId: string): boolean {
    return !!profileBase.groupPresence && Object.prototype.hasOwnProperty.call(profileBase.groupPresence, groupId);
}

/** 旁觀時打的字：只留在你的螢幕上，角色永遠看不到。 */
export function isOffstage(m: Pick<Message, 'metadata'>): boolean {
    return !!m.metadata?.offstage;
}

/**
 * 角色看得到的群訊息：旁觀中你所有的話都藏（群裡沒有你）；在場時只藏旁觀那陣子打的。
 * 代打（puppeted）的訊息是成員說的，role 不是 user，不受影響。
 */
export function memberVisibleGroupMessages<T extends Pick<Message, 'role' | 'metadata'>>(msgs: T[], lurking: boolean): T[] {
    return msgs.filter(m => m.role !== 'user' || (!lurking && !isOffstage(m)));
}

/** 這則群訊息是哪一個你發的：訊息上記的身份鍵，舊訊息沒記就算 fallback（通常是第一張在場的卡）。 */
export function userMessageKey(m: Pick<Message, 'metadata'>, fallback: string): string {
    const key = m.metadata?.personaKey;
    return typeof key === 'string' && key ? key : fallback;
}

/** 成員認識哪幾張在場的卡、哪幾張是群友。 */
export function memberPresence(
    char: Pick<CharacterProfile, 'knownPersonaKeys' | 'primaryPersonaKey'>,
    present: string[],
): { known: string[]; strangers: string[] } {
    const known: string[] = [];
    const strangers: string[] = [];
    for (const key of present) (knowsPersona(char, key) ? known : strangers).push(key);
    return { known, strangers };
}

/**
 * 成員認識好幾張在場的卡時，主看哪條線（Liora 2026-11-12：跟著最近在群裡說話的那張走）：
 * 它認識的卡裡最近在群裡說過話的那張 > 主線（在場的話）> 第一張。
 */
export function focalKnownKey(
    char: Pick<CharacterProfile, 'primaryPersonaKey'>,
    known: string[],
    groupMsgs: Array<Pick<Message, 'role' | 'metadata'>>,
    fallbackKey: string,
): string | undefined {
    if (!known.length) return undefined;
    for (let i = groupMsgs.length - 1; i >= 0; i--) {
        const m = groupMsgs[i];
        if (m.role !== 'user' || isOffstage(m)) continue;
        const key = userMessageKey(m, fallbackKey);
        if (known.includes(key)) return key;
    }
    if (char.primaryPersonaKey && known.includes(char.primaryPersonaKey)) return char.primaryPersonaKey;
    return known[0];
}

/** 發訊息預設用哪張卡：你上一則用的那張（還在場的話），否則第一張在場的。 */
export function defaultSpeakingKey(present: string[], groupMsgs: Array<Pick<Message, 'role' | 'metadata'>>): string | undefined {
    if (!present.length) return undefined;
    for (let i = groupMsgs.length - 1; i >= 0; i--) {
        const m = groupMsgs[i];
        if (m.role !== 'user' || isOffstage(m)) continue;
        const key = m.metadata?.personaKey;
        if (typeof key === 'string' && present.includes(key)) return key;
    }
    return present[0];
}

/** 在場的名字（提示詞、標示用）。 */
export function presentNames(profileBase: UserProfile, present: string[]): string[] {
    return present.map(k => personaNameForKey(profileBase, k));
}
