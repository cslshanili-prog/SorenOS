// utils/amsg2ToolBridge.test.ts
// 迴歸守衛：角色在同一輪工具循環裡連續排程/取消/續期時，本地清單必須累加。
// char 是生成開始時的快照，updateCharacter 只更 React state 不回寫它——清單要是從
// char 上讀寫，第二次 schedule 就會讀著空清單把第一條覆蓋掉（「建倆只顯示一個」）。
// 累加由 createAmsg2ToolSession 的本輪局部變量兜住，下面的用例釘的就是這件事。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./activeMsgClient', () => ({
  ActiveMsgClient: { scheduleCharacterTask: vi.fn(), cancelTask: vi.fn() },
}));
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: { getGlobalConfig: vi.fn() },
}));

import { createAmsg2ToolSession, executeAmsg2Tool } from './amsg2ToolBridge';
import { isAmsg2EnabledForChar } from './amsg2Tasks';
import { ActiveMsgClient } from './activeMsgClient';

const UUIDS = [
  'aaaaaaaa-0000-0000-0000-000000000000',
  'bbbbbbbb-0000-0000-0000-000000000000',
  'cccccccc-0000-0000-0000-000000000000',
];
const shortOf = (uuid: string) => uuid.slice(0, 8);

// 排程接口把角色寫的牆鍾折成的絕對時刻（上海 2026-08-03 21:00 / 紐約同日 09:00）。
const RESOLVED_ISO = '2026-08-03T13:00:00.000Z';

// persistTasks 會用 Date.now() 跑 48h 清理，一次性任務過期就被清空——夾具裡這個
// 絕對時刻寫死了，系統時鐘往前走兩天它就會被當成陳舊任務掃掉，測試跟著莫名其妙全紅。
// 這裡把時鐘釘在 RESOLVED_ISO 之前，讓這份夾具時間永遠不會「過期」。
beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-08-03T05:00:00.000Z') });
});
afterEach(() => {
  vi.useRealTimers();
});

// 模擬 React：updateCharacter 只記錄落盤的 config，絕不回寫 char——
// 這樣只有「session 自己兜住最新 config」才能讓同輪後續調用讀到累加結果。
const makeSession = (charOver: Record<string, unknown> = {}) => {
  const char: any = {
    id: 'preset-x', name: 'Nyah', activeMsg2Config: { enabled: true, tasks: [] },
    ...charOver,
  };
  const persisted: any[] = [];
  const updateCharacter = vi.fn((_id: string, updates: any) => {
    if (updates.activeMsg2Config) persisted.push(updates.activeMsg2Config);
  });
  const deps = createAmsg2ToolSession({
    char, userProfile: {} as any, groups: [], realtimeConfig: {} as any,
    apiConfig: {} as any, updateCharacter,
  });
  return { deps, char, persisted };
};

// 默認往後一小時；要在同一輪裡排兩條**不同**的任務就錯開小時數——同名同參的調用
// 現在會被指紋攔下（見文件末尾那組用例），兩條都寫同一個時刻測不出「累加」。
const future = (hours = 1) => new Date(Date.now() + hours * 3600_000).toISOString();
const lastTasks = (persisted: any[]) => persisted[persisted.length - 1]?.tasks ?? [];

describe('amsg2ToolBridge 同一輪多次調用累加', () => {
  beforeEach(() => {
    let n = 0;
    (ActiveMsgClient.scheduleCharacterTask as any).mockReset();
    (ActiveMsgClient.scheduleCharacterTask as any).mockImplementation(async () => {
      const uuid = UUIDS[n++];
      return {
        uuid, clientTaskId: `cid-${uuid.slice(0, 4)}`, anchorMs: 0, replacedCancelFailed: false,
        // 真接口把 send_at 折成絕對時刻後回傳，bridge 該存這一份（見下面的時區用例）。
        firstSendAt: RESOLVED_ISO,
      };
    });
    (ActiveMsgClient.cancelTask as any).mockReset();
    (ActiveMsgClient.cancelTask as any).mockResolvedValue({});
  });

  it('一輪內兩次 schedule → 本地保留兩條（迴歸：陳舊快照覆蓋）', async () => {
    const { deps, persisted } = makeSession();
    await executeAmsg2Tool('schedule_active_message', { send_at: future(1) }, deps);
    await executeAmsg2Tool('schedule_active_message', { send_at: future(2) }, deps);

    const tasks = lastTasks(persisted);
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t: any) => t.taskUuid)).toEqual([UUIDS[0], UUIDS[1]]);
  });

  it('一輪內 schedule×2 後按短 id 取消其一 → 剩下的是另一條', async () => {
    const { deps, persisted } = makeSession();
    await executeAmsg2Tool('schedule_active_message', { send_at: future(1) }, deps);
    await executeAmsg2Tool('schedule_active_message', { send_at: future(2) }, deps);
    await executeAmsg2Tool('cancel_active_message', { task_id: shortOf(UUIDS[1]) }, deps);

    const tasks = lastTasks(persisted);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskUuid).toBe(UUIDS[0]);
    expect(ActiveMsgClient.cancelTask).toHaveBeenCalledWith(UUIDS[1]);
  });

  it('一輪內 schedule 一次性任務後立刻 renew → 換成新 uuid、舊記錄移除、模式沿用', async () => {
    const { deps, persisted } = makeSession();
    await executeAmsg2Tool('schedule_active_message', {
      send_at: future(), mode: 'prompted', prompt_hint: '問問吃了沒',
    }, deps);
    const renewResult = await executeAmsg2Tool('renew_active_message', {
      send_at: future(), task_id: shortOf(UUIDS[0]),
    }, deps);

    // 修復前這裡會回「當前角色沒有可續期的任務」——renew 也讀不到同輪剛建的那條。
    expect(renewResult).not.toContain('沒有可續期');
    const tasks = lastTasks(persisted);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskUuid).toBe(UUIDS[1]);
    expect(tasks[0].mode).toBe('prompted');
    expect(tasks[0].promptHint).toBe('問問吃了沒');
    expect(tasks[0].recurrenceType).toBe('none');
    // 舊任務的遠端取消由 scheduleCharacterTask 內部「先建後刪」負責，bridge 的職責是
    // 把要替換的 uuid 傳下去——這裡釘的是 bridge 這一側。
    expect(ActiveMsgClient.scheduleCharacterTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ replaceTaskUuid: UUIDS[0] }),
    );
  });

  it('角色排的任務帶 selfScheduled 標記（連發上限的到點兜底閘認它；面板排的不帶）', async () => {
    const { deps } = makeSession();
    await executeAmsg2Tool('schedule_active_message', { send_at: future() }, deps);
    expect(ActiveMsgClient.scheduleCharacterTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ task: expect.objectContaining({ selfScheduled: true }) }),
    );
  });

  it('一輪內 schedule 後 list → 列得出剛建的那條', async () => {
    const { deps } = makeSession();
    await executeAmsg2Tool('schedule_active_message', { send_at: future() }, deps);
    const listed = await executeAmsg2Tool('list_active_messages', {}, deps);

    expect(listed).toContain(shortOf(UUIDS[0]));
    expect(listed).not.toContain('沒有任何定時主動消息任務');
  });

  // 迴歸守衛：循環任務的 renew 一度是整條改期（recurrence 原樣透傳 + replaceTaskUuid）。
  // 「每天 9:00 的早安」被角色順手續到 11:00「晚點補上」，從明天起就永久變成 11:00 了，
  // 編號還跟著換一個。現在改成只補當次，原序列一條不動。
  it('循環任務 renew → 原任務留著，另加一條一次性補發', async () => {
    const { deps, persisted } = makeSession();
    await executeAmsg2Tool('schedule_active_message', {
      send_at: future(), mode: 'prompted', prompt_hint: '道早安', recurrence: 'daily',
    }, deps);
    const renewResult = await executeAmsg2Tool('renew_active_message', {
      send_at: future(), task_id: shortOf(UUIDS[0]),
    }, deps);

    const tasks = lastTasks(persisted);
    expect(tasks).toHaveLength(2);
    // 原來那條每天的還在，編號和節奏都沒變
    expect(tasks[0].taskUuid).toBe(UUIDS[0]);
    expect(tasks[0].recurrenceType).toBe('daily');
    // 新加的是一次性補發，方向沿用
    expect(tasks[1].taskUuid).toBe(UUIDS[1]);
    expect(tasks[1].recurrenceType).toBe('none');
    expect(tasks[1].promptHint).toBe('道早安');

    const scheduleArgs = (ActiveMsgClient.scheduleCharacterTask as any).mock.calls[1][0];
    expect(scheduleArgs.replaceTaskUuid).toBeUndefined();
    expect(scheduleArgs.task.recurrenceType).toBe('none');
    // 回執得說清楚原節奏沒動，否則角色下一輪會跑去把「原來那條」再取消一遍
    expect(renewResult).toContain(shortOf(UUIDS[0]));
    expect(renewResult).toContain('重複節奏不變');
  });

  it('遠端取消失敗 → 本地記錄保留並標錯，不留「看不見的幽靈任務」', async () => {
    const { deps, persisted } = makeSession();
    await executeAmsg2Tool('schedule_active_message', { send_at: future() }, deps);
    (ActiveMsgClient.cancelTask as any).mockRejectedValueOnce(new Error('worker 503'));
    const result = await executeAmsg2Tool('cancel_active_message', { task_id: shortOf(UUIDS[0]) }, deps);

    expect(result).toContain('失敗');
    const tasks = lastTasks(persisted);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskUuid).toBe(UUIDS[0]);
    expect(tasks[0].lastError).toBeTruthy();
  });

  it('累加不靠就地改 char：React state 裡的角色對象不被寫髒', async () => {
    const { deps, char } = makeSession();
    await executeAmsg2Tool('schedule_active_message', { send_at: future(1) }, deps);
    await executeAmsg2Tool('schedule_active_message', { send_at: future(2) }, deps);

    // 落盤走 updateCharacter，char 快照本身保持原樣（它是 React state 裡的對象）。
    expect(char.activeMsg2Config.tasks).toEqual([]);
    // 但 session 讀得到累加後的兩條。
    expect(deps.getConfig()?.tasks).toHaveLength(2);
  });
});

// ─── 角色級開關 ───
// 工具注入這條路要是只看全局 workerUrl，沒在面板裡開過 2.0 的角色照樣拿得到
// schedule_active_message；再加上落盤時強寫 enabled:true，一次工具調用就把用戶
// 沒表態過的功能替他打開了。兩頭都得釘住。
describe('角色級開關', () => {
  const charWith = (config: any) => ({ id: 'preset-x', name: 'Nyah', activeMsg2Config: config } as any);

  it('關掉的角色不給注入工具', () => {
    expect(isAmsg2EnabledForChar(charWith({ enabled: false, tasks: [] }))).toBe(false);
  });

  it('開著的角色照常注入', () => {
    expect(isAmsg2EnabledForChar(charWith({ enabled: true, tasks: [] }))).toBe(true);
  });

  it('從沒配過 2.0 的角色算關閉（要先進面板把開關打開）', () => {
    expect(isAmsg2EnabledForChar(charWith(undefined))).toBe(false);
  });

  it('落盤不把 enabled 改寫成 true（工具調用不得替用戶重新開啟功能）', async () => {
    let n = 0;
    (ActiveMsgClient.scheduleCharacterTask as any).mockImplementation(async () => ({
      uuid: UUIDS[n++], clientTaskId: 'cid', anchorMs: 0, replacedCancelFailed: false,
    }));
    const char: any = charWith({ enabled: false, tasks: [] });
    const persisted: any[] = [];
    const deps = createAmsg2ToolSession({
      char, userProfile: {} as any, groups: [], realtimeConfig: {} as any, apiConfig: {} as any,
      updateCharacter: (_id: string, updates: any) => {
        if (updates.activeMsg2Config) persisted.push(updates.activeMsg2Config);
      },
    });
    await executeAmsg2Tool('schedule_active_message', { send_at: future() }, deps);

    expect(persisted[persisted.length - 1].enabled).toBe(false);
  });
});

// 迴歸守衛：角色寫的 send_at 是「它那邊的牆鍾」，不帶時區後綴（工具描述裡就是這麼教的）。
// 原樣落盤的話，本地讀它的地方一律 new Date() 按設備時區解析——異國角色的任務卡、待觸發
// 判定、以及下面這句回話全都差一個時差。排程接口已經按角色時區把它折成絕對時刻了，
// bridge 存的、說的都得是那一份。
describe('角色排程的時間統一存絕對時刻', () => {
  beforeEach(() => {
    let n = 0;
    (ActiveMsgClient.scheduleCharacterTask as any).mockReset();
    (ActiveMsgClient.scheduleCharacterTask as any).mockImplementation(async () => ({
      uuid: UUIDS[n++], clientTaskId: 'cid', anchorMs: 0, replacedCancelFailed: false,
      firstSendAt: RESOLVED_ISO,
    }));
  });

  it('落盤存排程接口摺好的絕對時刻，不是角色寫的牆鍾原串', async () => {
    const { deps, persisted } = makeSession({
      customTimezoneEnabled: true, customTimezone: 'America/New_York',
    });
    await executeAmsg2Tool(
      'schedule_active_message',
      { send_at: '2026-08-03T09:00:00' },   // 紐約角色寫的「明早九點」
      deps,
    );

    expect(lastTasks(persisted)[0].firstSendTime).toBe(RESOLVED_ISO);
  });

  it('回話裡的時間按角色的鐘說，且只折一次', async () => {
    const { deps } = makeSession({
      customTimezoneEnabled: true, customTimezone: 'America/New_York',
    });
    const reply = await executeAmsg2Tool(
      'schedule_active_message',
      { send_at: '2026-08-03T09:00:00' },
      deps,
    );

    // 紐約角色說的九點，回話裡就該是 09:00
    expect(reply).toContain('09:00');
    // 折兩次（先按設備解析原串、再換算到紐約）會落在別的鐘點上
    expect(reply).not.toContain('21:00');
  });
});

// ─── 打轉防護 ───
// 現場：用戶說一句「等會找我」，角色一口氣排出 5 條一模一樣的任務（同時間、同提示詞）。
// 5 不是巧合——它是每個角色的待觸發上限，也就是模型一路重複調用直到撞上限才停。前台的
// 工具循環最多轉 6 輪，每一輪執行一次 schedule 就是遠端實打實 5 條任務。
//
// 兩層防護，跟 worker 的 fire 循環同一套（見 utils/agenticToolFeedback.ts）：
//   軟的 —— 回話末尾明說「這一步做完了，別再調同一個」；
//   硬的 —— 同名同參第二次直接打回，一次網絡請求都不發。
describe('同名同參的調用不重複執行', () => {
  beforeEach(() => {
    let n = 0;
    (ActiveMsgClient.scheduleCharacterTask as any).mockReset();
    (ActiveMsgClient.scheduleCharacterTask as any).mockImplementation(async () => ({
      uuid: UUIDS[n++], clientTaskId: 'cid', anchorMs: 0, replacedCancelFailed: false,
      firstSendAt: RESOLVED_ISO,
    }));
    (ActiveMsgClient.cancelTask as any).mockReset();
    (ActiveMsgClient.cancelTask as any).mockResolvedValue({});
  });

  it('第二次完全相同的 schedule → 不建任務、不發請求，只回一句打回', async () => {
    const { deps, persisted } = makeSession();
    const args = { send_at: future(1), mode: 'prompted', prompt_hint: '等會來找你' };
    await executeAmsg2Tool('schedule_active_message', args, deps);
    const second = await executeAmsg2Tool('schedule_active_message', { ...args }, deps);

    expect(ActiveMsgClient.scheduleCharacterTask).toHaveBeenCalledTimes(1);
    expect(lastTasks(persisted)).toHaveLength(1);
    expect(second).not.toContain('已創建');
    expect(second).toContain('不要');
  });

  it('參數寫法變了但內容一樣（鍵序不同）照樣算同一次', async () => {
    const { deps } = makeSession();
    const send_at = future(1);
    await executeAmsg2Tool('schedule_active_message', { send_at, mode: 'auto' }, deps);
    await executeAmsg2Tool('schedule_active_message', { mode: 'auto', send_at }, deps);

    expect(ActiveMsgClient.scheduleCharacterTask).toHaveBeenCalledTimes(1);
  });

  it('換個時間就照常放行（只攔完全一樣的，多輪能力不減）', async () => {
    const { deps, persisted } = makeSession();
    await executeAmsg2Tool('schedule_active_message', { send_at: future(1) }, deps);
    await executeAmsg2Tool('schedule_active_message', { send_at: future(3) }, deps);

    expect(ActiveMsgClient.scheduleCharacterTask).toHaveBeenCalledTimes(2);
    expect(lastTasks(persisted)).toHaveLength(2);
  });

  it('renew 同參第二次也攔（它內部走的還是建新任務那條路）', async () => {
    const { deps, persisted } = makeSession();
    await executeAmsg2Tool('schedule_active_message', { send_at: future(1) }, deps);
    const renewArgs = { send_at: future(2), task_id: shortOf(UUIDS[0]) };
    await executeAmsg2Tool('renew_active_message', renewArgs, deps);
    const second = await executeAmsg2Tool('renew_active_message', { ...renewArgs }, deps);

    // 首次 schedule + 首次 renew = 2 次；第二次 renew 不該再打一發
    expect(ActiveMsgClient.scheduleCharacterTask).toHaveBeenCalledTimes(2);
    expect(lastTasks(persisted)).toHaveLength(1);
    expect(second).toContain('不要');
  });

  it('list 不攔：同一輪裡排完再查，清單本來就該變', async () => {
    const { deps } = makeSession();
    const empty = await executeAmsg2Tool('list_active_messages', {}, deps);
    await executeAmsg2Tool('schedule_active_message', { send_at: future(1) }, deps);
    const afterSchedule = await executeAmsg2Tool('list_active_messages', {}, deps);

    expect(empty).toContain('沒有任何定時主動消息任務');
    expect(afterSchedule).toContain(shortOf(UUIDS[0]));
  });

  it('排程成功的回話末尾帶收尾引導（軟的那層）', async () => {
    const { deps } = makeSession();
    const reply = await executeAmsg2Tool('schedule_active_message', { send_at: future(1) }, deps);

    // 事實照說
    expect(reply).toContain('已創建');
    // 再明說這一步結束了，別接著調同一個
    expect(reply).toContain('同樣的調用不要再來一遍');
  });

  it('遠端失敗的那次不記帳：改不了參數的重試仍放行一次', async () => {
    const { deps } = makeSession();
    (ActiveMsgClient.scheduleCharacterTask as any).mockRejectedValueOnce(new Error('worker 503'));
    const args = { send_at: future(1) };
    const failed = await executeAmsg2Tool('schedule_active_message', args, deps);
    const retried = await executeAmsg2Tool('schedule_active_message', { ...args }, deps);

    expect(failed).toContain('失敗');
    expect(retried).toContain('已創建');
    expect(ActiveMsgClient.scheduleCharacterTask).toHaveBeenCalledTimes(2);
  });
});

// 連發上限的本地排程閘（與 worker fire 側 unanswered_limit 對齊）：本地排到超限的
// 那幾條會被到點兜底閘靜默 skip——角色在正文裡承諾了「等下再來找你」，到點卻憑空
// 蒸發。這裡釘住：超限時帶回喂打回、一次遠端請求都不發；面板任務不佔額度。
describe('連發上限·本地排程閘', () => {
  beforeEach(() => {
    (ActiveMsgClient.scheduleCharacterTask as any).mockReset();
    (ActiveMsgClient.scheduleCharacterTask as any).mockImplementation(async () => ({
      uuid: UUIDS[0], clientTaskId: 'ct-limit', firstSendAt: RESOLVED_ISO, anchorMs: null,
    }));
  });

  const selfTask = (uuid: string) => ({
    taskUuid: uuid, clientTaskId: `${uuid}-c`, mode: 'auto', recurrenceType: 'none',
    expirePolicy: 'expire', source: 'character', status: 'scheduled',
    firstSendTime: new Date(Date.now() + 3600_000).toISOString(), createdAt: Date.now(),
  });

  it('掛滿自排任務（默認上限 3）再排 → 打回，不發遠端請求', async () => {
    const { deps } = makeSession({
      activeMsg2Config: { enabled: true, tasks: [selfTask('u1'), selfTask('u2'), selfTask('u3')] },
    });
    const reply = await executeAmsg2Tool('schedule_active_message', { send_at: future(1) }, deps);
    expect(reply).toContain('連發上限');
    expect(ActiveMsgClient.scheduleCharacterTask).not.toHaveBeenCalled();
  });

  it('面板裡用戶親手排的任務不佔連發額度', async () => {
    const userTask = (uuid: string) => ({ ...selfTask(uuid), source: 'user' });
    const { deps } = makeSession({
      activeMsg2Config: { enabled: true, tasks: [userTask('u1'), userTask('u2'), userTask('u3')] },
    });
    const reply = await executeAmsg2Tool('schedule_active_message', { send_at: future(1) }, deps);
    expect(reply).toContain('已創建');
  });

  it('用戶把上限設成 1 → 第一條自排就打回第二條', async () => {
    const { deps } = makeSession({
      activeMsg2Config: { enabled: true, maxUnansweredSends: 1, tasks: [selfTask('u1')] },
    });
    const reply = await executeAmsg2Tool('schedule_active_message', { send_at: future(1) }, deps);
    expect(reply).toContain('連發上限是 1 條');
    expect(ActiveMsgClient.scheduleCharacterTask).not.toHaveBeenCalled();
  });
});
