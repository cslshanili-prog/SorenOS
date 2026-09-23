// utils/dateSessionHistory.test.ts
// 見面（DateApp）會話歷史的兩處窗口邏輯。
import { describe, it, expect } from 'vitest';

import { trimHistoryThrough, planNovelLoadMore } from './dateSessionHistory';

const msg = (id: number, source: string) => ({ id, metadata: { source } } as any);

// ── 重擲時的歷史裁剪 ──
// 見面裡重擲最後一條 AI 回覆時，傳給提示詞的歷史是「全來源」的最近窗口，而被重擲的那輪
// user 消息是從 date 子集裡挑的。要是這中間用戶還在普通聊天裡發過消息，全來源歷史的尾巴
// 就不是那條 date user 了：buildDateHistory 固定砍掉最後一條（本該砍掉待重發的 user），
// 結果砍掉了那條聊天消息，而 date user 又被 buildSessionPayload 追加了一次——聊天消息丟了，
// date 回合重複了。裁到目標那條為止，兩個毛病一起沒。
describe('trimHistoryThrough', () => {
  it('目標之後還有別處來源的新消息 → 裁掉（迴歸：丟聊天消息 + 重複 date 回合）', () => {
    const msgs = [msg(1, 'date'), msg(2, 'date'), msg(3, 'chat'), msg(4, 'chat')];
    expect(trimHistoryThrough(msgs, 2).map((m) => m.id)).toEqual([1, 2]);
  });

  it('目標就是最後一條 → 原樣返回', () => {
    const msgs = [msg(1, 'date'), msg(2, 'date')];
    expect(trimHistoryThrough(msgs, 2).map((m) => m.id)).toEqual([1, 2]);
  });

  it('目標不在列表裡 → 原樣返回，不把歷史裁沒', () => {
    const msgs = [msg(1, 'date'), msg(2, 'date')];
    expect(trimHistoryThrough(msgs, 99).map((m) => m.id)).toEqual([1, 2]);
  });

  it('空歷史不炸', () => {
    expect(trimHistoryThrough([], 1)).toEqual([]);
  });
});

// ── 閱讀模式「加載更早」──
// 會話初始化只從庫裡取最近 220 條見面消息，閱讀模式的按鈕原本只是在這批已加載的數組上
// 放大顯示窗口，從不回庫裡取更早的行。於是這 220 條全放出來後按鈕就消失，更早的見面記錄
// 在閱讀模式裡永遠夠不著。要區分「只需開窗」和「得回庫裡再取」兩種情況。
describe('planNovelLoadMore', () => {
  const base = { loadedCount: 220, visibleCount: 80, windowStep: 80, loadLimit: 220, loadStep: 220, reachedDbEnd: false };

  it('本地還有沒顯示的 → 只開窗，不查庫', () => {
    const plan = planNovelLoadMore(base);
    expect(plan.nextVisibleCount).toBe(160);
    expect(plan.nextLoadLimit).toBeNull();
  });

  it('開窗不會超過已加載條數', () => {
    const plan = planNovelLoadMore({ ...base, visibleCount: 200 });
    expect(plan.nextVisibleCount).toBe(220);
    expect(plan.nextLoadLimit).toBeNull();
  });

  it('已加載的全顯示完、庫裡還有 → 回庫裡取下一批（迴歸：按鈕消失、舊記錄夠不著）', () => {
    const plan = planNovelLoadMore({ ...base, visibleCount: 220 });
    expect(plan.nextLoadLimit).toBe(440);
    expect(plan.nextVisibleCount).toBeGreaterThan(220);
  });

  it('已到庫底且窗口鋪滿 → 既不查庫也不再開窗', () => {
    const plan = planNovelLoadMore({ ...base, visibleCount: 220, reachedDbEnd: true });
    expect(plan.nextLoadLimit).toBeNull();
    expect(plan.nextVisibleCount).toBe(220);
  });

  it('到庫底但本地窗口還沒鋪滿 → 仍可繼續開窗', () => {
    const plan = planNovelLoadMore({ ...base, visibleCount: 100, reachedDbEnd: true });
    expect(plan.nextLoadLimit).toBeNull();
    expect(plan.nextVisibleCount).toBe(180);
  });
});
