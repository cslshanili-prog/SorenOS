import type { CharacterProfile, GroupProfile, MomentPost, UserProfile } from '../types';
import type { PersonaKnowledge } from './momentsPool';
import { globalPersonaKey, personaKeyForChar, personaKeyForGroup, personaNameForKey } from './userPersona';

/**
 * 朋友圈的身份資料（多身份隔離 2a，見 plans/multi-persona-isolation-design.md）：
 * - 角色的主身份＝它私聊那條線綁的身份卡（personaKeyForChar）。
 * - 見過的身份＝它所在的群的群身份，跟主身份不同的那些（群友，不是朋友）。
 * - NPC 還沒有「認識的身份」欄位（2c 才加），先當成認識全域默認的你。
 */
export function buildPersonaKnowledge(
    profileBase: UserProfile,
    characters: Array<Pick<CharacterProfile, 'id' | 'groupId'>>,
    groups: Array<Pick<GroupProfile, 'id' | 'members'>>,
    npcIds: Iterable<string> = [],
): PersonaKnowledge {
    const main = new Map<string, string>();
    for (const c of characters) main.set(c.id, personaKeyForChar(profileBase, c));
    const fallback = globalPersonaKey(profileBase);
    for (const id of npcIds) if (!main.has(id)) main.set(id, fallback);

    const seen = new Map<string, Set<string>>();
    for (const g of groups) {
        const key = personaKeyForGroup(profileBase, g.id);
        for (const member of g.members || []) {
            if (main.get(member) === key) continue;
            const set = seen.get(member) || new Set<string>();
            set.add(key);
            seen.set(member, set);
        }
    }
    const empty: ReadonlySet<string> = new Set();
    return {
        mainKeyOf: id => main.get(id),
        seenKeysOf: id => seen.get(id) || empty,
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
    return [main, ...[...knowledge.seenKeysOf(post.author.id)].filter(k => k !== main)];
}
