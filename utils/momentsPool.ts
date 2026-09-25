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
export function buildFriendGraph(characters: FriendChar[], npcs: FriendNpc[]): FriendGraph {
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

    return { areFriends, kindOf, isBlocked };
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
    return graph.areFriends(authorId, viewerId);
}

/**
 * 互動可見範圍（定案：微信式）：看得到的讚和留言，只有自己的、作者的、自己朋友的，
 * 以及從舊資料搬來的路人留言。
 */
export function canSeeInteraction(viewerId: string, actor: MomentActor, authorId: string | undefined, graph: FriendGraph): boolean {
    if (actor.kind === 'stranger' || !actor.id) return true;
    if (actor.id === viewerId || actor.id === authorId) return true;
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
): MomentActor | null {
    if (id === USER_ID) return { kind: 'user', id: USER_ID, name: userName.trim() || '我' };
    const npc = npcs.find(n => n.id === id);
    if (npc) return { kind: 'npc', id, name: npc.name };
    const char = characters.find(c => c.id === id);
    return char ? { kind: 'character', id, name: char.name } : null;
}

/** 展示名：角色／NPC 用現在的名字（改名跟著變），刪掉了用快照；用戶用傳進來的名字。 */
export function actorDisplayName(
    actor: MomentActor,
    characters: Array<Pick<CharacterProfile, 'id' | 'name'>>,
    npcs: Array<Pick<NPCProfile, 'id' | 'name'>>,
    userName: string,
): string {
    if (actor.kind === 'user') return userName.trim() || actor.name;
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
