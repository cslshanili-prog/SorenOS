import type { CharacterProfile, MomentActor, MomentComment, MomentPost, MomentVisibility } from '../types';
import { DB } from './db';
import { deleteBlobRefIfUnreferenced } from './blobRef';
import { addCommentTo, pendingMigrations, removeCommentFrom, toggleLikeOn } from './momentsPool';

/**
 * 貼文池的讀寫入口：每次改動後廣播 MOMENTS_CHANGED_EVENT，開著的時間線聽到就重讀。
 * 純邏輯（誰看得到什麼）在 utils/momentsPool.ts。
 */

export const MOMENTS_CHANGED_EVENT = 'moments-changed';

const genId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const announce = () => {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(MOMENTS_CHANGED_EVENT));
};

export async function createMomentPost(params: {
    author: MomentActor;
    content: string;
    images?: string[];
    imagePrompt?: string;
    visibility?: MomentVisibility;
    source?: MomentPost['source'];
}): Promise<MomentPost> {
    const post: MomentPost = {
        id: genId('mom'),
        author: params.author,
        content: params.content.trim(),
        images: params.images || [],
        imagePrompt: params.imagePrompt,
        visibility: params.visibility || { mode: 'friends' },
        likes: [],
        comments: [],
        createdAt: Date.now(),
        source: params.source || 'manual',
    };
    await DB.saveMomentPosts([post]);
    announce();
    return post;
}

export async function toggleMomentLike(postId: string, actor: MomentActor): Promise<MomentPost | undefined> {
    const post = await DB.updateMomentPost(postId, prev => toggleLikeOn(prev, actor));
    announce();
    return post;
}

export async function addMomentComment(
    postId: string,
    actor: MomentActor,
    content: string,
    replyTo?: string,
): Promise<MomentComment | null> {
    const text = content.trim();
    if (!text) return null;
    const comment: MomentComment = { id: genId('momc'), actor, content: text, at: Date.now(), ...(replyTo ? { replyTo } : {}) };
    const post = await DB.updateMomentPost(postId, prev => addCommentTo(prev, comment));
    if (!post) return null;
    announce();
    return comment;
}

export async function deleteMomentComment(postId: string, commentId: string): Promise<void> {
    await DB.updateMomentPost(postId, prev => removeCommentFrom(prev, commentId));
    announce();
}

export async function updateMomentPostFields(postId: string, patch: Partial<Pick<MomentPost, 'images' | 'imagePrompt' | 'syncedMessageId' | 'visibility' | 'content'>>): Promise<MomentPost | undefined> {
    const post = await DB.updateMomentPost(postId, prev => ({ ...prev, ...patch }));
    announce();
    return post;
}

/**
 * 刪貼文：圖片沒人用了才刪；搬遷來的貼文同時從角色舊的軌跡 Moments 裡拿掉，
 * 不然下次啟動搬遷又會把它搬回來（removeLegacy 由調用方寫角色資料）。
 */
export async function deleteMomentPost(post: MomentPost, removeLegacy?: (charId: string, oldId: string) => void): Promise<void> {
    await DB.deleteMomentPost(post.id);
    if (post.source === 'migrated' && post.author.id && removeLegacy) removeLegacy(post.author.id, post.id.replace(/^mig-/, ''));
    announce();
    for (const image of post.images) void deleteBlobRefIfUnreferenced(image);
}

/**
 * 啟動時跑：把各角色舊的軌跡 Moments 搬進池子（固定 id，已經搬過的跳過，所以每次啟動都可以跑）。
 * 舊欄位先不刪，保留一個版本當退路。回傳搬了幾條。
 */
export async function migrateTrajectoryMomentsToPool(characters: CharacterProfile[]): Promise<number> {
    if (!characters.some(c => c.phoneState?.trajectoryMoments?.length)) return 0;
    const existing = await DB.getAllMomentPosts();
    const todo = pendingMigrations(characters, new Set(existing.map(p => p.id)));
    if (todo.length === 0) return 0;
    await DB.saveMomentPosts(todo);
    announce();
    return todo.length;
}
