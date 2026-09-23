// utils/amsg2ExpireGuard.test.ts
import { describe, it, expect } from 'vitest';
import {
  ACTIVE_CHAT_WINDOW_MS,
  FIRE_GRACE_MS,
  detectExpiredOccurrences,
  getLastRealUserMessageAt,
  hasDeliveredProactiveNear,
  hasRealUserMessageBetween,
  shouldExpireFire,
} from './amsg2ExpireGuard';

const H = 3600_000;
const user = (timestamp: number, proactiveHint = false) => ({
  role: 'user', timestamp, metadata: proactiveHint ? { proactiveHint: true } : undefined,
});
const assistantPush = (timestamp: number, taskId: string | null = 't1') => ({
  role: 'assistant', timestamp, metadata: { source: 'active_msg_2', activeMsg2: { taskId } },
});

describe('shouldExpireFire', () => {
  // 一次性和循環共用同一條規則：到點前後十分鐘內用戶在不在聊天。窗口錨在觸發時刻，
  // 所以任務排了多久都不影響——早先一次性任務走的是「排完之後用戶再開過口就作廢」的
  // 錨點規則，它沒有時間窗，跨夜任務幾乎必然被誤殺（角色半夜說「明早叫你」，用戶回
  // 一句「晚安」，第二天的早安就沒了）。「這事是不是已經聊過了」交給角色自己判，
  // 見 amsg2ExpireGuard.ts 文件頭。
  const base = { policy: 'expire', nowMs: 10 * 60_000, occurrenceMs: 10 * 60_000 };

  it('到點前窗口內在聊 → 作廢；窗口外聊過 → 放行', () => {
    expect(shouldExpireFire({ ...base, lastUserMessageAt: 10 * 60_000 - ACTIVE_CHAT_WINDOW_MS + 1 })).toBe(true);
    expect(shouldExpireFire({ ...base, lastUserMessageAt: 10 * 60_000 - ACTIVE_CHAT_WINDOW_MS - 1 })).toBe(false);
  });

  // 線上事故的最小復現，釘死不許回退：角色半夜排的「明早九點半叫你」，用戶回過話，
  // 第二天早上照發。這條一掛就說明錨點規則又被加回來了。
  it('跨夜任務照發：八小時前排的，中間用戶開過口，到點時早就不在聊了', () => {
    const occurrenceMs = 9 * H;
    expect(shouldExpireFire({
      policy: 'expire',
      lastUserMessageAt: H + 60_000,   // 排完任務之後回了句「晚安」
      occurrenceMs,
      nowMs: occurrenceMs,
    })).toBe(false);
  });

  it('熱聊窗口錨在到點時刻，判定晚十幾分鍾也不放行（worker 與客戶端送達兜底同一口徑）', () => {
    // 到點 24h，客戶端送達兜底在 15 分鐘後才判：窗口仍是到點前後各十分鐘，
    // 拿 nowMs 當錨點的話這條 9 分鐘前的用戶消息會落到窗外被誤放行。
    const late = { policy: 'expire', occurrenceMs: 24 * H, nowMs: 24 * H + 15 * 60_000 };
    expect(shouldExpireFire({ ...late, lastUserMessageAt: 24 * H - 9 * 60_000 })).toBe(true);
    expect(shouldExpireFire({ ...late, lastUserMessageAt: 24 * H - 11 * 60_000 })).toBe(false);
  });

  // 窗口的**右**邊界也必須錨在到點時刻。右界拿 nowMs 的話，窗口在晚判定的路徑上會一路
  // 撐成 (到點-10min, 現在]：推送晚送達、或者 48h 補收把消息撈回來時，用戶到點之後隨便
  // 哪個時刻開過一次口，這條定時消息就被吞掉 + 銷帳 + 撤掉雲端自述日誌。更糟的是排程
  // 現狀塊用的是對稱窗 (到點±10min]，它查不到這次吞沒，作廢回執整段失聯——角色既沒說
  // 那句話，也不知道自己那條排程已經沒了。
  it('到點兩小時後才開的口，晚判定時也不算熱聊（右界跟檢出側的對稱窗一致）', () => {
    const occurrenceMs = 9 * H;
    expect(shouldExpireFire({
      policy: 'expire',
      lastUserMessageAt: 11 * H,       // 到點兩小時後隨口說了句話
      occurrenceMs,
      nowMs: 14 * H,                   // 五小時後補收才把這條消息撈回來判定
    })).toBe(false);
  });

  it('到點後五分鐘內開的口照舊算熱聊（對稱窗的右半邊沒被改壞）', () => {
    const occurrenceMs = 9 * H;
    expect(shouldExpireFire({
      policy: 'expire',
      lastUserMessageAt: occurrenceMs + 5 * 60_000,
      occurrenceMs,
      nowMs: 14 * H,
    })).toBe(true);
  });

  it('到點之後才開的口不算（那是消息發出去之後用戶回的話）', () => {
    expect(shouldExpireFire({
      policy: 'expire', occurrenceMs: 10 * 60_000, nowMs: 10 * 60_000, lastUserMessageAt: 10 * 60_000 + 1,
    })).toBe(false);
  });

  it('force / 未知策略 / 舊任務無策略 → 永遠放行', () => {
    expect(shouldExpireFire({ ...base, policy: 'force', lastUserMessageAt: 10 * 60_000 - 1 })).toBe(false);
    expect(shouldExpireFire({ ...base, policy: undefined, lastUserMessageAt: 10 * 60_000 - 1 })).toBe(false);
  });

  // 缺數據 = 判不了 = 放行。這道閘只擋它能確定的那一檔，剩下的交給角色自己判。
  it('缺觸發時刻 / 一條用戶消息都沒有 → 放行', () => {
    expect(shouldExpireFire({ ...base, occurrenceMs: undefined, lastUserMessageAt: 10 * 60_000 - 1 })).toBe(false);
    expect(shouldExpireFire({ ...base, lastUserMessageAt: null })).toBe(false);
  });
});

describe('消息掃描 helpers', () => {
  it('getLastRealUserMessageAt 跳過 proactiveHint 和 assistant', () => {
    expect(getLastRealUserMessageAt([user(1), assistantPush(2), user(3, true)])).toBe(1);
    expect(getLastRealUserMessageAt([assistantPush(2)])).toBe(null);
  });
  it('hasRealUserMessageBetween 是 (after, before] 半開區間', () => {
    const msgs = [user(100), user(200)];
    expect(hasRealUserMessageBetween(msgs, 100, 200)).toBe(true);
    expect(hasRealUserMessageBetween(msgs, 200, 300)).toBe(false);
  });
  it('hasDeliveredProactiveNear 只認 taskId 非空的 active_msg_2 消息', () => {
    const withCid = (taskId: string | null) => ({
      role: 'assistant', timestamp: 1000,
      metadata: { source: 'active_msg_2', activeMsg2: { taskId }, amsgClientTaskId: 'cid-A' },
    });
    expect(hasDeliveredProactiveNear([withCid('t1')], 1000, 'cid-A')).toBe(true);
    expect(hasDeliveredProactiveNear([withCid(null)], 1000, 'cid-A')).toBe(false); // instant 回覆不算
  });
  it('hasDeliveredProactiveNear 按精確 id 歸屬：id 不同或缺 id 都不算本任務的送達', () => {
    const withCid = { role: 'assistant', timestamp: 1000, metadata: { source: 'active_msg_2', activeMsg2: { taskId: 't1' }, amsgClientTaskId: 'cid-A' } };
    expect(hasDeliveredProactiveNear([withCid], 1000, 'cid-A')).toBe(true);
    expect(hasDeliveredProactiveNear([withCid], 1000, 'cid-B')).toBe(false); // A 的送達不能抹掉 B 的回執
    expect(hasDeliveredProactiveNear([assistantPush(1000)], 1000, 'cid-A')).toBe(false); // 缺 amsgClientTaskId 的消息不是本任務的送達
  });
});

describe('detectExpiredOccurrences（排程現狀塊的作廢檢出）', () => {
  const NOW = 100 * H;

  // 檢出口徑必須跟閘本身一模一樣（見 shouldExpireFire）：這裡說「作廢了」而閘其實
  // 放行了的話，角色會為一條用戶明明收到的消息道歉，比不說還糟。
  it('一次性：到點前後窗口內在聊 → 檢出；窗口外聊過 → 不檢出', () => {
    const fireAt = NOW - 2 * H;
    const base = {
      taskUuid: 'u1', policy: 'expire', recurrenceType: 'none',
      firstSendTime: new Date(fireAt).toISOString(), nowMs: NOW,
    };
    expect(detectExpiredOccurrences({ ...base, messages: [user(fireAt - 60_000)] }))
      .toEqual([{ id: 'u1', occurrenceMs: fireAt }]);
    // 到點之後一會兒開的口也算：Cron 可能晚幾分鐘才 fire，對稱窗把這一段蓋住。
    // 「其實已正常送達」的排除由調用方用 hasDeliveredProactiveNear 按任務歸屬做。
    expect(detectExpiredOccurrences({ ...base, messages: [user(fireAt + 60_000)] }))
      .toEqual([{ id: 'u1', occurrenceMs: fireAt }]);
    // 五小時前聊過的不算——早先的錨點規則會把這一條判成作廢，正是跨夜誤殺的來源。
    expect(detectExpiredOccurrences({ ...base, messages: [user(fireAt - 5 * H)] })).toEqual([]);
  });
  it('循環：只檢出「到點前窗口內在聊」的那幾次，id 帶 occurrence 時間戳', () => {
    const first = NOW - 30 * H;
    const o2 = first + 24 * H;
    const out = detectExpiredOccurrences({
      taskUuid: 'u1', policy: 'expire', recurrenceType: 'daily',
      firstSendTime: new Date(first).toISOString(),
      messages: [user(o2 - 60_000)], nowMs: NOW,
    });
    expect(out).toEqual([{ id: `u1:${o2}`, occurrenceMs: o2 }]);
  });
  it('循環 weekly：週期 7 天，快進到回看期後只檢出到點前窗口內在聊的那次', () => {
    const first = NOW - 8 * 24 * H;
    const o2 = first + 7 * 24 * H;
    const out = detectExpiredOccurrences({
      taskUuid: 'w1', policy: 'expire', recurrenceType: 'weekly',
      firstSendTime: new Date(first).toISOString(),
      messages: [user(o2 - 60_000)], nowMs: NOW,
    });
    expect(out).toEqual([{ id: `w1:${o2}`, occurrenceMs: o2 }]);
  });
  it('未來的任務 / force 策略 → 空', () => {
    expect(detectExpiredOccurrences({
      taskUuid: 'u1', policy: 'expire', recurrenceType: 'none',
      firstSendTime: new Date(NOW + H).toISOString(),
      messages: [user(NOW - 1)], nowMs: NOW,
    })).toEqual([]);
    expect(detectExpiredOccurrences({
      taskUuid: 'u1', policy: 'force', recurrenceType: 'none',
      firstSendTime: new Date(NOW - H).toISOString(),
      messages: [user(NOW - 1)], nowMs: NOW,
    })).toEqual([]);
  });
});
