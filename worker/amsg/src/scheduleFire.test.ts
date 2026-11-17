// 日程自動生成在 worker 那一側（plans/calendar.md 第 5 批）：讀 standing job → 算目標日 → 拼提示詞 → 結果送回收件箱
import { describe, expect, it, vi } from 'vitest';
import { scheduleGenerateHandler } from './scheduleFire';
import { packStateValue } from '../../../utils/amsgFirePack';
import { buildScheduleJobInput, scheduleJobKey, SCHEDULE_GENERATE_RESULT_KIND } from '../../../utils/amsgScheduleJob';
import { AMSG_JOB_NAMESPACE } from '../../../utils/amsgTaskKinds';

const NOW = new Date('2026-11-17T14:00:00Z'); // 台北 22:00
const job = (over: Record<string, unknown> = {}) => buildScheduleJobInput({
    charId: 'c1', charName: '宋時聿', userName: '小林', style: 'lifestyle', tzId: 'Asia/Taipei', ahead: 1,
    baseContext: '（人設）', chatHistoryBlock: '', refreshedAt: NOW.getTime() - 1000,
    days: [{ date: '2026-11-17', extra: '' }, { date: '2026-11-18', extra: '\n## 這天已經約好的事\n- 14:00 看展\n' }],
    ...over,
} as any);

const ctxFor = async (value: string | null) => ({
    task: { id: 1, metadata: {} },
    readState: vi.fn(async (ns: string) => (ns === AMSG_JOB_NAMESPACE && value !== null ? [{ key: scheduleJobKey('c1'), value }] : [])),
    now: NOW,
    scratch: {},
});

describe('beforeFire', () => {
    it('算出明天、挑那天的段拼提示詞', async () => {
        const ctx = await ctxFor(await packStateValue(JSON.stringify(job())));
        const plan = await scheduleGenerateHandler.beforeFire({ ctx, charId: 'c1', taskMeta: {} });
        expect('skip' in plan).toBe(false);
        if ('skip' in plan) return;
        expect(plan.messages[0].content).toContain('2026-11-18');
        expect(plan.messages[0].content).toContain('看展');
        expect((plan.state as any).dateKey).toBe('2026-11-18');
    });

    it('輸入不在、太久沒刷、沒那天的段都安靜跳過；壞數據硬失敗', async () => {
        expect(await scheduleGenerateHandler.beforeFire({ ctx: await ctxFor(null), charId: 'c1', taskMeta: {} })).toMatchObject({ skip: true });
        expect(await scheduleGenerateHandler.beforeFire({ ctx: await ctxFor(''), charId: 'c1', taskMeta: {} })).toMatchObject({ skip: true });
        const stale = await ctxFor(await packStateValue(JSON.stringify(job({ refreshedAt: NOW.getTime() - 20 * 86_400_000 }))));
        expect(await scheduleGenerateHandler.beforeFire({ ctx: stale, charId: 'c1', taskMeta: {} })).toMatchObject({ skip: true });
        const noDay = await ctxFor(await packStateValue(JSON.stringify(job({ days: [{ date: '2026-11-17', extra: '' }] }))));
        expect(await scheduleGenerateHandler.beforeFire({ ctx: noDay, charId: 'c1', taskMeta: {} })).toMatchObject({ skip: true });
        const bad = await ctxFor(await packStateValue('{"v":1}'));
        await expect(scheduleGenerateHandler.beforeFire({ ctx: bad, charId: 'c1', taskMeta: {} })).rejects.toThrow();
    });
});

describe('llmOutput', () => {
    const state = { job: job(), dateKey: '2026-11-18' };
    it('有效 JSON 送進收件箱，不彈通知', async () => {
        const emitResult = vi.fn(async () => ({ messageId: 'm', pushed: false }));
        const out = await scheduleGenerateHandler.llmOutput({ ctx: { llmOutputText: '```json\n{"slots":[{"startTime":"08:00","activity":"起床"}],"doneTodos":[]}\n```', emitResult }, state });
        expect(out).toEqual({ decision: 'skip-push', reason: 'schedule-result-emitted' });
        expect(emitResult).toHaveBeenCalledWith(expect.objectContaining({ resultKind: SCHEDULE_GENERATE_RESULT_KIND, charId: 'c1', dateKey: '2026-11-18', notification: { show: false } }));
    });
    it('空輸出不送；沒 emitResult 不炸', async () => {
        const emitResult = vi.fn();
        expect(await scheduleGenerateHandler.llmOutput({ ctx: { llmOutputText: '抱歉', emitResult }, state })).toMatchObject({ reason: 'schedule-empty-generation' });
        expect(emitResult).not.toHaveBeenCalled();
        expect(await scheduleGenerateHandler.llmOutput({ ctx: { llmOutputText: '{"slots":[{"activity":"x"}]}' }, state })).toMatchObject({ reason: 'schedule-emit-result-unsupported' });
    });
});
