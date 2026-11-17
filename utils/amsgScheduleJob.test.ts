import { describe, expect, it } from 'vitest';
import {
    addDaysKey, buildScheduleGenerateResult, buildScheduleJobInput, buildScheduleJobMessages, extractScheduleJson, parseScheduleGenerateResult, parseScheduleJobInput, scheduleJobKey, scheduleJobTargetDay,
} from './amsgScheduleJob';

// 日程自動生成上雲的契約（plans/calendar.md 第 5 批）

const job = () => buildScheduleJobInput({
    charId: 'c1', charName: '宋時聿', userName: '小林', style: 'lifestyle', tzId: 'Asia/Taipei', ahead: 1,
    baseContext: '（人設）', chatHistoryBlock: '', refreshedAt: 1,
    days: [{ date: '2026-11-17', extra: '\n## 出行中\n在東京\n' }, { date: '2026-11-18', extra: '' }],
});

describe('job 輸入', () => {
    it('組與讀回對得上；壞形狀回 null', () => {
        const j = job();
        expect(parseScheduleJobInput(JSON.stringify(j))).toEqual(j);
        expect(parseScheduleJobInput({ ...j, v: 2 })).toBeNull();
        expect(parseScheduleJobInput({ ...j, ahead: 2 })).toBeNull();
        expect(parseScheduleJobInput({ ...j, days: [{ date: '11-17', extra: '' }] })).toBeNull();
        expect(parseScheduleJobInput('not json')).toBeNull();
        expect(scheduleJobKey('c1')).toBe('schedule:c1');
    });

    it('目標日照 tzId 和 ahead 算；那天的段拼進提示詞；沒那天就 null', () => {
        // 2026-11-17 14:00Z = 台北 22:00、紐約 09:00
        const now = Date.parse('2026-11-17T14:00:00Z');
        expect(scheduleJobTargetDay({ tzId: 'Asia/Taipei', ahead: 1 }, now)).toBe('2026-11-18');
        expect(scheduleJobTargetDay({ tzId: 'Asia/Taipei', ahead: 0 }, now)).toBe('2026-11-17');
        expect(scheduleJobTargetDay({ tzId: 'America/New_York', ahead: 1 }, now)).toBe('2026-11-18');
        expect(addDaysKey('2026-11-30', 1)).toBe('2026-12-01');
        const msgs = buildScheduleJobMessages(job(), '2026-11-17');
        expect(msgs).toHaveLength(1);
        expect(msgs![0].content).toContain('在東京');
        expect(msgs![0].content).toContain('宋時聿');
        expect(msgs![0].content).toContain('2026-11-17 (星期二)');
        expect(buildScheduleJobMessages(job(), '2026-11-25')).toBeNull();
    });
});

describe('結果', () => {
    it('組與讀回；壞的回 null', () => {
        const r = buildScheduleGenerateResult({ charId: 'c1', dateKey: '2026-11-18', parsed: { slots: [{ startTime: '08:00', activity: '起床' }] }, generatedAt: 5 });
        expect(parseScheduleGenerateResult(r)).toEqual(r);
        expect(parseScheduleGenerateResult({ ...r, dateKey: 'x' })).toBeNull();
        expect(parseScheduleGenerateResult({ ...r, parsed: [] })).toBeNull();
    });

    it('extractScheduleJson：去 think、去圍欄、取最外層、修尾逗號', () => {
        expect(extractScheduleJson('<think>嗯</think>```json\n{"slots":[{"a":1}]}\n```')).toEqual({ slots: [{ a: 1 }] });
        expect(extractScheduleJson('好的：{"slots":[{"a":1},]}')).toEqual({ slots: [{ a: 1 }] });
        expect(extractScheduleJson('沒有 json')).toBeNull();
        expect(extractScheduleJson('[1,2]')).toBeNull();
    });
});
