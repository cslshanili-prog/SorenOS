// utils/agenticTools.test.ts
import { describe, it, expect } from 'vitest';
import { listRecallableMonths, runRecall, type AgenticToolMemory, type AgenticToolCtx } from './agenticTools';
import type { UserProfile } from '../types';

const mem = (date: string, summary = '那天的事'): AgenticToolMemory => ({ date, summary });

const ctxWith = (memories: AgenticToolMemory[]): AgenticToolCtx => ({
  char: { name: '測試角色', memories },
  userProfile: { name: '用戶' } as UserProfile,
});

describe('listRecallableMonths', () => {
  it('ISO 日期取出年月，去重後升序', () => {
    expect(listRecallableMonths([mem('2026-06-15'), mem('2026-06-28'), mem('2026-05-02')]))
      .toEqual(['2026-05', '2026-06']);
  });

  it('中文日期同樣認，月份補零', () => {
    expect(listRecallableMonths([mem('2026年6月15日'), mem('2026年11月3日')]))
      .toEqual(['2026-06', '2026-11']);
  });

  it('沒有記憶時給空清單（調用方據此不注入這行提示）', () => {
    expect(listRecallableMonths(undefined)).toEqual([]);
    expect(listRecallableMonths([])).toEqual([]);
  });

  it('認不出日期的條目跳過，不產出垃圾月份', () => {
    expect(listRecallableMonths([mem('不知道什麼時候'), mem('2026-07-01')])).toEqual(['2026-07']);
  });

  // 這條是這個函數存在的意義：清單要擺給角色看，報了一個查不到的月份
  // 比不報還糟——角色會以為自己有那段記憶，[[RECALL]] 回來卻是空的。
  it('報出來的每個月份，runRecall 都真能查到', async () => {
    const memories = [mem('2026-06-15'), mem('2026年5月2日'), mem('2026-11-30')];
    const months = listRecallableMonths(memories);
    expect(months.length).toBeGreaterThan(0);
    for (const month of months) {
      const [year, mm] = month.split('-');
      const result = await runRecall({ year, month: mm }, ctxWith(memories));
      expect(result, `${month} 應該查得到`).toMatchObject({ ok: true });
    }
  });

  it('沒被報出來的月份確實查不到', async () => {
    const memories = [mem('2026-06-15')];
    expect(listRecallableMonths(memories)).not.toContain('2026-07');
    expect(await runRecall({ year: '2026', month: '07' }, ctxWith(memories)))
      .toMatchObject({ ok: false, reason: 'no_logs' });
  });
});
