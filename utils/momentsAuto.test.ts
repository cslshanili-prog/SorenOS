import { beforeEach, describe, expect, it } from 'vitest';
import type { MomentPost, NPCProfile } from '../types';
import { buildFriendGraph } from './momentsPool';
import {
    buildBatchCommentPrompt, dropJobsForPost, enqueueJobs, firstPostDueAt, JOB_STALE_MS, nextPostDueAt, parseBatchComments,
    planAuthorReply, planReactions, readJobs, reconcilePostSchedule, spreadBatchComments, takeDueJobs,
} from './momentsAuto';

const H = 3600_000;
const settings = {
    minPostIntervalHours: 48, maxPostIntervalHours: 72, likeProbability: 75, commentProbability: 40,
    npcLikeProbability: 75, npcCommentProbability: 20,
    firstCommentDelaySec: 120, commentIntervalSec: 60, npcInteractionDelayMin: 30, replyToNpcDelaySec: 3,
};

describe('發文排程', () => {
    it('下一次在最短～最長間隔之間', () => {
        expect(nextPostDueAt(0, settings, () => 0)).toBe(48 * H);
        expect(nextPostDueAt(0, settings, () => 1)).toBe(72 * H);
    });

    it('第一次不用等滿間隔：2 分鐘～6 小時', () => {
        expect(firstPostDueAt(0, settings, () => 0)).toBe(2 * 60_000);
        expect(firstPostDueAt(0, settings, () => 1)).toBe(6 * H);
        expect(firstPostDueAt(0, { minPostIntervalHours: 1 }, () => 1)).toBe(H);
    });

    it('整理排程：補上沒排過的、拿掉不能發的、回傳到期的（早的在前）', () => {
        const { schedule, due } = reconcilePostSchedule({ a: 50, b: 10, gone: 5 }, ['a', 'b', 'c'], 100, settings, () => 0);
        expect(Object.keys(schedule).sort()).toEqual(['a', 'b', 'c']);
        expect(schedule.c).toBe(100 + 2 * 60_000);
        expect(due).toEqual(['b', 'a']);
    });
});

describe('看到新貼文的反應', () => {
    const graph = buildFriendGraph([{ id: 'a' }, { id: 'b' }], [
        { id: 'n1', relationships: [{ id: 'r', targetId: 'user', description: '' }] },
        { id: 'n2', relationships: [] },
    ] as Pick<NPCProfile, 'id' | 'relationships'>[]);
    const userPost = { id: 'p1', author: { kind: 'user' as const, id: 'user', name: '我' }, visibility: { mode: 'friends' as const } };
    const candidates = [
        { id: 'a', kind: 'character' as const }, { id: 'b', kind: 'character' as const },
        { id: 'n1', kind: 'npc' as const }, { id: 'n2', kind: 'npc' as const },
    ];

    it('機率 100%：看得到的都按讚、角色一批留言、NPC 晚一批；看不到的（n2）不在內', () => {
        const jobs = planReactions({ post: userPost, graph, candidates, settings: { ...settings, likeProbability: 100, commentProbability: 100, npcLikeProbability: 100, npcCommentProbability: 100 }, now: 0, random: () => 0.5 });
        const likes = jobs.filter(j => j.type === 'like').map(j => (j as any).actorId);
        expect(likes).toEqual(['a', 'b', 'n1']);
        const batches = jobs.filter(j => j.type === 'commentBatch') as any[];
        expect(batches.map(b => b.actorIds)).toEqual([['a', 'b'], ['n1']]);
        expect(batches[0].dueAt).toBe(120_000);
        expect(batches[1].dueAt).toBe(30 * 60_000 + 120_000);
    });

    it('機率 0：什麼都不做；作者自己不會對自己的貼文反應', () => {
        expect(planReactions({ post: userPost, graph, candidates, settings: { ...settings, likeProbability: 0, commentProbability: 0, npcLikeProbability: 0, npcCommentProbability: 0 }, now: 0 })).toEqual([]);
        const charPost = { id: 'p2', author: { kind: 'character' as const, id: 'a', name: 'a' }, visibility: { mode: 'public' as const } };
        const jobs = planReactions({ post: charPost, graph, candidates, settings: { ...settings, likeProbability: 100, commentProbability: 0 }, now: 0, random: () => 0 });
        expect(jobs.map(j => (j as any).actorId)).not.toContain('a');
    });

    it('角色和 NPC 各用自己那組機率', () => {
        const jobs = planReactions({
            post: userPost, graph, candidates, now: 0, random: () => 0.5,
            settings: { ...settings, likeProbability: 0, commentProbability: 100, npcLikeProbability: 100, npcCommentProbability: 0 },
        });
        expect(jobs.filter(j => j.type === 'like').map(j => (j as any).actorId)).toEqual(['n1']);
        expect((jobs.filter(j => j.type === 'commentBatch') as any[]).map(b => b.actorIds)).toEqual([['a', 'b']]);
    });

    it('一批留言分開貼：間隔照設定', () => {
        const jobs = spreadBatchComments('p', [{ actorId: 'a', content: 'x' }, { actorId: 'b', content: 'y' }], 1000, 60);
        expect(jobs.map(j => j.dueAt)).toEqual([1000, 61_000]);
        expect(planAuthorReply('p', 'a', 'c1', 0, 3)).toMatchObject({ type: 'reply', actorId: 'a', replyTo: 'c1', dueAt: 3000 });
    });
});

describe('待辦佇列', () => {
    beforeEach(() => localStorage.clear());

    it('到期的取出、沒到期的留著、過期太久的丟掉；刪貼文清掉它的待辦', () => {
        enqueueJobs([
            { id: '1', type: 'like', postId: 'p', actorId: 'a', dueAt: 100 },
            { id: '2', type: 'like', postId: 'p', actorId: 'b', dueAt: 500 },
            { id: '3', type: 'like', postId: 'q', actorId: 'b', dueAt: 1000 },
            { id: '4', type: 'like', postId: 'q', actorId: 'c', dueAt: 200 - JOB_STALE_MS - 1 },
        ]);
        expect(takeDueJobs(200).map(j => j.id)).toEqual(['1']);
        expect(readJobs().map(j => j.id)).toEqual(['2', '3']);
        dropJobsForPost('p');
        expect(readJobs().map(j => j.id)).toEqual(['3']);
    });
});

describe('批次留言', () => {
    it('提示詞列出每位留言的人和 id', () => {
        const prompt = buildBatchCommentPrompt({
            authorName: '我', userName: '我', post: { content: '新髮型', images: [] }, thread: '',
            commenters: [{ id: 'a', name: '小雨', brief: '毒舌' }],
        });
        expect(prompt).toContain('- 小雨（id: a）：毒舌');
        expect(prompt).toContain('只輸出 JSON 陣列');
    });

    it('解析：只收名單裡的 id、同一人只收一則、去引號', () => {
        const parsed = parseBatchComments([
            { id: 'a', content: '「好看」' }, { id: 'a', content: '重複' }, { id: 'x', content: '不在名單' }, { id: 'b', content: '' },
        ], ['a', 'b']);
        expect(parsed).toEqual([{ actorId: 'a', content: '好看' }]);
        expect(parseBatchComments('not array', ['a'])).toEqual([]);
    });
});
