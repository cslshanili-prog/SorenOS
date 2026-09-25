import type { MomentPost, MomentsInteractionSettings } from '../types';
import { canViewMoment, USER_ID, type FriendGraph } from './momentsPool';

/**
 * 朋友圈第二批（路線圖第 6 項，設計見 plans/moments-pool-design.md「生成與互動」）的純邏輯：
 * - 自動發文：每個能發的角色／NPC 各自排下一次發文時間（最短～最長間隔之間隨機）；
 * - 看到新貼文的反應：每個看得到的角色／NPC 各擲一次按讚、留言的骰子，排成待辦；
 * - 待辦存在 localStorage，App 開著時由 utils/momentsAutoRuntime.ts 到點執行，重新整理後接著跑。
 * 自動發文受「自動發帖」總開關管；看到新貼文的反應照按讚／留言機率走（調成 0 就不會發生）。
 */

const HOUR = 3600_000;
const MINUTE = 60_000;

// ── 自動發文排程 ──────────────────────────────────────────────────────

/** 下一次發文時間：現在往後「最短～最長間隔」之間隨機。 */
export function nextPostDueAt(now: number, settings: Pick<MomentsInteractionSettings, 'minPostIntervalHours' | 'maxPostIntervalHours'>, random: () => number = Math.random): number {
    const min = settings.minPostIntervalHours * HOUR;
    const max = Math.max(min, settings.maxPostIntervalHours * HOUR);
    return now + min + Math.round((max - min) * random());
}

/**
 * 第一次排：不用等滿一整個間隔（預設 48 小時，開了總開關會以為壞了），
 * 在 2 分鐘～min(最短間隔, 6 小時) 之間隨機，大家錯開。
 */
export function firstPostDueAt(now: number, settings: Pick<MomentsInteractionSettings, 'minPostIntervalHours'>, random: () => number = Math.random): number {
    const lo = 2 * MINUTE;
    const hi = Math.max(lo, Math.min(settings.minPostIntervalHours * HOUR, 6 * HOUR));
    return now + lo + Math.round((hi - lo) * random());
}

const SCHEDULE_KEY = 'soren_moments_next_post';

export function readPostSchedule(): Record<string, number> {
    try {
        const parsed = JSON.parse(localStorage.getItem(SCHEDULE_KEY) || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

export function writePostSchedule(schedule: Record<string, number>): void {
    try { localStorage.setItem(SCHEDULE_KEY, JSON.stringify(schedule)); } catch { /* 存不進去就每次重排 */ }
}

/**
 * 對一份排程做一次整理：沒排過的補上第一次、不能再發的拿掉，回傳新排程和現在到期的人（最早到期的排前面）。
 */
export function reconcilePostSchedule(
    schedule: Record<string, number>,
    posterIds: string[],
    now: number,
    settings: Pick<MomentsInteractionSettings, 'minPostIntervalHours'>,
    random: () => number = Math.random,
): { schedule: Record<string, number>; due: string[] } {
    const next: Record<string, number> = {};
    for (const id of posterIds) next[id] = typeof schedule[id] === 'number' ? schedule[id] : firstPostDueAt(now, settings, random);
    const due = posterIds.filter(id => next[id] <= now).sort((a, b) => next[a] - next[b]);
    return { schedule: next, due };
}

// ── 看到新貼文的反應 ──────────────────────────────────────────────────

export type MomentJob =
    | { id: string; type: 'like'; postId: string; actorId: string; dueAt: number }
    /** 一批人一起留言：一次呼叫模型，每人一句 */
    | { id: string; type: 'commentBatch'; postId: string; actorIds: string[]; dueAt: number }
    /** 已經生成好的留言，到點才貼出來（一批裡第二則以後） */
    | { id: string; type: 'postComment'; postId: string; actorId: string; content: string; replyTo?: string; dueAt: number }
    /** 作者回覆某則留言（角色回 NPC 的留言） */
    | { id: string; type: 'reply'; postId: string; actorId: string; replyTo: string; dueAt: number };

const genJobId = () => `mj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/**
 * 一篇新貼文發出來後，誰會按讚、誰會留言、什麼時候。
 * - 作者自己、用戶不在內（用戶自己動手）；看不到這篇的人不在內；
 * - 角色和 NPC 各用自己那組機率（NPC 的在設定頁單獨一區）；
 * - 讚：在「首則留言延遲」之內隨機一個時間點（沒有 API 成本）；
 * - 留言：角色一批在「首則留言延遲」後，NPC 一批再多等「NPC 互動延遲」。
 */
export function planReactions(params: {
    post: Pick<MomentPost, 'id' | 'author' | 'visibility'>;
    graph: FriendGraph;
    candidates: Array<{ id: string; kind: 'character' | 'npc' }>;
    settings: Pick<MomentsInteractionSettings, 'likeProbability' | 'commentProbability' | 'npcLikeProbability' | 'npcCommentProbability' | 'firstCommentDelaySec' | 'npcInteractionDelayMin'>;
    now: number;
    random?: () => number;
}): MomentJob[] {
    const { post, graph, candidates, settings, now, random = Math.random } = params;
    const firstDelay = settings.firstCommentDelaySec * 1000;
    const npcDelay = settings.npcInteractionDelayMin * MINUTE;
    const jobs: MomentJob[] = [];
    const commenters: Record<'character' | 'npc', string[]> = { character: [], npc: [] };
    for (const c of candidates) {
        if (c.id === USER_ID || c.id === post.author.id) continue;
        if (!canViewMoment(c.id, post, graph)) continue;
        const isNpc = c.kind === 'npc';
        const extra = isNpc ? npcDelay : 0;
        if (random() * 100 < (isNpc ? settings.npcLikeProbability : settings.likeProbability)) {
            jobs.push({ id: genJobId(), type: 'like', postId: post.id, actorId: c.id, dueAt: now + extra + Math.round(Math.max(firstDelay, 15_000) * random()) });
        }
        if (random() * 100 < (isNpc ? settings.npcCommentProbability : settings.commentProbability)) commenters[c.kind].push(c.id);
    }
    if (commenters.character.length) {
        jobs.push({ id: genJobId(), type: 'commentBatch', postId: post.id, actorIds: commenters.character, dueAt: now + firstDelay });
    }
    if (commenters.npc.length) {
        jobs.push({ id: genJobId(), type: 'commentBatch', postId: post.id, actorIds: commenters.npc, dueAt: now + npcDelay + firstDelay });
    }
    return jobs;
}

/** 一批留言生成完：第一則馬上貼，其餘每隔「後續留言間隔」貼一則。 */
export function spreadBatchComments(
    postId: string,
    comments: Array<{ actorId: string; content: string }>,
    now: number,
    intervalSec: number,
): MomentJob[] {
    return comments.map((c, i) => ({
        id: genJobId(), type: 'postComment' as const, postId, actorId: c.actorId, content: c.content,
        dueAt: now + i * intervalSec * 1000,
    }));
}

export function planAuthorReply(postId: string, authorId: string, commentId: string, now: number, delaySec: number): MomentJob {
    return { id: genJobId(), type: 'reply', postId, actorId: authorId, replyTo: commentId, dueAt: now + delaySec * 1000 };
}

// ── 待辦佇列（localStorage）────────────────────────────────────────────

const QUEUE_KEY = 'soren_moments_jobs';
/** 佇列上限：太久沒開 App 堆積的舊待辦，超過就丟最舊的 */
const QUEUE_MAX = 200;
/** 過期太久的待辦不做了（例如好幾天沒開 App，回來一次噴一堆留言很怪） */
export const JOB_STALE_MS = 24 * HOUR;

export function readJobs(): MomentJob[] {
    try {
        const parsed = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
        return Array.isArray(parsed) ? parsed.filter(j => j && typeof j.dueAt === 'number' && typeof j.postId === 'string') : [];
    } catch {
        return [];
    }
}

function writeJobs(jobs: MomentJob[]): void {
    try {
        const kept = [...jobs].sort((a, b) => a.dueAt - b.dueAt).slice(-QUEUE_MAX);
        if (kept.length === 0) localStorage.removeItem(QUEUE_KEY);
        else localStorage.setItem(QUEUE_KEY, JSON.stringify(kept));
    } catch { /* 存不進去就只剩這次開著時做得到的 */ }
}

export function enqueueJobs(jobs: MomentJob[]): void {
    if (jobs.length) writeJobs([...readJobs(), ...jobs]);
}

/** 取出到期的待辦（從佇列移除）；過期太久的直接丟掉。 */
export function takeDueJobs(now: number): MomentJob[] {
    const all = readJobs();
    const due: MomentJob[] = [];
    const rest: MomentJob[] = [];
    for (const j of all) {
        if (j.dueAt > now) rest.push(j);
        else if (now - j.dueAt <= JOB_STALE_MS) due.push(j);
    }
    if (due.length || rest.length !== all.length) writeJobs(rest);
    return due.sort((a, b) => a.dueAt - b.dueAt);
}

/** 貼文刪掉了：它的待辦一起清掉。 */
export function dropJobsForPost(postId: string): void {
    const all = readJobs();
    const rest = all.filter(j => j.postId !== postId);
    if (rest.length !== all.length) writeJobs(rest);
}

// ── 批次留言的提示詞與解析 ──────────────────────────────────────────────

export function buildBatchCommentPrompt(params: {
    authorName: string;
    post: Pick<MomentPost, 'content' | 'images'>;
    thread: string;
    commenters: Array<{ id: string; name: string; brief: string }>;
    userName: string;
}): string {
    const { authorName, post, thread, commenters, userName } = params;
    const photos = post.images.length ? `（配了 ${post.images.length} 張照片）` : '';
    const list = commenters.map(c => `- ${c.name}（id: ${c.id}）：${c.brief || '（沒有更多設定）'}`).join('\n');
    return `朋友圈裡，${authorName}發了一篇動態${photos}：
「${post.content || '（只有照片）'}」

底下目前的留言：
${thread || '（還沒有人留言）'}

下面這幾位滑到了這篇，各自想留一句言：
${list}

替每一位寫一句留言，一兩句就好，口吻要符合各自的設定和跟${authorName}的關係，像真的在朋友圈留言；彼此可以不一樣，不要全都在誇。
${authorName === userName ? `${userName}是這篇的作者，也是大家都認識的人。` : ''}
只輸出 JSON 陣列，不要其他文字：[{"id": "留言的人的 id", "content": "留言內容"}]`;
}

/** 解析批次留言：只收名單裡的 id，內容去引號、截斷；解析不了回空陣列。 */
export function parseBatchComments(json: unknown, allowedIds: string[]): Array<{ actorId: string; content: string }> {
    if (!Array.isArray(json)) return [];
    const seen = new Set<string>();
    const out: Array<{ actorId: string; content: string }> = [];
    for (const item of json) {
        if (!item || typeof item !== 'object') continue;
        const id = String((item as any).id ?? '').trim();
        const content = String((item as any).content ?? '').trim().replace(/^[「『"“]|[」』"”]$/g, '').trim();
        if (!allowedIds.includes(id) || seen.has(id) || !content) continue;
        seen.add(id);
        out.push({ actorId: id, content: content.slice(0, 200) });
    }
    return out;
}
