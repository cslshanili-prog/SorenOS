/**
 * 主動消息的「頻率與額度」：用戶給每個角色定的上限，以及這些上限怎麼落到代碼裡的閘。
 *
 * 角色在主動消息上有不少自由度——自己給自己排下一條、挑時間、挑要不要每天重複。這份
 * 模塊管的是這些自由的邊界：邊界由用戶定，用戶沒定的用這裡的默認值。每一項都是代碼裡
 * 實打實攔住的硬閘（排程時打回、到點時跳過），提示詞只負責把「還剩多少額度」告訴角色，
 * 讓它在額度內自己挑時機，而不是靠一句勸告去指望它自覺。
 *
 * 上限的原始值住在角色的 activeMsg2Config 上（面板寫），兩邊各自解析成生效值：
 *   - 客戶端：前台工具橋、面板建任務直接讀 config；
 *   - worker：讀客戶端同步上去的 `limits` 記錄（每角色一份，見 buildAmsgLimitsRecord）。
 * 兩邊都過 resolveAmsgLimits，默認值只在這裡定義一次。
 *
 * 零運行時依賴（worker bundle 會打進這份代碼），只有純函數和常量。
 */

import type { ActiveMsg2CharacterConfig } from '../types';

// ─── 默認值 ───

/** 你沒回時，角色最多連發幾條（0 = 不限）。 */
export const DEFAULT_MAX_UNANSWERED_SENDS = 3;
/** 角色自己排的兩條主動消息之間至少隔多少分鐘（0 = 不額外限制）。 */
export const DEFAULT_MIN_SEND_GAP_MINUTES = 10;
/** 每天最多主動發幾次（0 = 不限）。默認不限：這是用戶想管錢包時才去開的那道閘。 */
export const DEFAULT_DAILY_SEND_CAP = 0;
/** 重複的消息連續幾次沒回就先停（0 = 不停）。 */
export const DEFAULT_RECURRING_STOP_AFTER = 3;
/** 同時最多排著幾條（用戶和角色共用這些名額）。 */
export const DEFAULT_MAX_ACTIVE_TASKS = 5;
/** 設置裡能選到的「同時排著幾條」上限。 */
export const MAX_ACTIVE_TASKS_CEILING = 10;

/** 用戶在面板上能調的那幾項（都掛在 ActiveMsg2CharacterConfig 上，沒設 = 用默認值）。 */
export type AmsgPacingSettings = Pick<
  ActiveMsg2CharacterConfig,
  | 'maxUnansweredSends'
  | 'minSendGapMinutes'
  | 'dailySendCap'
  | 'recurringStopAfter'
  | 'maxActiveTasks'
  | 'allowSelfRecurring'
  | 'allowSelfForce'
>;

/** 所有上限字段名，拷貝 / 挑字段時用這一份，別在各處手抄。 */
export const AMSG_PACING_FIELDS = [
  'maxUnansweredSends',
  'minSendGapMinutes',
  'dailySendCap',
  'recurringStopAfter',
  'maxActiveTasks',
  'allowSelfRecurring',
  'allowSelfForce',
] as const satisfies ReadonlyArray<keyof AmsgPacingSettings>;

export const pickPacingSettings = (
  source: Partial<AmsgPacingSettings> | null | undefined,
): AmsgPacingSettings => {
  const out: AmsgPacingSettings = {};
  if (!source) return out;
  for (const field of AMSG_PACING_FIELDS) {
    if (source[field] !== undefined) (out as Record<string, unknown>)[field] = source[field];
  }
  return out;
};

/** 解析後的生效值。「不限」一律是 Infinity，閘裡直接比大小就行。 */
export interface AmsgLimits {
  maxUnansweredSends: number;
  /** 毫秒；0 = 不額外限制（到點的技術下限 1 分鐘另算）。 */
  minSendGapMs: number;
  dailySendCap: number;
  recurringStopAfter: number;
  maxActiveTasks: number;
  allowSelfRecurring: boolean;
  allowSelfForce: boolean;
}

/**
 * 「N 或不限」類的數值：0 = 不限（Infinity），沒設 / 壞值 = 默認，其餘取正整數並封頂。
 * 默認值本身是 0 的那一項（每日上限），沒設時同樣落到不限。
 */
const resolveCount = (value: unknown, fallback: number, ceiling: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback === 0 ? Infinity : fallback;
  }
  if (value === 0) return Infinity;
  if (value < 1) return fallback === 0 ? Infinity : fallback;
  return Math.min(ceiling, Math.floor(value));
};

/** 用戶設置 → 生效上限（連發上限單獨導出，老調用方還在用這一個）。 */
export const resolveMaxUnansweredSends = (value: unknown): number =>
  resolveCount(value, DEFAULT_MAX_UNANSWERED_SENDS, 99);

export const resolveAmsgLimits = (
  settings: Partial<AmsgPacingSettings> | null | undefined,
): AmsgLimits => {
  const s = settings ?? {};
  const gap = s.minSendGapMinutes;
  const gapMinutes = typeof gap === 'number' && Number.isFinite(gap) && gap >= 0
    ? Math.min(24 * 60, Math.floor(gap))
    : DEFAULT_MIN_SEND_GAP_MINUTES;
  const tasks = s.maxActiveTasks;
  return {
    maxUnansweredSends: resolveMaxUnansweredSends(s.maxUnansweredSends),
    minSendGapMs: gapMinutes * 60_000,
    dailySendCap: resolveCount(s.dailySendCap, DEFAULT_DAILY_SEND_CAP, 999),
    recurringStopAfter: resolveCount(s.recurringStopAfter, DEFAULT_RECURRING_STOP_AFTER, 99),
    // 任務名額沒有「不限」這一檔：掛太多等於把「同時有幾件事在後台排隊」這件事交出去了。
    maxActiveTasks: typeof tasks === 'number' && Number.isFinite(tasks) && tasks >= 1
      ? Math.min(MAX_ACTIVE_TASKS_CEILING, Math.floor(tasks))
      : DEFAULT_MAX_ACTIVE_TASKS,
    allowSelfRecurring: s.allowSelfRecurring === true,
    allowSelfForce: s.allowSelfForce === true,
  };
};

// ─── 雲端那份記錄 ───

/**
 * 每角色一份，住在 `amsg:char:<id>` 命名空間的這個 key 上。
 *
 * 單獨成一份而不是塞進 fire_pack：fire_pack 只在「有待發任務、聊完一輪」時才重傳，
 * 用戶在面板改了上限要等下一次重傳才生效——角色在雲端給自己排、手機還沒收到的那些
 * 任務，會一直按舊上限跑。這份記錄小，保存設置時單獨立刻傳；每次傳 fire_pack 也順手
 * 帶一份（見 activeMsgClient 的 buildCharStateEntries），兩條路都認同一個構造函數。
 */
export const AMSG_LIMITS_KEY = 'limits';

export interface AmsgLimitsRecord extends AmsgPacingSettings {
  v: 1;
  /**
   * 這個角色的主動消息 2.0 開沒開（寫入那一刻的 isAmsg2EnabledForChar）。
   *
   * fire_pack 上也有同名字段，但 fire_pack 要等下一次重傳才更新。用戶關掉 2.0 時先把這份
   * 小記錄寫成 false 再去取消任務：取消掃完之後才冒出來的自排任務（正在跑的那一輪順手
   * 排的），到點時 worker 讀到 false 就直接跳過，一個 token 都不花。
   */
  selfScheduleEnabled: boolean;
}

export const buildAmsgLimitsRecord = (
  config: Partial<AmsgPacingSettings> | null | undefined,
  selfScheduleEnabled: boolean,
): AmsgLimitsRecord => ({
  v: 1,
  selfScheduleEnabled,
  ...pickPacingSettings(config),
});

/** 讀回來的記錄；形狀不對返回 null（worker 按默認值走——默認值本身就是偏嚴的那一側）。 */
export const parseAmsgLimitsRecord = (value: string | null | undefined): AmsgLimitsRecord | null => {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<AmsgLimitsRecord> | null;
    if (parsed && typeof parsed === 'object' && parsed.v === 1
      && typeof parsed.selfScheduleEnabled === 'boolean') {
      return parsed as AmsgLimitsRecord;
    }
  } catch { /* 非 JSON → null */ }
  return null;
};

// ─── 每日計數 ───

/**
 * 今天這個角色主動發了幾次（每角色一份，worker 每次發完累加）。
 *
 * 按**用戶那邊**的日期算：這是用戶的錢包閘，「今天」得是用戶自己的今天，跟角色活在
 * 哪個時區無關。換日了就從零數起，不用清。
 */
export const AMSG_DAILY_SENDS_KEY = 'daily_sends';

export interface AmsgDailySends {
  v: 1;
  /** 用戶時區下的日期 YYYY-MM-DD。 */
  day: string;
  /** 這一天主動發出去的次數（一次 = 一條主動消息，分幾段氣泡也只算一次）。 */
  sends: number;
  /**
   * 這一天後台調了幾次模型（含失敗、含被判空沒發出去的那幾次）。
   * 上游從 amsg-server 新版起才報這個數，老版本上沒有，這一項就一直不出現。
   */
  llmCalls?: number;
  /**
   * 今天已經算過「發了一次」的那幾次觸發（`<clientTaskId>@<觸發時刻>`，只留最近幾條）。
   * 同一次觸發失敗重跑時不再多算一次。
   */
  counted?: string[];
}

/** counted 最多留幾條：同一次觸發的重跑都捱得很近，留一小截就夠認出來。 */
const DAILY_COUNTED_KEEP = 20;

/** nowMs 在某個時區下的日期 YYYY-MM-DD（Intl 算，禁手搓時差）。 */
export const dayKeyInZone = (nowMs: number, tzId: string): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tzId, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(nowMs));
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day}`;
};

export const parseDailySends = (value: string | null | undefined): AmsgDailySends | null => {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<AmsgDailySends> | null;
    if (parsed && typeof parsed === 'object' && parsed.v === 1
      && typeof parsed.day === 'string' && typeof parsed.sends === 'number') {
      return parsed as AmsgDailySends;
    }
  } catch { /* 非 JSON → null */ }
  return null;
};

/** 某一天已經主動發了幾次（記錄是別的日子的 = 0）。 */
export const sendsOnDay = (record: AmsgDailySends | null, day: string): number =>
  record && record.day === day ? record.sends : 0;

/**
 * 累加一次。換日了從零起算。
 *
 * 帶了 sentId 的「發了一次」按觸發去重：同一次觸發重跑（前一跳部分失敗）只算一次。
 * 模型調用次數不去重——重跑那一跳確實又花了一次錢。
 */
export const bumpDailySends = (
  record: AmsgDailySends | null,
  day: string,
  add: { sends?: number; llmCalls?: number; sentId?: string },
): AmsgDailySends => {
  const base: AmsgDailySends = record && record.day === day ? record : { v: 1, day, sends: 0 };
  const alreadyCounted = !!add.sentId && (base.counted ?? []).includes(add.sentId);
  const sends = base.sends + (alreadyCounted ? 0 : add.sends ?? 0);
  const llmCalls = add.llmCalls
    ? (base.llmCalls ?? 0) + add.llmCalls
    : base.llmCalls;
  const counted = add.sentId && add.sends && !alreadyCounted
    ? [...(base.counted ?? []), add.sentId].slice(-DAILY_COUNTED_KEEP)
    : base.counted;
  return {
    v: 1,
    day,
    sends,
    ...(llmCalls !== undefined ? { llmCalls } : {}),
    ...(counted ? { counted } : {}),
  };
};

// ─── 兩條之間的間隔 ───

/**
 * 按間隔要求，從 fromMs 起往後找第一個能排的時刻：離 busy 裡每個時刻都至少隔 gapMs。
 * busy 是已經排著的那些觸發時刻（以及剛發出去的那一條）。
 */
export const earliestSlotAfter = (fromMs: number, gapMs: number, busy: number[]): number => {
  if (gapMs <= 0) return fromMs;
  const sorted = [...busy].filter(Number.isFinite).sort((a, b) => a - b);
  let slot = fromMs;
  // slot 只會往後挪，busy 是有限集合，挪不動的那一輪就收斂了。
  for (let moved = true; moved;) {
    moved = false;
    for (const b of sorted) {
      if (Math.abs(slot - b) < gapMs) {
        slot = b + gapMs;
        moved = true;
      }
    }
  }
  return slot;
};

/** sendAtMs 和 busy 裡哪個時刻捱得太近（沒有就 null）。 */
export const findGapConflict = (sendAtMs: number, gapMs: number, busy: number[]): number | null => {
  if (gapMs <= 0) return null;
  return busy.find((b) => Number.isFinite(b) && Math.abs(sendAtMs - b) < gapMs) ?? null;
};

/**
 * 到點那道間隔閘的寬限。
 *
 * 排程時的間隔是拿「這條開始生成的時刻」算的，而上一條記進日誌的時刻是它真發出去的
 * 那一刻——中間隔著一次生成（十幾秒到一兩分鐘），再加上定時器一分鐘一跳的誤差。不留
 * 這點餘量的話，一條正好卡著間隔排下的消息到點會被自己的上一條判成「太近」。
 */
export const FIRE_GAP_TOLERANCE_MS = 3 * 60_000;

/** 分鐘數說成人話：90 → 「1 小時 30 分鐘」。 */
export const describeMinutes = (minutes: number): string => {
  if (minutes < 60) return `${minutes} 分鐘`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} 小時 ${m} 分鐘` : `${h} 小時`;
};

// ─── 角色排程時的規矩 ───

export type SelfScheduleRecurrence = 'none' | 'daily' | 'weekly';
export type SelfScheduleExpirePolicy = 'expire' | 'force';

export interface SelfScheduleRuleInput {
  limits: AmsgLimits;
  sendAtMs: number;
  recurrence: SelfScheduleRecurrence;
  expirePolicy: SelfScheduleExpirePolicy;
  /**
   * 離得太近就不行的那些時刻：已經排著的任務的下一次觸發，加上「用戶沒回之後角色
   * 最近一次主動發出去的時刻」（到點生成時這一條本身也算，它正在發）。
   */
  busy: number[];
  /** 最早能從哪一刻起排（現在 + 技術下限）。算「最早能排到幾點」用。 */
  earliestMs: number;
  /** 把時刻說成角色那邊的鐘（打回文案用）。 */
  formatTime: (ms: number) => string;
}

export type SelfScheduleRuleResult =
  | { ok: true; expirePolicy: SelfScheduleExpirePolicy }
  | { ok: false; reason: 'recurring_not_allowed' | 'min_gap'; message: string };

/**
 * 角色自己排一條主動消息之前，按用戶定的規矩過一遍。前台工具橋和到點生成裡的排程
 * 工具共用這一份，兩個入口說同一套話。
 *
 * 「到點必發」沒開時不打回、直接按普通的排：這是把一條消息改成更安靜的那一種，角色
 * 不需要為此再來一輪；回話裡會寫明排成了哪種，它看得見。
 */
export const checkSelfScheduleRules = (input: SelfScheduleRuleInput): SelfScheduleRuleResult => {
  const { limits } = input;
  if (input.recurrence !== 'none' && !limits.allowSelfRecurring) {
    return {
      ok: false,
      reason: 'recurring_not_allowed',
      message: '用戶沒有讓你排每天/每週重複的消息，這次只能排一次性的（去掉 recurrence 再排）。',
    };
  }
  const conflict = findGapConflict(input.sendAtMs, limits.minSendGapMs, input.busy);
  if (conflict !== null) {
    const gapMinutes = Math.round(limits.minSendGapMs / 60_000);
    const earliest = earliestSlotAfter(
      Math.max(input.earliestMs, input.sendAtMs), limits.minSendGapMs, input.busy);
    return {
      ok: false,
      reason: 'min_gap',
      message: `離 ${input.formatTime(conflict)} 那條太近了：用戶定了兩條主動消息之間至少隔 ${describeMinutes(gapMinutes)}。`
        + `要排的話最早 ${input.formatTime(earliest)}；沒那麼要緊的話，這次就別排了。`,
    };
  }
  return {
    ok: true,
    expirePolicy: input.expirePolicy === 'force' && !limits.allowSelfForce ? 'expire' : input.expirePolicy,
  };
};

// ─── 告訴角色的那幾句 ───

export interface LimitsBriefInput {
  limits: AmsgLimits;
  /** 用戶沒回期間已經發了 / 排了幾條（前台聊天時用戶剛開口，傳 0）。 */
  committedSends: number;
  /** 現在排著幾條（算任務名額）。 */
  activeTasks: number;
  /** 下一條最早能排到幾點（已經按間隔算好、說成角色那邊的鐘）；沒有間隔要求時不傳。 */
  earliestText?: string;
  /** 今天還能再主動發幾條（到點生成時才知道；前台不傳）。 */
  dailyRemaining?: number;
}

/**
 * 「用戶給你定的規矩」那一段：只列跟排程有關、而且真在限制它的幾條，說成事實。
 * 超出的系統會直接打回——把額度擺在它面前，比讓它排了再被打回省一輪。
 */
export const buildLimitsBrief = (input: LimitsBriefInput): string => {
  const { limits } = input;
  const lines: string[] = [];
  if (Number.isFinite(limits.maxUnansweredSends)) {
    const left = Math.max(0, limits.maxUnansweredSends - input.committedSends);
    lines.push(`- 對方沒回的時候，你最多連著主動發 ${limits.maxUnansweredSends} 條（排好還沒發的也算），`
      + (left > 0 ? `現在還能再排 ${left} 條。` : '現在一條都不能再排了，等對方回覆。'));
  }
  if (limits.minSendGapMs > 0) {
    lines.push(`- 兩條主動消息之間至少隔 ${describeMinutes(Math.round(limits.minSendGapMs / 60_000))}`
      + (input.earliestText ? `，這次最早排到 ${input.earliestText}。` : '。'));
  }
  if (input.dailyRemaining !== undefined && Number.isFinite(limits.dailySendCap)) {
    lines.push(input.dailyRemaining > 0
      ? `- 今天還能再主動發 ${input.dailyRemaining} 條。`
      : '- 今天的主動消息已經用完了，要排就排到明天。');
  }
  lines.push(`- 同時最多排著 ${limits.maxActiveTasks} 條，現在排著 ${input.activeTasks} 條。`);
  if (!limits.allowSelfRecurring) lines.push('- 只能排一次性的，不能排每天/每週重複的。');
  if (!limits.allowSelfForce) lines.push('- 排的消息到點碰上對方正在聊天會自動作罷（轉成你在聊天裡自然帶出），沒有「到點必發」。');
  return ['用戶給你定的規矩（系統照著執行：超出的排不上，排上了到點也不發）：', ...lines].join('\n');
};
