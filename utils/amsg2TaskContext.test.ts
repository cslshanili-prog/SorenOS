// utils/amsg2TaskContext.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db', () => ({
  DB: { getRecentMessagesByCharId: vi.fn() },
}));
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: {
    upsertExpiredNotices: vi.fn().mockResolvedValue([]),
    getExpiredNotices: vi.fn().mockResolvedValue([]),
  },
}));

import {
  AMSG2_TASK_LOOKBACK_MS,
  buildAmsg2NoticesText,
  buildAmsg2TaskContextText,
  buildUserCancelledNotices,
  collectAmsg2TaskContext,
} from './amsg2TaskContext';
import { DB } from './db';
import { ActiveMsgStore } from './activeMsgStore';
import type { ActiveMsg2TaskRecord, Amsg2ExpiredNoticeRecord, CharacterProfile } from '../types';

const H = 3600_000;
const pendingTask: ActiveMsg2TaskRecord = {
  taskUuid: 'aabbccdd-0000-0000-0000-000000000000', clientTaskId: 'cid-aabb', mode: 'prompted',
  firstSendTime: new Date(Date.now() + H).toISOString(), recurrenceType: 'none',
  promptHint: '問問考試結果', expirePolicy: 'expire',
  source: 'character', status: 'scheduled', createdAt: Date.now(),
};
const expired: Amsg2ExpiredNoticeRecord = {
  id: 'aabbccdd-0000-0000-0000-000000000000', charId: 'c1',
  occurrenceMs: Date.now() - H, mode: 'prompted', promptHint: '問問考試結果',
  recurrenceType: 'none', kind: 'expired', createdAt: Date.now(),
};

describe('buildAmsg2TaskContextText', () => {
  // 迴歸守衛：常駐簡介出現之前，沒任務時整塊是 null——角色平時根本不知道自己能排，
  // 用戶說「我去睡了」它只會口頭道晚安，想不起來給早上排一條。
  it('沒任務沒作廢 → 仍有常駐簡介，角色始終知道自己能排', () => {
    const text = buildAmsg2TaskContextText([], [], Date.now(), undefined);
    expect(text).toContain('schedule_active_message');
    expect(text).toContain('排成真任務'); // 嘴上許了就要排成真任務
    expect(text).toContain('不要只在正文裡答應'); // 承諾不能只停在台詞裡
    expect(text).toContain('會就排');     // 真想聯繫就排
    expect(text).toContain('隨口一想');   // 拿不準的不排：每一條都要花一次 API
    expect(text).toContain('硬排');       // 人設優先，不為排而排
    expect(text).toContain('自己的日程'); // 內容從角色自己的生活里長出來
    expect(text).not.toContain('進行中：');
    // 防複述約束照樣罩住只有簡介的形態
    expect(text.trimEnd().endsWith('不要向對方複述或提及這份排程信息本身的存在。')).toBe(true);
  });

  it('有任務時簡介也在（不是空狀態的佔位文案）', () => {
    const text = buildAmsg2TaskContextText([pendingTask], [], Date.now(), undefined);
    expect(text).toContain('schedule_active_message');
    expect(text).toContain('進行中：');
  });

  it('用 ChatApp 用戶名稱呼對方，不再使用泛稱', () => {
    const text = buildAmsg2TaskContextText([], [], Date.now(), undefined, undefined, '條條');
    expect(text).toContain('你和條條的聯繫');
    expect(text).toContain('內容不必總圍著條條轉');
    expect(text).not.toContain('你和對方的聯繫');
    expect(text.trimEnd().endsWith('不要向條條複述或提及這份排程信息本身的存在。')).toBe(true);
  });
  it('進行中任務列出短 id 與方向', () => {
    const text = buildAmsg2TaskContextText([pendingTask], [], Date.now(), undefined)!;
    expect(text).toContain('[aabbccdd]');
    expect(text).toContain('問問考試結果');
    expect(text).not.toContain('已作廢');
  });
  it('作廢段包含三選一引導、時機約束、renew 與重建引導、不復述約束', () => {
    const text = buildAmsg2TaskContextText([], [expired], Date.now(), undefined)!;
    expect(text).toContain('已作廢');
    expect(text).toContain('renew_active_message');
    expect(text).toContain('cancel_active_message + schedule_active_message');
    expect(text).toContain('強行轉移');
    expect(text).toContain('不要向對方複述');
  });

  // 迴歸守衛：防複述約束以前只掛在作廢那一段裡，「僅進行中」形態整塊裸奔——
  // 短 id、「遇忙作廢」這些系統腔會被角色照著念出來。
  it('只有進行中任務時也帶防複述約束', () => {
    const text = buildAmsg2TaskContextText([pendingTask], [], Date.now(), undefined)!;
    expect(text).toContain('不要向對方複述');
  });

  it('約束放在塊尾，管住整塊', () => {
    const text = buildAmsg2TaskContextText([pendingTask], [expired], Date.now(), undefined)!;
    expect(text.trimEnd().endsWith('不要向對方複述或提及這份排程信息本身的存在。')).toBe(true);
  });

  // 即時對話雲端路徑只欠回執這一樣（排程清單和能力簡介到點由 worker 現算現渲），
  // 迴歸守衛：整塊帶上簡介/清單的話，模型同一輪會讀到兩份互相打架的排程信息。
  it('回執單獨成塊（雲端路徑）：只帶回執兩段和保密約束，不帶簡介和進行中清單', () => {
    const cancelled: Amsg2ExpiredNoticeRecord = {
      ...expired, id: `${expired.id}:cancelled`, kind: 'user-cancelled',
    };
    const text = buildAmsg2NoticesText([expired, cancelled], undefined, '條條')!;
    expect(text).toContain('已作廢（到點時對話正在進行');
    expect(text).toContain('已被手動取消');
    expect(text).toContain('renew_active_message');
    expect(text).not.toContain('你和條條的聯繫');   // 常駐簡介不搭車
    expect(text).not.toContain('進行中：');
    expect(text.trimEnd().endsWith('不要向條條複述或提及這份排程信息本身的存在。')).toBe(true);
  });

  it('回執單獨成塊：沒有回執 → null，整塊不出現', () => {
    expect(buildAmsg2NoticesText([], undefined)).toBeNull();
  });

  // 迴歸守衛：手動取消以前沒有任何回執，角色下次還照著舊承諾說「放心我叫你」。
  it('手動取消的回執單獨成段，並說明不必向用戶求證', () => {
    const cancelled: Amsg2ExpiredNoticeRecord = {
      ...expired, id: `${expired.id}:cancelled`, kind: 'user-cancelled',
    };
    const text = buildAmsg2TaskContextText([], [cancelled], Date.now(), undefined)!;
    expect(text).toContain('已被手動取消');
    expect(text).toContain('[aabbccdd]');
    expect(text).toContain('不必向用戶求證');
    // 手動取消不該混進「自動作廢」那段的三選一引導裡（續期對它沒有意義）
    expect(text).not.toContain('到點時對話正在進行');
  });

  it('兩類回執同時存在 → 各佔一段', () => {
    const cancelled: Amsg2ExpiredNoticeRecord = {
      ...expired, id: 'bbbbbbbb-0000-0000-0000-000000000000:cancelled', kind: 'user-cancelled',
    };
    const text = buildAmsg2TaskContextText([], [expired, cancelled], Date.now(), undefined)!;
    expect(text).toContain('已作廢（到點時對話正在進行');
    expect(text).toContain('已被手動取消');
  });

  // 迴歸守衛：工具循環的第二輪起，這份清單是現算的，裡面會有角色本輪剛排好的任務。
  // 不點名的話，角色分不清「這條是我剛排的」還是「這條本來就有」，回頭又排一條一樣的
  // ——現場那次「一句『等會找我』排出 5 條」就是這麼來的。
  const otherTask: ActiveMsg2TaskRecord = {
    ...pendingTask, taskUuid: 'eeff0011-0000-0000-0000-000000000000', clientTaskId: 'cid-eeff',
    promptHint: '提醒喝水',
  };

  it('本輪剛排的那條點名標出來，別的任務不受影響', () => {
    const text = buildAmsg2TaskContextText(
      [pendingTask, otherTask], [], Date.now(), undefined,
      new Set([otherTask.taskUuid]),
    )!;
    const lines = text.split('\n');
    expect(lines.find((l) => l.includes('[aabbccdd]'))).not.toContain('本輪');
    expect(lines.find((l) => l.includes('[eeff0011]'))).toContain('本輪剛排的');
  });

  it('有本輪新排的 → 末尾多一句別再排一樣的', () => {
    const text = buildAmsg2TaskContextText(
      [pendingTask], [], Date.now(), undefined, new Set([pendingTask.taskUuid]),
    )!;
    expect(text).toContain('別再排一條一樣的');
  });

  it('沒傳本輪清單 → 一個字都不多（首輪那份不該憑空長出提醒）', () => {
    const plain = buildAmsg2TaskContextText([pendingTask], [], 1_800_000_000_000, undefined)!;
    const empty = buildAmsg2TaskContextText(
      [pendingTask], [], 1_800_000_000_000, undefined, new Set(),
    )!;
    expect(plain).not.toContain('本輪');
    expect(empty).toBe(plain);
  });
});

describe('buildUserCancelledNotices', () => {
  const now = Date.now();

  it('給還會響的任務寫回執，id 與作廢回執分開且冪等', () => {
    const notices = buildUserCancelledNotices('c1', [pendingTask], now);
    expect(notices).toHaveLength(1);
    expect(notices[0].id).toBe(`${pendingTask.taskUuid}:cancelled`);
    expect(notices[0].kind).toBe('user-cancelled');
    expect(notices[0].charId).toBe('c1');
    // 再取消一次只會命中同一個 id，台帳按 id 去重 → 冪等
    expect(buildUserCancelledNotices('c1', [pendingTask], now)[0].id).toBe(notices[0].id);
  });

  it('已經發過的一次性任務不寫（沒有承諾可撤）', () => {
    const fired: ActiveMsg2TaskRecord = {
      ...pendingTask, firstSendTime: new Date(now - 5 * H).toISOString(),
    };
    expect(buildUserCancelledNotices('c1', [fired], now)).toEqual([]);
  });

  it('循環任務寫的是「下一次」的時刻', () => {
    const daily: ActiveMsg2TaskRecord = {
      ...pendingTask, recurrenceType: 'daily',
      firstSendTime: new Date(now - 5 * 24 * H + H).toISOString(),
    };
    const [notice] = buildUserCancelledNotices('c1', [daily], now);
    expect(notice.occurrenceMs).toBeGreaterThan(now);
  });
});

// 迴歸守衛：送達證據以前只在「最近 200 條」裡找。重度用戶 48h 聊過 200 條之後，
// 已經發出去的那條主動消息被擠出窗口 → 檢出側把它當成作廢 → 角色把發過的事再來一遍。
describe('collectAmsg2TaskContext 的送達證據窗口', () => {
  const NOW = Date.UTC(2026, 7, 2, 12, 0);
  const CLIENT_TASK_ID = 'cid-morning';
  const TASK_UUID = 'aabbccdd-1111-4111-8111-111111111111';

  /** 觸發時刻（2h 前）+ 任務創建時刻（3h 前）。 */
  const occurrenceMs = NOW - 2 * H;
  const createdAtMs = NOW - 3 * H;

  /**
   * 送達證據（這一次確實發出去了）在最老的位置，後面壓著一大堆用戶消息。
   *
   * 用戶消息落在觸發時刻之後的熱聊窗內——閘認的就是「到點前後十分鐘在不在聊」，
   * 落在窗外的話這一批根本不會被檢出作廢，兩條用例都測不到想測的東西。
   */
  const buildHistory = (chatterCount: number) => {
    const delivered = {
      id: 1, role: 'assistant', timestamp: occurrenceMs + 60_000,
      metadata: { activeMsg2: { taskId: 'remote-1' }, amsgClientTaskId: CLIENT_TASK_ID },
    };
    const chatter = Array.from({ length: chatterCount }, (_, i) => ({
      id: i + 2, role: 'user',
      timestamp: occurrenceMs + 2 * 60_000 + i * 1_000,
      metadata: {},
    }));
    return [delivered, ...chatter];
  };

  const charWithTask = (): CharacterProfile => ({
    id: 'char-heavy', name: '重度聊天',
    activeMsg2Config: {
      enabled: true,
      tasks: [{
        taskUuid: TASK_UUID, clientTaskId: CLIENT_TASK_ID, mode: 'auto',
        firstSendTime: new Date(occurrenceMs).toISOString(), recurrenceType: 'none',
        expirePolicy: 'expire',
        source: 'character', status: 'scheduled', createdAt: createdAtMs,
      }],
    },
  } as unknown as CharacterProfile);

  beforeEach(() => {
    vi.setSystemTime(NOW);
    (ActiveMsgStore.upsertExpiredNotices as any).mockClear();
    (ActiveMsgStore.getExpiredNotices as any).mockResolvedValue([]);
  });

  it('近史超過 200 條、送達證據在 200 條之外 → 不再誤判成作廢', async () => {
    const history = buildHistory(260);
    (DB.getRecentMessagesByCharId as any).mockImplementation(
      async (_id: string, limit: number) => history.slice(-limit));

    const result = await collectAmsg2TaskContext(charWithTask());

    // 修復前：固定取 200 條 → 證據被擠出窗口 → 這裡會攢下一條作廢回執
    expect(ActiveMsgStore.upsertExpiredNotices).not.toHaveBeenCalled();
    expect(result.expiredIds).toEqual([]);
  });

  it('真的沒送達（證據不存在）照舊檢出作廢', async () => {
    const history = buildHistory(260).filter((m) => m.role !== 'assistant');
    (DB.getRecentMessagesByCharId as any).mockImplementation(
      async (_id: string, limit: number) => history.slice(-limit));

    await collectAmsg2TaskContext(charWithTask());

    expect(ActiveMsgStore.upsertExpiredNotices).toHaveBeenCalledTimes(1);
    const [, records] = (ActiveMsgStore.upsertExpiredNotices as any).mock.calls[0];
    expect(records).toHaveLength(1);
    expect(records[0].kind).toBe('expired');
  });

  it('歷史不足一頁時不空轉多要一次', async () => {
    (DB.getRecentMessagesByCharId as any).mockClear();
    (DB.getRecentMessagesByCharId as any).mockResolvedValue(buildHistory(10));

    await collectAmsg2TaskContext(charWithTask());

    expect(DB.getRecentMessagesByCharId).toHaveBeenCalledTimes(1);
  });
});

// 回看期必須明確短於作廢台帳的 TTL（48h）：一樣長的話，邊界那天的觸發會在台帳
// 剛清掉它的下一輪被重新檢出，同一件事給角色說第二遍。
describe('回看期與台帳 TTL 的關係', () => {
  it('回看期 < 48h', () => {
    expect(AMSG2_TASK_LOOKBACK_MS).toBeLessThan(48 * H);
  });
});
