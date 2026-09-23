// utils/amsgStateClock.test.ts
//
// 迴歸守衛（雲端 client_state 那一行的版本號該蓋幾點）：
//   1. 時鐘正常走的時候蓋的戳就是牆鍾本身。這一層絕不能給正常路徑引入偏移——雲端那行
//      一旦莫名其妙領先真實時間，換台設備（水位是空的）就寫不進去了。
//   2. 設備時鐘被回撥之後，蓋出去的戳仍然往前走。這是這個模塊存在的全部理由：雲端是
//      條件寫（舊不蓋新），戳只要回頭，那台設備就再也寫不進去。
//   3. 雲端那行落在未來時，照它對齊一次就能跨過去——這是已經卡住的人唯一的出路。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AMSG_STATE_CLOCK_LS_KEY,
  observeRemoteStateUpdatedAt,
  readStateClockWatermark,
  resetStateClock,
  stampStateUpdatedAt,
} from './amsgStateClock';

/** 讓 Date.now 按給定的序列往外吐（用完停在最後一個）。 */
const mockClock = (values: number[]) => {
  let i = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => values[Math.min(i++, values.length - 1)]);
};

beforeEach(() => {
  resetStateClock();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetStateClock();
});

describe('蓋戳', () => {
  it('時鐘正常往前走時，蓋的就是牆鍾本身（不引入任何偏移）', () => {
    mockClock([1_000, 2_000, 3_000]);

    expect(stampStateUpdatedAt()).toBe(1_000);
    expect(stampStateUpdatedAt()).toBe(2_000);
    expect(stampStateUpdatedAt()).toBe(3_000);
  });

  it('同一毫秒內連寫兩次也嚴格遞增（條件寫用的是 >=，相等能過，但遞增更穩）', () => {
    mockClock([1_000]);

    expect(stampStateUpdatedAt()).toBe(1_000);
    expect(stampStateUpdatedAt()).toBe(1_001);
  });

  it('時鐘被回撥之後，戳不跟著回頭', () => {
    // 5 秒處寫過一次，然後用戶把鍾往回撥了 1 秒。
    mockClock([5_000, 4_000, 4_001]);

    expect(stampStateUpdatedAt()).toBe(5_000);
    expect(stampStateUpdatedAt()).toBe(5_001);
    expect(stampStateUpdatedAt()).toBe(5_002);
  });

  it('水位落盤，重新讀得回來（關掉頁面再回來，雲端那行還在原地）', () => {
    mockClock([7_000]);

    stampStateUpdatedAt();
    expect(localStorage.getItem(AMSG_STATE_CLOCK_LS_KEY)).toBe('7000');
  });
});

describe('照雲端對齊', () => {
  it('雲端那行落在未來 → 對齊一次，之後蓋的戳就跨過去了', () => {
    // 本機的鐘停在 5 秒處，雲端那行卻記著 9 秒（當初設備時鐘領先時寫進去的）。
    mockClock([5_000]);

    expect(observeRemoteStateUpdatedAt(9_000)).toBe(true);
    expect(stampStateUpdatedAt()).toBe(9_001);
  });

  it('雲端那行比水位舊 → 不動水位，也不謊報對齊過（重發是白發）', () => {
    mockClock([5_000]);
    stampStateUpdatedAt();

    expect(observeRemoteStateUpdatedAt(3_000)).toBe(false);
    expect(readStateClockWatermark()).toBe(5_000);
  });

  it('雲端回的不是個正經時間戳 → 一律不動水位', () => {
    mockClock([5_000]);
    stampStateUpdatedAt();

    for (const bad of [undefined, null, 'a', NaN, 1.5, Number.MAX_VALUE]) {
      expect(observeRemoteStateUpdatedAt(bad)).toBe(false);
    }
    expect(readStateClockWatermark()).toBe(5_000);
  });
});
