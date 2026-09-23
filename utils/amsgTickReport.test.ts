import { describe, expect, it } from 'vitest';
import {
  classifyOverdueTasks,
  judgeOverdueTasks,
  type TickTaskFacts,
} from './amsgTickReport';

const NOW = Date.parse('2026-09-18T12:00:00.000Z');
const minutesAgo = (n: number) => NOW - n * 60_000;
const minutesLater = (n: number) => NOW + n * 60_000;

/** 一條「建好就沒人碰過」的任務，按需覆蓋字段。 */
const task = (overrides: Partial<TickTaskFacts> = {}): TickTaskFacts => ({
  nextSendAtMs: minutesAgo(40),
  createdAtMs: minutesAgo(120),
  updatedAtMs: minutesAgo(120),
  retryAfterMs: null,
  leaseUntilMs: null,
  currentErrorAtMs: null,
  serializeKey: 'char-a',
  ...overrides,
});

const classifyOne = (facts: TickTaskFacts) => classifyOverdueTasks([facts], NOW)[0];

describe('classifyOverdueTasks — 一條過期任務現在算哪種情況', () => {
  /**
   * 迴歸守衛：重試期間任務的到點時刻不會往後挪，一條在正常重試的任務「晚了四十分鐘」
   * 很平常。只看晚了多久的話，它會被報成「定時觸發器可能沒在跑」。
   */
  it('在等重試的不算卡住，哪怕到點已經很久了', () => {
    const verdict = classifyOne(task({
      retryAfterMs: minutesLater(4),
      currentErrorAtMs: minutesAgo(2),
      updatedAtMs: minutesAgo(2) + 30,
    }));
    expect(verdict.state).toBe('retry-wait');
    expect(verdict.stuck).toBe(false);
    // 記失敗那一筆和 updated_at 是前後腳寫的，不能當成「後來又開跑了一次」。
    expect(verdict.lastStartedAtMs).toBeNull();
  });

  it('重試時間剛到、下一跳還沒來，不算卡住（要從重試時刻起算，不是從到點起算）', () => {
    const verdict = classifyOne(task({
      retryAfterMs: minutesAgo(1),
      currentErrorAtMs: minutesAgo(5),
      updatedAtMs: minutesAgo(5),
    }));
    expect(verdict.state).toBe('ready');
    expect(verdict.stuck).toBe(false);
  });

  it('到點很久一直沒人領 → 卡住', () => {
    const verdict = classifyOne(task());
    expect(verdict.state).toBe('ready');
    expect(verdict.stuck).toBe(true);
    expect(verdict.unfinishedAttempt).toBe(false);
  });

  it('剛到點一兩分鐘不算卡住——cron 一分鐘一跳', () => {
    expect(classifyOne(task({ nextSendAtMs: minutesAgo(1) })).stuck).toBe(false);
  });

  it('開跑過、租約自己到期、行上什麼都沒留下 → 半路沒了，算卡住', () => {
    const verdict = classifyOne(task({
      updatedAtMs: minutesAgo(38),
      leaseUntilMs: minutesAgo(36),
    }));
    expect(verdict.state).toBe('ready');
    expect(verdict.unfinishedAttempt).toBe(true);
    expect(verdict.lastStartedAtMs).toBe(minutesAgo(38));
    expect(verdict.stuck).toBe(true);
  });

  it('失敗過一次、重試時刻到了之後又開跑、然後沒了下文 → 也認得出來', () => {
    const verdict = classifyOne(task({
      currentErrorAtMs: minutesAgo(20),
      retryAfterMs: minutesAgo(18),
      updatedAtMs: minutesAgo(17),
      leaseUntilMs: minutesAgo(15),
    }));
    expect(verdict.unfinishedAttempt).toBe(true);
    expect(verdict.stuck).toBe(true);
  });

  it('剛建好的任務（建的時刻就是到點時刻）不算開跑過', () => {
    const verdict = classifyOne(task({
      nextSendAtMs: minutesAgo(1),
      createdAtMs: minutesAgo(1) + 5,
      updatedAtMs: minutesAgo(1) + 5,
    }));
    expect(verdict.lastStartedAtMs).toBeNull();
    expect(verdict.unfinishedAttempt).toBe(false);
  });

  it('到點就開跑、正在發 → 正常', () => {
    const verdict = classifyOne(task({
      nextSendAtMs: minutesAgo(7),
      updatedAtMs: minutesAgo(7) + 20_000,
      leaseUntilMs: minutesLater(1),
    }));
    expect(verdict.state).toBe('sending');
    expect(verdict.lateStart).toBe(false);
    expect(verdict.stuck).toBe(false);
  });

  it('正在發，但到點半小時後才開跑 → 標出來開跑晚了（前面那段沒被正常處理）', () => {
    const verdict = classifyOne(task({
      updatedAtMs: minutesAgo(10),
      leaseUntilMs: minutesLater(1),
    }));
    expect(verdict.state).toBe('sending');
    expect(verdict.lateStart).toBe(true);
    expect(verdict.stuck).toBe(false);
  });

  it('同一個角色另一條正在發 → 這條在排隊，不算卡住', () => {
    const [sending, waiting] = classifyOverdueTasks([
      task({ nextSendAtMs: minutesAgo(9), updatedAtMs: minutesAgo(9), leaseUntilMs: minutesLater(1) }),
      task({ nextSendAtMs: minutesAgo(8) }),
    ], NOW);
    expect(sending.state).toBe('sending');
    expect(waiting.queuedBehind).toBe(true);
    expect(waiting.stuck).toBe(false);
  });

  it('正在發的是別的角色 → 不算排隊，照樣卡住', () => {
    const [, waiting] = classifyOverdueTasks([
      task({ serializeKey: 'char-b', updatedAtMs: minutesAgo(9), leaseUntilMs: minutesLater(1), nextSendAtMs: minutesAgo(9) }),
      task({ nextSendAtMs: minutesAgo(8) }),
    ], NOW);
    expect(waiting.queuedBehind).toBe(false);
    expect(waiting.stuck).toBe(true);
  });

  it('解不開任務內容（沒有分組鍵）時不瞎猜排隊', () => {
    const [, waiting] = classifyOverdueTasks([
      task({ serializeKey: null, updatedAtMs: minutesAgo(9), leaseUntilMs: minutesLater(1), nextSendAtMs: minutesAgo(9) }),
      task({ serializeKey: null, nextSendAtMs: minutesAgo(8) }),
    ], NOW);
    expect(waiting.queuedBehind).toBe(false);
    expect(waiting.stuck).toBe(true);
  });
});

describe('judgeOverdueTasks — 合起來算什麼狀態', () => {
  const verdictOf = (facts: TickTaskFacts) => classifyOne(facts);

  it('有卡住的就是 stalled', () => {
    expect(judgeOverdueTasks([
      { verdict: verdictOf(task()), hasCurrentError: false },
      { verdict: verdictOf(task({ retryAfterMs: minutesLater(2), currentErrorAtMs: minutesAgo(1) })), hasCurrentError: true },
    ])).toBe('stalled');
  });

  it('只是在失敗重試 → failing（有問題，但跟定時觸發器無關）', () => {
    expect(judgeOverdueTasks([
      { verdict: verdictOf(task({ retryAfterMs: minutesLater(2), currentErrorAtMs: minutesAgo(1) })), hasCurrentError: true },
    ])).toBe('failing');
  });

  it('開跑晚得不正常 → failing', () => {
    expect(judgeOverdueTasks([
      { verdict: verdictOf(task({ updatedAtMs: minutesAgo(10), leaseUntilMs: minutesLater(1) })), hasCurrentError: false },
    ])).toBe('failing');
  });

  it('都在正常處理 → healthy', () => {
    expect(judgeOverdueTasks([])).toBe('healthy');
    expect(judgeOverdueTasks([
      { verdict: verdictOf(task({ nextSendAtMs: minutesAgo(1) })), hasCurrentError: false },
    ])).toBe('healthy');
  });
});
