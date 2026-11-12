import type { CharacterProfile, GroupProfile, MomentPost, UserProfile } from '../types';
import type { PersonaKnowledge } from './momentsPool';
import { personaKeyForChar, personaKeyForNpc, personaNameForKey, type NpcPersonaRef } from './userPersona';
import { presentPersonaKeys } from './groupChat/presence';

/**
 * 朋友圈的身份資料（多身份隔離 2a，見 plans/multi-persona-isolation-design.md）：
 * - 角色的主身份＝它私聊那條線綁的身份卡（personaKeyForChar）。
 * - 見過的身份＝它所在的群的群身份，跟主身份不同的那些（群友，不是朋友）。
 * - NPC 的主身份：手動指定的「認識的身份」，沒指定就從它關係清單裡的角色推（personaKeyForNpc）。
 */
export function buildPersonaKnowledge(
    profileBase: UserProfile,
    characters: Array<Pick<CharacterProfile, 'id' | 'groupId'> & { knownPersonaKeys?: string[]; primaryPersonaKey?: string }>,
    groups: Array<Pick<GroupProfile, 'id' | 'members'>>,
    npcs: NpcPersonaRef[] = [],
): PersonaKnowledge {
    const main = new Map<string, string>();
    // 關係線：角色認識的每張卡都是「認識的人」（plans/persona-line-batch3.md）
    const known = new Map<string, Set<string>>();
    for (const c of characters) {
        main.set(c.id, personaKeyForChar(profileBase, c));
        if (c.knownPersonaKeys && c.knownPersonaKeys.length > 1) known.set(c.id, new Set(c.knownPersonaKeys));
    }
    for (const n of npcs) if (!main.has(n.id)) main.set(n.id, personaKeyForNpc(profileBase, n, characters));

    const seen = new Map<string, Set<string>>();
    for (const g of groups) {
        // 在場的每張卡都算見過（關係線第 5 批）；旁觀的群沒有你，不算見過
        for (const key of presentPersonaKeys(profileBase, g, characters)) {
            for (const member of g.members || []) {
                if (main.get(member) === key) continue;
                const set = seen.get(member) || new Set<string>();
                set.add(key);
                seen.set(member, set);
            }
        }
    }
    const empty: ReadonlySet<string> = new Set();
    return {
        mainKeyOf: id => main.get(id),
        seenKeysOf: id => seen.get(id) || empty,
        knownKeysOf: id => known.get(id) || empty,
        nameOf: key => personaNameForKey(profileBase, key),
    };
}

/** 在角色貼文底下互動時可以選的身份：主身份在前，再來是它見過的。用戶自己的貼文就用發文那個身份。 */
export function interactionPersonaOptions(
    post: Pick<MomentPost, 'author'>,
    knowledge: PersonaKnowledge,
    globalKey: string,
): string[] {
    if (post.author.kind === 'user') return [post.author.personaKey || globalKey];
    if (!post.author.id) return [globalKey];
    const main = knowledge.mainKeyOf(post.author.id) ?? globalKey;
    const known = [...(knowledge.knownKeysOf?.(post.author.id) || [])].filter(k => k !== main);
    return [main, ...known, ...[...knowledge.seenKeysOf(post.author.id)].filter(k => k !== main && !known.includes(k))];
}
