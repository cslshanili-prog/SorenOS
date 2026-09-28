import type {
    CharacterProfile, MomentActor, MomentComment, MomentLike, MomentPost, NPCProfile, PhoneContact, TrajectoryMomentPost,
} from '../types';

/**
 * 單一貼文池的純邏輯（路線圖第 6 項，設計見 plans/moments-pool-design.md）：
 * 誰跟誰是朋友、誰看得到哪篇貼文、看得到哪些讚和留言，以及舊軌跡 Moments 的搬遷。
 * 不碰資料庫，全部可以單測。
 *
 * 參與者 id：'user' 是用戶本人；其他是角色 id 或 NPC id（NPC 靠 npcs 清單認出來）。
 */

export const USER_ID = 'user';

type FriendChar = Pick<CharacterProfile, 'id'> & { phoneState?: { contacts?: PhoneContact[] }; chatBlock?: CharacterProfile['chatBlock'] };
type FriendNpc = Pick<NPCProfile, 'id' | 'relationships'>;

export interface FriendGraph {
    areFriends(a: string, b: string): boolean;
    kindOf(id: string): 'user' | 'character' | 'npc';
    /** 兩人之間有拉黑（私聊拉黑或通訊錄拉黑／刪除）：連公開貼文都看不到。 */
    isBlocked(a: string, b: string): boolean;
    /**
     * 角色／NPC 跟「用戶的某張身份卡」是什麼關係（同一世界裡不同身份是不同的人，
     * 見 plans/multi-persona-isolation-design.md）：main＝它的主身份（私聊那條線），
     * seen＝在共同的群裡見過，stranger＝不認識。沒帶身份資料、或舊資料沒有身份鍵，一律算 main。
     */
    personaRelation?(viewerId: string, personaKey: string | undefined): 'main' | 'seen' | 'stranger';
    /** 身份鍵的名字（沒帶身份資料就 undefined，由調用方用自己的名字）。 */
    personaName?(personaKey: string | undefined): string | undefined;
}

/** 誰認識哪張身份卡（由 utils/momentsPersona.ts 的 buildPersonaKnowledge 從用戶資料和群組算出來）。 */
export interface PersonaKnowledge {
    /** 角色／NPC 的主身份鍵；不認得的 id 回 undefined（當成 main，寬鬆處理）。 */
    mainKeyOf(viewerId: string): string | undefined;
    /** 在共同的群裡見過的身份鍵（不含主身份）。 */
    seenKeysOf(viewerId: string): ReadonlySet<string>;
    nameOf(personaKey: string): string;
}

/**
 * 朋友關係（定案：角色之間單向就算）：
 * - 用戶 ↔ 角色：一律是朋友
 * - 用戶 ↔ NPC：NPC 的關係清單裡有 'user'
 * - 角色 ↔ 角色：任一方的查手機通訊錄把對方標成 friend
 * - 角色 ↔ NPC：NPC 的關係清單裡有這個角色，或角色通訊錄裡綁了這個 NPC、標成 friend
 * - NPC ↔ NPC：不是朋友
 * 任何一方的通訊錄把另一方拉黑或刪掉，就不是朋友（優先於上面所有規則）。
 * 用戶跟角色之間私聊拉黑中（不管誰拉黑誰，見 utils/chatBlock.ts）也一樣。
 */
export function buildFriendGraph(characters: FriendChar[], npcs: FriendNpc[], personas?: PersonaKnowledge): FriendGraph {
    const npcById = new Map(npcs.map(n => [n.id, n]));
    const charById = new Map(characters.map(c => [c.id, c]));
    const kindOf = (id: string): 'user' | 'character' | 'npc' =>
        id === USER_ID ? 'user' : npcById.has(id) ? 'npc' : 'character';

    /** 角色 a 的通訊錄裡指向 b 的那條（真角色或綁定 NPC） */
    const contactOf = (a: string, b: string): PhoneContact | undefined =>
        (charById.get(a)?.phoneState?.contacts || []).find(c => c.linkedCharId === b || c.linkedNpcId === b);
    const blocks = (a: string, b: string): boolean => {
        if (a === USER_ID) return !!charById.get(b)?.chatBlock;
        const status = contactOf(a, b)?.status;
        return status === 'blocked' || status === 'deleted';
    };
    const isBlocked = (a: string, b: string): boolean => a !== b && (blocks(a, b) || blocks(b, a));
    const listsFriend = (a: string, b: string): boolean => contactOf(a, b)?.status === 'friend';
    const npcKnows = (npcId: string, other: string): boolean =>
        !!npcById.get(npcId)?.relationships.some(r => r.targetId === other);

    const areFriends = (a: string, b: string): boolean => {
        if (a === b) return true;
        if (isBlocked(a, b)) return false;
        const ka = kindOf(a);
        const kb = kindOf(b);
        if (ka === 'npc' && kb === 'npc') return false;
        if (ka === 'user' || kb === 'user') {
            const other = ka === 'user' ? b : a;
            return kindOf(other) === 'character' ? true : npcKnows(other, USER_ID);
        }
        if (ka === 'npc' || kb === 'npc') {
            const [npc, char] = ka === 'npc' ? [a, b] : [b, a];
            return npcKnows(npc, char) || listsFriend(char, npc);
        }
        return listsFriend(a, b) || listsFriend(b, a);
    };

    const personaRelation = (viewerId: string, personaKey: string | undefined): 'main' | 'seen' | 'stranger' => {
        if (!personas || !personaKey || viewerId === USER_ID) return 'main';
        const main = personas.mainKeyOf(viewerId);
        if (main === undefined || main === personaKey) return 'main';
        return personas.seenKeysOf(viewerId).has(personaKey) ? 'seen' : 'stranger';
    };
    const personaName = (personaKey: string | undefined): string | undefined =>
        personas && personaKey ? personas.nameOf(personaKey) : undefined;

    return { areFriends, kindOf, isBlocked, personaRelation, personaName };
}

/** 這個人看不看得到這篇貼文。 */
export function canViewMoment(viewerId: string, post: Pick<MomentPost, 'author' | 'visibility'>, graph: FriendGraph): boolean {
    const authorId = post.author.id;
    if (!authorId) return post.visibility.mode === 'public';
    if (authorId === viewerId) return true;
    if (graph.isBlocked?.(authorId, viewerId)) return false;
    const { mode, allow } = post.visibility;
    if (mode === 'public') return true;
    if (mode === 'custom') return !!allow?.includes(viewerId);
    // 用戶用別的身份發的「朋友可見」：對這個角色來說不是朋友（見過的是群友、不是好友）
    if (post.author.kind === 'user' && graph.personaRelation && graph.personaRelation(viewerId, post.author.personaKey) !== 'main') return false;
    return graph.areFriends(authorId, viewerId);
}

/**
 * 互動可見範圍（定案：微信式）：看得到的讚和留言，只有自己的、作者的、自己朋友的，
 * 以及從舊資料搬來的路人留言。
 */
export function canSeeInteraction(viewerId: string, actor: MomentActor, authorId: string | undefined, graph: FriendGraph): boolean {
    if (actor.kind === 'stranger' || !actor.id) return true;
    if (actor.id === viewerId || actor.id === authorId) return true;
    // 用戶用別的身份留的讚／言：只有貼文作者本人看得到（別人不是它的朋友）
    if (actor.kind === 'user' && graph.personaRelation && graph.personaRelation(viewerId, actor.personaKey) !== 'main') return false;
    return graph.areFriends(actor.id, viewerId);
}

export function visibleLikes(viewerId: string, post: MomentPost, graph: FriendGraph): MomentLike[] {
    return post.likes.filter(l => canSeeInteraction(viewerId, l.actor, post.author.id, graph));
}

export function visibleComments(viewerId: string, post: MomentPost, graph: FriendGraph): MomentComment[] {
    return post.comments.filter(c => canSeeInteraction(viewerId, c.actor, post.author.id, graph));
}

/** 這個人看到的時間線：看得到的貼文，新的在前。 */
export function momentFeedFor(viewerId: string, posts: MomentPost[], graph: FriendGraph): MomentPost[] {
    return posts.filter(p => canViewMoment(viewerId, p, graph)).sort((a, b) => b.createdAt - a.createdAt);
}

/** 顯示用的讚數：看得到的真人讚 + 舊資料的假讚數。 */
export function displayLikeCount(viewerId: string, post: MomentPost, graph: FriendGraph): number {
    return visibleLikes(viewerId, post, graph).length + (post.legacyLikeCount || 0);
}

// ── 參與者 ───────────────────────────────────────────────────────────

/** 把 id 變成帶名字快照的參與者；找不到的角色／NPC 回 null。 */
export function actorFor(
    id: string,
    characters: Array<Pick<CharacterProfile, 'id' | 'name'>>,
    npcs: Array<Pick<NPCProfile, 'id' | 'name'>>,
    userName: string,
    /** 用戶用哪張身份卡（身份鍵）；不給就是舊的「所有人都認識的你」 */
    personaKey?: string,
): MomentActor | null {
    if (id === USER_ID) return { kind: 'user', id: USER_ID, name: userName.trim() || '我', ...(personaKey ? { personaKey } : {}) };
    const npc = npcs.find(n => n.id === id);
    if (npc) return { kind: 'npc', id, name: npc.name };
    const char = characters.find(c => c.id === id);
    return char ? { kind: 'character', id, name: char.name } : null;
}

/**
 * 展示名：角色／NPC 用現在的名字（改名跟著變），刪掉了用快照。
 * 用戶：有身份鍵且好友圖帶了身份資料 → 那張身份卡現在的名字；否則用傳進來的名字（看的人認識的那個你）。
 */
export function actorDisplayName(
    actor: MomentActor,
    characters: Array<Pick<CharacterProfile, 'id' | 'name'>>,
    npcs: Array<Pick<NPCProfile, 'id' | 'name'>>,
    userName: string,
    graph?: Pick<FriendGraph, 'personaName'>,
): string {
    if (actor.kind === 'user') return graph?.personaName?.(actor.personaKey) || userName.trim() || actor.name;
    if (actor.kind === 'npc') return npcs.find(n => n.id === actor.id)?.name || actor.name;
    if (actor.kind === 'character') return characters.find(c => c.id === actor.id)?.name || actor.name;
    return actor.name;
}

// ── 改動（純函數，給 DB.updateMomentPost 的 updater 用）──────────────────

export function toggleLikeOn(post: MomentPost, actor: MomentActor, now: number = Date.now()): MomentPost {
    const liked = post.likes.some(l => l.actor.id === actor.id);
    return {
        ...post,
        likes: liked ? post.likes.filter(l => l.actor.id !== actor.id) : [...post.likes, { actor, at: now }],
    };
}

export function addCommentTo(post: MomentPost, comment: MomentComment): MomentPost {
    if (post.comments.some(c => c.id === comment.id)) return post;
    return { ...post, comments: [...post.comments, comment] };
}

export function removeCommentFrom(post: MomentPost, commentId: string): MomentPost {
    return { ...post, comments: post.comments.filter(c => c.id !== commentId) };
}

// ── 搬遷：軌跡 Moments → 貼文池 ──────────────────────────────────────

/** 搬遷來的貼文 id 固定由舊 id 推出來，重跑不會重複。 */
export const migratedMomentId = (oldId: string) => `mig-${oldId}`;

/** 一條舊的軌跡 Moments 轉成池子裡的貼文：作者是這個角色、朋友可見，假讚數和路人評論原樣保留。 */
export function migrateTrajectoryMoment(char: Pick<CharacterProfile, 'id' | 'name'>, old: TrajectoryMomentPost): MomentPost {
    return {
        id: migratedMomentId(old.id),
        author: { kind: 'character', id: char.id, name: char.name },
        content: old.content,
        images: old.image ? [old.image] : [],
        imagePrompt: old.imagePrompt || undefined,
        visibility: { mode: 'friends' },
        likes: [],
        comments: (old.comments || []).map(c => ({
            id: `mig-${c.id}`,
            actor: { kind: 'stranger' as const, name: c.authorName || '路人' },
            content: c.content,
            at: old.timestamp,
        })),
        legacyLikeCount: Math.max(0, Math.round(old.likes || 0)) || undefined,
        createdAt: old.timestamp,
        source: 'migrated',
        syncedMessageId: old.syncedMessageId,
    };
}

/** 還沒搬進池子的舊貼文（按固定 id 比對，已經在池子裡的跳過）。 */
export function pendingMigrations(
    characters: Array<Pick<CharacterProfile, 'id' | 'name' | 'phoneState'>>,
    existingIds: ReadonlySet<string>,
): MomentPost[] {
    const out: MomentPost[] = [];
    for (const char of characters) {
        for (const old of char.phoneState?.trajectoryMoments || []) {
            if (!old?.id || existingIds.has(migratedMomentId(old.id))) continue;
            out.push(migrateTrajectoryMoment(char, old));
        }
    }
    return out;
}
