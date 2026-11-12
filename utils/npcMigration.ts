/**
 * NPC 搬成配角（關係線第 6 批 6b，plans/persona-line-batch6.md 第 1.2 節）。純邏輯，不碰資料庫。
 *
 * - 開了關係線預覽就自動搬一次；id 照舊，所以引用它的地方大多只要換種類。
 * - 舊的 npcs 表不刪，留著當備份，搬過的那筆記 migratedToCharAt，之後不再列出來、不再搬。
 * - 引用它、存在別處的資料：群聊 npcMemberIds 併進 members、查手機綁 NPC 的聯繫人改成真角色、
 *   朋友圈 NPC 作者／按讚／留言改成角色、劇情劇場的客串併進演員。
 */
import type {
    CharacterProfile, GroupProfile, MomentActor, MomentPost, NPCProfile, PhoneContact, StoryTheaterEntry, UserProfile,
} from '../types';
import { personaKeyForNpc } from './userPersona';
import { DEFAULT_MANUAL_CONTEXT_LIMIT, CONTEXT_RANGE_POLICY_VERSION } from './chatContextRange';

/** 還沒搬的 NPC */
export const pendingNpcs = (npcs: NPCProfile[]): NPCProfile[] => npcs.filter(n => !n.migratedToCharAt);

const firstSentence = (text: string): string => {
    const t = (text || '').trim();
    if (!t) return '';
    const m = t.match(/^[^。！？!?\n]{1,60}[。！？!?]?/);
    return (m ? m[0] : t.slice(0, 60)).trim();
};

const monthKey = (ms: number): string => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

/** 一個 NPC → 一個配角（主動消息不開，日程沿用預設：沒開）。 */
export function npcToCharacter(
    npc: NPCProfile,
    profileBase: UserProfile,
    characters: Array<Pick<CharacterProfile, 'id' | 'groupId'>>,
): CharacterProfile {
    const knownKey = personaKeyForNpc(profileBase, npc, characters);
    const memory = npc.memory?.trim();
    return {
        id: npc.id,
        name: npc.name,
        avatar: npc.avatar,
        castRole: 'supporting',
        description: firstSentence(npc.description) || '配角',
        systemPrompt: npc.description || '',
        memories: [],
        ...(memory ? { refinedMemories: { [`${monthKey(npc.memoryUpdatedAt || npc.updatedAt || Date.now())}（搬家前的記憶）`]: memory } } : {}),
        relationships: (npc.relationships || []).map(r => ({ ...r })),
        ...(npc.groupId ? { groupId: npc.groupId } : {}),
        ...(npc.worldview ? { worldview: npc.worldview } : {}),
        ...(npc.mountedWorldbooks?.length ? { mountedWorldbooks: npc.mountedWorldbooks } : {}),
        ...(npc.timeAwarenessEnabled !== undefined ? { timeAwarenessEnabled: npc.timeAwarenessEnabled } : {}),
        ...(npc.customTimezoneEnabled !== undefined ? { customTimezoneEnabled: npc.customTimezoneEnabled } : {}),
        ...(npc.customTimezone ? { customTimezone: npc.customTimezone } : {}),
        ...(npc.dateTimeAwarenessEnabled !== undefined ? { dateTimeAwarenessEnabled: npc.dateTimeAwarenessEnabled } : {}),
        ...(npc.chatApi?.baseUrl ? { chatApi: { ...npc.chatApi } } : {}),
        primaryPersonaKey: knownKey,
        knownPersonaKeys: [knownKey],
        contextLimit: DEFAULT_MANUAL_CONTEXT_LIMIT,
        contextRangeMode: 'manual',
        contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
        emotionConfig: { enabled: true },
    } as CharacterProfile;
}

/** 群：NPC 成員併進 members（去重），npcMemberIds 拿掉。沒有要搬的回 null。 */
export function migrateGroup(group: GroupProfile, movedIds: ReadonlySet<string>): GroupProfile | null {
    const moving = (group.npcMemberIds || []).filter(id => movedIds.has(id));
    if (!moving.length) return null;
    const rest = (group.npcMemberIds || []).filter(id => !movedIds.has(id));
    const members = [...group.members, ...moving.filter(id => !group.members.includes(id))];
    const next: GroupProfile = { ...group, members };
    if (rest.length) next.npcMemberIds = rest; else delete next.npcMemberIds;
    return next;
}

/** 查手機聯繫人：綁了搬走的 NPC 的，改成真角色聯繫人。沒有要改的回 null。 */
export function migrateContacts(contacts: PhoneContact[] | undefined, movedIds: ReadonlySet<string>): PhoneContact[] | null {
    if (!contacts?.some(c => c.kind === 'npc' && c.linkedNpcId && movedIds.has(c.linkedNpcId))) return null;
    return contacts.map(c => {
        if (c.kind !== 'npc' || !c.linkedNpcId || !movedIds.has(c.linkedNpcId)) return c;
        const { linkedNpcId, ...rest } = c;
        return { ...rest, kind: 'real' as const, linkedCharId: linkedNpcId };
    });
}

const actorOf = (a: MomentActor, movedIds: ReadonlySet<string>): MomentActor =>
    a.kind === 'npc' && a.id && movedIds.has(a.id) ? { ...a, kind: 'character' } : a;

/** 朋友圈：NPC 作者、按讚、留言改成角色。沒有要改的回 null。 */
export function migrateMomentPost(post: MomentPost, movedIds: ReadonlySet<string>): MomentPost | null {
    const touches = (a: MomentActor) => a.kind === 'npc' && !!a.id && movedIds.has(a.id);
    if (!touches(post.author) && !post.likes.some(l => touches(l.actor)) && !post.comments.some(c => touches(c.actor))) return null;
    return {
        ...post,
        author: actorOf(post.author, movedIds),
        likes: post.likes.map(l => ({ ...l, actor: actorOf(l.actor, movedIds) })),
        comments: post.comments.map(c => ({ ...c, actor: actorOf(c.actor, movedIds) })),
    };
}

/** 劇情劇場：客串的 NPC 併進演員（配角跟主角一樣有記憶）。沒有要改的回 null。 */
export function migrateTheater(entry: StoryTheaterEntry, movedIds: ReadonlySet<string>): StoryTheaterEntry | null {
    const moving = (entry.npcIds || []).filter(id => movedIds.has(id));
    if (!moving.length) return null;
    const rest = (entry.npcIds || []).filter(id => !movedIds.has(id));
    return {
        ...entry,
        characterIds: [...entry.characterIds, ...moving.filter(id => !entry.characterIds.includes(id))],
        npcIds: rest,
    };
}
