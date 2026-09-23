import { describe, it, expect } from 'vitest';
import { isCustomMeterHoursDue, tickCustomMeterTurns } from './customMeterAutoUpdate';
import { CharacterCustomMeter } from '../types';

function makeEntry(overrides: Partial<CharacterCustomMeter> = {}): CharacterCustomMeter {
  return { id: 'x', title: 't', prompt: 'p', color: '#fff', ...overrides };
}

describe('isCustomMeterHoursDue', () => {
  it('沒設置 autoUpdate 時不到期', () => {
    expect(isCustomMeterHoursDue(makeEntry())).toBe(false);
  });

  it('autoUpdate 是 turns 模式時不歸 hours 判斷', () => {
    expect(isCustomMeterHoursDue(makeEntry({ autoUpdate: { mode: 'turns', interval: 3 } }))).toBe(false);
  });

  it('interval 是 0 或負數時不到期', () => {
    expect(isCustomMeterHoursDue(makeEntry({ autoUpdate: { mode: 'hours', interval: 0 } }))).toBe(false);
    expect(isCustomMeterHoursDue(makeEntry({ autoUpdate: { mode: 'hours', interval: -5 } }))).toBe(false);
  });

  it('從沒生成過（沒有 updatedAt）時直接判定到期', () => {
    expect(isCustomMeterHoursDue(makeEntry({ autoUpdate: { mode: 'hours', interval: 24 } }))).toBe(true);
  });

  it('距上次生成不到 interval 小時不到期', () => {
    const now = 1_700_000_000_000;
    const entry = makeEntry({ autoUpdate: { mode: 'hours', interval: 6 }, updatedAt: now - 3 * 3600_000 });
    expect(isCustomMeterHoursDue(entry, now)).toBe(false);
  });

  it('距上次生成正好/超過 interval 小時判定到期', () => {
    const now = 1_700_000_000_000;
    const exact = makeEntry({ autoUpdate: { mode: 'hours', interval: 6 }, updatedAt: now - 6 * 3600_000 });
    const over = makeEntry({ autoUpdate: { mode: 'hours', interval: 6 }, updatedAt: now - 7 * 3600_000 });
    expect(isCustomMeterHoursDue(exact, now)).toBe(true);
    expect(isCustomMeterHoursDue(over, now)).toBe(true);
  });

  it('"一天一更"即 interval=24 小時', () => {
    const now = 1_700_000_000_000;
    const entry = makeEntry({ autoUpdate: { mode: 'hours', interval: 24 }, updatedAt: now - 25 * 3600_000 });
    expect(isCustomMeterHoursDue(entry, now)).toBe(true);
  });
});

describe('tickCustomMeterTurns', () => {
  it('非 turns 模式的條目原樣透傳，不進 due', () => {
    const manual = makeEntry({ id: 'a' });
    const hoursMode = makeEntry({ id: 'b', autoUpdate: { mode: 'hours', interval: 6 } });
    const { entries, due } = tickCustomMeterTurns([manual, hoursMode]);
    expect(entries).toEqual([manual, hoursMode]);
    expect(due).toHaveLength(0);
  });

  it('turns 模式未到期時計數 +1，不進 due', () => {
    const entry = makeEntry({ autoUpdate: { mode: 'turns', interval: 5 }, turnsSinceAutoUpdate: 2 });
    const { entries, due } = tickCustomMeterTurns([entry]);
    expect(entries[0].turnsSinceAutoUpdate).toBe(3);
    expect(due).toHaveLength(0);
  });

  it('turns 模式沒有 turnsSinceAutoUpdate 時從 0 起算', () => {
    const entry = makeEntry({ autoUpdate: { mode: 'turns', interval: 5 } });
    const { entries } = tickCustomMeterTurns([entry]);
    expect(entries[0].turnsSinceAutoUpdate).toBe(1);
  });

  it('turns 模式達到 interval 時計數清零並進入 due', () => {
    const entry = makeEntry({ id: 'c', autoUpdate: { mode: 'turns', interval: 3 }, turnsSinceAutoUpdate: 2 });
    const { entries, due } = tickCustomMeterTurns([entry]);
    expect(entries[0].turnsSinceAutoUpdate).toBe(0);
    expect(due).toHaveLength(1);
    expect(due[0].id).toBe('c');
    expect(due[0].turnsSinceAutoUpdate).toBe(0);
  });

  it('interval 是 0 或負數時不推進、不到期', () => {
    const entry = makeEntry({ autoUpdate: { mode: 'turns', interval: 0 }, turnsSinceAutoUpdate: 5 });
    const { entries, due } = tickCustomMeterTurns([entry]);
    expect(entries[0].turnsSinceAutoUpdate).toBe(5);
    expect(due).toHaveLength(0);
  });

  it('多條混合：只有到期的那條進 due，其餘各自推進', () => {
    const a = makeEntry({ id: 'a', autoUpdate: { mode: 'turns', interval: 3 }, turnsSinceAutoUpdate: 2 });
    const b = makeEntry({ id: 'b', autoUpdate: { mode: 'turns', interval: 10 }, turnsSinceAutoUpdate: 1 });
    const c = makeEntry({ id: 'c' });
    const { entries, due } = tickCustomMeterTurns([a, b, c]);
    expect(due.map(e => e.id)).toEqual(['a']);
    expect(entries.find(e => e.id === 'a')?.turnsSinceAutoUpdate).toBe(0);
    expect(entries.find(e => e.id === 'b')?.turnsSinceAutoUpdate).toBe(2);
    expect(entries.find(e => e.id === 'c')?.turnsSinceAutoUpdate).toBeUndefined();
  });

  it('空數組原樣返回空', () => {
    const { entries, due } = tickCustomMeterTurns([]);
    expect(entries).toEqual([]);
    expect(due).toEqual([]);
  });
});
