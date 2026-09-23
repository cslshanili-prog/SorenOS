// 設置頁「鏈路狀態」面板文案的迴歸守衛。
//
// 要釘住的核心行為：**能力檢測說「支持」不等於這台設備真能推**。華為 Mate 60 這類不帶
// 谷歌服務的國行安卓機上，Chromium 把 PushManager 編譯進去了，所以接口檢測全綠，但
// subscribe() 必掛。以前面板對著這種機器寫「瀏覽器支持：是」，用戶完全無從下手。

import { describe, expect, it } from 'vitest';
import {
  describeElapsed,
  describeSupport,
  hasLiveFailure,
  isSupportBad,
  liveFailureKind,
} from './pushDiagnosticsView';
import type { BrowserPushState } from './pushSubscribeShared';

const baseState = (patch: Partial<BrowserPushState> = {}): BrowserPushState => ({
  supported: true,
  capabilityGap: null,
  permission: 'granted',
  swScope: 'https://example.test/',
  swState: 'activated',
  endpoint: null,
  endpointDead: false,
  channel: '未知',
  iosNeedsPwa: false,
  capacitorNative: false,
  lastSubscribeFailure: null,
  ...patch,
});

describe('「瀏覽器支持」這一行', () => {
  it('接口齊全但連不上推送服務器時，不再簡單說「是」', () => {
    // 正是 Mate 60 的讀數：接口全在、權限已授權、SW 已激活、訂閱建不出來。
    const state = baseState({
      lastSubscribeFailure: { kind: 'channel-unreachable', text: '連不上推送服務器……', at: Date.now() },
    });

    expect(describeSupport(state)).toBe('接口齊全，但連不上推送服務器');
    expect(isSupportBad(state)).toBe(true);
  });

  it('瀏覽器沒給出訂閱時照實說「沒拿到訂閱」', () => {
    // 跟上面那條分開寫：同樣是建不出訂閱，一個知道卡在推送服務商、一個連原因都沒有，
    // 面板上不該長成一句話。
    const state = baseState({
      lastSubscribeFailure: { kind: 'no-subscription', text: '瀏覽器沒給出推送訂閱……', at: Date.now() },
    });

    expect(describeSupport(state)).toBe('接口齊全，但沒拿到訂閱');
    expect(isSupportBad(state)).toBe(true);
  });

  it('瀏覽器自稱支持但實際建不出訂閱時判「否」', () => {
    const state = baseState({
      lastSubscribeFailure: { kind: 'unsupported', text: '當前瀏覽器不支持網頁推送……', at: Date.now() },
    });

    expect(describeSupport(state)).toBe('否（瀏覽器自稱支持，實際建不出訂閱）');
    expect(isSupportBad(state)).toBe(true);
  });

  it('權限被拒、狀態衝突這類不賴設備，「瀏覽器支持」照舊是「是」', () => {
    // 這兩類換設備沒用、重試有用，標紅只會把用戶往錯的方向引。
    for (const kind of ['permission', 'state', 'zombie', 'unknown'] as const) {
      const state = baseState({ lastSubscribeFailure: { kind, text: '...', at: Date.now() } });
      expect(describeSupport(state)).toBe('是');
      expect(isSupportBad(state)).toBe(false);
    }
  });

  it('接口本身就缺、或跑在 App 裡的老判定不變', () => {
    expect(describeSupport(baseState({ supported: false }))).toBe('否（瀏覽器缺少推送相關接口）');
    expect(describeSupport(baseState({ capacitorNative: true }))).toBe('否（現在跑在 App 裡）');
    expect(isSupportBad(baseState({ supported: false }))).toBe(true);
    expect(isSupportBad(baseState({ capacitorNative: true }))).toBe(true);
  });

  it('什麼都沒失敗過時是「是」，不標紅', () => {
    expect(describeSupport(baseState())).toBe('是');
    expect(isSupportBad(baseState())).toBe(false);
  });
});

describe('失敗記錄的時效', () => {
  it('已經有活訂閱了就當沒失敗過', () => {
    // 換了瀏覽器 / SW 自愈重訂之後，舊記錄還在盤上但顯然過期了，再顯示就是誤導。
    const state = baseState({
      endpoint: 'https://fcm.googleapis.com/fcm/send/ok',
      lastSubscribeFailure: { kind: 'channel-unreachable', text: '陳年舊帳', at: 1 },
    });

    expect(hasLiveFailure(state)).toBe(false);
    expect(liveFailureKind(state)).toBeNull();
    expect(describeSupport(state)).toBe('是');
  });

  it('端點是殭屍哨兵時失敗記錄仍然算數', () => {
    const state = baseState({
      endpoint: 'https://permanently-removed.invalid/x',
      endpointDead: true,
      lastSubscribeFailure: { kind: 'channel-unreachable', text: '...', at: Date.now() },
    });

    expect(hasLiveFailure(state)).toBe(true);
    expect(liveFailureKind(state)).toBe('channel-unreachable');
  });
});

describe('describeElapsed', () => {
  const now = 1_700_000_000_000;

  it('按分鐘 / 小時 / 天說人話', () => {
    expect(describeElapsed(now - 10_000, now)).toBe('剛剛');
    expect(describeElapsed(now - 5 * 60_000, now)).toBe('5 分鐘前');
    expect(describeElapsed(now - 3 * 3600_000, now)).toBe('3 小時前');
    expect(describeElapsed(now - 2 * 86_400_000, now)).toBe('2 天前');
  });

  it('沒有時間戳就不說', () => {
    expect(describeElapsed(0, now)).toBe('');
  });
});
