// ─── 定時任務細帳（Worker 的 GET /tick-report）───
//
// 體檢裡「定時任務」那一行，光靠 /debug 只拿得到兩個數：幾條到點沒發、最老的晚了多久。
// 同樣是晚了四十分鐘，背後可能是：
//
//   - 在等第三次重試，失敗原因明明白白記在任務行上；
//   - 每次一開跑就被 Cloudflare 掐掉，什麼都沒來得及記；
//   - 同一個角色另一條任務正在發，這條在排隊；
//   - 每分鐘那一跳一開頭就掛了，一條都沒碰到。
//
// 這幾種該做的事完全不同，所以細帳要把「現在算哪種」判出來，連同報錯原文一起交給前端。
//
// 這份文件是 Worker 和前端共用的那一半：回執的形狀，和「一條過期任務現在算哪種情況」的
// 判定（純函數，測試釘在 amsgTickReport.test.ts）。讀庫、解密、記整輪報錯那一半在
// worker/amsg/src/tickReport.ts。

/** 最老那條到點多久還沒人處理，就算定時任務卡住了。cron 一分鐘一跳，留足餘量。 */
export const TICK_STALL_MS = 5 * 60_000;

/**
 * 「這次開跑」比「可以開跑」晚了這麼久，就說明中間那段時間沒被正常處理過
 * （之前開跑過又沒了下文，或者那幾跳根本沒來）。cron 一分鐘一跳，留兩跳餘量再加一分鐘。
 */
export const LATE_START_MS = 3 * 60_000;

/**
 * 上游收尾時 last_error.at 和行的 updated_at 是前後腳寫的，差幾毫秒到幾秒。
 * 在這個範圍內的兩個時刻算同一件事，不能把「記失敗那一筆」誤認成「後來又開跑了一次」。
 */
const SAME_WRITE_TOLERANCE_MS = 5_000;

/** 整輪報錯多久沒再出現，就當那一串已經停了。cron 一分鐘一跳，隔兩跳沒再報就算停。 */
export const TICK_FAILURE_SERIES_GAP_MS = 3 * 60_000;

// ─── 判定 ───

/** 判定一條過期任務要用到的事實，全是任務行上的明文列（時刻一律 epoch 毫秒）。 */
export interface TickTaskFacts {
  nextSendAtMs: number;
  createdAtMs: number | null;
  updatedAtMs: number | null;
  retryAfterMs: number | null;
  leaseUntilMs: number | null;
  /**
   * 這一次到點留下的失敗記錄是什麼時候寫的。只認 occurrence 對得上 next_send_at 的那條：
   * 循環任務上一次到點的舊帳不算這一次的事。
   */
  currentErrorAtMs: number | null;
  /** 串行分組鍵（同一個角色的聊天任務一組，見 worker 的 amsgSerializeKey）。解不開任務內容時為 null。 */
  serializeKey: string | null;
}

/**
 * 這條任務此刻在幹什麼。
 *
 * - `sending`：正在發（租約還沒到期）。
 * - `retry-wait`：失敗過，在等下一次重試。
 * - `ready`：隨時可以開跑，等著下一跳來領。
 */
export type TickTaskState = 'sending' | 'retry-wait' | 'ready';

export interface TickTaskVerdict {
  state: TickTaskState;
  /** 最近一次開跑的時刻（晚於最後一條失敗記錄的那次）。這次到點還沒開跑過為 null。 */
  lastStartedAtMs: number | null;
  /** 開跑過，沒發完，也沒留下失敗原因。多半是跑到一半被平台掐掉了。 */
  unfinishedAttempt: boolean;
  /** 正在發，但這次開跑比「可以開跑」晚了好幾跳：前面那段時間沒被正常處理。 */
  lateStart: boolean;
  /** 同一個角色另一條任務正在發，這條在排隊。 */
  queuedBehind: boolean;
  /** 真卡住了：一直沒人來領，或者領了又沒了下文。 */
  stuck: boolean;
}

/**
 * 給一批過期任務逐條判定現在算哪種情況。
 *
 * 要整批一起判，是因為「排隊」只有放在一起才看得出來：同一個角色同時只跑一條，另一條
 * 正在發的話，這條等多久都是正常的，不能報成卡住。
 *
 * 判定只看行上的明文列，不看 last_error 的措辭。關鍵的幾個事實：
 *
 * - `next_send_at` 在重試期間一直是名義時刻，**不會**被推後，所以「晚了多久」不能直接當
 *   「卡了多久」用；可以開跑的時刻要取它和 `retry_after` 裡更晚的那個。
 * - 開跑（佔位）會刷新 `updated_at`，續租不會。所以 `updated_at` 晚於創建時刻、到點時刻和
 *   最後一條失敗記錄，就說明那之後又開跑過一次。
 * - 正常收尾一定會寫庫：發完刪行或推進排期，失敗寫 `last_error` 並放掉租約。租約自己
 *   到期、行上卻什麼都沒留下，只能是開跑的那個進程半路沒了。
 */
export const classifyOverdueTasks = (tasks: TickTaskFacts[], nowMs: number): TickTaskVerdict[] => {
  const verdicts = tasks.map((task): TickTaskVerdict & { readySinceMs: number } => {
    const state: TickTaskState = task.leaseUntilMs !== null && task.leaseUntilMs > nowMs
      ? 'sending'
      : task.retryAfterMs !== null && task.retryAfterMs > nowMs
        ? 'retry-wait'
        : 'ready';

    const readySinceMs = Math.max(task.nextSendAtMs, task.retryAfterMs ?? -Infinity);
    const lastSettledMs = Math.max(
      task.nextSendAtMs,
      (task.createdAtMs ?? -Infinity) + SAME_WRITE_TOLERANCE_MS,
      (task.currentErrorAtMs ?? -Infinity) + SAME_WRITE_TOLERANCE_MS,
    );
    const lastStartedAtMs = task.updatedAtMs !== null && task.updatedAtMs > lastSettledMs
      ? task.updatedAtMs
      : null;

    const unfinishedAttempt = state === 'ready' && lastStartedAtMs !== null;
    const lateStart = state === 'sending'
      && lastStartedAtMs !== null
      && lastStartedAtMs - readySinceMs > LATE_START_MS;
    const waitedTooLong = state === 'ready' && nowMs - readySinceMs >= TICK_STALL_MS;

    return {
      state,
      readySinceMs,
      lastStartedAtMs,
      unfinishedAttempt,
      lateStart,
      queuedBehind: false,
      stuck: unfinishedAttempt || waitedTooLong,
    };
  });

  return verdicts.map(({ readySinceMs: _readySinceMs, ...verdict }, index) => {
    // 半路沒了的那種不算排隊：它自己就開跑過，等的不是別人。
    if (verdict.state !== 'ready' || verdict.unfinishedAttempt) return verdict;
    const key = tasks[index].serializeKey;
    if (!key) return verdict;
    const blocked = verdicts.some((other, otherIndex) =>
      otherIndex !== index && other.state === 'sending' && tasks[otherIndex].serializeKey === key);
    return blocked ? { ...verdict, queuedBehind: true, stuck: false } : verdict;
  });
};

/**
 * 整批任務合起來，定時任務這一項算什麼狀態。
 *
 * - `stalled`：有任務卡住了（沒人領 / 領了沒下文）。
 * - `failing`：沒卡住，但有任務在失敗重試，或者這次開跑晚得不正常。
 * - `healthy`：都在正常處理（正在發、剛到點等下一跳、排隊）。
 */
export const judgeOverdueTasks = (
  tasks: { verdict: TickTaskVerdict; hasCurrentError: boolean }[],
): 'stalled' | 'failing' | 'healthy' => {
  if (tasks.some((task) => task.verdict.stuck)) return 'stalled';
  if (tasks.some((task) => task.hasCurrentError || task.verdict.lateStart)) return 'failing';
  return 'healthy';
};

// ─── 回執形狀 ───

/** 任務行上 last_error 的內容（上游寫的，reason 已脫敏、最長 500 字）。 */
export interface AmsgTaskErrorRecord {
  /** 這條記錄寫下的時刻（ISO）。 */
  at: string | null;
  /** 記的是哪一次到點（ISO）。 */
  occurrence: string | null;
  /** 報錯原文（脫敏後）。過期跳過時是字面量 `stale`。 */
  reason: string;
  /** 底層錯誤的穩定 code，如 `LLM_CALL_FAILED`。 */
  errorCode: string | null;
  /** 推送服務回的 HTTP 狀態碼。 */
  pushStatus: number | null;
}

/** 一條到點還沒發出去的任務。 */
export interface AmsgTickReportTask {
  uuid: string;
  /** 解不開任務內容（主密鑰不對之類）時為 null，下同。 */
  charId: string | null;
  contactName: string | null;
  /** 後台任務的種類（metadata.amsgKind）；聊天任務為 null。 */
  kind: string | null;
  /** `instant` = 即時對話的回覆，其餘是定時 / 主動消息。 */
  messageType: string | null;
  nextSendAt: string;
  state: TickTaskState;
  stuck: boolean;
  retryCount: number;
  retryAfter: string | null;
  lastStartedAt: string | null;
  unfinishedAttempt: boolean;
  lateStart: boolean;
  queuedBehind: boolean;
  /** 這一次到點留下的失敗記錄；還沒失敗過為 null。 */
  lastError: AmsgTaskErrorRecord | null;
}

/** 最近徹底沒發出去的一次（一次性任務標成失敗，或循環任務跳過了這一次）。 */
export interface AmsgTickReportFailure {
  uuid: string;
  charId: string | null;
  contactName: string | null;
  kind: string | null;
  messageType: string | null;
  /** `failed` = 一次性任務不會再發了；`skipped` = 循環任務跳過這一次，下次照常。 */
  outcome: 'failed' | 'skipped';
  error: AmsgTaskErrorRecord;
}

/**
 * 每分鐘那一跳自己出的錯（不落在任何一條任務上的那種）。
 *
 * 連著出現的同一種錯合併成一串，只記第一次、最後一次和次數——每分鐘掛一次的話，
 * 用戶要知道的是「從幾點開始一直在掛」，不是一千四百條一樣的記錄。
 */
export interface AmsgTickFailureRecord {
  /**
   * 掛在哪一步：`config` 讀配置、`tick` 整輪處理；任務寫庫失敗時是上游的收尾狀態
   * （`claim_failed` / `retry_update_failed` / `stale_update_failed` / `post_send_cleanup_failed…`）。
   */
  stage: string;
  name: string;
  /** 報錯原文（上游同一套脫敏，最長 500 字）。 */
  message: string;
  code: string | null;
  firstAt: string;
  lastAt: string;
  count: number;
  /** 最後一次離現在不到兩跳：多半還在掛。 */
  ongoing: boolean;
}

export interface AmsgTickReport {
  now: string;
  /** 到點還沒發出去的任務，按該發的時刻從早到晚。 */
  tasks: AmsgTickReportTask[];
  /** 最近 24 小時徹底沒發出去的，最近的在前。即時對話的不在這裡（聊天界面自己會說）。 */
  recentFailures: AmsgTickReportFailure[];
  tickFailure: AmsgTickFailureRecord | null;
  /** 過期任務太多、沒列全。 */
  truncated: boolean;
}

// ─── 前端認回執 ───

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const finiteOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const parseErrorRecord = (raw: unknown): AmsgTaskErrorRecord | null => {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const reason = str(value.reason);
  if (!reason) return null;
  return {
    at: str(value.at),
    occurrence: str(value.occurrence),
    reason,
    errorCode: str(value.errorCode),
    pushStatus: finiteOrNull(value.pushStatus),
  };
};

const TASK_STATES: TickTaskState[] = ['sending', 'retry-wait', 'ready'];

/**
 * 認一份 GET /tick-report 回執，形狀對不上返回 null。
 *
 * 單條任務形狀不對就跳過那一條，不整份作廢：列表裡有一條讀不懂，不該連帶把
 * 整輪報錯那段原文也吞掉——那恰恰是用戶最需要的。
 */
export const parseAmsgTickReport = (body: unknown): AmsgTickReport | null => {
  const data = (body as { success?: unknown; data?: Record<string, unknown> } | null)?.data;
  if (!data || typeof data !== 'object') return null;
  if (!Array.isArray(data.tasks) || !Array.isArray(data.recentFailures)) return null;

  const tasks = data.tasks.flatMap((raw): AmsgTickReportTask[] => {
    const value = raw as Record<string, unknown> | null;
    const uuid = str(value?.uuid);
    const nextSendAt = str(value?.nextSendAt);
    const state = value?.state as TickTaskState;
    if (!value || !uuid || !nextSendAt || !TASK_STATES.includes(state)) return [];
    return [{
      uuid,
      charId: str(value.charId),
      contactName: str(value.contactName),
      kind: str(value.kind),
      messageType: str(value.messageType),
      nextSendAt,
      state,
      stuck: value.stuck === true,
      retryCount: finiteOrNull(value.retryCount) ?? 0,
      retryAfter: str(value.retryAfter),
      lastStartedAt: str(value.lastStartedAt),
      unfinishedAttempt: value.unfinishedAttempt === true,
      lateStart: value.lateStart === true,
      queuedBehind: value.queuedBehind === true,
      lastError: parseErrorRecord(value.lastError),
    }];
  });

  const recentFailures = data.recentFailures.flatMap((raw): AmsgTickReportFailure[] => {
    const value = raw as Record<string, unknown> | null;
    const uuid = str(value?.uuid);
    const error = parseErrorRecord(value?.error);
    const outcome = value?.outcome;
    if (!value || !uuid || !error || (outcome !== 'failed' && outcome !== 'skipped')) return [];
    return [{
      uuid,
      charId: str(value.charId),
      contactName: str(value.contactName),
      kind: str(value.kind),
      messageType: str(value.messageType),
      outcome,
      error,
    }];
  });

  const rawFailure = data.tickFailure as Record<string, unknown> | null | undefined;
  const tickFailure: AmsgTickFailureRecord | null = rawFailure
    && str(rawFailure.stage) && str(rawFailure.message) && str(rawFailure.firstAt) && str(rawFailure.lastAt)
    ? {
      stage: rawFailure.stage as string,
      name: str(rawFailure.name) || 'Error',
      message: rawFailure.message as string,
      code: str(rawFailure.code),
      firstAt: rawFailure.firstAt as string,
      lastAt: rawFailure.lastAt as string,
      count: finiteOrNull(rawFailure.count) ?? 1,
      ongoing: rawFailure.ongoing === true,
    }
    : null;

  return {
    now: str(data.now) || new Date().toISOString(),
    tasks,
    recentFailures,
    tickFailure,
    truncated: data.truncated === true,
  };
};
