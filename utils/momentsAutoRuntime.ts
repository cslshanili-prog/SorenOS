import type { APIConfig, CharacterProfile, MomentPost, NPCProfile, UserProfile } from '../types';
import { DB } from './db';
import { safeResponseJson, extractContent, extractJson } from './safeApi';
import { normalizeMomentsSettings, canAutoPost } from './momentsSettings';
import { actorDisplayName, actorFor, buildFriendGraph, canViewMoment, USER_ID } from './momentsPool';
import { addMomentComment, toggleMomentLike } from './momentsStore';
import {
    buildBatchCommentPrompt, enqueueJobs, nextPostDueAt, parseBatchComments, planAuthorReply, planReactions,
    readPostSchedule, reconcilePostSchedule, spreadBatchComments, takeDueJobs, writePostSchedule, type MomentJob,
} from './momentsAuto';
import { generateCharacterMoment, generateNpcMoment } from './momentsGenerate';
import { replyAsAuthor } from './momentsReply';
import { characterVoice, npcVoice, relationToAuthor } from './momentsVoice';

/**
 * 朋友圈第二批的執行層：OSContext 在 App 開著時每分鐘調一次 runMomentsAutomation，
 * 新貼文發出來時調 scheduleReactionsForPost。純邏輯在 utils/momentsAuto.ts。
 * 生成失敗只記日誌；自動發文失敗的人往後推 30 分鐘，免得每分鐘重試燒 API。
 */

export interface MomentsRuntimeContext {
    characters: CharacterProfile[];
    npcs: NPCProfile[];
    userProfile: UserProfile;
    apiConfig: APIConfig;
}

const RETRY_LATER_MS = 30 * 60_000;


/** 新貼文 → 看得到的角色／NPC 各擲一次按讚、留言的骰子，排進待辦。 */
export function scheduleReactionsForPost(post: MomentPost, ctx: MomentsRuntimeContext): number {
    const settings = normalizeMomentsSettings(ctx.userProfile.momentsSettings);
    if ([settings.likeProbability, settings.commentProbability, settings.npcLikeProbability, settings.npcCommentProbability].every(p => p <= 0)) return 0;
    const graph = buildFriendGraph(ctx.characters, ctx.npcs);
    const jobs = planReactions({
        post, graph, settings, now: Date.now(),
        candidates: [
            ...ctx.characters.map(c => ({ id: c.id, kind: 'character' as const })),
            ...ctx.npcs.map(n => ({ id: n.id, kind: 'npc' as const })),
        ],
    });
    enqueueJobs(jobs);
    return jobs.length;
}

let running = false;

/** 跑一輪：先做到期的待辦，再看有沒有人該自動發文（一輪最多發一篇）。 */
export async function runMomentsAutomation(ctx: MomentsRuntimeContext): Promise<void> {
    if (running) return;
    running = true;
    try {
        for (const job of takeDueJobs(Date.now())) {
            try {
                await executeJob(job, ctx);
            } catch (e) {
                console.warn('[Moments] 自動互動失敗', job.type, e);
            }
        }
        await maybeAutoPost(ctx);
    } finally {
        running = false;
    }
}

async function maybeAutoPost(ctx: MomentsRuntimeContext): Promise<void> {
    const settings = normalizeMomentsSettings(ctx.userProfile.momentsSettings);
    if (!settings.autoPostEnabled) return;
    // 私聊拉黑中的角色不自動發：用戶看不到，白花 API
    const posterIds = [...ctx.characters.filter(c => !c.chatBlock).map(c => c.id), ...ctx.npcs.map(n => n.id)].filter(id => canAutoPost(settings, id));
    const now = Date.now();
    const { schedule, due } = reconcilePostSchedule(readPostSchedule(), posterIds, now, settings);
    if (due.length === 0) { writePostSchedule(schedule); return; }
    const posterId = due[0];
    // 先把下一次排好再生成：生成要十幾秒，這段時間裡再被觸發也不會重複發
    schedule[posterId] = nextPostDueAt(now, settings);
    writePostSchedule(schedule);
    try {
        const recent = (await DB.getAllMomentPosts()).filter(p => p.author.id === posterId).slice(0, 5);
        const char = ctx.characters.find(c => c.id === posterId);
        const npc = char ? undefined : ctx.npcs.find(n => n.id === posterId);
        if (char) await generateCharacterMoment({ char, apiConfig: ctx.apiConfig, recent, source: 'auto' });
        else if (npc) await generateNpcMoment({ npc, apiConfig: ctx.apiConfig, recent, source: 'auto' });
    } catch (e) {
        console.warn('[Moments] 自動發文失敗，30 分鐘後再試', posterId, e);
        const again = readPostSchedule();
        again[posterId] = Date.now() + RETRY_LATER_MS;
        writePostSchedule(again);
    }
}

async function executeJob(job: MomentJob, ctx: MomentsRuntimeContext): Promise<void> {
    const post = await DB.getMomentPost(job.postId);
    if (!post) return;
    const graph = buildFriendGraph(ctx.characters, ctx.npcs);
    const userName = ctx.userProfile.name || '用戶';
    const canAct = (id: string) => canViewMoment(id, post, graph) && !!actorFor(id, ctx.characters, ctx.npcs, userName);

    if (job.type === 'like') {
        if (!canAct(job.actorId) || post.likes.some(l => l.actor.id === job.actorId)) return;
        await toggleMomentLike(post.id, actorFor(job.actorId, ctx.characters, ctx.npcs, userName)!);
        return;
    }

    if (job.type === 'commentBatch') {
        const actorIds = job.actorIds.filter(id => canAct(id) && !post.comments.some(c => c.actor.id === id));
        if (actorIds.length === 0 || !ctx.apiConfig.baseUrl || !ctx.apiConfig.apiKey) return;
        const nameOf = (id: string) => actorFor(id, ctx.characters, ctx.npcs, userName)?.name || '';
        const commenters = actorIds.map(id => {
            const char = ctx.characters.find(c => c.id === id);
            const npc = ctx.npcs.find(n => n.id === id);
            // 挑講個性、說話方式的句子，不再只截開頭（見 utils/momentsVoice.ts）
            const brief = char ? characterVoice(char) : npc ? npcVoice(npc) : '';
            const relation = relationToAuthor({ commenterId: id, authorId: post.author.id, characters: ctx.characters, npcs: ctx.npcs });
            return { id, name: nameOf(id), brief, relation };
        });
        const authorName = post.author.id === USER_ID ? userName : actorDisplayName(post.author, ctx.characters, ctx.npcs, userName);
        const thread = post.comments.map(c => `${actorDisplayName(c.actor, ctx.characters, ctx.npcs, userName)}: ${c.content}`).join('\n');
        const prompt = buildBatchCommentPrompt({ authorName, post, thread, commenters, userName });
        // 一批人一起留言只打一次：用全局 API（通常比角色專屬的主對話模型便宜）
        const response = await fetch(`${ctx.apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ctx.apiConfig.apiKey}` },
            body: JSON.stringify({ model: ctx.apiConfig.model, messages: [{ role: 'user', content: prompt }], temperature: 0.9 }),
        });
        if (!response.ok) throw new Error(`API 返回 ${response.status}`);
        const comments = parseBatchComments(extractJson(extractContent(await safeResponseJson(response))), actorIds);
        const settings = normalizeMomentsSettings(ctx.userProfile.momentsSettings);
        const spread = spreadBatchComments(post.id, comments, Date.now(), settings.commentIntervalSec);
        // 第一則馬上貼，其餘排進待辦
        const [first, ...rest] = spread;
        enqueueJobs(rest);
        if (first) await executeJob(first, ctx);
        return;
    }

    if (job.type === 'postComment') {
        if (!canAct(job.actorId)) return;
        const actor = actorFor(job.actorId, ctx.characters, ctx.npcs, userName)!;
        const comment = await addMomentComment(post.id, actor, job.content, job.replyTo);
        // NPC 在角色的貼文底下留言 → 作者過一下回覆（「角色回覆 NPC 留言延遲」）
        if (comment && actor.kind === 'npc' && post.author.kind === 'character' && post.author.id) {
            const settings = normalizeMomentsSettings(ctx.userProfile.momentsSettings);
            enqueueJobs([planAuthorReply(post.id, post.author.id, comment.id, Date.now(), settings.replyToNpcDelaySec)]);
        }
        return;
    }

    if (job.type === 'reply') {
        const char = ctx.characters.find(c => c.id === job.actorId);
        const target = post.comments.find(c => c.id === job.replyTo);
        if (!char || !target || post.author.id !== char.id) return;
        if (post.comments.some(c => c.replyTo === target.id && c.actor.id === char.id)) return;
        await replyAsAuthor({ char, post, userComment: target, userName, apiConfig: ctx.apiConfig, characters: ctx.characters, npcs: ctx.npcs });
    }
}
