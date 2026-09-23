// utils/amsg2Tasks.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MAX_ACTIVE_TASKS_PER_CHAR,
  REPLACE_CANCEL_FAILED_NOTE,
  applyRemoteTaskDelta,
  applyScheduledTask,
  AMSG2_SCHEDULE_SECRECY_NOTE,
  buildFireTaskListBlock,
  currentOccurrenceMs,
  describeInstantChatFailure,
  describeRemoteLastError,
  describeTaskFailureCause,
  describeTaskProgress,
  findTaskByShortId,
  getPendingTasks,
  hasActiveAiTask,
  isPendingTask,
  isRemoteMissingTask,
  keepUncancelledTasks,
  parseRemoteTaskLastError,
  pruneFiredTasks,
  REMOTE_ERROR_REASON_MAX,
  pruneStaleTasks,
  reconcileTasksWithRemote,
  shortTaskId,
  toDatetimeLocalValue,
} from './amsg2Tasks';
import type { ActiveMsg2TaskRecord } from '../types';

const H = 3600_000;
const task = (extra: Partial<ActiveMsg2TaskRecord> = {}): ActiveMsg2TaskRecord => ({
  taskUuid: 'aabbccdd-0000-0000-0000-000000000000',
  clientTaskId: 'cid-aabb',
  mode: 'auto', firstSendTime: new Date(Date.now() + H).toISOString(),
  recurrenceType: 'none', expirePolicy: 'expire',
  source: 'character', status: 'scheduled', createdAt: Date.now(),
  ...extra,
});

describe('amsg2Tasks helpers', () => {
  it('shortTaskId 取 uuid 前 8 位；findTaskByShortId 按短 id 找', () => {
    const t = task();
    expect(shortTaskId(t.taskUuid)).toBe('aabbccdd');
    expect(findTaskByShortId([t], 'aabbccdd')).toBe(t);
    expect(findTaskByShortId([t], 'ffffffff')).toBeUndefined();
  });

  it('isPendingTask：未來一次性/循環任務算待觸發，過點一次性不算', () => {
    const now = Date.now();
    expect(isPendingTask(task(), now)).toBe(true);
    expect(isPendingTask(task({ firstSendTime: new Date(now - H).toISOString() }), now)).toBe(false);
    expect(isPendingTask(task({ firstSendTime: new Date(now - H).toISOString(), recurrenceType: 'daily' }), now)).toBe(true);
  });

  it('pruneStaleTasks 清掉過點超過 48h 的一次性任務，循環任務保留', () => {
    const now = Date.now();
    const stale = task({ taskUuid: 'stale000-0000-0000-0000-000000000000', firstSendTime: new Date(now - 49 * H).toISOString() });
    const recent = task({ taskUuid: 'recent00-0000-0000-0000-000000000000', firstSendTime: new Date(now - H).toISOString() });
    const daily = task({ taskUuid: 'daily000-0000-0000-0000-000000000000', firstSendTime: new Date(now - 100 * H).toISOString(), recurrenceType: 'daily' });
    expect(pruneStaleTasks([stale, recent, daily], now).map((t) => shortTaskId(t.taskUuid)))
      .toEqual(['recent00', 'daily000']);
  });

  it('封頂常量為 5', () => {
    expect(MAX_ACTIVE_TASKS_PER_CHAR).toBe(5);
  });

  // 同步門（amsgStateSync）依賴 hasActiveAiTask：只要還有「待觸發的非 fixed 任務」才同步 fire_pack。
  // 釘住這條，防止後續改動把它悄悄改死——靜默分流殺主動消息是踩過的坑。
  it('getPendingTasks 只留待觸發任務；hasActiveAiTask 排除 fixed，無待觸發 AI 任務時為 false', () => {
    const now = Date.now();
    const ai = task();
    const fixed = task({ taskUuid: 'fixed000-0000-0000-0000-000000000000', mode: 'fixed' });
    const past = task({ taskUuid: 'past0000-0000-0000-0000-000000000000', firstSendTime: new Date(now - H).toISOString() });
    const config = { enabled: true, tasks: [ai, fixed, past] };
    expect(getPendingTasks(config, now).map((t) => shortTaskId(t.taskUuid))).toEqual(['aabbccdd', 'fixed000']);
    expect(hasActiveAiTask(config, now)).toBe(true);
    expect(hasActiveAiTask({ enabled: true, tasks: [fixed, past] }, now)).toBe(false);
    expect(hasActiveAiTask(undefined, now)).toBe(false);
  });
});

// 防坑：角色用工具建的任務 firstSendTime 是完整 ISO 8601，datetime-local 輸入框只認
// 'YYYY-MM-DDTHH:mm'——不折算編輯角色任務時時間框會空白。斷言全部與本機時區無關。
describe('toDatetimeLocalValue', () => {
  it('已是 datetime-local 格式 → 原樣返回（跨時區恆成立）', () => {
    expect(toDatetimeLocalValue('2026-07-21T09:00')).toBe('2026-07-21T09:00');
  });
  it('完整 ISO（帶 Z / 秒 / 毫秒）→ 折成 16 位 YYYY-MM-DDTHH:mm（無 Z 無秒）', () => {
    const out = toDatetimeLocalValue('2026-07-21T01:00:00.000Z');
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(out).not.toContain('Z');
  });
  it('再折一次結果不變（冪等，防重複編輯時間漂移）', () => {
    const once = toDatetimeLocalValue('2026-07-21T01:00:00.000Z');
    expect(toDatetimeLocalValue(once)).toBe(once);
  });
  it('無法解析 / 空串 → 原樣返回，不拋錯', () => {
    expect(toDatetimeLocalValue('')).toBe('');
    expect(toDatetimeLocalValue('not-a-date')).toBe('not-a-date');
  });
});

// ─── 並清單 / 關閉時保留 —— 面板與角色工具共用的規則 ───
// 這兩個函數的存在意義是「絕不留下本地看不見、遠端卻會觸發的幽靈任務」，
// 所以每條都按這個標準釘：什麼情況下記錄必須留下來。

describe('applyScheduledTask', () => {
  const A = task({ taskUuid: 'aaaaaaaa-0000-0000-0000-000000000000' });
  const B = task({ taskUuid: 'bbbbbbbb-0000-0000-0000-000000000000' });
  const fresh = task({ taskUuid: 'cccccccc-0000-0000-0000-000000000000' });

  it('純新建：併到清單末尾，其它任務不動', () => {
    const out = applyScheduledTask([A, B], fresh, {}, Date.now());
    expect(out.map((t) => t.taskUuid)).toEqual([A.taskUuid, B.taskUuid, fresh.taskUuid]);
  });

  it('替換成功：舊記錄移除，新記錄進來', () => {
    const out = applyScheduledTask([A, B], fresh, { replaceTaskUuid: A.taskUuid }, Date.now());
    expect(out.map((t) => t.taskUuid)).toEqual([B.taskUuid, fresh.taskUuid]);
  });

  it('替換時遠端取消失敗：舊記錄必須保留並標錯（遠端新舊並存，本地不能只剩新的）', () => {
    const out = applyScheduledTask(
      [A, B], fresh,
      { replaceTaskUuid: A.taskUuid, replacedCancelFailed: true },
      Date.now(),
    );
    expect(out.map((t) => t.taskUuid)).toEqual([A.taskUuid, B.taskUuid, fresh.taskUuid]);
    expect(out.find((t) => t.taskUuid === A.taskUuid)?.lastError).toBe(REPLACE_CANCEL_FAILED_NOTE);
    // 沒被替換的那條不該被牽連打標
    expect(out.find((t) => t.taskUuid === B.taskUuid)?.lastError).toBeUndefined();
  });

  it('順手清掉過點 48h 的一次性任務，但循環任務不清', () => {
    const stale = task({ taskUuid: 'dddddddd-0000-0000-0000-000000000000', firstSendTime: new Date(Date.now() - 72 * H).toISOString() });
    const oldDaily = task({ taskUuid: 'eeeeeeee-0000-0000-0000-000000000000', recurrenceType: 'daily', firstSendTime: new Date(Date.now() - 72 * H).toISOString() });
    const out = applyScheduledTask([stale, oldDaily], fresh, {}, Date.now());
    expect(out.map((t) => t.taskUuid)).toEqual([oldDaily.taskUuid, fresh.taskUuid]);
  });
});

describe('keepUncancelledTasks', () => {
  const notes = { failed: '取消失敗', appeared: '關閉時新出現' };
  const A = task({ taskUuid: 'aaaaaaaa-0000-0000-0000-000000000000' });
  const B = task({ taskUuid: 'bbbbbbbb-0000-0000-0000-000000000000' });
  const C = task({ taskUuid: 'cccccccc-0000-0000-0000-000000000000' });

  it('全部取消成功 → 清單清空', () => {
    const attempted = new Set([A.taskUuid, B.taskUuid]);
    expect(keepUncancelledTasks([A, B], attempted, new Set(), notes)).toEqual([]);
  });

  it('取消失敗的留下並標錯（遠端還活著，用戶得能再試）', () => {
    const attempted = new Set([A.taskUuid, B.taskUuid]);
    const out = keepUncancelledTasks([A, B], attempted, new Set([B.taskUuid]), notes);
    expect(out.map((t) => t.taskUuid)).toEqual([B.taskUuid]);
    expect(out[0].lastError).toBe(notes.failed);
  });

  it('取消期間才出現的任務留下（壓根沒被嘗試過，跟著清掉就成幽靈任務）', () => {
    // C 是關閉流程跑到一半時角色在聊天裡剛排的，不在 attempted 裡
    const attempted = new Set([A.taskUuid, B.taskUuid]);
    const out = keepUncancelledTasks([A, B, C], attempted, new Set(), notes);
    expect(out.map((t) => t.taskUuid)).toEqual([C.taskUuid]);
    expect(out[0].lastError).toBe(notes.appeared);
  });
});

// 迴歸守衛：面板打開時抓的遠端底帳是「那一刻」的快照，之後新建的任務當然不在裡面。
// 曾經每建一條任務，卡片下面就立刻冒一行「⚠ 遠端不存在」，關掉面板重開才消失——
// 第一次用的人會以為排程失敗了。
describe('遠端對帳（applyRemoteTaskDelta / isRemoteMissingTask）', () => {
  const now = Date.now();
  const A = task({ taskUuid: 'aaaaaaaa-0000-0000-0000-000000000000' });
  const NEW = task({ taskUuid: 'nnnnnnnn-0000-0000-0000-000000000000' });

  it('新建成功後記進底帳 → 不再誤標「遠端不存在」', () => {
    const opened = new Set([A.taskUuid]);            // 打開面板時遠端只有 A
    expect(isRemoteMissingTask(NEW, opened, now)).toBe(true);   // 不記帳就是這個錯覺

    const after = applyRemoteTaskDelta(opened, { present: [NEW.taskUuid] });
    expect(isRemoteMissingTask(NEW, after, now)).toBe(false);
    expect(isRemoteMissingTask(A, after, now)).toBe(false);     // 別牽連原有任務
  });

  it('編輯 = 新建 + 取消舊的：新 uuid 進帳、舊 uuid 出帳', () => {
    const after = applyRemoteTaskDelta(new Set([A.taskUuid]), {
      present: [NEW.taskUuid],
      gone: [A.taskUuid],
    });
    expect(after).toEqual(new Set([NEW.taskUuid]));
  });

  it('替換時舊任務取消失敗 → 舊 uuid 留在帳上（遠端新舊並存，別標成不存在）', () => {
    const after = applyRemoteTaskDelta(new Set([A.taskUuid]), { present: [NEW.taskUuid] });
    expect(isRemoteMissingTask(A, after, now)).toBe(false);
  });

  it('底帳沒拉到（null）→ 一直保持 null，整個徽標不顯示', () => {
    expect(applyRemoteTaskDelta(null, { present: [NEW.taskUuid] })).toBeNull();
    expect(isRemoteMissingTask(A, null, now)).toBe(false);
  });

  it('已過點的一次性任務不標：它本來就該從遠端消失', () => {
    const fired = task({
      taskUuid: 'ffffffff-0000-0000-0000-000000000000',
      firstSendTime: new Date(now - 24 * H).toISOString(),
    });
    expect(isRemoteMissingTask(fired, new Set(), now)).toBe(false);
  });

  it('待觸發的任務確實從遠端消失了 → 照標（這才是徽標存在的意義）', () => {
    expect(isRemoteMissingTask(A, new Set(), now)).toBe(true);
  });
});

// 迴歸守衛：循環任務的 firstSendTime 是「第一次」的錨點，可能在好幾天前。
// 直接把它顯示出來，一條每天的任務看著就像「過點了還沒觸發」——設置面板、角色查到的
// 清單、注入角色的排程現狀塊三處都栽在這上面，所以時間一律走 currentOccurrenceMs。
describe('currentOccurrenceMs（清單顯示的「這一次」）', () => {
  const NOW = new Date('2026-07-26T14:00:00.000Z').getTime();
  const at = (iso: string) => new Date(iso).getTime();

  it('一次性任務恆為 firstSendTime，過沒過點都一樣', () => {
    const future = task({ firstSendTime: '2026-07-27T09:00:00.000Z' });
    const past = task({ firstSendTime: '2026-07-20T09:00:00.000Z' });
    expect(currentOccurrenceMs(future, NOW)).toBe(at('2026-07-27T09:00:00.000Z'));
    expect(currentOccurrenceMs(past, NOW)).toBe(at('2026-07-20T09:00:00.000Z'));
  });

  it('每天：幾天前建的任務推到今天/明天的那一次，而不是原始錨點', () => {
    const daily = task({ recurrenceType: 'daily', firstSendTime: '2026-07-20T09:00:00.000Z' });
    // 今天 09:00 已經過了（現在 14:00），下一次是明天 09:00
    expect(currentOccurrenceMs(daily, NOW)).toBe(at('2026-07-27T09:00:00.000Z'));
  });

  it('每週：按 7 天推，跨月也不迭代', () => {
    const weekly = task({ recurrenceType: 'weekly', firstSendTime: '2026-05-04T09:00:00.000Z' });
    const next = currentOccurrenceMs(weekly, NOW)!;
    expect(next).toBeGreaterThan(NOW);
    expect((next - at('2026-05-04T09:00:00.000Z')) % (7 * 24 * H)).toBe(0);
  });

  it('時間串壞掉 → null（調用方退回原值顯示，不拋錯）', () => {
    expect(currentOccurrenceMs(task({ firstSendTime: '不是時間' }), NOW)).toBeNull();
  });
});

// 「已到點」這三個字對一次性任務等於沒說——發過了還是卡住了，用戶分不出來。
// 遠端底帳正好能分辨，這裡釘住三檔口徑。
describe('describeTaskProgress', () => {
  const now = Date.now();
  const pending = task({ taskUuid: 'aaaaaaaa-0000-0000-0000-000000000000' });
  const fired = task({
    taskUuid: 'ffffffff-0000-0000-0000-000000000000',
    firstSendTime: new Date(now - 24 * H).toISOString(),
  });

  it('還沒到點 → 待觸發（底帳有沒有都一樣）', () => {
    expect(describeTaskProgress(pending, new Set([pending.taskUuid]), now)).toBe('待觸發');
    expect(describeTaskProgress(pending, null, now)).toBe('待觸發');
  });

  it('過點了、遠端那行還在 → cron 還沒消費', () => {
    expect(describeTaskProgress(fired, new Set([fired.taskUuid]), now)).toBe('已到點·待處理');
  });

  it('過點了、遠端已經沒有 → worker 處理完了（發出去或被閘作廢）', () => {
    expect(describeTaskProgress(fired, new Set(), now)).toBe('已觸發');
  });

  it('底帳沒拉到 → 不猜，給中性文案', () => {
    expect(describeTaskProgress(fired, null, now)).toBe('已到點');
  });

  // 一次性任務重試用完會被標 'failed' 留在遠端，永遠不會再被消費——
  // 這時候還說「待處理」是騙人，它不會有下文了。
  it('遠端那行還在但已是 failed 終態 → 發送失敗，不再說「待處理」', () => {
    expect(describeTaskProgress(fired, new Set([fired.taskUuid]), now, 'failed')).toBe('發送失敗');
    // 非終態的遠端 status（pending 等）不改變原口徑。
    expect(describeTaskProgress(fired, new Set([fired.taskUuid]), now, 'pending')).toBe('已到點·待處理');
  });
});

// ─── 遠端 lastError（上一次沒發出去的原因）的收斂與人話 ───
describe('parseRemoteTaskLastError', () => {
  it('標準形狀（run-tick 寫的 {at, occurrence, reason}）原樣收斂', () => {
    expect(parseRemoteTaskLastError({
      at: '2026-07-30T15:00:10.000Z',
      occurrence: '2026-07-30T15:00:00.000Z',
      reason: 'stale',
    })).toEqual({
      at: '2026-07-30T15:00:10.000Z',
      occurrence: '2026-07-30T15:00:00.000Z',
      reason: 'stale',
    });
  });

  it('null / 非對象 / 全空對象 → null（舊 worker 沒這字段，界面不顯示那行）', () => {
    expect(parseRemoteTaskLastError(null)).toBeNull();
    expect(parseRemoteTaskLastError(undefined)).toBeNull();
    expect(parseRemoteTaskLastError('stale')).toBeNull();
    expect(parseRemoteTaskLastError({})).toBeNull();
    expect(parseRemoteTaskLastError({ at: 123, reason: '' })).toBeNull();
  });

  it('字段殘缺時留下能用的部分', () => {
    expect(parseRemoteTaskLastError({ reason: 'HTTP 403' })).toEqual({
      at: undefined, occurrence: undefined, reason: 'HTTP 403',
    });
  });
});

describe('describeRemoteLastError', () => {
  const fmt = (iso: string) => `T(${iso})`;

  it("reason 'stale' → 「到點時已過期太久，跳過了一次」，時間優先用 occurrence", () => {
    expect(describeRemoteLastError({
      at: '2026-07-30T15:00:10.000Z',
      occurrence: '2026-07-30T15:00:00.000Z',
      reason: 'stale',
    }, fmt)).toBe('T(2026-07-30T15:00:00.000Z) 到點時已過期太久，跳過了一次');
  });

  it('其餘 reason → 「上次到點沒發出去（連續失敗）」並帶上原因', () => {
    expect(describeRemoteLastError({
      occurrence: '2026-07-30T15:00:00.000Z',
      reason: 'Web Push 返回 HTTP 403',
    }, fmt)).toBe('T(2026-07-30T15:00:00.000Z) 上次到點沒發出去（連續失敗：Web Push 返回 HTTP 403）');
  });

  it('reason 是一長串原始報錯時截斷，別把整段堆棧糊上卡片', () => {
    const text = describeRemoteLastError({ reason: 'x'.repeat(500) }, fmt)!;
    // 對著常量算，別寫死數字：截斷長度會隨上游報錯的形態調整，寫死的話調一次常量
    // 就假掛一次，而這條測試真正要釘的是「500 字的原文不會整段糊上來」。
    expect(text.length).toBeLessThan(REMOTE_ERROR_REASON_MAX + 40);
    expect(text).toContain('上次到點沒發出去');
  });

  // 上游拒了請求時 reason 是「狀態行 —— 上游原話」兩段，而唯一能照著改的東西
  // （模型名寫錯、餘額不夠）全在破折號後面。老的 60 字截斷正好把它整段切掉。
  it('LLM 上游那句話取破折號後面那段，不把狀態行佔滿整行', () => {
    const reason = 'AI API error: 401 Unauthorized. Request URL: https://api.example.com/v1/chat/completions\n'
      + '  — Incorrect API key provided: sk-[redacted]. (provider code: invalid_api_key)';
    const text = describeRemoteLastError({ reason }, fmt)!;
    expect(text).toContain('Incorrect API key provided');
    expect(text).toContain('invalid_api_key');
    expect(text).not.toContain('Request URL');
  });

  it('推送訂閱失效（pushStatus 410 / 404）說該去重置訂閱，不報原始錯誤', () => {
    const text = describeRemoteLastError(
      { reason: 'Web Push delivery failed: 410 Gone — …', pushStatus: 410 }, fmt,
    )!;
    expect(text).toContain('重置訂閱');
    expect(text).not.toContain('410 Gone');
  });

  it('沒有 occurrence 退回 at；兩個都沒有就不帶時間；null → null', () => {
    expect(describeRemoteLastError({ at: '2026-07-30T15:00:10.000Z', reason: 'boom' }, fmt))
      .toBe('T(2026-07-30T15:00:10.000Z) 上次到點沒發出去（連續失敗：boom）');
    expect(describeRemoteLastError({ reason: 'boom' }, fmt))
      .toBe('上次到點沒發出去（連續失敗：boom）');
    expect(describeRemoteLastError(null, fmt)).toBeNull();
  });
});

describe('describeInstantChatFailure', () => {
  // 排程那句是「上次到點沒發出去」，說的是一條到點該主動開口的任務。即時對話是用戶
  // 剛按下發送的一條消息，套那個句式讀起來不知所云。
  it('說人話地講這一輪生成失敗，帶上重試次數和底層報錯，不提「到點」', () => {
    expect(describeInstantChatFailure({ at: '2026-08-05T00:00:00.000Z', reason: '上游 502' }, 3))
      .toBe('生成失敗（重試 3 次後放棄）：上游 502');
  });

  it('沒重試過就不提重試；沒有底層報錯就只說生成失敗', () => {
    expect(describeInstantChatFailure({ reason: '上游 502' }, 0)).toBe('生成失敗：上游 502');
    expect(describeInstantChatFailure({ at: '2026-08-05T00:00:00.000Z' })).toBe('生成失敗');
  });

  it("reason 'stale' 是排隊太久沒輪到，沒有底層報錯可引", () => {
    expect(describeInstantChatFailure({ reason: 'stale' }, 2)).toBe('雲端排隊太久沒輪到這一輪（重試 2 次後放棄）');
  });

  // skip-push 的兩種機器碼（worker 在 chat_fail 裡留的）：這一輪不是失敗、是沒產出。
  // 掉進「生成失敗」句式的話，用戶以為出了故障，其實是模型拒答/只做了動作。
  it("reason 'empty-generation' / 'side-effects-only' 照實說沒產出，不說成失敗", () => {
    expect(describeInstantChatFailure({ reason: 'empty-generation' }))
      .toBe('模型這輪沒有生成內容（空輸出或拒答）');
    expect(describeInstantChatFailure({ reason: 'side-effects-only' }))
      .toBe('角色這輪只做了動作，沒有文字回覆');
  });

  it('一長串原始報錯照樣截斷；沒有 lastError → null', () => {
    expect(describeInstantChatFailure({ reason: 'x'.repeat(500) })!.length)
      .toBeLessThan(REMOTE_ERROR_REASON_MAX + 40);
    expect(describeInstantChatFailure(null)).toBeNull();
  });

  // ── 機讀字段（amsg-server 2.6.0-next.21 起）：這三條守的是「按 errorCode /
  //    pushStatus 分流，不去正則匹配 reason 那句人話」。上游改個措辭，reason 就變了，
  //    而這幾句「接下來該做什麼」不能跟著失效。

  it('errorCode LLM_CALL_FAILED → 說是模型接口拒了，別讓人以為本地生成掛了', () => {
    const reason = 'AI API error: 404 Not Found. Request URL: https://api.example.com/v1/chat/completions\n'
      + '  — The model `gpt-4o-typo` does not exist. (provider code: model_not_found)';
    const text = describeInstantChatFailure({ reason, errorCode: 'LLM_CALL_FAILED' })!;
    expect(text).toContain('模型接口拒了這次請求');
    // 模型名是這一檔最關鍵的信息，上游不再脫敏它，這邊也不能截斷截掉。
    expect(text).toContain('gpt-4o-typo');
    expect(text).not.toContain('生成失敗');
  });

  // 中轉站把報錯裝在 HTTP 200 裡（amsg-server 2.6.0-next.28 起按調用失敗處理）：報錯開頭
  // 換成了「HTTP 200 but …」，給用戶看的仍得是破折號後面中轉站的原話。
  it('errorCode LLM_CALL_FAILED 且上游回的是 200 → 照樣引中轉站原話', () => {
    const reason = 'AI API error: HTTP 200 but body is not a chat completion (no choices). '
      + 'Request URL: https://relay.example.com/v1/chat/completions — 無效的令牌 (provider code: 401)';
    expect(describeInstantChatFailure({ reason, errorCode: 'LLM_CALL_FAILED' }))
      .toBe('模型接口拒了這次請求：無效的令牌 (provider code: 401)');
  });

  it('errorCode PUSH_PAYLOAD_TOO_LARGE → 說這條太長，不套「生成失敗」', () => {
    expect(describeInstantChatFailure({ reason: 'push payload 4200 bytes', errorCode: 'PUSH_PAYLOAD_TOO_LARGE' }))
      .toBe('這條回覆太長，一條推送裝不下');
  });

  it('pushStatus 410 → 引導重新登記訂閱（重發多少次都是同一個結果）', () => {
    const text = describeInstantChatFailure(
      { reason: 'Web Push delivery failed: 410 Gone', pushStatus: 410 }, 3,
    )!;
    expect(text).toContain('重置訂閱');
    expect(text).toContain('重試 3 次後放棄');
  });

  it('認不出來的 errorCode 走通用文案，不吞掉底層報錯', () => {
    expect(describeInstantChatFailure({ reason: '上游 502', errorCode: 'SOMETHING_NEW' }))
      .toBe('生成失敗：上游 502');
  });

  // 聊天裡沒有「原文」可以展開，這句就是用戶能看到的全部，原話裡的憑據 id 不能被一句概括替掉。
  it('errorCode CREDENTIAL_MISSING → 照樣顯示原話（體檢面板那套一句話概括不用在這裡）', () => {
    const text = describeInstantChatFailure({
      reason: 'CREDENTIAL_MISSING: 憑據 cred-abc 不存在',
      errorCode: 'CREDENTIAL_MISSING',
    }, 2)!;
    expect(text).toContain('cred-abc');
  });
});

// 體檢「定時任務」那一行逐條說「這次是哪一類失敗」。原文全文另外收在「原文」底下，
// 這裡要守的是：類別說對、要緊的那半句不被吞掉、null 字段（體檢回執給的就是 null）不炸。
describe('describeTaskFailureCause', () => {
  it('模型接口拒了：類別 + 上游原話的關鍵段（模型名不能截掉）', () => {
    const reason = 'AI API error: 404 Not Found. Request URL: https://api.example.com/v1/chat/completions\n'
      + '  — The model `gpt-4o-typo` does not exist. (provider code: model_not_found)';
    const text = describeTaskFailureCause({ reason, errorCode: 'LLM_CALL_FAILED', pushStatus: null });
    expect(text).toContain('模型接口拒了這次請求');
    expect(text).toContain('gpt-4o-typo');
    expect(text).not.toContain('Request URL');
  });

  it('推送服務拒收：類別 + 狀態碼（原話裡狀態碼在破折號前面，會被切掉，從機讀字段補回來）', () => {
    const text = describeTaskFailureCause({
      reason: 'Web Push delivery failed: 403 Forbidden — invalid JWT provided',
      errorCode: 'PUSH_SEND_FAILED',
      pushStatus: 403,
    });
    expect(text).toBe('推送服務沒收下這條消息（403）：invalid JWT provided');
  });

  it('只要一句就說完的幾種直接給那一句', () => {
    expect(describeTaskFailureCause({ reason: 'CREDENTIAL_MISSING: 憑據 cred-1 不存在', errorCode: 'CREDENTIAL_MISSING' }))
      .toBe('Worker 上找不到這個角色要用的 API 憑據');
    expect(describeTaskFailureCause({ reason: 'PUSH_SUBSCRIPTION_MISSING: …', errorCode: 'PUSH_SUBSCRIPTION_MISSING' }))
      .toBe('Worker 上沒有登記收件設備');
    expect(describeTaskFailureCause({ reason: 'AGENTIC_LOOP_EXCEEDED: no finish/skip-push decision within 6 LLM round(s)', errorCode: 'AGENTIC_LOOP_EXCEEDED' }))
      .toBe('工具調用輪數用完了還沒寫出回覆');
    expect(describeTaskFailureCause({ reason: 'x', errorCode: 'AGENTIC_EMPTY_TOOL_REQUEST' })).toContain('工具');
    expect(describeTaskFailureCause({ reason: 'push payload 4200 bytes', errorCode: 'PUSH_PAYLOAD_TOO_LARGE' }))
      .toBe('這條回覆太長，一條推送裝不下');
  });

  it('訂閱失效（410）照舊說去重置訂閱', () => {
    expect(describeTaskFailureCause({ reason: 'Web Push delivery failed: 410 Gone', errorCode: 'PUSH_SEND_FAILED', pushStatus: 410 }))
      .toContain('重置訂閱');
  });

  it("'stale' 說成過期太久，不把機器詞原樣透出去", () => {
    expect(describeTaskFailureCause({ reason: 'stale', errorCode: null, pushStatus: null })).toBe('到點時已經過期太久');
  });

  it('SullyOS 自己的 Worker 拋的錯沒有 errorCode：原話截一段，代號留在開頭', () => {
    const text = describeTaskFailureCause({
      reason: `AMSG2_FIRE_STATE_MISSING: ${'x'.repeat(400)}`,
      errorCode: null,
      pushStatus: null,
    });
    expect(text.startsWith('AMSG2_FIRE_STATE_MISSING')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(REMOTE_ERROR_REASON_MAX);
  });

  it('什麼都沒留下時也給一句，不返回空串', () => {
    expect(describeTaskFailureCause({ reason: '', errorCode: null, pushStatus: null })).toBe('沒留下具體原因');
  });
});

describe('pruneFiredTasks', () => {
  const now = Date.now();
  const uuids = (list: ActiveMsg2TaskRecord[]) => list.map((t) => shortTaskId(t.taskUuid));
  const fired = task({
    taskUuid: 'ffffffff-0000-0000-0000-000000000000',
    firstSendTime: new Date(now - 24 * H).toISOString(),
  });
  const pending = task({ taskUuid: 'aaaaaaaa-0000-0000-0000-000000000000' });

  it('走完的一次性任務出清單，待觸發的留下', () => {
    expect(uuids(pruneFiredTasks([fired, pending], new Set(), now))).toEqual(['aaaaaaaa']);
  });

  it('過點了但遠端那行還在 → worker 還沒處理，留著', () => {
    expect(uuids(pruneFiredTasks([fired], new Set([fired.taskUuid]), now))).toEqual(['ffffffff']);
  });

  // 帶錯誤的那行是用戶唯一能看見的線索（遠端可能還會照發），清掉等於把問題藏起來。
  it('帶 lastError 的即使走完也留著', () => {
    const broken = { ...fired, lastError: REPLACE_CANCEL_FAILED_NOTE };
    expect(uuids(pruneFiredTasks([broken], new Set(), now))).toEqual(['ffffffff']);
  });

  it('底帳沒拉到時一條都不動', () => {
    expect(uuids(pruneFiredTasks([fired, pending], null, now))).toEqual(['ffffffff', 'aaaaaaaa']);
  });

  it('循環任務過點了也不清——它下一輪還會響', () => {
    const daily = task({
      taskUuid: 'dddddddd-0000-0000-0000-000000000000',
      firstSendTime: new Date(now - 24 * H).toISOString(),
      recurrenceType: 'daily',
    });
    expect(uuids(pruneFiredTasks([daily], new Set(), now))).toEqual(['dddddddd']);
  });

  // 清理口徑必須跟面板上那行字一致：寫著「已觸發」的正是該清掉的那條，
  // 兩邊走岔就會出現「顯示已觸發卻清不掉」或者「還在處理卻被清了」。
  it('清理口徑與 describeTaskProgress 的「已觸發」對齊', () => {
    for (const t of [fired, pending]) {
      const remote = new Set<string>();
      const kept = pruneFiredTasks([t], remote, now).length === 1;
      expect(kept).toBe(describeTaskProgress(t, remote, now) !== '已觸發');
    }
  });
});

// 迴歸守衛：fire 時刻的排程清單。平時聊天角色每輪都看得到自己掛著什麼，到點生成時
// 以前是瞎的——於是它會把同一件事再排一遍，或者說「等下再告訴你 X」而 X 早就排好了。
// 這一塊跟聊天那份說同一套話，但有三處只屬於 fire：時區換算、摘掉正在發的那條、不帶作廢回執。
describe('buildFireTaskListBlock', () => {
  const NOW = Date.UTC(2026, 6, 30, 12, 0);
  const fireTask = (over: Partial<ActiveMsg2TaskRecord> = {}): ActiveMsg2TaskRecord => ({
    taskUuid: 'aaaaaaaa-1111-4111-8111-111111111111',
    clientTaskId: 'client-1',
    mode: 'auto',
    firstSendTime: new Date(NOW + 3600_000).toISOString(),
    recurrenceType: 'none',
    expirePolicy: 'expire',
    source: 'user',
    status: 'scheduled',
    createdAt: NOW,
    ...over,
  });

  it('列出待觸發任務，時間按 tzId 換算（worker 跑在 UTC，不能用運行時本地時區）', () => {
    const block = buildFireTaskListBlock([fireTask()], { nowMs: NOW, tzId: 'Asia/Shanghai' });
    expect(block).toContain('7月30日 21:00');            // UTC 13:00 → UTC+8 21:00
    expect(buildFireTaskListBlock([fireTask()], { nowMs: NOW, tzId: 'UTC' }))
      .toContain('7月30日 13:00');
  });

  it('tzId 與當前時間槽 / self_log 同一參照系（東京鍾）', () => {
    // UTC 13:00 → 東京 22:00。
    const block = buildFireTaskListBlock([fireTask()], { nowMs: NOW, tzId: 'Asia/Tokyo' });
    expect(block).toContain('7月30日 22:00');
    expect(block).not.toContain('13:00');
  });

  it('摘掉正在發的那一條——列進去角色會以為還得再排一次', () => {
    const firing = fireTask({ clientTaskId: 'client-firing' });
    const other = fireTask({
      taskUuid: 'bbbbbbbb-2222-4222-8222-222222222222',
      clientTaskId: 'client-other',
    });
    const block = buildFireTaskListBlock([firing, other], {
      nowMs: NOW, tzId: 'UTC', excludeClientTaskId: 'client-firing',
    });
    expect(block).toContain(shortTaskId(other.taskUuid));
    expect(block).not.toContain(shortTaskId(firing.taskUuid));
  });

  it('過點的一次性任務不列（isPendingTask 同一把尺）', () => {
    const past = fireTask({ firstSendTime: new Date(NOW - 86_400_000).toISOString() });
    expect(buildFireTaskListBlock([past], { nowMs: NOW, tzId: 'UTC' })).toBe('');
  });

  it('循環任務寫「下一次」的時間，不是好幾天前的首次', () => {
    const daily = fireTask({
      firstSendTime: new Date(Date.UTC(2026, 6, 20, 13, 0)).toISOString(),
      recurrenceType: 'daily',
    });
    const block = buildFireTaskListBlock([daily], { nowMs: NOW, tzId: 'UTC' });
    expect(block).toContain('7月30日 13:00');
    expect(block).not.toContain('7月20日');
  });

  // 迴歸守衛：這一塊以前只說「別重複排、也別當它們不存在」，沒說「別唸出來」。
  // 短 id 和「遇忙作廢」是純系統腔，被角色照著複述出來就是當場穿幫。
  it('帶防複述約束（跟平時聊天那份共用同一句）', () => {
    const block = buildFireTaskListBlock([fireTask()], { nowMs: NOW, tzId: 'UTC' });
    expect(block).toContain(AMSG2_SCHEDULE_SECRECY_NOTE);
    expect(block).toContain('不要向用戶複述');
  });

  it('沒有可列的 → 空串（槽位被抹平）', () => {
    expect(buildFireTaskListBlock([], { nowMs: NOW, tzId: 'UTC' })).toBe('');
    expect(buildFireTaskListBlock([fireTask()], {
      nowMs: NOW, tzId: 'UTC', excludeClientTaskId: 'client-1',
    })).toBe('');
  });

  it('帶上模式與防穿幫策略——角色要據此判斷這條會不會被讓路', () => {
    const block = buildFireTaskListBlock([fireTask({ expirePolicy: 'force', mode: 'prompted', promptHint: '叫他起床' })], {
      nowMs: NOW, tzId: 'UTC',
    });
    expect(block).toContain('強制發送');
    expect(block).toContain('叫他起床');
  });
});

describe('reconcileTasksWithRemote（跟遠端底帳對一次帳）', () => {
  const remoteRow = (over: Record<string, unknown> = {}) => ({
    uuid: 'amsgself-char1-1754179200000-0',
    status: 'scheduled',
    lastError: null,
    clientTaskId: 'amsgself-char1-1754179200000-0-c',
    messageType: 'auto',
    recurrenceType: 'daily',
    nextSendAt: '2026-08-03T01:00:00.000Z',
    ...over,
  }) as any;

  // 角色在 fire 裡給自己排的任務是隨 push 認領的。那條 push 推失敗、或者被防穿幫閘
  // 吞掉，認領就跟著沒了，而任務在 D1 裡照常到點觸發——面板列不出來、用戶也取消不掉，
  // 唯一的辦法是關掉整個 2.0 或者刪角色。
  it('遠端有、本地沒有的任務補回清單', () => {
    const out = reconcileTasksWithRemote([], [remoteRow()]);
    expect(out.map((t) => t.taskUuid)).toEqual(['amsgself-char1-1754179200000-0']);
    expect(out[0].source).toBe('character');
    expect(out[0].recurrenceType).toBe('daily');
    expect(out[0].nextSendAt).toBe('2026-08-03T01:00:00.000Z');
  });

  it('本地已有的不重複補，只把遠端算的下次觸發時刻同步過來', () => {
    const local = [task({ taskUuid: 'amsgself-char1-1754179200000-0' })];
    const out = reconcileTasksWithRemote(local, [remoteRow()]);
    expect(out).toHaveLength(1);
    expect(out[0].nextSendAt).toBe('2026-08-03T01:00:00.000Z');
  });

  it('遠端那行還沒有下次觸發時刻 → 不憑空造一條本地記錄', () => {
    expect(reconcileTasksWithRemote([], [remoteRow({ nextSendAt: undefined })])).toEqual([]);
  });

  it('遠端一條都沒有 → 原樣返回，不動本地清單', () => {
    const local = [task()];
    expect(reconcileTasksWithRemote(local, [])).toEqual(local);
  });

  // 失敗的行會在遠端留 7 天（一次性任務發成功才刪行），照單全收的話，清單上會多出
  // 一條永遠等不到的幽靈任務。
  it('遠端那行已經失敗 → 不補進清單', () => {
    expect(reconcileTasksWithRemote([], [remoteRow({ status: 'failed' })])).toEqual([]);
  });

  // 即時對話的行是「用戶此刻正等著的一輪聊天」，不是排程：補進清單會顯示成待觸發的
  // 任務，還可能被「取消全部」把用戶正等著的回覆順手掐掉。
  it('遠端那行是即時對話 → 不補進清單', () => {
    expect(reconcileTasksWithRemote([], [remoteRow({ messageSubtype: 'instant-chat' })])).toEqual([]);
  });
});

describe('currentOccurrenceMs 跨夏令時', () => {
  // 循環任務按角色所在時區的牆鍾推進（worker 那邊用 Intl 算）。本地固定加 24 小時的話，
  // 紐約的每日任務過一次夏令時切換就永久偏一小時，顯示的時刻跟真正會響的對不上。
  it('對過帳就用遠端算的那個時刻，不自己按固定週期乘', () => {
    const dstTask = task({
      firstSendTime: '2026-03-07T13:00:00.000Z',   // 紐約 3/7 08:00（EST）
      recurrenceType: 'daily',
      nextSendAt: '2026-03-08T12:00:00.000Z',      // 紐約 3/8 08:00（EDT，真實間隔 23h）
    });
    const now = Date.parse('2026-03-07T14:00:00.000Z');

    expect(currentOccurrenceMs(dstTask, now)).toBe(Date.parse('2026-03-08T12:00:00.000Z'));
    // 固定 +24h 會算成 13:00Z，也就是紐約的 09:00——那正是舊行為偏掉的那一小時。
    expect(currentOccurrenceMs(dstTask, now)).not.toBe(Date.parse('2026-03-08T13:00:00.000Z'));
  });

  it('遠端給的那次已經過點 → 退回自己推算（還沒對上這一輪的帳）', () => {
    const stale = task({
      firstSendTime: '2026-03-07T13:00:00.000Z',
      recurrenceType: 'daily',
      nextSendAt: '2026-03-08T12:00:00.000Z',
    });
    const now = Date.parse('2026-03-20T00:00:00.000Z');
    expect(currentOccurrenceMs(stale, now)).toBeGreaterThan(now);
  });
});

// ─── 設置面板的「啟用主動消息 2.0」開關必須落盤 ───
//
// isAmsg2EnabledForChar 只認持久化下來的 enabled:true。開關的 onClick 要是只改 React
// state，用戶撥開、關掉彈窗之後角色身上還是沒有 activeMsg2Config：聊天裡不注入
// schedule/cancel/renew/list、fire_pack 的 selfScheduleEnabled 上傳 false、雲端 fire
// 也不給排程能力，而重開面板開關又顯示成「關」。症狀是純界面的，不報錯也不崩，
// 用戶唯一能歪打正著的路子是去點「新建任務」——那條路才順手寫了 enabled:true。
//
// 倉庫的 vitest 是純 Node 環境（沒裝 jsdom），設置面板是 React 組件跑不起來測行為，
// 所以沿用 amsg2CharToggle.wiring.test.ts 的做法做源碼級斷言：它驗證不了運行時時序，
// 只釘住「開關接的是會寫庫的 handler」這一件事。
describe('設置面板的啟用開關落盤', () => {
  const modal = readFileSync(
    fileURLToPath(new URL('../components/chat/ActiveMsg2SettingsModal.tsx', import.meta.url)),
    'utf8',
  );
  const toggleHandler = modal.match(/const handleToggleEnabled[\s\S]*?\n  \};/)?.[0] ?? '';

  it('開關接的是會寫庫的 handler，不是裸 setEnabled', () => {
    expect(modal).toMatch(/onClick=\{handleToggleEnabled\}/);
    expect(modal).not.toMatch(/onClick=\{\(\) => setEnabled\(!enabled\)\}/);
  });

  it('handler 既改面板狀態也落盤', () => {
    expect(toggleHandler).toMatch(/setEnabled\(!enabled\)/);
    expect(toggleHandler).toMatch(/onSave\(/);
  });

  it('只有「開」就地落盤，「關」留給「關閉 2.0」按鈕先取消遠端任務', () => {
    // 就地寫 enabled:false 的話，該角色在遠端的任務沒人取消，會變成面板看不見、
    // 卻照樣到點觸發的幽靈任務。
    expect(toggleHandler).toMatch(/if \(turningOn\)[\s\S]*?onSave\(/);
  });
});

// 任務卡片上那行原因只留得下關鍵半句，狀態碼和上游原話的其餘部分都截掉了——
// 用戶截圖來問的時候，唯一能看到全文的地方就是這個「原文」摺疊塊。
// 跟上面一樣是源碼級斷言（vitest 是純 Node 環境，組件跑不起來）。
describe('任務卡片的失敗原文', () => {
  const modal = readFileSync(
    fileURLToPath(new URL('../components/chat/ActiveMsg2SettingsModal.tsx', import.meta.url)),
    'utf8',
  );

  it('失敗原因下面掛著「原文」摺疊塊，放的是沒截斷的 reason', () => {
    expect(modal).toMatch(/<summary[^>]*>原文<\/summary>/);
    expect(modal).toMatch(/<pre[^>]*>\s*\{remoteInfo\.lastError\.reason\}\s*<\/pre>/);
  });
});
