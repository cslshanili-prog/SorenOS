// 「訂閱建不出來時，用戶能不能看懂為什麼」這條鏈路的迴歸守衛。
//
// 背景：華為 Mate 60（國行安卓機，出廠不帶谷歌服務）上的實測——面板顯示瀏覽器支持=是、
// 權限=已授權、SW=已激活，瀏覽器訂閱就是「不存在」，點多少次重置都沒變化。根因是
// Chromium 系的網頁推送要轉交系統裡的谷歌服務（GMS）去註冊，沒 GMS 就必掛；而失敗原文
// 只走 toast，一閃而過，用戶回頭什麼都看不到。
//
// 這裡釘住三件事：失敗要分得出「換設備才有救」這一類、失敗要落盤、修好之後記錄要清掉。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSubscribeFailure,
  explainSubscribeError,
  readSubscribeFailure,
  rememberSubscribeFailure,
  subscribeWithRetry,
  SUBSCRIBE_ATTEMPTS_MAX,
} from './pushSubscribeShared';

/** 合法的 base64url，只為讓 b64uToBytes 別在 atob 上炸。 */
const FAKE_VAPID = 'AAAA';

const makeRegistration = (subscribe: () => Promise<unknown>) =>
  ({ pushManager: { subscribe } }) as unknown as ServiceWorkerRegistration;

const makeSubscription = (endpoint: string) => ({
  endpoint,
  unsubscribe: async () => true,
});

const namedError = (name: string, message = '') => {
  const error = new Error(message);
  error.name = name;
  return error;
};

beforeEach(() => {
  clearSubscribeFailure();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('explainSubscribeError 的失敗分類', () => {
  it('把「連不上推送服務器」單獨歸成 channel-unreachable', () => {
    // 沒裝谷歌服務的安卓機上，Chromium 就是這麼拋的。這一類跟「訂閱失敗」必須分開：
    // 前者重試無用、只能換瀏覽器/換設備，後者才值得讓用戶再點一次。
    expect(explainSubscribeError(namedError('AbortError')).kind).toBe('channel-unreachable');
    expect(
      explainSubscribeError(namedError('Error', 'Registration failed - push service error')).kind,
    ).toBe('channel-unreachable');
  });

  it('給出的建議裡帶上「換 Firefox」這條同機可走的路', () => {
    // 只說「換台設備 / 用電腦」的話，手上只有這一台手機的用戶就走到頭了。
    // Firefox 的推送走 Mozilla 自己的服務器，不經過谷歌，是同一台機器上唯一的希望。
    expect(explainSubscribeError(namedError('AbortError')).text).toContain('Firefox');
  });

  it('權限、內核不支持、狀態衝突各歸各的', () => {
    expect(explainSubscribeError(namedError('NotAllowedError')).kind).toBe('permission');
    expect(explainSubscribeError(namedError('NotSupportedError')).kind).toBe('unsupported');
    expect(explainSubscribeError(namedError('InvalidStateError')).kind).toBe('state');
    expect(explainSubscribeError(namedError('WeirdError', '沒見過')).kind).toBe('unknown');
  });
});

describe('subscribeWithRetry 的失敗落盤', () => {
  it('subscribe 拋錯時把原因記下來，面板才有得顯示', async () => {
    const registration = makeRegistration(async () => { throw namedError('AbortError'); });

    const result = await subscribeWithRetry(registration, FAKE_VAPID, '[test]');

    expect(result.sub).toBeNull();
    expect(result.failure?.kind).toBe('channel-unreachable');
    // 關鍵：落了盤。以前只有 toast，用戶點完重置一眨眼就沒了，回頭再看面板還是乾巴巴
    // 一行「不存在」。
    const stored = readSubscribeFailure();
    expect(stored?.kind).toBe('channel-unreachable');
    expect(stored?.text).toBe(result.failure?.text);
    expect(stored?.at).toBeGreaterThan(0);
  });

  it('訂閱建成時把上一次的失敗記錄清掉', async () => {
    rememberSubscribeFailure({ kind: 'channel-unreachable', text: '陳年舊帳', at: 1 });
    const registration = makeRegistration(async () => makeSubscription('https://fcm.googleapis.com/fcm/send/ok'));

    const result = await subscribeWithRetry(registration, FAKE_VAPID, '[test]');

    expect(result.sub).not.toBeNull();
    // 不清的話，用戶換了瀏覽器修好了，面板還掛著一條早就過期的紅色失敗，比不顯示更糟。
    expect(readSubscribeFailure()).toBeNull();
  });

  it('重試到底還是殭屍端點時歸成 zombie 並落盤', async () => {
    vi.useFakeTimers();
    const subscribe = vi.fn(async () => makeSubscription('https://permanently-removed.invalid/x'));
    const pending = subscribeWithRetry(makeRegistration(subscribe), FAKE_VAPID, '[test]');
    await vi.runAllTimersAsync();
    const result = await pending;
    vi.useRealTimers();

    expect(subscribe).toHaveBeenCalledTimes(SUBSCRIBE_ATTEMPTS_MAX);
    expect(result.sub).toBeNull();
    expect(result.failure?.kind).toBe('zombie');
    expect(readSubscribeFailure()?.kind).toBe('zombie');
  });
});

// 安卓 Firefox 上的實測：subscribe() 既不拋錯也不給訂閱，直接兌現成 null。之前的代碼
// 只防了拋錯，緊接著讀 endpoint 就拋 TypeError——用戶看到的是「can't access property
// "endpoint", r is null」，而面板上一條失敗記錄都留不下。
describe('subscribe() 兌現成空值', () => {
  it('拿不到訂閱就按失敗處理，不去讀它的 endpoint', async () => {
    const registration = makeRegistration(async () => null);

    const result = await subscribeWithRetry(registration, FAKE_VAPID, '[test]');

    expect(result.sub).toBeNull();
    expect(result.failure?.kind).toBe('no-subscription');
    // 落了盤面板才說得出原因——這一條正是原來那個報錯吞掉的東西。
    expect(readSubscribeFailure()?.kind).toBe('no-subscription');
    expect(readSubscribeFailure()?.text).toBe(result.failure?.text);
  });

  it('只說事實和下一步，不替瀏覽器猜原因', async () => {
    const text = (await subscribeWithRetry(makeRegistration(async () => null), FAKE_VAPID, '[test]')).failure?.text || '';

    // 瀏覽器一個錯誤對象都沒給，說是谷歌服務沒裝、還是 Mozilla 那邊連不上，都是編的。
    expect(text).not.toContain('GMS');
    expect(text).not.toContain('Mozilla');
    // 但得留下能動手的下一步，否則用戶對著「沒拿到訂閱」還是乾瞪眼。
    expect(text).toContain('換個網絡');
    expect(text).toContain('換個瀏覽器');
  });

  it('跟「連不上推送服務商」分開歸類', async () => {
    // 面板的說法、上報的代號都按這個分。混成一格的話，Firefox 這種空值就永遠藏在
    // 「沒裝谷歌服務」的統計裡，看不出有多少人是另一種壞法。
    const empty = await subscribeWithRetry(makeRegistration(async () => null), FAKE_VAPID, '[test]');
    const thrown = await subscribeWithRetry(
      makeRegistration(async () => { throw namedError('AbortError'); }),
      FAKE_VAPID,
      '[test]',
    );

    expect(empty.failure?.kind).not.toBe(thrown.failure?.kind);
  });
});

describe('readSubscribeFailure 的容錯', () => {
  it('存的東西壞了就當沒有，不拋', () => {
    localStorage.setItem('push_last_subscribe_failure_v1', '{不是 JSON');
    expect(readSubscribeFailure()).toBeNull();

    localStorage.setItem('push_last_subscribe_failure_v1', JSON.stringify({ kind: 'x' }));
    expect(readSubscribeFailure()).toBeNull();
  });
});
