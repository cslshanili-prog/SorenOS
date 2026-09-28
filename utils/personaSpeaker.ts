import type { UserProfile } from '../types';
import { personaNameForKey } from './userPersona';

/**
 * 共享的地方（群聊、朋友圈、角色之間提到你）裡「你」是哪一個、叫什麼名字，
 * 以及「那不是你私下認識的那個人」的提醒。規則見 plans/multi-persona-isolation-design.md。
 */

/** 用戶的訊息／貼文記的身份鍵（沒記就用場景預設，例如群身份）→ 顯示名字。 */
export function userSpeakerName(profileBase: UserProfile | null | undefined, key: string | undefined, fallbackName: string): string {
    if (!profileBase || !key) return fallbackName;
    return personaNameForKey(profileBase, key) || fallbackName;
}

/**
 * 給角色的提醒：這些名字是別的人，不是你私下認識的那個你。
 * where 是場景（「群裡」「朋友圈裡」），knownName 是它主身份的名字。
 */
export function distinctPersonaNote(otherNames: string[], knownName: string, where: string): string {
    const names = [...new Set(otherNames.map(n => n.trim()).filter(n => n && n !== knownName))];
    if (!names.length) return '';
    const list = names.map(n => `「${n}」`).join('、');
    return `（注意：${where}的${list}跟你私下聊天的「${knownName}」是不同的人，你不知道他們之間有任何關係；別把${list}說過的話、做過的事算到「${knownName}」頭上，也別對${list}用你跟「${knownName}」之間的稱呼和默契。）`;
}

/**
 * 兩個角色私下聊天（查手機的角色對聊），而它們私下認識的你是不同的身份卡：
 * 給其中一方的提醒。selfKnown 是自己認識的那個你，otherKnown 是對方認識的。
 */
export function crossPersonaNote(selfKnown: string, otherCharName: string, otherKnown: string): string {
    if (!selfKnown || !otherKnown || selfKnown === otherKnown) return '';
    return `（注意：你私下認識的「${selfKnown}」跟「${otherCharName}」私下認識的「${otherKnown}」是兩個不同的人，你不知道他們之間有任何關係。你和「${selfKnown}」的事是你自己的私事，不是你跟「${otherCharName}」的共同話題；「${otherCharName}」聊到「${otherKnown}」時，那是另一個人，別算到「${selfKnown}」頭上，也別主動提起「${otherKnown}」。）`;
}

/**
 * NPC 的「跟你的關係」在某個場景裡怎麼標：它認識的你（knownName）就是場景裡的你（sceneName）→ 照舊；
 * 不是 → 標明那段關係是對「knownName」的，場景裡的「sceneName」是另一個人。
 */
export function userRelationLabel(knownName: string, sceneName: string): string {
    if (!knownName || knownName === sceneName) return `「${sceneName}」`;
    return `「${knownName}」（你私下認識的人；不是這裡的「${sceneName}」，你不知道他們之間有任何關係）`;
}
