// utils/amsg2DebugView.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildAmsg2DebugTasks,
  clampPanelPosition,
  formatCountdown,
  nextCronTickMs,
  DEBUG_PANEL_MARGIN_PX,
} from './amsg2DebugView';
import { currentOccurrenceMs, isPendingTask } from './amsg2Tasks';
import { FIRE_GRACE_MS } from './amsg2ExpireGuard';
import type { ActiveMsg2TaskRecord, CharacterProfile } from '../types';

const MIN = 60_000;
const H = 3600_000;
const DAY = 24 * H;

// 時鐘寫死，不碰 Date.now()：這裡斷言的全是「相對某一刻算出什麼狀態」，
// 默認值要是跟著真實時間飄，狀態分界的用例會隨跑測試的時間點時靈時不靈。
const NOW = new Date('2026-07-26T14:00:00.000Z').getTime();

const task = (extra: Partial<ActiveMsg2TaskRecord> = {}): ActiveMsg2TaskRecord => ({
  taskUuid: 'aabbccdd-0000-0000-0000-000000000000',
  clientTaskId: 'cid-aabb',
  mode: 'auto',
  firstSendTime: new Date(NOW + H).toISOString(),
  recurrenceType: 'none',
  expirePolicy: 'expire',
  source: 'character',
  status: 'scheduled',
  createdAt: NOW,
  ...extra,
});

const char = (tasks: ActiveMsg2TaskRecord[], extra: Record<string, unknown> = {}): CharacterProfile =>
  ({
    id: 'char-1',
    name: '楚小南',
    activeMsg2Config: { enabled: true, tasks },
    ...extra,
  }) as unknown as CharacterProfile;

describe('nextCronTickMs', () => {
  // worker 的 cron 是 "* * * * *"，每分鐘跑一次，跑起來時把「名義時間已經到了」的任務
  // 全部領走（底帳查詢是 next_send_at <= 當前時刻）。這裡算的就是：這一次觸發
  // 會被哪一分鐘的 cron 領走。
  it('名義時間壓在整分上時，就是這一分鐘的 cron 領走它', () => {
    const fire = new Date('2026-07-26T14:07:00.000Z').getTime();
    expect(nextCronTickMs(fire)).toBe(new Date('2026-07-26T14:07:00.000Z').getTime());
  });

  it('名義時間落在分鐘中間時，要等下一個整分的 cron', () => {
    const fire = new Date('2026-07-26T14:07:39.000Z').getTime();
    expect(nextCronTickMs(fire)).toBe(new Date('2026-07-26T14:08:00.000Z').getTime());
  });

  it('過了整分哪怕只有 1 毫秒，也歸下一個整分', () => {
    const fire = new Date('2026-07-26T14:07:00.001Z').getTime();
    expect(nextCronTickMs(fire)).toBe(new Date('2026-07-26T14:08:00.000Z').getTime());
  });

  // 釘死兩條邊界：tick 不能早於名義時間（早了會讓人以為任務漏發），
  // 也不能整整甩開一分鐘（晚了會跟同一行的倒計時對不上）。
  it('算出來的 tick 落在 [名義時間, 名義時間+1分鐘) 裡', () => {
    const base = new Date('2026-07-26T14:07:00.000Z').getTime();
    for (const offset of [0, 1, 999, 1_000, 30_000, 59_999]) {
      const fire = base + offset;
      const tick = nextCronTickMs(fire);
      expect(tick).toBeGreaterThanOrEqual(fire);
      expect(tick - fire).toBeLessThan(MIN);
    }
  });
});

describe('currentOccurrenceMs', () => {
  // 迴歸守衛：循環任務的 firstSendTime 是「第一次」的時間，可能是幾天前。
  // 直接拿它算倒計時會顯示一個早就過去的負數——面板必須按週期推到當前這一次。
  it('每天循環：firstSendTime 在三天前時推到今天/明天的那一次，而不是原地不動', () => {
    const first = new Date('2026-07-23T09:00:00.000Z').getTime();
    const now = new Date('2026-07-26T14:00:00.000Z').getTime();
    const occurrence = currentOccurrenceMs(
      task({ firstSendTime: new Date(first).toISOString(), recurrenceType: 'daily' }),
      now,
    );
    expect(occurrence).toBe(new Date('2026-07-27T09:00:00.000Z').getTime());
    expect(occurrence).toBeGreaterThan(now);
  });

  it('每週循環按 7 天推', () => {
    const first = new Date('2026-07-05T09:00:00.000Z').getTime();
    const now = new Date('2026-07-26T14:00:00.000Z').getTime();
    expect(
      currentOccurrenceMs(
        task({ firstSendTime: new Date(first).toISOString(), recurrenceType: 'weekly' }),
        now,
      ),
    ).toBe(new Date('2026-08-02T09:00:00.000Z').getTime());
  });

  it('剛過點但還在送達寬限內時，停在這一次而不是跳到下一次', () => {
    const first = new Date('2026-07-26T09:00:00.000Z').getTime();
    const now = first + FIRE_GRACE_MS - 1_000;
    expect(
      currentOccurrenceMs(
        task({ firstSendTime: new Date(first).toISOString(), recurrenceType: 'daily' }),
        now,
      ),
    ).toBe(first);
  });

  it('一次性任務恆為 firstSendTime，過點也不推', () => {
    const first = new Date('2026-07-20T09:00:00.000Z').getTime();
    const now = new Date('2026-07-26T14:00:00.000Z').getTime();
    expect(currentOccurrenceMs(task({ firstSendTime: new Date(first).toISOString() }), now)).toBe(first);
  });

  it('時間串解析不了時返回 null，不拋錯也不返回 NaN', () => {
    expect(currentOccurrenceMs(task({ firstSendTime: '不是時間' }), NOW)).toBeNull();
  });
});

describe('formatCountdown', () => {
  it('未到點顯示 T-，已過點顯示 T+', () => {
    expect(formatCountdown(4 * MIN + 12_000)).toBe('T-4m12s');
    expect(formatCountdown(-30_000)).toBe('T+30s');
  });

  it('不足一分鐘不帶 m，超過一小時帶 h', () => {
    expect(formatCountdown(12_000)).toBe('T-12s');
    expect(formatCountdown(2 * H + 3 * MIN + 4_000)).toBe('T-2h3m4s');
  });
});

describe('buildAmsg2DebugTasks', () => {
  const now = NOW;

  it('把每個角色的任務攤平，帶上角色名和該角色的主動消息總開關', () => {
    const views = buildAmsg2DebugTasks(
      [char([task()], { id: 'c1', name: '楚小南' })],
      now,
    );
    expect(views).toHaveLength(1);
    expect(views[0].charName).toBe('楚小南');
    expect(views[0].charEnabled).toBe(true);
  });

  it('角色關掉主動消息時 charEnabled 為 false，但任務照樣列出來', () => {
    const views = buildAmsg2DebugTasks(
      [char([task()], { activeMsg2Config: { enabled: false, tasks: [task()] } })],
      now,
    );
    expect(views).toHaveLength(1);
    expect(views[0].charEnabled).toBe(false);
  });

  // 迴歸守衛：狀態分類必須跟 isPendingTask 完全同口徑。
  // 面板說「待觸發」而系統認為已失效（或反過來），排查時會把人帶溝裡。
  it('pending / firing 兩態之和恰好等於 isPendingTask 為真的集合', () => {
    const cases = [
      task({ taskUuid: 'future00-0000-0000-0000-000000000000', firstSendTime: new Date(now + H).toISOString() }),
      task({ taskUuid: 'ingrace0-0000-0000-0000-000000000000', firstSendTime: new Date(now - 30_000).toISOString() }),
      task({ taskUuid: 'expired0-0000-0000-0000-000000000000', firstSendTime: new Date(now - H).toISOString() }),
      task({ taskUuid: 'daily000-0000-0000-0000-000000000000', firstSendTime: new Date(now - 3 * DAY).toISOString(), recurrenceType: 'daily' }),
      task({ taskUuid: 'cancel00-0000-0000-0000-000000000000', status: 'cancelled' }),
    ];
    const views = buildAmsg2DebugTasks([char(cases)], now);
    for (const view of views) {
      const live = view.state === 'pending' || view.state === 'firing';
      expect(live).toBe(isPendingTask(view.task, now));
    }
  });

  it('已取消的任務標成 cancelled，不會混進待觸發裡', () => {
    const views = buildAmsg2DebugTasks([char([task({ status: 'cancelled' })])], now);
    expect(views[0].state).toBe('cancelled');
  });

  it('一次性任務過點超過送達寬限後標成 expired', () => {
    const fire = now - FIRE_GRACE_MS - 1_000;
    const views = buildAmsg2DebugTasks([char([task({ firstSendTime: new Date(fire).toISOString() })])], now);
    expect(views[0].state).toBe('expired');
  });

  it('一次性任務剛過點、還在送達寬限內時標成 firing', () => {
    const fire = now - 30_000;
    const views = buildAmsg2DebugTasks([char([task({ firstSendTime: new Date(fire).toISOString() })])], now);
    expect(views[0].state).toBe('firing');
  });

  it('活的任務排在失效的前面；活的按觸發時間由近到遠', () => {
    const soon = task({ taskUuid: 'soon0000-0000-0000-0000-000000000000', firstSendTime: new Date(now + 5 * MIN).toISOString() });
    const later = task({ taskUuid: 'later000-0000-0000-0000-000000000000', firstSendTime: new Date(now + H).toISOString() });
    const dead = task({ taskUuid: 'dead0000-0000-0000-0000-000000000000', firstSendTime: new Date(now - 5 * H).toISOString() });
    const views = buildAmsg2DebugTasks([char([later, dead, soon])], now);
    expect(views.map((v) => v.task.taskUuid.slice(0, 8))).toEqual(['soon0000', 'later000', 'dead0000']);
  });

  // 面板一行裡同時有倒計時和「開跑」時刻，兩個數字必須指向同一分鐘。
  it('名義時間壓在整分上時，開跑時刻就是倒計時歸零的那一刻', () => {
    const fire = new Date('2026-07-26T14:30:00.000Z').getTime();
    const views = buildAmsg2DebugTasks(
      [char([task({ firstSendTime: new Date(fire).toISOString() })])],
      fire - 5 * MIN,
    );
    expect(views[0].occurrenceMs).toBe(fire);
    expect(views[0].cronTickMs).toBe(fire);
  });

  it('名義時間帶秒數時，開跑時刻是它後面的第一個整分', () => {
    const fire = new Date('2026-07-26T14:30:21.000Z').getTime();
    const views = buildAmsg2DebugTasks(
      [char([task({ firstSendTime: new Date(fire).toISOString() })])],
      fire - 5 * MIN,
    );
    expect(views[0].cronTickMs).toBe(new Date('2026-07-26T14:31:00.000Z').getTime());
  });

  it('沒配 amsg2 的角色直接跳過，不報錯', () => {
    const plain = { id: 'c9', name: '路人' } as unknown as CharacterProfile;
    expect(buildAmsg2DebugTasks([plain], now)).toEqual([]);
  });
});

describe('clampPanelPosition', () => {
  const PANEL = { width: 330, height: 400 };
  const VIEWPORT = { width: 390, height: 844 };
  const M = DEBUG_PANEL_MARGIN_PX;

  it('視口內的落點原樣保留', () => {
    expect(clampPanelPosition({ x: 30, y: 120 }, PANEL, VIEWPORT)).toEqual({ x: 30, y: 120 });
  });

  it('拖出左上角會被拉回邊距處', () => {
    expect(clampPanelPosition({ x: -500, y: -500 }, PANEL, VIEWPORT)).toEqual({ x: M, y: M });
  });

  it('拖出右下角時整個面板仍留在視口裡', () => {
    expect(clampPanelPosition({ x: 9999, y: 9999 }, PANEL, VIEWPORT)).toEqual({
      x: VIEWPORT.width - PANEL.width - M,
      y: VIEWPORT.height - PANEL.height - M,
    });
  });

  // 面板比視口高時上下界會翻過來。讓底部溢出、把標題欄留在屏幕裡，
  // 反過來的話標題欄被頂出視口，全屏 / 關閉兩顆按鈕就再也點不到了。
  it('面板比視口大時貼住左上角，不把標題欄頂出屏幕', () => {
    const tall = { width: 330, height: 2000 };
    expect(clampPanelPosition({ x: 0, y: 0 }, tall, VIEWPORT).y).toBe(M);
    expect(clampPanelPosition({ x: 0, y: 9999 }, tall, VIEWPORT).y).toBe(M);
  });
});
