import { describe, it, expect } from 'vitest';
import { isCustomMeterHoursDue, tickCustomMeterTurns } from './customMeterAutoUpdate';
import { CharacterCustomMeter } from '../types';

function makeEntry(overrides: Partial<CharacterCustomMeter> = {}): CharacterCustomMeter {
  return { id: 'x', title: 't', prompt: 'p', color: '#fff', ...overrides };
}

describe('isCustomMeterHoursDue', () => {
  it('没设置 autoUpdate 时不到期', () => {
    expect(isCustomMeterHoursDue(makeEntry())).toBe(false);
  });

  it('autoUpdate 是 turns 模式时不归 hours 判断', () => {
    expect(isCustomMeterHoursDue(makeEntry({ autoUpdate: { mode: 'turns', interval: 3 } }))).toBe(false);
  });

  it('interval 是 0 或负数时不到期', () => {
    expect(isCustomMeterHoursDue(makeEntry({ autoUpdate: { mode: 'hours', interval: 0 } }))).toBe(false);
    expect(isCustomMeterHoursDue(makeEntry({ autoUpdate: { mode: 'hours', interval: -5 } }))).toBe(false);
  });

  it('从没生成过（没有 updatedAt）时直接判定到期', () => {
    expect(isCustomMeterHoursDue(makeEntry({ autoUpdate: { mode: 'hours', interval: 24 } }))).toBe(true);
  });

  it('距上次生成不到 interval 小时不到期', () => {
    const now = 1_700_000_000_000;
    const entry = makeEntry({ autoUpdate: { mode: 'hours', interval: 6 }, updatedAt: now - 3 * 3600_000 });
    expect(isCustomMeterHoursDue(entry, now)).toBe(false);
  });

  it('距上次生成正好/超过 interval 小时判定到期', () => {
    const now = 1_700_000_000_000;
    const exact = makeEntry({ autoUpdate: { mode: 'hours', interval: 6 }, updatedAt: now - 6 * 3600_000 });
    const over = makeEntry({ autoUpdate: { mode: 'hours', interval: 6 }, updatedAt: now - 7 * 3600_000 });
    expect(isCustomMeterHoursDue(exact, now)).toBe(true);
    expect(isCustomMeterHoursDue(over, now)).toBe(true);
  });

  it('"一天一更"即 interval=24 小时', () => {
    const now = 1_700_000_000_000;
    const entry = makeEntry({ autoUpdate: { mode: 'hours', interval: 24 }, updatedAt: now - 25 * 3600_000 });
    expect(isCustomMeterHoursDue(entry, now)).toBe(true);
  });
});

describe('tickCustomMeterTurns', () => {
  it('非 turns 模式的条目原样透传，不进 due', () => {
    const manual = makeEntry({ id: 'a' });
    const hoursMode = makeEntry({ id: 'b', autoUpdate: { mode: 'hours', interval: 6 } });
    const { entries, due } = tickCustomMeterTurns([manual, hoursMode]);
    expect(entries).toEqual([manual, hoursMode]);
    expect(due).toHaveLength(0);
  });

  it('turns 模式未到期时计数 +1，不进 due', () => {
    const entry = makeEntry({ autoUpdate: { mode: 'turns', interval: 5 }, turnsSinceAutoUpdate: 2 });
    const { entries, due } = tickCustomMeterTurns([entry]);
    expect(entries[0].turnsSinceAutoUpdate).toBe(3);
    expect(due).toHaveLength(0);
  });

  it('turns 模式没有 turnsSinceAutoUpdate 时从 0 起算', () => {
    const entry = makeEntry({ autoUpdate: { mode: 'turns', interval: 5 } });
    const { entries } = tickCustomMeterTurns([entry]);
    expect(entries[0].turnsSinceAutoUpdate).toBe(1);
  });

  it('turns 模式达到 interval 时计数清零并进入 due', () => {
    const entry = makeEntry({ id: 'c', autoUpdate: { mode: 'turns', interval: 3 }, turnsSinceAutoUpdate: 2 });
    const { entries, due } = tickCustomMeterTurns([entry]);
    expect(entries[0].turnsSinceAutoUpdate).toBe(0);
    expect(due).toHaveLength(1);
    expect(due[0].id).toBe('c');
    expect(due[0].turnsSinceAutoUpdate).toBe(0);
  });

  it('interval 是 0 或负数时不推进、不到期', () => {
    const entry = makeEntry({ autoUpdate: { mode: 'turns', interval: 0 }, turnsSinceAutoUpdate: 5 });
    const { entries, due } = tickCustomMeterTurns([entry]);
    expect(entries[0].turnsSinceAutoUpdate).toBe(5);
    expect(due).toHaveLength(0);
  });

  it('多条混合：只有到期的那条进 due，其余各自推进', () => {
    const a = makeEntry({ id: 'a', autoUpdate: { mode: 'turns', interval: 3 }, turnsSinceAutoUpdate: 2 });
    const b = makeEntry({ id: 'b', autoUpdate: { mode: 'turns', interval: 10 }, turnsSinceAutoUpdate: 1 });
    const c = makeEntry({ id: 'c' });
    const { entries, due } = tickCustomMeterTurns([a, b, c]);
    expect(due.map(e => e.id)).toEqual(['a']);
    expect(entries.find(e => e.id === 'a')?.turnsSinceAutoUpdate).toBe(0);
    expect(entries.find(e => e.id === 'b')?.turnsSinceAutoUpdate).toBe(2);
    expect(entries.find(e => e.id === 'c')?.turnsSinceAutoUpdate).toBeUndefined();
  });

  it('空数组原样返回空', () => {
    const { entries, due } = tickCustomMeterTurns([]);
    expect(entries).toEqual([]);
    expect(due).toEqual([]);
  });
});
