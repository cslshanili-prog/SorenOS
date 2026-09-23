import { describe, expect, it } from 'vitest';
import {
  buildAmsgLimitsRecord,
  buildLimitsBrief,
  bumpDailySends,
  checkSelfScheduleRules,
  dayKeyInZone,
  earliestSlotAfter,
  findGapConflict,
  parseAmsgLimitsRecord,
  parseDailySends,
  pickPacingSettings,
  resolveAmsgLimits,
  sendsOnDay,
} from './amsgLimits';

const MIN = 60_000;

describe('resolveAmsgLimits — 用戶沒設時的默認值', () => {
  // 默認值是這次改動的核心承諾：用戶什麼都不動，角色也不會一分鐘一條地刷、不會自己
  // 建每天都響的任務。改默認值要改的是產品決定，不是順手調參——這條釘住它。
  it('默認：連發 3 條、隔 10 分鐘、每天不限、重複的 3 次沒回就停、同時 5 條、不許排重複和到點必發', () => {
    expect(resolveAmsgLimits(undefined)).toEqual({
      maxUnansweredSends: 3,
      minSendGapMs: 10 * MIN,
      dailySendCap: Infinity,
      recurringStopAfter: 3,
      maxActiveTasks: 5,
      allowSelfRecurring: false,
      allowSelfForce: false,
    });
  });

  it('0 的意思：連發 / 每日 / 重複停發是「不限」，間隔是「不額外限制」', () => {
    const limits = resolveAmsgLimits({
      maxUnansweredSends: 0, dailySendCap: 0, recurringStopAfter: 0, minSendGapMinutes: 0,
    });
    expect(limits.maxUnansweredSends).toBe(Infinity);
    expect(limits.dailySendCap).toBe(Infinity);
    expect(limits.recurringStopAfter).toBe(Infinity);
    expect(limits.minSendGapMs).toBe(0);
  });

  it('壞值回落默認值；任務名額封在 1~10、沒有「不限」', () => {
    expect(resolveAmsgLimits({ maxUnansweredSends: -1 }).maxUnansweredSends).toBe(3);
    expect(resolveAmsgLimits({ minSendGapMinutes: Number.NaN }).minSendGapMs).toBe(10 * MIN);
    expect(resolveAmsgLimits({ maxActiveTasks: 0 }).maxActiveTasks).toBe(5);
    expect(resolveAmsgLimits({ maxActiveTasks: 50 }).maxActiveTasks).toBe(10);
    expect(resolveAmsgLimits({ maxActiveTasks: 2 }).maxActiveTasks).toBe(2);
  });
});

describe('limits 記錄', () => {
  it('只帶上限字段和開關，讀回來一樣', () => {
    const record = buildAmsgLimitsRecord({
      enabled: true, tasks: [], maxTokens: 120, dailySendCap: 5, allowSelfForce: true,
    } as any, true);
    expect(record).toEqual({ v: 1, selfScheduleEnabled: true, dailySendCap: 5, allowSelfForce: true });
    expect(parseAmsgLimitsRecord(JSON.stringify(record))).toEqual(record);
  });

  it('形狀不對 → null（worker 按默認值走）', () => {
    expect(parseAmsgLimitsRecord('')).toBeNull();
    expect(parseAmsgLimitsRecord('{')).toBeNull();
    expect(parseAmsgLimitsRecord(JSON.stringify({ v: 1 }))).toBeNull();
  });

  it('pickPacingSettings 不帶沒設的項', () => {
    expect(pickPacingSettings({ maxUnansweredSends: undefined, minSendGapMinutes: 30 })).toEqual({ minSendGapMinutes: 30 });
  });
});

describe('每日計數', () => {
  // 「今天」是用戶那邊的今天：同一個時刻，上海已經是第二天，紐約還是前一天。
  it('按時區取日期', () => {
    const at = Date.parse('2026-07-25T20:00:00Z');
    expect(dayKeyInZone(at, 'Asia/Shanghai')).toBe('2026-07-26');
    expect(dayKeyInZone(at, 'America/New_York')).toBe('2026-07-25');
  });

  it('同一天累加，換日從零數起', () => {
    let record = bumpDailySends(null, '2026-07-25', { sends: 1, llmCalls: 2 });
    record = bumpDailySends(record, '2026-07-25', { sends: 1 });
    expect(record).toEqual({ v: 1, day: '2026-07-25', sends: 2, llmCalls: 2 });
    expect(sendsOnDay(record, '2026-07-26')).toBe(0);
    expect(bumpDailySends(record, '2026-07-26', { sends: 1 })).toEqual({ v: 1, day: '2026-07-26', sends: 1 });
    expect(parseDailySends(JSON.stringify(record))).toEqual(record);
  });

  it('同一次觸發只算一次「發了」，模型調用照加', () => {
    let record = bumpDailySends(null, '2026-07-25', { sends: 1, llmCalls: 1, sentId: 'c@1' });
    record = bumpDailySends(record, '2026-07-25', { sends: 1, llmCalls: 1, sentId: 'c@1' });
    expect(record).toMatchObject({ sends: 1, llmCalls: 2, counted: ['c@1'] });
  });
});

describe('間隔', () => {
  it('找衝突：離哪個時刻不夠遠', () => {
    expect(findGapConflict(100 * MIN, 10 * MIN, [95 * MIN, 200 * MIN])).toBe(95 * MIN);
    expect(findGapConflict(100 * MIN, 10 * MIN, [80 * MIN, 120 * MIN])).toBeNull();
    expect(findGapConflict(100 * MIN, 0, [100 * MIN])).toBeNull();
  });

  it('最早能排的時刻：一路往後挪到跟每個都隔夠', () => {
    expect(earliestSlotAfter(0, 10 * MIN, [0, 12 * MIN])).toBe(22 * MIN);
    expect(earliestSlotAfter(0, 10 * MIN, [30 * MIN])).toBe(0);
  });
});

describe('checkSelfScheduleRules', () => {
  const base = {
    sendAtMs: 60 * MIN,
    recurrence: 'none' as const,
    expirePolicy: 'expire' as const,
    busy: [] as number[],
    earliestMs: MIN,
    formatTime: (ms: number) => `T+${Math.round(ms / MIN)}分`,
  };

  it('不許排重複的 → 打回', () => {
    const out = checkSelfScheduleRules({ ...base, limits: resolveAmsgLimits(undefined), recurrence: 'daily' });
    expect(out).toMatchObject({ ok: false, reason: 'recurring_not_allowed' });
    expect(checkSelfScheduleRules({
      ...base, limits: resolveAmsgLimits({ allowSelfRecurring: true }), recurrence: 'daily',
    }).ok).toBe(true);
  });

  it('離已排的太近 → 打回，並報最早能排的時刻', () => {
    const out = checkSelfScheduleRules({ ...base, limits: resolveAmsgLimits(undefined), busy: [55 * MIN] });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe('min_gap');
      expect(out.message).toContain('T+65分');
    }
  });

  it('到點必發沒放開 → 不打回，按普通的排；放開了原樣', () => {
    const locked = checkSelfScheduleRules({ ...base, limits: resolveAmsgLimits(undefined), expirePolicy: 'force' });
    expect(locked).toEqual({ ok: true, expirePolicy: 'expire' });
    const open = checkSelfScheduleRules({
      ...base, limits: resolveAmsgLimits({ allowSelfForce: true }), expirePolicy: 'force',
    });
    expect(open).toEqual({ ok: true, expirePolicy: 'force' });
  });
});

describe('buildLimitsBrief', () => {
  it('把額度說成事實：還能排幾條、最早幾點、今天還剩幾條', () => {
    const text = buildLimitsBrief({
      limits: resolveAmsgLimits({ dailySendCap: 5 }),
      committedSends: 1,
      activeTasks: 2,
      earliestText: '21:40',
      dailyRemaining: 3,
    });
    expect(text).toContain('現在還能再排 2 條');
    expect(text).toContain('最早排到 21:40');
    expect(text).toContain('今天還能再主動發 3 條');
    expect(text).toContain('現在排著 2 條');
    expect(text).toContain('只能排一次性的');
  });

  it('額度用完了直說；不限的項不出現', () => {
    const full = buildLimitsBrief({ limits: resolveAmsgLimits(undefined), committedSends: 3, activeTasks: 0 });
    expect(full).toContain('一條都不能再排了');
    const loose = buildLimitsBrief({
      limits: resolveAmsgLimits({ maxUnansweredSends: 0, minSendGapMinutes: 0, allowSelfRecurring: true, allowSelfForce: true }),
      committedSends: 9,
      activeTasks: 0,
    });
    expect(loose).not.toContain('連著主動發');
    expect(loose).not.toContain('至少隔');
    expect(loose).not.toContain('只能排一次性的');
    expect(loose).not.toContain('到點必發');
  });
});
