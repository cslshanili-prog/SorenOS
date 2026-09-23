// utils/amsg2ExpireGuard.ts
/**
 * amsg2 防穿幫閘 — 純判定邏輯。
 *
 * ⚠️ 葉子模塊：會被 worker/amsg 打進 Cloudflare bundle，同時被客戶端送達兜底
 * （activeMsgRuntime）與排程現狀塊（amsg2TaskContext）複用——不得 import
 * 瀏覽器 / DB / React 依賴（與 utils/agenticTools.ts 同一約束）。
 *
 * 語義（設計：claude-notes/2026-07-21-amsg2-liveness-design.md「防穿幫閘」）：
 *   - expire（默認）：到點那會兒用戶正在聊天 → 作廢，轉「排程現狀塊」告知；
 *   - force：鬧鐘型，照發。
 *
 * 這道閘只判一件確定的事：**到點前後 ACTIVE_CHAT_WINDOW_MS 內，用戶在不在聊天**。
 * 一次性任務和循環任務同一條規則，窗口都錨在觸發時刻，兩邊都錨——左右界都是觸發時刻
 * 加減這個窗寬，跟排程現狀塊的檢出（detectExpiredOccurrences）用的是同一個對稱窗。
 *
 * 「這件事是不是已經聊過了」不歸它管——那是語義問題，判據在角色自己手上（提示詞裡
 * 那段「開口之前」：已經發生過的事就一個字都不要輸出，走 worker 的 skip-push 出口）。
 * 早先這裡對一次性任務用的是錨點規則「排完任務之後用戶只要再開過一次口就作廢」，
 * 它沒有時間窗，跨夜任務幾乎必然中招：角色半夜說「明早九點半叫你起床」，用戶回一句
 * 「晚安」，第二天的早安就被判死。錨在觸發時刻的窗口沒有這個毛病，任務排了多久都不影響。
 */

export type AmsgExpirePolicy = 'expire' | 'force';

/** 「正在聊天」窗口：觸發時刻前後 10 分鐘內有真實用戶消息就算熱聊。 */
export const ACTIVE_CHAT_WINDOW_MS = 10 * 60_000;

/** 觸發時刻附近的推理/送達寬限（fire 後 10-30s 才送達，判定窗口向後放這麼多）。 */
export const FIRE_GRACE_MS = 90_000;

/** 排程現狀塊只回看這麼久內的觸發時刻，太老的不再提。 */
const DEFAULT_LOOKBACK_MS = 48 * 3600_000;

const DAY_MS = 24 * 3600_000;

/** 循環任務兩次觸發之間隔多久；一次性任務沒有周期，返回 null。 */
export const recurrencePeriodMs = (recurrenceType: string | undefined): number | null =>
  recurrenceType === 'daily' ? DAY_MS
    : recurrenceType === 'weekly' ? 7 * DAY_MS
      : null;

export interface ExpireFireInput {
  policy: string | undefined;
  /** 判定時刻已知的最後一條真實用戶消息時間戳。 */
  lastUserMessageAt: number | null | undefined;
  nowMs: number;
  /**
   * 本次觸發時刻。「正在聊天」窗口錨定它而不是 nowMs——生成+送達可能比到點晚十幾分鍾，
   * 拿判定時刻算 10 分鐘窗會把撞上對話的消息誤放行。worker 在到點當時判定（兩者幾乎
   * 相等），客戶端送達兜底則晚得多，所以必須顯式給。
   */
  occurrenceMs: number | null | undefined;
}

/**
 * fire 時刻該不該作廢這次觸發。worker onBeforeFire（數據來自 fire_pack /
 * task metadata）與客戶端送達兜底（數據來自本地歷史 / push metadata）共用，
 * 一次性和循環任務同一條規則：到點前後十分鐘內用戶在不在聊天。
 *
 * 判不了（缺策略 / 缺觸發時刻 / 一條用戶消息都沒有）一律放行——這道閘只擋它能確定的
 * 那一檔，剩下的交給角色自己在提示詞裡判（見文件頭）。
 */
export function shouldExpireFire(input: ExpireFireInput): boolean {
  if (input.policy !== 'expire') return false;
  // 缺觸發時刻就算不出窗口，放行。客戶端送達兜底閘會碰上（老版本 SW 落的收件箱行
  // 沒有這個頂層字段）；worker 側走不到，occurrenceMs 由 onBeforeFire 校驗過。
  if (input.occurrenceMs == null) return false;
  const last = input.lastUserMessageAt;
  if (last == null) return false;
  // 兩邊都錨在觸發時刻，跟 detectExpiredOccurrences 的對稱窗同一個口徑。
  // 右界要是拿 nowMs：worker 在到點當時判（now≈到點）看不出差別，客戶端送達兜底 /
  // 48h 補收卻是 now=Date.now()，窗口會一路撐成 (到點-10min, 現在]——用戶到點之後
  // 隨便哪個時刻開過一次口，晚送到的定時消息就被吞掉、銷帳、連雲端自述日誌一起撤銷，
  // 而檢出那邊用對稱窗根本查不到這次吞沒，作廢回執整段失聯。
  return last > input.occurrenceMs - ACTIVE_CHAT_WINDOW_MS
    && last <= input.occurrenceMs + ACTIVE_CHAT_WINDOW_MS
    // last 是過去的消息時間戳，這條理論上恆真；留著擋時鐘歪掉時冒出來的未來時間戳。
    && last <= input.nowMs;
}

export interface RealUserMessageLike {
  role: string;
  timestamp: number;
  metadata?: Record<string, unknown> | null;
}

/** 「真實用戶消息」定義與 activeMsgClient.buildTimeGapHint 保持一致。 */
const isRealUserMessage = (m: RealUserMessageLike): boolean =>
  m.role === 'user' && !(m.metadata as { proactiveHint?: unknown } | null | undefined)?.proactiveHint;

export function getLastRealUserMessageAt(messages: RealUserMessageLike[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isRealUserMessage(messages[i])) return messages[i].timestamp;
  }
  return null;
}

/** (afterMs, beforeMs] 內是否有真實用戶消息。 */
export function hasRealUserMessageBetween(
  messages: RealUserMessageLike[],
  afterMs: number,
  beforeMs: number,
): boolean {
  return messages.some((m) =>
    isRealUserMessage(m) && m.timestamp > afterMs && m.timestamp <= beforeMs);
}

/** 送達判定的回看窗：觸發時刻之後這麼久內的消息才算這次觸發的產物。 */
const DELIVERED_WINDOW_MS = 30 * 60_000;

/**
 * 某個觸發時刻附近是否真的送達過定時主動消息（區分「作廢了」和「發出去之後
 * 用戶才回復」）。定時任務的落庫消息帶 metadata.activeMsg2.taskId（非空）；
 * instant 聊天回覆的 taskId 是 null，不算。
 *
 * 按精確 id 歸屬：任務的送達一定帶同源 amsgClientTaskId，id 不同或缺 id 的消息都不算
 * 本任務的送達——否則會拿別的任務的送達當證據、誤抹掉本任務的作廢回執。
 */
export function hasDeliveredProactiveNear(
  messages: RealUserMessageLike[],
  occurrenceMs: number,
  clientTaskId: string,
): boolean {
  return messages.some((m) => {
    if (m.role !== 'assistant') return false;
    const meta = m.metadata as { activeMsg2?: { taskId?: unknown }; amsgClientTaskId?: unknown } | null | undefined;
    if (meta?.activeMsg2?.taskId == null) return false;
    if (meta.amsgClientTaskId !== clientTaskId) return false;
    return m.timestamp >= occurrenceMs - FIRE_GRACE_MS && m.timestamp <= occurrenceMs + DELIVERED_WINDOW_MS;
  });
}

export interface ExpiredNoticeCandidate {
  /** 一次性 = taskUuid；循環 = `${taskUuid}:${occurrenceMs}`。 */
  id: string;
  occurrenceMs: number;
}

export interface DetectExpiredInput {
  taskUuid: string;
  policy: string | undefined;
  recurrenceType: string | undefined;
  /** ISO 字符串，任務首次觸發時間。 */
  firstSendTime: string;
  messages: RealUserMessageLike[];
  nowMs: number;
  lookbackMs?: number;
}

/**
 * 排程現狀塊的作廢檢出：回看期內哪些觸發時刻滿足作廢條件。調用方需另用
 * hasDeliveredProactiveNear 排除實際送達過的（這裡不做，方便單測各管一半）。
 */
export function detectExpiredOccurrences(input: DetectExpiredInput): ExpiredNoticeCandidate[] {
  if (input.policy !== 'expire') return [];
  const first = new Date(input.firstSendTime).getTime();
  if (!Number.isFinite(first)) return [];
  const horizon = input.nowMs - (input.lookbackMs ?? DEFAULT_LOOKBACK_MS);

  const periodMs = recurrencePeriodMs(input.recurrenceType);
  if (periodMs === null) {
    if (first > input.nowMs || first < horizon) return [];
    // 跟循環那支同一個對稱窗，因為閘本身已經是同一條規則了（見 shouldExpireFire）。
    // 兩邊必須一致：這裡說「作廢了」而閘其實放行了的話，角色會為一條用戶明明收到的
    // 消息道歉——比不說還糟。
    // 「其實已正常送達」由調用方用 hasDeliveredProactiveNear 按任務歸屬排除。
    if (!hasRealUserMessageBetween(
      input.messages, first - ACTIVE_CHAT_WINDOW_MS, first + ACTIVE_CHAT_WINDOW_MS,
    )) return [];
    return [{ id: input.taskUuid, occurrenceMs: first }];
  }

  // 快進到回看期起點，別從幾個月前逐個迭代。
  let t = first;
  if (t < horizon) t = first + Math.ceil((horizon - first) / periodMs) * periodMs;
  const out: ExpiredNoticeCandidate[] = [];
  for (; t <= input.nowMs; t += periodMs) {
    // 「到點前後都在聊」的對稱窗：覆蓋 fire 略晚於到點的 Cron 延遲場景。
    if (hasRealUserMessageBetween(input.messages, t - ACTIVE_CHAT_WINDOW_MS, t + ACTIVE_CHAT_WINDOW_MS)) {
      out.push({ id: `${input.taskUuid}:${t}`, occurrenceMs: t });
    }
  }
  return out;
}
