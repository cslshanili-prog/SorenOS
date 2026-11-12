/**
 * 關係線（plans/persona-line-batch1-2.md 第 6 節）：召回時給「別條線的記憶」加標籤。
 *
 * 記憶只有一份：角色認識好幾張身份卡時，跟 A 聊的事、跟 B 聊的事都存在它的記憶宮殿裡，
 * 召回時一起找。跟現在這張卡無關的那些，標清楚是跟誰的、現在這位不一定知道，要不要說出口
 * 由角色決定。標籤是召回當下才算的，之後規則變了（例如小號被認出來）不用回頭改記憶。
 */
import { DB } from '../db';
import { lineViewPersonaKey, personaNameForKey, REAL_IDENTITY_PERSONA_ID } from '../userPersona';
import type { CharacterProfile, UserProfile } from '../../types';
import { sameIdentityKeys } from '../personaLinks';

export interface MemoryLineLabels {
    /** 現在這條線的身份鍵 */
    currentKey: string;
    /** 角色主線的身份鍵（沒標身份的記憶算這條） */
    primaryKey: string;
    /** 身份鍵 → 名字 */
    names: Record<string, string>;
    /** 角色知道跟現在這張是同一個人的那幾張卡（小號，plans/persona-line-batch4.md） */
    sameAs?: string[];
}

/** 這條記憶要不要標、標什麼；同一條線回空字串。 */
export function memoryLineLabel(node: { personaKey?: string }, labels?: MemoryLineLabels): string {
    if (!labels) return '';
    const nodeKey = node.personaKey || labels.primaryKey;
    if (nodeKey === labels.currentKey) return '';
    const other = labels.names[nodeKey] || '另一個人';
    if (labels.sameAs?.includes(nodeKey)) return `〔這是TA用「${other}」的身份跟你經歷的事〕`;
    const current = labels.names[labels.currentKey] || '現在跟你說話的人';
    return `〔這是你跟「${other}」之間的事，「${current}」不一定知道〕`;
}

/** 純函式版：給定角色（可能是線視圖）和用戶檔案，算出標籤設定；只有一條線的角色回 undefined。 */
export function memoryLineLabelsFor(
    char: { knownPersonaKeys?: string[]; primaryPersonaKey?: string; altKnowledge?: CharacterProfile['altKnowledge'] },
    profileBase: UserProfile | null | undefined,
): MemoryLineLabels | undefined {
    const known = char.knownPersonaKeys || [];
    if (known.length <= 1 || !profileBase) return undefined;
    const primaryKey = char.primaryPersonaKey || known[0] || REAL_IDENTITY_PERSONA_ID;
    const currentKey = lineViewPersonaKey(char) || primaryKey;
    const names: Record<string, string> = {};
    for (const key of new Set([...known, primaryKey, currentKey])) names[key] = personaNameForKey(profileBase, key);
    const sameAs = sameIdentityKeys(char, profileBase, currentKey);
    return { currentKey, primaryKey, names, ...(sameAs.length ? { sameAs } : {}) };
}

/** 從資料庫讀用戶檔案再算；讀不到就不標（等於只有一條線）。 */
export async function buildMemoryLineLabels(
    char: { knownPersonaKeys?: string[]; primaryPersonaKey?: string; altKnowledge?: CharacterProfile['altKnowledge'] },
): Promise<MemoryLineLabels | undefined> {
    if ((char.knownPersonaKeys || []).length <= 1) return undefined;
    const profile = await DB.getUserProfile().catch(() => null);
    return memoryLineLabelsFor(char, profile);
}
