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
