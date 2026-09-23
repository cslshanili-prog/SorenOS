import { describe, it, expect, vi } from 'vitest';
import { ActiveMsgStore } from './activeMsgStore';
import type { Amsg2ExpiredNoticeRecord } from '../types';

// fake-indexeddb 已通過 test-setup.ts 自動注入. 跨測試 deleteDatabase 會被單例連接
// block — 改用每個 case 唯一 key 隔離.

let _sid = 0;

describe('ActiveMsgStore 連接', () => {
  it('連接複用: 單例建立後後續操作不再新開 indexedDB 連接', async () => {
    // 先跑一次確保單例已建立, 這裡冪等。
    await ActiveMsgStore.getGlobalConfig();
    const openSpy = vi.spyOn(indexedDB, 'open');
    try {
      await ActiveMsgStore.getGlobalConfig();
      await ActiveMsgStore.listInboxMessages();
      await ActiveMsgStore.consumeInboxMessages();
      // 3 個操作都複用單例, 0 次 open。
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }
  });
});

describe('ActiveMsgStore 作廢回執台帳', () => {
  const uniqueChar = (label: string) => `${label}-${++_sid}-${Date.now()}`;
  const rec = (id: string, charId: string, extra: Partial<Amsg2ExpiredNoticeRecord> = {}): Amsg2ExpiredNoticeRecord => ({
    id, charId, occurrenceMs: Date.now() - 1000, mode: 'auto', recurrenceType: 'none',
    createdAt: Date.now(), ...extra,
  });

  it('upsert 按 id 去重，getExpiredNotices 讀回', async () => {
    const charId = uniqueChar('n1');
    await ActiveMsgStore.upsertExpiredNotices(charId, [rec('a', charId)]);
    await ActiveMsgStore.upsertExpiredNotices(charId, [rec('a', charId), rec('b', charId)]);
    expect((await ActiveMsgStore.getExpiredNotices(charId)).map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('markExpiredNoticesNotified 只標指定 id，不覆蓋已有 notifiedAt', async () => {
    const charId = uniqueChar('n2');
    await ActiveMsgStore.upsertExpiredNotices(charId, [rec('a', charId), rec('b', charId)]);
    await ActiveMsgStore.markExpiredNoticesNotified(charId, ['a']);
    const list = await ActiveMsgStore.getExpiredNotices(charId);
    expect(list.find((r) => r.id === 'a')?.notifiedAt).toBeTypeOf('number');
    expect(list.find((r) => r.id === 'b')?.notifiedAt).toBeUndefined();
  });

  it('48h 前的老記錄在 upsert 時被清掉', async () => {
    const charId = uniqueChar('n3');
    await ActiveMsgStore.upsertExpiredNotices(charId, [rec('old', charId, { createdAt: Date.now() - 49 * 3600_000 })]);
    await ActiveMsgStore.upsertExpiredNotices(charId, [rec('new', charId)]);
    expect((await ActiveMsgStore.getExpiredNotices(charId)).map((r) => r.id)).toEqual(['new']);
  });

  it('超上限時先淘汰已告知的，未告知的保留（作廢 ≠ 消失）', async () => {
    const charId = uniqueChar('n4');
    const notified = Array.from({ length: 10 }, (_, i) =>
      rec(`old-${i}`, charId, { notifiedAt: Date.now(), occurrenceMs: Date.now() - i * 1000 }));
    await ActiveMsgStore.upsertExpiredNotices(charId, notified);
    await ActiveMsgStore.upsertExpiredNotices(charId, [rec('fresh', charId)]);
    const list = await ActiveMsgStore.getExpiredNotices(charId);
    expect(list.find((r) => r.id === 'fresh')).toBeTruthy();
    expect(list.length).toBeLessThanOrEqual(10);
  });
});
