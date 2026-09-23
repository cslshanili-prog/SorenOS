// 主動消息 2.0 的「體檢」判定：把 worker 的 GET /debug 回執翻成一排能直接看的結論，
// 以及把 fetch 拋出來的異常翻成一句知道該去改哪兒的話。
//
// 單獨成葉子的原因有兩個：
//   1. 這兩件事都是純函數（輸入回執 / 異常，輸出結論），能脫開瀏覽器單測，而它們要
//      守的恰恰是「壞了但界面看不出來」這一類問題——沒有測試釘住，退化了沒人會發現。
//   2. activeMsgClient 要用它，設置面板也要用它，放在任何一邊都會讓另一邊反向依賴。
//
// worker 那側的對應實現見 worker/amsg/src/index.ts 的 inspectWorkerEnv / inspectStorage /
// judgeTick，改動那三處的輸出形狀時這份要跟著走。「定時任務」那一行另外讀 GET /tick-report
// 的逐條細帳，形狀和判定在 utils/amsgTickReport.ts。

import type {
  AmsgTickFailureRecord,
  AmsgTickReport,
  AmsgTickReportFailure,
  AmsgTickReportTask,
} from './amsgTickReport';
import { describeTaskFailureCause } from './amsg2Tasks';

// ─── 失敗歸類（給使用統計分檔用）───
//
// 「連接失敗」在圖上只有一格的話，地址填錯、密鑰對不上、D1 沒綁、純斷網會長成一個樣，
// 而這四種要修的引導完全不同。所以在**拋錯的那一刻**按源碼裡寫死的謂詞掛一個代號，
// 上報只帶這個代號。
//
// 報錯原文（可能帶 Worker 地址、push endpoint）一個字都不進上報——掛在這裡的
// 永遠是下面這個聯合類型裡的字面量之一，不是從異常對象上讀出來的任何東西。
// 見 docs/analytics.md 「加新埋點的規矩」第 4 條。
export type AmsgFailKind =
  | '地址沒填'
  | '打到網頁了'
  | '鑑權失敗'
  | '端點不存在'
  | '建表失敗'
  | '配置缺失'
  | '網絡失敗'
  | '權限被拒'
  | '不支持推送'
  | 'worker沒配VAPID'
  | '訂閱失敗'
  | '推送通道不通'
  | '沒拿到訂閱'
  | '端點殭屍'
  | '其他';

/** 從 Worker 地址裡取一個能給人看的域名。取不到（沒填 / 填了段不是 URL 的東西）返回空串。 */
export const readWorkerHost = (workerUrl: string | null | undefined): string => {
  const value = workerUrl?.trim();
  if (!value) return '';
  try {
    return new URL(value).hostname;
  } catch {
    return '';
  }
};

const looksLikeHtmlFallbackError = (message: string) => (
  /HTML/i.test(message) ||
  message.includes(`Unexpected token '<'`) ||
  /<!doctype/i.test(message) ||
  /<html/i.test(message)
);

/**
 * 瀏覽器把「連不上」報成什麼，各家不一樣：Chrome/Firefox 是 TypeError: Failed to fetch，
 * Safari 是 TypeError: Load failed，舊 Firefox 還有 NetworkError when attempting to fetch。
 * 三種都得認，漏一種就有一批人只能看到光禿禿的英文。
 */
const looksLikeOfflineError = (message: string, name: string) => (
  name === 'TypeError' ||
  /failed to fetch/i.test(message) ||
  /load failed/i.test(message) ||
  /networkerror/i.test(message)
);

const looksLikeTimeoutError = (message: string, name: string) => (
  name === 'AbortError' ||
  name === 'TimeoutError' ||
  /timed? ?out/i.test(message) ||
  /aborted/i.test(message)
);

export interface AmsgFetchFailureDescription {
  /** 直接顯示給用戶的整句，含「這是哪一步、壞在哪、去改哪兒」。可能多行。 */
  message: string;
  /** 上報用的代號，永遠是 AmsgFailKind 裡的字面量。 */
  kind: AmsgFailKind;
}

/**
 * 把 fetch 拋出來的異常翻成人話。
 *
 * 存在的理由：這類異常的原文只有 "Failed to fetch" 五個字，既不說打的是哪兒，也不說
 * 是網絡不通還是地址錯了。社區裡排查這一句花掉過好幾天——先懷疑代理平台封號、再懷疑
 * worker 配置、最後才發現只是當時沒連上 Cloudflare。所以在這兒一次把三件事說全：
 * 是哪一步、連的是哪個域名、可能的原因分別去哪兒改。
 *
 * 另外必須寫明「這條路不通不影響到點推送」：推送是 Cloudflare 直接發給設備的，
 * 跟瀏覽器能不能連上 worker 是兩條路。不寫的話用戶會以為主動消息整個廢了。
 */
export const describeAmsgFetchFailure = (
  error: unknown,
  phase: string,
  workerUrl?: string | null,
): AmsgFetchFailureDescription => {
  const raw = error instanceof Error ? error.message : String(error || 'Unknown error');
  const name = error instanceof Error ? error.name : '';
  const host = readWorkerHost(workerUrl);
  const where = host ? `（${host}）` : '';

  if (looksLikeHtmlFallbackError(raw)) {
    return {
      kind: '打到網頁了',
      message: `主動消息 2.0 的${phase}請求沒有打到 Worker${where}，而是拿到了一個網頁。請確認設置裡填的是你部署好的 amsg Worker 地址，不是某個網頁地址。`,
    };
  }

  if (looksLikeTimeoutError(raw, name)) {
    return {
      kind: '網絡失敗',
      message: `主動消息 2.0 的${phase}請求等太久，超時了${where}。多半是當前網絡到 Cloudflare 很慢或中途被掐斷，稍後重試即可；一直這樣的話，用設置面板裡的「Deno 門面」換一條線路。\n到點的主動消息推送不走這條路，不受影響。`,
    };
  }

  if (looksLikeOfflineError(raw, name)) {
    return {
      kind: '網絡失敗',
      message: `連不上你的 Worker${where}，${phase}沒能完成。\n這一步是這台設備直接去連 Cloudflare，常見原因有三個：當前網絡到 Cloudflare 不通（換個網絡，或用設置面板裡的「Deno 門面」套一層）、Worker 地址填錯了、Worker 已經被刪掉了。\n到點的主動消息推送是 Cloudflare 直接發給設備的，不走這條路，所以照常收得到。`,
    };
  }

  return { kind: '其他', message: `主動消息 2.0 的${phase}請求失敗：${raw}` };
};

// ─── /debug 回執 → 一排看得懂的結論 ───

/** worker 自檢裡「能跑但有一塊是啞的」那類提醒。 */
export interface AmsgConfigWarning { code: string; message: string }

/**
 * 表結構自查沒跑成時，worker 給出的歸類代號（worker/amsg/src/index.ts 的
 * classifySchemaProbeError；改那邊的檔位這份要跟著走）。
 *
 * 分檔全是為了「用戶該做什麼」：unsupported 點一下更新就好，denied 是後端自己的
 * 毛病、點什麼都沒用，timeout 再體檢一次多半就過。
 */
export type AmsgSchemaProbeError = 'unsupported' | 'denied' | 'timeout' | 'other';

/** GET /debug 回執裡用得上的那部分（worker/amsg/src/index.ts）。 */
export interface AmsgDebugReport {
  config: { ok: boolean; missing: string[]; message: string; warnings: AmsgConfigWarning[] };
  storage: {
    reachable: boolean;
    /** null = worker 查不了這一項（不等於「齊了」）。老 worker 只報 boolean。 */
    schemaReady?: boolean | null;
    /** 上面那項查不了時是為什麼。缺字段 = 老 worker 不報這一項，只能籠統說一句。 */
    schemaError?: AmsgSchemaProbeError | null;
    missingTables?: string[];
    missingColumns?: string[];
    pushSubscriptionRegistered?: boolean;
    /**
     * 推送到底推沒推出去。三態由 parseAmsgDebugReport 收斂，**認下來的回執裡一定有值**
     * ——界面不用猜「缺字段」是什麼意思。可選只是為了讓「庫根本讀不到」那種樁不用湊
     * 一個沒有意義的值；那種時候上面幾行早就紅了，壓根走不到這一項。
     */
    pushDelivery?: AmsgPushDeliveryProbe;
    pendingTasks?: number;
    overdueTasks?: number;
    oldestOverdueMinutes?: number | null;
    error?: string;
  };
  /**
   * cron 在不在按時處理任務。unknown = 手上沒有待發任務，無從判斷。
   * stalled = 有任務真卡住了（沒人來領，或者領了沒下文）；failing = 沒卡住，但有任務在
   * 失敗重試、或者這次開跑晚得不正常；healthy = 都在正常處理。
   */
  tick: 'unknown' | 'idle' | 'healthy' | 'failing' | 'stalled';
  server: { version: string | null; featureCount: number } | null;
  vapidPublicKey: string | null;
}

/**
 * 認一份 /debug 回執，形狀對不上返回 null。
 *
 * 寬容不了的地方在於：沒有這個端點的 worker 回什麼的都有（404 的 JSON、Cloudflare 的
 * 錯誤頁、代理塞回來的一段 HTML）。只看 success 就採信的話，會把一台好 worker 判成
 * 「哪兒都是紅的」——那比不體檢還糟，用戶照著提示改哪兒都改不對。
 */
export const parseAmsgDebugReport = (body: unknown): AmsgDebugReport | null => {
  const data = (body as { success?: unknown; data?: Record<string, any> } | null)?.data;
  if (!data || typeof data !== 'object') return null;
  const config = data.config;
  const storage = data.storage;
  if (typeof config?.ok !== 'boolean' || !Array.isArray(config.missing)) return null;
  if (typeof storage?.reachable !== 'boolean') return null;

  return {
    config: {
      ok: config.ok,
      missing: config.missing.filter((item: unknown): item is string => typeof item === 'string'),
      message: typeof config.message === 'string' ? config.message : '',
      warnings: Array.isArray(config.warnings)
        ? config.warnings.filter((item: any) => typeof item?.code === 'string' && typeof item?.message === 'string')
        : [],
    },
    storage: { ...storage, pushDelivery: normalizePushDeliveryProbe(storage.pushDelivery) },
    tick: ['idle', 'healthy', 'failing', 'stalled'].includes(data.tick) ? data.tick : 'unknown',
    server: data.server && typeof data.server === 'object'
      ? { version: data.server.version ?? null, featureCount: Number(data.server.featureCount) || 0 }
      : null,
    vapidPublicKey: typeof data.vapidPublicKey === 'string' ? data.vapidPublicKey : null,
  };
};

// ─── 推送服務說「這條訂閱已經沒了」───
//
// 這是「登記狀態全綠、到點一條都不來」的最後一塊拼圖。瀏覽器手裡有訂閱、Worker 上
// 也登記著同一條 endpoint——兩邊都自洽，但那條 endpoint 在推送服務（FCM/Mozilla/
// Apple）那側早就作廢了，推過去只會換回一個 410。這件事只有推送服務知道，前端和
// Worker 自己都查不出來。
//
// 事實由上游 amsg-server 產生並結構化保存（投遞失敗時把推送服務回的狀態碼寫進任務的
// last_error），Worker 的 /debug 把它讀出來，這份文件只負責把它翻成紅綠燈和人話。
// 狀態碼怎麼認在 worker/amsg/src/index.ts，那兒離數據最近。

/** 認出來的那一次「訂閱已失效」。 */
export interface AmsgPushGoneFailure {
  /** 推送服務回的狀態碼：410 = 已註銷/過期，404 = 端點根本不存在。 */
  status: number;
  /** 這次失敗記錄的時刻（epoch 毫秒）。 */
  atMs: number;
}

/**
 * 「推送投遞情況」這一項的三種結局。
 *
 * `probed: false` 的兩檔都**不是**「沒問題」：`unsupported` 是這台 Worker 上跑的後端
 * 還不查這一項（老 bundle），`failed` 是查了沒查成。界面必須照實說查不了——在唯一能
 * 拆穿「全綠但一條不來」的地方給假綠燈，比沒有這項檢查更糟。
 */
export type AmsgPushDeliveryProbe =
  | { probed: false; reason: 'unsupported' | 'failed' }
  | { probed: true; gone: AmsgPushGoneFailure | null; registeredAtMs: number | null };

/** 認出 /debug 回執裡那一段的形狀。缺字段 = 老 bundle 不報這一項。 */
const normalizePushDeliveryProbe = (raw: unknown): AmsgPushDeliveryProbe => {
  if (raw === undefined) return { probed: false, reason: 'unsupported' };
  // worker 查不成時顯式回 null（老庫還沒有 last_error 列、查詢被拒）。
  if (!raw || typeof raw !== 'object') return { probed: false, reason: 'failed' };
  const value = raw as { gone?: any; registeredAtMs?: unknown };
  const status = Number(value.gone?.status);
  const atMs = Number(value.gone?.atMs);
  return {
    probed: true,
    gone: Number.isFinite(status) && Number.isFinite(atMs) ? { status, atMs } : null,
    registeredAtMs: Number.isFinite(Number(value.registeredAtMs)) ? Number(value.registeredAtMs) : null,
  };
};

/** 一行體檢結論的嚴重程度。bad = 現在就是壞的，warn = 能跑但有一塊是啞的。 */
export type AmsgDiagnosticLevel = 'ok' | 'warn' | 'bad' | 'unknown';

/** 一行結論底下的一條細目（比如「定時任務」那一行裡的每一條任務）。 */
export interface AmsgDiagnosticItem {
  /** 一句或一小段人話。 */
  text: string;
  /** 報錯原文。界面上默認收著，點「原文」才展開——截圖發給別人排查時用得上。 */
  raw?: string;
}

export interface AmsgDiagnosticRow {
  key: string;
  label: string;
  level: AmsgDiagnosticLevel;
  /** 一句話：壞在哪、去哪兒改。ok 的行寫現狀即可。 */
  detail: string;
  /** 逐條細目，按「先看哪條」排好。沒有就不帶這個字段。 */
  items?: AmsgDiagnosticItem[];
}

/** 拉體檢的結果。連不上時帶上已經翻成人話的原因，那本身就是第一行結論。 */
export type AmsgDiagnosticsProbe =
  | { reachable: true; report: AmsgDebugReport }
  | { reachable: false; reason: string; /** 舊 worker 沒有這個端點，不是壞了 */ unsupported?: boolean };

/** 拉定時任務細帳（GET /tick-report）的結果。拿不到時帶一句已經翻成人話的原因。 */
export type AmsgTickReportResult =
  | { ok: true; report: AmsgTickReport }
  | { ok: false; reason: string };

export interface AmsgDiagnosticsInput {
  probe: AmsgDiagnosticsProbe;
  /** 這台設備的瀏覽器有沒有推送訂閱（本地事實，worker 那側看不到）。 */
  localPushSubscribed?: boolean;
  /** 把 epoch 毫秒寫成給人看的時間；不傳按本機習慣格式化（單測注入固定格式用）。 */
  formatTime?: (atMs: number) => string;
  /** 定時任務的逐條細帳。沒拉（null / 不傳）時「定時任務」那一行只按 /debug 的兩個數說話。 */
  tickReport?: AmsgTickReportResult | null;
  /** 用戶在面板上把後台任務暫停了。這時任務到點不發是意料之中，不能報成觸發器壞了。 */
  cronPaused?: boolean;
  /**
   * 判定用的「現在」（epoch 毫秒，單測注入用）。不傳時用細帳回執裡 Worker 的時鐘，
   * 沒有細帳才用本機時鐘：任務上的時刻全是 Worker 寫的，拿設備時鐘去減，設備鍾一跑偏
   * 「晚了幾分鐘」就跟著歪。
   */
  nowMs?: number;
}

const defaultFormatTime = (atMs: number): string => new Date(atMs).toLocaleString();

/** 「重置訂閱」在哪兒、點了會發生什麼。幾處文案共用一句，別各寫各的。 */
export const PUSH_RESET_HINT = '去設置頁的「推送訂閱狀態」點「重置訂閱」重建一條——它會退訂、重訂、再覆蓋登記回 Worker，點一次就夠。';

const WORKER_TOO_OLD_HINT = '這台 Worker 上跑的後端還不查「推送有沒有真的送出去」，所以「到點了但一條都不來」這種壞法它看不出來。點上面的「更新 Worker」換成新版就能查了。';

export interface AmsgPushDeliveryVerdict {
  level: 'bad' | 'warn';
  /** 發生了什麼。幾處共用，不帶「去哪兒修」。 */
  what: string;
  /** 體檢那一行的完整說法：發生了什麼 + 該去哪兒點哪個按鈕。 */
  detail: string;
}

/**
 * 上一次推送到底有沒有被推送服務判成「訂閱失效」，以及那筆帳現在還算不算數。
 * 沒問題（查過了、沒發生過 / 是重置之前的舊帳）返回 null。
 *
 * 體檢的「這台設備」和設置頁的推送訂閱面板共用這一份判定：兩處各寫一套的話，
 * 用戶會看到一個紅一個綠，而這正是他唯一能拿來判斷該不該重置訂閱的依據。
 *
 * @param formatTime 把 epoch 毫秒寫成給人看的時間；不傳按本機習慣格式化。
 */
export const judgePushDeliveryFailure = (
  probe: AmsgPushDeliveryProbe | null | undefined,
  formatTime: (atMs: number) => string = defaultFormatTime,
): AmsgPushDeliveryVerdict | null => {
  if (!probe) return null;

  // 查不了不是「沒問題」。報 warn 而不是紅：這時並沒有任何證據說明推送壞了，
  // 但也絕不能給綠燈——它恰恰是唯一能拆穿「全綠但一條不來」的那一項。
  if (!probe.probed) {
    const what = probe.reason === 'unsupported'
      ? '這次沒查「推送有沒有真的送出去」'
      : '「推送有沒有真的送出去」這一項沒查成（後端讀不到任務的失敗記錄）';
    return {
      level: 'warn',
      what,
      detail: probe.reason === 'unsupported' ? WORKER_TOO_OLD_HINT : `${what}。到點卻收不到消息的話，${PUSH_RESET_HINT}`,
    };
  }

  const { gone, registeredAtMs } = probe;
  if (!gone) return null;

  const when = formatTime(gone.atMs);
  const what = `${when} 那次推送被推送服務退回來了，理由是「這條訂閱已經失效」（${gone.status}）`;

  // 登記時刻問不到就沒法分辨新舊帳。報 warn 不報紅：重置過訂閱的人不該被一條
  // 永遠消不掉的紅燈追著跑，但也不能給綠燈——那正是這條要拆穿的假象。
  if (registeredAtMs == null) {
    const uncertain = '這次問不到 Worker 上那行訂閱是什麼時候登記的，沒法確認它是不是重置之前的舊帳';
    return {
      level: 'warn',
      what: `${what}。${uncertain}`,
      detail: `${what}。${uncertain}；最近沒重置過的話，${PUSH_RESET_HINT}`,
    };
  }

  // 那之後訂閱換過一條了：這筆是上一條訂閱的舊帳，服務端只在失敗時寫、成功不會清。
  if (gone.atMs <= registeredAtMs) return null;

  const stillBroken = `${what}，而 Worker 上登記的還是它——到點的消息全都推不出去`;
  return { level: 'bad', what: stillBroken, detail: `${stillBroken}。${PUSH_RESET_HINT}` };
};

const DB_MISSING_HINT = 'Worker 沒有綁定 D1 數據庫。多半是部署第一步填完 Database ID 之後沒點那個「Add」就直接 Deploy 了。回 Cloudflare 的 Settings → Bindings 加一條 D1 database，變量名填大寫的 DB。';
const MASTER_KEY_MISSING_HINT = 'Worker 上沒有 AMSG_MASTER_KEY。去 Settings → Variables and secrets 添加，類型一定要選 Secret——選成 Text 的話下次部署就會消失。';
const SCHEMA_STALE_HINT = '換過 Worker 版本後，已經存在的表不會自己長出新列，定時任務每分鐘都會因為讀不到它們而掛掉（界面上一切正常，就是一條都不發）。點上面的「重新連接並驗證」補一次。';

/**
 * 表結構沒查成時，各檔分別該跟用戶說什麼。
 *
 * 每一句都要落到「要不要緊 + 該做什麼」上。以前這裡只有一句「查不了，不知道」——
 * 原因躺在 Cloudflare 日誌裡，用戶看不到，隔著屏幕也問不出來，只能一路猜。
 */
const SCHEMA_PROBE_HINTS: Record<AmsgSchemaProbeError, string> = {
  denied: '查表結構時被數據庫擋了一道：Cloudflare 在庫裡放了一張自己的內部表，不讓 Worker 讀，自查就斷在那兒了。表齊沒齊這次沒查出來，但主動消息的收發不受影響。等後端更新到修好這處的版本就會自己恢復。',
  unsupported: '這台 Worker 上跑的後端代碼還沒有「查自己表結構」這個本事，齊沒齊問不出來。點上面的「更新 Worker」換成新版就能查了。',
  timeout: '查表結構時數據庫沒在時限內回話，這次沒查出來。多半是 D1 剛被喚醒（隔幾小時的頭一次請求常這樣），過一會兒再體檢一次通常就好了。',
  other: '這台 Worker 查不了自己的表結構，齊沒齊不知道。要是主動消息到點不響，先點一次上面的「重新連接並驗證」把表補齊。',
};

// ─── 「定時任務」那一行：/debug 的兩個數 + /tick-report 的逐條細帳 ───
//
// 光靠 /debug 只知道「幾條到點沒發、最老的晚了多久」，只夠說一句籠統的「定時觸發器
// 可能沒在跑」。可同樣是晚了四十分鐘，可能是在等第三次重試（原因明明白白
// 記在任務上）、可能是一開跑就被 Cloudflare 掐掉、也可能是用戶自己把後台任務暫停了——
// 照那一句去 Cloudflare 翻觸發器，三種裡有兩種翻不出任何東西。
// 所以這一行先給一句總的結論，再逐條說每條任務現在算哪種情況，報錯原文收在底下。

const MINUTE_MS = 60_000;

/** 失敗記錄在這個時間以內算「剛出的事」，夠把這一行提成 warn。 */
const RECENT_FAILURE_MS = 60 * MINUTE_MS;

/**
 * 再早的失敗記錄一律不提。Worker 那邊本來也只留一天，列太老的帳只會讓人以為現在還壞著；
 * 一小時到一天之間的，只在這一行本來就不正常時陪著列出來，幫著看是不是同一個毛病。
 */
const FAILURE_LOOKBACK_MS = 24 * 60 * MINUTE_MS;

/** 沒有細帳可看時的那句籠統說法。兩種壞法都點到，讓人至少知道去哪兒看日誌。 */
const TICK_STALLED_GENERIC_HINT = '定時觸發器可能沒在跑，或者每分鐘那一跳在報錯——去 Cloudflare 的 Workers → 你的 Worker → Observability 看日誌。';

/** 任務一直沒人來領、Worker 又什麼報錯都沒留下時，最可能的原因和該去哪兒看。 */
const TICK_TRIGGER_MISSING_HINT = '多半是定時觸發器沒在跑：去 Cloudflare 的 Workers → 你的 Worker → Settings → Trigger events 看看有沒有 * * * * *，再到 Observability 看日誌。';

const parseIsoMs = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

/** 兩個時刻隔了幾整分鐘。時鐘有點偏時可能算出負數，一律按 0 算。 */
const minutesBetween = (fromMs: number, toMs: number): number =>
  Math.max(0, Math.floor((toMs - fromMs) / MINUTE_MS));

/** 補上句號；原話自己已經帶了句末標點的（英文報錯常見）不再疊一個。 */
const endSentence = (text: string): string => {
  const trimmed = text.trim();
  return /[。！？.!?…]$/.test(trimmed) ? trimmed : `${trimmed}。`;
};

/**
 * 這條任務在列表裡怎麼稱呼。
 *
 * 解不開任務內容時（主密鑰換過之類）連名字都拿不到，也得有個主語，不然一句話開頭就是冒號。
 * 名字是英文的話跟後面的中文之間空一格，中文名直接連著寫。
 */
const describeTaskOwner = (task: { contactName: string | null; kind: string | null; messageType: string | null }): string => {
  const name = task.contactName || '某個角色';
  const gap = /[\x21-\x7e]$/.test(name) ? ' ' : '';
  if (task.kind) return `${name}${gap}的後台任務`;
  if (task.messageType === 'instant') return `${name}${gap}的即時回覆`;
  return name;
};

interface TickTaskContext {
  nowMs: number;
  formatIso: (iso: string) => string;
  /** 每分鐘那一跳自己此刻正在報錯。卡住的任務就不必再猜觸發器了，原因在那條報錯裡。 */
  tickFailureOngoing: boolean;
  cronPaused: boolean;
}

/** 一條到點還沒發出去的任務，現在是什麼情況。判定是 Worker 做的，這裡只負責說成人話。 */
const describeTickTask = (task: AmsgTickReportTask, ctx: TickTaskContext): AmsgDiagnosticItem => {
  const { nowMs, formatIso } = ctx;
  const owner = describeTaskOwner(task);
  const nextSendMs = parseIsoMs(task.nextSendAt);
  const lateMinutes = nextSendMs === null ? null : minutesBetween(nextSendMs, nowMs);
  const parts: string[] = [
    lateMinutes === null
      ? `${owner}：${task.nextSendAt} 該發。`
      : `${owner}：${formatIso(task.nextSendAt)} 該發，${lateMinutes < 1 ? '剛到點' : `已經晚了 ${lateMinutes} 分鐘`}。`,
  ];

  const lastErrorLine = task.lastError
    ? `上一次失敗：${endSentence(describeTaskFailureCause(task.lastError))}`
    : '';
  const startedMs = parseIsoMs(task.lastStartedAt);

  if (task.state === 'retry-wait') {
    const failed = task.retryCount > 0 ? `已經失敗 ${task.retryCount} 次` : '失敗過';
    const retryAt = task.retryAfter ? `${formatIso(task.retryAfter)} 再試` : '等一會兒再試';
    parts.push(`${failed}，${retryAt}。`, lastErrorLine);
  } else if (task.state === 'sending') {
    if (task.lateStart && startedMs !== null) {
      // 「可以開跑」取到點時刻和重試時刻裡更晚的那個：重試期間到點時刻是不往後推的。
      const readySinceMs = Math.max(nextSendMs ?? -Infinity, parseIsoMs(task.retryAfter) ?? -Infinity);
      const gap = Number.isFinite(readySinceMs) ? `到點 ${minutesBetween(readySinceMs, startedMs)} 分鐘後` : '到點好一陣之後';
      parts.push(`正在發，但這次是${gap}才開始的，前面那段時間沒留下任何記錄：可能之前開跑過、半路被 Cloudflare 掐掉了，也可能那幾分鐘定時觸發器沒在跑。`);
    } else {
      const agoMinutes = startedMs === null ? null : minutesBetween(startedMs, nowMs);
      parts.push(agoMinutes === null ? '正在發。' : agoMinutes < 1 ? '正在發（剛開始）。' : `正在發（${agoMinutes} 分鐘前開始的）。`);
    }
    parts.push(lastErrorLine);
  } else if (task.unfinishedAttempt) {
    const when = task.lastStartedAt ? `${formatIso(task.lastStartedAt)} ` : '';
    parts.push(`${when}開始發過，但沒發完，也沒留下失敗原因。多半是跑到一半被 Cloudflare 掐掉了（比如 CPU 時間或運行時長超限），原話只在 Cloudflare 的 Workers → 你的 Worker → Observability 日誌裡。`);
    // 行上的失敗記錄早於這次開跑，說的是再往前那一次。
    if (task.lastError) parts.push(`再往前那次失敗：${endSentence(describeTaskFailureCause(task.lastError))}`);
  } else if (task.queuedBehind) {
    parts.push('同一個角色的另一條任務正在發，這條在排隊。', lastErrorLine);
  } else if (task.stuck) {
    parts.push(lastErrorLine ? `${lastErrorLine}之後到了重試時間，也一直沒開始發。` : '到點後一直沒開始發。');
    parts.push(ctx.cronPaused
      ? '後台任務暫停著，恢復後會一起補發。'
      : ctx.tickFailureOngoing
        ? '原因見下面那條整輪報錯。'
        : `Worker ${lastErrorLine ? '那之後' : ''}沒留下任何報錯，${TICK_TRIGGER_MISSING_HINT}`);
  } else {
    parts.push(lastErrorLine ? `${lastErrorLine}馬上會再試一次。` : '馬上就會發。');
  }

  const raw = task.lastError && task.lastError.reason !== 'stale' ? task.lastError.reason : undefined;
  return { text: parts.filter(Boolean).join(''), ...(raw ? { raw } : {}) };
};

/** 整輪報錯掛在哪一步。鍵是 Worker 記下的階段代號（見 amsgTickReport 的 AmsgTickFailureRecord.stage）。 */
const TICK_STAGE_TEXT: Record<string, string> = {
  config: '讀配置那一步',
  tick: '整輪處理任務那一步',
  claim_failed: '給任務佔位寫庫那一步',
  retry_update_failed: '記失敗原因寫庫那一步',
  stale_update_failed: '處理過期任務寫庫那一步',
};

const describeTickStage = (stage: string): string => {
  // 發完之後的收尾有好幾種（刪行、推進排期……），代號都是這個前綴加後綴。
  if (stage.startsWith('post_send_cleanup_failed')) return '發完之後寫庫那一步';
  return TICK_STAGE_TEXT[stage] || `「${stage}」那一步`;
};

/** 認得出來的整輪報錯，順帶說一句該怎麼辦。認不出來的只給原文，不瞎猜。 */
const describeTickFailureRemedy = (failure: AmsgTickFailureRecord): string => {
  if (/no such (column|table)/i.test(failure.message)) {
    return '表結構跟現在的代碼對不上，點上面的「重新連接並驗證」補一次。';
  }
  if (failure.name === 'VapidNotConfigured') {
    return 'Worker 上沒配推送憑據（VAPID），去 Settings → Variables and secrets 補上。';
  }
  if (/timed? ?out/i.test(`${failure.name} ${failure.message}`)) {
    return '數據庫這一下沒響應，偶爾一次沒關係，一直這樣再來看。';
  }
  return '';
};

const describeTickFailure = (failure: AmsgTickFailureRecord, formatIso: (iso: string) => string): AmsgDiagnosticItem => {
  const stage = describeTickStage(failure.stage);
  const head = failure.count > 1
    ? `Worker 每分鐘那一跳${failure.ongoing ? '一直在' : '之前'}報錯：${formatIso(failure.firstAt)} 到 ${formatIso(failure.lastAt)} 連著 ${failure.count} 次，卡在${stage}。`
    : `Worker 每分鐘那一跳${failure.ongoing ? '剛剛' : '之前'}報了一次錯（${formatIso(failure.lastAt)}），卡在${stage}。`;
  return {
    text: `${head}${describeTickFailureRemedy(failure)}`,
    raw: `${failure.name}: ${failure.message}${failure.code ? ` (${failure.code})` : ''}`,
  };
};

/** 最近徹底沒發出去的一次。 */
const describeRecentFailure = (failure: AmsgTickReportFailure, formatIso: (iso: string) => string): AmsgDiagnosticItem => {
  const owner = describeTaskOwner(failure);
  // 「哪一次」比「什麼時候記的」更貼用戶想知道的事，跟任務卡片那行同一個取法。
  const when = failure.error.occurrence || failure.error.at;
  const outcome = failure.outcome === 'skipped'
    ? '沒發出去，這次跳過了，下次到點照常'
    : '沒發出去，不會再補發了';
  const head = when ? `${owner}：${formatIso(when)} 那次${outcome}。` : `${owner}：最近有一次${outcome}。`;
  const raw = failure.error.reason !== 'stale' ? failure.error.reason : undefined;
  return {
    text: `${head}原因：${endSentence(describeTaskFailureCause(failure.error))}`,
    ...(raw ? { raw } : {}),
  };
};

/** 失敗重試 / 開跑晚了的那幾條，合起來一句話。 */
const summarizeFailingTasks = (tasks: AmsgTickReportTask[], truncatedNote: string): string => {
  const retrying = tasks.filter((task) => task.state === 'retry-wait' || task.lastError).length;
  const late = tasks.filter((task) => task.lateStart).length;
  const what = retrying && late
    ? `有 ${retrying} 條任務在失敗重試，${late} 條這次開始發得比平時晚`
    : retrying
      ? `有 ${retrying} 條任務在失敗重試`
      : late
        ? `有 ${late} 條任務這次開始發得比平時晚`
        : '有任務到點沒按時發出去';
  return `${what}，逐條情況在下面${truncatedNote}。`;
};

/**
 * 「定時任務」這一行。
 *
 * 嚴重程度只看證據：真卡住了、或者每分鐘那一跳此刻正在報錯，才報紅；在失敗重試、
 * 剛報過錯、最近一小時有沒發出去的，報 warn；用戶自己暫停了後台任務，任務攢著是
 * 意料之中，同樣只報 warn，而且不許說成觸發器壞了。
 */
const buildTickRow = (debugReport: AmsgDebugReport, input: AmsgDiagnosticsInput): AmsgDiagnosticRow => {
  const { storage, tick } = debugReport;
  const formatTime = input.formatTime || defaultFormatTime;
  const formatIso = (iso: string) => {
    const ms = parseIsoMs(iso);
    return ms === null ? iso : formatTime(ms);
  };
  const tickReport = input.tickReport?.ok ? input.tickReport.report : null;
  const reportFailedReason = input.tickReport && !input.tickReport.ok ? input.tickReport.reason : null;
  const nowMs = input.nowMs ?? parseIsoMs(tickReport?.now) ?? Date.now();

  const storageOverdue = storage.overdueTasks || 0;
  const stalledMinutes = storage.oldestOverdueMinutes ?? null;
  const listedTasks = tickReport?.tasks ?? [];
  // 有細帳就按細帳數，跟下面列出來的條數對得上；沒列全時取兩邊大的那個。
  const overdue = listedTasks.length
    ? (tickReport?.truncated ? Math.max(storageOverdue, listedTasks.length) : listedTasks.length)
    : storageOverdue;
  const truncatedNote = tickReport?.truncated && listedTasks.length
    ? `（太多了，只列了前 ${listedTasks.length} 條）`
    : '';
  const cronPaused = Boolean(input.cronPaused);
  const pausedWithTasks = cronPaused && ((storage.pendingTasks ?? 0) > 0 || storageOverdue > 0 || listedTasks.length > 0);

  const tickFailure = tickReport?.tickFailure ?? null;
  const tickFailureAtMs = parseIsoMs(tickFailure?.lastAt);
  const tickFailureRecent = Boolean(
    tickFailure && !tickFailure.ongoing && tickFailureAtMs !== null && nowMs - tickFailureAtMs <= RECENT_FAILURE_MS,
  );
  const tickFailureWithinDay = Boolean(
    tickFailure && (tickFailure.ongoing || tickFailureAtMs === null || nowMs - tickFailureAtMs <= FAILURE_LOOKBACK_MS),
  );

  // 時刻讀不出來的失敗記錄還是列（Worker 那邊已經只給最近一天的），只是不拿它提級。
  const dayFailures = (tickReport?.recentFailures ?? []).filter((failure) => {
    const atMs = parseIsoMs(failure.error.at) ?? parseIsoMs(failure.error.occurrence);
    return atMs === null || nowMs - atMs <= FAILURE_LOOKBACK_MS;
  });
  const hourFailures = new Set(dayFailures.filter((failure) => {
    const atMs = parseIsoMs(failure.error.at);
    return atMs !== null && nowMs - atMs <= RECENT_FAILURE_MS;
  }));

  const level: AmsgDiagnosticLevel = tickFailure?.ongoing || (tick === 'stalled' && !cronPaused)
    ? 'bad'
    : pausedWithTasks || tick === 'stalled' || tick === 'failing' || tickFailureRecent || hourFailures.size > 0
      ? 'warn'
      : tick === 'unknown'
        ? 'unknown'
        : 'ok';

  const lateText = stalledMinutes === null ? '' : ` ${stalledMinutes} 分鐘`;
  const detail = pausedWithTasks
    ? (storageOverdue || listedTasks.length
      ? `後台任務暫停中，有 ${overdue} 條到點的任務等恢復後一起補發。`
      : `後台任務暫停中，${storage.pendingTasks ?? 0} 條待發任務到點了也先攢著，恢復後一起補發。`)
    : tickFailure?.ongoing
      ? (overdue
        ? `Worker 每分鐘那一跳在報錯，有 ${overdue} 條任務到點還沒發出去。報錯原話和逐條情況在下面。`
        : 'Worker 每分鐘那一跳在報錯，原話在下面。')
      : tick === 'stalled'
        ? (listedTasks.length
          ? `有 ${overdue} 條任務到點還沒發出去，逐條情況在下面${truncatedNote}。`
          : `有 ${storageOverdue} 條任務到點${lateText}還沒發出去。${TICK_STALLED_GENERIC_HINT}`)
        : tick === 'failing'
          ? (listedTasks.length
            ? summarizeFailingTasks(listedTasks, truncatedNote)
            : `有 ${storageOverdue} 條任務到點${lateText}還沒發出去。Worker 在處理，但中間失敗過，或者開始得比平時晚。`)
          : tickFailureRecent
            ? 'Worker 每分鐘那一跳前一陣報過錯，現在沒再報。'
            : hourFailures.size > 0
              ? `最近一小時有 ${hourFailures.size} 次到點沒發出去，原因在下面。`
              : tick === 'healthy'
                ? `${storage.pendingTasks ?? 0} 條待發任務，都在按時處理。`
                : tick === 'idle'
                  ? '現在沒有待發任務。'
                  : '手上沒有待發任務，暫時看不出定時器在不在跑。';

  const items: AmsgDiagnosticItem[] = [];
  if (reportFailedReason && (level === 'bad' || level === 'warn')) {
    // 沒拿到細帳時上面那句只能說得籠統，至少讓人知道為什麼沒有逐條的。
    items.push({ text: reportFailedReason });
  }
  if (tickReport) {
    const ctx: TickTaskContext = { nowMs, formatIso, tickFailureOngoing: Boolean(tickFailure?.ongoing), cronPaused };
    items.push(...listedTasks.map((task) => describeTickTask(task, ctx)));
    if (tickFailure && (tickFailure.ongoing || tickFailureRecent || (level !== 'ok' && tickFailureWithinDay))) {
      items.push(describeTickFailure(tickFailure, formatIso));
    }
    items.push(...dayFailures
      .filter((failure) => hourFailures.has(failure) || level !== 'ok')
      .map((failure) => describeRecentFailure(failure, formatIso)));
  }

  return {
    key: 'tick',
    label: '定時任務',
    level,
    detail,
    ...(items.length ? { items } : {}),
  };
};

/**
 * 把體檢結果排成一列，順序就是「該先修哪個」。
 *
 * 每一行只回答一個問題，且都是靠自己能改的：連不連得上 → 庫綁沒綁 → 密鑰有沒有 →
 * 表建沒建全 → 推送憑據配沒配 → 這台設備登記了沒 → 定時任務在不在跑。
 * 前面的行是壞的時候，後面那些查不出結論的一律報 unknown，不假裝綠。
 */
export const buildAmsgDiagnosticRows = (input: AmsgDiagnosticsInput): AmsgDiagnosticRow[] => {
  const { probe, localPushSubscribed } = input;

  if (!probe.reachable) {
    const unknownRest = (key: string, label: string): AmsgDiagnosticRow => ({
      key, label, level: 'unknown', detail: '連上 Worker 之後才能查。',
    });
    return [
      {
        key: 'reachable',
        label: 'Worker 可達',
        level: probe.unsupported ? 'warn' : 'bad',
        detail: probe.reason,
      },
      unknownRest('database', '數據庫綁定'),
      unknownRest('masterKey', '主密鑰'),
      unknownRest('schema', '數據表'),
      unknownRest('pushCredential', '推送憑據'),
      unknownRest('pushDevice', '這台設備'),
      unknownRest('tick', '定時任務'),
    ];
  }

  const { config, storage } = probe.report;
  const rows: AmsgDiagnosticRow[] = [];

  rows.push({
    key: 'reachable',
    label: 'Worker 可達',
    level: 'ok',
    detail: probe.report.server?.version ? `後端版本 ${probe.report.server.version}` : '連得上。',
  });

  const dbMissing = config.missing.includes('DB');
  rows.push({
    key: 'database',
    label: '數據庫綁定',
    level: dbMissing ? 'bad' : 'ok',
    detail: dbMissing ? DB_MISSING_HINT : '已綁定 D1。',
  });

  const masterKeyMissing = config.missing.includes('AMSG_MASTER_KEY');
  const masterKeyFormat = config.warnings.find((item) => item.code === 'MASTER_KEY_FORMAT');
  rows.push({
    key: 'masterKey',
    label: '主密鑰',
    level: masterKeyMissing ? 'bad' : masterKeyFormat ? 'warn' : 'ok',
    detail: masterKeyMissing ? MASTER_KEY_MISSING_HINT : masterKeyFormat?.message || '已配置。',
  });

  // 庫都沒綁的話，下面這些查出來必然是「什麼都沒有」，報紅會把人往錯的方向引。
  if (dbMissing || !storage.reachable) {
    rows.push({
      key: 'schema',
      label: '數據表',
      level: dbMissing ? 'unknown' : 'bad',
      detail: dbMissing
        ? '先把 D1 綁上再看這一項。'
        : `連得上 Worker，但讀不了它的數據庫${storage.error ? `（${storage.error}）` : ''}。`,
    });
  } else if (storage.schemaReady === null) {
    // Worker 連得上、庫也讀得到，但它比對不出表結構（比如那句查詢本身被拒了）。
    // 這一檔過去混在「正常」裡——而這一項存在的全部意義就是查出表結構漂移，
    // 漂移時 cron 每分鐘靜默失敗、界面處處正常，這裡再給一個假綠燈就徹底沒人能發現了。
    rows.push({
      key: 'schema',
      label: '數據表',
      level: 'unknown',
      detail: SCHEMA_PROBE_HINTS[storage.schemaError || 'other'],
    });
  } else {
    const missingTables = storage.missingTables || [];
    const missingColumns = storage.missingColumns || [];
    const schemaBad = missingTables.length > 0 || missingColumns.length > 0;
    // 明說了不夠用（false）卻一項都沒點到名 = 自查本身沒跑成，而主表確實不在：庫還是空的。
    // 只數這兩個數組的話，一個一張表都沒建的空庫會顯示成全綠——一鍵部署完還沒點連接時
    // 正好是這個組合（表沒建 + 自查被內部表拒掉）。
    const emptyDatabase = storage.schemaReady === false && !schemaBad;
    rows.push({
      key: 'schema',
      label: '數據表',
      level: schemaBad || emptyDatabase ? 'bad' : 'ok',
      detail: emptyDatabase
        ? '庫裡還一張表都沒有。點上面的「重新連接並驗證」建一次。'
        : missingTables.length
          ? `缺表：${missingTables.join('、')}。點上面的「重新連接並驗證」會自動建好（可能要點兩次）。`
          : missingColumns.length
            ? `表結構是舊的，缺列：${missingColumns.join('、')}。${SCHEMA_STALE_HINT}`
            : '表和列都齊了。',
    });
  }

  const vapidWarning = config.warnings.find((item) => item.code === 'VAPID_MISSING');
  rows.push({
    key: 'pushCredential',
    label: '推送憑據',
    level: vapidWarning ? 'bad' : 'ok',
    // 這是最難自己查出來的一種壞法：任務建得成、界面全綠，到點一條都推不出去。
    detail: vapidWarning ? vapidWarning.message : 'VAPID 已配齊。',
  });

  const remoteRegistered = storage.pushSubscriptionRegistered === true;
  // 兩邊都登記著，也不等於推得出去：那條 endpoint 可能在推送服務那側早就作廢了。
  // 只有投遞結果知道這件事，登記狀態是綠的時候更要看它——「全綠但一條不來」就是
  // 這麼來的。雲端壓根沒登記時不看這個：那時該修的是上一層，說兩件事只會分散注意力。
  const deliveryVerdict = remoteRegistered
    ? judgePushDeliveryFailure(storage.pushDelivery, input.formatTime)
    : null;
  rows.push({
    key: 'pushDevice',
    label: '這台設備',
    level: !localPushSubscribed ? 'bad' : !remoteRegistered ? 'bad' : deliveryVerdict?.level || 'ok',
    detail: !localPushSubscribed
      ? '這台設備還沒訂閱推送，點下面的「開啟通知與推送」。'
      : !remoteRegistered
        ? '瀏覽器訂閱好了，但 Worker 上沒有登記收件設備——到點的消息發不出去。點下面的「開啟通知與推送」補登記一次。'
        : deliveryVerdict?.detail
          || '瀏覽器已訂閱，Worker 上也登記了收件設備，最近一次推送也沒被退回來。換設備或換瀏覽器之後要在新的那台上再點一次「開啟通知與推送」。',
  });

  rows.push(buildTickRow(probe.report, input));

  return rows;
};

/** 一排結論裡最嚴重的那一檔，用來給面板定基調。 */
export const summarizeAmsgDiagnostics = (rows: AmsgDiagnosticRow[]): AmsgDiagnosticLevel => {
  if (rows.some((row) => row.level === 'bad')) return 'bad';
  if (rows.some((row) => row.level === 'warn')) return 'warn';
  if (rows.some((row) => row.level === 'unknown')) return 'unknown';
  return 'ok';
};

// ─── 即時對話：開不了的話卡在哪一道 ───

/**
 * 即時對話三道門裡最先沒過的那一道。
 *
 * 代號寫死在這兒，設置頁拿它選提示文案、使用統計拿它當屬性——**兩處共用同一個判定**。
 * 各算各的話，黃字說的和上報裡的早晚各說各話，而這條路上的每一次分歧都只能靠用戶
 * 自己來報（他看到的是「開關點不動」，我們看到的是「沒人開」）。
 */
export type InstantChatBlocker = '沒連上Worker' | '沒開推送' | 'Worker太舊';

export interface InstantChatGateInput {
  /** 連接並驗證成功過（全局配置的 initializedAt）。 */
  connected: boolean;
  /** 這台設備訂閱了推送。 */
  pushSubscribed: boolean;
  /** 這台 Worker 認 `POST /instant-chat`（GET /config-check 的 instantChat 標誌）。 */
  workerSupportsInstantChat: boolean;
}

/**
 * 按「先補哪個」的順序返回第一道沒過的門，三道全過返回 null。
 *
 * 順序不是隨便排的：沒連上就談不上推送，沒推送權限就算發得出去也收不回來，
 * 最後才是 Worker 太舊、端點根本不存在。
 */
export const resolveInstantChatBlocker = (input: InstantChatGateInput): InstantChatBlocker | null => {
  if (!input.connected) return '沒連上Worker';
  if (!input.pushSubscribed) return '沒開推送';
  if (!input.workerSupportsInstantChat) return 'Worker太舊';
  return null;
};

/** 每道門對應的那句話（設置頁開關下面的黃字）。 */
export const INSTANT_CHAT_BLOCKER_HINTS: Record<InstantChatBlocker, string> = {
  '沒連上Worker': '先在上面把 Worker 連上。',
  '沒開推送': '先開啟通知與推送：回覆是靠推送送回來的，沒有權限就變成發得出、收不到。',
  'Worker太舊': 'Worker 上跑的代碼還起不了這條路（缺起跳器，或者還是舊版）。點上面的「更新 Worker」，更新完這裡會自己恢復。開著也不會走雲端——那台 Worker 上是發一條掛一條，這段時間聊天先在本地生成。',
};
