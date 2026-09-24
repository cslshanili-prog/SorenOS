import { loadCharacterContextMessages } from './chatContextRange';
import { ReiClient } from '@rei-standard/amsg-client';
import {
  ActiveMsg2CharacterConfig,
  ActiveMsg2ExpirePolicy,
  ActiveMsg2GlobalConfig,
  ActiveMsg2Mode,
  ActiveMsg2Recurrence,
  ActiveMsg2TaskRecord,
  APIConfig,
  CharacterProfile,
  Emoji,
  EmojiCategory,
  GroupProfile,
  RealtimeConfig,
  UserProfile,
} from '../types';
import { getLastRealUserMessageAt } from './amsg2ExpireGuard';
import { resolveCharacterChatApi } from './characterApi';
import { AMSG_BUNDLE_VERSION } from './amsgBundleVersion';
import { buildTaskInstruction, resolveSendAtMs } from './amsgFireSchedule';
import {
  getPendingTasks, isAmsg2EnabledForChar,
  parseRemoteTaskLastError, RemoteTaskLastError, type RemoteTaskProjection,
  resolveExpirePolicy, toDatetimeLocalValue,
} from './amsg2Tasks';
import {
  AMSG_DAILY_SENDS_KEY,
  AMSG_LIMITS_KEY,
  type AmsgDailySends,
  buildAmsgLimitsRecord,
  parseDailySends,
  resolveAmsgLimits,
} from './amsgLimits';
import { AMSG_CHAT_PRESENCE_KEY, AmsgChatPresence } from './amsgChatPresence';
import {
  AmsgDiagnosticsProbe, AmsgFailKind, type AmsgTickReportResult, describeAmsgFetchFailure, parseAmsgDebugReport,
} from './amsgDiagnostics';
import { parseAmsgTickReport } from './amsgTickReport';
// 「這個角色欠著一條即時對話回覆嗎」的兩個原始信號（待收記錄 + 發送在飛）。
// amsgInstantChat 反過來也 import 這個文件，兩邊都只在函數體裡用對方，模塊求值期
// 誰都不碰誰，所以這個環是安全的；換成在這裡另讀一遍 localStorage 才是真麻煩
// （掛起判定就有了兩把尺，而「發送在飛」那半截根本抄不過來，它是內存裡的集合）。
import { getInstantChatPending, isInstantChatSendInFlight } from './amsgInstantChat';
import {
  buildCharChatCredRow,
  buildCharEmotionCredRow,
  buildCharInstantCredRow,
  chunkCredRows,
  forgetAllCredIds,
  forgetCredIds,
  normalizeChatApiUrl,
  pickChangedCredRows,
  rememberCredRows,
  supportsLlmCredentials,
  type LlmCredentialRow,
} from './amsgLlmCredentials';
import {
  chunkClientStateEntries,
  pickSidechannelShellKeys,
  supportsClientStateDelete,
} from './amsgClientStateDelete';
import { observeRemoteStateUpdatedAt, stampStateUpdatedAt } from './amsgStateClock';
import { flattenContentPartsToText } from './promptMessageCleanup';
import { resolveBlobRefsDeep } from './blobRef';
import {
  AMSG_FIRE_PACK_KEY,
  FIRE_PACK_VERSION,
  AMSG_SLOT_AWAY_HINT,
  AMSG_SLOT_CURRENT_TIME,
  AMSG_SLOT_REALTIME_WORLD,
  AMSG_SLOT_SCENE,
  AMSG_SLOT_TASK_INSTRUCTION,
  AMSG2_INSTANT_STUB_TEMPLATE,
  AMSG_INSTANT_CHAT_SUBTYPE,
  AMSG_LAST_SKIP_KEY,
  AMSG_SLOT_SELF_LOG,
  AMSG_SLOT_TASK_LIST,
  AMSG_SLOT_TIME_SINCE_USER,
  AMSG_SLOT_USER_CLOCK,
  AmsgFirePack,
  type AmsgFirePackChatContent,
  type AmsgLastSkip,
  amsgStateNamespace,
  packStateValue,
  parseLastSkip,
} from './amsgFirePack';
import {
  AMSG_BACKGROUND_JOB_SUBTYPE,
  AMSG_JOB_ID_KEY,
  AMSG_JOB_NAMESPACE,
  AMSG_TASK_KIND_KEY,
} from './amsgTaskKinds';
import type { AmsgFireScene } from './amsgFireScene';
import { buildSongPool } from './charMusicSchedule';
import { getDailyScheduleForChar } from './dailySchedule';
import { getLocalDateKey } from './localDate';
import { isScheduleFeatureOn } from './scheduleGenerator';
import {
  AMSG_GLOBAL_NAMESPACE,
  AMSG_TOOL_CONFIG_KEY,
  AMSG_TOOL_PACK_KEY,
  buildToolConfig,
  buildToolPack,
} from './amsgToolPack';
// 只取一個常量：客戶端算 firstSendTime 時要留的提前量，和包裝層「把任務行拉到期」
// 那一步是同一個數，各寫各的就會出現「校驗說時間要在未來 / cron 說還沒到」的死角。
import type { AmsgEmotionEvalSpec } from '../worker/amsg/src/emotionEval';
import { listRecallableMonths } from './agenticTools';
import { ChatPrompts } from './chatPrompts';
import { nowInTimeZone, resolveCharTimeZone, tzAwarenessNote } from './timezone';
import { DB } from './db';
import { copyWorkerBundleToClipboard } from './workerDeploy';
import { collectMcpFireServers, getMcpUseNativeTools } from './mcpClient';
import { safeResponseJson } from './safeApi';
import { ActiveMsgStore } from './activeMsgStore';
import { KeepAlive } from './keepAlive';
import {
  bytesToB64u,
  describePushCapabilityGap,
  isDeadPushEndpoint,
  subscribeWithRetry,
  SUBSCRIBE_SETTLE_MS,
  type SubscribeFailureKind,
} from './pushSubscribeShared';
import { isUnifiedPushPlatform } from './unifiedPushPlugin';

export const NATIVE_PUSH_TOKEN_STORAGE_KEY = 'amsg2_fcm_token_v1';
const nativePushBuildEnabled = () => import.meta.env.VITE_AMSG_NATIVE_PUSH === 'true';
const readNativePushToken = () => nativePushBuildEnabled() && typeof localStorage !== 'undefined'
  && !isUnifiedPushPlatform()
  ? localStorage.getItem(NATIVE_PUSH_TOKEN_STORAGE_KEY)?.trim() || ''
  : '';

export interface ActiveMsg2PushStatus {
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
  hasSubscription: boolean;
  vapidConfigured: boolean;
  detail?: string;
  transport?: 'web-push' | 'unified-push';
  distributor?: string | null;
  needsDistributor?: boolean;
}

/** worker 上登記的那份訂閱（一個用戶一行）。讀不到時調用方拿 null。 */
export interface AmsgRemotePushSubscription {
  exists: boolean;
  endpoint: string | null;
  updatedAt: number | null;
}

/**
 * 「worker 到點會不會推到這台設備」的結論。
 *
 * 中間那兩檔是主動消息最難自己發現的故障：任務建得成、界面全綠、到點一條都不來。
 * 換過 worker（新庫是空的）、或者在另一台設備上登記過（一個用戶只存一份，後來的
 * 頂掉先前的），都會落到這裡。
 */
export type AmsgPushRegistrationState =
  | 'worker-unset'    // 還沒填 Worker 地址，無從談起
  | 'unreachable'     // 問不到 worker（斷網，或那台 worker 沒有這個端點）
  | 'missing'         // worker 上沒有登記
  | 'other-endpoint'  // 登記著，但不是本機這個端點
  | 'matched';        // 登記著，且就是本機

/**
 * 拿本機端點跟 worker 登記的那份對一下。純函數，面板和單測共用同一套判定。
 *
 * 本機還沒訂閱（localEndpoint 為空）時，只要遠端有登記就算 'other-endpoint'——
 * 那份登記確實指向別的地方，說「已登記」會讓用戶以為這台設備收得到。
 */
export const compareRemotePushSubscription = (
  localEndpoint: string | null | undefined,
  remote: AmsgRemotePushSubscription | null,
): AmsgPushRegistrationState => {
  if (!remote) return 'unreachable';
  if (!remote.exists || !remote.endpoint) return 'missing';
  return remote.endpoint === localEndpoint ? 'matched' : 'other-endpoint';
};

/**
 * 庫把載荷加解密留成了私有實現，而分頁拉任務、init-tenant 這類庫沒封裝的端點
 * 得自己組加密載荷，所以按運行時的真實形狀單獨聲明一份，在下面兩個橋接函數里
 * 轉一次。不能寫成 `ReiClient & { _encrypt }`——交叉類型碰上 private 成員會整個
 * 塌成 never，連帶 ReiClient 自己的方法一起查不到。
 */
interface ReiCryptoBridge {
  _encrypt(plaintext: string): Promise<{ iv: string; authTag: string; encryptedData: string }>;
  _decrypt(payload: { iv: string; authTag: string; encryptedData: string }): Promise<any>;
}

const ACTIVE_MSG_RUNTIME_HEADER = '[ActiveMsg2]';

/** amsg-server 的 DELETE /cancel-message 找不到目標行時回的錯誤碼（HTTP 404）。 */
const REMOTE_TASK_NOT_FOUND_CODE = 'TASK_NOT_FOUND';
/** 行還在、但已經跑完出清（sent / failed）時回的錯誤碼（HTTP 409）。 */
const REMOTE_TASK_ALREADY_COMPLETED_CODE = 'TASK_ALREADY_COMPLETED';

// 單用戶模式：所有請求打到用戶自部署的 Cloudflare Worker（config.workerUrl）。
// 配了 serverToken 就每次帶 X-Client-Token；worker 端配了就強制校驗，缺/錯回 401。
const normalizeWorkerBase = (workerUrl: string) => workerUrl.trim().replace(/\/+$/, '');

const createClient = (config: Pick<ActiveMsg2GlobalConfig, 'userId' | 'workerUrl' | 'serverToken'>) =>
  new ReiClient({
    baseUrl: normalizeWorkerBase(config.workerUrl),
    userId: config.userId,
    serverToken: config.serverToken || undefined,
  });

/** 面板新建任務的默認時間：半小時後，折成 datetime-local 認的本地牆鍾。 */
export const getDefaultActiveMsgFirstSendTime = () =>
  toDatetimeLocalValue(new Date(Date.now() + 30 * 60_000).toISOString());

/** amsg-server 對 avatarUrl 的長度上限，超了整條會被拒。 */
const REMOTE_AVATAR_URL_MAX_LENGTH = 2048;

/**
 * 能交給 worker 當推送通知圖標的頭像地址，不合格返回 undefined。
 *
 * worker 只收公網可訪問的 URL（不能是 data: URI，上限 2048 字符）。而本地角色頭像基本都是
 * base64，傳過去必被拒，代價是每排一條任務就在 worker 日誌裡刷一條
 * `avatarUrl 不合法，已置空`。這裡按同一把尺先篩掉——傳了本來也是被置空，通知一樣退回
 * 默認圖標，少一條噪音而已。
 */
export const toRemoteAvatarUrl = (avatar: string | undefined | null): string | undefined => {
  const value = avatar?.trim();
  if (!value || value.length > REMOTE_AVATAR_URL_MAX_LENGTH || /^data:/i.test(value)) return undefined;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
};

// 失敗歸類（AmsgFailKind）連同「把 fetch 異常翻成人話」都住在 ./amsgDiagnostics：
// 那是一份純函數葉子，設置頁的體檢面板也要用同一套判定。這裡原樣轉出去，
// 外面按 `from './activeMsgClient'` 引的地方不用改。
export type { AmsgFailKind } from './amsgDiagnostics';

const FAIL_KIND_PROP = '__amsgFailKind';

/** 給錯誤掛一個失敗代號，原樣拋回去（不改 message、不改類型）。 */
const withFailKind = <T extends Error>(error: T, kind: AmsgFailKind): T => {
  (error as unknown as Record<string, string>)[FAIL_KIND_PROP] = kind;
  return error;
};

/**
 * 讀出失敗代號，沒掛的一律 '其他'。
 * 上報側只該調這個，別自己從 error 上取任何字段——那些是運行時字符串。
 */
export const readAmsgFailKind = (error: unknown): AmsgFailKind => {
  const kind = (error as Record<string, unknown> | null | undefined)?.[FAIL_KIND_PROP];
  return typeof kind === 'string' ? (kind as AmsgFailKind) : '其他';
};

/**
 * worker 自檢的回執（`GET /config-check`，見 worker/amsg/src/index.ts 的 inspectWorkerEnv）。
 * missing 是缺了就跑不起來的，warnings 是能跑但有一塊功能是啞的。
 */
export interface AmsgWorkerEnvReport {
  ok: boolean;
  missing: string[];
  /** worker 生成的整句，含「去哪兒補」，直接顯示給用戶。 */
  message: string;
  warnings: { code: string; message: string }[];
}

/**
 * 問 worker 自己配齊了沒。
 *
 * 拿不到結論一律返回 null，不拋：這個端點是後加的，舊 worker 會回 404；而網絡本身
 * 不通的話，緊接著的 init-tenant 會用它自己那套分類報出來，在這兒搶先報一遍只會讓
 * 用戶同時看到兩條口徑不同的錯誤。
 */
const inspectWorkerConfig = async (config: ActiveMsg2GlobalConfig): Promise<AmsgWorkerEnvReport | null> => {
  try {
    const { status, body } = await fetchWithAuthRaw('config-check', config, { method: 'GET' }, '配置自檢');
    if (status !== 200 || !body?.success) return null;
    // 只認形狀對得上的回執。沒有這個端點的 worker 回什麼的都有（404 只是其中一種），
    // 光看 success 就採信的話，會把一台好 worker 判成「配置缺失」——那比不自檢還糟，
    // 用戶照著提示改哪兒都改不對。形狀不對就當它不支持自檢，走原來的流程。
    const data = body.data;
    if (typeof data?.ok !== 'boolean' || !Array.isArray(data.missing) || !Array.isArray(data.warnings)) {
      return null;
    }
    return data as AmsgWorkerEnvReport;
  } catch {
    return null;
  }
};

/**
 * 拉一次體檢（`GET /debug`）。
 *
 * 跟 inspectWorkerConfig 的差別在於失敗也要有結論：那個是連接流程裡的搶跑一步，拿不到
 * 就退回原流程；這個是用戶主動來看「我到底哪兒沒配對」的，連不上本身就是第一條結論，
 * 嚥下去的話面板會一片空白，比不體檢還難受。
 *
 * 端點是後加的，舊 worker 回 404（或者代理塞回來一段 HTML）。那種情況標成 unsupported——
 * 它只是查不了，不是壞了，報紅會讓人跑去改根本沒錯的配置。
 */
export const fetchWorkerDiagnostics = async (): Promise<AmsgDiagnosticsProbe> => {
  let config: ActiveMsg2GlobalConfig;
  try {
    config = await ensureWorkerReady();
  } catch (error: any) {
    return { reachable: false, reason: error?.message || '還沒填 Worker 地址。' };
  }

  try {
    // 自帶超時：連不上 Cloudflare 時 TCP 可以乾等幾十秒，而這個面板正是用戶來問
    // 「到底怎麼了」的地方——轉圈轉到天荒地老跟沒有體檢沒區別。超時會被翻成
    // 「等太久」那一句，它跟「不通」的處理辦法本來就不一樣。
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(8000) : undefined;
    const { status, body } = await fetchWithAuthRaw('debug', config, { method: 'GET', signal }, '體檢');
    const report = parseAmsgDebugReport(body);
    if (report) return { reachable: true, report };

    // 401/403 是真配錯了（共享密鑰兩邊對不上），不是「版本舊」——標成 unsupported
    // 會讓人跑去點更新，而更新一遍照樣進不來。
    if (status === 401 || status === 403) {
      return { reachable: false, reason: `Worker 拒絕了這次請求（HTTP ${status}），多半是共享密鑰兩邊對不上。` };
    }
    // 200 但形狀對不上，跟 404 一樣都是「這台 worker 上沒有這個端點」。
    return {
      reachable: false,
      unsupported: true,
      reason: 'Worker 上跑的代碼還沒有體檢端點。回你 fork 的 sullyos-workers 點一下 Sync fork，或者用上面的「更新 Worker」，之後再來看。',
    };
  } catch (error: any) {
    // fetchWithAuthRaw 拋出來的已經是人話了（見 amsgDiagnostics 的 describeAmsgFetchFailure）。
    return { reachable: false, reason: error?.message || '連不上 Worker。' };
  }
};

/**
 * 拉一次定時任務細帳（`GET /tick-report`，形狀見 amsgTickReport.ts）。
 *
 * 體檢「定時任務」那一行靠它把「到點沒發」拆成逐條的原因。跟 /debug 並排拉，所以
 * 失敗也不拋：那一行照舊按 /debug 的兩個數給籠統結論，這裡的原因掛在下面，
 * 讓人知道為什麼沒有逐條的。
 */
export const fetchWorkerTickReport = async (): Promise<AmsgTickReportResult> => {
  let config: ActiveMsg2GlobalConfig;
  try {
    config = await ensureWorkerReady();
  } catch (error: any) {
    return { ok: false, reason: error?.message || '還沒填 Worker 地址。' };
  }

  try {
    // 超時的理由同 fetchWorkerDiagnostics：兩邊是一起等的，這邊乾等會拖住整塊體檢。
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(8000) : undefined;
    const { status, body } = await fetchWithAuthRaw('tick-report', config, { method: 'GET', signal }, '體檢');
    const report = status === 200 ? parseAmsgTickReport(body) : null;
    if (report) return { ok: true, report };

    if (status === 401 || status === 403) {
      return { ok: false, reason: `Worker 拒絕了讀定時任務細帳的請求（HTTP ${status}），多半是共享密鑰兩邊對不上。` };
    }
    // 端點在、但查的時候自己出了錯（讀庫失敗之類）：這跟「代碼太舊」是兩回事，原話帶上。
    if (status >= 500) {
      const message = typeof body?.error?.message === 'string' ? body.error.message : '';
      return { ok: false, reason: `Worker 查定時任務細帳時出錯了（HTTP ${status}）${message ? `：${message}` : '。'}` };
    }
    // 404，或者 200 但形狀對不上：這台 Worker 上還沒有這個端點。
    return { ok: false, reason: '沒拿到每條任務的細帳（Worker 上的代碼可能還不是最新，點上面的「更新 Worker」）。' };
  } catch (error: any) {
    return { ok: false, reason: error?.message || '連不上 Worker。' };
  }
};

/**
 * 後端自更新的回執（`POST /self-update`，見 worker/amsg/src/selfUpdate.ts）。
 * supported 為 false 表示這台 worker 還是舊版、根本沒有這個端點。
 */
export interface AmsgSelfUpdateResult {
  ok: boolean;
  supported: boolean;
  /** 直接顯示給用戶的整句，成功和失敗都有。 */
  message: string;
  /** 新代碼的指紋，成功時才有，拿來當「現在跑的是哪一版」。 */
  bundleHash?: string;
  /**
   * worker 掛在哪一步的代號（`CF_TOKEN_MISSING` / `UPLOAD_FAILED` 之類）。
   * 面板據此決定要不要露出「補裝更新能力」那一塊——缺鑰匙是唯一能就地解決的一種。
   */
  code?: string;
}

/**
 * 後台任務的定時觸發（Worker 的 cron trigger）現在開著沒有（`GET /cron-trigger`，
 * 見 worker/amsg/src/cronTrigger.ts）。
 * supported 為 false 是端點在、但 Worker 自己查不了（多半是沒配 CF_API_TOKEN），code 說明卡在哪。
 */
export interface AmsgCronTriggerState {
  supported: boolean;
  /** 開著 = true。supported 為 false 時沒有這一項。 */
  enabled?: boolean;
  /** worker 報的代號（`CF_TOKEN_MISSING` / `SCRIPT_NAME_UNKNOWN` 之類），supported 為 false 時才有。 */
  code?: string;
  /** 給人看的一句，supported 為 false 時才有。 */
  message?: string;
}

/** init-tenant 沒成功時按 HTTP 狀態歸類：三種狀態要用戶去改的地方完全不同。 */
const resolveInitFailKind = (status: number): AmsgFailKind => {
  if (status === 401 || status === 403) return '鑑權失敗';   // 共享密鑰兩邊對不上
  if (status === 404) return '端點不存在';                   // 地址不對，或 worker 是舊版
  return '建表失敗';                                         // 多半是沒綁 D1（變量名 DB）
};

/**
 * 最近一次用過的 Worker 地址，只拿來把域名寫進給人看的報錯裡。
 *
 * 報錯想說清「連不上的是哪兒」，可有幾條拋錯路徑手上只有 client 沒有 config
 * （取 VAPID 公鑰、登記訂閱）。為它們逐層加參數不划算——這個值不參與任何判定，
 * 錯了也只是那句話裡少個域名。凡是走 ensureWorkerReady 的路徑都會先更新它。
 */
let lastKnownWorkerUrl = '';

const normalizeActiveMsgApiError = (error: unknown, phase: string, workerUrl?: string | null) => {
  const described = describeAmsgFetchFailure(error, phase, workerUrl || lastKnownWorkerUrl);
  // 儘量沿用原來那個異常對象（調用方可能還看它別的字段），只把給人看的那句話換掉。
  const normalized = error instanceof Error ? error : new Error(described.message);
  normalized.message = described.message;
  return withFailKind(normalized, described.kind);
};

const ensureGlobalReady = async (): Promise<ActiveMsg2GlobalConfig> => {
  const userId = await ActiveMsgStore.ensureUserId();
  const config = await ActiveMsgStore.getGlobalConfig();
  if (config.workerUrl?.trim()) lastKnownWorkerUrl = config.workerUrl;
  return { ...config, userId };
};

const ensureWorkerReady = async () => {
  const config = await ensureGlobalReady();
  if (!config.workerUrl.trim()) {
    throw withFailKind(new Error('請先在系統設置裡填寫「主動消息 2.0」的 Worker 地址。'), '地址沒填');
  }
  return config;
};

// 握手結果按配置記憶化：init()（get-user-key）是一次真網絡往返，而用戶密鑰不變——
// 即時對話把它放上了發送熱路徑（拿到 202 之前的串行延遲）和 60s 狀態點名（一跳最多
// 兩次），逐次重新握手純屬白付 RTT。鍵取會影響握手的三個字段；配置一變（換 worker /
// 換密鑰 / 清空重連）鍵就換，舊緩存自然作廢。失敗的握手不緩存，下一次重新來過。
/**
 * 「這台 worker 認不認識後台任務」的探測結果（見 probeBackgroundJobSupport）。
 * 只在內存裡存，換 workerUrl 自然作廢——用戶中途換後端時不該拿舊結論當數。
 */
let backgroundJobProbe: { workerUrl: string; supported: boolean; at: number } | null = null;

/**
 * 存量答案是「不支持」時，最多隔這麼久就再問一遍。
 *
 * 下面那個 forget 只蓋得住「在設置頁點按鈕更新 Worker」這一條路，而換 bundle 不止這
 * 一條：文檔裡那條 GitHub「Sync fork」→ Cloudflare Workers Builds 更新完，地址沒變、
 * 整個過程也不經過前端，緩存裡那句「不支持」就會一直活到用戶刷新頁面為止——這段時間
 * 每一輪消化都在前台跑那一兩分鐘的整理，頁面一關就死。即時對話那條探測對同樣的狀態
 * 就是「存著 false 就重探」（見 reprobeInstantChatSupport）。
 *
 * 正面答案不設冷卻：一份認識後台任務的 bundle 不會自己變回不認識。
 */
const BACKGROUND_JOB_UNSUPPORTED_RECHECK_MS = 5 * 60_000;

/**
 * 把探測結論作廢，下次重新問一遍。
 *
 * 緩存是按 workerUrl 鍵的，而「更新 Worker」換的是同一個地址上的 bundle——地址沒變，
 * 結論卻過期了。不作廢的話用戶剛把後端升上去，前端還認著升級前那句「不支持」，得刷新
 * 頁面才好。所以凡是**在同一個地址上換 bundle** 的路徑都要調一次：設置頁的「重新連接
 * 並驗證」、以及「更新 Worker」（POST /self-update）。
 *
 * 從零部署那條路不用調：它換的是 workerUrl 本身，鍵一變舊緩存自然作廢。
 */
export const forgetBackgroundJobProbe = (): void => { backgroundJobProbe = null; };

/**
 * 後台任務能力探測的三種結論。
 *
 * `unsupported` 和 `unknown` 分開是有用的：前者是「這條路斷了」（老 bundle，重試也一樣），
 * 後者是「這次沒問到」（網絡抖一下、CF 邊緣抽風、D1 冷啟動超時）。調用方對這兩種的處置
 * 不一樣——路斷了就該退回本地把活兒幹了，而只是沒問到時，手上要是還有一份任務在雲端跑，
 * 退回本地就是拿同一份快照再燒一次 API、兩份結果先後落地互相蓋。
 */
export type BackgroundJobProbeOutcome = 'supported' | 'unsupported' | 'unknown';

const BACKGROUND_JOB_MAYBE_CREATED_PROP = '__amsgBackgroundJobMaybeCreated';

/**
 * 這次失敗的後台任務，**有沒有可能其實已經在遠端建起來了**。
 *
 * 只有「`POST /schedule-message` 發出去之後沒等到答覆」才算——那一刻請求可能已經到了
 * 服務端。服務端答覆了「不行」不算（確定沒建），上傳輸入、傳憑據那幾步失敗也不算
 * （它們排在建任務之前）。
 *
 * 調用方靠它區分「沒交出去」和「不知道交沒交出去」：前者該退回本地把活兒幹了，後者
 * 絕不能——那會拿同一份快照在兩條路上各跑一次，白燒一次 API，兩份結果還先後落地互相蓋。
 */
export const mayHaveCreatedBackgroundJob = (error: unknown): boolean =>
  (error as Record<string, unknown> | null | undefined)?.[BACKGROUND_JOB_MAYBE_CREATED_PROP] === true;

let cachedClientEntry: { key: string; promise: ReturnType<typeof createAndInitClient> } | null = null;

/**
 * 作廢握手緩存，下一次調用重新 get-user-key。
 *
 * 記憶化的鍵只認「地址 / 用戶 id / 共享密鑰」，可雲端的用戶密鑰還能在這三樣都不變的
 * 情況下換代 —— 用戶在 Cloudflare 上換掉 AMSG_MASTER_KEY 就是。所以凡是「用戶密鑰
 * 可能已經不是剛才那把」的動作（重新連接、清空雲端狀態）都得先過這裡，否則緩存裡
 * 那條 client 握著舊密鑰，加密調用發出去 worker 一條都解不開。
 */
const invalidateClientCache = () => { cachedClientEntry = null; };

const createAndInitClient = async (config: ActiveMsg2GlobalConfig) => {
  const client = createClient(config);
  try {
    await client.init();
  } catch (error) {
    throw normalizeActiveMsgApiError(error, '獲取用戶密鑰', config.workerUrl);
  }
  return client;
};

const initializeClient = (config: ActiveMsg2GlobalConfig) => {
  const key = `${config.workerUrl}|${config.userId}|${config.serverToken ?? ''}`;
  if (cachedClientEntry?.key === key) return cachedClientEntry.promise;
  const promise = createAndInitClient(config);
  cachedClientEntry = { key, promise };
  promise.catch(() => {
    if (cachedClientEntry?.promise === promise) cachedClientEntry = null;
  });
  // 順手刷一次即時對話的能力位（結果存進全局配置，見 probeInstantChatSupport）。
  // 掛在這裡是因為這是「一次會話一次」的天然位置：握手按配置記憶化，換 worker / 換密鑰
  // 才會重來。設置頁那一處探測只覆蓋打開過設置頁的人——而最需要被糾正的恰恰是那批
  // 「裝好之後再沒進過設置頁、Worker 還停在舊版」的人。
  // 不 await：它只影響**之後**幾輪的路由判斷，拿它擋住握手等於給每條消息加一次 RTT。
  void ActiveMsgClient.probeInstantChatSupport().catch(() => {});
  // 同理順手探一次按特性位存的幾個結論（憑據存表 credRefs、雲端狀態刪行，見
  // probeWorkerFeatures）。探不到就按老路走，不影響任何一條消息發出去。
  void ActiveMsgClient.probeWorkerFeatures().catch(() => {});
  return promise;
};

/**
 * 生效憑據優先級：角色自己開了「使用單獨 API」→ 那份單獨 API；否則 → 角色自己的
 * 對話模型 chatApi（跟私聊用的是同一份，角色沒單獨設過就是 undefined）；否則 → 全局主 API。
 * 中間這層是補的——之前直接跳到全局主 API，角色明明設了專屬 chatApi，全局 API 一掛
 * 該角色的主動消息照樣全滅，跟下面這句 UI 文案「複用當前聊天主 API」對不上。
 */
const resolveApiConfig = (char: CharacterProfile, config: ActiveMsg2CharacterConfig, apiConfig: APIConfig) => {
  const useSecondary = config.useSecondaryApi && config.secondaryApi?.baseUrl;
  const source = useSecondary ? config.secondaryApi! : resolveCharacterChatApi(char, apiConfig);

  if (!source.baseUrl || !source.apiKey || !source.model) {
    throw new Error('主動消息 2.0 缺少可用的 API URL / Key / Model。');
  }

  return source;
};

/**
 * 一個角色的 AI 任務此刻該用的憑據補丁（update-message 載荷）。
 * 生效憑據的算法與排程時同一份 resolveApiConfig：單獨 API → 角色自己的 chatApi → 全局主
 * API——憑據刷新絕不能把單獨 API / 角色專屬 API 的任務蓋成全局憑據。
 * 憑據配不齊（比如單獨 API 缺字段）沿用 resolveApiConfig 的拋錯，調用方按角色記失敗。
 */
const resolveTaskCredentialUpdates = (
  char: CharacterProfile,
  config: ActiveMsg2CharacterConfig,
  apiConfig: APIConfig,
): Record<string, unknown> => {
  const active = resolveApiConfig(char, config, apiConfig);
  return {
    apiUrl: normalizeChatApiUrl(active.baseUrl),
    apiKey: active.apiKey,
    primaryModel: active.model,
  };
};

// ─── LLM 憑據引用（credRefs）───
//
// 走不走這條路只判一處：這台 worker 的 capabilities 裡有沒有 'llm-credentials'。
// 達標就把憑據存成表裡的一行、任務只帶名字；不達標原樣走「憑據凍結進任務」的老路。
// 結論跟即時對話那個能力位一樣存進全局配置（握手時探一次），發消息 / 排程的路上
// 不做逐次網絡預檢——那等於給每條消息加一次 RTT。

/**
 * 這台 worker 現在走不走 credRefs。**整個前端的版本門檻只有這一處。**
 *
 * undefined（還沒探過）按 false 處理：老路在哪台 worker 上都能跑，寧可這一輪多凍結
 * 一份憑據，也不要拿新寫法去撞一台還不認識它的 worker（那是排程直接 400）。
 * 握手時會補探一次，之後就有準數了。
 */
export const isLlmCredentialsReady = async (): Promise<boolean> => {
  try {
    return (await ActiveMsgStore.getGlobalConfig()).llmCredentialsSupported === true;
  } catch {
    return false;
  }
};

/**
 * 這台 worker 現在認不認 `PUT /client-state` 裡 `value: null` 的刪行語義
 * （能力位 'client-state-delete'，握手時探一次存進全局配置，見 probeWorkerFeatures）。
 *
 * undefined（還沒探過）按 false 處理：寫空串在哪台 worker 上都能跑，而 null 發到
 * 老 worker 上是逐條被拒。取回旁路內容後的清理、刪角色、存量空殼清理三處都讀這一份。
 */
export const isClientStateDeleteReady = async (): Promise<boolean> => {
  try {
    return (await ActiveMsgStore.getGlobalConfig()).clientStateDeleteSupported === true;
  } catch {
    return false;
  }
};

/**
 * 把這幾行憑據傳上去，**只傳真的變了的那些**（指紋底帳見 amsgLlmCredentials）。
 *
 * force 用在「雲端說這行不存在」的自愈路徑上：那時本地底帳是髒的（記著傳過、實際沒有），
 * 必須繞過指紋。傳成功才記帳——記早了就會把一次失敗的上傳當成已生效。
 */
const putLlmCredentialRows = async (
  rows: LlmCredentialRow[],
  options: { force?: boolean } = {},
): Promise<number> => {
  const pending = options.force ? rows : pickChangedCredRows(rows);
  if (pending.length === 0) return 0;
  const globalConfig = await ensureWorkerReady();
  const client = await initializeClient(globalConfig);
  for (const batch of chunkCredRows(pending)) {
    const response = await client.putLlmCredentials(batch);
    if (!response?.success) {
      throw new Error(response?.error?.message || '登記 LLM 憑據失敗。');
    }
    // 逐批記帳：後面那批失敗時，前面已經落地的不必再傳一遍。
    rememberCredRows(batch);
  }
  return pending.length;
};

const formatHistoryLine =(role: string, content: any, char: CharacterProfile, userProfile: UserProfile) => {
  const speaker = role === 'assistant' ? char.name : role === 'user' ? userProfile.name : '系統';
  // 富內容（視覺模型的 [{type:'text'},{type:'image_url'}] 格式）按 part 類型拍平：
  // 文本部分照抄，圖片部分壓成 [圖片] 佔位，別的類型丟掉——不能整段 JSON.stringify，
  // 那樣會把 image_url 裡幾百 KB 的 base64 一字不差焊進模板，排程任務的載荷直接體積炸彈。
  // 與 worker 側 restoreEvalPrompt 用的 flattenContent（worker/amsg/src/emotionEval.ts）
  // 同一套壓法，但這裡保留原有的 '\n' 分段（這份模板本來就一行一段，跟 worker 那邊
  // 拼單行摘要的 ' ' 連接不是同一個用途，故不跟隨其分隔符）。
  const text = Array.isArray(content)
    ? content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part.text || '';
        if (part?.type === 'image_url') return '[圖片]';
        return '';
      })
      .filter(Boolean)
      .join('\n')
    : String(content || '');
  return `【${speaker}】\n${text.trim()}`;
};

const buildTimeGapHint = async (charId: string) => {
  const recentMessages = await DB.getRecentMessagesByCharId(charId, 200);
  return {
    // 時間差在渲染時刻才算（formatTimeSinceUser），這裡只取原始時間戳——
    // 滿血鏈路會把它放進 fire_pack，worker 到點用「fire 時刻」重算，不吃排程時的陳舊值。
    // 「真實用戶消息」判定與防穿幫閘共用同一葉子 helper（見 amsg2ExpireGuard）。
    lastUserMessageAt: getLastRealUserMessageAt(recentMessages),
    recentMessages,
  };
};

// 時間性內容留槽位（AMSG_SLOT_*），由 worker 在 fire 時刻用 renderFirePack 填。
// 文案模板本身仍在前端這份代碼裡維護。
// includeTime：角色關掉「時間感知」時，這一段裡報鐘的兩行連槽位一起不進模板
// （見 buildFirePack 的同名判斷）。
const buildLegacyStyleProactiveHint = (targetName: string, includeTime: boolean) => {
  const target = targetName || '對方';

  return [
    '【1.0 風格主動消息提示】',
    ...(includeTime ? [`現在是 ${AMSG_SLOT_CURRENT_TIME}。`, AMSG_SLOT_AWAY_HINT] : []),
    `這不是 ${target} 正在和你聊天，而是你突然想起了 ${target}，想主動發條消息給他/她。`,
    `像真人隨手發消息一樣自然一點，可以是分享剛看到的東西、輕輕吐槽、問一句近況、突然想念，或者單純想找 ${target} 聊兩句。`,
    `${target} 不在的這段時間，你自己的日子也在往前過：剛發生的小事、注意到的細節、對之前聊過的話冒出來的後續想法，都比干巴巴的問候更像你。`,
    '不要寫成彙報近況，不要像在完成任務，也不要解釋自己為什麼會發這條消息。',
    `關心別變成查崗：不催問 ${target} 在幹嘛、怎麼還不回；喝水、早睡這類叮囑偶爾一句是心意，回回都發就成了說教。`,
    `正文儘量短，通常 1 到 2 句就夠；如果 ${target} 很久沒來找你，可以輕輕帶一點想念、好奇或者小小抱怨。`,
  ].join('\n');
};

// 拼出帶時間槽位的完整 prompt 模板（fire_pack）：原樣 putClientState 上雲，
// worker 到點用 renderFirePack 填槽（所以上下文永遠是最後一次聊天的狀態）。
/**
 * 表情包全庫（按角色過濾前）。批量同步時由調用方讀一次傳進來——它跟角色無關，
 * 一個角色讀一遍的話，N 個角色就是 N 次全表 getAll，讀回來的還是同一份。
 */
type EmojiLibrary = { all: Emoji[]; categories: EmojiCategory[] };

const readEmojiLibrary = async (): Promise<EmojiLibrary> => {
  const [all, categories] = await Promise.all([DB.getEmojis(), DB.getEmojiCategories()]);
  return { all, categories };
};

// export 只為單測（activeMsgClient.test.ts 釘 tzId 取值與模板不烤時間）。
export const buildFirePack = async (
  char: CharacterProfile,
  userProfile: UserProfile,
  groups: GroupProfile[],
  realtimeConfig: RealtimeConfig | undefined,
  emojiLibrary?: EmojiLibrary,
  opts?: {
    /**
     * 用佔位模板替代真模板（跳過系統提示詞 + 近史轉寫 + 表情全庫讀取這三樣大頭）。
     * 只許在「這份包的模板確定無人渲染」時傳：即時對話發送路徑上，角色 2.0 關著
     * （selfScheduleEnabled=false，雲端 fire 不給排程能力）且本地任務清單為空。
     * 其餘字段（scene / lastUserMessageAt / pendingTasks / tzId…）照常構建——
     * 即時 fire 自己要讀它們（sceneSong、錨點、任務清單塊）。
     */
    templateStub?: boolean;
  },
): Promise<AmsgFirePack> => {
  const templateStub = opts?.templateStub === true;
  const [{ lastUserMessageAt }, recentMessages, library, schedule] = await Promise.all([
    buildTimeGapHint(char.id),
    templateStub ? Promise.resolve([]) : loadCharacterContextMessages(char),
    // 表情庫只喂系統提示詞/近史渲染：佔位模板路徑整庫都不用讀（表情記錄帶圖片數據，
    // 全表 getAll 不便宜）。
    templateStub
      ? Promise.resolve({ all: [], categories: [] } as unknown as EmojiLibrary)
      : (emojiLibrary ? Promise.resolve(emojiLibrary) : readEmojiLibrary()),
    // 日程隨包帶原始表（不是渲染好的文字），worker 到點自己挑時段。總開關關掉的角色沒有表。
    isScheduleFeatureOn(char)
      ? getDailyScheduleForChar(char).catch((e) => {
          console.warn('[ActiveMsg2] 日程讀取失敗，這次不帶作息表', char.id, e);
          return null;
        })
      : Promise.resolve(null),
  ]);
  // 角色的時間參照系：開了自定義時區用角色的，沒開用設備的。worker 渲染一切給角色看的
  // 時間（當前時間、日程日期、排程清單）都按它來。
  const charTz = resolveCharTimeZone(char);
  const tzId = charTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // 用戶設備自己的鐘。跟 tzId 分開存：角色排消息時得知道「對方那邊現在幾點」，
  // 不然異國戀角色會把「晚上聊兩句」排到用戶的凌晨三點，而且沒有任何線索能讓它避開。
  const userTzId = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // 時間相關的行整塊跟著角色的「時間感知」開關走：關掉的角色在前台連今天幾號都讀不到
  // （buildTimeAwarenessBlock 直接返回空串），主動消息這邊卻精確報出年月日 + 星期，
  // 是同一個開關的兩套行為。關掉時這幾行連槽位一起不進模板。
  // 排程工具的 send_at 說明不受影響（那份在 amsgFireSchedule）：排時間本來就得知道現在幾點。
  const timeAware = char.timeAwarenessEnabled !== false;
  // 只摘渲染會讀到的字段：整份日程裡還掛著每個時段緩存的小劇場台詞和看板圖，
  // 帶上去只是白佔雲端狀態的體積（fire_pack 本來就有幾萬字）。
  const scene: AmsgFireScene | null = schedule
    ? {
        charId: char.id,
        // 這份表是角色當地「今天」的安排，到點先比日期再用（見 renderFireSceneBlock）。
        dateKey: getLocalDateKey(nowInTimeZone(tzId)),
        schedule: {
          slots: schedule.slots.map((s) => ({
            startTime: s.startTime,
            activity: s.activity,
            ...(s.description ? { description: s.description } : {}),
            ...(s.emoji ? { emoji: s.emoji } : {}),
            ...(s.location ? { location: s.location } : {}),
            ...(s.innerThought ? { innerThought: s.innerThought } : {}),
          })),
          ...(schedule.flowNarrative ? { flowNarrative: schedule.flowNarrative } : {}),
        },
        songPool: buildSongPool(char).map((s) => ({ id: s.id, name: s.name, artists: s.artists })),
      }
    : null;
  const legacyHint = buildLegacyStyleProactiveHint(userProfile.name || '對方', timeAware);
  // 前台每輪都注入的時差說明（「你身處 X 時區……對方可能在不同時區」）。它是靜態文案、
  // 不隨時間變，所以打包時就烤進模板；到點由 AMSG_SLOT_USER_CLOCK 補上「對方那邊現在
  // 幾點」。fire 側的角色設定是 skipTimeAwareness 建的，整塊時間感知都被抹掉了，
  // 不在這裡補回來的話，最容易撞用戶睡覺的恰恰是主動消息。
  const tzNote = timeAware ? tzAwarenessNote(charTz).trim() : '';
  // 按角色可見性過濾表情包：主動消息不經過 Chat.tsx 的 aiVisibleEmojis/visibleCategories，
  // 必須在這裡複用同一套過濾，否則角色會用到只對其他角色開放的表情包。
  const { emojis, categories } = ChatPrompts.filterVisibleEmojis(
    library.all,
    library.categories,
    char.id,
  );
  const systemPrompt = templateStub ? '' : await ChatPrompts.buildSystemPrompt(
    char,
    userProfile,
    groups,
    emojis,
    categories,
    recentMessages,
    realtimeConfig,
    undefined,
    undefined,
    undefined,
    undefined,
    // 模板是現在打好、到點才渲染的，凡是「打包這一刻」的狀態都不烤進去。
    // 具體拿掉哪些塊、到點由誰補，見 ChatPrompts.PromptBuildOptions 上的表。
    { forFirePack: true },
  );
  const recentTranscript = templateStub ? '' : ChatPrompts.buildMessageHistory(
    recentMessages,
    Math.max(1, recentMessages.length),
    char,
    userProfile,
    emojis,
  ).apiMessages
    .map((message) => formatHistoryLine(message.role, message.content, char, userProfile))
    .join('\n\n');

  // 記憶庫裡有哪些月份查得到 —— 提示詞一直在教角色用 [[RECALL: 年-月]]，卻沒說過
  // 哪些月份有東西。不報菜單的話它多半不查，直接憑空編一段「回憶」出來。
  // 只寫進下面這段主動消息自己的規則裡，不動 chatPrompts 那條所有角色每輪都走的主鏈路。
  const recallableMonths = listRecallableMonths(char.memories);
  const recallHint = recallableMonths.length > 0
    ? `- 你的記憶庫裡存著這些月份的經歷：${recallableMonths.join('、')}。想聊起其中某段時，先輸出 [[RECALL: 年-月]] 把細節取回來再寫，別憑印象編。`
    : null;

  const template = templateStub ? AMSG2_INSTANT_STUB_TEMPLATE : [
    '你將代表下面這個角色，生成一條“主動發給用戶”的私聊消息。',
    '',
    '【重要規則】',
    '- 這不是回覆用戶剛剛發來的消息，而是角色主動來找用戶聊天。',
    '- 輸出只能是最終要發送的消息正文，不要解釋，不要寫分析，不要加引號。',
    '- 像真實聊天一樣簡短自然，優先 1 到 2 句，最多 3 句。',
    '- 可以用換行拆成多個聊天氣泡，但不要寫時間戳、名字前綴、系統提示。',
    '- 不要出現“作為AI”“系統提示”等元話語。',
    '- 語氣更像真人突然想起對方時發來的私聊，不要像在完成任務。',
    '- 角色設定裡描述的查記憶、讀日記、聯網搜索、逛小紅書等能力照常可用：需要時正常輸出對應標籤，系統會取回結果後讓你繼續寫。',
    ...(recallHint ? [recallHint] : []),
    '',
    '【角色系統設定】',
    systemPrompt,
    `（注意：上面角色設定裡的情緒、印象等狀態是最近一次聊天時的快照。${timeAware ? '此刻的時間、你正在做什麼' : '你此刻正在做什麼'}，以下方「當前時刻補充」為準。）`,
    '',
    '【最近對話上下文】',
    // 槽位直接黏在最後一行後面（不單獨佔一行）：worker 到點沒有可寫的自述時填空串，
    // 輸出跟沒這個槽位一模一樣；有內容時那段自帶前導空行，見 renderSelfLogBlock。
    `${recentTranscript || '（暫時沒有最近聊天記錄）'}${AMSG_SLOT_SELF_LOG}`,
    '',
    // 「此刻在做什麼」緊跟當前時間：日程時段本來就要對著鍾讀，挨在一起才對得上。
    // 沒日程的角色 worker 填空串，這一行連帶消失（那段自帶前導空行，見 renderFireSceneBlock）。
    // 時區那兩行也挨著鍾：靜態說明打包時就烤好，「對方那邊現在幾點」由 worker 到點現算——
    // 一個是角色自己的鐘、一個是用戶的鐘，各自把主語寫在文案裡，別讓模型以為在打架。
    ...(timeAware
      ? [
          '【當前時刻補充】',
          `當前本地時間（你所在地）：${AMSG_SLOT_CURRENT_TIME}${tzNote ? `\n${tzNote}` : ''}${AMSG_SLOT_USER_CLOCK}${AMSG_SLOT_SCENE}`,
        ]
      // 關了時間感知的架空角色：整段只剩「你在做什麼 / 外面什麼樣」，一個鐘都不給。
      : [`【當前時刻補充】${AMSG_SLOT_SCENE}`]),
    // 排程清單跟在時間後面：它整段都在講「幾點會發生什麼」，挨著當前時刻讀才對得上。
    // 沒有待觸發任務時 worker 填空串，這一行連帶消失。
    // 最後是「外面的世界此刻什麼樣」（節日 / 天氣 / 熱搜）：跟時間同屬「此刻的讀數」，
    // 一樣由 worker 到點現拉現填，拉不到就整段消失。
    `${timeAware ? AMSG_SLOT_TIME_SINCE_USER : ''}${AMSG_SLOT_TASK_LIST}${AMSG_SLOT_REALTIME_WORLD}`,
    '',
    legacyHint,
    '',
    '【本次任務】',
    AMSG_SLOT_TASK_INSTRUCTION,
    '',
    // 「這件事是不是已經聊過了」是語義問題，只有看得到完整對話的角色判得了。代碼那道閘
    // （utils/amsg2ExpireGuard.ts）只判「到點那會兒用戶在不在聊天」這一件確定的事——早先
    // 它還兼管一次性任務的「排完之後用戶再開過口就作廢」，那條規則沒有時間窗，跨夜任務
    // 幾乎必然被誤殺，現在整條交給這裡。
    // 判據必須是「這件事發生過沒有」這種能對照上下文查證的事實。寫成「你覺得合不合適」
    // 的話，模型會拿「怕打擾」「時機不太對」當理由沉默，主動消息就整體啞掉了。
    // 一個字都不輸出 → worker 走 skip-push 出口：不推送、不佔連發額度、面板照實說明。
    '【開口之前】',
    '先對照上面的【最近對話上下文】：這條任務要說的事，是不是已經在你們的對話裡發生過、或者已經聊完了？',
    '已經發生過 → 什麼都不要輸出。一個字都不要寫，也不要解釋自己為什麼不說。這次就當沒有這條任務。',
    '還沒發生 → 照常說你要說的話。',
    '判據只有「這件事發生過沒有」這一條。不要因為「怕打擾」「時機好像不太對」而沉默，那些不歸你判。',
    '',
    // recency 末位人聲錨：上面【角色系統設定】裡已帶「回到你自己」鋼印，但被任務說明壓在後面、
    // 失了 recency。這裡在最後一句把它拎回來，讓主動消息也從「你這個人」長出來，而不是滑回均值腔。
    `（開口前回到你自己：這條得是 ${char.name} 會發的那一條——語氣、用詞、節奏都只屬於你。哪怕只是隨口一句，也要是你。）`,
  ].join('\n');

  return {
    // 版本號只有 amsgFirePack 那一份說了算：寫死數字的話，升版時 worker 側的 parseFirePack
    // 已經在按新號校驗，而這裡還發著舊號，表現是每條任務到點都硬失敗。
    v: FIRE_PACK_VERSION,
    template,
    lastUserMessageAt,
    // 角色的時間參照系（見上面的 tzId / userTzId）：前者是角色自己的鐘，後者是用戶那邊的，
    // worker 渲染時兩者各管各的一行，絕不混用。
    tzId,
    userTzId,
    targetName: userProfile.name || '對方',
    // 這份模板的身份戳：worker 用它判斷雲端自述日誌裡哪些正文已經進了新轉寫、
    // 自排任務備帳還配不配得上當前清單（見 amsgFirePack 的 reconcileSelfLogWithPack）。
    // 每打一次包都是新值。
    builtAt: Date.now(),
    // 角色級 2.0 開關隨包上雲：關著的角色即便走即時對話（全局開關是另一顆），雲端
    // fire 也不給排程能力——本地的 amsg2ToolsInjected 閘門在雲端的對應物就是它。
    selfScheduleEnabled: isAmsg2EnabledForChar(char),
    // 到點時角色要知道自己還掛著什麼，才不會把同一件事再排一遍。這裡帶原始記錄，
    // 渲染成人話由 worker 現場做（時間要按 tzId 換算，且得摘掉正在發的那條）。
    pendingTasks: getPendingTasks(char.activeMsg2Config, Date.now()),
    // 「此刻在做什麼」也帶原始素材：整天的作息表 + 歌單抽樣池，worker 到點按 tzId
    // 挑當前時段。烤成文字的話，凌晨三點觸發時角色會說「我在健身房呢」。
    scene,
  };
};

/**
 * 按任務生成「本次任務」指令——排程時寫進 task metadata，worker 到點填槽。
 * 實現搬到了 amsgFireSchedule（worker 也要用同一份），這裡轉出去保持調用方不動。
 */
export { buildTaskInstruction } from './amsgFireSchedule';

/**
 * 首次發送時間 → 絕對時刻（UTC ISO）。
 *
 * 裸牆鍾（`2026-08-03T09:00:00`，datetime-local 輸入框和角色用工具排程時給的都是這種）
 * 按 tz 參照系解釋，跟 worker 到點解析 send_at 是同一份規則（amsgFireSchedule.resolveSendAtMs）。
 * 各解各的話，紐約角色說的「明早九點」，前端按設備的東八區算成絕對時刻，worker 又按
 * 角色時區去理解，同一句話差整整一個時差。帶 Z / ±hh:mm 後綴的照標註解析。
 */
const ensureFutureTime = (value: string, tzId: string) => {
  const ms = resolveSendAtMs(value, { tzId });
  if (Number.isNaN(ms)) {
    throw new Error('請選擇有效的首次發送時間。');
  }
  if (ms <= Date.now()) {
    throw new Error('首次發送時間必須晚於當前時間。');
  }
  return new Date(ms).toISOString();
};

/**
 * 任務體裡 messages 的佔位內容。
 *
 * 服務端要求「completePrompt 或 messages」二選一、messages 非空、content 非空字符串，
 * 所以哪怕真正的 prompt 是到點才由 worker 下發的，排程時也得塞點東西過校驗。
 * 寫成一眼能認出來的標記：它要是出現在 worker 日誌、模型輸出或者聊天氣泡裡，
 * 就說明 worker 的 fire hooks 沒生效（正常路徑下它會被 onBeforeFire 的返回值覆蓋）。
 */
const AMSG2_PLACEHOLDER_PROMPT =
  'AMSG2_PLACEHOLDER_PROMPT（正式 prompt 到點由 worker onBeforeFire 下發；看到這條說明 fire hooks 未生效）';

/**
 * fire_pack 裡 `chat.messages` 的體積上限（對 `JSON.stringify(messages)` 按 UTF-8 字節算）。
 *
 * 上限是這麼推出來的：
 *   1. 上游按**條目**卡體積：PUT /client-state 的 validateEntry 拿
 *      `new TextEncoder().encode(entry.value).length` 跟 maxStateValueBytes 比，超了回
 *      STATE_VALUE_TOO_LARGE。我們的 worker 沒配這個值 → 用庫的默認 5 MiB。
 *      注意它量的是**我們交出去的那個字符串**（服務端落庫前的加密不算在內）。
 *   2. 不能指望壓縮幫忙：packStateValue 在運行時沒有 CompressionStream（老 Safari）
 *      或者壓完更大時會原樣返回，所以按「一點沒壓」的原始 JSON 算才是誠實的。
 *   3. fire_pack 裡除了這串對話還有別的：完整角色卡 + 世界書 + 最近對話的 template、
 *      pendingTasks、scene。給它們留 1 MiB。剩 4 MiB。
 *   4. 再對摺留一半餘量 —— 同一批字節還要坐 /instant-chat 的請求體，外面套一層
 *      AES-GCM + base64（漲三分之一）；而這麼大的 body 走手機上行，往往在服務端
 *      來得及判它超沒超之前就先被上行超時掐掉了。
 * → 2 MiB。
 */
const CHAT_CONTENT_BUDGET_BYTES = 2 * 1024 * 1024;

const utf8ByteLength = (text: string): number => new TextEncoder().encode(text).length;

/** 字節數 → 給人看的 MB（體積類報錯共用一份口徑）。 */
const formatMegabytes = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);

/** 結構化分段裡有沒有圖片這類非文字內容（只有文字段的數組拆了也省不下什麼）。 */
const hasNonTextPart = (content: unknown): boolean =>
  Array.isArray(content) && content.some((part: any) => part?.type !== 'text');

// 「圖片消息 → 文字佔位」的拍平內核與本地 stripImages 路徑共用同一份
// （promptMessageCleanup.flattenContentPartsToText）：超預算降級產物必須與
// 本地拍平產物嚴格同源，否則同一條歷史消息在兩條生成路上渲染成兩種樣子。

/**
 * 上雲前把聊天消息裡的圖片令牌（`blobref:<id>`）還原成 data URL，返回一份獨立副本。
 *
 * 兩條理由，缺一條都不能省這一步：
 *   · worker 那邊沒有 IndexedDB，令牌到了雲端誰也解不開。瀏覽器裡那層「發請求前統一
 *     還原」（utils/apiBlobRefs.ts）夠不到 worker 自己發出去的請求，圖會靜默消失；
 *   · 令牌只有幾十字節，而它代表的圖可能幾 MB。先算預算再還原的話，一份「看著沒超」
 *     的包還原後照樣超限，下面那道體積閘等於白設。所以順序是死的：**先還原，再算預算**。
 *
 * resolveBlobRefsDeep 原地改對象，所以先深拷貝再交給它——調用方那串 fullMessages
 * 本地這一輪還要用，一個字節都不能被改。拷貝發生在還原之前，拷的是還帶著短令牌的
 * 小結構，不是幾 MB 的 base64。
 */
export const resolveChatMessagesForUpload = async (
  messages: Array<{ role: string; content: unknown }>,
): Promise<Array<{ role: string; content: unknown }>> => {
  const copy = messages.map((message) => ({
    role: message.role,
    content: message.content === null || typeof message.content !== 'object'
      ? message.content
      : (typeof structuredClone === 'function'
        ? structuredClone(message.content)
        : JSON.parse(JSON.stringify(message.content))),
  }));
  await resolveBlobRefsDeep(copy);
  return copy;
};

/**
 * 本地那串 fullMessages → fire_pack 的 `chat.messages`。
 *
 * **原樣搬運**：帶圖片的消息本地是結構化的（`[{type:'text'},{type:'image_url'}]`，
 * 圖片是 base64 data URL），這裡一個字都不動地帶上雲——即時對話的整個前提就是
 * 「雲端跑出來的回覆和本地跑出來的一模一樣」，模型看不看得見圖片是這裡面差別最大的一項。
 *
 * 唯一的例外是體積：一條 client_state 有硬上限（見 CHAT_CONTENT_BUDGET_BYTES）。
 * 超了就**從最老的消息開始**丟圖片本體（換成它自己的文字段，也就是以前那種拍平結果），
 * 一條一條丟到進預算為止。最新那條用戶消息的圖片永遠不丟——用戶剛發的這張圖正是
 * 這一輪要聊的東西，把它丟了等於答非所問，而用戶完全看不出來。
 *
 * 丟到只剩最新那條還是超預算 → 拋錯，走「即時對話發送失敗」那條明路，絕不悄悄把
 * 當前這輪截斷。報錯分兩種：刪掉最新那張圖能救回來的，指向圖片；純文本本身就超限的
 * （長角色卡 + 世界書 + 近史），如實說上下文太大——這種情況用戶沒有圖可刪。
 */
export const toFirePackChatMessages = (
  messages: Array<{ role: string; content: unknown }>,
): Array<{ role: string; content: AmsgFirePackChatContent }> => {
  const result: Array<{ role: string; content: AmsgFirePackChatContent }> = messages.map((message) => {
    if (typeof message.content === 'string') return { role: message.role, content: message.content };
    // 結構化分段整段原樣帶走（分段內部長什麼樣是 chat API 的方言，這裡不解釋也不改寫）。
    if (Array.isArray(message.content)) {
      return { role: message.role, content: message.content as AmsgFirePackChatContent };
    }
    return { role: message.role, content: String(message.content ?? '') };
  });

  // 體積帳做增量：全量 stringify 只做這一次。整串 JSON 是「[ 條目,條目,… ]」，
  // 換掉第 i 條時分隔符一個字節都不動，總字節的變化就恰好是這條自身序列化字節的差。
  // 把全量 stringify 放進下面循環的條件裡的話，每壓平一條都要翻攪一遍整串
  // （帶圖歷史動輒數 MB），發生在用戶剛按下發送的主線程上，一次就是秒級卡頓。
  const entryBytes = (entry: { role: string; content: AmsgFirePackChatContent }) =>
    utf8ByteLength(JSON.stringify(entry));
  let totalBytes = utf8ByteLength(JSON.stringify(result));
  if (totalBytes <= CHAT_CONTENT_BUDGET_BYTES) return result;

  // 最新那條用戶消息 = 用戶剛發出去、正在等回覆的這一條。它的圖片是這一輪的題面。
  let protectedIdx = -1;
  for (let i = result.length - 1; i >= 0; i -= 1) {
    if (result[i].role === 'user') { protectedIdx = i; break; }
  }

  // 從最老的開始丟：越老的圖片對這一輪越不重要，而正文那句「用戶發來一張圖片」還在，
  // 模型至少知道當時發生過這件事。
  for (let i = 0; i < result.length && totalBytes > CHAT_CONTENT_BUDGET_BYTES; i += 1) {
    if (i === protectedIdx || !hasNonTextPart(result[i].content)) continue;
    const bytesBefore = entryBytes(result[i]);
    result[i] = { role: result[i].role, content: flattenContentPartsToText(result[i].content as unknown[]) };
    totalBytes -= bytesBefore - entryBytes(result[i]);
    console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 即時對話這輪體積超標，第 ${i + 1} 條消息的圖片本體沒帶上雲（文字段保留）`);
  }

  if (totalBytes > CHAT_CONTENT_BUDGET_BYTES) {
    const mb = formatMegabytes;
    // 走到這裡，能拍的圖全拍平了，還帶著圖的只可能是受保護的最新那條用戶消息。
    // 報錯前先算一筆帳：把它的圖也拍掉能不能進預算。能 → 罪魁確實是這張圖，讓用戶
    // 刪圖/換小圖是條真出路；不能 → 超限的是純文本本身（長角色卡 + 世界書 + 近史），
    // 這時候還叫人刪圖就是指錯路——用戶可能壓根沒發過圖，照著做也永遠修不好。
    const protectedEntry = protectedIdx >= 0 ? result[protectedIdx] : undefined;
    const protectedImageBytes = protectedEntry && hasNonTextPart(protectedEntry.content)
      ? entryBytes(protectedEntry) - entryBytes({
          role: protectedEntry.role,
          content: flattenContentPartsToText(protectedEntry.content as unknown[]),
        })
      : 0;
    if (totalBytes - protectedImageBytes <= CHAT_CONTENT_BUDGET_BYTES) {
      throw new Error(
        `即時對話發不出去：這一輪要帶的圖片太大（約 ${mb(totalBytes)} MB，上限 ${mb(CHAT_CONTENT_BUDGET_BYTES)} MB）。`
        + '刪掉圖片、或者換一張小一點的再發。',
      );
    }
    throw new Error(
      `即時對話發不出去：這一輪上下文太大（約 ${mb(totalBytes)} MB，即時對話單輪上限 ${mb(CHAT_CONTENT_BUDGET_BYTES)} MB）。`
      + '精簡一下上下文（比如角色設定、世界書或攜帶的歷史條數），或先關掉即時對話走本地生成。',
    );
  }
  return result;
};

/** POST /instant-chat 的失敗原因（包裝層的錯誤碼 → 一句能照著做的話）。 */
export const describeInstantChatFailure = (status: number, body: any): string => {
  const code = body?.error?.code;
  const upstream = body?.error?.upstream?.error?.message || body?.error?.upstream?.message;
  // Worker 內部真正拋出來的那句（`D1_ERROR: no such table …` 之類）。上游只回一句寫死的
  // 「服務器內部錯誤」，包裝層從它的日誌裡把原文撈了出來（見 worker 的 forwardWithFatalLog）。
  // 這才是能照著做事的那一句，所以排在泛型報文後面一起給出來，別讓人再去翻 Cloudflare 面板。
  const upstreamLog = typeof body?.error?.upstreamLog === 'string' ? body.error.upstreamLog : '';
  const detail = [body?.error?.message, upstream, upstreamLog].filter(Boolean).join('：');
  if (status === 401 || code === 'INVALID_CLIENT_TOKEN') {
    return '即時對話沒發出去：共享密鑰和 Worker 上的對不上，去「主動消息 2.0」設置裡核對一下。';
  }
  if (status === 405 || status === 404) {
    return '即時對話沒發出去：Worker 上還沒有這個端點，去你 fork 的 sullyos-workers 點一下 Sync fork 更新。';
  }
  if (status === 503) {
    return '即時對話沒發出去：Worker 的環境變量沒配齊（設置頁點「重新連接並驗證」能看到缺什麼）。';
  }
  // 任務正文超過存儲的單行上限（amsg-server 2.6.0-next.21 起在建任務時就回 400，
  // 以前要一路走到落庫才撞上 D1 的 `string or blob too big`）。上游把兩個數放在
  // details 裡，照著念就是了——重試沒有意義，得先把帶上去的內容減下來。
  //
  // 跟 CHAT_CONTENT_BUDGET_BYTES 那道閘不是一回事：那道量的是 fire_pack 裡的對話
  // （走 client_state，5 MiB 一條），這道量的是任務正文本身（約 1 MB）。
  const tooLarge = body?.error?.upstream?.error?.code === 'TASK_PAYLOAD_TOO_LARGE'
    ? body?.error?.upstream?.error
    : (code === 'TASK_PAYLOAD_TOO_LARGE' ? body?.error : null);
  if (tooLarge) {
    const bytes = Number(tooLarge?.details?.bytes);
    const maxBytes = Number(tooLarge?.details?.maxBytes);
    const sizes = Number.isFinite(bytes) && Number.isFinite(maxBytes)
      ? `（約 ${formatMegabytes(bytes)} MB，上限 ${formatMegabytes(maxBytes)} MB）`
      : '';
    return `即時對話沒發出去：這一輪的任務內容超過了雲端單條任務的上限${sizes}。`
      + '精簡一下角色設定 / 世界書 / 攜帶的歷史條數，或先關掉即時對話走本地生成。';
  }
  // 上游打回「時間必須在未來」：firstSendTime 是設備的鐘加提前量算出來的，被打回
  // 說明提前量在路上被吃光了——要麼整包狀態上傳得太慢，要麼設備時鐘本身偏慢。
  // 這兩種用戶能做的事是一樣的：重試，或去檢查自動對時。別讓它掉進下面那句
  // 光禿禿的 HTTP 400。
  if (body?.error?.upstream?.error?.code === 'INVALID_TIMESTAMP') {
    return '即時對話沒發出去：沒趕上服務端的時間校驗——網絡太慢，或設備時鐘偏慢。'
      + '重試一次通常就好；每次都這樣的話，檢查一下設備的「自動設置時間」開沒開。';
  }
  // 走到這裡說明連自愈那一輪（讀回雲端時間戳對齊再發一次）都沒蓋上去：要麼雲端狀態
  // 讀不回來，要麼真的有另一台設備/另一個標籤頁在同時寫同一個角色。
  if (code === 'INSTANT_CHAT_STATE_STALE') {
    return '即時對話沒發出去：雲端那份狀態比這台設備的新，對齊之後重發也沒能蓋上去。'
      + '另一台設備或另一個標籤頁開著同一個角色的話，先關掉再發；只有這一台的話，'
      + '檢查一下設備的「自動設置時間」開沒開。';
  }
  return `即時對話沒發出去（HTTP ${status}${code ? ` / ${code}` : ''}）${detail ? `：${detail}` : '。'}`;
};

/**
 * 這個錯誤體是不是「引用的憑據行在雲端不存在」。
 *
 * 兩層都看：排程直接調上游時錯誤碼就在頂層；即時對話經包裝層，上游那份原樣躺在
 * `error.upstream` 裡。補傳自愈的兩處（排程 / 即時對話）共用這一把尺。
 */
export const isCredentialNotFound = (body: any): boolean =>
  body?.error?.code === 'CREDENTIAL_NOT_FOUND'
  || body?.error?.upstream?.error?.code === 'CREDENTIAL_NOT_FOUND';

/**
 * 這個錯誤體是不是「雲端拒收了這一輪的狀態」——條件寫把 fire_pack 攔下了。
 *
 * 這個碼由包裝層判出來（`worker/amsg/src/instantChat.ts`），所以只在頂層，不用像
 * 憑據那個一樣再往 `error.upstream` 裡剝一層。
 */
export const isInstantChatStateStale = (body: any): boolean =>
  body?.error?.code === 'INSTANT_CHAT_STATE_STALE';

/** client_state 上傳每次嘗試前等多久：數組長度即總嘗試次數（首次不等）。 */
const CLIENT_STATE_BACKOFF_MS = [0, 400, 1200];

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 上傳一批 client_state 條目：網絡抖動重試，最終失敗拋錯——不降級。
 *
 * 為什麼這一步是硬要求：worker 到點靠 fire_pack 拿新鮮上下文，「遠端有任務、雲端
 * 沒狀態」是個不該存在的中間態。過去這裡失敗只 warn，任務照建，到點用排程那一刻
 * 凍結的 prompt 發——用戶不知道自己收到的是舊上下文。現在傳不上去就讓整個排程失敗，
 * 由用戶 / 角色重試。
 *
 * 被 worker 點名 rejected（體積超限等結構性原因）不重試：重試不會變好，直接把原因
 * 拋出來。注意 putClientState 失敗有兩種形態——拋異常和回 { success: false }，
 * 兩種都要接住，只判 try/catch 會漏掉後者。
 */
export const putClientStateOrThrow = async (
  client: ReiClient,
  // value 為 null 表示刪掉這一行（只在 isClientStateDeleteReady 為 true 時才能發）。
  entries: Array<{ namespace: string; key: string; value: string | null; updatedAt: number }>,
  phase: string,
): Promise<void> => {
  let lastError: unknown;

  for (const backoffMs of CLIENT_STATE_BACKOFF_MS) {
    if (backoffMs) await delay(backoffMs);

    let response: { success?: boolean; data?: { rejected?: Array<{ key: string; message?: string }> }; error?: { message?: string } } | undefined;
    try {
      response = await client.putClientState(entries) as typeof response;
    } catch (error) {
      lastError = error;
      continue;
    }

    if (!response?.success) {
      lastError = new Error(response?.error?.message || `${phase}失敗。`);
      continue;
    }

    const rejected = response.data?.rejected;
    if (rejected?.length) {
      throw new Error(
        `${phase}被 Worker 拒絕：${rejected.map((r) => `${r.key}(${r.message || 'rejected'})`).join('、')}。`
        + '請確認已部署最新的 Worker 代碼（設置頁有版本探測）。',
      );
    }
    return;
  }

  throw normalizeActiveMsgApiError(lastError, phase);
};

/**
 * 被條件寫攔下之後，照雲端那幾行的時間戳把本地水位抬上去；返回水位有沒有真的動。
 *
 * 為什麼非得讀一遍：攔下只說明「你蓋的戳不夠新」，沒說雲端那行是幾點。不讀回來就只能
 * 猜偏移多少，而這個偏移取決於當初設備時鐘跑偏了多少，猜不出來。對齊之後下一次蓋的戳
 * 自然就跨得過去了（見 amsgStateClock）。
 *
 * 讀失敗不拋：調用方拿 false 當「沒對齊上」處理，該報的錯照報——自愈是加分項，不該
 * 把原本清清楚楚的失敗蓋成一句「讀雲端狀態失敗」。
 */
const alignStateClockWithRemote = async (
  client: ReiClient,
  namespaces: string[],
): Promise<boolean> => {
  let aligned = false;
  for (const namespace of namespaces) {
    try {
      const response = await client.getClientState(namespace) as
        { data?: { entries?: Array<{ updatedAt?: unknown }> } } | undefined;
      for (const entry of response?.data?.entries ?? []) {
        if (observeRemoteStateUpdatedAt(entry?.updatedAt)) aligned = true;
      }
    } catch (error) {
      console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 讀雲端狀態時間戳失敗，這一輪不對齊`, error);
    }
  }
  return aligned;
};

/**
 * 把一個 namespace 下的條目全部清掉，返回被清掉的鍵名。
 *
 * 先讀一遍再逐條清，而不是照著已知鍵名盲寫，有兩個原因：
 *   1. 旁路存儲的鍵名帶 clientTaskId（`xhs_session:<id>`），任務記錄被
 *      pruneStaleTasks 清掉之後就再也拼不出來，只能靠讀回來才知道有哪些；
 *   2. 盲寫會把本來不存在的條目 upsert 出來 —— putClientState 是 upsert，
 *      "清理" 反倒變成新建。
 *
 * 清法跟 clearClientStateValue 同一套，按 worker 的能力位分兩條路：
 *   - worker 認刪行（isClientStateDeleteReady）：讀回來的每一行都發 `value: null`
 *     真刪，已經是空殼的行也在內——它們正是過去寫空留下的，現在能一起刪乾淨；
 *   - 老 worker：只對還有內容的行寫空串，留下幾字節的空殼；已經是空殼的跳過，
 *     再寫一遍不會更乾淨，只是白佔一次請求體。
 * 條目多過上游單批上限時切批發。
 */
export const clearNamespaceValuesOrThrow = async (
  client: ReiClient,
  namespace: string,
): Promise<string[]> => {
  // 全局 namespace 不許走這條路：裡面的 tool_config 只在配置變更時才重傳，被清掉
  // 之後沒有任何一條路會把它補回來，而 worker 到點讀不到它就整條任務硬失敗。
  // 這個函數目前只服務「刪角色」（每角色一個 namespace），加道護欄免得將來被順手複用。
  if (namespace === AMSG_GLOBAL_NAMESPACE) {
    throw new Error('全局雲端狀態不能按 namespace 清空（tool_config 清掉就沒人補了）。');
  }
  const response = await client.getClientState(namespace);
  if (!response?.success) {
    throw new Error(response?.error?.message || '讀取雲端狀態失敗。');
  }
  const entries = (response.data?.entries ?? []) as Array<{ key?: string; value?: string }>;
  const deleteSupported = await isClientStateDeleteReady();
  const keys = entries
    .filter((e) => e?.key && (deleteSupported || e?.value))
    .map((e) => e.key as string);
  if (keys.length === 0) return [];

  const updatedAt = stampStateUpdatedAt();
  const value = deleteSupported ? null : '';
  for (const batch of chunkClientStateEntries(keys)) {
    await putClientStateOrThrow(
      client,
      batch.map((key) => ({ namespace, key, value, updatedAt })),
      '清空雲端狀態',
    );
  }
  return keys;
};

/**
 * 旁路存儲的存量空殼清理：把這幾個角色命名空間裡歷史積累的空殼行掃一遍刪掉，
 * 每個角色只掃一次。
 *
 * 在 worker 認刪行之前，取回旁路內容後是寫空串；即時對話每輪的鍵都是新的
 * （`reasoning:<uuid>` 這類），於是每個角色的命名空間裡躺著一堆只漲不跌的空殼，
 * 而 worker 每次生成都要把整個命名空間讀一遍。現在取回即刪、不再新增，這裡負責清舊帳：
 *   - 只在探到 'client-state-delete' 時做，老 worker 收到 null 是逐條被拒；
 *   - 每個角色讀一次命名空間，挑出旁路鍵且值為空串的行（見 pickSidechannelShellKeys），
 *     按上游單批上限切開發 null。別的鍵一律不碰；
 *   - 掃完（不管有沒有空殼）把角色 id 記進全局配置的已掃列表，之後的同步不再為它多讀一次；
 *   - 哪一步失敗只 warn、這個角色不記進列表，下一次同步再試。
 *
 * 掛在 syncCharFirePacks 的末尾：那條路每次聊完都會為每個角色跑到，正好順路。放在
 * 正常同步之後，這裡的成敗不影響同步本身。
 */
const sweepSidechannelShells = async (client: ReiClient, charIds: string[]): Promise<void> => {
  let config: ActiveMsg2GlobalConfig;
  try {
    config = await ActiveMsgStore.getGlobalConfig();
  } catch {
    return;
  }
  if (config.clientStateDeleteSupported !== true) return;
  const swept = new Set(config.sidechannelShellsSweptCharIds ?? []);
  const pending = [...new Set(charIds)].filter((charId) => !swept.has(charId));
  if (pending.length === 0) return;

  const newlySwept: string[] = [];
  for (const charId of pending) {
    const namespace = amsgStateNamespace(charId);
    try {
      const response = await client.getClientState(namespace) as {
        success?: boolean;
        data?: { entries?: Array<{ key?: unknown; value?: unknown }> };
        error?: { message?: string };
      } | undefined;
      if (!response?.success) {
        throw new Error(response?.error?.message || '讀取雲端狀態失敗。');
      }
      const shellKeys = pickSidechannelShellKeys(response.data?.entries);
      if (shellKeys.length > 0) {
        const updatedAt = stampStateUpdatedAt();
        for (const batch of chunkClientStateEntries(shellKeys)) {
          await putClientStateOrThrow(
            client,
            batch.map((key) => ({ namespace, key, value: null, updatedAt })),
            '清理旁路存儲空殼',
          );
        }
      }
      newlySwept.push(charId);
    } catch (error) {
      console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 角色 ${charId} 的旁路存儲空殼沒清完（下次同步再試）`, error);
    }
  }
  if (newlySwept.length === 0) return;

  try {
    await ActiveMsgStore.saveGlobalConfig({ sidechannelShellsSweptCharIds: [...swept, ...newlySwept] });
  } catch (error) {
    // 列表沒存下來只是下次會再掃一遍（再讀一次、發現沒空殼），已經刪掉的行不會回來。
    console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 已掃過的角色列表沒存下來（下次同步會再掃一遍）`, error);
  }
};

/**
 * 這個角色此刻欠著一條即時對話的回覆嗎（發送還在飛 / 已受理還沒收到）。
 *
 * 欠著的那段時間裡，雲端的 fire_pack 是 POST /instant-chat 帶上去的那一份，比常規的包
 * 多一段 chat —— worker 到點全靠它拿這一輪的對話。常規重建的包沒有 chat 段，覆蓋上去
 * worker 只會硬失敗（「fire_pack 裡沒有 chat 段」），重試梯子上每一跳都是同一個錯，
 * 用戶最後拿到一句「即時對話沒能完成」，話還得自己重發一遍。
 *
 * 所以凡是會寫 fire_pack 的路徑，寫之前都得先問一次這裡：批量同步（amsgStateSync 的
 * 掛起段）和排程（scheduleCharacterTask）共用這一把尺，別各寫各的。
 *
 * 「發送在飛」這一半不能省：待收記錄要 202 回來才有，光認它的話，慢網上傳的那幾秒
 * 正好是敞著的。
 */
export const owesInstantChatReply = (charId: string): boolean =>
  !!getInstantChatPending(charId) || isInstantChatSendInFlight(charId);

/**
 * 角色側雲端狀態的兩條條目（fire_pack + tool_pack）。
 *
 * 「哪個 namespace 配哪個 key 配哪個 build 函數」只在這裡寫一遍：排程和批量同步兩條路
 * 都得把同一批東西寫上去，各寫各的話漏一條就是 worker 到點讀不到 → 整條任務硬失敗。
 */
/**
 * 用戶給這個角色定的「頻率與額度」（見 amsgLimits）。
 *
 * 保存設置時單獨立刻傳一次（putCharLimits），每次傳 fire_pack 也順手帶一份——兩條路
 * 都走這裡，worker 讀到的永遠是同一個構造出來的形狀。
 */
const buildLimitsEntry = (char: CharacterProfile, updatedAt: number) => ({
  namespace: amsgStateNamespace(char.id),
  key: AMSG_LIMITS_KEY,
  value: JSON.stringify(buildAmsgLimitsRecord(char.activeMsg2Config, isAmsg2EnabledForChar(char))),
  updatedAt,
});

const buildCharStateEntries = async (
  char: CharacterProfile,
  firePack: AmsgFirePack,
  updatedAt: number,
) => [
  buildLimitsEntry(char, updatedAt),
  {
    namespace: amsgStateNamespace(char.id),
    key: AMSG_FIRE_PACK_KEY,
    // 壓在加密之前：上游 putClientState 先加密再發，密文壓不動（見 amsgFirePack）。
    value: await packStateValue(JSON.stringify(firePack)),
    updatedAt,
  },
  // v2 服務端工具循環的角色側數據（recall 月度總結 / XHS 開關 / 角色名）。
  {
    namespace: amsgStateNamespace(char.id),
    key: AMSG_TOOL_PACK_KEY,
    value: await packStateValue(JSON.stringify(buildToolPack(char))),
    updatedAt,
  },
];

/** 全局工具憑據條目（v2 服務端工具循環用的搜索 / Notion / 飛書 / 小紅書 / 自配 MCP 配置）。 */
const buildToolConfigEntry = (
  realtimeConfig: RealtimeConfig | undefined,
  updatedAt: number,
) => ({
  namespace: AMSG_GLOBAL_NAMESPACE,
  key: AMSG_TOOL_CONFIG_KEY,
  // MCP 配置在這裡現讀現帶：三條上傳路徑（排程 / fire_pack 沖刷 / 設置保存）
  // 全走這個咽喉，不會出現某條路漏帶的版本分叉。
  value: JSON.stringify(buildToolConfig(realtimeConfig, {
    servers: collectMcpFireServers(),
    useNativeTools: getMcpUseNativeTools(),
  })),
  updatedAt,
});

/**
 * 現有推送訂閱還能不能繼續用；不能用的當場退訂，返回 null 讓調用方重新訂閱。
 *
 * 兩種「留著必失聯」的形態：
 *   1. 死端點——瀏覽器把訂閱殭屍化成 `permanently-removed.invalid` 哨兵，推必失敗；
 *   2. 綁的 VAPID 公鑰跟目標 worker 的不一致——換過 VAPID 後舊訂閱還簽著老公鑰，
 *      worker 發推會被推送服務 403 拒掉。
 * 退訂後要等瀏覽器清內部 removed 標記（SUBSCRIBE_SETTLE_MS），否則緊接著的
 * subscribe() 又拿到死哨兵。
 *
 * 判定口徑與 proactivePushConfig.getOrCreateSubscription 的內聯實現一致；那一處在
 * 它自己的文件裡，將來合併時以這份抽出來的函數為準。export 供單測 mock pushManager 釘行為。
 */
export const dropStaleSubscription = async (
  sub: PushSubscription | null,
  targetVapidPublicKey: string,
): Promise<PushSubscription | null> => {
  if (!sub) return null;
  if (isDeadPushEndpoint(sub.endpoint)) {
    try { await sub.unsubscribe(); } catch { /* ignore */ }
    await delay(SUBSCRIBE_SETTLE_MS);
    return null;
  }
  try {
    const existingKey = bytesToB64u(sub.options.applicationServerKey);
    if (existingKey && existingKey !== targetVapidPublicKey) {
      await sub.unsubscribe();
      await delay(SUBSCRIBE_SETTLE_MS);
      return null;
    }
  } catch {
    // 公鑰讀不出來（個別瀏覽器不暴露 options）就按可複用處理——
    // 與 proactive 那處同款 fall-through。
  }
  return sub;
};

/**
 * 重置類操作的前置：Worker 地址填了、瀏覽器有推送能力、通知權限拿到了。
 *
 * 權限這一步會彈框（用戶點的就是「重置訂閱」，彈一次合理）；沒給就直接拋，
 * 別硬著頭皮往下走——沒有權限 subscribe() 必然失敗，報「訂閱失敗」會把用戶
 * 引去查網絡，實際上只要去站點設置裡放開通知。
 */
const requirePushReady = async (): Promise<ActiveMsg2GlobalConfig> => {
  const capabilityGap = describePushCapabilityGap();
  if (capabilityGap) throw withFailKind(new Error(`${capabilityGap}。`), '不支持推送');

  const config = await ensureWorkerReady();

  let permission = Notification.permission;
  if (permission !== 'granted') permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw withFailKind(new Error('通知權限未授予，沒法重建推送訂閱。'), '權限被拒');
  }

  await KeepAlive.init();
  return config;
};

/** 退掉當前這條瀏覽器訂閱，並等瀏覽器把內部的 removed 標記清完再返回。 */
const unsubscribeCurrentPush = async (): Promise<void> => {
  try {
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    if (!existing) return;
    try { await existing.unsubscribe(); } catch { /* 退不掉也繼續，下面重訂會再試 */ }
    // 不等的話，緊接著的 subscribe() 大概率直接吐 permanently-removed.invalid 哨兵。
    await delay(SUBSCRIBE_SETTLE_MS);
  } catch (error) {
    console.warn('[ActiveMsg] 退訂舊推送訂閱時出錯，繼續重建', error);
  }
};

/**
 * 問 worker 要它自己籤推送用的 VAPID 公鑰。
 *
 * 各用戶自部署 worker、各有各的 VAPID，運行時拉、不編譯進前端。拿別人的公鑰訂閱，
 * worker 推的時候會 403。
 */
const fetchWorkerVapidKey = async (client: ReiClient): Promise<string> => {
  let vapidPublicKey: string;
  try {
    vapidPublicKey = await client.getVapidPublicKey();
  } catch (error) {
    throw normalizeActiveMsgApiError(error, '獲取 Worker VAPID 公鑰');
  }
  if (!vapidPublicKey) {
    throw withFailKind(new Error('Worker 沒返回 VAPID 公鑰，請確認已配置 VAPID 並部署了最新 worker。'), 'worker沒配VAPID');
  }
  return vapidPublicKey;
};

/**
 * 建一條新的瀏覽器推送訂閱，拿不到活端點就拋。
 *
 * 走共用的 subscribeWithRetry 而不是 `ReiClient.subscribePush`：後者是裸的
 * `pushManager.subscribe()`，剛退訂完的窗口期裡瀏覽器會吐 permanently-removed.invalid
 * 哨兵，它照單收下——那個死端點一旦被登記進 worker，用戶看到「訂閱成功」，到點卻一條
 * 都收不到，兩邊都沒有任何報錯。重試到底仍是殭屍的話掛 '端點殭屍' 代號，設置頁據此
 * 把「重置訂閱」升級成「深度重置」。
 */
/** 共用層的失敗分類 → 上報用的失敗代號。兩邊都是源碼裡寫死的枚舉。 */
const SUBSCRIBE_FAIL_KIND: Record<SubscribeFailureKind, AmsgFailKind> = {
  'channel-unreachable': '推送通道不通',
  'no-subscription': '沒拿到訂閱',
  unsupported: '不支持推送',
  permission: '權限被拒',
  state: '訂閱失敗',
  zombie: '端點殭屍',
  unknown: '訂閱失敗',
};

const subscribeOrThrow = async (
  registration: ServiceWorkerRegistration,
  vapidPublicKey: string,
): Promise<PushSubscription> => {
  const { sub, failure } = await subscribeWithRetry(registration, vapidPublicKey, ACTIVE_MSG_RUNTIME_HEADER);
  if (sub) return sub;
  // 提示原文（瀏覽器能力、重試了幾次）留在 toast 和 console 裡。掛上去的代號來自
  // 上面那張寫死的表，不是從異常對象上讀出來的任何東西。
  const message = failure?.text || '訂閱創建失敗';
  throw withFailKind(new Error(message), failure ? SUBSCRIBE_FAIL_KIND[failure.kind] : '訂閱失敗');
};

/** 重置的公共尾段：拿 worker 的 VAPID → 重新訂閱 → 覆蓋登記回 worker。 */
const resubscribeAndRegister = async (client: ReiClient): Promise<void> => {
  const vapidPublicKey = await fetchWorkerVapidKey(client);
  const registration = await navigator.serviceWorker.ready;
  const sub = await subscribeOrThrow(registration, vapidPublicKey);

  try {
    await client.putPushSubscription(sub);
  } catch (error) {
    throw normalizeActiveMsgApiError(error, '登記推送訂閱');
  }
};

/**
 * 請求體超過這麼多字節才壓。跟 amsg-client 的 `compressRequest` 用同一個數
 * （16 KB）：小請求壓縮省下的字節還不夠抵一次 CompressionStream 的開銷，而這條路上
 * 真正的大件（fire_pack、整輪聊天）動輒幾百 KB 起步，一個數就分得開。
 */
const REQUEST_GZIP_THRESHOLD_BYTES = 16 * 1024;

/**
 * 超閾值的請求體先 gzip 再上網線。
 *
 * 收益有限，得說清楚：這裡的正文進 HTTP 之前已經是**密文**，
 * 而 fire_pack 真正的壓縮早在交給上游加密之前就做過了（見 amsgFirePack 的
 * packStateValue，省 60%）。所以這一層壓掉的只是密文那層 base64 的膨脹，約 25%。
 * 慢網和 iOS 上行那幾秒裡，這 25% 仍然是實打實少傳的字節。
 *
 * 接收端：上游端點由 amsg-server 的 readRequestBody 解（2.6.0-next.21 起），包裝層
 * 自己的 `/instant-chat` 由 readMaybeGzippedBody 解。兩邊都按 gzip 魔數判斷，所以
 * 中途被邊緣節點替我們解開、頭還留著的那種情形也接得住。
 *
 * 壓不動就退回明文：老 Safari 沒有 CompressionStream，壓縮本身出錯也一樣——這條路
 * 只是省流量，絕不能變成發不出去的理由。
 *
 * export 只為單測。
 */
export const maybeGzipRequestBody = async (
  body: BodyInit | null | undefined,
): Promise<{ body: BodyInit | null | undefined; gzipped: boolean }> => {
  if (typeof body !== 'string') return { body, gzipped: false };
  // 快速排除：UTF-8 一個字符最多三字節（BMP 之外是四字節，但那是代理對、佔兩個
  // char），所以字符數乘三還不到閾值的，字節數必然也不到，連量都不用量。反過來
  // **不成立**——「字符數不到閾值」推不出「字節數不到閾值」，一段六千字的中文就是
  // 六千字符、一萬八千字節。絕大多數請求都在這條線以下，一次 encode 都不用做。
  if (body.length * 3 < REQUEST_GZIP_THRESHOLD_BYTES) return { body, gzipped: false };
  if (typeof CompressionStream !== 'function') return { body, gzipped: false };
  try {
    const raw = new TextEncoder().encode(body);
    // 到這兒才量得準。壓縮要用的也是這份字節，沒有多算。
    if (raw.byteLength < REQUEST_GZIP_THRESHOLD_BYTES) return { body, gzipped: false };
    const stream = new Response(raw).body!.pipeThrough(new CompressionStream('gzip'));
    return { body: await new Response(stream).arrayBuffer(), gzipped: true };
  } catch (error) {
    console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 請求體壓縮失敗，這一次照常發明文`, error);
    return { body, gzipped: false };
  }
};

/**
 * 帶鑑權頭請求 worker，同時把 HTTP 狀態一起交出來。
 * 狀態只有「連接」那條路用得上（401/404/其它要引導用戶去改的地方不同），
 * 其餘調用方走下面那層薄殼，簽名跟以前一樣只拿 body。
 */
const fetchWithAuthRaw = async (
  path: string,
  config: ActiveMsg2GlobalConfig,
  init: RequestInit,
  phase = '接口',
): Promise<{ status: number; body: any }> => {
  const headers = new Headers(init.headers);
  if (config.serverToken) headers.set('X-Client-Token', config.serverToken);
  headers.set('X-User-Id', config.userId);

  const { body, gzipped } = await maybeGzipRequestBody(init.body);
  if (gzipped) headers.set('Content-Encoding', 'gzip');

  try {
    const response = await fetch(`${normalizeWorkerBase(config.workerUrl)}/${path}`, {
      ...init,
      headers,
      body,
    });

    return { status: response.status, body: await safeResponseJson(response) };
  } catch (error) {
    throw normalizeActiveMsgApiError(error, phase, config.workerUrl);
  }
};

const fetchWithAuth = async (path: string, config: ActiveMsg2GlobalConfig, init: RequestInit, phase = '接口') =>
  (await fetchWithAuthRaw(path, config, init, phase)).body;

const encryptPayload = async (client: ReiClient, payload: unknown) => {
  return (client as unknown as ReiCryptoBridge)._encrypt(JSON.stringify(payload));
};

const decryptPayload = async (client: ReiClient, payload: { iv: string; authTag: string; encryptedData: string }) => {
  return (client as unknown as ReiCryptoBridge)._decrypt(payload);
};

/**
 * 即時對話能力探測這一次到底問到了什麼。
 *
 * 「探不到」必須和「問到了、答案是不行」分開。混成同一個 false 的話，一次網絡抖動
 * （切代理節點、CF 邊緣抖一下、D1 冷啟動慢）就會把即時對話長期釘死在本地生成——存量
 * 是粘的，只有下次探測成功才翻得回來，而重探只掛在握手和打開設置頁兩處，用戶不進設置頁
 * 就一直卡著。線上真踩過：Worker 那頭全綠，用戶卻連著幾小時每一輪都在本地直連生成，
 * 而他的本地直連根本不通，只看得到一條讀不懂的網絡報錯，開關還寫著「已開啟」。
 */
export type InstantChatProbeOutcome =
  /** 200 + instantTick:true —— 跑得動 */
  | 'supported'
  /** 200 但沒有 instantTick —— 明確跑不動（老 bundle，或代碼新了綁定沒接上） */
  | 'unsupported'
  /** 壓根沒問到（網絡異常、超時、401、5xx、網關頁）—— 這不是答案，不能拿來判死刑 */
  | 'unknown';

export interface InstantChatProbeResult {
  outcome: InstantChatProbeOutcome;
  /** 探完之後真正生效的存量。unknown 時 = 探測前那份（原樣不動，可能是 undefined）。 */
  supported: boolean | undefined;
}

/**
 * 單條任務此刻的狀態（`getRemoteTaskStatus` 的答案）。
 *   pending   —— 行在且還會跑（可能正在重試等待裡，retryCount>0）
 *   completed —— 行在但已經出清（對一次性任務就等於失敗：發成功的行會被刪掉）
 *   gone      —— 行沒了（發成功後被刪 / 被取消 / 被頂替）
 */
export type RemoteTaskStatus =
  | { state: 'pending'; retryCount?: number; nextSendAt?: string }
  /**
   * lastError：amsg-server 2.6.0-next.15 起 409 的 error.details 帶的行級失敗摘要
   * （查詢本來就按 uuid 點名，必然是這一行的）。舊 worker 不帶 → null，調用方退回
   * chat_fail 留痕那條路。
   */
  | { state: 'completed'; lastError?: RemoteTaskLastError | null }
  | { state: 'gone' };

/**
 * 服務端消息帳本里的一條。
 *
 * 雲端每條推送發出去之前先記一行，客戶端收下之後銷帳（ack）。`push` 就是推送信封
 * 本身，跟 Service Worker 收到的那一份逐字一致——補收時原樣走收件箱那條老路即可。
 */
export interface AmsgOutboxEntry {
  /** 行號，同時也是翻頁游標。 */
  id: number;
  messageId: string;
  taskUuid: string | null;
  sessionId: string | null;
  messageIndex: number | null;
  totalMessages: number | null;
  /** 落帳時刻（epoch ms）。補收按它掐時效，太老的不再往聊天流裡放。 */
  createdAt: number;
  deliveredAt: number | null;
  push: Record<string, any>;
}

/** 單頁條數。服務端上限 100，取滿減少往返。 */
const OUTBOX_PAGE_SIZE = 100;

/**
 * 最多翻幾頁。護欄而非配額：正常情況一兩頁就到底了，堆到 2000 條說明帳本沒人銷過，
 * 這時也不該無限翻下去把啟動卡死——剩下的下次再拉。
 */
const OUTBOX_MAX_PAGES = 20;

/** 單次 ack 的條數上限（服務端 200，超了自己分批）。 */
const OUTBOX_ACK_BATCH_SIZE = 200;

export const ActiveMsgClient = {
  async registerNativePushToken(token: string): Promise<void> {
    if (!nativePushBuildEnabled()) throw new Error('當前構建未開啟 Capacitor 原生推送');
    const value = token.trim();
    if (!value) throw new Error('FCM registration token 為空');
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    await client.putPushSubscription({ endpoint: `fcm:${value}` });
  },

  async getGlobalConfig() {
    return ensureGlobalReady();
  },

  // 生成 worker env 用的 AMSG_MASTER_KEY（32 字節 → 64 位 hex）。
  // 只在設置頁展示給用戶粘進 CF env，前端自己不存也用不到它。
  generateMasterKey(): string {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    return Array.from(buf, (byte) => byte.toString(16).padStart(2, '0')).join('');
  },

  // 複製站點隨 build 發佈的 public/amsg-worker.bundle.js（Dashboard 粘貼部署用）。
  copyWorkerBundleToClipboard(): Promise<void> {
    return copyWorkerBundleToClipboard('amsg-worker.bundle.js');
  },

  // 複製 public/amsg-deno-proxy.ts —— 貼進 Deno Playground 當 worker 的門面用。
  // 走的是同一套「fetch 站點靜態文件 → 剪貼板」，只是這份不打包、原樣發佈，
  // 因為用戶要照著裡面的註釋改 UPSTREAM 那一行。
  copyDenoProxyToClipboard(): Promise<void> {
    return copyWorkerBundleToClipboard('amsg-deno-proxy.ts');
  },

  async getPushStatus(): Promise<ActiveMsg2PushStatus> {
    const config = await ensureGlobalReady();
    const workerConfigured = Boolean(config.workerUrl.trim());
    if (isUnifiedPushPlatform()) {
      try {
        const { getUnifiedPushStatus } = await import('./unifiedPushPlugin');
        const status = await getUnifiedPushStatus();
        const needsDistributor = !status.distributor && status.distributors.length === 0;
        return {
          supported: !needsDistributor,
          permission: status.permission === 'prompt' ? 'default' : status.permission,
          hasSubscription: Boolean(status.subscription),
          vapidConfigured: workerConfigured,
          transport: 'unified-push',
          distributor: status.distributor,
          needsDistributor,
          detail: needsDistributor
            ? '尚未檢測到 UnifiedPush 服務。請先安裝並打開 ntfy 的無 Firebase 版本。'
            : status.lastError
              ? `UnifiedPush：${status.lastError}`
              : !workerConfigured
                ? '請先填寫 Worker 地址。'
                : status.distributor
                  ? `UnifiedPush 服務：${status.distributor}`
                  : undefined,
        };
      } catch (error) {
        return {
          supported: false,
          permission: 'unsupported',
          hasSubscription: false,
          vapidConfigured: workerConfigured,
          transport: 'unified-push',
          detail: `UnifiedPush 原生橋不可用：${(error as Error)?.message || error}`,
        };
      }
    }
    // 能力檢測與 proactive push 共用 describePushCapabilityGap：
    // 它會說清缺的是三件套裡的哪一件，「不支持」這三個字用戶拿著沒法action。
    const capabilityGap = describePushCapabilityGap();
    if (capabilityGap) {
      return {
        supported: false,
        permission: 'unsupported',
        hasSubscription: false,
        vapidConfigured: workerConfigured,
        detail: `${capabilityGap}。`,
      };
    }

    await KeepAlive.init();
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();

    return {
      supported: true,
      permission: Notification.permission,
      hasSubscription: Boolean(subscription),
      vapidConfigured: workerConfigured,
      detail: !workerConfigured ? '請先填寫 Worker 地址。' : undefined,
      transport: 'web-push',
    };
  },

  async ensurePushSubscription() {
    if (isUnifiedPushPlatform()) {
      const config = await ensureWorkerReady();
      const client = createClient(config);
      const vapidPublicKey = await fetchWorkerVapidKey(client);
      const { ensureUnifiedPushSubscription } = await import('./unifiedPushPlugin');
      return ensureUnifiedPushSubscription(vapidPublicKey);
    }

    // 只需要「支不支持」這一個判斷，不走 getPushStatus——那會把 KeepAlive.init /
    // serviceWorker.ready / getSubscription 整套先跑一遍，下面又原樣跑一次。
    const capabilityGap = describePushCapabilityGap();
    if (capabilityGap) throw withFailKind(new Error(`${capabilityGap}。`), '不支持推送');

    const config = await ensureWorkerReady();

    let permission = Notification.permission;
    if (permission !== 'granted') {
      permission = await Notification.requestPermission();
    }
    if (permission !== 'granted') {
      throw withFailKind(new Error('通知權限未授予，無法創建主動消息 2.0 的推送訂閱。'), '權限被拒');
    }

    await KeepAlive.init();
    const registration = await navigator.serviceWorker.ready;

    // **有舊訂閱也要拉公鑰**：換過 VAPID 後舊訂閱綁的還是老公鑰，無條件複用等於把一個
    // 必 403 的訂閱繼續寫進新任務——自檢就是拿目標公鑰跟舊訂閱比對（還有瀏覽器殭屍化
    // 的死端點），不合格先退訂再重訂（見 dropStaleSubscription）。
    const client = createClient(config);
    const vapidPublicKey = await fetchWorkerVapidKey(client);

    const existing = await registration.pushManager.getSubscription();
    const reusable = await dropStaleSubscription(existing, vapidPublicKey);
    if (reusable) return reusable.toJSON();

    return (await subscribeOrThrow(registration, vapidPublicKey)).toJSON();
  },

  /**
   * 把當前這個瀏覽器的推送訂閱登記到 worker——一個用戶一份，覆蓋寫。
   *
   * worker 到點投遞時讀的就是這一份，包括角色在 fire 裡給自己排的、客戶端根本
   * 不知道存在的那些任務。所以訂閱換了端點只要覆蓋這一份，已排的任務一條都不用
   * 碰；反過來說**排程前必須先登記過**，否則 worker 沒地方推、直接拒絕建任務。
   *
   * 冪等：重複調用只是把同一份再寫一遍，啟動自檢可以無腦調。
   *
   * 「一個用戶一份」是有意為之，不是待修的限制：worker 上按 user_id 存單行，後登記的
   * 設備直接頂掉前一台，主動消息只會推到最後登記的那一台。所以不支持多設備同時收——
   * 一般也不會有人同時開著兩台設備玩，真開了的話，「另一台不響了」就是正常現象。
   */
  async registerPushSubscription(): Promise<void> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    const subscription = await this.ensurePushSubscription();
    try {
      await client.putPushSubscription(subscription);
    } catch (error) {
      throw normalizeActiveMsgApiError(error, '登記推送訂閱');
    }
  },

  /**
   * worker 上登記的那份訂閱現狀（不含密鑰，只有 endpoint 和登記時間）。
   *
   * 問不到一律返回 null、不拋：設置頁的狀態面板會反覆調它，斷網或者對面是台沒有
   * 這個端點的舊 worker 時，面板顯示「問不到」就夠了，不該整塊紅著報錯。
   */
  async getRemotePushSubscription(): Promise<AmsgRemotePushSubscription | null> {
    try {
      const config = await ensureWorkerReady();
      const client = await initializeClient(config);
      const response = await client.getPushSubscription();
      if (!response?.success) return null;
      const data = response.data;
      // 形狀對不上就當問不到。舊 worker 什麼都可能回，照著猜會把「沒登記」顯示成
      // 「已登記」——那正好是這一行要拆穿的故障，判反了還不如不顯示。
      if (typeof data?.exists !== 'boolean') return null;
      return {
        exists: data.exists,
        endpoint: typeof data.endpoint === 'string' ? data.endpoint : null,
        updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : null,
      };
    } catch {
      return null;
    }
  },

  /**
   * 只刪掉 worker 上登記的那行訂閱，瀏覽器這邊的訂閱原樣不動。
   *
   * 跟 resetPushSubscription 的分工：那個是「收不到推送了」的修復動作，刪完要重建
   * 瀏覽器訂閱再登記回去；這裡是清空雲端數據時的收尾，本機壓根沒開推送的話不該順手
   * 去申請通知權限，把雲端那行刪乾淨、留白就是對的。
   */
  async deleteRemotePushSubscription(): Promise<void> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    try {
      await client.deletePushSubscription();
    } catch (error) {
      throw normalizeActiveMsgApiError(error, '刪除推送訂閱登記');
    }
  },

  /**
   * 重置訂閱：清掉現在這條，重新建一條，再覆蓋登記回 worker。
   *
   * 三步缺一不可。只在瀏覽器重訂不登記的話，worker 的 push_subscriptions 裡還是
   * 舊端點，到點推給一個已經不存在的地址——界面全綠、一條消息都收不到，正是這個
   * 按鈕要治的病，不能自己再犯一遍。
   */
  async resetPushSubscription(): Promise<void> {
    if (isUnifiedPushPlatform()) {
      const config = await ensureWorkerReady();
      const client = await initializeClient(config);
      try {
        await client.deletePushSubscription();
      } catch (error) {
        console.warn('[ActiveMsg] UnifiedPush 重置：刪除 Worker 舊訂閱失敗，繼續覆蓋', error);
      }
      const subscription = await this.ensurePushSubscription();
      await client.putPushSubscription(subscription);
      return;
    }

    const config = await requirePushReady();
    const client = await initializeClient(config);

    // 先讓 worker 忘掉舊的那行。失敗不攔：下面重新登記本來就是覆蓋寫，刪不掉也不
    // 影響結果，只是萬一後面掛了，D1 裡會多留一條已經沒用的舊記錄。
    try {
      await client.deletePushSubscription();
    } catch (error) {
      console.warn('[ActiveMsg] 重置訂閱：刪除 worker 上的舊訂閱失敗，繼續重建', error);
    }

    await unsubscribeCurrentPush();
    await resubscribeAndRegister(client);
  },

  /**
   * 深度重置：在普通重置的基礎上，把 Service Worker 整個註銷再裝一遍。
   *
   * 什麼時候需要：Chromium 會把訂閱鎖死在內部的 MarkedForRemoval 狀態，這時候
   * `pushManager.unsubscribe()` 清不掉標記，重訂多少次都只會拿到
   * `permanently-removed.invalid`。唯一能從代碼裡走出來的路是換一個 SW 註冊 id，
   * 綁在舊 id 上的壞記錄自然失效。
   *
   * 副作用：SW 會短暫下線（1 秒上下），這期間來的推送是真丟。但會點這個按鈕的前提
   * 就是「已經收不到了」，不存在把原本收得到的弄丟。主動消息 2.0 的排程存在 worker
   * 的 D1 裡、跟 SW 無關，不用像 proactive-push 那樣重新推排程回去。
   */
  async deepResetPushSubscription(): Promise<void> {
    if (isUnifiedPushPlatform()) {
      await this.resetPushSubscription();
      return;
    }

    const config = await requirePushReady();
    const client = await initializeClient(config);

    try {
      await client.deletePushSubscription();
    } catch (error) {
      console.warn('[ActiveMsg] 深度重置：刪除 worker 上的舊訂閱失敗，繼續重建', error);
    }

    await unsubscribeCurrentPush();

    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister().catch(() => false)));
    } catch (error) {
      console.warn('[ActiveMsg] 深度重置：註銷 Service Worker 失敗，繼續走重裝', error);
    }

    try {
      await KeepAlive.reregister();
      await navigator.serviceWorker.ready;
    } catch (error) {
      throw withFailKind(
        new Error(`Service Worker 重新註冊失敗：${(error as Error)?.message || error}`),
        '訂閱失敗',
      );
    }

    await resubscribeAndRegister(client);
  },

  /**
   * 「連接並驗證」的收尾：把瀏覽器當前的推送訂閱補登記到這台 worker 上。
   *
   * 訂閱存在 worker 自己的 D1 裡（push_subscriptions，一個用戶一行）。換一台 worker
   * 就是換一個空庫，而瀏覽器這側的訂閱一個字都沒變——SW 的 pushsubscriptionchange
   * 不會響，refreshPushSubscriptionIfMarked 也就沒有標記可消費。於是面板全綠、連接
   * 驗證通過，worker 到點卻讀不到訂閱，直接拋 PUSH_SUBSCRIPTION_MISSING：消息一條
   * 都發不出來，用戶這側看不到任何異常。所以連接這一步順手覆蓋寫一次。
   *
   * 只在**權限已授予且瀏覽器已有訂閱**時補。沒訂閱說明用戶還沒走「開啟通知與推送
   * 訂閱」那步，那是引導流程該做的事——連接不替用戶開推送，也不在這兒彈權限框。
   *
   * 返回值只為單測斷言：'registered' 補了 / 'skipped' 條件不滿足 / 'failed' 補失敗了。
   */
  async reconcilePushSubscription(): Promise<'registered' | 'skipped' | 'failed'> {
    if (isUnifiedPushPlatform()) {
      try {
        const { readUnifiedPushSubscription } = await import('./unifiedPushPlugin');
        const subscription = await readUnifiedPushSubscription();
        if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) return 'skipped';
        const config = await ensureWorkerReady();
        const client = await initializeClient(config);
        await client.putPushSubscription({ endpoint: subscription.endpoint, keys: subscription.keys });
        return 'registered';
      } catch (error) {
        console.warn('[ActiveMsg] 連接後補登記 UnifiedPush 訂閱失敗', error);
        return 'failed';
      }
    }

    try {
      if (describePushCapabilityGap()) return 'skipped';
      if (Notification.permission !== 'granted') return 'skipped';
      await KeepAlive.init();
      const registration = await navigator.serviceWorker.ready;
      if (!await registration.pushManager.getSubscription()) return 'skipped';
    } catch {
      // 探測本身炸了（SW 沒就緒 / 環境不支持）就算了，別為一句自檢攔住連接。
      return 'skipped';
    }

    try {
      await this.registerPushSubscription();
      return 'registered';
    } catch (error) {
      // init-tenant 過了、鑑權也通了，連接本身是成功的，這裡不能往外拋：否則用戶
      // 會被指去改一堆根本沒錯的配置。補不上就等排程那步（scheduleTask 也會登記）。
      console.warn('[ActiveMsg] 連接後補登記推送訂閱失敗', error);
      return 'failed';
    }
  },

  // 單用戶「連接」：先 POST /init-tenant 讓 worker 在自己的 D1 裡冪等建表
  // （Dashboard 粘貼部署的用戶不用碰 SQL），再拿一次 user key 驗證地址與鑑權都通，
  // 最後把推送訂閱補登記上去（換 worker 後雲端那份是空的，見 reconcilePushSubscription）。
  async connect() {
    const config = await ensureWorkerReady();

    // 先問 worker 配齊了沒：缺 D1 綁定或 master key 的話，下面的 init-tenant 必然失敗，
    // 而那一步只能按 HTTP 狀態猜個大概（三種原因共用「建表失敗」）。自檢能直接說出
    // 缺的是哪一樣、去哪兒補，用戶不用再去翻 Cloudflare 的日誌。
    const report = await inspectWorkerConfig(config);
    if (report && !report.ok) {
      throw withFailKind(new Error(report.message), '配置缺失');
    }

    const { status, body: initResponse } = await fetchWithAuthRaw('init-tenant', config, { method: 'POST' }, '初始化數據庫');
    if (!initResponse?.success) {
      throw withFailKind(
        new Error(initResponse?.error?.message || '主動消息 2.0 初始化數據庫失敗，請確認 Worker 已綁定 D1（變量名 DB）。'),
        resolveInitFailKind(status),
      );
    }
    // 「重新連接並驗證」是顯式的重新握手，緩存必須先作廢。用戶按它多半正是因為雲端換了
    // 東西（典型是在 Cloudflare 上換掉 AMSG_MASTER_KEY，用戶密鑰跟著換代），而記憶化的
    // 三個鍵一個都沒變 —— 不作廢的話這裡拿回來的還是握著舊密鑰的老 client：init-tenant
    // 成功、界面報「連接成功」，此後每一次加密調用（排任務 / 即時對話 / 讀雲端狀態）
    // worker 都解不開，只有整頁刷新才能恢復。
    invalidateClientCache();
    // 同理：那台 worker 上的 bundle 可能剛被換過（「更新 Worker」走的是同一個地址），
    // 而「認不認識後台任務」這個結論是按地址緩存的，不作廢就還認著升級前那句「不支持」。
    forgetBackgroundJobProbe();
    await initializeClient(config);
    await ActiveMsgStore.saveGlobalConfig({ ...config, initializedAt: Date.now() });
    // 「重新連接並驗證」是用戶顯式的一次對錶，按特性位存的能力位也當場探準，別等下次握手。
    // 排在保存之後：上面那句寫的是握手前的配置快照，探測結論放它前面會被原樣蓋回去。
    await this.probeWorkerFeatures();
    await this.reconcilePushSubscription();
    const nativeToken = readNativePushToken();
    if (nativeToken) await this.registerNativePushToken(nativeToken);
    // warnings 是「連上了，但有一塊功能是啞的」——比如 VAPID 沒配齊，任務能建、到點
    // 卻一條都推不出去。連接本身算成功，交給調用方提示，別攔住流程。
    return { ok: true, userId: config.userId, warnings: report?.warnings ?? [] };
  },

  // 分頁全量：循環 messages?limit=100&offset=<n>，每頁解密後讀 tasks 與 pagination.hasMore，
  // 拉到最後一頁為止。任一頁失敗整體拋錯——不能拿半頁結果去判「遠端不存在」（會誤傷沒拉到的任務）。
  // 每條任務帶上游投影的頂層 charId / clientTaskId，供按角色對帳/關閉全部。
  async listAllTasks(): Promise<any[]> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);

    const all: any[] = [];
    let offset = 0;
    const limit = 100;
    while (true) {
      const response = await fetchWithAuth(`messages?limit=${limit}&offset=${offset}`, config, {
        method: 'GET',
        headers: {
          'X-Response-Encrypted': 'true',
          'X-Encryption-Version': '1',
        },
      }, '讀取任務列表');

      if (!response?.success) {
        throw new Error(response?.error?.message || '讀取主動消息 2.0 任務列表失敗。');
      }

      const page = await decryptPayload(client, response.data);
      const pageTasks: any[] = page?.tasks || [];
      all.push(...pageTasks);

      if (!page?.pagination?.hasMore || pageTasks.length === 0) break;
      offset += limit;
    }
    return all;
  },

  /**
   * 某個角色在遠端的任務投影（uuid + status + lastError），面板對帳 / 失敗可見化用。
   *
   * 老 worker（amsg-server < 2.6.0-next.5）不投影 charId：遠端明明有任務，這裡卻一條都
   * 匹配不上。空結果此時不是「遠端沒有」的證據，直接拋錯讓調用方走各自的降級——面板
   * 對帳整體關掉「遠端不存在」徽標，關閉 2.0 退回本地全量清單——而不是拿半份證據誤判。
   *
   * lastError 是 run-tick 記進 payload 的「上一次為什麼沒發出去」（2.6.0-next.10 起
   * GET /messages 透出；舊 worker 沒有這字段 → null，界面上就是不顯示那行說明）。
   */
  async listRemoteTasksForChar(charId: string): Promise<RemoteTaskProjection[]> {
    const tasks = await this.listAllTasks();
    if (tasks.length > 0 && tasks.every((t) => t?.charId == null)) {
      throw new Error('worker 版本過舊：任務列表沒有 charId 投影，無法按角色對帳，請在設置裡重新粘貼部署。');
    }
    return tasks
      .filter((t) => t?.charId === charId && typeof t?.uuid === 'string')
      .map((t) => ({
        uuid: t.uuid as string,
        status: typeof t?.status === 'string' ? t.status as string : undefined,
        lastError: parseRemoteTaskLastError(t?.lastError),
        clientTaskId: typeof t?.clientTaskId === 'string' ? t.clientTaskId : undefined,
        messageType: typeof t?.messageType === 'string' ? t.messageType : undefined,
        // 排程方寫進 payload 的自由文本標籤，即時對話的行標著 'instant-chat'。
        messageSubtype: typeof t?.messageSubtype === 'string' ? t.messageSubtype : undefined,
        recurrenceType: typeof t?.recurrenceType === 'string' ? t.recurrenceType : undefined,
        // 遠端算出來的下一次觸發時刻。循環任務按角色時區的牆鍾推進，本地拿固定週期
        // 自己乘出來的那個跨夏令時會偏一小時——顯示以遠端為準，跟真正會響的時刻一致。
        nextSendAt: typeof t?.nextSendAt === 'string' ? t.nextSendAt : undefined,
        // 已經重試過幾次（遠端行上的計數）。舊 worker 不投影這字段 → undefined。
        retryCount: typeof t?.retryCount === 'number' ? t.retryCount : undefined,
      }));
  },

  /**
   * 取消一個遠端任務。**冪等**：遠端已經沒有這一條（一次性任務發完就刪行、或在別處
   * 取消過），amsg-server 回 404 `TASK_NOT_FOUND`，那正是取消要達到的終態，算成功並
   * 帶上 alreadyGone=true 交給調用方——當失敗處理會讓「取消一條已經發過的任務」顯示
   * 成紅色的「遠端取消失敗，可重試」，其實沒有任何東西需要重試。
   * 其餘錯誤（鑑權、D1 掛了、網絡）照常拋，別一起吞掉。
   */
  async cancelTask(taskUuid: string): Promise<{ uuid: string; alreadyGone: boolean }> {
    const config = await ensureWorkerReady();
    const response = await fetchWithAuth(`cancel-message?id=${encodeURIComponent(taskUuid)}`, config, {
      method: 'DELETE',
    }, '取消任務');

    if (!response?.success) {
      if (response?.error?.code === REMOTE_TASK_NOT_FOUND_CODE) {
        return { uuid: taskUuid, alreadyGone: true };
      }
      throw new Error(response?.error?.message || '取消主動消息 2.0 任務失敗。');
    }

    return { uuid: taskUuid, alreadyGone: false };
  },

  /**
   * 查一條任務此刻的狀態（即時對話「一直等」的判定器）。
   * 比 listAllTasks（全表分頁 + 逐行解密）便宜得多，適合回前台時點名查一條。
   *
   * 只認遠端明說的這兩個錯誤碼來下結論，不看 HTTP 狀態：worker 地址填錯時未知路由
   * 同樣回 404（錯誤碼是 NOT_FOUND），照狀態判就會把「壓根沒問到」當成「任務沒了」。
   * 網絡故障、鑑權失敗照常拋——調用方據此什麼都不結論，繼續等。
   */
  async getRemoteTaskStatus(taskUuid: string): Promise<RemoteTaskStatus> {
    const config = await ensureWorkerReady();
    const response = await fetchWithAuth(`message?id=${encodeURIComponent(taskUuid)}`, config, {
      method: 'GET',
      headers: {
        'X-Response-Encrypted': 'true',
        'X-Encryption-Version': '1',
      },
    }, '查詢任務狀態');

    if (!response?.success) {
      const code = response?.error?.code;
      if (code === REMOTE_TASK_NOT_FOUND_CODE) return { state: 'gone' };
      if (code === REMOTE_TASK_ALREADY_COMPLETED_CODE) {
        // 失敗摘要跟著 409 一起來（新 worker 的 details.lastError；明文列，無憑據）。
        const details = (response.error as { details?: { lastError?: unknown } } | undefined)?.details;
        return { state: 'completed', lastError: parseRemoteTaskLastError(details?.lastError) };
      }
      throw new Error(response?.error?.message || '查詢任務狀態失敗。');
    }

    // 能回 200 的行必然是 pending（上游那條 SQL 寫死了 status='pending'）。
    // 響應整體加密，解出來是 { task }，字段在裡頭。解密要用戶密鑰，所以拖到這一步
    // 才建客戶端——判定成 gone / completed 的那兩條路省掉一次 get-user-key 往返。
    const client = await initializeClient(config);
    const task = (await decryptPayload(client, response.data))?.task ?? {};
    return {
      state: 'pending',
      ...(typeof task.retryCount === 'number' ? { retryCount: task.retryCount } : {}),
      ...(typeof task.nextSendAt === 'string' ? { nextSendAt: task.nextSendAt } : {}),
    };
  },

  /**
   * 服務端消息帳本里還沒銷帳的條目，翻頁拉全。
   *
   * 「哪些消息客戶端還沒收下」在服務端是查得出來的事實——每條推送發出去之前先記一行，
   * 客戶端落庫之後銷帳。所以這裡不做任何本地對帳，讀回來是什麼就是什麼。
   *
   * 讀失敗照常拋：調用方要能分清「讀到了、裡面確實沒有」和「壓根沒讀成」，
   * 後者不構成任何結論——網絡抖一下、請求被掐斷都會讀失敗，消息可能好好地躺在帳本上，
   * 拿它判「消息沒了 / 發送失敗」就是誤判。
   */
  async listOutboxEntries(): Promise<AmsgOutboxEntry[]> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    const collected: AmsgOutboxEntry[] = [];
    let since: number | undefined;

    for (let page = 0; page < OUTBOX_MAX_PAGES; page += 1) {
      const response = await client.getOutbox({
        limit: OUTBOX_PAGE_SIZE,
        ...(since == null ? {} : { since }),
      });
      if (!response?.success) {
        throw new Error(response?.error?.message || '讀取雲端消息帳本失敗。');
      }
      const data = (response.data ?? {}) as {
        entries?: unknown;
        cursor?: unknown;
        hasMore?: unknown;
      };
      const entries = Array.isArray(data.entries) ? data.entries : [];
      for (const raw of entries) {
        const entry = raw as Partial<AmsgOutboxEntry> | null;
        // messageId 是銷帳和去重的唯一依據，缺了這條就沒法處理，跳過。
        if (!entry || typeof entry.messageId !== 'string' || !entry.messageId) continue;
        if (!entry.push || typeof entry.push !== 'object') continue;
        collected.push({
          id: typeof entry.id === 'number' ? entry.id : 0,
          messageId: entry.messageId,
          taskUuid: typeof entry.taskUuid === 'string' ? entry.taskUuid : null,
          sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : null,
          messageIndex: typeof entry.messageIndex === 'number' ? entry.messageIndex : null,
          totalMessages: typeof entry.totalMessages === 'number' ? entry.totalMessages : null,
          createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
          deliveredAt: typeof entry.deliveredAt === 'number' ? entry.deliveredAt : null,
          push: entry.push as Record<string, any>,
        });
      }
      if (data.hasMore !== true) break;
      const cursor = typeof data.cursor === 'number' ? data.cursor : null;
      // 游標沒往前走就停：再拉一次是同一頁，會轉成死循環。
      if (cursor == null || (since != null && cursor <= since)) break;
      since = cursor;
    }

    return collected;
  },

  /**
   * 銷帳：告訴服務端這些消息已經收下了，之後不會再拉到。
   *
   * **只在消息真的落地之後調**——帳銷了而落庫半途失敗的話，這條消息就再也補不回來。
   * 冪等，重複銷同一批不會出錯。超過單次上限自動分批；某一批失敗不攔著後面幾批，
   * 沒銷掉的下次拉回來會被落庫那層的去重擋下，不會重複上屏。
   */
  async ackOutboxMessages(messageIds: string[]): Promise<void> {
    const ids = Array.from(new Set(messageIds.filter((id) => typeof id === 'string' && !!id)));
    if (ids.length === 0) return;
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    let failed = 0;
    let lastError: unknown = null;
    for (let i = 0; i < ids.length; i += OUTBOX_ACK_BATCH_SIZE) {
      const batch = ids.slice(i, i + OUTBOX_ACK_BATCH_SIZE);
      // 一批掛了繼續跑後面幾批：中途 throw 的話剩下的批次一條都銷不掉，帳本只會
      // 越積越多，下一趟又整批拉回來。沒銷掉的那批下次拉回來有落庫那層的去重擋著。
      try {
        const response = await client.ackOutbox(batch);
        if (!response?.success) {
          throw new Error(response?.error?.message || '雲端消息帳本銷帳失敗。');
        }
      } catch (error) {
        failed += batch.length;
        lastError = error;
      }
    }
    if (failed > 0) {
      const detail = lastError instanceof Error ? lastError.message : String(lastError);
      throw new Error(`雲端消息帳本銷帳失敗（${failed}/${ids.length} 條沒銷掉）：${detail}`);
    }
  },

  /**
   * 取消某個角色在遠端的全部任務（關閉 2.0 / 刪角色共用）。
   *
   * 以遠端清單為準：本地 pending 派生會漏掉「已過點但 Cron 還沒消費」的一次性任務，
   * 只按本地清單取消會留下還會響的幽靈任務。遠端讀不到（網絡故障 / 老 worker 沒
   * charId 投影）才退回調用方給的本地清單——半份證據也比不取消強。
   *
   * 逐條取消，單條失敗記進 failed 繼續跑完其餘的：一條網絡抖動不該讓剩下的任務都留著。
   *
   * 即時對話的行不在取消範圍內（過濾口徑與面板對帳同一把尺 AMSG_INSTANT_CHAT_SUBTYPE，
   * 見 amsg2Tasks 的 reconcileTasksWithRemote）：那不是定時任務，是用戶此刻正等著的一輪
   * 聊天。角色的 2.0 開關管的是定時主動消息，連它一起掐掉的話 worker 那一跳永遠不會跑，
   * 用戶等到的是一句「雲端已處理這條消息，但回覆沒能取回」，還得自己把話重發一遍。
   * 退回本地清單的那條路天然不含即時對話（本地任務記錄裡從來沒有它）。
   */
  async cancelAllTasksForChar(
    charId: string,
    localTaskUuids: string[],
  ): Promise<{ targets: string[]; failed: Set<string> }> {
    let targets: string[];
    try {
      targets = (await this.listRemoteTasksForChar(charId))
        .filter((task) => task.messageSubtype !== AMSG_INSTANT_CHAT_SUBTYPE)
        .map((task) => task.uuid);
    } catch {
      targets = localTaskUuids;
    }
    const failed = new Set<string>();
    for (const uuid of targets) {
      try { await this.cancelTask(uuid); } catch { failed.add(uuid); }
    }
    return { targets, failed };
  },

  async scheduleCharacterTask(params: {
    char: CharacterProfile;
    /** 角色級共享設置（secondaryApi / maxTokens）。 */
    config: ActiveMsg2CharacterConfig;
    /** 本次要排的任務。 */
    task: {
      mode: ActiveMsg2Mode;
      firstSendTime: string;
      recurrenceType: ActiveMsg2Recurrence;
      promptHint?: string;
      userMessage?: string;
      expirePolicy?: ActiveMsg2ExpirePolicy;
      /** 角色自己排的（工具橋傳 true）。帶上 metadata 標記，連發上限的到點兜底閘只攔它。 */
      selfScheduled?: boolean;
      /**
       * 任務行的 messageSubtype，不傳就是 'chat'。借這條路排、但不是主動消息的任務
       * （延遲自動回覆）靠它在面板對帳時擋在清單外面。
       */
      subtype?: string;
      /** 「本次任務」指令的整段替換，不傳就按 mode / promptHint 生成。 */
      instruction?: string;
      /** 額外寫進任務 metadata 的標記（例如延遲回覆的 amsgDelayedReply）。 */
      extraMetadata?: Record<string, unknown>;
    };
    /** 編輯/續期時傳舊任務 uuid：先取消它再新建（不傳 = 純新建）。 */
    replaceTaskUuid?: string;
    userProfile: UserProfile;
    groups: GroupProfile[];
    realtimeConfig: RealtimeConfig;
    apiConfig: APIConfig;
  }) {
    const { char, config, task, replaceTaskUuid, userProfile, groups, realtimeConfig, apiConfig } = params;
    const globalConfig = await ensureWorkerReady();
    const client = await initializeClient(globalConfig);
    // 任務體不帶訂閱，worker 到點讀用戶級那一份——所以建任務前先把它登記上去。
    const nativeToken = readNativePushToken();
    if (nativeToken) await this.registerNativePushToken(nativeToken);
    else await this.registerPushSubscription();

    // 數量封頂：待觸發任務（不含被替換的那個）排滿就拒絕，讓角色/用戶先清。名額用戶可調，
    // 用戶和角色共用（見 amsgLimits 的 maxActiveTasks）。
    const maxActiveTasks = resolveAmsgLimits(config).maxActiveTasks;
    const pendingOthers = getPendingTasks(config, Date.now())
      .filter((t) => t.taskUuid !== replaceTaskUuid);
    if (pendingOthers.length >= maxActiveTasks) {
      throw new Error(`該角色同時排著的消息已經有 ${maxActiveTasks} 條了（上限在「主動頻率」裡調），請先取消或合併已有的。`);
    }

    // 角色的時間參照系：任務行、fire_pack、worker 渲染全用這一個，解析 send_at 也一樣。
    const tzId = resolveCharTimeZone(char) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    // 裸牆鍾在這裡被折成絕對時刻。調用方要把這一份存進任務記錄（見返回值 firstSendAt），
    // 別存自己手上那個牆鍾串——角色寫的是它那邊的鐘、面板填的是設備的鐘，兩種串長得一樣，
    // 落盤後誰也認不出該按哪個時區讀，本地一律 new Date() 按設備解析就會差一個時差。
    const firstSendTime = ensureFutureTime(task.firstSendTime, tzId);
    // AI 模式的 prompt 只有一條來源：firePack 上傳 client_state，worker 到點現場填槽。
    // 任務體裡不再凍結一份渲染好的 prompt——讀不到 fire_pack 就直接報錯，沒有第二條路，
    // 留著那份快照只是白佔請求體（完整角色卡 + 世界書）。
    const firePack = task.mode === 'fixed'
      ? null
      : await buildFirePack(char, userProfile, groups, realtimeConfig);
    // 任務身份：客戶端自造 clientTaskId——遠端 uuid 要創建成功後才有，而 metadata
    // 必須在創建時就帶上歸屬鍵；push 原樣透傳，送達歸屬全靠它。
    const clientTaskId = crypto.randomUUID();

    const remoteAvatarUrl = toRemoteAvatarUrl(char.avatar);
    const payload: Record<string, any> = {
      contactName: char.name,
      // 本地 base64 頭像過不了 worker 的校驗，不合格乾脆不帶這個字段（見 toRemoteAvatarUrl）。
      ...(remoteAvatarUrl ? { avatarUrl: remoteAvatarUrl } : {}),
      messageType: task.mode,
      messageSubtype: task.subtype || 'chat',
      firstSendTime,
      recurrenceType: task.recurrenceType,
      // 角色的時間參照系（與 fire_pack 同一份）。daily / weekly 由 worker 按這個時區的
      // 牆鍾推進——固定加 24 小時的話，跨夏令時切換之後每天的觸發時刻會永久偏一小時。
      tzId,
      metadata: {
        charId: char.id,
        charName: char.name,
        source: 'active_msg_2',
        // worker 滿血鏈路的 onLLMOutput 拿不到任務頂層的 messageType，靠 metadata 透傳
        // 還原 push.messageType（老任務沒這字段時 worker 回退 'auto'，收側只展示不路由）。
        amsgMode: task.mode,
        // 防穿幫閘字段：worker onBeforeFire 與客戶端送達兜底都從這裡讀。
        // fixed 恆為 force——它走不了 worker 閘（taskNeedsLlm=false），語義統一釘死。
        // recurrenceType / occurrenceMs 不往這兒抄：庫會把它們蓋在每條 push 頂層，
        // 角色在 fire 裡自排的任務也一樣有，抄一份反而多一處會漏寫的地方。
        amsgClientTaskId: clientTaskId,
        amsgExpirePolicy: resolveExpirePolicy(task.mode, task.expirePolicy),
        // 自排標記：到點兜底閘只攔帶它的任務（用戶面板排的不帶、不受連發上限管）。
        ...(task.selfScheduled ? { amsgSelfScheduled: true } : {}),
        ...(task.extraMetadata || {}),
      },
    };

    // 憑據這一輪走哪條路：能存表就只帶引用，老 worker 照舊內聯三件套。
    // 引用那條路要先把行傳上去（下面的 credRow），傳成功才建任務。
    const useCredRefs = task.mode !== 'fixed' && await isLlmCredentialsReady();
    let credRow: LlmCredentialRow | null = null;

    if (task.mode === 'fixed') {
      const userMessage = task.userMessage?.trim();
      if (!userMessage) throw new Error('固定消息模式需要填寫消息內容。');
      payload.userMessage = userMessage;
    } else {
      const activeApi = resolveApiConfig(char, config, apiConfig);
      // 「本次任務」指令隨任務 metadata 走，worker 到點拿它填 fire_pack 的指令槽。
      payload.metadata.amsgTaskInstruction = task.instruction?.trim() || buildTaskInstruction(task.mode, task.promptHint);
      // 服務端要求「completePrompt 或 messages」二選一，且 messages 必須非空、
      // content 必須非空字符串，所以這裡給一條佔位。到點真正發給 LLM 的 messages 由
      // worker 的 onBeforeFire 返回值覆蓋（庫用 { ...payload, messages } 調 LLM），
      // 這條內容永遠不參與生成——它要是真出現在哪裡，就說明 worker 的 fire hooks 沒生效。
      payload.messages = [{ role: 'user', content: AMSG2_PLACEHOLDER_PROMPT }];
      if (useCredRefs) {
        // 引用與內聯三件套上游只收一種，同傳直接 400——所以這條路上一個內聯字段都不寫。
        // 行的值按 (char, config, apiConfig) 現算，與後台補傳那條路同一個入口，
        // 兩邊算出來的指紋才對得上（否則每次排程都會白傳一次）。
        credRow = buildCharChatCredRow(char, config, apiConfig);
        if (!credRow) throw new Error('主動消息 2.0 缺少可用的 API URL / Key / Model。');
        payload.credRefs = { chat: credRow.credId };
      } else {
        payload.apiUrl = normalizeChatApiUrl(activeApi.baseUrl);
        payload.apiKey = activeApi.apiKey;
        payload.primaryModel = activeApi.model;
      }
      if (config.maxTokens && config.maxTokens > 0) {
        payload.maxTokens = config.maxTokens;
      }
    }

    // ── 先傳雲端狀態，成功了再建任務 ──
    // fire_pack / tool_pack 都按角色存、不依賴任務 id，所以順序可以倒過來。倒過來的好處：
    // 上傳失敗時遠端還沒有任務，直接拋錯就行，既不用回滾、也不會留下「用戶看到排程失敗、
    // 遠端卻會到點觸發」的幽靈任務。反過來（先建後傳）失敗時只剩降級或回滾兩條路，都更差。
    //
    // 反向的殘留是無害的那一側：上傳成功但建任務失敗 → 雲端多一份沒人引用的 fire_pack，
    // 不會被讀（worker 只在 fire 某個任務時讀它），下次同步直接覆蓋。
    //
    // 大值（胖角色的完整角色卡 / 世界書）由 amsg-server 2.6.0-next.4+ 在 worker 存儲層
    // 透明分塊，客戶端整條直傳即可；老 worker 會拒超限條目 → putClientStateOrThrow 拋錯。
    //
    // 角色欠著即時對話回覆時，這一批裡的 fire_pack 抽掉不寫（口徑與批量同步那條路共用
    // owesInstantChatReply）：雲端此刻那份帶著用戶正等的這一輪 chat 段，蓋掉的話 worker
    // 到點只能硬失敗。tool_pack / tool_config 裡沒有 chat，照傳。抽掉的那份不會就此作廢：
    // 排完任務緊跟著的落庫會打髒，等回覆銷帳後由狀態同步把最新的包補上去。
    if (firePack) {
      const now = stampStateUpdatedAt();
      const owesChat = owesInstantChatReply(char.id);
      if (owesChat) {
        console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 該角色還欠著一條即時對話回覆，這次排程不覆蓋雲端 fire_pack（等回覆銷帳後由狀態同步補傳）`);
      }
      const charEntries = await buildCharStateEntries(char, firePack, now);
      await putClientStateOrThrow(client, [
        ...(owesChat ? charEntries.filter((entry) => entry.key !== AMSG_FIRE_PACK_KEY) : charEntries),
        buildToolConfigEntry(realtimeConfig, now),
      ], '上傳雲端狀態');
    }

    // 憑據行要先在雲端存在：上游建任務前會挨個查引用，缺一個就 409 CREDENTIAL_NOT_FOUND。
    // 只在值變過時真的發請求（指紋底帳），所以常態下這一步一個請求都不發。
    if (credRow) await putLlmCredentialRows([credRow]);

    const postSchedule = async () => {
      const encrypted = await encryptPayload(client, payload);
      return fetchWithAuth('schedule-message', globalConfig, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Payload-Encrypted': 'true',
          'X-Encryption-Version': '1',
        },
        body: JSON.stringify(encrypted),
      }, '創建任務');
    };

    let response = await postSchedule();
    // 雲端說這行憑據不存在（換過 master key、點過「清空雲端數據」、或者上一次上傳其實
    // 沒落地而本地底帳記著傳過）——本地那本帳此刻是髒的，繞過指紋強傳一次再重排一次。
    // 只自愈一次：再不成就是真出了別的問題，拋給用戶看得見的報錯。
    if (!response?.success && response?.error?.code === 'CREDENTIAL_NOT_FOUND' && credRow) {
      console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 雲端沒有這行憑據，補傳後重排一次`, credRow.credId);
      forgetCredIds([credRow.credId]);
      await putLlmCredentialRows([credRow], { force: true });
      response = await postSchedule();
    }

    if (!response?.success) {
      throw new Error(response?.error?.message || '主動消息 2.0 任務創建失敗。');
    }

    // 先建後刪（Codex #4）：新任務確認創建成功才取消舊的——反過來一旦創建失敗，
    // 舊任務已刪、新任務沒建，兩頭空。取消失敗時新舊短暫並存於遠端，把狀態交還
    // 調用方（保留舊記錄 + 標錯 + 可重試），絕不靜默。
    let replacedCancelFailed = false;
    if (replaceTaskUuid) {
      try {
        await this.cancelTask(replaceTaskUuid);
      } catch (error) {
        replacedCancelFailed = true;
        console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 替換後取消舊任務失敗（遠端新舊並存，待重試）`, error);
      }
    }

    return {
      ...(response.data as { uuid: string; status: string; nextSendAt?: string }),
      clientTaskId,
      replacedCancelFailed,
      // 解析好的絕對時刻（UTC ISO）。任務記錄存這一份，字段口徑才只有一種。
      firstSendAt: firstSendTime,
    };
  },

  /**
   * 這台 worker 上的代碼認不認識「後台任務」。
   *
   * 認的是 `GET /config-check` 裡的 `backgroundJobs`——**這份 bundle 裡有沒有那段分派代碼**，
   * 不是版本號：自更新永遠由用戶那台 Worker 上的舊代碼執行，「版本號對上了、新邏輯沒生效」
   * 是真實存在的中間態（即時對話那次踩過，見 probeInstantChatSupportDetailed）。
   *
   * 老 bundle 不報這個字段 → false，調用方留在本地跑。老 worker 會把後台任務當聊天任務
   * 跑、卡在「本次任務指令缺失」終態失敗，而那條任務行不在用戶的清單裡——面板一片正常，
   * 活兒卻永遠不幹。這道門就是為了別走到那兒。
   *
   * 探不到（網絡抖 / 沒連上）是單獨一種結論 `unknown`，不跟「不支持」混：後台活兒本來
   * 就有本地那條路，寧可這一輪在本地跑掉也別建一條註定失敗的任務——但「這次沒問到」時
   * 手上可能還有一份任務正在雲端跑，那時候退回本地是有害的（見 plateCloudGate）。
   *
   * 「問不到」也**不寫進緩存**——只有拿到明確答覆（不管支不支持）才按 workerUrl 記下來。
   * 混著緩存的話，一次代理切換、一次 CF 邊緣抖動、一次 D1 冷啟動超時，就能把整個會話
   * 釘死在本地整理，只有刷新頁面才翻得回來。
   *
   * 緩存本身只為省掉「一輪裡連著提交好幾個 job」時的重複請求——這類任務幾十輪才跑一次。
   */
  async probeBackgroundJobSupportDetailed(): Promise<BackgroundJobProbeOutcome> {
    let config: ActiveMsg2GlobalConfig;
    try {
      config = await ensureWorkerReady();
    } catch {
      return 'unknown';
    }
    const cached = backgroundJobProbe;
    if (
      cached?.workerUrl === config.workerUrl
      // 「不支持」只當階段性結論：worker 可能在這個會話裡被別的路徑換掉了
      // （見 BACKGROUND_JOB_UNSUPPORTED_RECHECK_MS）。
      && (cached.supported || Date.now() - cached.at < BACKGROUND_JOB_UNSUPPORTED_RECHECK_MS)
    ) {
      return cached.supported ? 'supported' : 'unsupported';
    }
    try {
      const { status, body } = await fetchWithAuthRaw(
        'config-check', config, { method: 'GET' }, '後台任務能力探測',
      );
      if (status !== 200 || body?.success !== true) {
        console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 後台任務能力問不到（HTTP ${status}），不記緩存`);
        return 'unknown';
      }
      const supported = body?.data?.backgroundJobs === true;
      backgroundJobProbe = { workerUrl: config.workerUrl, supported, at: Date.now() };
      return supported ? 'supported' : 'unsupported';
    } catch (error) {
      console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 後台任務能力探測沒發出去，不記緩存`, error);
      return 'unknown';
    }
  },

  /** 只問「能不能交」的那一版：問不到當不能交。要區分「問不到」用上面那個。 */
  async probeBackgroundJobSupport(): Promise<boolean> {
    return (await this.probeBackgroundJobSupportDetailed()) === 'supported';
  },

  /**
   * 排一條**後台任務**：不說話的那種活兒（門牌整理是第一個），跑完把結果送回客戶端。
   *
   * 跟排主動消息的那條路（scheduleCharacterTask）共用調度器，但要的東西少得多：
   * 不傳 fire_pack / tool_pack（那是聊天專用的雲端狀態，worker 的 kind 分派排在讀它們
   * 之前），不填「本次任務指令」，也不寫防穿幫錨點——「到點還該不該說這句話」那一整套
   * 判斷對後台活兒都不適用。
   *
   * 只走憑據引用那條路，不做內聯降級：這類任務用的往往是副 API（比如記憶宮殿那份），
   * 內聯三件套那條老路只有一個 chat 槽位，塞進去等於把副 API 冒充成聊天 API。憑據存不了
   * 表的老 worker 上直接拋錯，調用方據此留在本地跑。
   *
   * 順序與排程那條路一致：**先傳輸入、成功了再建任務**。反過來失敗的話，遠端會留下一條
   * 到點取不到輸入的任務；這個方向的殘留是無害的那一側——沒人引用的輸入行會被
   * clientStateTtl 清掉。
   *
   * @returns 遠端任務 uuid
   */
  async scheduleBackgroundJob(params: {
    /** 業務種類，worker 按它分派 handler（見 utils/amsgTaskKinds.ts） */
    kind: string;
    /** 任務歸屬的角色。worker 的 charId 是必填的，調度器也按它分組串行 */
    charId: string;
    charName: string;
    /** 這一次的一次性輸入在 amsg:job 命名空間下的 key */
    jobKey: string;
    /** 任務 metadata 上帶的 job 編號，worker 靠它去抽屜裡取輸入 */
    jobId: string;
    /** 一次性輸入本體（會被 JSON 序列化 + 壓縮後上傳） */
    jobInput: unknown;
    /** 這條任務該用哪一行憑據。行不在雲端時這裡負責補傳 */
    credRow: LlmCredentialRow;
    /**
     * 採樣溫度與輸出上限：**同一件活兒在本地跑和在雲端跑必須用同一組**。
     * 不傳的話上游整個省略這兩個字段，落到供應商默認值（溫度常為 1.0、輸出上限常遠小於
     * 後台活兒需要的量）——同一批材料兩條路會跑出不一樣的結果，而界面上完全看不出來。
     */
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ uuid: string }> {
    const globalConfig = await ensureWorkerReady();
    const client = await initializeClient(globalConfig);

    if (!await isLlmCredentialsReady()) {
      throw new Error('這台 Worker 還不支持憑據存表，後台任務跑不了（去設置頁重新部署一次）。');
    }

    const now = stampStateUpdatedAt();
    await putClientStateOrThrow(client, [{
      namespace: AMSG_JOB_NAMESPACE,
      key: params.jobKey,
      value: await packStateValue(JSON.stringify(params.jobInput)),
      updatedAt: now,
    }], '上傳後台任務輸入');

    await putLlmCredentialRows([params.credRow]);

    const payload: Record<string, any> = {
      contactName: params.charName,
      messageType: 'auto',
      // 任務清單跟遠端對帳時靠它把這些行擋在外面（見 amsg2Tasks 的 reconcileTasksWithRemote）。
      messageSubtype: AMSG_BACKGROUND_JOB_SUBTYPE,
      // 立刻可跑：到期時間由服務端自己蓋，下一跳 cron（最多一分鐘）就會撈起來。
      // 不能改成客戶端算一個 firstSendTime——那個時刻在上傳輸入、傳憑據、加密、
      // 發請求這一路上早就過去了，服務端一律打回「時間必須在未來」，整條雲端路
      // 每次都退回本地跑。即時對話那條路同樣只用 immediate。
      immediate: true,
      recurrenceType: 'none',
      metadata: {
        charId: params.charId,
        charName: params.charName,
        source: 'active_msg_2',
        [AMSG_TASK_KIND_KEY]: params.kind,
        [AMSG_JOB_ID_KEY]: params.jobId,
      },
      credRefs: { chat: params.credRow.credId },
      ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
      ...(params.maxTokens && params.maxTokens > 0 ? { maxTokens: params.maxTokens } : {}),
      // 服務端要求「completePrompt 或 messages」二選一。到點真正發給 LLM 的 messages 由
      // worker 的 kind handler 返回值覆蓋，這條佔位內容永遠不參與生成。
      messages: [{ role: 'user', content: AMSG2_PLACEHOLDER_PROMPT }],
    };

    const postSchedule = async () => {
      const encrypted = await encryptPayload(client, payload);
      try {
        return await fetchWithAuth('schedule-message', globalConfig, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Payload-Encrypted': 'true',
            'X-Encryption-Version': '1',
          },
          body: JSON.stringify(encrypted),
        }, '創建後台任務');
      } catch (error) {
        // 請求發出去了卻沒等到答覆（斷網、超時、連接被掐）：這條任務可能已經在遠端建
        // 起來了。掛個標記交給調用方，別讓它把這種情形當成「沒交出去」——見
        // mayHaveCreatedBackgroundJob。只包這一步：上面上傳輸入、傳憑據那兩步排在建任務
        // 之前，它們失敗時確定還沒有任務。
        if (error && typeof error === 'object') {
          (error as Record<string, unknown>)[BACKGROUND_JOB_MAYBE_CREATED_PROP] = true;
        }
        throw error;
      }
    };

    let response = await postSchedule();
    // 與排程那條路同款自愈：本地指紋底帳記著傳過、雲端其實沒有（換過 master key /
    // 點過「清空雲端數據」）。繞過指紋強傳一次再重排一次，只自愈一次。
    if (!response?.success && response?.error?.code === 'CREDENTIAL_NOT_FOUND') {
      console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 雲端沒有這行憑據，補傳後重排一次`, params.credRow.credId);
      forgetCredIds([params.credRow.credId]);
      await putLlmCredentialRows([params.credRow], { force: true });
      response = await postSchedule();
    }

    if (!response?.success) {
      throw new Error(response?.error?.message || '後台任務創建失敗。');
    }
    return response.data as { uuid: string };
  },

  /**
   * 即時對話：把「用戶剛按下發送」這一輪交給雲端跑，一個請求受理完就返回。
   *
   * 請求體裡兩個信封都是這裡加密好的（外殼是明文 JSON，包裝層只搬不看）：
   *   statePayload —— 和 putClientState 逐字節同構的 `{ entries }`，帶這一輪的 fire_pack
   *                   （v7，多一段 chat）+ tool_pack + 全局工具憑據；
   *   taskPayload  —— 和 scheduleCharacterTask 同構的排程體，標著 amsgInstantChat。
   *
   * 只有 202 才算受理。**任何別的狀態都是「這條沒發出去」**，拋錯交調用方明說，
   * 絕不退回本地生成——靜默分流那種查無可查的坑踩過一次就夠了。
   */
  async sendInstantChat(params: {
    char: CharacterProfile;
    /** 本地生成會 POST 給 /chat/completions 的那串 fullMessages，原樣帶上去。 */
    chatMessages: Array<{ role: string; content: unknown }>;
    /**
     * 這一輪該用的聊天憑據——**必須是本地生成那一輪會用的同一份**（effectiveApi）。
     * 換成主動消息的「角色單獨 API」的話，同一句話開不開即時對話會由不同的模型來答，
     * 而用戶完全看不出這件事發生過。
     */
    api: { baseUrl: string; apiKey: string; model: string };
    /**
     * 本地這一輪會發的採樣溫度。不傳就是本地也不發（開思考時本地會刪掉溫度）——
     * 上游 buildLlmRequestBody 對空溫度整個省略該字段，兩邊落到同一個供應商默認值。
     */
    temperature?: number;
    maxTokens?: number;
    /**
     * 本地這一輪會額外發進請求體的字段（思考鏈三件套：thinking / reasoning_effort /
     * extra_body，由 useChatAI 的 shouldSendThinkingParams 分支決定）。worker 組請求體
     * 時原樣展開、核心字段（model/messages 等）優先——兩條路發出去的請求體必須一致，
     * 不然開思考的角色一開即時對話，心象卡片就靜默消失。
     */
    extraBody?: Record<string, unknown>;
    userProfile: UserProfile;
    groups: GroupProfile[];
    realtimeConfig: RealtimeConfig;
    /**
     * 這一輪的情緒評估（副 API 提示詞 + 憑據），交給雲端跑。
     * 走 taskPayload —— 那份是端到端加密的信封，憑據不會以明文出門。
     */
    emotionEval?: AmsgEmotionEvalSpec;
    /** 上一條還沒被認領的即時對話任務，連發兩條時用它頂掉（合併成一起回）。 */
    supersedesUuid?: string;
  }): Promise<{ uuid: string; clientTaskId: string }> {
    const { char, chatMessages, api, userProfile, groups, realtimeConfig } = params;
    if (!api.baseUrl || !api.model) throw new Error('即時對話沒發出去：聊天 API 地址或模型沒配齊。');
    const globalConfig = await ensureWorkerReady();
    const client = await initializeClient(globalConfig);

    const now = Date.now();
    const tzId = resolveCharTimeZone(char) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    // 模板只有定時任務那條路才渲染：角色 2.0 關著（雲端 fire 不注入排程工具，排不出
    // 會消費模板的新任務）且本地任務清單為空時，用佔位模板省掉每次發送的二次全量
    // 構建與上傳。2.0 開著 / 還掛著任務（含取消失敗的幽靈行）就老老實實帶真模板。
    const templateStub = !isAmsg2EnabledForChar(char)
      && (char.activeMsg2Config?.tasks?.length ?? 0) === 0;
    const firePack: AmsgFirePack = {
      ...(await buildFirePack(char, userProfile, groups, realtimeConfig, undefined, { templateStub })),
      // 先還原圖片令牌再算體積預算——反過來會讓一份「看著沒超」的包在雲端脹成幾 MB，
      // 而 worker 那邊根本解不開令牌（見 resolveChatMessagesForUpload）。
      chat: { messages: toFirePackChatMessages(await resolveChatMessagesForUpload(chatMessages)), builtAt: now },
    };

    const clientTaskId = crypto.randomUUID();

    // ── 這一輪的憑據走引用還是內聯 ──
    //
    // 走引用時兩行一起登記：
    //   char:<id>/instant  這一輪真正會用的聊天憑據（model 是請求體終值，claude 系開思考
    //                      時帶 -thinking 後綴）。**必須帶上它**——只帶 emotion 一個引用的話，
    //                      角色在這一輪裡給自己排的任務會繼承一份「有引用、沒聊天憑據」的
    //                      空殼（上游 scheduleTask 見到任何 credRefs 就不再複製內聯三件套）。
    //   char:<id>/emotion  情緒評估的副 API。有了它，評估配置裡就不必再塞一份憑據。
    //
    // 走內聯時一切照舊：三件套寫在任務頂層，評估配置連憑據一起放 metadata。
    const useCredRefs = await isLlmCredentialsReady();
    const credRows: LlmCredentialRow[] = [];
    const credRefs: Record<string, string> = {};
    if (useCredRefs) {
      const instantRow = buildCharInstantCredRow(char.id, api);
      if (instantRow) {
        credRows.push(instantRow);
        credRefs.chat = instantRow.credId;
      }
      if (params.emotionEval?.api) {
        const emotionRow = buildCharEmotionCredRow(char.id, params.emotionEval.api, {
          baseUrl: api.baseUrl, apiKey: api.apiKey, model: api.model,
        });
        // 只在聊天那一行也立得住時才掛 emotion：單掛一個 emotion 引用就是上面說的那種空殼。
        if (emotionRow && credRefs.chat) {
          credRows.push(emotionRow);
          credRefs.emotion = emotionRow.credId;
        }
      }
    }
    const inlineCreds = !credRefs.chat;
    // 評估配置：憑據走引用時只留提示詞模板，副 API 的 apiKey 一個字節都不進任務 metadata。
    const emotionEvalSpec = params.emotionEval
      ? (credRefs.emotion ? { prompt: params.emotionEval.prompt } : params.emotionEval)
      : undefined;

    const remoteAvatarUrl = toRemoteAvatarUrl(char.avatar);
    const taskPayload: Record<string, unknown> = {
      contactName: char.name,
      ...(remoteAvatarUrl ? { avatarUrl: remoteAvatarUrl } : {}),
      // 用 'auto' 而不是 'instant'：'instant' 在上游是「當場跑完」的行型，走不到 fire hooks，
      // 到點拿的就不是這份 chat 段。客戶端收到的 push.messageType 由 metadata.amsgMode 決定。
      messageType: 'auto',
      // 上游只把它當自由文本標籤原樣帶進推送，不據此分支；本地拿它把即時對話的行跟
      // 定時任務的行分開——不然一條失敗的即時對話行會被面板對帳當成排程任務補進清單。
      // 常量與面板對帳的過濾端共用（amsgFirePack 的 AMSG_INSTANT_CHAT_SUBTYPE）。
      messageSubtype: AMSG_INSTANT_CHAT_SUBTYPE,
      // 落庫即到期（不帶 firstSendTime）：用戶已經把話說完了，現在就該答。
      // 排未來時刻的話，打包/上傳的耗時都要預支提前量，慢網低端機會被
      // 「時間必須在未來」打回，而同一輪走本地路徑毫無問題。
      immediate: true,
      // 頂替上一條還沒被認領的任務（連發兩條時合併成一起回）：上游在建新任務的
      // 同一事務裡取消舊的，原子、無第二個請求。
      ...(params.supersedesUuid ? { supersedesUuid: params.supersedesUuid } : {}),
      recurrenceType: 'none',
      tzId,
      // 真正要發給模型的消息在 fire_pack.chat 裡，這條只為過上游「messages 非空」的校驗。
      messages: [{ role: 'user', content: AMSG2_PLACEHOLDER_PROMPT }],
      // 引用與內聯上游只收一種，同傳直接 400。
      ...(inlineCreds
        ? {
          apiUrl: normalizeChatApiUrl(api.baseUrl),
          apiKey: api.apiKey,
          primaryModel: api.model,
        }
        : { credRefs }),
      // 溫度跟著本地走：本地發多少雲端發多少，本地不發（開思考時）雲端也不發。
      // 少了它，同一句話雲端會落到供應商默認溫度（常為 1.0），回覆風格和本地對不上。
      ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
      ...(params.maxTokens && params.maxTokens > 0 ? { maxTokens: params.maxTokens } : {}),
      // 思考鏈三件套（thinking / reasoning_effort / extra_body）放行頂層，隨加密信封
      // 到 fire 時刻由上游 buildLlmRequestBody 展開進請求體（核心字段 model/messages
      // 等優先）。⚠️ 依賴上游 amsg-server 認領這個字段（/schedule-message 的
      // fullTaskData 白名單 + buildLlmRequestBody 的展開）；舊版上游會把它剝掉——
      // 那時行為退回「只有 -thinking 模型名後綴生效」，即本次改動前的樣子，不會更糟。
      ...(params.extraBody && Object.keys(params.extraBody).length > 0
        ? { llmExtraBody: params.extraBody }
        : {}),
      metadata: {
        charId: char.id,
        charName: char.name,
        source: 'active_msg_2',
        // push 的 messageType 取自這裡（收側按 'instant' 分軌）。
        amsgMode: 'instant',
        // worker 到點靠它認出「這是用戶在等回覆」，從而跳過那幾道主動消息專用的閘。
        amsgInstantChat: true,
        amsgClientTaskId: clientTaskId,
        // 情緒評估交給雲端跑：worker 到點和主回覆並行發起，結果隨最後一條推送回來
        // （見 worker/amsg/src/emotionEval.ts）。憑據走引用時這裡只剩提示詞模板；
        // 老 worker 那條路還帶著副 API 的 apiKey，它只能待在這個加密信封裡——worker
        // 組推送前會把它摘掉，一個字節都不許跟著 push 出門。
        ...(emotionEvalSpec ? { amsgEmotionEval: emotionEvalSpec } : {}),
        // 刻意不帶 amsgExpirePolicy：防穿幫閘問的是「到點還該不該主動開口」，
        // 對「回一句用戶剛說的話」不適用，帶上去反而會把用戶等著的回覆吞掉。
      },
    };

    // 雲端那一行的版本號走水位而不是牆鍾（見 amsgStateClock）：設備時鐘領先過真實時間
    // 的話，雲端會留著一個還沒到的時刻，之後每次上傳都被條件寫判成「舊的」，這條路上
    // 的表現就是每發一句都 409。
    const stampedAt = stampStateUpdatedAt();
    const stateEntries = [
      ...(await buildCharStateEntries(char, firePack, stampedAt)),
      buildToolConfigEntry(realtimeConfig, stampedAt),
    ];
    // 自愈那一輪只換戳、不重打包：value 裡那份壓好的 fire_pack 原樣複用。
    const encryptStateEntries = (updatedAt: number) => encryptPayload(client, {
      entries: stateEntries.map((entry) => ({ ...entry, updatedAt })),
    });
    const [encryptedTask, initialState] = await Promise.all([
      encryptPayload(client, taskPayload),
      encryptStateEntries(stampedAt),
    ]);
    // 重發那一輪要換成新蓋的戳，所以這份是可變的。
    let statePayload = initialState;

    // 憑據行先落地再建任務（上游建任務前會挨個查引用）。只有值變過才真的發請求，
    // 所以常態下這一步是零請求——不給「用戶正等著回覆」這條路白加一次往返。
    if (credRows.length > 0) await putLlmCredentialRows(credRows);

    const postInstantChat = () => fetchWithAuthRaw('instant-chat', globalConfig, {
      method: 'POST',
      // 外殼是明文：裡頭兩個信封已經加密好，別再給外殼掛加密頭（包裝層會當它是整體密文）。
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statePayload, taskPayload: encryptedTask }),
    }, '即時對話');

    let { status, body } = await postInstantChat();
    // 雲端說引用的憑據不存在（本地底帳髒了）：繞過指紋強傳一次再發一次，只自愈一次。
    // 包裝層把上游那份原樣塞在 error.upstream 裡，所以要往裡再剝一層看錯誤碼。
    if (status !== 202 && credRows.length > 0 && isCredentialNotFound(body)) {
      console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 雲端沒有這一輪引用的憑據，補傳後重發一次`);
      forgetCredIds(credRows.map((row) => row.credId));
      await putLlmCredentialRows(credRows, { force: true });
      ({ status, body } = await postInstantChat());
    }
    // 雲端拒收了這一輪的狀態：不是內容有問題，是這台設備蓋的時間戳跨不過雲端那一行
    // （設備時鐘被改過之後，雲端會一直留著一個還沒到的時刻）。讀回雲端那份對齊水位、
    // 重新蓋戳再發一次。對齊不動就不重發——那說明攔下它的不是時間戳，重發也是白發。
    if (status !== 202 && isInstantChatStateStale(body)) {
      if (await alignStateClockWithRemote(client, [amsgStateNamespace(char.id)])) {
        console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 雲端狀態的時間戳比本機的鐘新，對齊後重發這一輪`);
        statePayload = await encryptStateEntries(stampStateUpdatedAt());
        ({ status, body } = await postInstantChat());
      }
    }

    if (status !== 202 || typeof body?.uuid !== 'string' || !body.uuid) {
      throw new Error(describeInstantChatFailure(status, body));
    }
    return { uuid: body.uuid, clientTaskId };
  },

  // 同角色活躍會話租約：只 PUT 這一條几十字節的 chat_presence，不復用胖 fire_pack。
  // worker 對 expire AI 任務到點前先讀它——新鮮則 skip，避免正在聊天時又彈主動消息。
  // 寫入失敗由調用方（amsgStateSync 的 lease timer）只 warn，45s TTL 自然失效。
  async syncChatPresence(charId: string, presence: AmsgChatPresence): Promise<void> {
    const globalConfig = await ensureWorkerReady();
    const client = await initializeClient(globalConfig);
    const response = await client.putClientState([{
      namespace: amsgStateNamespace(charId),
      key: AMSG_CHAT_PRESENCE_KEY,
      value: JSON.stringify(presence),
      // 行的版本號走水位，而不是 presence.activeAt：worker 讀的是 value 裡那個
      // activeAt（45s TTL 判活躍），版本號只管「這一行能不能蓋上去」，兩者不是一回事。
      updatedAt: stampStateUpdatedAt(),
    }]);
    if (!response?.success) {
      throw new Error(response?.error?.message || '上傳活躍會話租約失敗。');
    }
  },

  // 滿血同步：把一批角色的最新 fire_pack 合成一次 putClientState 上傳（amsgStateSync
  // 打髒後在微任務裡合批調用；iOS 切後台只有幾秒存活窗口，多角色也必須一次請求寫完）。
  // 這裡只是拿最新聊天狀態去刷新雲端那份，失敗由調用方 warn（沿用上一份，上下文舊一點）。
  async syncCharFirePacks(items: Array<{
    char: CharacterProfile;
    config: ActiveMsg2CharacterConfig;
    userProfile: UserProfile;
    groups: GroupProfile[];
    realtimeConfig?: RealtimeConfig;
  }>): Promise<void> {
    if (!items.length) return;
    const globalConfig = await ensureWorkerReady();
    const client = await initializeClient(globalConfig);
    const now = stampStateUpdatedAt();
    // 表情包全庫與角色無關，整批讀一次就夠——放在循環裡的話 N 個角色要跑 2N 次全表
    // getAll（表情記錄帶圖片數據），拿回來的還是同一份。
    const emojiLibrary = await readEmojiLibrary();
    const entries = [];
    // 逐個串行：併發跑會同時開 N 個 IDB 事務，容易撞上 IndexedDB 連接風暴（寫失敗、確認超時）。
    for (const item of items) {
      const firePack = await buildFirePack(
        item.char, item.userProfile, item.groups, item.realtimeConfig, emojiLibrary,
      );
      // 大值由 amsg-server 2.6.0-next.4+ 在 worker 存儲層透明分塊，整條直傳，
      // 內容一個字不裁；老 worker 拒超限條目 → 設置頁 capabilities 探測亮牌。
      entries.push(...(await buildCharStateEntries(item.char, firePack, now)));
    }
    const response = await client.putClientState(entries);
    if (!response?.success) {
      throw new Error(response?.error?.message || '上傳雲端狀態失敗。');
    }
    // amsg-server 2.6.0-next.4+ 局部失敗語義：單個壞條目只拒自己，不連坐同批。
    // 被拒的條目點名 warn 出來（該角色沿用上一份 fire_pack，其餘角色不受影響）。
    const rejected = (response as { data?: { rejected?: Array<{ namespace: string; key: string; message?: string }> } })
      .data?.rejected;
    if (rejected && rejected.length > 0) {
      console.warn(
        `${ACTIVE_MSG_RUNTIME_HEADER} 雲端狀態部分條目被拒（對應角色沿用上一份 fire_pack）`,
        rejected.map((r) => `${r.namespace}/${r.key}: ${r.message || 'rejected'}`),
      );
    }
    // amsg-server 2.6.0-next.15 起服務端按 updatedAt 做條件寫（舊不蓋新）。被攔有兩種
    // 成因，長得一模一樣：雲端確實有更新的一份（多設備 / 多標籤頁競寫），或者雲端那行
    // 的時間戳落在了未來（設備時鐘被改過，見 amsgStateClock）。後者不管的話，這個角色
    // 的雲端上下文會一直停在舊版本、主動消息一直拿舊上下文說話，而這條路上除了這行 log
    // 沒有任何動靜——比即時對話那條明著報 409 的還難發現。
    //
    // 對齊水位就夠了，這一輪不重傳：fire_pack 每輪聊天都是全量重建的，下一次打髒同步
    // 帶著更新的內容蓋過去，比現在拿這份已經被判成「舊」的包硬擠進去更有道理。
    const skipped = (response as { data?: { skippedEntries?: Array<{ namespace: string; key: string }> } })
      .data?.skippedEntries;
    if (skipped && skipped.length > 0) {
      console.warn(
        `${ACTIVE_MSG_RUNTIME_HEADER} 雲端已有更新的一份，這批條目被條件寫攔下`,
        skipped.map((s) => `${s.namespace}/${s.key}`),
      );
      await alignStateClockWithRemote(client, [...new Set(skipped.map((s) => s.namespace))]);
    }
    // 同步已經落定，順路把這幾個角色的存量空殼清一遍（每角色一次，失敗只 warn）。
    await sweepSidechannelShells(client, items.map((item) => item.char.id));
  },

  async syncToolConfig(realtimeConfig: RealtimeConfig | undefined): Promise<void> {
    const globalConfig = await ensureWorkerReady();
    const client = await initializeClient(globalConfig);
    const response = await client.putClientState([buildToolConfigEntry(realtimeConfig, stampStateUpdatedAt())]);
    if (!response?.success) {
      throw new Error(response?.error?.message || '上傳工具憑據失敗。');
    }
  },

  // worker 特性探測（amsg-server 2.6.0-next.4+ 的 GET /capabilities）。
  // 老部署沒有這個端點 → null。設置頁用它亮「worker 需要重新粘貼部署」的牌子，
  // 防止版本落後時新特性靜默降級、用戶以為功能壞了。不需要 init（無加密參與）。
  /**
   * 這台 worker 現在**真的跑得動**即時對話嗎（即時對話的唯一版本門檻）。
   *
   * 認的是 `GET /config-check` 裡的 `instantTick`——運行時到底有沒有 INSTANT_TICK 綁定。
   * 不認 `instantChat`（那隻說明代碼裡有這條路由）也不認版本號，因為這三樣會分家：
   * 自更新由用戶那台 Worker 上的**舊代碼**執行，舊代碼不認識 Durable Object，所以更新完
   * 第一下常常是「代碼新了、版本號也對上了、綁定卻沒接上」，這條路只能回 503。看版本號
   * 的話前端會一邊說「已經是最新版」一邊發一條掛一條。
   *
   * 「探不到」和「問到了、答案是不行」是兩回事，只有後者才寫進存量——詳見
   * InstantChatProbeOutcome 那段註釋。返回值是**探完之後生效的存量**（探不到時
   * 就是探測前那份），調用方只想要一個「現在能不能上雲」時用這個簽名即可；要分辨
   * 這次到底問沒問到，用 probeInstantChatSupportDetailed。
   *
   * 結論順手存進全局配置（`instantChatSupported`）：真正攔下這一輪的是發消息那條路上的
   * resolveInstantChatReadiness，而它只認這份存量（外加存量為 false 時的一次現探）。
   */
  async probeInstantChatSupport(options?: { timeoutMs?: number }): Promise<boolean> {
    return (await this.probeInstantChatSupportDetailed(options)).supported === true;
  },

  /**
   * 同上，但把「這次到底問到了什麼」一併交出來。發消息路上的重探要靠它區分
   * 「確認跑不動」（該提示去更新 Worker）和「這一刻連不上」（多半是網絡，等會兒自己好）。
   *
   * timeoutMs：給現探用的護欄。握手時那次不傳（不阻塞任何人），發消息路上那次必須傳，
   * 否則一條連不上的線路會把用戶按在發送鍵上乾等。
   */
  async probeInstantChatSupportDetailed(options?: { timeoutMs?: number }): Promise<InstantChatProbeResult> {
    let previous: boolean | undefined;
    try {
      previous = (await ActiveMsgStore.getGlobalConfig()).instantChatSupported;
    } catch {
      previous = undefined;
    }
    let outcome: InstantChatProbeOutcome = 'unknown';
    try {
      const config = await ensureWorkerReady();
      const init: RequestInit = { method: 'GET' };
      const timeoutMs = options?.timeoutMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (typeof timeoutMs === 'number' && timeoutMs > 0 && typeof AbortController !== 'undefined') {
        const controller = new AbortController();
        init.signal = controller.signal;
        timer = setTimeout(() => controller.abort(), timeoutMs);
      }
      try {
        const { status, body } = await fetchWithAuthRaw('config-check', config, init, '即時對話能力探測');
        // 只有「200 + 這份 JSON 自稱成功」才算問到了答案。401（密鑰沒填對）、5xx、
        // 中間設備塞回來的網關頁……說明的都是「這條線路/這份配置有問題」，而不是
        // 「那台 Worker 跑不動即時對話」，一律留在 unknown。
        if (status === 200 && body?.success === true) {
          outcome = body?.data?.instantTick === true ? 'supported' : 'unsupported';
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch {
      // 網絡異常 / 超時 / 中止：同上，不是答案。
      outcome = 'unknown';
    }
    // 探不到就什麼都不寫：存量保持原樣。這一句就是「一次抖動 ≠ 長期降級」的全部。
    if (outcome === 'unknown') return { outcome, supported: previous };
    const supported = outcome === 'supported';
    try {
      await ActiveMsgStore.saveGlobalConfig({ instantChatSupported: supported });
    } catch (error) {
      // 存不下只是這一輪的判斷留不到下次，探測結論本身照常返回。
      console.warn('[AmsgInstantChat] 能力探測結果沒存下來（下次發消息按上一次的存量判斷）', error);
    }
    return { outcome, supported };
  },

  /**
   * 一次 GET /capabilities，把按特性位存的幾個結論一起刷新進全局配置：
   *   llmCredentialsSupported     'llm-credentials'      憑據存表、任務帶引用（見 isLlmCredentialsReady）
   *   clientStateDeleteSupported  'client-state-delete'  PUT /client-state 認 value: null 刪行（見 isClientStateDeleteReady）
   *
   * 之後排程 / 即時對話 / 清雲端狀態各條路都只讀那份存量——路上不做逐次預檢，
   * 那等於給每條消息加一次 RTT。握手時（initializeClient）和「重新連接並驗證」各探一次。
   *
   * 探不到（老 worker 沒這個端點、網絡不通）一律 false：老路在哪台 worker 上都能跑。
   */
  async probeWorkerFeatures(): Promise<{ llmCredentialsSupported: boolean; clientStateDeleteSupported: boolean }> {
    let features: string[] | null = null;
    try {
      features = (await this.getCapabilities())?.features ?? null;
    } catch {
      features = null;
    }
    const flags = {
      llmCredentialsSupported: supportsLlmCredentials(features),
      clientStateDeleteSupported: supportsClientStateDelete(features),
    };
    try {
      await ActiveMsgStore.saveGlobalConfig(flags);
    } catch (error) {
      console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 能力探測結果沒存下來（下次按上一次的存量判斷）`, error);
    }
    return flags;
  },

  /** 這台 worker 支不支持 credRefs（只關心憑據那一位的入口；探測本身見 probeWorkerFeatures）。 */
  async probeLlmCredentialsSupport(): Promise<boolean> {
    return (await this.probeWorkerFeatures()).llmCredentialsSupported;
  },

  /**
   * 把幾行憑據登記到雲端（只傳真的變了的那些）。排程 / 即時對話之前調，失敗就拋，
   * 讓那一輪明確失敗——建了一條引用著不存在憑據的任務，到點只會白白失敗幾輪。
   */
  async putLlmCredentials(rows: LlmCredentialRow[], options?: { force?: boolean }): Promise<number> {
    return putLlmCredentialRows(rows, options ?? {});
  },

  /**
   * 列出雲端 client_state 裡有哪些命名空間，各佔多少。給「雲端數據」清點用。
   *
   * 這是唯一一條能發現「本地已經沒有、雲端只剩一份上下文」的角色的線索：任務表和憑據
   * 表都問不到它們（沒排過任務、沒配過單獨 API），而角色命名空間在 worker 側沒有 TTL，
   * 不主動去看就永遠不知道它在那兒。
   *
   * 要用戶那台 worker 更新到帶 `client-state-namespaces` 的版本。老 worker 上那條路由
   * 不存在，直接問會拿到一句沒法解釋的 404——所以先問 capabilities，缺能力時拋一句
   * 說得清的話，界面照它提示「更新 Worker 之後清單會更全」。
   *
   * 這一趟要在 worker 上按用戶掃一遍 client_state，所以只在用戶點開清點界面時調，
   * 別塞進體檢或者任何定時路徑（每分鐘白掃一遍 D1 就是 rows read 被掃穿的來由）。
   */
  async listCloudNamespaces(): Promise<Array<{
    namespace: string; entryCount: number; byteSize: number; updatedAt: number | null;
  }>> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    const features = await this.getCapabilities().then((c) => c?.features ?? null).catch(() => null);
    if (!features?.includes('client-state-namespaces')) {
      throw new Error('這台 Worker 還沒有「列出雲端命名空間」的能力，更新 Worker 之後清單會更全。');
    }
    const response = await fetchWithAuth('client-state/namespaces', config, {
      method: 'GET',
      headers: {
        'X-Response-Encrypted': 'true',
        'X-Encryption-Version': '1',
      },
    }, '讀取雲端命名空間清單');
    if (!response?.success) {
      throw new Error(response?.error?.message || '讀取雲端命名空間清單失敗。');
    }
    const payload = await decryptPayload(client, response.data) as {
      namespaces?: Array<{ namespace?: unknown; entryCount?: unknown; byteSize?: unknown; updatedAt?: unknown }>;
    };
    return (payload?.namespaces ?? [])
      .filter((row): row is { namespace: string } & Record<string, unknown> => typeof row?.namespace === 'string' && !!row.namespace)
      .map((row) => ({
        namespace: row.namespace,
        entryCount: Number(row.entryCount ?? 0) || 0,
        byteSize: Number(row.byteSize ?? 0) || 0,
        updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : null,
      }));
  },

  /**
   * 列出雲端登記著哪些憑據行。上游只回 credId 和更新時間，**不回憑據本體**。
   *
   * credId 的形狀是 `char:<charId>/<用途>`，角色身份就編在這個字符串裡——所以這是眼下
   * 唯一一個「不靠本地記錄，直接問雲端還記著哪些角色」的口子。任務表那邊角色 id 埋在
   * 密文裡，要把全部任務拉回來逐條解密才看得見；client_state 則要等用戶那台 worker
   * 更新到帶命名空間清單的那一版。
   */
  async listLlmCredentials(): Promise<Array<{ credId: string; updatedAt?: number }>> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    const response = await client.listLlmCredentials();
    if (!response?.success) {
      throw new Error(response?.error?.message || '讀取雲端憑據清單失敗。');
    }
    const rows = (response.data as { credentials?: Array<{ credId?: unknown; updatedAt?: unknown }> })?.credentials ?? [];
    return rows
      .filter((row): row is { credId: string; updatedAt?: number } => typeof row?.credId === 'string' && !!row.credId)
      .map((row) => ({ credId: row.credId, updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : undefined }));
  },

  /**
   * 刪掉雲端登記的憑據行。`credIds` 刪指定幾行（刪角色時清它名下的），
   * `all` 全刪（「清空雲端數據」）。本地指紋底帳同步劃掉，不然下次「沒變過」會攔住重傳。
   */
  async deleteLlmCredentials(opts: { credIds?: string[]; all?: boolean }): Promise<number> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    const response = await client.deleteLlmCredentials(opts);
    if (!response?.success) {
      throw new Error(response?.error?.message || '刪除 LLM 憑據失敗。');
    }
    if (opts.all) forgetAllCredIds();
    else forgetCredIds(opts.credIds ?? []);
    return Number(response.data?.deleted ?? 0);
  },

  /**
   * 用戶那台 Worker 上跑的後端代碼是不是最新的。
   *
   * 比的是 `GET /config-check` 報的 workerVersion 和本 App 編譯進來的
   * AMSG_WORKER_VERSION——兩者同源（都出自 utils/amsgWorkerVersion.ts），所以只要不相等
   * 就是「那台 Worker 貼的是舊 bundle」。
   *
   * 三種拿不到結論的情況分開表態，因為界面上該說的話不一樣：
   *   - 老 bundle 根本不報這個字段 → outdated（它確實舊，只是舊到還不會自報家門）；
   *   - 網絡不通 / 還沒連上 → unknown（別在用戶斷網時催他更新）。
   */
  async probeWorkerVersion(): Promise<{
    state: 'current' | 'outdated' | 'unknown';
    /** 那台 Worker 自報的版本；老 bundle 不報就是 null。 */
    deployed: string | null;
    /** 本 App 期望的版本，用來在界面上寫「更新到 X」。 */
    expected: string;
  }> {
    const expected = AMSG_BUNDLE_VERSION;
    try {
      const config = await ensureWorkerReady();
      const { status, body } = await fetchWithAuthRaw('config-check', config, { method: 'GET' }, '後端版本探測');
      if (status !== 200 || body?.success !== true) return { state: 'unknown', deployed: null, expected };
      const deployed = typeof body?.data?.workerVersion === 'string' ? body.data.workerVersion : null;
      if (!deployed) return { state: 'outdated', deployed: null, expected };
      return { state: deployed === expected ? 'current' : 'outdated', deployed, expected };
    } catch {
      return { state: 'unknown', deployed: null, expected };
    }
  },

  /**
   * 讓後端自己更新到最新版本。
   *
   * 這活兒只能由 worker 自己幹：api.cloudflare.com 不返回 CORS 頭，瀏覽器直接調一律被攔。
   * 所以這裡只是按一下開關，取代碼、校驗、覆蓋都發生在 worker 那一側（見 worker/amsg/src/selfUpdate.ts）。
   *
   * 更新成功那一刻代碼就換了，但本次響應仍由舊代碼發出——所以這個方法拿到的是「舊代碼
   * 報告更新已完成」，不是新代碼的自我介紹。想確認新版本真跑起來了，看返回的 bundleHash。
   */
  async selfUpdateWorker(): Promise<AmsgSelfUpdateResult> {
    const config = await ensureWorkerReady();
    const { status, body } = await fetchWithAuthRaw('self-update', config, { method: 'POST' }, '後端自更新');

    // 舊 worker 沒有這個端點。它可能回 404，也可能被上游當成未知路由回一段自己的 JSON，
    // 兩種都歸到「不支持」——讓面板去說「先用老辦法更新一次」，而不是報一個看不懂的錯。
    if (status === 404 || body?.error?.code === 'NOT_FOUND') {
      return {
        ok: false,
        supported: false,
        message: '這台 Worker 還是舊版本，沒有自更新能力。先按原來的辦法更新一次，之後就能在這兒點了。',
      };
    }
    if (status === 200 && body?.success === true) {
      const data = body.data ?? {};
      // 地址沒變、bundle 換了，而「認不認識後台任務」這個結論是按地址緩存的。不作廢的話
      // 用戶剛把後端升上去，接下來這幾分鐘每一輪消化還是照著升級前那句「不支持」在前台
      // 跑那一兩分鐘的整理，頁面一關就死。
      forgetBackgroundJobProbe();
      return {
        ok: true,
        supported: true,
        message: typeof data.message === 'string' ? data.message : '已經更新到最新版本。',
        bundleHash: typeof data.bundleHash === 'string' ? data.bundleHash : undefined,
      };
    }
    return {
      ok: false,
      supported: true,
      message: body?.error?.message || `更新沒成功（HTTP ${status}）。`,
      code: typeof body?.error?.code === 'string' ? body.error.code : undefined,
    };
  },

  /**
   * 問一下這台 Worker 的定時觸發（cron trigger）現在開著沒有。
   *
   * 回 null 表示問不到：舊版 Worker 沒有這個端點（404）、沒填地址、或者這一次沒連上。
   * 三種都按「不支持」處理——設置頁不顯示那個按鈕，也不報錯。
   */
  async getCronTriggerState(): Promise<AmsgCronTriggerState | null> {
    try {
      const config = await ensureWorkerReady();
      const { status, body } = await fetchWithAuthRaw('cron-trigger', config, { method: 'GET' }, '後台任務狀態');
      // 舊 worker 沒有這個端點：可能回 404，也可能被上游當成未知路由回一段自己的 JSON。
      if (status === 404 || body?.error?.code === 'NOT_FOUND') return null;
      if (status === 200 && body?.success === true) {
        const data = body.data ?? {};
        if (data.supported === true && typeof data.enabled === 'boolean') {
          return { supported: true, enabled: data.enabled };
        }
        return {
          supported: false,
          code: typeof data.code === 'string' ? data.code : undefined,
          message: typeof data.message === 'string' ? data.message : undefined,
        };
      }
      return {
        supported: false,
        code: typeof body?.error?.code === 'string' ? body.error.code : undefined,
        message: body?.error?.message || `HTTP ${status}`,
      };
    } catch {
      return null;
    }
  },

  /**
   * 暫停（false）或恢復（true）後台任務：讓 Worker 摘掉或加回自己的 cron trigger。
   *
   * 暫停期間到點的任務在 D1 裡排著，一條都不丟；恢復後的第一跳一起補發。
   * 成功和失敗都帶一句能直接顯示的話；code 是 worker 報的代號，缺 CF_API_TOKEN 時
   * 面板據此露出補鑰匙那一塊。網絡層面的失敗照常拋（跟 selfUpdateWorker 一樣），調用方兜。
   */
  async setCronTriggerEnabled(enabled: boolean): Promise<{ ok: boolean; message: string; code?: string }> {
    const config = await ensureWorkerReady();
    const { status, body } = await fetchWithAuthRaw(
      'cron-trigger',
      config,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) },
      enabled ? '恢復後台任務' : '暫停後台任務',
    );
    if (status === 404 || body?.error?.code === 'NOT_FOUND') {
      return {
        ok: false,
        message: '這台 Worker 還是舊版本，沒有暫停後台任務的能力。先點「更新 Worker」，之後就能在這兒點了。',
      };
    }
    if (status === 200 && body?.success === true) {
      return {
        ok: true,
        message: enabled
          ? '後台任務已恢復，攢下的消息會在下一分鐘一起補發。'
          : '後台任務已暫停，到點的消息先攢著，恢復後一起補發。',
      };
    }
    return {
      ok: false,
      message: body?.error?.message || `${enabled ? '恢復' : '暫停'}沒成功（HTTP ${status}）。`,
      code: typeof body?.error?.code === 'string' ? body.error.code : undefined,
    };
  },

  async getCapabilities(): Promise<{ serverVersion: string; features: string[] } | null> {
    const globalConfig = await ensureWorkerReady();
    const client = createClient(globalConfig);
    return client.getCapabilities();
  },

  /**
   * 逐條 PUT update-message，返回成功數與失敗的 uuid。
   * TASK_NOT_FOUND / TASK_ALREADY_COMPLETED 不算失敗——遠端已經沒有 / 已完結的
   * 任務本來就沒有「刷新」可言，正是不需要動的那一側。單條失敗繼續跑完其餘的
   * （口徑同 cancelAllTasksForChar：一條網絡抖動不該拖累剩下的任務）。
   */
  async updatePendingTasksRemote(
    taskUuids: string[],
    updates: Record<string, unknown>,
  ): Promise<{ updated: number; failed: string[] }> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    let updated = 0;
    const failed: string[] = [];
    for (const uuid of taskUuids) {
      try {
        const response = await client.updateMessage(uuid, { ...updates });
        const code = response?.error?.code;
        if (response?.success) {
          updated += 1;
        } else if (code !== 'TASK_NOT_FOUND' && code !== 'TASK_ALREADY_COMPLETED') {
          failed.push(uuid);
        }
      } catch {
        failed.push(uuid);
      }
    }
    return { updated, failed };
  },

  /**
   * 單角色版憑據刷新：面板保存後用。
   * 面板手裡就有最新的角色級配置（onSave 落庫是異步的，讀 DB 會拿到舊的），
   * 所以這裡讓調用方把 config 和要刷的任務清單直接傳進來；fixed 在這裡再濾一遍，
   * 傳錯也不至於給固定消息塞憑據。
   */
  async refreshCharPendingAiTaskCredentials(params: {
    char: CharacterProfile;
    config: ActiveMsg2CharacterConfig;
    apiConfig: APIConfig;
    tasks: ActiveMsg2TaskRecord[];
  }): Promise<{
    status: 'no-tasks' | 'ok' | 'partial';
    updated: number;
    failed: number;
  }> {
    const aiTaskUuids = params.tasks
      .filter((t) => t.mode !== 'fixed')
      .map((t) => t.taskUuid);
    if (aiTaskUuids.length === 0) return { status: 'no-tasks', updated: 0, failed: 0 };

    const updates = resolveTaskCredentialUpdates(params.char, params.config, params.apiConfig);
    const { updated, failed } = await this.updatePendingTasksRemote(aiTaskUuids, updates);
    return { status: failed.length ? 'partial' : 'ok', updated, failed: failed.length };
  },

  /**
   * 聊天 API 配置保存後，把新憑據寫回還會響的遠端 AI 任務（設置頁保存路徑調）。
   * 任務體裡的 apiUrl / apiKey / primaryModel 是排程那一刻凍結的——換了 Key、
   * 舊 Key 吊銷後，已排程任務到點全部 401，用戶只看到「主動消息怎麼不來了」。
   *
   * 範圍：開著 2.0（enabled:true）且有 pending AI 任務（mode !== 'fixed'）的
   * 角色。fixed 不走 LLM 用不到憑據；關掉 2.0 的角色殘留任務是「待取消」而不是
   * 「待續命」，不給它們續新憑據。生效憑據按 resolveTaskCredentialUpdates 算——
   * 開了單獨 API 的角色寫的是單獨 API 的值，設了角色專屬 chatApi 的寫那份，
   * 兩個都沒設的角色才會真的被這次全局配置變更覆蓋到。
   */
  async refreshApiCredentialsForPendingTasks(apiConfig: APIConfig): Promise<{
    status: 'no-tasks' | 'ok' | 'partial';
    updated: number;
    failed: number;
  }> {
    const now = Date.now();
    const targets = (await DB.getAllCharacters())
      .filter((char) => isAmsg2EnabledForChar(char))
      .map((char) => ({
        char,
        config: char.activeMsg2Config ?? { enabled: true },
        aiTaskUuids: getPendingTasks(char.activeMsg2Config, now)
          .filter((t) => t.mode !== 'fixed')
          .map((t) => t.taskUuid),
      }))
      .filter((item) => item.aiTaskUuids.length > 0);
    // 沒有要刷的任務直接返回：沒配 2.0 的用戶每次保存 API 不該多打一個請求。
    if (targets.length === 0) return { status: 'no-tasks', updated: 0, failed: 0 };

    let updated = 0;
    let failed = 0;
    for (const item of targets) {
      let updates: Record<string, unknown>;
      try {
        updates = resolveTaskCredentialUpdates(item.char, item.config, apiConfig);
      } catch (error) {
        // 這個角色的憑據配不齊（多半是單獨 API 缺字段），整組記失敗，別攔著其他角色。
        console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 角色憑據解析失敗，跳過其任務的憑據刷新`, item.char.id, error);
        failed += item.aiTaskUuids.length;
        continue;
      }
      const result = await this.updatePendingTasksRemote(item.aiTaskUuids, updates);
      updated += result.updated;
      failed += result.failed.length;
    }
    return { status: failed ? 'partial' : 'ok', updated, failed };
  },

  /**
   * 角色資料改了之後，把跟著變的字段寫回還會響的遠端任務行（角色頁保存的路徑調）。
   *
   * **timeZone**：上游是按任務行裡凍結的那份 tzId、以牆鍾推進循環任務的下次觸發時刻的
   * （tzId 缺省時才退回死加 24h）。fire_pack 裡那份 tzId 每輪聊天都會重傳，但它救不了
   * 任務行——不刷的話「每天 9:00」會一直按排程那天的時區走，角色改到紐約就成了當地晚上
   * 八九點，跨夏令時還會永久偏一小時；同一次 fire 裡 prompt 用新時區、觸發時刻用舊時區，
   * 兩個鍾直接打架。
   *
   * **contactName**：推送橫幅標題「來自 X」。AI 模式的 fire 會從 tool_pack 取當前名字
   * （見 worker 的 onLLMOutput），但 fixed 模式不走 hooks，標題直接讀任務行這一份。
   *
   * 範圍是全部 pending 任務，**含 fixed**：固定文本的循環任務同樣按牆鍾推進、同樣要彈
   * 橫幅，所以不能沿用憑據刷新那邊的 `mode !== 'fixed'` 過濾。
   *
   * fields 由調用方按「哪些真的變了」逐項開：任務行裡存的可能是排程那一刻的快照，跟著
   * 別的操作順手全刷的話，用戶出差時保存一次配置就會把所有任務的時區悄悄挪走。
   */
  async refreshCharPendingTaskRow(
    char: CharacterProfile,
    fields: { timeZone?: boolean; contactName?: boolean },
  ): Promise<{
    status: 'no-tasks' | 'ok' | 'partial';
    updated: number;
    failed: number;
  }> {
    const updates: Record<string, unknown> = {};
    // 關掉自定義時區也走這裡：那時該回落到設備時區，跟排程時的算法保持同一份。
    if (fields.timeZone) {
      updates.tzId = resolveCharTimeZone(char) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    }
    // 上游要求非空字符串，空名字傳上去會被打回 400。
    if (fields.contactName && char.name?.trim()) updates.contactName = char.name;
    if (Object.keys(updates).length === 0) return { status: 'no-tasks', updated: 0, failed: 0 };

    const uuids = getPendingTasks(char.activeMsg2Config, Date.now()).map((t) => t.taskUuid);
    if (uuids.length === 0) return { status: 'no-tasks', updated: 0, failed: 0 };

    const { updated, failed } = await this.updatePendingTasksRemote(uuids, updates);
    return { status: failed.length ? 'partial' : 'ok', updated, failed: failed.length };
  },

  /**
   * 取回 worker 旁路存下的一份雲端狀態（push 裝不下的大內容，見 amsgXhsSessionKey）。
   * 鍵不存在、或者內容已被取走清空，都返回 null 交調用方決定——不要在這裡編一個空殼
   * 出來，那會讓「數據還沒取回」和「本來就沒有」變成同一件事。
   */
  async readClientStateValue(namespace: string, key: string): Promise<string | null> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    const response = await client.getClientState(namespace);
    if (!response?.success) {
      throw new Error(response?.error?.message || '讀取雲端狀態失敗。');
    }
    const entries = (response.data?.entries ?? []) as Array<{ key: string; value: string }>;
    const hit = entries.find((e) => e?.key === key);
    return hit?.value ? hit.value : null;
  },

  /**
   * 防穿幫閘最近一次攔下了哪次觸發（沒有記錄 / 讀不出來一律 null）。
   *
   * 閘跳過一次 fire 時不發任何 push，而遠端那行任務照樣被消費掉——客戶端事後分不出
   * 「讓路了」和「發出去但沒收到」。這條記錄就是 worker 留下的那句解釋，面板照實說明。
   * 讀失敗按「沒有記錄」處理：這是一句錦上添花的說明，不該讓面板打不開。
   */
  async readLastSkip(charId: string): Promise<AmsgLastSkip | null> {
    return (await this.readPanelStatus(charId)).lastSkip;
  },

  /**
   * 面板上那兩句「近況」一次讀齊：最近一次為什麼沒響（last_skip）、今天主動找了幾次
   * （daily_sends）。兩份住在同一個角色命名空間裡，讀一次整個命名空間就都有了——分兩次
   * 讀的話每次都要把幾十 KB 的 fire_pack 一起拉下來解密。讀失敗兩樣都按「沒有」處理：
   * 這是錦上添花的說明，不該讓面板打不開。
   */
  async readPanelStatus(charId: string): Promise<{
    lastSkip: AmsgLastSkip | null;
    dailySends: AmsgDailySends | null;
  }> {
    try {
      const config = await ensureWorkerReady();
      const client = await initializeClient(config);
      const response = await client.getClientState(amsgStateNamespace(charId));
      if (!response?.success) return { lastSkip: null, dailySends: null };
      const entries = (response.data?.entries ?? []) as Array<{ key: string; value: string }>;
      const valueOf = (key: string) => entries.find((e) => e?.key === key)?.value || null;
      const skipValue = valueOf(AMSG_LAST_SKIP_KEY);
      return {
        lastSkip: skipValue ? parseLastSkip(skipValue) : null,
        dailySends: parseDailySends(valueOf(AMSG_DAILY_SENDS_KEY)),
      };
    } catch {
      return { lastSkip: null, dailySends: null };
    }
  },

  /**
   * 把這個角色的「頻率與額度」單獨傳上去（面板保存、關掉 2.0 時用）。
   *
   * 不等下一次 fire_pack 同步：那一份要「有待發任務、聊完一輪」才重傳，用戶改的上限會
   * 遲遲不生效。失敗照拋，讓面板告訴用戶沒同步上。
   */
  async putCharLimits(char: CharacterProfile): Promise<void> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    await putClientStateOrThrow(client, [buildLimitsEntry(char, stampStateUpdatedAt())], '同步主動頻率設置');
  },

  /**
   * 往雲端 client_state 的某個 namespace/key 上寫一份內容（不存在就新建，已有就覆蓋）。
   *
   * 雲端狀態的讀寫都從這個模塊走：worker 地址、用戶身份、鑑權初始化都在這裡一處備齊，
   * 別處要寫雲端狀態時調這個函數就行，不用自己再建一條連接。
   *
   * 寫失敗會拋錯（內部帶網絡抖動重試），交調用方決定是重試還是放棄——靜默吞掉的話
   * 雲端留的就是上一份舊內容，而調用方以為自己已經寫成功了。
   */
  async writeClientStateValue(namespace: string, key: string, value: string): Promise<void> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    await putClientStateOrThrow(
      client,
      [{ namespace, key, value, updatedAt: stampStateUpdatedAt() }],
      '寫入雲端狀態',
    );
  },

  /**
   * 取回落庫後把雲端那一行清掉，騰回 D1 空間。按 worker 的能力位分兩條路：
   *   - worker 認刪行（isClientStateDeleteReady）：發 `value: null`，整行連大值的切片
   *     一起刪掉。即時對話每輪的旁路鍵都是新的（`reasoning:<uuid>` 這類），只有真刪
   *     才不會讓角色的命名空間只漲不跌——worker 每次生成都要把它整個讀一遍；
   *   - 老 worker（沒探到、或探到不認）：寫空串，留一個幾字節的空殼，內容本身沒了。
   *     null 發到老 worker 上會被當無效條目拒掉、內容原封不動，所以不認就不發。
   * 歷史積累的空殼由 syncCharFirePacks 末尾的存量清理掃掉。
   */
  async clearClientStateValue(namespace: string, key: string): Promise<void> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    const value = (await isClientStateDeleteReady()) ? null : '';
    await client.putClientState([{ namespace, key, value, updatedAt: stampStateUpdatedAt() }]);
  },

  /**
   * 清掉某個角色在雲端 client_state 裡的全部條目（fire_pack / tool_pack /
   * 活躍會話租約 / 旁路存的小紅書會話），刪角色時用。
   *
   * 為什麼單獨有這麼一個：設置頁的「清空雲端數據」是全局的、要用戶主動去點，
   * 刪一個角色時該走的是只清這一個角色的路。返回被清掉的鍵名供調用方記帳。
   */
  async clearCharClientState(charId: string): Promise<string[]> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    return clearNamespaceValuesOrThrow(client, amsgStateNamespace(charId));
  },

  /**
   * 清空該用戶在 worker D1 裡的全部 client_state，清完立刻把全局工具憑據補回去。
   * 設置頁「清空雲端數據」把它當其中一步用（見 amsgStateSync 的 wipeAmsgCloudData）。
   *
   * 為什麼補傳這一步是必須的：雲端有三份數據，角色上下文與角色工具數據每輪聊完都會
   * 重新同步（見 syncCharFirePacks），只有全局的 tool_config 是「改的時候才傳」——
   * 它沒有別的補寫時機。而 worker 到點三份缺一就硬失敗（見 worker/amsg/src/index.ts
   * 的 fireStateError），於是清空之後已排程的 AI 任務會一直失敗，聊多少輪天都不會好。
   *
   * 清空這個動作本身就是一次「雲端憑據變沒了」的變更，所以在這裡就地補回來，
   * 不必讓每輪同步都白傳一遍。這個方法只碰 client_state、不動任務表，所以它就是
   * 「任務還活著、憑據卻沒了」的唯一入口，堵住這裡就夠。
   *
   * 補傳失敗不算清空失敗（清空確實成功了），返回值把結果交給調用方去提示。
   *
   * `restoreToolConfig: false` 用在「重置全部數據」那條路上：那時用戶要的是一切歸零，
   * 本地緊接著就要刪庫，補傳只會在剛清空的庫裡重新留下一行誰也不會再讀的憑據。
   */
  async clearClientState(
    realtimeConfig: RealtimeConfig | undefined,
    options: { restoreToolConfig?: boolean } = {},
  ): Promise<{ deleted: number; toolConfigRestored: boolean }> {
    const config = await ensureWorkerReady();
    // 清雲端狀態可能連用戶密鑰一起換代：握手緩存作廢，之後的第一次調用重新 init。
    invalidateClientCache();
    const client = createClient(config);
    const response = await client.clearClientState();
    if (!response?.success) {
      throw new Error(response?.error?.message || '清除雲端狀態失敗。');
    }
    const { deleted } = response.data as { deleted: number };
    if (options.restoreToolConfig === false) return { deleted, toolConfigRestored: false };

    let toolConfigRestored = true;
    try {
      const authed = await initializeClient(config);
      await putClientStateOrThrow(
        authed,
        [buildToolConfigEntry(realtimeConfig, stampStateUpdatedAt())],
        '重新上傳工具憑據',
      );
    } catch (error) {
      console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 清空後補傳工具憑據失敗`, error);
      toolConfigRestored = false;
    }
    return { deleted, toolConfigRestored };
  },
};
