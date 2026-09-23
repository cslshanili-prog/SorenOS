/**
 * 定時任務細帳：到點沒發出去的任務各自卡在哪一步、報了什麼錯，以及每分鐘那一跳自己
 * 出過什麼錯。給體檢面板「定時任務」那一行用（GET /tick-report，要共享密鑰）。
 *
 * 回執形狀和「一條過期任務算哪種情況」的判定在 utils/amsgTickReport.ts（前端共用）；
 * 這裡只管讀庫、解密出是哪個角色的任務，以及把整輪報錯記進庫裡。
 *
 * **整輪報錯為什麼要自己記**：上游 scheduled() 掛了只會把原因當返回值交出來、再打一行
 * 日誌，庫裡什麼都不留。而「每一跳一開頭就掛」恰恰是任務行上一點痕跡都沒有的那種壞法
 * ——任務行只記得「我還沒發」，說不出為什麼。不記進庫的話，這句原話只在 Cloudflare 的
 * 日誌裡，大多數人根本不知道那個入口在哪。
 *
 * 只在出錯時寫一筆，正常的那一跳什麼都不寫：心跳式的「每分鐘記一次」會讓 D1 的寫入
 * 次數平白多出一天一千四百多筆，而用戶關心的只是出錯的那幾次。
 */

import {
  decryptFromStorage,
  deriveUserEncryptionKey,
  summarizeErrorCause,
} from '@rei-standard/amsg-server/cloudflare';
import {
  classifyOverdueTasks,
  judgeOverdueTasks,
  TICK_FAILURE_SERIES_GAP_MS,
  type AmsgTaskErrorRecord,
  type AmsgTickFailureRecord,
  type AmsgTickReport,
  type AmsgTickReportFailure,
  type AmsgTickReportTask,
  type TickTaskFacts,
} from '../../../utils/amsgTickReport';
import { readTaskKind } from '../../../utils/amsgTaskKinds';

export type TickReportDb = {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T = unknown>(): Promise<T | null>;
      all<T = unknown>(): Promise<{ results?: T[] }>;
      run(): Promise<unknown>;
    };
    first<T = unknown>(): Promise<T | null>;
    all<T = unknown>(): Promise<{ results?: T[] }>;
    run(): Promise<unknown>;
  };
};

/** 同一個角色的任務歸一組（跟 worker 配給上游的 serializeBy 是同一個函數）。 */
export type SerializeKeyOf = (task: { metadata?: Record<string, unknown> | null }) => string | null;

/** 一次最多列多少條過期任務。單用戶手上正常不會有這麼多，多了說明整個都停了，列前面這些就夠看。 */
const MAX_OVERDUE_TASKS = 50;
/** 最近失敗列多少條、往回看多久。 */
const MAX_RECENT_FAILURES = 10;
const RECENT_FAILURE_WINDOW_MS = 24 * 60 * 60_000;

/** 讀過期任務要用的列。retry_after / lease_until / last_error 是後加的列，老庫沒有的話這條查詢會掛。 */
const TASK_COLUMNS = `uuid, user_id, encrypted_payload, message_type, status, next_send_at,
       retry_count, retry_after, lease_until, created_at, updated_at, last_error`;

interface TaskRow {
  uuid: string | null;
  user_id: string | null;
  encrypted_payload: string | null;
  message_type: string | null;
  status: string | null;
  next_send_at: string | null;
  retry_count: number | null;
  retry_after: string | null;
  lease_until: string | null;
  created_at: string | null;
  updated_at: string | null;
  last_error: string | null;
}

const parseMs = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

const toIso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** 任務行上的 last_error。存的應該是 JSON；萬一不是，整段當原文，不丟。 */
const parseLastError = (raw: string | null): AmsgTaskErrorRecord | null => {
  if (!raw) return null;
  let value: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(raw);
    value = parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return { at: null, occurrence: null, reason: raw, errorCode: null, pushStatus: null };
  }
  if (!value) return null;
  const pick = (key: string) => (typeof value?.[key] === 'string' && value[key] ? (value[key] as string) : null);
  const pushStatus = Number(value.pushStatus);
  return {
    at: pick('at'),
    occurrence: pick('occurrence'),
    reason: pick('reason') || '',
    errorCode: pick('errorCode'),
    pushStatus: Number.isFinite(pushStatus) && pushStatus > 0 ? pushStatus : null,
  };
};

/** 這條失敗記錄是不是記的「這一次到點」。循環任務上一次的舊帳不算。 */
const isCurrentOccurrence = (error: AmsgTaskErrorRecord, nextSendAtMs: number): boolean => {
  const occurrenceMs = parseMs(error.occurrence);
  if (occurrenceMs !== null) return occurrenceMs === nextSendAtMs;
  const atMs = parseMs(error.at);
  return atMs !== null && atMs >= nextSendAtMs;
};

interface TaskIdentity {
  charId: string | null;
  contactName: string | null;
  kind: string | null;
  serializeKey: string | null;
}

/**
 * 解開任務內容，認出是哪個角色的。解不開（主密鑰換過、內容壞了）就全是 null——
 * 細帳照樣出，只是說不出名字；這時候更要緊的是讓人看到後面那段報錯。
 */
const createIdentityReader = (masterKey: string | undefined, serializeKeyOf: SerializeKeyOf) => {
  const userKeys = new Map<string, Promise<string>>();
  return async (row: TaskRow): Promise<TaskIdentity> => {
    const unknown: TaskIdentity = { charId: null, contactName: null, kind: null, serializeKey: null };
    if (!masterKey || !row.user_id || !row.encrypted_payload) return unknown;
    try {
      let userKey = userKeys.get(row.user_id);
      if (!userKey) {
        userKey = deriveUserEncryptionKey(row.user_id, masterKey);
        userKeys.set(row.user_id, userKey);
      }
      const payload = JSON.parse(await decryptFromStorage(row.encrypted_payload, await userKey)) as {
        contactName?: unknown;
        metadata?: Record<string, unknown> | null;
      };
      const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : null;
      return {
        charId: typeof metadata?.charId === 'string' ? metadata.charId : null,
        contactName: typeof payload.contactName === 'string' && payload.contactName ? payload.contactName : null,
        kind: readTaskKind(metadata),
        serializeKey: serializeKeyOf({ metadata }),
      };
    } catch {
      return unknown;
    }
  };
};

export interface OverdueTasksResult {
  tasks: AmsgTickReportTask[];
  truncated: boolean;
  /** 合起來算什麼狀態（見 judgeOverdueTasks）。沒有過期任務時是 healthy。 */
  verdict: 'stalled' | 'failing' | 'healthy';
}

/**
 * 讀出所有到點還沒發出去的任務，逐條判定現在算哪種情況。
 *
 * 查詢本身掛了（老庫還沒有 retry_after 這些列）會原樣拋出去，由調用方決定怎麼退：
 * 體檢退回只看「最老那條晚了多久」，細帳端點照實報錯。
 */
export const readOverdueTasks = async (
  db: TickReportDb,
  options: { masterKey?: string; serializeKeyOf: SerializeKeyOf; nowMs?: number },
): Promise<OverdueTasksResult> => {
  const nowMs = options.nowMs ?? Date.now();
  const rows = (await db
    .prepare(
      `SELECT ${TASK_COLUMNS}
         FROM scheduled_messages
        WHERE status = 'pending' AND next_send_at <= ?
        ORDER BY next_send_at ASC
        LIMIT ?`,
    )
    .bind(new Date(nowMs).toISOString(), MAX_OVERDUE_TASKS + 1)
    .all<TaskRow>()).results || [];

  const truncated = rows.length > MAX_OVERDUE_TASKS;
  const readIdentity = createIdentityReader(options.masterKey, options.serializeKeyOf);

  const prepared = (await Promise.all(rows.slice(0, MAX_OVERDUE_TASKS).map(async (row) => {
    const nextSendAtMs = parseMs(row.next_send_at);
    if (!row.uuid || nextSendAtMs === null) return null;
    const lastError = parseLastError(row.last_error);
    const currentError = lastError && isCurrentOccurrence(lastError, nextSendAtMs) ? lastError : null;
    const identity = await readIdentity(row);
    const facts: TickTaskFacts = {
      nextSendAtMs,
      createdAtMs: parseMs(row.created_at),
      updatedAtMs: parseMs(row.updated_at),
      retryAfterMs: parseMs(row.retry_after),
      leaseUntilMs: parseMs(row.lease_until),
      currentErrorAtMs: currentError ? parseMs(currentError.at) : null,
      serializeKey: identity.serializeKey,
    };
    return { row: { ...row, uuid: row.uuid }, nextSendAtMs, currentError, identity, facts };
  }))).filter((item): item is NonNullable<typeof item> => item !== null);

  const verdicts = classifyOverdueTasks(prepared.map((item) => item.facts), nowMs);

  const tasks = prepared.map(({ row, nextSendAtMs, currentError, identity, facts }, index): AmsgTickReportTask => {
    const verdict = verdicts[index];
    return {
      uuid: row.uuid,
      charId: identity.charId,
      contactName: identity.contactName,
      kind: identity.kind,
      messageType: row.message_type,
      nextSendAt: new Date(nextSendAtMs).toISOString(),
      state: verdict.state,
      stuck: verdict.stuck,
      retryCount: Number(row.retry_count) || 0,
      retryAfter: toIso(facts.retryAfterMs),
      lastStartedAt: toIso(verdict.lastStartedAtMs),
      unfinishedAttempt: verdict.unfinishedAttempt,
      lateStart: verdict.lateStart,
      queuedBehind: verdict.queuedBehind,
      lastError: currentError,
    };
  });

  return {
    tasks,
    truncated,
    verdict: judgeOverdueTasks(tasks.map((task, index) => ({
      verdict: verdicts[index],
      hasCurrentError: task.lastError !== null,
    }))),
  };
};

/**
 * 最近 24 小時徹底沒發出去的：一次性任務標成了失敗，或者循環任務跳過了這一次
 * （行還是 pending，排期已經推到以後，失敗記錄留在行上）。
 *
 * 即時對話的不列：它失敗時聊天界面自己會說，放在這裡是重複的噪音。
 */
export const readRecentFailures = async (
  db: TickReportDb,
  options: { masterKey?: string; serializeKeyOf: SerializeKeyOf; nowMs?: number },
): Promise<AmsgTickReportFailure[]> => {
  const nowMs = options.nowMs ?? Date.now();
  const sinceMs = nowMs - RECENT_FAILURE_WINDOW_MS;
  const rows = (await db
    .prepare(
      `SELECT ${TASK_COLUMNS}
         FROM scheduled_messages
        WHERE last_error IS NOT NULL
          AND updated_at >= ?
          AND message_type != 'instant'
          AND (status = 'failed' OR (status = 'pending' AND next_send_at > ?))
        ORDER BY updated_at DESC
        LIMIT ?`,
    )
    .bind(new Date(sinceMs).toISOString(), new Date(nowMs).toISOString(), MAX_RECENT_FAILURES)
    .all<TaskRow>()).results || [];

  const readIdentity = createIdentityReader(options.masterKey, options.serializeKeyOf);
  const failures = await Promise.all(rows.map(async (row): Promise<AmsgTickReportFailure | null> => {
    const error = parseLastError(row.last_error);
    const atMs = parseMs(error?.at);
    // updated_at 會被後來的開跑刷新，真正「什麼時候失敗的」看記錄自己的時刻。
    if (!row.uuid || !error || atMs === null || atMs < sinceMs) return null;
    const identity = await readIdentity(row);
    return {
      uuid: row.uuid,
      charId: identity.charId,
      contactName: identity.contactName,
      kind: identity.kind,
      messageType: row.message_type,
      outcome: row.status === 'failed' ? 'failed' : 'skipped',
      error,
    };
  }));
  return failures.filter((item): item is AmsgTickReportFailure => item !== null);
};

// ─── 整輪報錯 ───

/** worker 自己的診斷表：一行一個鍵，值是 JSON。跟上游的表分開，上游的 schema 自查不管它。 */
const DIAGNOSTICS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS worker_diagnostics (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`;
const TICK_FAILURE_KEY = 'tick_failure';

/**
 * 上游收尾時寫庫失敗的那幾種狀態（見上游 run-tick 的 failedTasks）。這幾種不會在任務行上
 * 留下任何痕跡——要寫的那一筆本身就沒寫進去——所以只能記在這裡。
 * `post_send_cleanup_failed_marked_sent` / `…_rescheduled` 是補救成功了的，不算。
 */
const TASK_WRITE_FAILURE_STATUSES = new Set([
  'claim_failed',
  'retry_update_failed',
  'stale_update_failed',
  'post_send_cleanup_failed',
]);

type StoredTickFailure = Omit<AmsgTickFailureRecord, 'ongoing'>;

/** 從上游 scheduled() 的返回值裡認出這一跳要記的那個錯。沒出錯返回 null。 */
export const pickTickFailure = (outcome: unknown): Pick<StoredTickFailure, 'stage' | 'name' | 'message' | 'code'> | null => {
  const value = outcome as {
    ok?: unknown;
    cause?: { stage?: unknown; name?: unknown; message?: unknown; code?: unknown };
    summary?: { details?: { failedTasks?: unknown } };
  } | null;
  if (!value || typeof value !== 'object') return null;

  if (value.ok === false) {
    const cause = value.cause;
    return {
      stage: typeof cause?.stage === 'string' && cause.stage ? cause.stage : 'tick',
      name: typeof cause?.name === 'string' && cause.name ? cause.name : 'Error',
      message: typeof cause?.message === 'string' ? cause.message : '',
      code: typeof cause?.code === 'string' && cause.code ? cause.code : null,
    };
  }

  const failedTasks = value.summary?.details?.failedTasks;
  if (!Array.isArray(failedTasks)) return null;
  const hit = failedTasks.find((entry) => TASK_WRITE_FAILURE_STATUSES.has(entry?.status)) as
    | { status: string; reason?: unknown; updateError?: unknown }
    | undefined;
  if (!hit) return null;

  const reason = typeof hit.reason === 'string' ? hit.reason : '';
  const updateError = typeof hit.updateError === 'string' ? hit.updateError : '';
  // 記失敗原因那一筆沒寫進去時，丟的是兩樣東西：寫庫的錯，和本來要記下的那個失敗原因。
  // 兩樣都留著，後者正是用戶想知道的「為什麼沒發出去」。
  const rawMessage = updateError
    ? `${updateError}（本來要記下的失敗原因：${reason || '無'}）`
    : reason;
  // 上游給 failedTasks 的 reason 是沒脫敏的原話，這裡過一遍跟整輪報錯同一套打碼。
  const cause = summarizeErrorCause({ name: 'TaskWriteFailed', message: rawMessage }, 'tick');
  return { stage: hit.status, name: cause.name, message: cause.message ?? '', code: null };
};

/**
 * 把這一跳的報錯記進庫。同一種錯連著出現就併成一串（只更新最後一次和次數）。
 *
 * best-effort：庫本身掛了的時候這一筆多半也寫不進去，那也只能認——不能讓記帳的錯
 * 反過來蓋掉 scheduled() 的正常收尾。
 */
export const recordTickOutcome = async (db: TickReportDb | undefined, outcome: unknown, nowMs = Date.now()): Promise<void> => {
  const failure = pickTickFailure(outcome);
  if (!failure || typeof db?.prepare !== 'function') return;
  try {
    await db.prepare(DIAGNOSTICS_TABLE_SQL).run();
    const existing = await db
      .prepare('SELECT value FROM worker_diagnostics WHERE key = ?')
      .bind(TICK_FAILURE_KEY)
      .first<{ value: string }>();
    const previous = parseStoredTickFailure(existing?.value);
    const sameSeries = previous
      && previous.stage === failure.stage
      && previous.name === failure.name
      && nowMs - Date.parse(previous.lastAt) <= TICK_FAILURE_SERIES_GAP_MS;
    const nowIso = new Date(nowMs).toISOString();
    const record: StoredTickFailure = {
      ...failure,
      firstAt: sameSeries ? previous.firstAt : nowIso,
      lastAt: nowIso,
      count: sameSeries ? previous.count + 1 : 1,
    };
    await db
      .prepare(
        `INSERT INTO worker_diagnostics (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(TICK_FAILURE_KEY, JSON.stringify(record), nowMs)
      .run();
  } catch (error) {
    console.warn('[amsg:tick-report] 這一跳的報錯沒記進庫', error);
  }
};

const parseStoredTickFailure = (raw: string | null | undefined): StoredTickFailure | null => {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredTickFailure> | null;
    if (!value || typeof value.stage !== 'string' || typeof value.firstAt !== 'string' || typeof value.lastAt !== 'string') {
      return null;
    }
    return {
      stage: value.stage,
      name: typeof value.name === 'string' ? value.name : 'Error',
      message: typeof value.message === 'string' ? value.message : '',
      code: typeof value.code === 'string' ? value.code : null,
      firstAt: value.firstAt,
      lastAt: value.lastAt,
      count: Number(value.count) || 1,
    };
  } catch {
    return null;
  }
};

/** 讀最近一次整輪報錯。表還沒建（從沒出過錯）或讀不了都當沒有。 */
export const readTickFailure = async (db: TickReportDb, nowMs = Date.now()): Promise<AmsgTickFailureRecord | null> => {
  try {
    const row = await db
      .prepare('SELECT value FROM worker_diagnostics WHERE key = ?')
      .bind(TICK_FAILURE_KEY)
      .first<{ value: string }>();
    const record = parseStoredTickFailure(row?.value);
    if (!record) return null;
    return { ...record, ongoing: nowMs - Date.parse(record.lastAt) <= TICK_FAILURE_SERIES_GAP_MS };
  } catch {
    return null;
  }
};

/** GET /tick-report 的完整回執。 */
export const buildTickReport = async (
  db: TickReportDb,
  options: { masterKey?: string; serializeKeyOf: SerializeKeyOf; nowMs?: number },
): Promise<AmsgTickReport> => {
  const nowMs = options.nowMs ?? Date.now();
  const scoped = { ...options, nowMs };
  const [overdue, recentFailures, tickFailure] = await Promise.all([
    readOverdueTasks(db, scoped),
    readRecentFailures(db, scoped),
    readTickFailure(db, nowMs),
  ]);
  return {
    now: new Date(nowMs).toISOString(),
    tasks: overdue.tasks,
    recentFailures,
    tickFailure,
    truncated: overdue.truncated,
  };
};
