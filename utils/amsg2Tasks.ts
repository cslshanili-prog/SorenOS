/**
 * amsg2 多任務清單的讀取/派生工具集。
 *
 * 主要在瀏覽器側用；worker bundle 也會打進這份代碼（fire 時要渲染「你現在還掛著哪些排程」，
 * 見 buildFireTaskListBlock）。所以這裡只能依賴純函數葉子，別往上引前端環境的東西。
 * 另外：worker 跑在 UTC，任何顯示給角色看的時間都得按 fire_pack 的時區參照系（tzId）
 * 換算，不能用 formatTaskTime 那種吃運行時本地時區的寫法。
 *
 * 狀態設計：清單隻存 'scheduled'（取消即移除記錄）。到點後的一次性任務不回寫
 * 狀態——「已發送 / 已作廢」由消息歷史現場推導（amsg2TaskContext），避免
 * React 之外（push 送達路徑）寫角色數據引發狀態競爭。過點 48h 的一次性任務
 * 由 pruneStaleTasks 在下一次任務變更落盤時順手清掉。
 */

import {
  ActiveMsg2CharacterConfig,
  ActiveMsg2ExpirePolicy,
  ActiveMsg2Mode,
  ActiveMsg2Recurrence,
  ActiveMsg2TaskRecord,
  CharacterProfile,
} from '../types';
import { FIRE_GRACE_MS, recurrencePeriodMs } from './amsg2ExpireGuard';
import { AMSG_INSTANT_CHAT_SUBTYPE, type AmsgTzRef, formatFireTimeShort } from './amsgFirePack';
import { AMSG_BACKGROUND_JOB_SUBTYPE, AMSG_DELAYED_REPLY_SUBTYPE } from './amsgTaskKinds';

/**
 * 這個角色是否開著主動消息 2.0。
 *
 * 只有在設置面板裡把開關打開過（持久化 enabled:true）才算開。從沒配過的角色
 * （config 缺失）算關——注入工具前必須過這道判定，否則用戶還沒表態要不要用，
 * 角色已經能調 schedule_active_message 給他排定時消息了。
 *
 * 面板的開關初值和工具注入門都讀這一個判定，別各寫各的三元——兩處答案不一致的話，
 * 面板顯示「關」而角色其實照樣能排程，界面就成了騙人的那一方。
 *
 * 「關」是默認值，不是需要遷移掉的舊數據：寫 activeMsg2Config 的每條路（面板保存、
 * 角色用工具排程、push 認領自排任務、面板與遠端對帳補任務）落盤時都帶著 enabled:true，
 * 所以真用過 2.0 的角色身上一定有這面旗，判定翻面也照常能排程；剩下 config 缺失的
 * 那批本來就一次沒用過。反過來給全體角色補寫一份 config 更糟——amsg2CharCleanup 拿
 * 「身上有沒有 activeMsg2Config」判斷刪角色時要不要去雲端清數據，補完之後每刪一個
 * 角色都會為一份根本不存在的雲端殘留發請求。
 */
export const isAmsg2EnabledForChar = (char: CharacterProfile): boolean =>
  char.activeMsg2Config?.enabled === true;

export const shortTaskId = (taskUuid: string): string => taskUuid.slice(0, 8);

/**
 * fixed 任務恆為 force：它沒有 AI 生成環節，防穿幫閘的「作廢」對它沒有意義，
 * 而且 worker 的閘壓根不會看到 fixed 任務。寫任務記錄的地方都過這裡，別各寫各的三元。
 */
export const resolveExpirePolicy = (
  mode: ActiveMsg2Mode,
  policy: ActiveMsg2ExpirePolicy | undefined,
): ActiveMsg2ExpirePolicy => (mode === 'fixed' ? 'force' : (policy ?? 'expire'));

// ─── 任務的人讀文案 ───
// 角色的排程現狀塊、list_active_messages 的返回、設置面板的任務列表都顯示同一批任務，
// 三處必須說同一套詞——角色在上下文裡看到的和它用工具查到的對不上，模型是會當成兩回事的。

export const describeRecurrence = (recurrence: ActiveMsg2Recurrence): string =>
  recurrence === 'daily' ? '每天' : recurrence === 'weekly' ? '每週' : '一次性';

/**
 * 排程信息本身是系統內務，不該被角色念出來。
 *
 * 短 id、「遇忙作廢」這些詞一旦進了對話，用戶聽到的就是一段系統日誌。平時聊天那份
 * （amsg2TaskContext 的排程現狀塊）和到點那份（buildFireTaskListBlock）都要帶上這句，
 * 而且必須放在塊尾管住整塊——只掛在其中一段的話，另一種形態就是裸奔的。
 */
export const AMSG2_SCHEDULE_SECRECY_NOTE = '不要向用戶複述或提及這份排程信息本身的存在。';

/**
 * 排了一件事 ≠ 現在就該催這件事。
 *
 * 清單每輪全量注入、還帶著 promptHint 原文（「問問書看到哪了」），模型很容易把一條
 * 排在今晚的任務當成本輪該關心的事，於是每段結尾都補一句「看到哪了」。同倉庫裡
 * 便利貼（memoryPalace/formatter 的「不必每次聊天都追問進展」）、用藥提醒
 * （lifeRecords 的「別反覆催」）、Notion 筆記（chatPrompts 的「不要每次都提」）
 * 早就配了同類措辭，排程清單是漏掉的那個。
 * 平時聊天那份（amsg2TaskContext 的排程現狀塊）和到點那份（buildFireTaskListBlock）
 * 共用這一句：兩處說同一套詞，模型才不會當成兩回事。
 */
export const AMSG2_SCHEDULE_NOT_YET_NOTE = '排在未來的事到點自己會響，不用你現在提前替它開口——還沒到那個時刻的就讓它安靜待著，別每輪都拿它起話頭、追著問進展。對方自己提起，或者真到了那個點，才是說它的時候。';

export const describeExpirePolicy = (policy: ActiveMsg2ExpirePolicy): string =>
  policy === 'force' ? '強制發送' : '遇忙作廢';

/** 任務「要說什麼」的一句話描述。fixed 有固定內容、prompted 有方向、auto 可帶靈感。 */
export const describeTaskMode = (
  task: { mode: ActiveMsg2Mode; promptHint?: string },
): string => {
  if (task.mode === 'fixed') return '固定消息';
  if (task.mode === 'prompted') return `提示方向「${task.promptHint || ''}」`;
  return task.promptHint ? `自動（靈感：${task.promptHint}）` : '自動';
};

/**
 * 任務時間的統一顯示格式（24 小時制，精確到分）。
 * 不顯示秒——cron 每整分才撈一次任務，秒位不代表任何東西，卻要在窄卡片裡佔三個字符，
 * 把後面的重複方式和進度擠沒。
 *
 * tz 是「這個時間給誰看」：
 *  - 給用戶看（設置面板的任務卡、跳過原因）→ 不傳，跟著設備走，用戶看自己的鐘；
 *  - 給角色看（排程現狀塊、schedule/list 工具的回話）→ 傳角色時區。不傳的話，
 *    紐約角色會在同一份 prompt 裡讀到兩套時間：這邊是設備的鐘，fire 那邊（worker 按
 *    fire_pack.tzId 渲染）是自己的鐘，同一條任務差整整一個時差。
 */
export const formatTaskTime = (value: number | string, tz?: string): string =>
  new Date(value).toLocaleString('zh-CN', {
    hour12: false,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
    ...(tz ? { timeZone: tz } : {}),
  });

/**
 * 把任意可解析的時間折成 datetime-local 輸入框認的本地牆鍾 'YYYY-MM-DDTHH:mm'。
 * 任務的 firstSendTime 有兩種來源：面板建的本就是 datetime-local，角色用工具建的是
 * 完整 ISO 8601（帶時區）——編輯角色任務時不折算會導致時間框空白。已是該格式的原樣
 * 返回（冪等）；無法解析（空 / 壞值）也原樣返回，不拋錯。
 */
export const toDatetimeLocalValue = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
};

/**
 * datetime-local 輸入框的值 → 絕對時刻（UTC ISO）。toDatetimeLocalValue 的逆操作。
 *
 * 設置面板的時間框是給**用戶**填的，填的是用戶桌上的鐘。而排程接口拿到裸牆鍾
 * （沒有 Z / ±hh:mm 後綴）一律按**角色**時區解釋——那條規則是給角色自己排程用的
 * （紐約角色說「明早九點」就該是紐約的九點）。兩邊共用同一個字符串的話，角色一開
 * 自定義時區，用戶填的時間就會被當成角色那邊的牆鍾，同一條任務差整整一個時差。
 * 所以面板在交出去之前先按設備時區折成絕對時刻，讓後面所有環節都只認這一個時刻。
 *
 * 無法解析（空 / 壞值）原樣返回，交給下游報錯，不在這裡拋。
 */
export const fromDatetimeLocalValue = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString();
};

export const findTaskByShortId = (
  tasks: ActiveMsg2TaskRecord[],
  shortId: string,
): ActiveMsg2TaskRecord | undefined =>
  tasks.find((t) => shortTaskId(t.taskUuid) === shortId || t.taskUuid === shortId);

/** 待觸發 = 還會響的任務：循環任務恆真；一次性任務觸發點（含寬限）未過。 */
export const isPendingTask = (task: ActiveMsg2TaskRecord, nowMs: number): boolean => {
  if (task.status !== 'scheduled') return false;
  if (task.recurrenceType !== 'none') return true;
  const fireAt = new Date(task.firstSendTime).getTime();
  return Number.isFinite(fireAt) && fireAt + FIRE_GRACE_MS > nowMs;
};

/**
 * 當前該盯的那一次觸發時刻。
 *
 * 一次性任務恆為 firstSendTime。循環任務的 firstSendTime 是「第一次」的時間，可能在
 * 好幾天前，必須按週期推到當前這一次——否則清單會給一條每天的任務顯示好幾天前的時間
 * 配上「待觸發」，看著就像過點了沒響。停留條件用的是「加上送達寬限後仍在未來」，跟
 * isPendingTask 同一把尺，這樣剛過點還在發的那一次不會被跳過。
 */
export const currentOccurrenceMs = (
  task: Pick<ActiveMsg2TaskRecord, 'firstSendTime' | 'recurrenceType' | 'nextSendAt'>,
  nowMs: number,
): number | null => {
  // 遠端對過帳就以它為準：循環任務按角色所在時區的牆鍾推進，本地按固定週期乘出來的
  // 那個一跨夏令時就會跟真正會響的時刻差一小時。還沒到點的那次才作數——已經過點的
  // 說明還沒對上這一輪的帳，照舊自己推。
  const remoteNext = task.nextSendAt ? new Date(task.nextSendAt).getTime() : NaN;
  if (Number.isFinite(remoteNext) && remoteNext + FIRE_GRACE_MS > nowMs) return remoteNext;

  const first = new Date(task.firstSendTime).getTime();
  if (!Number.isFinite(first)) return null;

  const periodMs = recurrencePeriodMs(task.recurrenceType);
  if (periodMs === null) return first;

  // 找最小的 k（≥0）使 first + k*period + GRACE > now，直接算不要逐個迭代——
  // 循環任務可能已經跑了幾個月。
  const k = Math.max(0, Math.floor((nowMs - FIRE_GRACE_MS - first) / periodMs) + 1);
  return first + k * periodMs;
};

/**
 * 任務當前進度的一句話（清單裡跟在「重複方式」後面那個詞）。
 *
 * 已過點的一次性任務光說「已到點」信息量為零——用戶看不出它是發過了還是卡住了。
 * 遠端底帳正好能分辨：那一行還在 = worker 還沒消費（cron 慢了或剛過點）；不在了 =
 * worker 已經處理完（發出去了，或者被防穿幫閘作廢了，兩種情況都會刪行）。
 * 底帳沒拉到（null）時不猜，回到中性的「已到點」。
 *
 * remoteStatus 是遠端那一行的 status（拉到底帳時順帶的投影，沒有就不傳）：
 * 一次性任務重試用完會被標 'failed' 留在遠端，不會再被消費——這時候還說
 * 「待處理」是騙人，它不會有下文了。
 */
export const describeTaskProgress = (
  task: ActiveMsg2TaskRecord,
  knownRemoteUuids: Set<string> | null,
  nowMs: number,
  remoteStatus?: string,
): string => {
  if (isPendingTask(task, nowMs)) return '待觸發';
  if (knownRemoteUuids === null) return '已到點';
  if (!knownRemoteUuids.has(task.taskUuid)) return '已觸發';
  return remoteStatus === 'failed' ? '發送失敗' : '已到點·待處理';
};

export const getPendingTasks = (
  config: ActiveMsg2CharacterConfig | undefined,
  nowMs: number,
): ActiveMsg2TaskRecord[] =>
  (config?.tasks ?? []).filter((t) => isPendingTask(t, nowMs));

/** 這個任務的觸發有沒有可能被防穿幫閘作廢（fixed / force 永遠照發）。 */
export const canExpire = (task: ActiveMsg2TaskRecord): boolean =>
  task.status === 'scheduled' && task.mode !== 'fixed' && task.expirePolicy === 'expire';

/** 有沒有還會響的 AI 任務（amsgStateSync 的同步門用：fixed 不需要 fire_pack）。 */
export const hasActiveAiTask = (
  config: ActiveMsg2CharacterConfig | undefined,
  nowMs = Date.now(),
): boolean => getPendingTasks(config, nowMs).some((t) => t.mode !== 'fixed');

/**
 * fire 時刻注進 prompt 的「你現在還掛著哪些排程」。
 *
 * 跟平時聊天那份（amsg2TaskContext 的排程現狀塊）說的是同一件事、用同一套 describeXxx
 * 文案，差別只有三處，都是 fire 這邊特有的：
 *   1. 時間按 fire_pack 的時區參照系（tzId）換算——
 *      worker 跑在 UTC，用運行時本地時區會整體差幾個小時；
 *   2. 摘掉正在發的這一條 —— 它此刻正在被消費，列進「進行中」會讓角色以為還得再排一次；
 *   3. 不含「已作廢回執」那一段 —— 那是給對話現場用的，到點生成時提不著。
 *
 * 沒有可列的（清單空了，或者只剩正在發的這條）→ 返回空串，槽位被抹平。
 */
export const buildFireTaskListBlock = (
  tasks: ActiveMsg2TaskRecord[],
  opts: { nowMs: number; tzId: string; excludeClientTaskId?: string },
): string => {
  const tz: AmsgTzRef = { tzId: opts.tzId };
  const listed = tasks
    .filter((t) => isPendingTask(t, opts.nowMs))
    .filter((t) => !opts.excludeClientTaskId || t.clientTaskId !== opts.excludeClientTaskId);
  if (listed.length === 0) return '';

  return [
    '',
    '',
    '【你還掛著這些排程·僅你可見】',
    ...listed.map((t) => {
      const occurrenceMs = currentOccurrenceMs(t, opts.nowMs);
      const when = formatFireTimeShort(
        occurrenceMs ?? new Date(t.firstSendTime).getTime(),
        tz,
      );
      return `- [${shortTaskId(t.taskUuid)}] ${when} ${describeRecurrence(t.recurrenceType)}`
        + ` · ${describeTaskMode(t)} · ${describeExpirePolicy(t.expirePolicy)}`;
    }),
    '（這幾條到點會自動發出去，別在這條消息裡把同一件事再排一遍，也別當它們不存在。）',
    AMSG2_SCHEDULE_NOT_YET_NOTE,
    AMSG2_SCHEDULE_SECRECY_NOTE,
  ].join('\n');
};

// ─── 遠端 lastError：上一次到點為什麼沒發出去 ───
// amsg-server 2.6.0-next.10 起 GET /messages 每條任務多帶 lastError（run-tick 在
// 失敗時寫進 payload）：{ at: 記錄時刻 ISO, occurrence: 那一次的名義觸發時刻 ISO,
// reason: 'stale'（錯過觸發時刻太久被跳過）| 投遞失敗的原始錯誤信息 }。
// 服務端只在失敗時寫、之後成功也不清，所以它永遠是「最近一次失敗」的記錄——
// 顯示時必須帶上時間，老記錄才不會被讀成「現在還壞著」。
//
// 2.6.0-next.21 起同一份記錄多兩個機讀字段：errorCode（底層錯誤的穩定 code）和
// pushStatus（真正發推送那一步上游回的狀態碼）。「這次該怎麼辦」讀這兩個就夠，
// 不用回去正則匹配 reason 那句人話——那是給用戶看的自由文本，上游改個措辭，
// 按文本分流的代碼就靜默失效了。

export interface RemoteTaskLastError {
  at?: string;
  occurrence?: string;
  reason?: string;
  /** 底層錯誤的穩定 code，如 `LLM_CALL_FAILED` / `PUSH_PAYLOAD_TOO_LARGE`。 */
  errorCode?: string;
  /** 推送那一步上游回的 HTTP 狀態碼；410 / 404 = 這份訂閱已經作廢了。 */
  pushStatus?: number;
}

/** 遠端投影是解密出來的任意 JSON，進 UI 前收斂一遍形狀；全空/不是對象 → null。 */
export const parseRemoteTaskLastError = (raw: unknown): RemoteTaskLastError | null => {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const pick = (key: string): string | undefined =>
    typeof value[key] === 'string' && value[key] ? (value[key] as string) : undefined;
  const pushStatus = Number(value.pushStatus);
  const parsed: RemoteTaskLastError = {
    at: pick('at'),
    occurrence: pick('occurrence'),
    reason: pick('reason'),
    errorCode: pick('errorCode'),
    ...(Number.isFinite(pushStatus) && pushStatus > 0 ? { pushStatus } : {}),
  };
  return parsed.at || parsed.occurrence || parsed.reason || parsed.errorCode || parsed.pushStatus
    ? parsed
    : null;
};

/**
 * reason 是投遞失敗時的原始錯誤信息，可能整段 HTML / 堆棧，界面上截個頭就夠。
 *
 * 從 60 放寬到這個數：amsg-server 2.6.0-next.21 起，上游拒了請求時 reason 是
 * 「狀態行 + 破折號 + 上游原話」兩段，光狀態行就佔掉五六十字（見 pickErrorDetail），
 * 按老長度截等於每次都把唯一有用的那半句切掉。上游那句原話自己截到 300 字符，
 * 這裡再收一道——卡片上放得下、又裝得完典型的那句「模型不存在 / 餘額不足」。
 */
export const REMOTE_ERROR_REASON_MAX = 120;

/** 推送服務判定「這份訂閱已經沒了」時回的狀態碼：410 已註銷，404 端點不存在。 */
const PUSH_GONE_STATUSES = [410, 404];

/**
 * 從 reason 裡挑出最有信息量的那一段。
 *
 * 上游拒了請求時，amsg-server 寫下來的是這麼兩行：
 *
 *   AI API error: 401 Unauthorized. Request URL: https://api.example.com/v1/chat/completions
 *     — Incorrect API key provided: sk-[redacted]. (provider code: invalid_api_key)
 *
 * 第一行只說得出「是 400 還是 401」，而「模型名寫錯、餘額不夠、上下文超長、被內容
 * 審核攔下」這些真正能照著改的東西全在破折號後面。所以有破折號就取它後面那段，
 * 沒有的話（推送失敗、宿主 hook 拋錯等）原文照用。
 *
 * 取**第一個**破折號：分隔符只有那一個，後面整段都是上游原話，而原話自己也可能帶
 * 破折號（`Web Push delivery failed: 410 Gone — …` 就是），從最後一個切會把它再腰斬一次。
 */
const pickErrorDetail = (reason: string): string => {
  const dashAt = reason.indexOf('—');
  const detail = dashAt >= 0 ? reason.slice(dashAt + 1) : reason;
  return detail.replace(/\s+/g, ' ').trim();
};

/** 上游給了穩定 code 時對用戶說的話；沒有對應條目的碼走通用文案。 */
const ERROR_CODE_TEXT: Record<string, string> = {
  // 一條 push 的明文上限是 3993 字節，超了庫在加密之前就拋，一個字節都沒發出去。
  PUSH_PAYLOAD_TOO_LARGE: '這條回覆太長，一條推送裝不下',
  // 任務正文（角色設定 + 對話歷史）整個超過了存儲單行上限。
  TASK_PAYLOAD_TOO_LARGE: '這一輪要帶上雲的內容太多，超過了單條任務的上限',
};

/**
 * 體檢「定時任務」那一行專用的幾種 code：一句中文說清是哪類失敗。
 *
 * 只給體檢用，因為體檢每條下面都掛著「原文」，原話（憑據 id、英文的循環輪數）照樣
 * 看得到。任務卡片和聊天裡的即時對話失敗說明直接顯示原話，不走這張表——那裡用一句
 * 概括替掉原話，用戶就再也看不到具體是哪個憑據、哪一輪了。
 */
const DIAGNOSTIC_CODE_TEXT: Record<string, string> = {
  // 任務引用的憑據行不在庫裡，任務裡也沒有內聯的那一份。
  CREDENTIAL_MISSING: 'Worker 上找不到這個角色要用的 API 憑據',
  // 推送訂閱表裡沒有這個用戶的行：生成完了也沒地方送。
  PUSH_SUBSCRIPTION_MISSING: 'Worker 上沒有登記收件設備',
  // 帶工具的那條路上，模型一輪輪調工具，到上限了還沒給出最終回覆。
  AGENTIC_LOOP_EXCEEDED: '工具調用輪數用完了還沒寫出回覆',
  // 模型說要調工具，卻沒說調哪個。
  AGENTIC_EMPTY_TOOL_REQUEST: '模型說要調用工具，但沒給出要調哪一個',
};

/**
 * 光說類別不夠、原話裡還有要緊信息的那幾種 code：類別在前，原話的關鍵段跟在後面。
 *
 * 模型接口拒了請求時，原話裡是「模型名寫錯 / 餘額不夠 / Key 不對」；推送服務拒收時，
 * 原話裡是推送服務自己給的理由。這兩種只報類別，用戶照樣不知道該去改什麼。
 * 跟 ERROR_CODE_TEXT 分開放，是因為認到那兩張表裡的碼就整句替換、不再帶原話——
 * 放進去等於把這半句吞掉。
 */
const ERROR_KIND_TEXT: Record<string, string> = {
  // 措辭跟 describeInstantChatFailure 那一檔保持一致。上游真的答覆了才會掛這個碼
  // （網絡沒通、超時不算），所以說「拒了」不冤枉它。
  LLM_CALL_FAILED: '模型接口拒了這次請求',
  PUSH_SEND_FAILED: '推送服務沒收下這條消息',
};

/**
 * 這次失敗該怎麼辦——從機讀字段推，不看 reason 那句人話。
 * 返回 null = 沒有專門的說法，調用方走通用文案。
 */
const describeActionableFailure = (lastError: RemoteTaskLastError): string | null => {
  if (lastError.pushStatus && PUSH_GONE_STATUSES.includes(lastError.pushStatus)) {
    return '這台設備的推送訂閱已經失效，去設置頁「重置訂閱」重新登記一次';
  }
  return (lastError.errorCode && ERROR_CODE_TEXT[lastError.errorCode]) || null;
};

/**
 * 遠端 lastError 的人話（任務卡片上那行說明）。formatTime 由調用方注入
 * （面板用 formatTaskTime）；時間優先用 occurrence（「哪一次」比「什麼時候記的」
 * 更貼用戶想知道的事），沒有再退 at。
 */
export const describeRemoteLastError = (
  lastError: RemoteTaskLastError | null | undefined,
  formatTime: (iso: string) => string,
): string | null => {
  if (!lastError) return null;
  const when = lastError.occurrence || lastError.at;
  const whenText = when ? `${formatTime(when)} ` : '';
  if (lastError.reason === 'stale') {
    return `${whenText}到點時已過期太久，跳過了一次`;
  }
  // 上游點名說了是什麼毛病時用它的說法：那句話裡有「接下來該做什麼」，
  // 而原始報錯只能告訴用戶「壞了」。
  const actionable = describeActionableFailure(lastError);
  if (actionable) return `${whenText}上次到點沒發出去：${actionable}`;
  const reason = pickErrorDetail(lastError.reason || '').slice(0, REMOTE_ERROR_REASON_MAX);
  return `${whenText}上次到點沒發出去（連續失敗${reason ? `：${reason}` : ''}）`;
};

/**
 * 即時對話那一輪失敗的人話。讀的是同一份 lastError，但換一套說法：那是用戶剛按下
 * 發送的一條消息，「上次到點沒發出去」這種排程口吻放在這裡不成話。時間也不帶——
 * 就是剛才，寫出來只是噪音。retryCount 是遠端行上的重試次數（舊 worker 不投影 → 不提）。
 */
export const describeInstantChatFailure = (
  lastError: RemoteTaskLastError | null | undefined,
  retryCount?: number,
): string | null => {
  if (!lastError) return null;
  const retried = retryCount && retryCount > 0 ? `（重試 ${retryCount} 次後放棄）` : '';
  // 'stale' 是「排隊太久沒輪到就被跳過」，沒有底層報錯可以引。
  if (lastError.reason === 'stale') return `雲端排隊太久沒輪到這一輪${retried}`;
  // skip-push 的兩種（worker 在 chat_fail 裡留的機器碼）：這一輪雲端跑完了，但沒有
  // 能推給用戶的正文。照實說，別掉進下面「生成失敗」的口徑——生成沒失敗，是沒產出。
  if (lastError.reason === 'empty-generation') return '模型這輪沒有生成內容（空輸出或拒答）';
  if (lastError.reason === 'side-effects-only') return '角色這輪只做了動作，沒有文字回覆';
  // 訂閱失效 / 正文超限這類有確定處置方式的，直接說該幹什麼。這些重發多少次都是
  // 同一個結果，混在「生成失敗」裡只會讓用戶對著發送鍵反覆試。
  const actionable = describeActionableFailure(lastError);
  if (actionable) return `${actionable}${retried}`;
  const detail = pickErrorDetail(lastError.reason || '').slice(0, REMOTE_ERROR_REASON_MAX);
  // 上游明說是模型接口拒了請求：換個說法，別讓用戶以為是 SullyOS 這邊生成掛了——
  // 這一檔要查的是 API Key、模型名、餘額，跟本地一點關係沒有。
  if (lastError.errorCode === 'LLM_CALL_FAILED') {
    return `模型接口拒了這次請求${retried}${detail ? `：${detail}` : ''}`;
  }
  return `生成失敗${retried}${detail ? `：${detail}` : ''}`;
};

/**
 * 一條失敗記錄「是哪一類失敗」的短句，不帶時間，也不帶「上次到點沒發出去」這類句式。
 *
 * 給體檢「定時任務」那一行逐條說原因用：那邊每條前面已經有「誰、幾點該發、晚了多久」，
 * 這裡只補「為什麼」。認法跟任務卡片、即時對話那兩句是同一套（機讀字段優先，認不出來的
 * 截原話裡最有用的那段），三處說法才對得上。原話全文由調用方另外收在「原文」底下，
 * 所以這裡照樣截斷。
 *
 * 字段允許 null：體檢那份回執（amsgTickReport）缺值給的是 null，任務投影給的是 undefined。
 */
export const describeTaskFailureCause = (record: {
  reason?: string | null;
  errorCode?: string | null;
  pushStatus?: number | null;
}): string => {
  if (record.reason === 'stale') return '到點時已經過期太久';
  const lastError: RemoteTaskLastError = {
    reason: record.reason || undefined,
    errorCode: record.errorCode || undefined,
    ...(record.pushStatus ? { pushStatus: record.pushStatus } : {}),
  };
  const actionable = describeActionableFailure(lastError)
    || (lastError.errorCode ? DIAGNOSTIC_CODE_TEXT[lastError.errorCode] : undefined);
  if (actionable) return actionable;

  const detail = pickErrorDetail(lastError.reason || '').slice(0, REMOTE_ERROR_REASON_MAX);
  const kind = lastError.errorCode ? ERROR_KIND_TEXT[lastError.errorCode] : undefined;
  if (kind) {
    // 推送服務回的狀態碼（403 = 推送憑據對不上、413 = 太大……）在原話的破折號前面，
    // 取關鍵段時會被切掉，從機讀字段補回來。
    const status = lastError.pushStatus ? `（${lastError.pushStatus}）` : '';
    return `${kind}${status}${detail ? `：${detail}` : ''}`;
  }
  // SullyOS 自己的 Worker 拋的錯沒有 errorCode，代號寫在原話開頭（AMSG2_FIRE_STATE_MISSING: …），
  // 截出來的這段本身就帶著它。
  return detail || '沒留下具體原因';
};

/** 替換任務時遠端取消失敗的標註文案（面板和工具側共用一份，兩邊都會顯示給人看）。 */
export const REPLACE_CANCEL_FAILED_NOTE = '替換時遠端取消失敗，任務可能仍會觸發，可再次取消';

// ─── 遠端對帳：哪些任務在遠端還活著 ───
// 面板打開時拉一次全量清單當底帳，之後**不再重拉**，而是把每次遠端操作的結果增量記進來。
// 底帳是「打開那一刻」的快照，拿它去比對之後新建的任務，新任務必然不在裡面——那樣每次
// 新建都會立刻誤標一行「遠端不存在」，是純粹的時序錯覺。排程接口回了 success 就是這條
// 任務在遠端存在的確證，直接記帳即可，不用再多跑一次全量拉取。

/**
 * 把一次遠端操作的結果並進底帳。
 * `present` = 剛確認在遠端存在的（新建/替換成功）；`gone` = 剛確認已不在的（取消成功）。
 *
 * 底帳為 null（沒拉到）時保持 null：新建一條任務並不能說明**其餘**任務在不在遠端，
 * 憑這半份證據開始對帳會把別的任務全標成「遠端不存在」。
 */
export const applyRemoteTaskDelta = (
  knownRemoteUuids: Set<string> | null,
  delta: { present?: string[]; gone?: string[] },
): Set<string> | null => {
  if (!knownRemoteUuids) return null;
  const next = new Set(knownRemoteUuids);
  delta.gone?.forEach((uuid) => next.delete(uuid));
  delta.present?.forEach((uuid) => next.add(uuid));
  return next;
};

/** `GET /messages` 的任務投影（worker 側白名單，不含任何憑據）裡用得上的字段。 */
export interface RemoteTaskProjection {
  uuid: string;
  status?: string;
  lastError: RemoteTaskLastError | null;
  clientTaskId?: string;
  messageType?: string;
  /** 排程方寫的自由文本標籤；即時對話的行是 'instant-chat'，定時任務是 'chat'。 */
  messageSubtype?: string;
  recurrenceType?: string;
  nextSendAt?: string;
  /** 遠端行上的重試計數（舊 worker 不投影這字段 → undefined）。 */
  retryCount?: number;
}

/**
 * 拿遠端全量投影跟本地清單對一次帳，兩個方向都走。
 *
 * **遠端有、本地沒有 → 補回來。** 會漏帳的都是角色在 fire 裡給自己排的那些：認領是
 * 隨 push 帶回來的，那條 push 推失敗、或者被防穿幫閘吞掉，認領就跟著沒了。於是任務在
 * D1 裡照常到點觸發，本地卻列不出來、也取消不掉——用戶唯一能清掉它的辦法是關掉整個
 * 2.0 或者刪角色。面板每次打開本來就拉一次全量投影，順手接回來，零額外請求。
 *
 * **本地已有 → 同步遠端算出來的下一次觸發時刻。** 循環任務按角色所在時區的牆鍾推進，
 * 本地拿固定週期乘出來的那個跨夏令時會偏一小時，顯示得跟真正會響的時刻一致。
 */
export const reconcileTasksWithRemote = (
  local: ActiveMsg2TaskRecord[],
  remote: RemoteTaskProjection[],
): ActiveMsg2TaskRecord[] => {
  const byUuid = new Map(remote.map((r) => [r.uuid, r]));
  const known = new Set(local.map((t) => t.taskUuid));

  const synced = local.map((task) => {
    const row = byUuid.get(task.taskUuid);
    if (!row?.nextSendAt || row.nextSendAt === task.nextSendAt) return task;
    return { ...task, nextSendAt: row.nextSendAt };
  });

  const adopted = remote
    // 字段不全的行不補：寧可少一條，也別拿默認值湊一條跟遠端對不上的記錄出來。
    // 已經失敗的行也不補：它不會再響，補進來就是清單上一條永遠等不到的幽靈任務。
    // 即時對話的行同樣不補：那是用戶此刻正等著的一輪聊天，不是排程，進了清單會顯示成
    // 「待觸發的任務」，還可能被「取消全部」順手掐掉。後台任務（門牌整理這類不說話的
    // 活兒）同理——它們跟聊天任務共用調度器，但不是用戶排的主動消息。交給雲端的延遲自動
    // 回覆也一樣，它是在回用戶的話，不是排程。
    .filter((row) => (
      !known.has(row.uuid)
      && row.nextSendAt && row.recurrenceType && row.messageType
      && row.status !== 'failed'
      && row.messageSubtype !== AMSG_INSTANT_CHAT_SUBTYPE
      && row.messageSubtype !== AMSG_BACKGROUND_JOB_SUBTYPE
      && row.messageSubtype !== AMSG_DELAYED_REPLY_SUBTYPE
    ))
    .map((row): ActiveMsg2TaskRecord => ({
      taskUuid: row.uuid,
      // 歸屬鍵是應用自己寫進 metadata 的，投影裡帶回來；非 amsg2 建的任務沒有，
      // 那就拿 uuid 當歸屬鍵——它一樣是唯一的。
      clientTaskId: row.clientTaskId ?? row.uuid,
      mode: row.messageType as ActiveMsg2TaskRecord['mode'],
      firstSendTime: row.nextSendAt as string,
      nextSendAt: row.nextSendAt,
      recurrenceType: row.recurrenceType as ActiveMsg2Recurrence,
      // 遠端投影沒有防穿幫策略（那是應用寫在 metadata 裡的語義，投影不帶）。
      // 補回來的都是角色自排的，那條路徑恆為 expire。
      expirePolicy: 'expire',
      source: 'character',
      status: 'scheduled',
      createdAt: Date.now(),
    }));

  return adopted.length ? [...synced, ...adopted] : synced;
};

/**
 * 這條任務該不該標「遠端不存在」。
 * 只對**還會響**的任務判定：已過點的一次性任務本來就該從遠端消失，標它是噪音。
 */
export const isRemoteMissingTask = (
  task: ActiveMsg2TaskRecord,
  knownRemoteUuids: Set<string> | null,
  nowMs: number,
): boolean =>
  knownRemoteUuids !== null
  && isPendingTask(task, nowMs)
  && !knownRemoteUuids.has(task.taskUuid);

/**
 * 已經走完的一次性任務出清單。
 *
 * 「走完」= 過了觸發點、遠端底帳裡也沒有這一行。worker 領走任務後就會刪掉那行，
 * 所以底帳裡找不到它 = 這一次已經處理完了，本地留著只會讓清單越積越長（一天測下來
 * 就能攢出十來條一模一樣的「已觸發」）。判定跟 describeTaskProgress 是同一把尺：
 * 那裡寫「已觸發」的，正是這裡清掉的。
 *
 * 兩種情況一律留著：
 *   - 帶 lastError 的（比如替換時遠端取消失敗，遠端可能還會照發）——那行錯誤是用戶
 *     唯一能看見的線索，自動清掉等於把問題藏起來；
 *   - 底帳沒拉到（null）——分不出「遠端處理完了」和「壓根沒讀到遠端」，一條都不動。
 *
 * 循環任務永遠還會響，isPendingTask 對它們恆真，不會被這裡帶走。
 */
export const pruneFiredTasks = (
  tasks: ActiveMsg2TaskRecord[],
  knownRemoteUuids: Set<string> | null,
  nowMs: number,
): ActiveMsg2TaskRecord[] => {
  if (knownRemoteUuids === null) return tasks;
  return tasks.filter((task) => Boolean(task.lastError)
    || isPendingTask(task, nowMs)
    || knownRemoteUuids.has(task.taskUuid));
};

/**
 * 排程 / 替換成功後把新記錄並進清單。
 *
 * 替換失敗時**保留舊記錄並標錯**，絕不靜默丟掉：遠端此時新舊並存，本地要是只留新的，
 * 舊任務就成了沒有短 id、誰都取消不了的幽靈任務。面板和角色工具兩條路都走這裡，
 * 規則只有一份。
 */
export const applyScheduledTask = (
  tasks: ActiveMsg2TaskRecord[],
  record: ActiveMsg2TaskRecord,
  opts: { replaceTaskUuid?: string; replacedCancelFailed?: boolean },
  nowMs: number,
): ActiveMsg2TaskRecord[] => {
  const rest = opts.replacedCancelFailed
    ? tasks.map((t) => t.taskUuid === opts.replaceTaskUuid
      ? { ...t, lastError: REPLACE_CANCEL_FAILED_NOTE }
      : t)
    : tasks.filter((t) => t.taskUuid !== opts.replaceTaskUuid);
  return pruneStaleTasks([...rest, record], nowMs);
};

/**
 * 關閉主動消息後，清單裡該留下誰 —— 只留「遠端還活著」的兩類：
 *   1. 取消失敗的（attempted 過但 failed）；
 *   2. 取消期間才出現的（不在 attempted 裡，比如角色剛在聊天裡排的）——壓根沒被取消過，
 *      跟著一起清掉就又是遠端照發、面板看不見的幽靈任務。
 * 其餘（成功取消的）出清單。
 */
export const keepUncancelledTasks = (
  tasks: ActiveMsg2TaskRecord[],
  attemptedUuids: Set<string>,
  failedUuids: Set<string>,
  notes: { failed: string; appeared: string },
): ActiveMsg2TaskRecord[] =>
  tasks
    .filter((t) => failedUuids.has(t.taskUuid) || !attemptedUuids.has(t.taskUuid))
    .map((t) => ({
      ...t,
      lastError: failedUuids.has(t.taskUuid) ? notes.failed : notes.appeared,
    }));

/**
 * 過點超過 48h 的一次性任務出清單。
 * 這個 48h 是三條時間線裡最長的一條：排程現狀塊只回看 40h（AMSG2_TASK_LOOKBACK_MS）、
 * 作廢回執台帳留 48h，所以任務一定活到「該不該給回執」判完之後才被清走。
 */
export const pruneStaleTasks = (
  tasks: ActiveMsg2TaskRecord[],
  nowMs: number,
): ActiveMsg2TaskRecord[] =>
  tasks.filter((t) => {
    if (t.recurrenceType !== 'none') return true;
    const fireAt = new Date(t.firstSendTime).getTime();
    return !Number.isFinite(fireAt) || fireAt > nowMs - 48 * 3600_000;
  });
