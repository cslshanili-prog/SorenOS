// 羈絆主動產出在 worker 那一側（plans/bond-batch3.md 1.6、第 3d 批）：讀 standing job → 判斷該不該寫 → 拼提示詞 → 原文送回收件箱、記帳
import { describe, expect, it, vi } from 'vitest';
import { bondOutputHandler } from './bondOutputFire';
import { packStateValue } from '../../../utils/amsgFirePack';
import { AMSG_JOB_ID_KEY, AMSG_JOB_NAMESPACE } from '../../../utils/amsgTaskKinds';
import {
    BOND_OUTPUT_LOG_KEY, BOND_OUTPUT_RESULT_KIND, bondOutputJobId, bondOutputJobKey, buildBondOutputJob, recordBondOutput, type BondOutputJob,
} from '../../../utils/bond/outputCloudJob';

const NOW = new Date('2026-11-26T13:00:00Z'); // 台北 21:00
const HOUR = 3600_000;
const job = (): BondOutputJob => buildBondOutputJob({
    bondId: 'c1::p1', charId: 'c1', charName: '煦', tzId: 'Asia/Taipei', refreshedAt: NOW.getTime() - HOUR,
    system: '（人設）', lock: '（友情線）', limits: { perBondPerDay: 2, minGapMs: 3 * HOUR, allPerDay: 6 },
    kinds: {
        note: { dueAt: NOW.getTime() - HOUR, everyDays: [3, 7], withNotice: true, prompt: '丟一張紙條', tags: ['想你'], taskUuid: 'T1' },
        question: { dueAt: NOW.getTime() + 86400_000, everyDays: [3, 7], withNotice: false, prompt: '出一題' },
    },
});

const ctxFor = async (rows: Array<{ key: string; value: string }>, uuid = 'T1') => ({
    task: { id: 1, uuid, metadata: {} },
    readState: vi.fn(async (ns: string) => (ns === AMSG_JOB_NAMESPACE ? rows : [])),
    now: NOW,
    scratch: {},
});
const jobRow = async (j: unknown = job()) => ({ key: bondOutputJobKey('c1::p1'), value: await packStateValue(JSON.stringify(j)) });
const meta = (kind: string) => ({ [AMSG_JOB_ID_KEY]: bondOutputJobId('c1::p1', kind as any) });

describe('beforeFire', () => {
    it('到期就拼提示詞：系統是人設、最後補路線鎖', async () => {
        const plan = await bondOutputHandler.beforeFire({ ctx: await ctxFor([await jobRow()]), charId: 'c1', taskMeta: meta('note') });
        if ('skip' in plan) throw new Error(plan.reason);
        expect(plan.messages).toEqual([{ role: 'system', content: '（人設）' }, { role: 'user', content: '丟一張紙條\n\n（友情線）' }]);
        expect((plan.state as any).kind).toBe('note');
    });

    it('還沒到期、舊任務、雲端今天寫滿了、輸入不在都安靜跳過；壞數據硬失敗', async () => {
        const rows = [await jobRow()];
        expect(await bondOutputHandler.beforeFire({ ctx: await ctxFor(rows), charId: 'c1', taskMeta: meta('question') })).toMatchObject({ skip: true });
        expect(await bondOutputHandler.beforeFire({ ctx: await ctxFor(rows, 'T-old'), charId: 'c1', taskMeta: meta('note') })).toMatchObject({ skip: true });
        const full = recordBondOutput(recordBondOutput(null, '2026-11-26', 'c1::p1', 'diary', NOW.getTime() - 10 * HOUR), '2026-11-26', 'c1::p1', 'essay', NOW.getTime() - 5 * HOUR);
        const capped = [...rows, { key: BOND_OUTPUT_LOG_KEY, value: JSON.stringify(full) }];
        expect(await bondOutputHandler.beforeFire({ ctx: await ctxFor(capped), charId: 'c1', taskMeta: meta('note') })).toMatchObject({ skip: true });
        expect(await bondOutputHandler.beforeFire({ ctx: await ctxFor([]), charId: 'c1', taskMeta: meta('note') })).toMatchObject({ skip: true });
        await expect(bondOutputHandler.beforeFire({ ctx: await ctxFor([await jobRow({ v: 1 })]), charId: 'c1', taskMeta: meta('note') })).rejects.toThrow();
        await expect(bondOutputHandler.beforeFire({ ctx: await ctxFor(rows), charId: 'c1', taskMeta: {} })).rejects.toThrow();
    });
});

describe('llmOutput', () => {
    const state = { job: job(), kind: 'note', day: '2026-11-26', dateKey: '2026-11-26', log: null };
    it('送回原文、私聊那句當通知、記帳', async () => {
        const emitResult = vi.fn(async () => ({ messageId: 'm', pushed: true }));
        const writeState = vi.fn(async () => ({ upserted: 1, skipped: 0, deleted: 0 }));
        const raw = '{"text":"今天路過那家店","tags":["想你"],"notice":"欸，我丟了一張紙條給你"}';
        const out = await bondOutputHandler.llmOutput({ ctx: { llmOutputText: raw, emitResult, writeState }, state });
        expect(out).toEqual({ decision: 'skip-push', reason: 'bond-output-result-emitted' });
        expect(emitResult).toHaveBeenCalledWith(expect.objectContaining({
            resultKind: BOND_OUTPUT_RESULT_KIND, bondId: 'c1::p1', kind: 'note', raw, tags: ['想你'],
            notification: { title: '煦', body: '欸，我丟了一張紙條給你' },
        }));
        const [[ns, entries]] = writeState.mock.calls as any;
        expect(ns).toBe(AMSG_JOB_NAMESPACE);
        expect(entries[0].key).toBe(BOND_OUTPUT_LOG_KEY);
        expect(JSON.parse(entries[0].value)).toMatchObject({ day: '2026-11-26', total: 1 });
    });
    it('沒寫出東西不送；沒 emitResult 不炸；沒有私聊那句不彈通知', async () => {
        const emitResult = vi.fn(async () => ({ messageId: 'm', pushed: false }));
        expect(await bondOutputHandler.llmOutput({ ctx: { llmOutputText: '<think>想想</think>  ', emitResult }, state })).toMatchObject({ reason: 'bond-output-empty-generation' });
        expect(emitResult).not.toHaveBeenCalled();
        expect(await bondOutputHandler.llmOutput({ ctx: { llmOutputText: '{"text":"嗨"}' }, state })).toMatchObject({ reason: 'bond-output-emit-result-unsupported' });
        await bondOutputHandler.llmOutput({ ctx: { llmOutputText: '{"text":"嗨"}', emitResult }, state });
        expect(emitResult).toHaveBeenCalledWith(expect.objectContaining({ notification: { show: false } }));
    });
});
