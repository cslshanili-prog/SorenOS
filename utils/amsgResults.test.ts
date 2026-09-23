// utils/amsgResults.test.ts
//
// 迴歸守衛（雲端結果的分發口要排隊）。同一條結果有兩條腿會送到這兒：推送直達
// （SW 的 active-msg-result）和上線補收（drainOutbox）。兩條腿會撞車——推送剛到、
// 頁面正好因為 visibilitychange 跑了一趟補收。而 handler 普遍是「讀一份 → 改 →
// 整塊存回去」，併發跑就是後寫的把先寫的整塊蓋掉，兩邊日誌還都顯示成功。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { trace, behavior, seenContexts } = vi.hoisted(() => ({
  trace: [] as string[],
  behavior: { throwOn: null as string | null, hangOn: null as string | null },
  seenContexts: [] as unknown[],
}));

vi.mock('./memoryPalace/roomPlateCloud', () => ({
  applyPlateConsolidateResult: vi.fn(async (payload: any, context?: unknown) => {
    trace.push(`enter:${payload.jobId}`);
    // IDB 連接被別的標籤頁 block 住時就是這個形態：promise 一輩子不 settle
    if (behavior.hangOn === payload.jobId) return new Promise<boolean>(() => {});
    // 讓出一次事件循環：沒有排隊的話，第二條會在這兒插進來
    await new Promise((resolve) => setTimeout(resolve, 0));
    trace.push(`exit:${payload.jobId}`);
    if (behavior.throwOn === payload.jobId) throw new Error('IDB 抖了一下');
    seenContexts.push(context);
    return true;
  }),
}));

import { PLATE_CONSOLIDATE_RESULT_KIND } from './amsgPlateJob';
import { dispatchAmsgResult } from './amsgResults';

const result = (jobId: string) => ({ resultKind: PLATE_CONSOLIDATE_RESULT_KIND, jobId });

beforeEach(() => {
  trace.length = 0;
  seenContexts.length = 0;
  behavior.throwOn = null;
  behavior.hangOn = null;
});

describe('結果分發口排隊', () => {
  it('兩條同時到達也串行落地，不交錯', async () => {
    await Promise.all([dispatchAmsgResult(result('a')), dispatchAmsgResult(result('b'))]);

    expect(trace, '交錯的話就是兩次讀改寫撞在一起，後寫的整塊蓋掉先寫的')
      .toEqual(['enter:a', 'exit:a', 'enter:b', 'exit:b']);
  });

  it('前一條炸了也不掐斷隊列（它自己記成「帳沒銷」）', async () => {
    behavior.throwOn = 'a';

    const [first, second] = await Promise.all([
      dispatchAmsgResult(result('a')),
      dispatchAmsgResult(result('b')),
    ]);

    expect(first, '消化失敗要留著帳，下次上線再拉回來').toBe(false);
    expect(second).toBe(true);
    expect(trace).toEqual(['enter:a', 'exit:a', 'enter:b', 'exit:b']);
  });

  // 迴歸守衛：worker 可以脫開前端單獨更新（fork 的 Sync → Cloudflare Workers Builds），
  // PWA 那邊還可能跑著緩存下來的舊包——「worker 比前端新」是這套部署方式必然造得出來的
  // 狀態。當場銷帳的話，這份跑完的活兒在前端更新上來之前就已經從服務端帳本上抹掉了。
  it('認不出的結果種類先留著不銷帳（等前端更新上來還能接著處理）', async () => {
    await expect(
      dispatchAmsgResult({ resultKind: 'something-new' }),
      '銷掉的話前端更新完再來找，東西已經沒了',
    ).resolves.toBe(false);
    expect(trace).toEqual([]);
  });

  it('壓根沒有 resultKind 的照舊銷帳（形狀本身就壞了，換個版本也讀不出來）', async () => {
    await expect(dispatchAmsgResult({ nothing: true })).resolves.toBe(true);
    expect(trace).toEqual([]);
  });

  it('隨身信息（帳本上記的時間）原樣交給認領它的那一方', async () => {
    await dispatchAmsgResult(result('a'), { createdAt: 1_700_000_000_000 });

    expect(seenContexts.at(-1), 'handler 拿不到時間就沒法判「這份產物是不是已經陳到不能用」')
      .toEqual({ createdAt: 1_700_000_000_000 });
  });

  // 迴歸守衛：隊是全局一條、所有 resultKind 共用的，而 handler 幹的是 IndexedDB 的活兒。
  // 連接被別的標籤頁 block 住（IndexedDB 連接風暴時就出過這種事），promise
  // 一輩子不 settle——沒有超時的話後面每一條都永遠排不上，而且一點動靜都沒有。
  //
  // 放在最後一條：這一隊是模塊級的全局狀態，卡住那條會一直掛在隊尾。
  it('一條卡住不 settle 也不許把整條隊釘死', async () => {
    vi.useFakeTimers();
    try {
      behavior.hangOn = 'a';
      const first = dispatchAmsgResult(result('a'));
      const second = dispatchAmsgResult(result('b'));

      await vi.advanceTimersByTimeAsync(60_000);
      expect(await first, '超時那條按「帳沒銷」算，下次上線還會拉回來').toBe(false);

      // 卡住那條讓開之後，排在後面的照常輪到（它自己那次讓出事件循環也要走完）
      await vi.advanceTimersByTimeAsync(10);
      expect(await second, '排在後面的一條都落不了地，後台產物全靜默積壓').toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
