import type { APIConfig, CharacterProfile, MomentComment, MomentPost, NPCProfile } from '../types';
import { ContextBuilder } from './context';
import { resolveCharacterChatApi } from './characterApi';
import { safeResponseJson, extractContent } from './safeApi';
import { actorDisplayName, USER_ID } from './momentsPool';
import { addMomentComment } from './momentsStore';

/**
 * 用戶在角色的貼文底下留言 → 作者回一句（第一批只做這條；其他人接話、NPC 互動在第二批）。
 * 設計見 plans/moments-pool-design.md「生成與互動」。
 */

/** 作者回覆的提示詞（接在角色設定後面）。 */
export function buildAuthorReplyPrompt(params: {
    authorName: string;
    userName: string;
    post: Pick<MomentPost, 'content' | 'images'>;
    /** 作者自己看得到的留言，已經換成「名字: 內容」逐行 */
    thread: string;
    userComment: string;
    /** 用戶這則是回覆誰的（回覆作者自己時不用說） */
    replyingToName?: string;
}): string {
    const { authorName, userName, post, thread, userComment, replyingToName } = params;
    const photos = post.images.length ? `（配了 ${post.images.length} 張照片）` : '';
    return `你（${authorName}）在朋友圈發了一篇動態${photos}：
「${post.content || '（只有照片）'}」

底下目前的留言：
${thread || '（還沒有別人留言）'}

${userName}剛剛${replyingToName ? `回覆了${replyingToName}` : '在底下留言'}：「${userComment}」

用你平常的口吻回${userName}這則留言，一兩句就好，像真的在朋友圈回留言。延續你們的關係和最近聊過的事，不要客套。
只輸出回覆內容本身，不要帶名字、不要加引號。`;
}

/** 模型輸出收尾：去掉名字前綴、引號、多餘空行，太長截斷。 */
export function cleanMomentReply(raw: string, authorName: string): string {
    let text = raw.trim().replace(/^```[a-z]*\n?|```$/gi, '').trim();
    const prefix = new RegExp(`^(?:${authorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|我)\\s*[:：]\\s*`);
    text = text.replace(prefix, '').replace(/^[「『"“]|[」』"”]$/g, '').trim();
    text = text.split(/\n+/).map(s => s.trim()).filter(Boolean).join(' ');
    return text.slice(0, 200);
}

/**
 * 生成作者回覆並寫進貼文。失敗只記日誌（留言本身已經落地，回覆沒來不影響）。
 * delayMs：假裝作者過一會兒才看到，比較像真的。
 */
export async function replyAsAuthor(params: {
    char: CharacterProfile;
    post: MomentPost;
    userComment: MomentComment;
    userName: string;
    apiConfig: APIConfig;
    characters: CharacterProfile[];
    npcs: NPCProfile[];
    delayMs?: number;
}): Promise<void> {
    const { char, post, userComment, userName, apiConfig, characters, npcs, delayMs = 0 } = params;
    const api = resolveCharacterChatApi(char, apiConfig);
    if (!api.baseUrl || !api.apiKey) return;
    const nameOf = (c: MomentComment) => actorDisplayName(c.actor, characters, npcs, userName);
    const thread = post.comments
        .filter(c => c.id !== userComment.id)
        .map(c => `${c.actor.id === char.id ? '你' : nameOf(c)}: ${c.content}`)
        .join('\n');
    const replyTarget = userComment.replyTo ? post.comments.find(c => c.id === userComment.replyTo) : undefined;
    const replyingToName = replyTarget && replyTarget.actor.id !== char.id ? nameOf(replyTarget) : undefined;
    const prompt = buildAuthorReplyPrompt({ authorName: char.name, userName, post, thread, userComment: userComment.content, replyingToName });
    try {
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
        const response = await fetch(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey}` },
            body: JSON.stringify({
                model: api.model,
                messages: [{ role: 'system', content: ContextBuilder.buildRoleSettingsContext(char) }, { role: 'user', content: prompt }],
                temperature: 0.9,
            }),
        });
        if (!response.ok) throw new Error(`API 返回 ${response.status}`);
        const reply = cleanMomentReply(extractContent(await safeResponseJson(response)) || '', char.name);
        if (!reply) return;
        await addMomentComment(post.id, { kind: 'character', id: char.id, name: char.name }, reply, userComment.id);
    } catch (e) {
        console.warn(`[Moments] ${char.name} 回覆留言失敗`, e);
    }
}

/** 用戶這則留言該不該觸發作者回覆：貼文是角色發的、留言是用戶的。 */
export function shouldAuthorReply(post: Pick<MomentPost, 'author'>, comment: Pick<MomentComment, 'actor'>): boolean {
    return post.author.kind === 'character' && comment.actor.id === USER_ID;
}

/** 角色在別人的貼文底下留言的提示詞（查手機的軌跡 Moments「讓 TA 留言」）。 */
export function buildCharCommentPrompt(params: {
    charName: string;
    authorName: string;
    post: Pick<MomentPost, 'content' | 'images'>;
    thread: string;
}): string {
    const { charName, authorName, post, thread } = params;
    const photos = post.images.length ? `（配了 ${post.images.length} 張照片）` : '';
    return `你（${charName}）在朋友圈滑到${authorName}發的動態${photos}：
「${post.content || '（只有照片）'}」

底下目前的留言：
${thread || '（還沒有人留言）'}

用你平常的口吻在底下留一句言，一兩句就好，像真的在朋友圈留言。從你和${authorName}的關係出發，不要客套。
只輸出留言內容本身，不要帶名字、不要加引號。`;
}

/** 讓角色在某篇貼文底下留一句言；成功回傳 true。 */
export async function commentAsCharacter(params: {
    char: CharacterProfile;
    post: MomentPost;
    userName: string;
    apiConfig: APIConfig;
    characters: CharacterProfile[];
    npcs: NPCProfile[];
}): Promise<boolean> {
    const { char, post, userName, apiConfig, characters, npcs } = params;
    const api = resolveCharacterChatApi(char, apiConfig);
    if (!api.baseUrl || !api.apiKey) throw new Error('沒有可用的 API');
    const nameOf = (c: MomentComment) => actorDisplayName(c.actor, characters, npcs, userName);
    const thread = post.comments.map(c => `${c.actor.id === char.id ? '你' : nameOf(c)}: ${c.content}`).join('\n');
    const authorName = post.author.id === char.id ? '你自己' : actorDisplayName(post.author, characters, npcs, userName);
    const response = await fetch(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey}` },
        body: JSON.stringify({
            model: api.model,
            messages: [
                { role: 'system', content: ContextBuilder.buildRoleSettingsContext(char) },
                { role: 'user', content: buildCharCommentPrompt({ charName: char.name, authorName, post, thread }) },
            ],
            temperature: 0.9,
        }),
    });
    if (!response.ok) throw new Error(`API 返回 ${response.status}`);
    const text = cleanMomentReply(extractContent(await safeResponseJson(response)) || '', char.name);
    if (!text) return false;
    return !!(await addMomentComment(post.id, { kind: 'character', id: char.id, name: char.name }, text));
}
