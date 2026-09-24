/**
 * SullyOS 主動消息 2.0（amsg2）— 單用戶 Cloudflare Worker 入口。
 *
 * 定時任務存 D1（binding 名固定 `DB`），到點投遞由 Cron Trigger 觸發
 * scheduled()，沒有 send-notifications 這類 HTTP 投遞端點。
 *
 * 部署走「Dashboard 粘貼」：`pnpm build:workers` 把這份入口打成
 * worker/amsg/worker.bundle.js（+ public/amsg-worker.bundle.js 供設置頁
 * 「複製 Worker 代碼」按鈕讀取），整份粘進 CF Dashboard 的 Edit code 即可。
 * amsg-server 2.6.0-next.2 起全 Web Crypto，無需 nodejs_compat flag。
 *
 * Worker 側要配的東西（都在 CF Dashboard 的 Settings 裡）：
 *   - D1 binding:  變量名 `DB`（庫隨便建一個，表由前端「連接」時 POST /init-tenant 冪等創建）
 *   - Cron Trigger: `* * * * *`（每分鐘查一次到點任務，UTC）
 *   - env: AMSG_MASTER_KEY（64 位 hex）+ VAPID_EMAIL / VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
 *          + 可選 AMSG_SERVER_TOKEN（配了則所有端點強制校驗 X-Client-Token）
 *
 * 上面這些漏了哪樣，`GET /config-check` 會直接列出來（見 inspectWorkerEnv），
 * 前端「連接並驗證」也會讀它，不用去翻 Cloudflare 的日誌。排障時還有個信息更全的
 * `GET /debug`：配置 + 庫的 schema + cron 有沒有在按時處理任務，全只讀、不帶敏感信息，
 * 隔著屏幕幫人看部署時用它。
 *
 * VAPID 必須和 SullyOS「推送憑據 (VAPID)」面板裡的是同一對：整個站點
 * 共用一個瀏覽器 push 訂閱，worker 用別的密鑰對籤推送會 403。
 */

import { DurableObject } from 'cloudflare:workers';
import {
  createSingleUserCloudflareWorker,
  createWebCryptoWebPush,
  decryptFromStorage,
  deriveUserEncryptionKey,
  measurePushPayload,
  summarizeErrorCause,
} from '@rei-standard/amsg-server/cloudflare';
import { stripReasoningTags } from '@rei-standard/amsg-shared';
import { AMSG_BUNDLE_VERSION } from '../../../utils/amsgBundleVersion';
// 「上一次推送被判訂閱失效」的形狀，跟前端體檢共用一個類型定義（那份是零依賴純葉子；
// 往裡加任何瀏覽器依賴都會連累這個 bundle）。這裡只產出事實，紅綠燈和文案歸前端。
import type { AmsgPushGoneFailure } from '../../../utils/amsgDiagnostics';
import type { UserProfile } from '../../../types';
import { AMSG_JOB_NAMESPACE, AMSG_JOB_TTL_DAYS } from '../../../utils/amsgTaskKinds';
import {
  FIRE_KIND_HANDLERS,
  getKindFireStash,
  putKindFireStash,
  readTaskKind,
} from './fireKinds';
import {
  AMSG_CHAT_FAIL_KEY,
  AMSG_FIRE_PACK_KEY,
  AMSG_LAST_SKIP_KEY,
  AMSG_SELF_LOG_KEY,
  AMSG2_INSTANT_STUB_TEMPLATE,
  type AmsgChatFailRecord,
  type AmsgLastSkip,
  type AmsgSelfLog,
  type AmsgTzRef,
  amsgStateNamespace,
  amsgXhsSessionKey,
  appendSelfLogEntry,
  appendSelfLogTask,
  bumpRecurringSend,
  countRecurringSends,
  countUnansweredSends,
  formatFireTimeShort,
  describeFirePackVersion,
  parseFirePack,
  parseSelfLog,
  reconcileSelfLogWithPack,
  renderFirePack,
  renderSelfLogBlock,
  unpackStateValue,
} from '../../../utils/amsgFirePack';
import {
  AMSG_DAILY_SENDS_KEY,
  AMSG_LIMITS_KEY,
  type AmsgDailySends,
  type AmsgLimits,
  buildLimitsBrief,
  bumpDailySends,
  checkSelfScheduleRules,
  dayKeyInZone,
  earliestSlotAfter,
  FIRE_GAP_TOLERANCE_MS,
  parseAmsgLimitsRecord,
  parseDailySends,
  resolveAmsgLimits,
  resolveMaxUnansweredSends,
  sendsOnDay,
} from '../../../utils/amsgLimits';
import { resolveFireSceneSong } from '../../../utils/amsgFireScene';
import { shouldExpireFire } from '../../../utils/amsg2ExpireGuard';
import { buildFireTaskListBlock, currentOccurrenceMs, isPendingTask, shortTaskId } from '../../../utils/amsg2Tasks';
import {
  AMSG_FIRE_CANCEL_TOOL,
  AMSG_FIRE_RENEW_TOOL,
  AMSG_FIRE_SCHEDULE_TOOL,
  buildFireCancelTool,
  buildFireRenewTool,
  buildFireScheduleBlock,
  buildFireScheduleTool,
  buildSelfScheduleUuid,
  MAX_FIRE_SCHEDULES,
  parseFireRenewSendAt,
  MIN_SCHEDULE_LEAD_MS,
  parseFireScheduleArgs,
  resolveFireTargetTask,
  buildTaskInstruction,
} from '../../../utils/amsgFireSchedule';
import {
  AMSG_CHAT_PRESENCE_KEY,
  isFreshChatPresence,
  parseAmsgChatPresence,
} from '../../../utils/amsgChatPresence';
import {
  AMSG_GLOBAL_NAMESPACE,
  AMSG_TOOL_CONFIG_KEY,
  AMSG_TOOL_PACK_KEY,
  parseToolConfig,
  parseToolPack,
  type AmsgToolConfig,
  type AmsgToolPack,
} from '../../../utils/amsgToolPack';
import { buildRealtimeWorldBlock } from './realtimeWorld';
import { handleSelfUpdate } from './selfUpdate';
import { handleCronTriggerRead, handleCronTriggerWrite, isCronTriggerAuthFailure } from './cronTrigger';
import {
  buildMcpDirectHeaders,
  buildMcpFireBlock,
  buildMcpFireTools,
  buildMcpNameMap,
  callMcpToolCore,
  createMcpSessionState,
  filterMcpServersForChar,
  formatMcpToolResult,
  MCP_FIRE_NAME_BUDGET,
  MCP_FIRE_NAME_PREFIX,
  type McpResolvedToolCore,
  type McpSessionState,
} from '../../../utils/mcpFireCore';
import { dispatchAgenticTool, type AgenticToolChar, type AgenticToolCtx } from '../../../utils/agenticTools';
import {
  buildDuplicateToolMessage,
  buildToolResultMessage,
  neverRan,
  toolCallFingerprint,
  type ToolCallRecord,
} from '../../../utils/agenticToolFeedback';
import { setProxyWorkerUrlOverride } from '../../../utils/proxyWorker';
import { XhsMcpClient } from '../../../utils/xhsMcpClient';
// type-only：編譯期擦除，classifier 的實現不會因為這行被拉進 bundle。
import type { ToolCall } from './classifier';
import {
  classifyNativeToolCalls,
  createFireSessionState,
  resolveToolIterationBudget,
  processLLMRound,
  type FireSessionState,
} from './agentic';
import {
  amsgEmotionUpdateKey,
  EMOTION_EVAL_RIDE_ALONG_MS,
  resolveEmotionEvalApi,
  runAmsgEmotionEval,
  stripEmotionEvalSpec,
  takeEmotionEvalSpec,
  type AmsgEmotionEvalOutcome,
} from './emotionEval';
import {
  applyInstantNotificationPolicy,
  buildInstantTimelyBlock,
  constantTimeEqual,
  handleInstantChat,
  instantNotificationTag,
  INSTANT_TOTAL_TIMEOUT_MS,
  isInstantChatTask,
  NOTIFICATION_SILENT_WHEN_VISIBLE,
  type InstantTickNamespace,
} from './instantChat';
import { buildScheduleChangeResult } from '../../../utils/amsgScheduleResult';
import { TICK_STALL_MS } from '../../../utils/amsgTickReport';
import { buildTickReport, readOverdueTasks, recordTickOutcome, type TickReportDb } from './tickReport';
import type { ActiveMsg2TaskRecord } from '../../../types';
import { createHybridPushTransport, isFcmConfigured, type NativeFcmEnv } from './nativeFcm';
import { configureSkipDiagnostics, isDebugFlagOn, logSkipDiagnostic } from './skipDiagnostics';

interface Env extends NativeFcmEnv {
  AMSG_MASTER_KEY: string;
  VAPID_EMAIL: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  /** 可選共享密鑰；配了才校驗 X-Client-Token，不配則端點全開。 */
  AMSG_SERVER_TOKEN?: string;
  /**
   * 排查「模型這輪沒說話」時臨時打開：填 1 後，跳過診斷日誌（[amsg:skip-diag]）會帶上模型回覆的
   * 原文片段。默認只記形狀、不含聊天正文，查完刪掉。見 ./skipDiagnostics。
   */
  AMSG_DEBUG_LLM_RAW?: string;
  /** D1 binding（factory 默認 createD1Adapter(env.DB)，這裡只是標註存在）。 */
  DB: unknown;
  /** 以下三項給 /self-update 用，都可選；沒配 CF_API_TOKEN 就是不開自更新。見 ./selfUpdate。 */
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_SCRIPT_NAME?: string;
  /**
   * 即時對話的起跳器（Durable Object）。類型上可選是因為老版本 Worker 上真的沒有它，
   * 那種情況由 /instant-chat 明確報「需要更新 Worker」，見 instantChat.kickInstantTick。
   */
  INSTANT_TICK?: InstantTickNamespace;
}

// ─── 滿血 fire-time hooks（amsg-server 2.6.0-next.4+：含 ctx.scratch / 存儲層大值分塊） ───
//
// AI 任務的 prompt 到點才組裝：讀前端同步上來的 fire_pack（client_state 表，見
// utils/amsgFirePack.ts + utils/amsgStateSync.ts），在 fire 時刻現算時間填槽 →
// 上下文永遠是「用戶最後一次聊天時」的狀態。任務體裡沒有第二份 prompt——排程鏈保證
// 「先傳雲端狀態、成功了再建任務」（activeMsgClient 的 putClientStateOrThrow），
// 所以讀不到 fire_pack 就是異常，直接拋錯，不降級（見 fireStateError）。
//
// v2 服務端工具循環：LLM 輸出經業務標籤 classifier 分類
// （見 ./agentic.ts、./classifier.ts），數據標籤由 executeToolCalls 在 worker 內就地執行
// （recall 讀 tool_pack 裡的月度總結，搜索 / Notion / 飛書 / XHS 用 tool_config
// 裡的憑據直調，全程不需要客戶端在線）；副作用標籤結構化成 directives 掛
// 最後一條 push，客戶端收到時重放。tool_pack / tool_config 與 fire_pack 同批上傳，
// 所以和它一樣按「讀不到就是異常」處理；沒配憑據的工具自己會回 not_configured。
//
// 思考鏈走 metadata、不佔一條 push：只發 content push，把這次生成的 reasoning 掛在
// **第一條** push 的 metadata.amsgReasoning 上，客戶端在那條上渲染思考鏈卡片
// （收側認領見 utils/activeMsgRuntime.ts）。
// 這麼走的好處是編號不動：hook 路徑的 sendHookPushPayloads 會把 pushPayloads 數組整體
// 編號（messageIndex/totalMessages），多插一條 reasoning push 就會把第一條 content
// 頂到 messageIndex=2，多段消息的等齊、補收、directive 重放全跟著編號走。
// 正文裡的 <think> 標籤照舊 strip，只是剝之前先抄一份當思考鏈。

interface FireCtx {
  task: {
    id?: string | number | null;
    /** 任務行 uuid（客戶端清單裡的那個）；跳過時留痕要拿它對上是哪一條。 */
    uuid?: string | null;
    contactName?: string;
    recurrenceType?: string;
    nextSendAt?: string | null;
    metadata?: Record<string, unknown>;
    /**
     * 憑據引用（`{ <用途>: <cred_id> }`）。聊天那一路由上游自己解析後直接餵給 LLM，
     * 宿主碰不到也不必碰；這裡只用得上別的用途——現在只有 `emotion`（情緒評估的副 API）。
     * 引用本身不是機密（只是個名字），所以上游沒把它擋在 hook 之外。
     */
    credRefs?: Record<string, unknown> | null;
  };
  userId: string;
  /**
   * 按名字取一行憑據（amsg-server 2.6.0-next.17+）。查不到回 null，老部署上整個方法不存在。
   * **紅線**：取到就地用完即棄，絕不掛到 ctx / task / metadata / push 上——憑據一旦
   * 沾上會流向推送的任何對象，就等於送出門了。
   */
  resolveLlmCredential?: (
    credId: string,
  ) => Promise<{ apiUrl: string; apiKey: string; primaryModel: string } | null>;
  readState: (namespace: string) => Promise<Array<{ key: string; value: string }>>;
  /** 與每輪 sessionCtx 上那個是同一套寫口（防穿幫閘跳過時用它留一句原因）。 */
  writeState?: WriteState;
  scheduleTask?: ScheduleTask;
  cancelTask?: CancelTask;
  renewTask?: RenewTask;
  now: Date;
  /**
   * 單次 fire 的宿主便籤（amsg-server 2.6.0-next.4+）：與同一次 fire 每輪的
   * sessionCtx.scratch 是同一個對象引用，fire 結束隨調用棧丟棄，庫不讀不寫。
   */
  scratch: Record<string, unknown>;
}

/** client_state 的寫入口（amsg-server 2.6.0-next.7+）；value 傳 null 即刪除該 key。 */
type WriteState = (
  namespace: string,
  entries: Array<{ key: string; value: string | null; updatedAt?: number }>,
) => Promise<{ upserted: number; skipped: number; deleted: number }>;

/**
 * 在這次 fire 裡再建一條定時任務（amsg-server 2.6.0-next.9+）。
 * 憑據與投遞配置由庫從當前任務繼承，這裡只說「什麼時候、說什麼方向」。
 * uuid 撞車不拋錯，回 { created: false } 外帶已存在那行的脫敏投影（不含任何憑據）
 * ——fire 重跑時靠確定性 uuid 天然冪等，投影讓重跑那一輪也能把帳記下來。
 */
type ScheduleTask = (options: {
  firstSendTime: string;
  recurrenceType?: string;
  messageType?: string;
  metadata?: Record<string, unknown>;
  uuid?: string;
  /** 任務的時間參照系（IANA），daily / weekly 按這個時區的牆鍾推進。 */
  tzId?: string | null;
}) => Promise<
  | { created: true; id: number | null; uuid: string; nextSendAt: string }
  | {
      created: false;
      reason: 'duplicate';
      uuid: string;
      task: {
        nextSendAt?: string | null;
        recurrenceType?: string | null;
        messageType?: string | null;
        clientTaskId?: string | null;
      } | null;
    }
>;

/**
 * 取消 / 改期一條既有任務（amsg-server 2.6.0-next.15+ 的 fire ctx）。
 * 兩個都不許動當前正在 fire 的這條（上游拋 RangeError），調用前先自己攔。
 * renewTask 只換時間（uuid 不變、重試計數清零）；行不存在回 { renewed: false }。
 */
type CancelTask = (uuid: string) => Promise<{ cancelled: boolean }>;
type RenewTask = (uuid: string, nextSendAt: string) => Promise<
  { renewed: true; uuid: string; nextSendAt: string } | { renewed: false; reason: string }
>;

interface SessionCtx {
  /** 日誌與去重用的不透明串。任務身份讀下面三個字段，別拿它切。 */
  sessionId: string;
  llmResponse: unknown;
  llmOutputText: string;
  contactName: string;
  avatarUrl?: string;
  metadata: Record<string, unknown>;
  scratch?: Record<string, unknown>;
  writeState?: WriteState;
  scheduleTask?: ScheduleTask;
  cancelTask?: CancelTask;
  renewTask?: RenewTask;
  /**
   * 往客戶端送一條**不是聊天內容**的結果（amsg-server 2.6.0-next.21+）。
   * 一條結果落進 message_outbox（到達的保證：客戶端下次 `GET /outbox?since=` 一定
   * 拿得到），並按通知策略決定要不要順帶發一條 Web Push（及時性）。
   * `resultKind` 是唯一必填字段，其餘形狀由宿主定。老部署上整個方法不存在。
   */
  emitResult?: (payload: Record<string, unknown>) => Promise<{ messageId: string; pushed: boolean }>;
  /** 本次 fire 的第幾輪 LLM（0-based）。最後一輪不再放行工具請求，預算在 scratch.fire。 */
  iteration?: number;
  /** 任務行 id；沒有任務行的 in-server instant 路徑為 null。 */
  taskId: number | string | null;
  /** 任務行 uuid。 */
  taskUuid: string | null;
  /** 本次觸發的名義時刻（epoch 毫秒）。 */
  occurrenceMs: number | null;
}

/** 一次 fire 的跨輪狀態：工具執行上下文 + 旁白累積。掛在 ctx.scratch.fire 上。 */
interface FireStash {
  session: FireSessionState;
  toolCtx: AgenticToolCtx;
  proxyWorkerUrl: string | null;
  xhsCookie: string;
  /** 本次觸發時刻（任務行 next_send_at）；透傳給每條 push 的 metadata.amsgOccurrenceMs。 */
  occurrenceMs: number;
  /**
   * 「角色自己發過什麼」的當前版本（已跟本次 fire_pack 對齊過；對不上就是空的一份）。
   * onBeforeFire 讀進來注入 prompt，onLLMOutput 發完在它上面追加一條寫回雲端。
   */
  selfLog: AmsgSelfLog;
  /**
   * selfLog 上有沒有還沒落盤的改動。收尾時（amsgFireSettled）據此決定要不要寫一次庫。
   *
   * 「角色給自己排了任務」這件事必須靠它落帳：任務在 ctx.scheduleTask 那一刻就真的
   * 建進 D1 了，但如果這輪最終沒有正文可發（只做了副作用 / 空生成），帳沒記下來的話
   * 客戶端認領不到、面板看不見，用戶永遠取消不掉它，而它會一直按時發下去。
   */
  selfLogDirty: boolean;
  /** 通用 MCP：暴露名 → 服務器/工具。tool_config 裡沒配（或對該角色不可見）時為 null。 */
  mcpResolve: Map<string, McpResolvedToolCore> | null;
  /** 本次 fire 真正回給上游的自適應輪次預算；最後一輪判斷與提示都讀這一份。 */
  maxToolIterations: number;
  /**
   * 本次 fire 聲明給模型的非 MCP native 工具名（schedule / cancel / renew 按各自開關
   * 在場與否）。onLLMOutput 認領 native tool_call 時拿它當清單（MCP 那份在 mcpResolve）。
   * 從拼好的 fireTools 現算——以後加新工具不用再來入口登記。onBeforeFire 拼完 fireTools
   * 後填充，在那之前是空集。
   */
  fireToolNames: Set<string>;
  /** 每服務器一份連接會話，單次 fire 內跨輪複用，fire 結束隨 scratch 丟棄。 */
  mcpSessions: Map<string, McpSessionState>;
  /** 本次 fire 已經花在 MCP 調用上的毫秒數，見 MCP_TOTAL_BUDGET_MS。 */
  mcpSpentMs: number;
  /** 打包那一刻客戶端已知的待觸發任務，用來算「還能不能再排」。 */
  pendingTaskCount: number;
  /**
   * fire 開場的活任務清單（客戶端快照 + 自排未認領），取消 / 改期工具按短 id
   * 在這裡找目標。唯一生產者 onBeforeFire 恆定初始化，必填。
   */
  pendingTasks: ActiveMsg2TaskRecord[];
  /** 角色本次 fire 已經排成功的任務（也是要隨 push 帶回客戶端認領的那些）。 */
  scheduledTasks: ActiveMsg2TaskRecord[];
  /**
   * 本次 fire 內已經消耗掉的排程序號（只增不減）。自排任務的確定性 uuid 由
   * 「觸發時刻 + 序號」推出來，序號不能取 scheduledTasks.length——取消會讓數組回縮，
   * 「排 A → 排 B → 取消 A → 排 C」時 C 會撞上還活著的 B 的 uuid（撞車被當成
   * fire 重跑回 ok:true，任務實際沒建）。fire 重跑時 stash 重建、序號從頭推進，
   * 重跑的確定性去重語義不變。
   */
  selfScheduleSeq: number;
  /**
   * 本次 fire 裡取消 / 改期掉的既有任務（uuid / uuid+新時刻）。隨最後一條 push 的
   * metadata.amsgTaskMutations 帶回客戶端消帳——D1 行已經動了，本地清單不跟著動的話，
   * 面板會一直列著一條永遠不會響（或時間不對）的任務。唯一生產者恆定初始化，必填。
   */
  cancelledTasks: string[];
  renewedTasks: Array<{ taskUuid: string; sendAt: string }>;
  /**
   * 用戶給這個角色定的「頻率與額度」（已解析成生效值，見 amsgLimits）。排程工具拿它
   * 打回超額 / 太密 / 不許排的自排；到點那幾道閘在 onBeforeFire 裡用的是同一份。
   */
  limits: AmsgLimits;
  /**
   * 用戶沒回之後，角色最近一次主動發出去的時刻（自述日誌裡最後一條非回覆的條目；
   * 沒有為 null）。排程工具算「兩條之間隔夠沒有」要它。
   */
  lastSelfSendAt: number | null;
  /** 這次觸發的任務是每天/每週重複的。發出去之後要給它的「連續沒回」計數加一。 */
  recurring: boolean;
  /** 用戶那邊的「今天」（YYYY-MM-DD），每日計數記在這一天上。 */
  dailyDay: string;
  /** fire 開場讀到的每日計數（收尾時在它上面累加再寫回）。 */
  dailySends: AmsgDailySends | null;
  /** 這次 fire 已經記進每日計數了（收尾 hook 被調兩次也只記一回）。 */
  dailyCounted: boolean;
  /** 這次 fire 開始的時刻；日誌條目的 startedAt（間隔的錨點）就是它。 */
  firedAt: number;
  /**
   * fire 開場時還沒響的自排任務條數（pendingTasks + selfLog.tasks 裡 source='character'
   * 且時間在未來的）。它們到點各會消耗一條連發額度，排程工具算「還能不能再排」要連它一起數。
   */
  plannedSelfSends: number;
  /**
   * plannedSelfSends 那份快照裡各條任務的 uuid。排程閘退額度用：本輪被成功取消的、
   * 原本計入快照的任務，按它與 cancelledTasks 的交集把額度還回來——不退的話，
   * pending 打滿上限時提示詞教的「cancel + 重排」必被打回（任務刪了卻排不回來）。
   */
  plannedSelfSendUuids: string[];
  /** 本次觸發用到的角色 id / 任務歸屬鍵，排程時要寫進新任務的 metadata。 */
  charId: string;
  /**
   * 角色的時間參照系（fire_pack 的 tzId）。worker 裡一切「給角色看的時間」
   * ——當前時間槽、self_log 時間戳、排程清單、send_at 解析與打回文案——都從這一份出。
   */
  tz: AmsgTzRef;
  /** 任務行 uuid（skip 留痕要對上是哪一條；拿不到為 null）。 */
  taskUuid: string | null;
  /** 任務行 id（字符串化）；日誌與自排任務的 metadata 用。 */
  taskRowId: string | null;
  /** 客戶端給這條任務起的歸屬鍵，self_log 的條目 id 用它。 */
  clientTaskId: string;
  /**
   * 這次生成的各段正文，等推送發完由 onAfterSend 按真送出去的段數寫進 self_log。
   * 沒生成、或者已經寫過一次時為 null。
   */
  selfLogTexts: string[] | null;
  /**
   * prompt 裡那句「你此刻在聽：《X》」寫的是哪一首（這一段沒渲染時為 null）。
   *
   * 在 onBeforeFire 就定下來，用的是填槽那一刻的時間：角色寫的 MUSIC_ACTION 說的正是
   * 它讀到的那首歌，onLLMOutput 把它凍進 directive 帶給客戶端（見 agentic.attachSceneSong）。
   */
  sceneSong: { id?: number; name: string; artists: string } | null;
  /** 這條任務是不是即時對話（用戶剛發完消息在等回覆）；決定要不要寫 outbox。 */
  instant: boolean;
  /**
   * Soren 的雲端延遲回覆（任務 metadata.amsgDelayedReply，見 utils/delayedReplyCloud.ts）。
   * 跟即時對話一樣是在回用戶的話，判斷用 isReplyLikeFire。
   */
  delayedReply?: boolean;
  /**
   * 這一輪的情緒評估（副 API）。onBeforeFire 起跑、onLLMOutput 收尾時 await，
   * 結論掛上最後一條 push。沒配評估 / 不是即時對話時是 null。
   *
   * 存 promise 而不是結果：評估和主生成是並行跑的，等到收尾時多半早就跑完了。
   */
  emotionEvalPromise: Promise<AmsgEmotionEvalOutcome> | null;
  /**
   * 評估沒趕上順風車（EMOTION_EVAL_RIDE_ALONG_MS），push 上只掛了引用鍵 + pending
   * 標記。收尾時（amsgFireSettled）據此把遲到的結果寫進旁路存儲，客戶端輪詢補落。
   */
  emotionLatePending: boolean;
}

const getFireStash = (scratch: Record<string, unknown> | undefined): FireStash | undefined =>
  scratch?.fire as FireStash | undefined;

/** 兩個時間戳取較新的那個；兩個都沒有為 null。 */
const laterOf = (a: number | null, b: number | null): number | null =>
  (a == null ? b : b == null ? a : Math.max(a, b));

/**
 * 用雲端 tool_pack / tool_config 拼 dispatchAgenticTool 要的 ctx。
 *
 * 純構造：解析與「解析不出來怎麼辦」都留在 onBeforeFire（它才知道 taskId / charId 這些
 * 報錯上下文），這裡只管把兩份已經驗好的數據裝成 ctx。
 */
const buildToolCtx = (
  pack: AmsgToolPack,
  config: AmsgToolConfig,
): { toolCtx: AgenticToolCtx; proxyWorkerUrl: string | null; xhsCookie: string } => {
  // AgenticToolChar 就是 agenticTools 真正會讀的那幾個字段（runRecall / resolveXhsConfig /
  // 日記按角色名查）。用它當類型而不是硬轉 CharacterProfile：那邊多讀一個字段這裡就編譯不過，
  // 不會等到 worker 到點才拿到 undefined。
  const char: AgenticToolChar = {
    name: pack.charName,
    xhsEnabled: pack.xhsEnabled,
    activeMemoryMonths: pack.activeMemoryMonths,
    memories: pack.memories,
  };

  return {
    toolCtx: {
      char,
      userProfile: {} as UserProfile,
      // AmsgToolConfig 的憑據字段就是 AgenticToolRealtimeConfig，結構化直接滿足——
      // 不用逐字段抄一遍再強轉，那樣 buildToolConfig 加字段這裡不會報錯。
      realtimeConfig: config,
      // XHS 多步流程（search → detail 的 xsecToken 緩存）在同一次 fire 內共享。
      xhsCaches: {
        xsecTokenCache: new Map(),
        noteTitleCache: new Map(),
        commentUserIdCache: new Map(),
        commentAuthorNameCache: new Map(),
        commentParentIdCache: new Map(),
      },
      lastXhsNotesRef: { current: [] },
    },
    proxyWorkerUrl: config.proxyWorkerUrl ?? null,
    xhsCookie: config.xhsMcpConfig?.cookie ?? '',
  };
};

/**
 * fire 前置狀態不完整時拋這個 —— 不降級。
 *
 * 排程鏈已經保證「先傳雲端狀態、成功了再建任務」（見 activeMsgClient 的
 * putClientStateOrThrow），所以到點讀不到 fire_pack 只有三種可能：雲端狀態被刪了、
 * 數據壞了、任務是開發期的舊格式。都是異常，不是能悄悄降級的正常分支。
 *
 * 為什麼拋錯而不是 { skip: true }：skip 是「這次故意不發」的出口（防穿幫閘在用），
 * 用它表達「壞了」會把兩件事混在一起，而且循環任務會天天靜默不響、只有 worker 日誌
 * 裡看得見。拋錯走庫的投遞失敗路徑，任務標 failed + 寫 last_error，至少留下痕跡。
 *
 * permanent: true 是 amsg-server 2.6.0-next.15 起 isNonRetryableError 認的鴨子契約
 * （與它導出的 NonRetryableError 同效，標屬性就不用把根入口整個打進 bundle）：
 * 這批失敗全是確定性的狀態問題（fire_pack 缺失 / 解析不過 / 缺 chat 段），狀態不變
 * 重試三次只是讓等回覆的用戶多白等六分鐘，直接終審處置。老版上游不認這個屬性，
 * 行為退回「重試 3 次再 failed」，不會更糟。
 */
const fireStateError = (reason: string, detail: Record<string, unknown>): Error => {
  console.error('[amsg:fire-state-missing]', { reason, ...detail });
  const error = new Error(`AMSG2_FIRE_STATE_MISSING: ${reason}`);
  (error as Error & { permanent: boolean }).permanent = true;
  return error;
};

/** 內聯思考塊的成對標籤，跟 stripReasoningTags 認的是同一批。 */
const INLINE_THINK_RE = /<(think|thinking|thought)>([\s\S]*?)<\/\1>/gi;

/**
 * 把正文裡內聯的思考塊抄出來拼成一段（沒有就是空串）。
 *
 * 只認閉合的成對標籤：抄的範圍要跟正文剝掉的範圍對得上（stripReasoningTags 主判的就是
 * 成對標籤），也跟客戶端渲染那份同口徑——本地的 extractThinkingChain 只在**全文一個閉合
 * 標籤都沒有**時才走 open-only 兜底。沒閉合的那種照舊交給正文側兜：sanitize 有自己的
 * 未閉合兜底，整段只有一個沒閉合的思考塊時這一輪壓根不發 push。
 */
const extractInlineThink = (text: string): string => {
  if (!text.includes('<')) return '';
  const blocks: string[] = [];
  for (const match of text.matchAll(INLINE_THINK_RE)) {
    const inner = match[2].trim();
    if (inner) blocks.push(inner);
  }
  return blocks.join('\n\n');
};

/**
 * 思考鏈太長、一條 push 裝不下時的旁路存儲鍵（同 XHS / 情緒評估那套，見
 * amsgXhsSessionKey / amsgEmotionUpdateKey）。push 裡只留 `metadata.amsgReasoningRef`
 * 指過來，客戶端按鍵取回、用完即刪。每任務固定一份、下次觸發覆蓋。
 */
export const amsgReasoningKey = (clientTaskId: string) => `reasoning:${clientTaskId}`;

// 體積判定按「庫補完信封字段之後」的尺寸算：hook 交還 payload 之後，庫還會補
// messageId / sessionId / timestamp / messageIndex / totalMessages 和四個任務身份
// 字段。卡著上限判的話，量出來「剛好裝得下」的那一檔補完就超了——既沒走旁路存儲、
// 也發不出去，整條消息丟掉，而且每次重試都卡在同一處。餘量由庫導出
// （PUSH_ENVELOPE_RESERVED_BYTES），跟著它自己補的字段走，不用這邊手猜。

/** 這一份 payload 現在裝得下嗎（按庫補完信封字段之後的尺寸算）。 */
const pushFits = (payload: Record<string, unknown>): boolean =>
  measurePushPayload(JSON.stringify(payload), { reserveEnvelope: true }).withinLimit;

/** 旁路存儲的一棒：metadata 上的哪個字段整份挪走、挪完留哪個引用鍵、存到哪個鍵下。 */
interface OffloadBaton {
  /** metadata 上要挪走的字段名。 */
  field: string;
  /** 挪完留在 metadata 上的引用鍵字段名，客戶端照著它取回。 */
  refField: string;
  /** client_state 裡的存儲鍵（每任務一份，下次觸發覆蓋）。 */
  key: (clientTaskId: string) => string;
  /** 日誌前綴，`wrangler tail` 上一眼看出是哪一棒挪的。 */
  log: string;
}

/**
 * 挪的順序：思考鏈 → 情緒評估結果 → XHS 會話數據。
 *
 * 前兩樣都是整段模型輸出（幾百到幾千字），超限時多半是它倆撐爆的，而且客戶端拿它們
 * 只是渲染卡片 / 落 buff，晚一步取回來不影響這條消息本身；XHS 那份關係到這條消息裡的
 * 卡片能不能出來，所以排最後，挪完還是裝不下才動它。
 */
const OFFLOAD_BATONS: OffloadBaton[] = [
  {
    field: 'amsgReasoning',
    refField: 'amsgReasoningRef',
    key: amsgReasoningKey,
    log: '[amsg:reasoning] 思考鏈旁路存儲',
  },
  {
    field: 'amsgEmotionUpdate',
    refField: 'amsgEmotionRef',
    key: amsgEmotionUpdateKey,
    log: '[amsg:emotion] 評估結果旁路存儲',
  },
  {
    field: 'xhsSession',
    refField: 'xhsSessionRef',
    key: amsgXhsSessionKey,
    log: '[amsg:agentic] XHS 會話數據旁路存儲',
  },
];

/**
 * 一條 push 裝不下時，把大塊附加數據旁路存進 client_state，payload 裡只留引用鍵。
 *
 * Web Push 的 payload 上限是 4096 字節密文（明文 3993，見 measurePushPayload），
 * 一張筆記連標題帶摘要就六七百字節。過去的做法是硬砍到 4 張，於是角色說「分享了 6 張」
 * 而只出來 4 張卡——話和內容對不上，一眼假。現在改成按真實字節算：裝得下就照裝
 * （日常 1-3 張走的就是這條，行為不變），裝不下才把整份挪到 client_state，
 * 客戶端上線後按引用鍵取回，一張不少。
 *
 * 挪哪幾樣、按什麼順序挪見 OFFLOAD_BATONS。
 *
 * 存不進去時**拋錯**而不是砍內容：拋錯走投遞失敗重試，砍內容則是當場穿幫且無從察覺。
 */
export const offloadOversizedPush = async (
  payload: Record<string, unknown>,
  writeState: WriteState | undefined,
  charId: string,
  clientTaskId: string,
): Promise<Record<string, unknown>> => {
  if (pushFits(payload)) return payload;

  if (!clientTaskId) {
    // 存儲鍵是按 clientTaskId 編的，沒有它就沒法旁路。兩條建任務路徑和角色自排那條
    // 都必帶 amsgClientTaskId，走到這裡說明任務行是壞的——接下來庫會拋
    // PUSH_PAYLOAD_TOO_LARGE 把整條消息卡住，光看那個錯認不出根因，先吼一聲。
    console.warn('[amsg:offload] push 超限卻沒有 clientTaskId，旁路存儲用不上', {
      charId,
      bytes: measurePushPayload(JSON.stringify(payload)).bytes,
    });
    return payload;
  }

  const hasOffloadable = (value: unknown): boolean =>
    (typeof value === 'string' ? !!value : value != null);
  const readMeta = (p: Record<string, unknown>) => (p.metadata ?? {}) as Record<string, unknown>;

  // 沒有可旁路的東西，交給庫拋 PUSH_PAYLOAD_TOO_LARGE
  if (!OFFLOAD_BATONS.some((baton) => hasOffloadable(readMeta(payload)[baton.field]))) return payload;

  if (typeof writeState !== 'function') {
    // 老部署（amsg-server < 2.6.0-next.7）沒有寫入口。不靜默砍卡片——拋錯讓這次投遞
    // 失敗重試，設置頁的版本門檻會提示用戶重新粘貼部署。
    throw new Error('AMSG2_WRITE_STATE_UNSUPPORTED: push 超限需要旁路存儲，請在設置頁重新粘貼部署 worker');
  }

  // 一棒接一棒：每棒都從**上一棒的結果**上讀，裝得下了就收手。各挪各的字段，
  // 從原始 payload 重新起算的話，前一棒挪走的會被原樣塞回去、引用鍵也丟。
  let current = payload;
  for (const baton of OFFLOAD_BATONS) {
    const meta = readMeta(current);
    const value = meta[baton.field];
    if (!hasOffloadable(value)) continue;

    const key = baton.key(clientTaskId);
    // 字符串原樣存（客戶端取回來直接用），對象序列化一份。
    await writeState(amsgStateNamespace(charId), [
      { key, value: typeof value === 'string' ? value : JSON.stringify(value) },
    ]);
    const { [baton.field]: _moved, ...restMeta } = meta;
    const slimmed = { ...current, metadata: { ...restMeta, [baton.refField]: key } };
    console.log(baton.log, {
      key,
      charId,
      beforeBytes: measurePushPayload(JSON.stringify(current)).bytes,
      afterBytes: measurePushPayload(JSON.stringify(slimmed)).bytes,
    });
    current = slimmed;
    if (pushFits(current)) return current;
  }
  return current;
};

/**
 * 防穿幫閘跳過一次觸發時，留一句「為什麼沒響」給客戶端。
 *
 * 閘是靜默工作的：判定該讓路就直接跳過，一條 push 都不發，而遠端那行任務兩種情況下
 * （真發出去了 / 被閘攔下）都會被消費掉。客戶端事後看到的一模一樣，用戶只會覺得
 * 「說好的消息呢」。留一條記錄，面板就能照實說明。
 *
 * best-effort：寫不進去不能連累這次 skip 本身——閘該攔還是要攔，少一句解釋而已。
 */
const writeLastSkip = async (
  writeState: WriteState | undefined,
  charId: string,
  skip: AmsgLastSkip,
): Promise<void> => {
  if (typeof writeState !== 'function') return;
  try {
    await writeState(amsgStateNamespace(charId), [
      { key: AMSG_LAST_SKIP_KEY, value: JSON.stringify(skip) },
    ]);
  } catch (error) {
    console.warn('[amsg:skip] 跳過原因寫入失敗（跳過本身照常生效，只是面板少一句說明）', error);
  }
};

const recordSkip = async (
  ctx: FireCtx,
  charId: string,
  reason: AmsgLastSkip['reason'],
  occurrenceMs: number,
): Promise<void> =>
  writeLastSkip(ctx.writeState, charId, {
    v: 1,
    taskUuid: typeof ctx.task.uuid === 'string' ? ctx.task.uuid : null,
    occurrenceMs,
    reason,
    skippedAt: ctx.now.getTime(),
  });

// ─── self_log 的發送後回寫（⑥）───
//
// 過去 recordSelfLog 在 onLLMOutput 裡、推送發出**之前**調用——LLM 成功但推送全掛時
// 雲端記了「說過」而用戶一個字沒收到，下次 fire 角色會接著一句不存在的話往下說。
// 現在改成：onLLMOutput 只把各段正文掛在本次 fire 的 scratch 上，等庫發完（或發掛）
// 之後調 config 級 hook onAfterSend，只把**前 sentCount 段**寫進 self_log，entry.at
// 用實際發送時刻。sentCount=0（一段都沒出去）且沒落進收件箱時不寫——重試的下一條 fire
// 會重新生成。整批落進了收件箱（onFireSettled 的 outboxed）的，重試只補推原文、不再
// 調 hook，所以當場按整批記上。
//
// scratch 是這一次 fire 獨有的對象，onBeforeFire / onLLMOutput / onAfterSend 拿到的
// 是同一個引用，所以併發的幾個 fire 天然互不串台，也不需要按任務行 id 自建登記表。

/**
 * 一次 fire 收尾時把雲端自述日誌落盤（config 級 hook onFireSettled，見 buildWorkerConfig）。
 *
 * 掛在 onFireSettled 而不是 onAfterSend 上，因為後者只在「真發出去了」那條路被調用：
 * skip-push（這輪只做了副作用 / 空生成）、防穿幫閘 skip、中途拋錯三條路都不調。而角色
 * 用工具給自己排的任務在 ctx.scheduleTask 那一刻就已經建進 D1 了——帳沒落下來的話，
 * 客戶端認領不到、面板看不見、用戶取消不掉，它卻會一直按時發下去。
 *
 * 正文只在真送出去時才記：sentCount 是「實際送達幾段」，部分失敗時後面幾段用戶沒收到，
 * 記進去下一次角色就會以為自己說過。
 *
 * entry.at 用實際發送時刻（不是名義 occurrenceMs）：日誌給角色讀的是「我幾點幾分真的
 * 說了這句」，cron 延遲半小時時名義時刻是句謊話。id 仍是 `clientTaskId@occurrenceMs`
 * ——去重語義（同一次觸發重跑同 id 覆蓋）靠它，不動。
 *
 * best-effort：寫不進去不能連累投遞結果，但下一次到點角色就不知道自己說過這句，要吼一聲。
 */
/**
 * chat_fail 留痕的統一出口（即時對話失敗原因，客戶端 60s 點名判到行已出清後讀回）。
 * 三個寫入點共用：fire 收尾（amsgFireSettled）、過期跳過（amsgStaleSkip）、以及
 * onBeforeFire 拋錯那一刻（fail 的副作用——最典型的失敗都發生在掛 stash 之前，
 * 只靠收尾那份的話這些路徑一條痕都留不下）。每次覆蓋寫，最終留下最後一跳的原因。
 * best-effort：寫不進去只是失敗原因退化成籠統一句，絕不連累調用方。
 */
/**
 * fire 拋出來那個錯誤對象上的穩定 code（沒有 → null）。
 *
 * 刻意**只認 `code`**，不去讀 `statusCode`：Node 生態的 HTTP 庫習慣把上游狀態碼掛成
 * `statusCode`，而這個 catch 罩著整條投遞鏈——宿主 hook 裡轉手拋出的一個 404 會被讀成
 * 「推送訂閱已失效」，客戶端於是引導用戶白重建一次訂閱。上游踩過同一個坑，修法就是
 * 只在真正發 push 那一步認那個數（存在包內私有的 WeakMap 上，這裡讀不到）。
 * 推送狀態碼要用的話，讀上游寫在任務行 last_error 上的那份。
 */
const readErrorCode = (error: unknown): string | null => {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && code ? code : null;
};

const writeChatFail = async (
  writeState: WriteState,
  charId: string,
  record: { uuid: string; reason: string; retryCount: number; errorCode?: string | null },
): Promise<void> => {
  const full: AmsgChatFailRecord = {
    v: 1,
    uuid: record.uuid,
    reason: record.reason.slice(0, 500),
    retryCount: record.retryCount,
    at: Date.now(),
    ...(record.errorCode ? { errorCode: record.errorCode } : {}),
  };
  try {
    await writeState(amsgStateNamespace(charId), [
      { key: AMSG_CHAT_FAIL_KEY, value: JSON.stringify(full) },
    ]);
  } catch (error) {
    console.warn('[amsg:instant-chat] 失敗留痕寫不進去（客戶端只能報籠統原因）', error);
  }
};

/**
 * 即時對話終態失敗直發 error push 用到的三樣：推送 transport、D1、master key。
 * buildWorkerConfig 每次組裝配置時寫入（isolate 級全局，同代理地址 / XHS cookie 的先例：
 * 單用戶部署裡全局同一份才安全）。沒配齊時直發整個跳過，失敗告知退回 60s 點名兜底。
 */
interface InstantErrorPushDeps {
  webpush: { sendNotification: (subscription: unknown, body: string) => Promise<unknown> };
  db: { prepare: (sql: string) => { bind: (...args: unknown[]) => { first: () => Promise<Record<string, unknown> | null> }; first: () => Promise<Record<string, unknown> | null> } };
  masterKey: string;
}
let instantErrorPushDeps: InstantErrorPushDeps | null = null;

/** buildWorkerConfig 的寫入口；export 只為單測注入假 transport / 假庫。 */
export const configureInstantErrorPush = (deps: InstantErrorPushDeps | null): void => {
  instantErrorPushDeps = deps;
};

/** 通知橫幅上那句話（簡短人話）；聊天流裡的詳細說明由客戶端 describeInstantChatFailure 出。 */
const instantErrorNotificationBody = (reason: string): string => {
  if (reason === 'empty-generation') return '模型這一輪沒有生成內容，可以重新發一次。';
  if (reason === 'side-effects-only') return '角色這一輪只做了動作，沒有文字回覆。';
  if (reason === 'stale') return '這條消息在雲端排隊太久，已作廢。可以重新發一次。';
  return '這一輪雲端生成失敗了，點開查看原因，可以重新發一次。';
};

/**
 * 即時對話的**終態**失敗直發一條 `messageKind:'error'` 的 push（best-effort）。
 *
 * 只許在「這條任務不會再跑」的場合調：重試打光（retry_count 判定與上游
 * handleDeliveryFailure 同源）、skip-push（行被當成功消費）、stale 跳過。還會重試的
 * 失敗絕不發——「報錯完回覆又到了」這種誤報比晚知道更傷（SSE↔push 雙通道的老教訓）。
 *
 * 通知打 `show: 'always'` + 按角色摺疊 + 靜音：這條是自己直發的 push，不經庫的收件箱，
 * 收了不彈就是跟瀏覽器違約一次（配額、吊銷訂閱，見 applyInstantNotificationPolicy），
 * 所以推就一定彈。前台該收的尾照收——頁面監聽 active-msg-error 落系統消息、熄燈，
 * 跟彈不彈橫幅互不影響。發不出去只 warn——客戶端 60s 點名讀 chat_fail 的兜底路徑原樣
 * 保留，這條 push 只是把感知從分鐘級提到秒級。
 *
 * 訂閱行是加密存的（encryptForStorage 的 iv:authTag:data 格式）；個別老部署可能存的是
 * 明文 JSON，解密失敗時按明文再試一次，都不行才放棄。
 */
const sendInstantErrorPush = async (args: {
  charId: string;
  taskUuid: string;
  reason: string;
  /** 底層錯誤的穩定 code（見 AmsgChatFailRecord.errorCode）；客戶端按它給處置建議。 */
  errorCode?: string | null;
  /** 任務行上的 user_id；拿不到時取訂閱表唯一那行（單用戶部署）。 */
  userId?: string | null;
  contactName?: string | null;
}): Promise<void> => {
  const deps = instantErrorPushDeps;
  if (!deps?.masterKey) return;
  try {
    const row = args.userId
      ? await deps.db.prepare('SELECT user_id, subscription FROM push_subscriptions WHERE user_id = ? LIMIT 1').bind(args.userId).first()
      : await deps.db.prepare('SELECT user_id, subscription FROM push_subscriptions LIMIT 1').first();
    const stored = row?.subscription;
    const userId = row?.user_id;
    if (typeof stored !== 'string' || !stored || typeof userId !== 'string' || !userId) return;
    let subscription: unknown;
    try {
      const userKey = await deriveUserEncryptionKey(userId, deps.masterKey);
      subscription = JSON.parse(await decryptFromStorage(stored, userKey));
    } catch {
      subscription = JSON.parse(stored);
    }
    const payload = {
      messageKind: 'error',
      messageType: 'instant',
      charId: args.charId,
      contactName: args.contactName ?? undefined,
      // 確定性 id：同一條任務的終態只有一個，重複投遞靠 SW 的 messageId 去重兜住
      messageId: `err_${args.taskUuid}`,
      timestamp: new Date().toISOString(),
      metadata: {
        charId: args.charId,
        amsgInstantError: true,
        taskUuid: args.taskUuid,
        reason: args.reason.slice(0, 500),
        ...(args.errorCode ? { errorCode: args.errorCode } : {}),
      },
      notification: {
        title: args.contactName ? `${args.contactName} 的回覆沒能生成` : '回覆沒能生成',
        body: instantErrorNotificationBody(args.reason),
        show: 'always',
        silent: NOTIFICATION_SILENT_WHEN_VISIBLE,
        // 跟這個角色的回覆共用一個 tag：通知欄裡只留最新狀態，重發成功後那條回覆
        // 會把這條「沒能生成」蓋掉。失敗本身在聊天流裡有系統消息留痕，不靠橫幅記帳。
        tag: instantNotificationTag(args.charId),
        // 這一輪到此為止了，橫幅是唯一會去叫人的東西。同 tag 默認靜默替換，不帶
        // renotify 的話它會悄悄頂掉剛才那條回覆通知，用戶在後台就什麼都不知道。
        renotify: true,
      },
    };
    await deps.webpush.sendNotification(subscription, JSON.stringify(payload));
  } catch (error) {
    console.warn('[amsg:instant-chat] 失敗通知沒發出去（客戶端仍靠 60s 點名兜底）', error);
  }
};

export const amsgFireSettled = async (
  info: {
    /** sent / skipped / failed / not-handled；區分「有沒有真發出去」和「這跳掛了」。 */
    status?: string;
    sentCount?: number;
    /** D1 任務行原樣（上游 notifyFireSettled 透傳；retry_count 是明文列）。 */
    task?: { retry_count?: unknown } | null;
    /** 這一跳拋出的錯誤（status 'failed' 時才有）。 */
    error?: unknown;
    /**
     * 這一跳實際發出去的 LLM 請求次數（含失敗的那次）。上游 amsg-server 新版才報，
     * 老版本上沒有——那樣每日計數里就只有「發了幾次」，沒有「調了幾次模型」。
     */
    llmCalls?: unknown;
    /**
     * 這一批有沒有整批落進服務端收件箱（上游 amsg-server 新版才報）。落進去了就說明內容
     * 已經定了：推送這一跳就算沒成，上游重試時只會原樣補推、不會重新生成，客戶端上線
     * 也補收得到——所以這種「失敗」對用戶來說就是發出去了，只是晚點到。
     */
    outboxed?: unknown;
    scratch: Record<string, unknown>;
    writeState: WriteState;
  },
): Promise<void> => {
  const stash = getFireStash(info.scratch);
  if (!stash) return;   // onBeforeFire 沒走到掛 stash 那步（比如取 fire_pack 就失敗了）

  // 內容已經落定（見 info.outboxed）：之後的重試只補推送，而且補推那一跳不會再調任何
  // hook——這是記帳的最後機會，按「全部發出去了」記，別等一個不會來的回執。
  const committed = info.outboxed === true;
  const delivered = committed || (info.sentCount ?? 0) > 0;

  // 這一輪往雲端回寫的條目攢在一起，收尾一次寫完。
  const stateWrites: Array<{ key: string; value: string }> = [];

  // 每日計數：定時觸發發出去了記一次（多段氣泡也只算一次），調了幾次模型另記——失敗、
  // 判空沒發的那幾次同樣花了錢。即時對話是正常聊天，兩樣都不記。
  if (!isReplyLikeFire(stash) && !stash.dailyCounted) {
    stash.dailyCounted = true;   // 認領掉，重複調用不會記兩遍
    const sent = delivered ? 1 : 0;
    const llmCalls = typeof info.llmCalls === 'number' && info.llmCalls > 0 ? info.llmCalls : 0;
    if (sent || llmCalls) {
      stash.dailySends = bumpDailySends(stash.dailySends, stash.dailyDay, {
        sends: sent,
        llmCalls,
        sentId: `${stash.clientTaskId || 'task'}@${stash.occurrenceMs}`,
      });
      stateWrites.push({ key: AMSG_DAILY_SENDS_KEY, value: JSON.stringify(stash.dailySends) });
    }
  }

  // 即時對話這一跳掛了 → 失敗原因留痕（chat_fail），每次失敗嘗試覆蓋寫，最終留下的
  // 就是最後一跳的原因。客戶端 60s 點名判到「行已出清」後一次點名讀回這份，向用戶
  // 交代為什麼沒發出去——不用再按角色掃全量任務列表逐條解密（幾秒起步）。
  // best-effort：寫不進去只是失敗原因退化成籠統的一句，不能連累收尾其他動作。
  // 內容已經落定的不算失敗：回覆隨後就會補推到、或被客戶端補收，這時候留一句「沒發出去」
  // 或者發失敗通知，用戶會在回覆已經到了之後還看到報錯。
  if (stash.instant && info.status === 'failed' && !committed && stash.taskUuid) {
    const failReason = info.error instanceof Error ? info.error.message : String(info.error ?? '未知錯誤');
    const retryCount = typeof info.task?.retry_count === 'number' ? info.task.retry_count : 0;
    // 上游 amsg-server 2.6.0-next.21 起給這一族錯誤掛了穩定的 code（LLM 上游拒了請求是
    // LLM_CALL_FAILED，hook 契約違約是 AGENTIC_*，正文超限是 *_TOO_LARGE）。原樣帶下去，
    // 客戶端據此說「該查 API Key」還是「該重發」，不必去猜那句人話的措辭。
    const errorCode = readErrorCode(info.error);
    await writeChatFail(info.writeState, stash.charId, {
      uuid: stash.taskUuid,
      reason: failReason,
      retryCount,
      errorCode,
    });
    // 終態判定與上游同源，兩種都算：retry_count >= 3 的這跳失敗後行轉 failed
    // （handleDeliveryFailure 的梯子打光）；permanent 標記的錯誤（fireStateError 那族）
    // 上游一跳就終審。info.error 就是 fire 裡拋出的那個對象，permanent 屬性原樣帶過來
    // ——掛上 stash 之後才炸出的 permanent 只有這裡看得到（掛 stash 之前的那族由
    // onBeforeFire 的 fail() 直發，那時沒有 stash、走不到這裡，兩條機制天然互斥）。
    // 還會重試的失敗絕不發通知（回覆可能隨後就到）。
    const permanent = info.error instanceof Error
      && (info.error as Error & { permanent?: boolean }).permanent === true;
    if (retryCount >= 3 || permanent) {
      await sendInstantErrorPush({
        charId: stash.charId,
        taskUuid: stash.taskUuid,
        reason: failReason,
        errorCode,
        userId: typeof (info.task as Record<string, unknown> | null | undefined)?.user_id === 'string'
          ? (info.task as Record<string, unknown>).user_id as string
          : null,
      });
    } else if (stash.emotionEvalPromise && stash.clientTaskId) {
      // 還會重試的失敗：這一跳的情緒評估結果寫進旁路鍵留給下一跳——重試會整輪重跑
      // onBeforeFire，讀到這份就不再白燒一次副 API（見那邊的複用邏輯）。等待有界：
      // 只等搭車窗口那麼久，評估還沒跑完就算了，下一跳重新評估。
      try {
        const outcome = await raceEmotionEval(
          stash.emotionEvalPromise, '評估沒趕上這跳收尾，重試那輪只好重新評估');
        if (outcome?.raw) {
          await info.writeState(amsgStateNamespace(stash.charId), [
            { key: amsgEmotionUpdateKey(stash.clientTaskId), value: outcome.raw },
          ]);
        }
      } catch (error) {
        console.warn('[amsg:emotion] 重試前留不下評估結果（下一跳會重新評估）', error);
      }
    }
  }

  // 情緒評估沒趕上順風車、回覆已經先發出去了 → 在這裡等它出結果，寫進旁路存儲
  // （push 上已掛引用鍵 + pending 標記，客戶端對著鍵輪詢補落）。上游 await 這個 hook，
  // 評估自帶 EMOTION_EVAL_TIMEOUT_MS，續等是有界的。只在真送出去過（sentCount > 0）
  // 時等：一段都沒出去的話客戶端根本沒收到 pending 標記，任務還會整輪重跑。
  // 評估失敗或超時什麼都不寫——旁路只存 applyEmotionEvalRaw 認識的評估原文，
  // 客戶端輪詢到點自會按「最終沒等到」收尾。
  if (stash.instant && stash.emotionLatePending && stash.emotionEvalPromise
      && stash.clientTaskId && delivered) {
    stash.emotionLatePending = false;   // 認領掉，重複調用不會寫兩遍
    try {
      const outcome = await stash.emotionEvalPromise;
      if (outcome.raw) {
        await info.writeState(amsgStateNamespace(stash.charId), [
          { key: amsgEmotionUpdateKey(stash.clientTaskId), value: outcome.raw },
        ]);
      } else {
        console.warn('[amsg:emotion] 晚投評估沒跑出結果（這一輪情緒不更新）', outcome.error);
      }
    } catch (error) {
      console.warn('[amsg:emotion] 晚投評估收尾失敗（這一輪情緒不更新）', error);
    }
  }

  const texts = stash.selfLogTexts;
  stash.selfLogTexts = null;   // 認領掉，重複調用不會記兩遍
  // 落定了的整批都會送到（補推或補收），全記；沒落定的只記真送出去的前幾段。
  const sentCount = committed && texts ? texts.length : info.sentCount ?? 0;
  if (texts && sentCount > 0) {
    // 多段消息在用戶那邊是連著的幾條氣泡，對角色而言是一次「我說了這些」，合成一條記。
    // 只取前 sentCount 段：部分失敗（而且沒落進收件箱）時沒送出去的正文絕不能進日誌。
    const text = texts
      .slice(0, sentCount)
      .filter((message) => message.trim())
      .join('\n');
    const entryId = `${stash.clientTaskId || 'task'}@${stash.occurrenceMs}`;
    // 同一次觸發重跑（前一跳部分失敗）時日誌裡已經有這一條：條目同 id 覆蓋，
    // 重複任務的「連續沒回」計數也不能再加一次。
    const rerun = stash.selfLog.entries.some((e) => e.id === entryId);
    const next = appendSelfLogEntry(stash.selfLog, {
      id: entryId,
      at: Date.now(),
      startedAt: stash.firedAt,
      text,
      // 即時對話是在答用戶剛說的話——列進自述塊保持連續性，但不佔「主動連發」的額度
      // （帶這個標記的條目不會讓 selfLog.unansweredSends 加一）。
      ...(isReplyLikeFire(stash) ? { reply: true } : {}),
    });
    // 整段只有副作用標籤（正文為空）時 append 原樣返回——沒有話可記。
    if (next !== stash.selfLog) {
      stash.selfLog = next;
      stash.selfLogDirty = true;
    }
    // 重複任務這一次真發出去了：「連續幾次沒回」的計數加一（用戶開口時整份清零）。
    // 跟正文一起認領：texts 已經清掉，重複調用走不到這裡。
    if (!stash.instant && stash.recurring && stash.clientTaskId && !rerun) {
      stash.selfLog = bumpRecurringSend(stash.selfLog, stash.clientTaskId);
      stash.selfLogDirty = true;
    }
  }

  if (stash.selfLogDirty) {
    stash.selfLogDirty = false;
    stateWrites.push({ key: AMSG_SELF_LOG_KEY, value: JSON.stringify(stash.selfLog) });
  }
  if (stateWrites.length === 0) return;   // 這次 fire 什麼也沒添，不必寫庫

  try {
    await info.writeState(amsgStateNamespace(stash.charId), stateWrites);
  } catch (error) {
    console.warn('[amsg:self-log] 寫入失敗（這次照常發送，但下一次到點角色不會知道說過這句，每日計數也少記一次）', error);
  }
};

// ─── stale 守衛的消費端（⑥）───
//
// 上游 run-tick 的補發新鮮度守衛：任務錯過觸發時刻太久（服務停擺後恢復）不再補發，
// 並調 config 級 hook onStaleSkip(task, info)。不接這個 hook 的話，用戶看到的就是
// 「說好的消息憑空消失」——這裡把它寫成 last_skip，面板照實說明。
//
// info.action 分兩種，面板文案也分兩種：
//   expired        一次性任務，行已標 failed，這一次永遠不會補發了
//   fast_forwarded 循環任務，攢下的這幾次都跳過，排期已快進到 nextSendAt，下次照常
// 混為一談的話，每日提醒斷更一天會被說成「已經徹底沒了」。
//
// task 是 D1 任務行原樣，charId 在 encrypted_payload 裡解不開：上游把解密後的
// payload.metadata 遞進 info（只透傳 metadata，憑據不外漏），charId 從那裡取。兩條
// 排程路徑（客戶端排 / 角色自排）建任務時都寫了 metadata.charId，取不到就是真異常，
// 只能放棄留痕。寫口由 info 直接給，不用攢——攢下來的那份在 isolate 冷啟動後的第一
// 跳是空的，而「服務停擺恢復」正是這個 hook 最該留痕的時候。

/** config 級 stale 回執 hook（見 buildWorkerConfig）。export 只為單測。 */
export const amsgStaleSkip = async (
  task: { id?: unknown; uuid?: unknown } | null | undefined,
  info: {
    reason: string;
    action: 'expired' | 'fast_forwarded';
    metadata: unknown;
    occurrenceMs: number | null;
    skippedCount: number;
    nextSendAt: string | null;
    writeState: WriteState;
  },
): Promise<void> => {
  const meta = (info.metadata ?? {}) as Record<string, unknown>;

  // 後台任務（門牌整理這類）先接走。last_skip 那份留痕說的是「這條**主動消息**到點
  // 為什麼沒響」，主動消息面板照它給用戶解釋；後台任務過期跟主動消息毫無關係，寫進去
  // 面板就會說謊——服務停擺幾小時之後，用戶會看到一條「上次主動消息沒響、已被丟棄」，
  // 而那個角色根本沒排過主動消息。onBeforeFire 裡那條 kind-skip 分支躲開的就是這個，
  // 但它排在這個 hook 後面、看不到 kind，只能在這兒再擋一道。
  const taskKind = readTaskKind(meta);
  if (taskKind) {
    console.log('[amsg:stale-skip] 後台任務過期跳過，不寫 last_skip', {
      taskId: task?.id ?? null, kind: taskKind, action: info.action,
    });
    return;
  }

  const charId = typeof meta.charId === 'string' && meta.charId ? meta.charId : null;
  if (!charId) {
    console.warn('[amsg:stale-skip] 任務 metadata 缺 charId，這次過期跳過沒法留痕', { taskId: task?.id ?? null });
    return;
  }
  // 被過期跳過的是即時對話（服務停擺恢復時可能發生）→ 也寫一份 chat_fail：
  // 客戶端點名判到「行已出清」後靠它說出「排隊太久沒輪到」，而不是籠統的生成失敗。
  if (isInstantChatTask(meta) && typeof task?.uuid === 'string' && task.uuid) {
    await writeChatFail(info.writeState, charId, { uuid: task.uuid, reason: 'stale', retryCount: 0 });
    // 過期跳過也是一錘定音 → 直發失敗通知（best-effort），別讓用戶乾等點名。
    await sendInstantErrorPush({ charId, taskUuid: task.uuid, reason: 'stale' });
  }
  const nextSendAtMs = Date.parse(String(info.nextSendAt ?? ''));
  await writeLastSkip(info.writeState, charId, {
    v: 1,
    taskUuid: typeof task?.uuid === 'string' ? task.uuid : null,
    // 名義觸發時刻由上游給——它知道被跳過的是哪一次。任務行上的 next_send_at 在循環
    // 任務快進之後已經是「下一次」了，拿它當被跳過的時刻會差出一整輪。
    occurrenceMs: info.occurrenceMs ?? Date.now(),
    reason: 'stale',
    skippedAt: Date.now(),
    staleAction: info.action,
    skippedCount: info.skippedCount,
    nextSendAtMs: Number.isFinite(nextSendAtMs) ? nextSendAtMs : null,
  });
};

/**
 * 把角色這次給自己排下的任務掛到最後一條 push 上，客戶端收到時補進本地清單。
 *
 * 為什麼要帶回去：任務是在 D1 裡建的，客戶端那份清單並不知道它存在——面板不顯示、
 * 用戶想取消也找不到。任務本身照常觸發（這正是自排的意義：不依賴客戶端在線），
 * 客戶端上線認領只是把帳對上。
 *
 * 掛在**最後一條**：與 directives 同一個位置，收側的 isLastChunk 守衛保證只重放一次。
 * 一條 push 都沒有（整段被判空）時原樣返回——那種情況下這次本來也沒東西發出去。
 */
export const attachScheduledTasks = (
  pushPayloads: Array<Record<string, unknown>>,
  tasks: ActiveMsg2TaskRecord[],
): Array<Record<string, unknown>> => {
  if (tasks.length === 0 || pushPayloads.length === 0) return pushPayloads;
  const lastIdx = pushPayloads.length - 1;
  return pushPayloads.map((payload, i) => (i === lastIdx
    ? {
      ...payload,
      metadata: { ...(payload.metadata as Record<string, unknown> ?? {}), amsgSelfScheduled: tasks },
    }
    : payload));
};

/** 會真動 D1 任務行的那三個工具（其餘都是查東西的）。 */
const TASK_MUTATING_TOOLS = new Set<string>([
  AMSG_FIRE_SCHEDULE_TOOL, AMSG_FIRE_CANCEL_TOOL, AMSG_FIRE_RENEW_TOOL,
]);

/**
 * 一次工具調用值不值得記進工具痕跡（用來填 ToolCallRecord.ran）。兩族問的問題不一樣：
 *
 * - 查東西的（recall / 搜索 / 日記 / MCP…）問「有沒有真去查」：跑起來了就算，
 *   查了沒查到照算——角色說「我翻了下沒找到」是實話。壓根沒跑起來的（沒配 key、
 *   連不上、服務器沒開機）不算，那一族由 neverRan 認。
 * - 改排程的（schedule / cancel / renew）問「有沒有真改成」：`ok:false` 一律不算。
 *   它們的打回碼（unanswered_limit、task_not_found、ambiguous_task、cancel_failed…）
 *   都不在 neverRan 的集合裡，照 neverRan 判就成了「跑起來了」——於是取消失敗的那次
 *   也會在氣泡底下寫一行「調用了工具：取消排好的消息」，用戶據此以為排程沒了，而任務
 *   原封不動到點照響。這行灰字本來就是防穿幫的，不能自己造一個。
 *
 * 形狀認不出來（不是對象）時按「算」處理，與 neverRan 的兜底同口徑。
 */
const toolDidSomething = (name: string, result: unknown): boolean => {
  if (!result || typeof result !== 'object') return true;
  if (TASK_MUTATING_TOOLS.has(name)) return (result as { ok?: unknown }).ok !== false;
  return !neverRan(result);
};

/**
 * 這一輪在雲端**真做成事**的工具，按第一次出現的順序壓成 `[{ name, count }]`。
 *
 * 只留原始工具名和次數：參數和結果都不帶（那些是角色的內心活動，攤給用戶看反而出戲），
 * 翻譯成人話也不在這兒——那是顯示的事，歸客戶端（見 utils/amsgToolTrace.ts）。
 *
 * 哪些算「做成了」見 toolDidSomething：查東西的看有沒有真去查，改排程的看有沒有真改成。
 */
const condenseToolTrace = (
  calls: ReadonlyArray<ToolCallRecord>,
): Array<{ name: string; count: number }> => {
  const counts = new Map<string, number>();
  for (const call of calls) {
    if (call.ran === false) continue;
    counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count }));
};

/** 旁路也用不上（任務行沒有 clientTaskId）時給用戶看的一句話（跟著 amsgEmotionDone 回去）。 */
const EMOTION_EVAL_LATE_REASON = '情緒評估沒趕上這條回覆（副 API 太慢），這一輪先不更新';

/** 等評估結果，最多等 EMOTION_EVAL_RIDE_ALONG_MS；沒趕上返回 null，回覆照發。 */
const raceEmotionEval = (
  promise: Promise<AmsgEmotionEvalOutcome>,
  lateNote = '評估沒趕上這條回覆，先把話發出去（這一輪不更新情緒）',
): Promise<AmsgEmotionEvalOutcome | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[amsg:emotion] ${lateNote}`);
      resolve(null);
    }, EMOTION_EVAL_RIDE_ALONG_MS);
  });
  return Promise.race([promise, late])
    .finally(() => { if (timer !== undefined) clearTimeout(timer); });
};

/**
 * 用戶沒回期間「已經算進連發額度」的條數：發過的 + 先前排了還沒響的 + 這次已經排的，
 * 再加上正在發的這一條（定時觸發才算；即時對話是在答用戶）。
 *
 * 本輪成功取消的、原本計入快照的任務把額度還回來：提示詞教的「cancel + 重排」
 *（renew 循環任務補當次走的也是這條）在同一次 fire 內額度中性。只抵扣快照裡的
 * ——本輪剛排又反悔的不在快照裡，它的額度已隨 scheduledTasks 回縮，不重複退。
 */
/**
 * 這一輪是在回用戶的話、不是主動開口：即時對話，或 Soren 的雲端延遲回覆。
 * 不算進每日主動次數、不佔連發額度，也不跟下一條主動消息搶間隔。
 */
const isReplyLikeFire = (stash: Pick<FireStash, 'instant' | 'delayedReply'>): boolean =>
  stash.instant || stash.delayedReply === true;

const countCommittedSelfSends = (stash: FireStash): number => {
  const refundedSends = stash.cancelledTasks
    .filter((uuid) => stash.plannedSelfSendUuids.includes(uuid)).length;
  return countUnansweredSends(stash.selfLog)
    + stash.plannedSelfSends - refundedSends + stash.scheduledTasks.length
    + (isReplyLikeFire(stash) ? 0 : 1);
};

/**
 * 新排一條時要跟哪些時刻隔開：還掛著的任務各自的下一次觸發、本輪剛排的，以及用戶沒回
 * 之後最近一次主動發出去的時刻。定時觸發時正在發的這一條也算一個（它此刻就在發）；
 * 即時對話的這一條是在答用戶，不算——用戶剛開口，想馬上接著說點什麼是正常的。
 */
const selfScheduleBusyTimes = (stash: FireStash, nowMs: number): number[] => {
  const busy = liveTaskView(stash)
    .map((t) => currentOccurrenceMs(t, nowMs))
    .filter((ms): ms is number => ms != null);
  if (stash.lastSelfSendAt != null) busy.push(stash.lastSelfSendAt);
  if (!isReplyLikeFire(stash)) busy.push(nowMs);
  return busy;
};

/**
 * 執行一次「給自己排下一條」。永不拋錯——參數寫歪、排滿了都以 ok:false 回喂讓模型改口，
 * 跟別的工具一個語義（fire 拋錯 = 整條任務重跑 = 用戶這次一個字都收不到）。
 *
 * 冪等：任務 uuid 由「本次觸發 + 第幾條」推出來，fire 重跑時上游認出撞車、回 created:false，
 * 不會每重試一次多排一條。
 */
export const runFireScheduleTool = async (
  stash: FireStash,
  scheduleTask: ScheduleTask | undefined,
  args: Record<string, unknown>,
  nowMs: number,
): Promise<Record<string, unknown>> => {
  if (typeof scheduleTask !== 'function') {
    // 老 worker 部署（amsg-server < 2.6.0-next.9）沒有這個口子。設置頁的版本門檻會提示
    // 重新粘貼，這裡只需要讓角色別以為排上了。
    return { ok: false, reason: 'not_supported', message: '當前後台版本還不支持給自己排後續，這次就把話說完吧。' };
  }
  // 連發上限·排程閘（用戶主權）：已經算進額度的（口徑見 countCommittedSelfSends）加上
  // 這條會超就打回。到點兜底閘（onBeforeFire）是它的另一半——先排滿再觸發的在那邊攔。
  //
  // 正在發的這一條本身也算一條（定時觸發的話）：它的日誌條目要等發完才記，這會兒還沒進
  // 計數；不算上它的話，額度正好卡滿時會放行一條到點必被兜底閘跳過的後續——角色許了諾，
  // 到點卻一個字都沒有。
  const unansweredLimit = stash.limits.maxUnansweredSends;
  const committedSends = countCommittedSelfSends(stash);
  if (committedSends + 1 > unansweredLimit) {
    return {
      ok: false,
      reason: 'unanswered_limit',
      message: `對方還沒回復，這期間你已經發了/排了 ${committedSends} 條，用戶設置的連發上限是 ${unansweredLimit} 條——這次別排了，等 ta 回覆再說。`,
    };
  }
  if (stash.scheduledTasks.length >= MAX_FIRE_SCHEDULES) {
    return {
      ok: false,
      reason: 'fire_limit',
      message: `這次已經排了 ${MAX_FIRE_SCHEDULES} 條，夠了，剩下的話直接寫進這條消息裡。`,
    };
  }
  // 本輪取消掉的既有任務把名額還回來（提示詞教的「取消再重排」才走得通）。
  const pendingUuids = new Set(stash.pendingTasks.map((t) => t.taskUuid));
  const freedSlots = stash.cancelledTasks.filter((uuid) => pendingUuids.has(uuid)).length;
  const live = stash.pendingTaskCount - freedSlots + stash.scheduledTasks.length;
  if (live >= stash.limits.maxActiveTasks) {
    return {
      ok: false,
      reason: 'task_limit',
      message: `你同時掛著的任務已經有 ${live} 個（用戶設的上限是 ${stash.limits.maxActiveTasks}），這次別再排了。`,
    };
  }

  // 裸 send_at 按角色的時間參照系解析（③）：角色在 prompt 裡看到的鐘是它自己時區的，
  // worker 跑在 UTC，不帶 tz 的話「明早 9 點」會整整差一個時差。
  const parsed = parseFireScheduleArgs(args, nowMs, stash.tz);
  if ('ok' in parsed) return parsed as unknown as Record<string, unknown>;

  // 用戶定的規矩：能不能排重複的、兩條之間隔夠沒有、「到點必發」放沒放開（沒放開就按
  // 普通的排，不打回）。前台工具橋過的是同一份判定。
  const rules = checkSelfScheduleRules({
    limits: stash.limits,
    sendAtMs: Date.parse(parsed.sendAt),
    recurrence: parsed.recurrence,
    expirePolicy: parsed.expirePolicy,
    busy: selfScheduleBusyTimes(stash, nowMs),
    earliestMs: nowMs + MIN_SCHEDULE_LEAD_MS,
    formatTime: (ms) => formatFireTimeShort(ms, stash.tz),
  });
  if (!rules.ok) return rules as unknown as Record<string, unknown>;
  parsed.expirePolicy = rules.expirePolicy;

  // 同一次觸發內第幾條 —— 連同觸發時刻構成確定性 uuid，重跑對得上。序號只增不減
  // （selfScheduleSeq，見字段註釋）：取不得 scheduledTasks.length，取消會讓它回縮，
  // 「排→取消→再排」就會撞上還活著那條的 uuid。
  // uuid 開頭那 8 位摘要正是排程清單裡印給角色看的短 id，同一次 fire 排下的兩條
  // 必須印得不一樣（見 buildSelfScheduleUuid）。
  const seq = stash.selfScheduleSeq;
  const uuid = buildSelfScheduleUuid(stash.charId, stash.occurrenceMs, seq);
  const clientTaskId = `${uuid}-c`;

  let result;
  try {
    result = await scheduleTask({
      firstSendTime: parsed.sendAt,
      recurrenceType: parsed.recurrence,
      messageType: parsed.mode,
      uuid,
      // 角色自排的循環任務也按角色所在時區的牆鍾推進，跟用戶在面板排的同一套。
      tzId: stash.tz.tzId,
      metadata: {
        charId: stash.charId,
        source: 'active_msg_2',
        amsgMode: parsed.mode,
        amsgClientTaskId: clientTaskId,
        amsgExpirePolicy: parsed.expirePolicy,
        amsgTaskInstruction: buildTaskInstruction(parsed.mode, parsed.promptHint),
        // 自排標記：到點兜底閘只攔帶它的任務（用戶面板排的不受連發上限管）。
        amsgSelfScheduled: true,
      },
    });
  } catch (error) {
    // 上游的護欄（時間太近、類型不對、超上限）都拋錯。轉成回喂，讓模型換個時間再試。
    return {
      ok: false,
      reason: 'schedule_rejected',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  // 這個序號已經打到遠端了（created 和撞車都算），下一條換新號。打回/拋錯（上面已
  // return）不消號：重跑時同樣在那一步被打回，序號推進保持確定性。
  stash.selfScheduleSeq += 1;

  // 撞車 = 這一條在上一次重跑裡已經建過了（投遞失敗重試會重跑整個 fire）。任務確實在
  // D1 裡排著，但這一輪要是什麼帳都不記，它就只活在 D1 裡：隨 push 帶不回客戶端、面板
  // 看不到、用戶也取消不掉。以遠端那一行為準記帳——這一輪模型給的時間未必和第一次一樣，
  // 而真正會響的是第一次寫進去的那個。
  const remote = result.created ? null : result.task;
  const sendAt = remote?.nextSendAt || parsed.sendAt;
  const record: ActiveMsg2TaskRecord = {
    taskUuid: result.uuid,
    clientTaskId: remote?.clientTaskId || clientTaskId,
    mode: (remote?.messageType as ActiveMsg2TaskRecord['mode']) || parsed.mode,
    firstSendTime: sendAt,
    recurrenceType: (remote?.recurrenceType as ActiveMsg2TaskRecord['recurrenceType'])
      || parsed.recurrence,
    ...(parsed.promptHint ? { promptHint: parsed.promptHint } : {}),
    expirePolicy: parsed.expirePolicy,
    source: 'character',
    status: 'scheduled',
    createdAt: nowMs,
  };

  // 冪等：同一輪裡兩次調到同一個 uuid 不重複記帳。
  if (!stash.scheduledTasks.some((t) => t.taskUuid === record.taskUuid)) {
    stash.scheduledTasks.push(record);
    stash.selfLog = appendSelfLogTask(stash.selfLog, record);
    stash.selfLogDirty = true;
  }
  console.log('[amsg:self-schedule]', {
    uuid: result.uuid,
    sendAt,
    mode: record.mode,
    duplicate: !result.created,
  });

  if (!result.created) {
    // 對模型來說結果一樣：那條確實排上了。時間報遠端的真實值，別報它這次想改成的。
    return { ok: true, already_scheduled: true, send_at: sendAt };
  }

  return {
    ok: true,
    task_id: shortTaskId(result.uuid),
    send_at: sendAt,
    message: '排好了。到點你會知道自己這次說了什麼，接著說就行，現在不用劇透。',
  };
};

/**
 * 取消 / 改期工具按短 id 找目標時的活任務視圖：開場清單 + 本輪新排的，
 * 刨掉本輪已經取消的。不含當前正在 fire 的這條（它的收尾歸 run-tick 管）。
 */
const liveTaskView = (stash: FireStash): ActiveMsg2TaskRecord[] => {
  const cancelled = new Set(stash.cancelledTasks);
  return [...stash.pendingTasks, ...stash.scheduledTasks]
    .filter((t) => !cancelled.has(t.taskUuid) && t.taskUuid !== stash.taskUuid);
};

/** 從 selfLog.tasks 摘掉一條（取消時）或換時間（改期時）。沒這條就原樣返回。 */
const patchSelfLogTask = (
  stash: FireStash,
  taskUuid: string,
  patch: { remove: true } | { sendAt: string },
): void => {
  const tasks = stash.selfLog.tasks;
  if (!tasks.some((t) => t.taskUuid === taskUuid)) return;
  stash.selfLog = {
    ...stash.selfLog,
    tasks: 'remove' in patch
      ? tasks.filter((t) => t.taskUuid !== taskUuid)
      : tasks.map((t) => (t.taskUuid === taskUuid
        ? { ...t, firstSendTime: patch.sendAt, nextSendAt: patch.sendAt }
        : t)),
  };
  stash.selfLogDirty = true;
};

/**
 * fire 側取消任務（cancel_active_message）。
 *
 * D1 行刪掉之後必須兩頭消帳：selfLog.tasks（不消的話下次 fire 的清單裡它還在，
 * 角色以為沒取消成）+ stash.cancelledTasks（隨最後一條 push 回客戶端，面板跟著刪）。
 * 本輪剛排的那條也允許當場反悔——從 scheduledTasks 裡一併摘掉。
 */
export const runFireCancelTool = async (
  stash: FireStash,
  cancelTask: CancelTask | undefined,
  args: Record<string, unknown>,
  nowMs: number,
): Promise<Record<string, unknown>> => {
  if (typeof cancelTask !== 'function') {
    return { ok: false, reason: 'not_supported', message: '當前後台版本還不支持取消任務，先當它會照常響，把要說的話說清楚。' };
  }
  const resolved = resolveFireTargetTask(liveTaskView(stash), args.task_id, nowMs, stash.tz);
  if ('ok' in resolved) return resolved as unknown as Record<string, unknown>;
  const target = resolved.task;

  let result;
  try {
    result = await cancelTask(target.taskUuid);
  } catch (error) {
    return { ok: false, reason: 'cancel_failed', message: error instanceof Error ? error.message : String(error) };
  }
  if (!result.cancelled) {
    // 行已經不在了（先前取消過 / 已經觸發跑掉了）。對模型來說目的達成，照實說。
    return { ok: true, already_gone: true, message: `任務 [${shortTaskId(target.taskUuid)}] 已經不在排程裡了，不用再管它。` };
  }

  stash.cancelledTasks = [...stash.cancelledTasks, target.taskUuid];
  stash.scheduledTasks = stash.scheduledTasks.filter((t) => t.taskUuid !== target.taskUuid);
  patchSelfLogTask(stash, target.taskUuid, { remove: true });
  console.log('[amsg:self-cancel]', { uuid: target.taskUuid });
  return { ok: true, task_id: shortTaskId(target.taskUuid), message: `已取消 [${shortTaskId(target.taskUuid)}]。` };
};

/**
 * fire 側改期（renew_active_message）。
 *
 * 一次性任務走 ctx.renewTask 原地換時間（uuid 不變，與前台「重建換編號」不同——
 * fire 側有原地改的能力就不折騰編號）；循環任務與前台同語義：只給這一次補發一條
 * 一次性任務（複用排程工具的全部帳目與上限），原序列不動。fixed 模式不讓動
 * （沒有 AI 生成環節，改期該去設置面板）。
 */
export const runFireRenewTool = async (
  stash: FireStash,
  fireCtx: { renewTask?: RenewTask; scheduleTask?: ScheduleTask },
  args: Record<string, unknown>,
  nowMs: number,
): Promise<Record<string, unknown>> => {
  if (typeof fireCtx.renewTask !== 'function') {
    return { ok: false, reason: 'not_supported', message: '當前後台版本還不支持改期，要麼取消重排，要麼先當它會照常響。' };
  }
  const resolved = resolveFireTargetTask(liveTaskView(stash), args.task_id, nowMs, stash.tz);
  if ('ok' in resolved) return resolved as unknown as Record<string, unknown>;
  const target = resolved.task;
  if (target.mode === 'fixed') {
    return { ok: false, reason: 'fixed_task', message: '固定內容的任務不在這裡改，讓用戶去設置面板調整。' };
  }
  const parsed = parseFireRenewSendAt(args.send_at, nowMs, stash.tz);
  if ('ok' in parsed) return parsed as unknown as Record<string, unknown>;

  // 循環任務：補發一條一次性，原節奏不動（與前台 renew 同語義）。走排程工具的
  // 完整入口，連發上限 / 任務上限 / 記帳 / 認領全部照常生效。
  if (target.recurrenceType !== 'none') {
    const result = await runFireScheduleTool(stash, fireCtx.scheduleTask, {
      send_at: args.send_at,
      mode: target.mode,
      ...(target.promptHint ? { prompt_hint: target.promptHint } : {}),
      recurrence: 'none',
      expire_policy: target.expirePolicy,
    }, nowMs);
    if (result.ok === true) {
      return { ...result, message: `已為 [${shortTaskId(target.taskUuid)}] 的這一次補上一條一次性任務，原來的重複節奏不變。` };
    }
    return result;
  }

  let result;
  try {
    result = await fireCtx.renewTask(target.taskUuid, parsed.sendAt);
  } catch (error) {
    // 上游的護欄（時間太近、行型不認）都拋錯，轉成回喂讓模型換個時間再試。
    return { ok: false, reason: 'renew_rejected', message: error instanceof Error ? error.message : String(error) };
  }
  if (!result.renewed) {
    return { ok: false, reason: 'task_gone', message: `任務 [${shortTaskId(target.taskUuid)}] 已經不在排程裡了（可能剛觸發過），要說的話用 schedule_active_message 重新排。` };
  }

  stash.renewedTasks = [...stash.renewedTasks, { taskUuid: target.taskUuid, sendAt: result.nextSendAt }];
  patchSelfLogTask(stash, target.taskUuid, { sendAt: result.nextSendAt });
  console.log('[amsg:self-renew]', { uuid: target.taskUuid, sendAt: result.nextSendAt });
  return {
    ok: true,
    task_id: shortTaskId(target.taskUuid),
    send_at: result.nextSendAt,
    message: `已把 [${shortTaskId(target.taskUuid)}] 改到新時間（編號不變）。`,
  };
};

/**
 * 倒數第二輪的工具回喂末尾追加的一句。
 *
 * 這批結果喂進去之後就是最後一輪了，模型再請求工具只會被硬收尾（processLLMRound 那道
 * 閘），它寫的「等我再查查」會被丟掉。先把話說在前面，讓它自己把內容寫完——軟提示不管用
 * 時還有硬收尾兜著，兩層都在。
 */
const FINAL_ROUND_NOTICE = '（提醒：這是最後一輪了，不要再調用任何工具，直接把想說的話寫完。）';

/** 本輪的工具結果是不是餵給最後一輪的（ctx.iteration 缺失的老部署不提示）。 */
const feedsFinalRound = (iteration: number | undefined, maxToolIterations: number): boolean =>
  typeof iteration === 'number' && iteration >= maxToolIterations - 2;

/**
 * 單個 MCP 調用的超時。總 fire 預算 240s；MCP 雖可自適應推進到 12 輪，一個慢服務器
 * 仍不能吃光整條鏈（瀏覽器側是 60s，那邊沒有同一份 fire 總預算壓力）。
 *
 * 單次上限之外還有下面那條共享總預算：native FC 一輪可以吐好幾個調用，
 * executeToolCalls 是串行 await 的，只卡單次的話 25s × N 照樣能頂穿 240s。
 */
const MCP_CALL_TIMEOUT_MS = 25_000;

/**
 * 單次 fire 內全部 MCP 調用共享的時間預算。總 fire 240s，扣掉 LLM 往返，
 * MCP 最多吃一半——預算盡了讓後續調用早退（ok:false 回喂），比轉到輪次上限
 * 整條任務重跑便宜得多（重跑的代價見 agenticToolFeedback 頭註釋）。
 */
const MCP_TOTAL_BUDGET_MS = 120_000;

/**
 * 執行一個帶 MCP_FIRE_NAME_PREFIX 的工具調用。永不拋錯——失敗也以 ok:false 回餵給 LLM
 * 圓場（與 dispatchAgenticTool 的失敗語義對齊，見 executeToolCalls 註釋）。
 * export 只為單測。
 */
export const runMcpFireTool = async (
  stash: Pick<FireStash, 'mcpResolve' | 'mcpSessions' | 'mcpSpentMs'>,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const exposed = name.slice(MCP_FIRE_NAME_PREFIX.length);
  const hit = stash.mcpResolve?.get(exposed);
  if (!hit) {
    return { ok: false, reason: 'unknown_tool', message: `未配置的 MCP 工具: ${exposed}` };
  }
  // 預算盡了就不再發請求，直接把「別調了，收尾吧」回餵給模型——繼續排隊等超時只會
  // 把 fire 拖過總預算，那是整條任務重跑，比少查一次貴得多。
  const remaining = MCP_TOTAL_BUDGET_MS - stash.mcpSpentMs;
  if (remaining <= 0) {
    return {
      ok: false,
      reason: 'mcp_budget_exhausted',
      source: hit.server.name,
      message: 'MCP 調用時間預算已用完，這輪別再調外部工具了，用手上已有的信息收尾。',
    };
  }
  // 每台服務器一份會話，單次 fire 內跨輪複用：多步 MCP 最多十二輪，每輪重握手就是白燒往返。
  let session = stash.mcpSessions.get(hit.server.id);
  if (!session) {
    session = createMcpSessionState();
    stash.mcpSessions.set(hit.server.id, session);
  }
  const started = Date.now();
  const result = await callMcpToolCore(
    // worker 側 fetch 沒有 CORS，直連用戶配的地址，不經代理。
    {
      url: hit.server.url,
      headers: (sid, protocolVersion) => buildMcpDirectHeaders(hit.server, sid, protocolVersion),
    },
    session,
    hit.toolName,
    args as Record<string, any>,
    {
      // 剩餘預算比單次上限還少時按剩餘的來，最後一個調用不會越過總線。
      timeoutMs: Math.min(MCP_CALL_TIMEOUT_MS, remaining),
      inputSchema: hit.tool.inputSchema,
      serverLabel: hit.server.name,
    },
  );
  // 失敗/超時的耗時同樣記帳——燒掉的牆鍾時間不因為結果不好就不算。
  stash.mcpSpentMs += Date.now() - started;
  return result.success
    ? { ok: true, source: hit.server.name, data: formatMcpToolResult(result.data) }
    : { ok: false, reason: 'mcp_error', source: hit.server.name, message: result.error };
};

// export 只為單測（見 index.test.ts）：onBeforeFire 的四道門順序是這個功能最關鍵的
// 決策路徑，一個判斷寫錯位就是「該攔的沒攔」或「全都不發」，必須有迴歸守衛釘住。
export const amsgHooks = {
  async onBeforeFire(ctx: FireCtx) {
    const charId = ctx.task?.metadata?.charId;
    if (typeof charId !== 'string' || !charId) {
      throw fireStateError('task metadata 缺 charId', { taskId: ctx.task.id });
    }
    // 提前到這兒算（下面那段註釋仍在原位）：fail 的留痕副作用要用它。
    const instant = isInstantChatTask((ctx.task.metadata ?? {}) as Record<string, unknown>);

    // 下面每道門的報錯都帶同一套定位信息，綁一次就好——逐處手抄 detail 的話，
    // 加一道門就要再抄一遍，漏了就是一條查不到是誰的錯誤日誌。
    // 即時對話的失敗還在拋出那一刻就寫 chat_fail：最典型的失敗（fire_pack 缺失 /
    // 解析不過 / 缺 chat 段）都發生在掛 stash 之前，onFireSettled 那份留痕拿不到
    // stash、一條都寫不了，用戶等完全部重試只會得到「雲端沒記下原因」。fire-and-forget，
    // 不攔 throw；掛 stash 之後的失敗會被收尾那份用最後一跳的原因覆蓋，語義不變。
    const fail = (reason: string, extra?: Record<string, unknown>) => {
      if (instant && typeof ctx.task.uuid === 'string' && ctx.task.uuid) {
        // writeState 在老版本上游的 FireCtx 上可能不存在——那就退回沒有留痕的老行為。
        if (typeof ctx.writeState === 'function') {
          void writeChatFail(ctx.writeState, charId, {
            uuid: ctx.task.uuid,
            reason,
            retryCount: typeof (ctx.task as { retry_count?: unknown }).retry_count === 'number'
              ? (ctx.task as { retry_count: number }).retry_count
              : 0,
          });
        }
        // fireStateError 一律 permanent：上游一跳就把任務行標 failed（終態），而這批失敗
        // 都發生在掛 stash 之前——收尾那份（amsgFireSettled）因讀不到 stash 提前走人，
        // 一條通知都發不出，用戶會對著「正在輸入…」乾等到超時。終態失敗的 error push
        // 只能在這裡補發；與收尾那條互斥不雙發（這裡只在掛 stash 之前跑，收尾只在
        // stash 在場時發）。老上游不認 permanent 時每跳重試都會走到這兒，重複投遞由
        // 確定性 messageId（err_<uuid>）交給 SW 去重兜住。fire-and-forget，不攔 throw。
        void sendInstantErrorPush({
          charId,
          taskUuid: ctx.task.uuid,
          reason,
          contactName: ctx.task.contactName ?? null,
        });
      }
      return fireStateError(reason, { taskId: ctx.task.id, charId, ...extra });
    };

    // 前端上傳的雲端狀態可能被 packStateValue 壓過（值以 gz1: 開頭），讀回來統一先過
    // 一遍解壓——沒壓過的原樣穿過去，讀側不用賭客戶端到底壓了哪幾份。帶月度總結的
    // tool_pack 就在壓縮量級上，漏掉這一步整條 fire 鏈會卡死在「解析失敗」。
    // 解壓失敗說明數據真損壞了，和解析失敗同款硬失敗語義。
    const unpackOrFail = async (label: string, value: string): Promise<string> => {
      try {
        return await unpackStateValue(value);
      } catch (error) {
        throw fail(`${label} 解壓失敗（數據損壞）`, { error: String(error) });
      }
    };

    const taskMeta = (ctx.task.metadata ?? {}) as Record<string, unknown>;
    // Soren 的雲端延遲回覆（utils/delayedReplyCloud.ts）借的是一次性定時任務的殼，但它是在回
    // 用戶的話：跟即時對話一樣不算每日主動次數、不佔連發額度（見 isReplyLikeFire）。
    const replyLike = instant || taskMeta.amsgDelayedReply === true;
    // 任務上寫的防穿幫策略。角色自排的「到點必發」在用戶沒放開時會降成普通的
    // （見下面讀到 limits 之後的 policy），這裡先留原值。
    const taskPolicy = typeof taskMeta.amsgExpirePolicy === 'string'
      ? taskMeta.amsgExpirePolicy : undefined;
    const selfScheduled = taskMeta.amsgSelfScheduled === true;
    const recurring = ctx.task.recurrenceType === 'daily' || ctx.task.recurrenceType === 'weekly';

    // 副 API 憑據落地即取走：這一份 metadata 對象上游還要按引用往下傳（onLLMOutput 的
    // ctx.metadata、以及 hook 不接手時那條會把整份 metadata 直接掛上推送的模板路徑），
    // 在最早的地方摘掉，後面誰也漏不出去。取完還要用——即時對話那一支下面拿它起跑評估。
    // 這裡不分支：定時任務上本來就不該有這個鍵，真有也一樣刪掉。見 takeEmotionEvalSpec。
    const emotionEvalSpec = takeEmotionEvalSpec(ctx.task.metadata);

    // 非聊天任務在這裡就被接走（見 fireKinds.ts）。分派排在下面四道門之前是有意的：
    // 那四道門問的都是「主動消息到點還該不該發」，對「後台整理一份數據」全都不適用；
    // 而且它們要的 fire_pack / tool_pack 是聊天專用的雲端狀態，後台任務根本沒傳過，
    // 排在後面的話第一道硬失敗門就會把它判死。憑據擦除（上面那句）刻意留在前面：
    // 不管什麼種類的任務，metadata 上萬一沾了副 API 憑據都得先摘掉。
    const taskKind = readTaskKind(taskMeta);
    if (taskKind) {
      const handler = FIRE_KIND_HANDLERS[taskKind];
      if (!handler) {
        throw fail(`不認識的任務種類 amsgKind=${taskKind}（worker 代碼比前端舊，去設置頁重新部署一次）`);
      }
      let plan;
      try {
        plan = await handler.beforeFire({ ctx, charId, taskMeta });
      } catch (error) {
        throw fail(error instanceof Error ? error.message : String(error), { kind: taskKind });
      }
      if ('skip' in plan) {
        // 不寫 last_skip：那份留痕說的是「這條**主動消息**到點為什麼沒響」，主動消息
        // 面板照它給用戶解釋。後台任務的跳過跟主動消息毫無關係，寫進去面板就會說謊。
        console.log('[amsg:kind-skip]', { taskId: ctx.task.id, kind: taskKind, reason: plan.reason });
        return { skip: true } as const;
      }
      // 掛上跨 hook 的上下文，onLLMOutput 靠它認出「這一輪不是聊天」。
      putKindFireStash(ctx.scratch, taskKind, plan.state);
      return {
        messages: plan.messages,
        ...(plan.totalTimeoutMs ? { totalTimeoutMs: plan.totalTimeoutMs } : {}),
      };
    }

    // 角色狀態讀在這兒而不是更早：fire_pack + tool_pack 是「一個角色 32KB 起步」、胖角色
    // 還會被透明分塊的大對象，讀回來每條都要解密。上面那批後台任務根本沒傳過它，早讀一行
    // 就是每條任務白付一次 D1 往返加解密。
    const charRows = await ctx.readState(amsgStateNamespace(charId));

    // 用戶給這個角色定的「頻率與額度」（客戶端同步上來的那份，見 amsgLimits）。沒有或讀不出來
    // 就按默認值——默認值本身就是偏嚴的那一側，丟了記錄不會把閘打開。
    const limitsRecord = parseAmsgLimitsRecord(charRows.find((r) => r.key === AMSG_LIMITS_KEY)?.value);
    const recordLimits = resolveAmsgLimits(limitsRecord);
    // 角色自己排的「到點必發」，用戶沒放開時按普通的處理：碰上用戶正在聊天就讓路。
    // 放開之前排下的那些也一樣，不用等角色重排。
    const policy = selfScheduled && taskPolicy === 'force' && !recordLimits.allowSelfForce
      ? 'expire' : taskPolicy;

    // 即時對話：用戶剛把話說完、正盯著「正在輸入…」等回覆。下面三道門問的都是
    // 「主動消息到點還該不該發」——用戶正在聊天所以讓路、對話已經往前走所以作廢、
    // 這次任務的方向是什麼——對「回一句用戶剛說的話」全都不適用，整段跳過。
    // （instant 本體在上面 fail 之前就算好了，這裡只是敘事位置。）

    // 同角色活躍會話租約：一輪對話生成期間客戶端每 15s 續租，45s TTL。
    // 這是 worker 防通知的第一道快速門；缺失/過期/壞數據就繼續走 fire_pack 規則。
    // 保持在 fire_pack 檢查之前：用戶正在聊天時應該直接 skip，既省一次狀態讀，
    // 也讓「狀態不完整」的異常任務在用戶正忙時安靜跳過、而不是拋錯刷失敗計數。
    const presence = parseAmsgChatPresence(
      charRows.find((r) => r.key === AMSG_CHAT_PRESENCE_KEY)?.value,
    );
    if (!instant && policy === 'expire' && isFreshChatPresence(presence, charId, ctx.now.getTime())) {
      console.log('[amsg:expire-skip]', {
        taskId: ctx.task.id,
        reason: 'active-chat-presence',
        presenceActiveAt: presence?.activeAt,
      });
      // 這道門在解析 fire_pack 之前，拿不到 occurrenceMs，用任務行的名義時刻。
      await recordSkip(
        ctx, charId, 'active-chat-presence',
        Date.parse(String(ctx.task.nextSendAt)) || ctx.now.getTime(),
      );
      return { skip: true } as const;
    }

    const packRow = charRows.find((r) => r.key === AMSG_FIRE_PACK_KEY);
    if (!packRow) throw fail('雲端沒有這個角色的 fire_pack');

    // 大值分塊由 amsg-server 2.6.0-next.4+ 在存儲層透明處理，readState 拿到的已是拼回的原文。
    const packJson = await unpackOrFail('fire_pack', packRow.value);
    const pack = parseFirePack(packJson);
    // 失敗原因寫清楚：升 fire_pack 版本要 worker bundle 和前端一起動，而設置頁的版本門檻
    // 讀的是上游 amsg-server 庫的版本號，只改 SullyOS 自己這份 worker 代碼時它不會亮。
    // 面板上的 lastError 是用戶唯一能看到的線索，得直接說出該做什麼。
    if (!pack) throw fail(`fire_pack 解析失敗：${describeFirePackVersion(packJson)}`);

    // 連發上限以前跟著 fire_pack 走。前端還沒換新版（沒傳過 limits 那份）時，老包上那個值
    // 就是用戶設過的上限——拿默認值頂掉的話，設了「不限」或 10 條報備的人會突然被卡在 3 條。
    // 新前端第一次上傳就會帶上 limits，這條退路自然用不上了。
    const legacyUnanswered = (pack as { maxUnansweredSends?: unknown }).maxUnansweredSends;
    const limits = limitsRecord || legacyUnanswered === undefined
      ? recordLimits
      : { ...recordLimits, maxUnansweredSends: resolveMaxUnansweredSends(legacyUnanswered) };

    // 即時對話缺 chat 段 = 雲端狀態和任務對不上（客戶端只傳了主動消息那半份）。
    // 硬失敗，絕不退回模板渲染：拿「到點主動找人說話」的提示詞去答用戶剛說的話，
    // 出來的東西驢唇不對馬嘴，而用戶完全看不出這是壞了還是角色就這樣。
    if (instant && !pack.chat) {
      throw fail('即時對話任務的 fire_pack 裡沒有 chat 段（雲端狀態沒跟上）');
    }

    // 定時輪撞上佔位模板：角色 2.0 關著且無任務時，即時對話上傳的輕量包把 template 填成
    // 佔位串（AMSG2_INSTANT_STUB_TEMPLATE）；欠著即時回覆期間用戶新排了定時任務、真模板
    // 的補傳又被擋到銷帳之後時，任務可能先到點——照渲就是把那句佔位自白當系統提示詞發出去。
    // 拋**可重試**錯誤（不帶 permanent、不走 fail()）：這不是狀態壞了，只是包還沒就緒，
    // 走上游重試梯子（2/4/6 分鐘，第一跳就比客戶端銷帳後 60s 一輪的補傳回看寬），銷帳後
    // 真模板到位自然放行；一直不來就按正常梯子終失敗。
    // 即時輪不渲染模板，不受這道門管；這條是定時輪，也不寫 chat_fail、不發 error push。
    // fixed 任務（固定文案、不走 LLM）不會被這道門等死：上游按 taskNeedsLlm 把關，
    // messageType 'fixed' 壓根不進 onBeforeFire，直接走固定文案分支。
    if (!instant && pack.template === AMSG2_INSTANT_STUB_TEMPLATE) {
      console.warn('[amsg:fire-pack-stub] fire_pack 還是即時對話的佔位模板，等客戶端補傳後重試', {
        taskId: ctx.task.id,
        charId,
      });
      throw new Error('AMSG2_FIRE_PACK_NOT_READY: fire_pack 裡還是即時對話的佔位模板（真模板尚未補傳），這次觸發先重試等它就位');
    }

    // 本次觸發時刻：任務行 next_send_at（NOT NULL，buildHookTask 已攤平提供）。防穿幫閘的
    // 循環判定要拿它當窗口錨點，之後又經 scratch 透傳給每條 push 的 metadata.amsgOccurrenceMs
    // （客戶端兜底閘的循環判定與吞放緩存鍵都要它）。解析不出來說明上游任務行的時間格式變了，
    // 按狀態異常硬失敗。
    const occurrenceMs = Date.parse(String(ctx.task.nextSendAt));
    if (!Number.isFinite(occurrenceMs)) {
      throw fail('任務行 next_send_at 解析不出觸發時刻', { nextSendAt: ctx.task.nextSendAt });
    }

    // 防穿幫閘·worker 主判定：一次性任務創建後對話已前進 / 循環任務到點時用戶
    // 正在熱聊 → { skip: true } 跳過本次 fire（amsg-server skip 出口，任務照常
    // 推進/刪除），一個生成 token 都不花。fire_pack.lastUserMessageAt 隨 amsgStateSync
    // 在微任務裡沖刷，滯後的只有一次上傳往返（慢網下也是幾秒量級）；這點殘餘競態由客戶端
    // 送達兜底閘兜住（activeMsgRuntime 的 runtime-expire-swallow）。缺策略字段的任務不攔。
    //
    // 「用戶最後一次開口」取 fire_pack 和 presence 兩份裡較新的：presence 行是每輪聊天
    // 一開場就寫的小值，幾十字節就發完了；fire_pack 是整包幾十 KB，同樣是打髒即發，
    // 但傳完總要慢一截。presence 過期（TTL 45s，上面那道門用的就是它）只說明用戶此刻不在
    // 等回覆，不影響「他最後一次開口是幾點」這個事實，所以這裡不看新鮮度，只保留 charId
    // 校驗——別拿別的角色的對話當錨點。
    const presenceLastUserMessageAt = presence?.charId === charId ? presence.lastUserMessageAt : null;
    const expireInput = {
      policy,
      lastUserMessageAt: laterOf(pack.lastUserMessageAt ?? null, presenceLastUserMessageAt),
      nowMs: ctx.now.getTime(),
      occurrenceMs,
    };
    // 判定輸入原樣留一行，**放行也留**。客戶端送達兜底閘會拿同一套規則、更新的數據
    // 再判一次，兩邊結論不一樣時（worker 放行 → 生成 → 推送，客戶端吞掉）用戶看到的
    // 就是「通知彈出來了、點進去沒有」，而這中間沒有任何一處說得出發生過什麼。只有把
    // 兩邊的輸入都留下來，事後才分得清是哪一邊、因為哪個字段。
    // 「最後一次開口」拆成兩個來源分別記：合併後的那一個值看不出 fire_pack 是不是
    // 陳舊的，而「fire_pack 落後於真實對話」正是兩邊判定分叉的頭號原因。
    // 字段全是時間戳與枚舉，不含正文、不含角色名。
    const expireTrace = {
      taskId: ctx.task.id,
      // 判定本身已經不看任務類型了（一次性和循環同一條規則），但排查時得認得出是哪種。
      recurrenceType: ctx.task.recurrenceType,
      ...expireInput,
      packLastUserMessageAt: pack.lastUserMessageAt ?? null,
      presenceLastUserMessageAt,
    };
    if (!instant && shouldExpireFire(expireInput)) {
      console.log('[amsg:expire-skip]', { ...expireTrace, reason: 'conversation-moved-on' });
      await recordSkip(ctx, charId, 'conversation-moved-on', occurrenceMs);
      return { skip: true } as const;
    }
    if (!instant) console.log('[amsg:expire-pass]', expireTrace);

    // 任務指令缺失（開發期舊格式任務）：不能用默認 auto 指令湊一個渲染——那會把
    // prompted 任務的方向偷換掉，發出去的內容和用戶當初排的不是一回事。
    // 即時對話沒有「本次任務」這回事，方向就是回用戶剛說的那句話。
    if (!instant && typeof taskMeta.amsgTaskInstruction !== 'string') {
      throw fail('任務 metadata 缺 amsgTaskInstruction（舊格式任務）');
    }

    // 工具數據與 prompt 同拍裝好，掛 ctx.scratch 給同一次 fire 的
    // onLLMOutput / executeToolCalls（庫保證同引用、fire 結束即丟，
    // 不需要自維護 sessionId → 狀態的 Map 和防洩漏水位）。
    const globalRows = await ctx.readState(AMSG_GLOBAL_NAMESPACE);
    const toolPackRow = charRows.find((r) => r.key === AMSG_TOOL_PACK_KEY);
    const toolConfigRow = globalRows.find((r) => r.key === AMSG_TOOL_CONFIG_KEY);
    if (!toolPackRow) throw fail('雲端沒有這個角色的 tool_pack');
    if (!toolConfigRow) throw fail('雲端沒有 tool_config');

    // 兩份數據和 fire_pack 同批原子上傳（activeMsgClient 的 putClientStateOrThrow），
    // 所以走到這裡必然都在；和 fire_pack 一樣先解壓再解析（tool_pack 攢上幾條月度總結
    // 就會被前端壓縮）。解析不出來就是雲端狀態壞了，硬失敗不降級。
    const toolPack = parseToolPack(await unpackOrFail('tool_pack', toolPackRow.value));
    if (!toolPack) throw fail('tool_pack 解析失敗（格式不對或數據損壞）');
    const toolConfig = parseToolConfig(await unpackOrFail('tool_config', toolConfigRow.value));
    if (!toolConfig) throw fail('tool_config 解析失敗（格式不對或數據損壞）');

    // 通用 MCP：提示詞塊 / tools 數組與憑據同源同拍（都來自這一行 tool_config），
    // 不存在「教了角色用、憑據卻沒到」的窗口。charIds 過濾與前台同語義。
    // mcpUseNativeTools=false = 用戶的中轉拒 tools（前台「原生 tools」開關已關閉），
    // 請求不帶 tools 參數、提示詞塊教正文協議，識別走 processLLMRound 第二層。
    const mcpServers = filterMcpServersForChar(toolConfig.mcpServers, charId);
    // 暴露名後面要拼 MCP_FIRE_NAME_PREFIX，長度預算得先把前綴那幾個字符扣掉。
    const mcpResolve = mcpServers.length
      ? buildMcpNameMap(mcpServers, { maxNameLen: MCP_FIRE_NAME_BUDGET })
      : null;
    const mcpNative = toolConfig.mcpUseNativeTools !== false;
    // 只有通用 MCP 使用長預算；普通搜索/記憶/排程仍是原來的 5 輪。長預算也不是固定
    // 跑滿：模型正常收尾立即結束，連續重複調用則由 duplicate 閘提前收束。
    const maxToolIterations = resolveToolIterationBudget(!!mcpResolve);

    // 角色上次到點自己說了什麼：對齊到本次的 fire_pack 與用戶發言狀態。
    // 連發記錄（entries）只在用戶開口時清零，fire_pack 換代只作廢 tasks 段
    // ——兩段生死分開的理由見 amsgFirePack 的 reconcileSelfLogWithPack。
    const storedSelfLog = parseSelfLog(charRows.find((r) => r.key === AMSG_SELF_LOG_KEY)?.value ?? '');
    const selfLog = reconcileSelfLogWithPack(storedSelfLog, pack, expireInput.lastUserMessageAt);

    // 連發上限·到點兜底閘（用戶主權）：用戶未回覆期間，角色自己排的任務最多響這麼多次。
    // 只攔自排（amsgSelfScheduled）——用戶面板排的是明確意願，不受自己的防騷擾上限誤傷；
    // 即時對話在答用戶剛說的話，更不歸它管。排程工具那半邊只能攔「再排新的」，
    // 先排滿再觸發的繞不過它，得在這裡兜住。用戶一回話 entries 清零，閘自動解除。
    // 任務歸屬鍵：self_log 的條目 id、重複任務的「連續沒回」計數、以及「排程清單裡排除掉
    // 自己這條」都用它。
    const clientTaskId = typeof taskMeta.amsgClientTaskId === 'string' ? taskMeta.amsgClientTaskId : '';
    const nowMs = ctx.now.getTime();

    // 這類消息用戶已經關掉了：角色級 2.0 關著（fire_pack 或更新得更快的 limits 那份，
    // 任一說關就是關），或者這是角色自排的重複任務、而用戶沒讓它排重複的。
    // 關 2.0 時客戶端會先把 limits 寫成關、再去取消任務——取消掃完之後才冒出來的
    // （正在跑的那一輪順手排的）、以及取消失敗留下的，都在這裡攔住，一個 token 都不花。
    const scheduleOff = !pack.selfScheduleEnabled || limitsRecord?.selfScheduleEnabled === false;
    if (!instant && (scheduleOff || (selfScheduled && recurring && !limits.allowSelfRecurring))) {
      console.log('[amsg:schedule-off-skip]', {
        taskId: ctx.task.id, charId, selfScheduled, recurring, scheduleOff,
      });
      await recordSkip(ctx, charId, 'schedule-off', occurrenceMs);
      return { skip: true } as const;
    }

    const maxUnansweredSends = limits.maxUnansweredSends;
    if (!instant && selfScheduled
      && countUnansweredSends(selfLog) >= maxUnansweredSends) {
      console.log('[amsg:unanswered-limit-skip]', {
        taskId: ctx.task.id,
        charId,
        sends: countUnansweredSends(selfLog),
        limit: maxUnansweredSends,
      });
      await recordSkip(ctx, charId, 'unanswered-limit', occurrenceMs);
      return { skip: true } as const;
    }

    // 兩條之間的間隔·到點兜底閘：只管角色自排的。排程時已經按間隔打回過一輪，這裡兜住的
    // 是間隔調大之前就排下的、以及雲端自排還沒被客戶端認領的那些。留一點寬限（見
    // FIRE_GAP_TOLERANCE_MS），正好卡著間隔排下的那條不會被自己的上一條判成太近。
    // 錨點用那一條開始生成的時刻（startedAt）：排程時拿的也是開始時刻，用發完的時刻比
    // 會平白差出一整次生成的時長。同一次觸發重跑時，日誌裡那條就是它自己，不算。
    const occurrenceEntryId = `${clientTaskId || 'task'}@${occurrenceMs}`;
    const lastSelfSendAt = selfLog.entries
      .filter((e) => !e.reply && e.id !== occurrenceEntryId)
      .map((e) => e.startedAt ?? e.at)
      .reduce<number | null>((latest, at) => (latest == null || at > latest ? at : latest), null);
    if (!instant && selfScheduled && limits.minSendGapMs > 0 && lastSelfSendAt != null
      && nowMs < lastSelfSendAt + limits.minSendGapMs - FIRE_GAP_TOLERANCE_MS) {
      console.log('[amsg:min-gap-skip]', {
        taskId: ctx.task.id, charId, lastSelfSendAt, gapMs: limits.minSendGapMs,
      });
      await recordSkip(ctx, charId, 'min-gap', occurrenceMs);
      return { skip: true } as const;
    }

    // 重複的消息連續幾次沒人回就先停（用戶面板排的和角色排的都算）。跳過重複任務只是把
    // 排期推到下一次，不花 token；用戶一開口計數清零，下一次照常發。
    if (!instant && recurring && Number.isFinite(limits.recurringStopAfter)
      && countRecurringSends(selfLog, clientTaskId) >= limits.recurringStopAfter) {
      console.log('[amsg:recurring-unanswered-skip]', {
        taskId: ctx.task.id, charId, sends: countRecurringSends(selfLog, clientTaskId),
        stopAfter: limits.recurringStopAfter,
      });
      await recordSkip(ctx, charId, 'recurring-unanswered', occurrenceMs);
      return { skip: true } as const;
    }

    // 每日上限：用戶面板排的也算（用戶自己選的口徑），即時對話不算——那是正常聊天。
    // 「今天」按用戶那邊的日期：這是用戶的錢包閘，跟角色活在哪個時區無關。
    const dailyDay = dayKeyInZone(nowMs, pack.userTzId);
    const dailySends = parseDailySends(charRows.find((r) => r.key === AMSG_DAILY_SENDS_KEY)?.value);
    const sentToday = sendsOnDay(dailySends, dailyDay);
    if (!replyLike && sentToday >= limits.dailySendCap) {
      console.log('[amsg:daily-limit-skip]', {
        taskId: ctx.task.id, charId, day: dailyDay, sentToday, cap: limits.dailySendCap,
      });
      await recordSkip(ctx, charId, 'daily-limit', occurrenceMs);
      return { skip: true } as const;
    }

    // 客戶端記錄的（打包那一刻的快照）+ 角色自己在之前幾次 fire 裡排下、客戶端還沒認領的。
    // 後者不補上的話，角色排完一條、下次到點又看不見它，很容易把同一件事再排一遍。
    const livePendingTasks = [...pack.pendingTasks, ...selfLog.tasks];
    // 算額度和名額時要扣掉正在觸發的這一條一次性任務：它發完就沒了，而「正在發的這一條」
    // 在連發額度裡另外單獨算了一次（見 countCommittedSelfSends）——不扣就是同一條算兩遍。
    // 重複任務發完還在，照舊佔著名額。
    const otherLiveTasks = livePendingTasks.filter((t) => recurring
      || (t.taskUuid !== ctx.task.uuid && (!clientTaskId || t.clientTaskId !== clientTaskId)));

    // 角色級 2.0 開關（pack.selfScheduleEnabled，打包時取 isAmsg2EnabledForChar）。
    // 關著 = 排程說明塊、排程工具、任務清單一概不注入：本地路徑這道閘在 useChatAI 的
    // amsg2ToolsInjected——用戶顯式關掉的功能不能被雲端聊天輪繞開重排任務。
    // 必填字段（parseFirePack 把關），不做缺省——這道閘缺省放行就是 fail-open。
    // limits 那份更新得更快（關 2.0 時第一個寫的就是它），任一說關就是關。
    const selfScheduleAllowed = !scheduleOff;

    // 老 worker 部署（amsg-server < 2.6.0-next.9）沒有這個口子。教了也排不成，
    // 只會讓角色說「我等下再找你」然後沒有下文——乾脆不教。
    const canSelfSchedule = typeof ctx.scheduleTask === 'function' && selfScheduleAllowed;

    // 角色的時間參照系：fire_pack 的 tzId（parseFirePack 保證非空，Intl 管夏令時）。
    const tz: AmsgTzRef = { tzId: pack.tzId };

    const { toolCtx, proxyWorkerUrl, xhsCookie } = buildToolCtx(toolPack, toolConfig);
    // 連發額度裡「先前排了還沒響」那一份的快照：條數進 plannedSelfSends，uuid 留一份
    // 給排程閘退額度用（本輪取消掉快照裡的任務時按交集抵扣，cancel + 重排額度中性）。
    const plannedSelfSendTasks = otherLiveTasks
      .filter((t) => t.source === 'character' && isPendingTask(t, ctx.now.getTime())
        // 正在觸發的這條重複任務，下一次要等下個週期，不算「用戶沒回期間還要發的」。
        && t.taskUuid !== ctx.task.uuid);
    // 顯式標註而不是 satisfies：下面即時對話那一支要往 emotionEvalPromise 上寫 promise，
    // 用 satisfies 的話這個字段會被推成字面量 null 類型，寫不進去。
    const stash: FireStash = {
      session: createFireSessionState(),
      toolCtx,
      proxyWorkerUrl,
      xhsCookie,
      occurrenceMs,
      selfLog,
      selfLogDirty: false,
      mcpResolve,
      maxToolIterations,
      fireToolNames: new Set(),
      mcpSessions: new Map(),
      mcpSpentMs: 0,
      // 「還能不能再排」按客戶端已知的 + 角色自己排過還沒被認領的一起算，
      // 不然角色離線期間連排幾次就能繞過每角色的任務上限。
      pendingTaskCount: otherLiveTasks.length,
      pendingTasks: livePendingTasks,
      scheduledTasks: [],
      // 序號與 scheduledTasks 一樣從空帳起步；此後只增不減（取消不回退，見字段註釋）。
      selfScheduleSeq: 0,
      cancelledTasks: [],
      renewedTasks: [],
      limits,
      lastSelfSendAt,
      recurring,
      dailyDay,
      dailySends,
      dailyCounted: false,
      firedAt: nowMs,
      plannedSelfSends: plannedSelfSendTasks.length,
      plannedSelfSendUuids: plannedSelfSendTasks.map((t) => t.taskUuid),
      charId,
      tz,
      taskUuid: typeof ctx.task.uuid === 'string' ? ctx.task.uuid : null,
      taskRowId: ctx.task.id != null ? String(ctx.task.id) : null,
      clientTaskId,
      selfLogTexts: null,
      // 跟下面 renderFirePack 填「你此刻在聽」用的是同一個時刻、同一份 scene、同一個種子
      // （resolveFireSceneSong 與 renderFireSceneBlock 共用判定），凍的必然是正文裡那首。
      sceneSong: resolveFireSceneSong(pack.scene, ctx.now.getTime(), tz),
      instant,
      delayedReply: replyLike && !instant,
      // 下面即時對話那一支起跑（要等請求消息拼完才知道給評估喂什麼）。
      emotionEvalPromise: null,
      emotionLatePending: false,
    };
    ctx.scratch.fire = stash;

    // 「你還掛著這些排程」：客戶端記錄的（打包那一刻的快照）+ 角色自己在之前幾次 fire 裡
    // 排下、客戶端還沒認領的那些。後者不補上的話，角色排完一條、下次到點又看不見它，
    // 很容易把同一件事再排一遍。
    // 角色級 2.0 開關關著時整塊不給（跟排程工具同一道閘，但不看 scheduleTask 能力：
    // 老 worker 只是排不了新任務，已有清單照舊要給）。本地路徑關著開關連任務清單都
    // 不注入，雲端給了就是「看得見任務」的半截能力，反而引導角色去聊它。
    // 取消 / 改期工具（amsg-server 2.6.0-next.15 的 ctx.cancelTask / renewTask）。
    // 與排程同一道角色級閘；native tools 才注入——正文協議不教這兩個（排程那個教了
    // 是因為它是主鏈路，取消 / 改期在拒 tools 的中轉上寧缺勿濫，語法教多了模型會把
    // 工具名當敘述寫進正文）。
    const canManageTasks = canSelfSchedule && mcpNative
      && typeof ctx.cancelTask === 'function' && typeof ctx.renewTask === 'function';

    const baseTaskListBlock = selfScheduleAllowed
      ? buildFireTaskListBlock(livePendingTasks, {
        nowMs: ctx.now.getTime(),
        tzId: pack.tzId,
        excludeClientTaskId: clientTaskId || undefined,
      })
      : '';
    // 清單非空且工具在位時補一句「這些歸你管」——工具聲明模型看得到，但不點一句的話，
    // 它多半不會想到清單裡的條目是可以動的。
    const taskListBlock = baseTaskListBlock && canManageTasks
      ? `${baseTaskListBlock}\n（清單裡的任務歸你管：情況變了不該響的可以用 cancel_active_message 取消，只是要換時間的用 renew_active_message 改期，task_id 就是清單裡的短 id。）`
      : baseTaskListBlock;

    // 「外面的世界此刻什麼樣」：今日節日 + 實時天氣 + 熱搜，到點現拉現填。
    // 拉不到 / 超時都只是返回空串，那一段整個消失，這次觸發照常往下走。
    const realtimeWorldBlock = await buildRealtimeWorldBlock({
      toolConfig,
      timeAwarenessEnabled: toolPack.timeAwarenessEnabled,
      tzId: pack.tzId,
      nowMs: ctx.now.getTime(),
      globalRows,
      globalNamespace: AMSG_GLOBAL_NAMESPACE,
      writeState: ctx.writeState,
    });

    // MCP 說明塊 / 「給自己排下一條」說明塊：兩條路都要，只是掛的位置不同
    // （主動消息接在渲染好的 prompt 後面，即時對話拼進末尾追加的那個 system 塊）。
    const mcpBlock = mcpResolve
      ? buildMcpFireBlock(mcpResolve, { mode: mcpNative ? 'native' : 'text' })
      : '';
    // 跟 MCP 共用一個 native/text 判斷：用戶的中轉拒 tools 時兩邊都得改教正文協議，
    // 不然一邊聲明成 tools、一邊教語法，模型會兩種都寫一遍。
    // 時間上下文讓 send_at 的示例是「明天這個點」的裸牆鍾，別再教模型寫 offset。
    //
    // 塊尾接「用戶給你定的規矩」：還能再排幾條、最早排到幾點、今天還剩幾條。額度擺在它
    // 面前，比讓它排了再被打回省一輪；真超了照樣由排程工具打回。
    const limitsBrief = canSelfSchedule
      ? buildLimitsBrief({
        limits,
        committedSends: countCommittedSelfSends(stash),
        activeTasks: otherLiveTasks.length,
        earliestText: limits.minSendGapMs > 0
          ? formatFireTimeShort(earliestSlotAfter(
            nowMs + MIN_SCHEDULE_LEAD_MS, limits.minSendGapMs, selfScheduleBusyTimes(stash, nowMs)), tz)
          : undefined,
        // 正在發的這一條（定時觸發）發完就佔掉今天的一個名額。
        dailyRemaining: Number.isFinite(limits.dailySendCap)
          ? Math.max(0, limits.dailySendCap - sentToday - (replyLike ? 0 : 1))
          : undefined,
      })
      : '';
    const scheduleBlock = canSelfSchedule
      ? buildFireScheduleBlock(mcpNative ? 'native' : 'text', { nowMs: ctx.now.getTime(), tz, limitsBrief })
      : '';
    const abilities = { allowRecurring: limits.allowSelfRecurring, allowForce: limits.allowSelfForce };

    const fireTools = [
      ...(mcpResolve && mcpNative ? buildMcpFireTools(mcpResolve) : []),
      ...(canSelfSchedule && mcpNative
        ? [buildFireScheduleTool({ nowMs: ctx.now.getTime(), tz, abilities })]
        : []),
      ...(canManageTasks
        ? [buildFireCancelTool(), buildFireRenewTool({ nowMs: ctx.now.getTime(), tz })]
        : []),
    ];
    // 非 MCP 的聲明名單獨留一份給 onLLMOutput 認領 native 調用用（見 FireStash.fireToolNames）。
    stash.fireToolNames = new Set(fireTools
      .map((t) => t?.function?.name)
      .filter((n): n is string => typeof n === 'string' && !n.startsWith(MCP_FIRE_NAME_PREFIX)));
    // 輪次上限顯式給一份：worker 要靠同一個數判「這是最後一輪了」（見 onLLMOutput），
    // 而上游只有內部默認值、沒導出常量，各寫各的遲早對不上。
    // tools 由 amsg-server 帶 agentic-fire-tools feature 的版本起透傳給每輪 LLM 請求。
    const common = {
      maxToolIterations,
      ...(fireTools.length ? { tools: fireTools } : {}),
    };

    // 即時對話：請求消息就是客戶端本地生成會發出去的那一串，末尾追加一塊時效信息。
    // 不走模板渲染——那是「到點主動找人說話」的提示詞，拿它答用戶剛說的話必然跑偏。
    if (instant) {
      // 到點才知道的那些事（現在幾點、外面在下雨、還掛著哪些排程…）。一件都沒有時是空串，
      // 那就一條都不追加——空的系統消息掛在對話末尾只會讓模型以為話沒說完。
      const timelyBlock = buildInstantTimelyBlock({
        nowMs: ctx.now.getTime(),
        tz,
        userTzId: pack.userTzId,
        targetName: pack.targetName,
        timeAwarenessEnabled: toolPack.timeAwarenessEnabled,
        blocks: [
          realtimeWorldBlock,
          renderSelfLogBlock(selfLog, ctx.now.getTime(), tz, maxUnansweredSends),
          taskListBlock, mcpBlock, scheduleBlock,
        ],
      });
      const instantMessages = [
        // content 原樣透傳，一個字都不動：帶圖片的消息本地就是結構化分段
        // （`[{type:'text'},{type:'image_url'}]`），上游把這個數組整個丟進
        // /chat/completions 的請求體（amsg-shared 的 buildLlmRequestBody 只做
        // `messages: llmMessages`，不看 content 的類型）。這裡但凡 String() 一下，
        // 模型收到的就是「[object Object]」而不是那張圖。
        // 每條重新包一層對象只是不把 pack 上那份交出去，content 仍是同一個引用。
        ...pack.chat!.messages.map((m) => ({ role: m.role, content: m.content })),
        ...(timelyBlock ? [{ role: 'system' as const, content: timelyBlock }] : []),
      ];

      // 情緒評估（副 API）：跟主生成**並行**跑，等 onLLMOutput 收尾時 await——那時
      // 多半早就跑完了，等於零額外延遲。掛了返回 null，主回覆照發。
      //
      // 餵給它的是主生成看到的同一串消息（含末尾那塊時效信息）：客戶端打包的 chat 段
      // 裡已經沒有「現在幾點」了（那部分留給到點現填），只喂原串的話評估模型連時間都
      // 不知道，判出來的情緒跟角色剛說的話對不上。
      //
      // fire 重試（2/4/6 分鐘梯子）會整輪重跑到這裡。上一跳評估已經出了結果的話，
      // 失敗收尾（amsgFireSettled）把它寫在旁路鍵 amsgEmotionUpdateKey 下——重試跨
      // tick 唯一能帶過來的位置。讀到就直接包成 resolved promise 複用，別再白燒一次
      // 副 API；讀不到才起新評估。
      if (emotionEvalSpec) {
        const storedEvalRaw = clientTaskId
          ? charRows.find((r) => r.key === amsgEmotionUpdateKey(clientTaskId))?.value
          : undefined;
        // 副 API 憑據兩種來路：存量任務裡內聯的那份，或任務只帶引用、這裡現讀憑據表
        // （換 Key 之後不用回頭改任務，見 resolveEmotionEvalApi）。取不到就這一輪不評估，
        // 主回覆照發——評估從來不連累正文。
        // 取憑據是異步的，包在一個 promise 裡保持「與主生成並行起跑」這件事不變。
        stash.emotionEvalPromise = storedEvalRaw
          ? Promise.resolve({ raw: storedEvalRaw, error: null })
          : (async () => {
            const evalApi = await resolveEmotionEvalApi(
              emotionEvalSpec, ctx.task.credRefs, ctx.resolveLlmCredential,
            );
            if (!evalApi) {
              console.warn('[amsg:emotion] 這一輪取不到副 API 憑據，跳過評估');
              return { raw: null, error: '雲端沒有可用的情緒評估 API 憑據' };
            }
            return runAmsgEmotionEval(
              emotionEvalSpec, evalApi, instantMessages,
              toolPack.charName || ctx.task.contactName || '角色',
            );
          })();
      }

      return {
        messages: instantMessages,
        ...common,
        // 用戶正盯著「正在輸入…」等回覆，給足時間把工具循環跑完，別讓他重發一遍。
        totalTimeoutMs: INSTANT_TOTAL_TIMEOUT_MS,
      };
    }

    // fire_pack v3：「本次任務」指令隨任務 metadata 走，這裡填槽。
    // MCP 塊拼在渲染好的 prompt 之後（同一條 user 消息）。
    const prompt = renderFirePack(pack, ctx.now.getTime(), taskMeta.amsgTaskInstruction as string, {
      maxUnansweredSends,
      selfLog,
      taskListBlock,
      realtimeWorldBlock,
      // 「此刻在做什麼」裡的鐘點跟今日節日同一個開關：關掉時間感知的角色不該從日程塊
      // 讀到「23:00」——那正是這個開關要擋的東西。日程內容本身照給。
      includeClock: toolPack.timeAwarenessEnabled,
    }) + mcpBlock + scheduleBlock;
    return {
      messages: [{ role: 'user' as const, content: prompt }],
      ...common,
    };
  },

  async onLLMOutput(ctx: SessionCtx) {
    // 非聊天任務在這裡就被接走，排在下面所有聊天語義（stash、分段、self_log、推送）
    // 之前——它們一條都不適用，而 stash 那道斷言更是會直接把這一輪判死。
    const kindFire = getKindFireStash(ctx.scratch);
    if (kindFire) {
      const handler = FIRE_KIND_HANDLERS[kindFire.kind];
      if (!handler) {
        // 到點那一步查過表才會掛上 stash，走到這裡表裡不該沒有。
        throw new Error(`AMSG2_KIND_HANDLER_MISSING: onLLMOutput 找不到 ${kindFire.kind} 的 handler`);
      }
      return handler.llmOutput({ ctx, state: kindFire.state });
    }

    const content = stripReasoningTags(ctx.llmOutputText || '').trim();

    // 任務身份直接從 ctx 上讀（sessionId 是給日誌和去重用的不透明串，不拿它切）。
    const taskId = ctx.taskId != null ? String(ctx.taskId) : null;
    if (taskId == null) {
      // 沒有任務行的路徑（in-server instant）才該是 null。定時任務走到這裡說明上游沒
      // 給身份，而後果是靜默的：送達消息的 metadata.activeMsg2.taskId 會是 null →
      // 客戶端 hasDeliveredProactiveNear 判定「這次沒送達過」→ 排程現狀塊給角色注入
      // 一條假的「已作廢」回執，角色可能把已經發出去的事又當沒發生。留個日誌。
      console.warn('[amsg:agentic] ctx 上沒有 taskId，送達歸屬會失效', ctx.sessionId);
    }
    const messageType = typeof ctx.metadata?.amsgMode === 'string' ? ctx.metadata.amsgMode : 'auto';

    // onBeforeFire 要麼拋錯、要麼 skip、要麼在返回 messages 之前把 stash 掛上，所以
    // 走到這裡 stash 必然存在（庫保證 fireCtx.scratch 與每輪 sessionCtx.scratch 同引用）。
    // 真缺了就是這個前提被打破（比如庫不再共享 scratch）——響亮地失敗，別靜默丟旁白。
    const stash = getFireStash(ctx.scratch);
    if (!stash) {
      throw new Error('AMSG2_FIRE_STASH_MISSING: onLLMOutput 讀不到 ctx.scratch.fire，檢查 amsg-server 是否仍共享 scratch');
    }
    const session = stash.session;

    // 思考鏈兩個來源：響應字段 + 正文內聯 <think>。抄的是沒 strip 過的原文
    // （上面那個 content 是剝完的）。字段名認三個，跟本地路徑一樣寬
    // （見 utils/safeApi.ts）：reasoning_content 是 deepseek-r1 / GLM 那批的寫法，
    // OpenRouter 轉出來叫 reasoning，還有渠道寫 thinking——只認一個就會靜默沒有卡片。
    // 不復用上游的 readReasoningContent：它是「原生**或**第一個內聯塊」，這裡要的是
    // 「原生**加**全部內聯塊」，跟客戶端渲染的那份對齊。
    //
    // 每輪**覆蓋**（包括覆蓋成空）：留下的必須是產出正文那一輪的思考。中間輪那句
    // 「我先去查一下」跟用戶看到的正文對不上，最後一輪沒思考時也不能拿它頂上。
    //
    // 包裝層不主動開 thinking 參數——該不該開由客戶端定：本地那一輪會發的三件套
    // （thinking / reasoning_effort / extra_body）隨 taskPayload 頂層 llmExtraBody
    // 上雲（含 Gemini 讓步在內的判定都在 useChatAI 的 shouldSendThinkingParams），
    // 由上游 buildLlmRequestBody 展開進請求體；上游沒認領這個字段時退化為只有
    // -thinking 模型名後綴生效。這裡替客戶端多開一份的話，Gemini 系 thinking + tools
    // 同發直接 400。
    const llmMessage = (ctx.llmResponse as {
      choices?: Array<{ message?: Record<string, unknown> }>;
    })?.choices?.[0]?.message;
    const nativeReasoning = llmMessage?.reasoning_content ?? llmMessage?.reasoning ?? llmMessage?.thinking;
    const roundReasoning = [nativeReasoning, extractInlineThink(ctx.llmOutputText || '')]
      .filter((s): s is string => typeof s === 'string' && !!s.trim())
      .map((s) => s.trim())
      .join('\n\n');
    session.finalReasoning = roundReasoning || null;

    // native tool_calls：只認聲明過的工具（fireToolNames 的管理工具 + mcpResolve 的
    // MCP 名），但認法放寬——模型常把聲明名的「姓」搞丟或換家：聲明的 mcp__foo 回報成
    // foo / default_api:foo，cancel_active_message 也在此列。嚴格命中優先，對不上再
    // 去掉命名空間取裸名、唯一命中才認領（見 classifyNativeToolCalls，認領時名字改寫
    // 回聲明名）。真幻覺的（哪份清單都對不上）照舊丟棄並留日誌——直接透傳會讓
    // executeToolCalls 撞上沒有 stash 映射的名字。日誌帶上當時聲明了哪些，
    // 「模型編的」和「名字映射建歪了」一眼能分開。
    const rawToolCalls = (ctx.llmResponse as { choices?: Array<{ message?: { tool_calls?: unknown } }> })
      ?.choices?.[0]?.message?.tool_calls;
    const nativeCalls = classifyNativeToolCalls(rawToolCalls, stash.fireToolNames, stash.mcpResolve);
    for (const droppedName of nativeCalls.dropped) {
      console.warn('[amsg:agentic] 丟棄未聲明的 native tool_call', {
        sessionId: ctx.sessionId,
        name: droppedName,
        declared: [...stash.fireToolNames, ...(stash.mcpResolve?.keys() ?? [])],
      });
    }

    let decision = processLLMRound(session, content, {
      // 名字取 tool_pack 裡的那份：它跟著每輪聊天重新上雲，改名當天就是新的。
      // ctx.contactName 是排程那一刻凍進任務行的快照，用戶改完名字之後，之前排的
      // 任務推送出來橫幅還頂著舊名字（上游 update-message 也不讓改這個字段）。
      // tool_pack 裡沒名字時退回任務行那份，別讓標題變成「來自 」。
      contactName: stash.toolCtx.char.name || ctx.contactName,
      avatarUrl: ctx.avatarUrl ?? null,
      taskId,
      messageType,
      // 摘掉評估配置再交出去：它裡頭是用戶副 API 的 apiKey，而 metadata 會被整個
      // 攤進每條 push 的 payload（見 agentic 的 buildScheduledPush）。見 stripEmotionEvalSpec。
      metadata: stripEmotionEvalSpec(ctx.metadata),
      occurrenceMs: stash.occurrenceMs,
      // round 1 XHS 工具抓到的筆記 / xsecToken 快照：finish 時按 directive 引用
      // 挑選後隨最後一條 push 帶回客戶端（客戶端離線跑不了 round 1，缺這份
      // [[XHS_SHARE]] / 點贊 / 評論重放必然 available:0 掉卡片）。
      xhsNotes: stash.toolCtx.lastXhsNotesRef?.current,
      xhsXsecTokens: stash.toolCtx.xhsCaches
        ? Array.from(stash.toolCtx.xhsCaches.xsecTokenCache.entries())
        : undefined,
      // 角色寫了 MUSIC_ACTION 的話，把它讀到的那首歌一起帶給客戶端：標籤裡只有歌單名，
      // 沒有這一份的話客戶端只能拿「用戶此刻在聽的那首」湊（補收時多半是空的）。
      sceneSong: stash.sceneSong,
    },
    stash.mcpResolve ? { resolve: stash.mcpResolve, nativeToolCalls: nativeCalls.mcp } : null,
    // 傳 null = 這次不認排程（老部署沒這口子），正文裡寫了也不當調用。
    // manage 池裡可能還有 cancel / renew——它們被認領的前提是聲明過（canManageTasks），
    // 而 canManageTasks ⊆ canSelfSchedule ⊆「scheduleTask 是函數」，這道閘不會誤攔。
    typeof ctx.scheduleTask === 'function' ? { nativeToolCalls: nativeCalls.manage } : null,
    // 最後一輪不再放行工具請求，改成用手上的內容收尾（預算由 MCP 與否自適應）。
    ctx.iteration,
    stash.maxToolIterations);

    if (decision.decision === 'tool-request') {
      console.log('[amsg:agentic]', {
        type: 'tool_request',
        sessionId: ctx.sessionId,
        tools: decision.toolCalls.map((tc) => tc.function.name),
      });
    } else {
      // finish / skip-push：這次 fire 到頭，scratch 隨調用棧丟棄，無需手動回收。
      console.log('[amsg:agentic]', {
        type: decision.decision,
        sessionId: ctx.sessionId,
        pushes: decision.decision === 'finish' ? decision.pushPayloads.length : 0,
      });
    }

    if (decision.decision === 'skip-push') {
      // 先把模型這輪回了個什麼記一行：last_skip 只有一個 reason，分不清是 content 為 null、
      // 正文全在思考塊裡、被截斷，還是中轉站把報錯包在了 200 裡（見 ./skipDiagnostics）。
      logSkipDiagnostic({
        sessionId: ctx.sessionId,
        reason: decision.reason,
        iteration: ctx.iteration,
        llmResponse: ctx.llmResponse,
        llmOutputText: ctx.llmOutputText,
      });
      // 這一輪沒有正文，所以整條不發；但角色順手改的日程要送到客戶端去，不然它下一次
      // 讀到的還是那條舊安排（見 agentic.ts 裡 skip-push 那處註釋）。走 emitResult：
      // 落服務端收件箱，客戶端下次拉 outbox 一定拿得到，不用為它硬發一條空推送。
      //
      // 老部署上 emitResult 整個方法不存在（amsg-server 2.6.0-next.21 才有），那種情況
      // 只留一行日誌——沒有這條通道時，丟掉仍然比發一條空白橫幅強。
      if (decision.scheduleChanges?.length) {
        if (typeof ctx.emitResult === 'function') {
          try {
            await ctx.emitResult({
              ...buildScheduleChangeResult({
                charId: stash.charId,
                // 說出口的時刻用真實的此刻：模型剛照著本次 fire 的那個鍾寫完這批改動，
                // 客戶端也該照著同一個鍾判「隔天了沒有」。名義時刻 occurrenceMs 在這裡
                // 不能用——cron 延遲或者重試梯子把 23:50 的任務拖到 00:05 才跑時，兩者
                // 會分處兩個日曆日，整批改動會被客戶端的隔天閘白白丟掉。取值跟同一段裡的
                // skippedAt、以及 self_log 的 entry.at 一致（fire ctx 上那個 now 只在
                // onBeforeFire 裡拿得到，每輪的 sessionCtx 沒有這個字段）。
                spokenAt: Date.now(),
                directives: decision.scheduleChanges,
              }),
              // 角色一個字都沒說，這一輪本來就不該驚動用戶。show:false 的 payload 上游
              // 只落收件箱、不發推送——既不會彈出一條空白橫幅，也不佔推送配額（訂閱是
              // 按 userVisibleOnly 建的，收了不彈瀏覽器要記帳）。
              notification: { show: false },
            });
          } catch (error) {
            console.warn('[amsg:schedule-change] 日程改動沒能送出去（這一輪的改動丟了）', error);
          }
        } else {
          console.warn('[amsg:schedule-change] 這台 Worker 還沒有 emitResult，日程改動沒處送', {
            sessionId: ctx.sessionId,
            changes: decision.scheduleChanges.length,
          });
        }
      }
      // ⑤ 沒發出去也留痕：模型返回空/純拒答、或者只做了副作用沒說話時，上游把任務
      // 當成功消費，用戶看到的就是「說好的消息憑空消失」。寫一條 last_skip，面板能
      // 照實解釋是哪種。best-effort，寫不進去不影響 skip 本身。
      await writeLastSkip(ctx.writeState, stash.charId, {
        v: 1,
        taskUuid: stash.taskUuid,
        occurrenceMs: stash.occurrenceMs,
        reason: decision.reason,
        skippedAt: Date.now(),
      });
      // 即時對話被 skip：一次性行會被上游當成功消費刪掉，客戶端點名只能看到「行沒了、
      // outbox 也空」，落下的說明是「回覆沒能取回」——把「沒生成出來」說成了「取不回」。
      // 也寫一份 chat_fail（認 uuid），客戶端 gone 分支讀回後能照實說「模型這輪沒說話」。
      if (stash.instant && stash.taskUuid && ctx.writeState) {
        await writeChatFail(ctx.writeState, stash.charId, {
          uuid: stash.taskUuid,
          reason: decision.reason,
          retryCount: 0,
        });
        // skip 一錘定音（行不會再跑）→ 直發失敗通知，等待當場收尾，不用乾等 60s 點名。
        await sendInstantErrorPush({
          charId: stash.charId,
          taskUuid: stash.taskUuid,
          reason: decision.reason,
          contactName: ctx.contactName ?? null,
        });
      }
    }

    if (decision.decision === 'finish') {
      // 「我這次說了什麼」不在這裡寫庫（這裡還沒發出去），只把各段正文掛到本次 fire 的
      // scratch 上，等 onAfterSend 按真正送出去的段數落盤。
      stash.selfLogTexts = decision.pushPayloads.map(
        (p) => (typeof p.message === 'string' ? p.message : ''));

      // 角色這次給自己排的任務，隨最後一條 push 帶回客戶端認領——不然它們只活在 D1 裡，
      // 面板看不到、用戶也沒法取消。任務本身照常觸發，客戶端上線補進清單即可。
      let payloads = attachScheduledTasks(decision.pushPayloads, stash.scheduledTasks);

      // 往指定那一條 push 的 metadata 上追加字段（其餘條原樣）。下面三處掛載共用：
      // 展開順序固定「舊 metadata 在前、新字段在後」，鍵衝突時新值贏。
      const attachMetaAt = (
        list: typeof payloads, idx: number, extra: Record<string, unknown>,
      ): typeof payloads => list.map((payload, i) => (i === idx
        ? { ...payload, metadata: { ...(payload.metadata as Record<string, unknown> ?? {}), ...extra } }
        : payload));

      // 本輪取消 / 改期掉的既有任務同樣隨最後一條回去消帳（與排程認領對稱：那邊是
      // 「D1 多了一行，本地補上」，這邊是「D1 那行沒了 / 換時間了，本地跟上」）。
      const cancelled = stash.cancelledTasks;
      const renewed = stash.renewedTasks;
      if ((cancelled.length > 0 || renewed.length > 0) && payloads.length > 0) {
        payloads = attachMetaAt(payloads, payloads.length - 1, {
          amsgTaskMutations: {
            ...(cancelled.length > 0 ? { cancelled } : {}),
            ...(renewed.length > 0 ? { renewed } : {}),
          },
        });
      }

      // 這次生成的思考鏈隨**第一條** push 回客戶端：思考鏈卡片渲染在第一條氣泡上，
      // 收側也只在 messageIndex<=1 那條上認領（見 utils/activeMsgRuntime.ts）。
      // 同樣排在旁路存儲之前，裝不下時才能連它一起挪走。
      //
      // 只在即時對話這條路回傳。那一輪的 prompt 裡帶著「心象」提示詞（客戶端
      // buildThinkingChainPrompt 打進 fire_pack 的 chat 段），模型的 thinking 寫出來是
      // 角色腦內的嘟囔，當卡片正合適。定時任務這條路的 prompt 是 renderFirePack 現拼的，
      // 沒有那段提示詞，thinking 就是原始推理腔（「用戶三小時沒說話了，我應該……」）——
      // 那個放進心象卡片就是穿幫。等哪天給 fire_pack 也注入那段提示詞，再把這道門放開。
      if (stash.instant && session.finalReasoning && payloads.length > 0) {
        payloads = attachMetaAt(payloads, 0, { amsgReasoning: session.finalReasoning });
      }

      // 末條 push 的掛載合成一次：工具痕跡 + 情緒評估結果都跟正文一起收尾。
      //
      // 工具痕跡：氣泡底下那行灰字照它渲染。掛最後一條是因為用戶讀完話才看到
      // 「哦，這是查過的」；掛第一條就成了還沒開口先報備一句「我搜了網頁」。
      // 只在即時對話這條路回傳。定時任務的氣泡是憑空冒出來的（用戶沒在等這一輪），底下
      // 再掛一行「調用了工具」等於把後台實現攤開給用戶看，跟主動消息要的那點不著痕跡相沖。
      //
      // 情緒評估（客戶端拿 applyEmotionEvalRaw 落 buff，與本地路徑共用同一套解析）：
      // 評估是 onBeforeFire 就起跑的，跟主生成並行，走到這裡多半早跑完了。**最多再等
      // EMOTION_EVAL_RIDE_ALONG_MS**，等不到就不搭這班車（見那個常量的註釋）。評估掛了
      // 或沒趕上都要掛一個 amsgEmotionDone——客戶端從按下發送那一刻就點著「情緒更新中」，
      // 只在有結果時才帶信號的話，評估一失敗那盞燈就得亮到十幾分鍾後才由安全網熄。
      // 掛了還捎一句短原因（amsgEmotionError），原因裡絕不含憑據（見 describeEvalFailure）。
      //
      // 兩樣都排在旁路存儲之前，裝不下時才能連它們一起挪走。
      if (stash.instant && payloads.length > 0) {
        const lastMeta: Record<string, unknown> = {};
        const toolTrace = condenseToolTrace(session.toolCalls);
        if (toolTrace.length > 0) lastMeta.amsgToolTrace = toolTrace;
        // 最後一輪的 token 用量（amsg-server 2.6.0-next.15 起 sessionCtx 帶 usage，
        // 來源是供應商響應體的 usage 字段）。只挑三個數、不透傳原對象——各家供應商
        // 往 usage 裡塞的私有字段（緩存命中、思考 token 明細…）沒必要跟著每條 push 走。
        // 客戶端暫時只存不顯示，將來做用量角標不用再動 worker。
        const usage = (ctx as { usage?: Record<string, unknown> | null }).usage;
        if (usage && typeof usage === 'object') {
          const pick = (key: string): number | undefined =>
            typeof usage[key] === 'number' ? usage[key] as number : undefined;
          const promptTokens = pick('prompt_tokens');
          const completionTokens = pick('completion_tokens');
          if (promptTokens !== undefined || completionTokens !== undefined) {
            lastMeta.amsgUsage = {
              ...(promptTokens !== undefined ? { promptTokens } : {}),
              ...(completionTokens !== undefined ? { completionTokens } : {}),
            };
          }
        }
        if (stash.emotionEvalPromise) {
          const outcome = await raceEmotionEval(stash.emotionEvalPromise);
          if (outcome === null) {
            // 沒趕上順風車：不作廢也不熄燈。掛引用鍵 + pending 標記，收尾 hook
            // （amsgFireSettled）等評估出結果寫進旁路，客戶端對著引用鍵輪詢補落。
            // clientTaskId 缺失時旁路無處可寫（存儲鍵按它編），退回「這一輪不更新」。
            if (stash.clientTaskId) {
              lastMeta.amsgEmotionRef = amsgEmotionUpdateKey(stash.clientTaskId);
              lastMeta.amsgEmotionPending = true;
              stash.emotionLatePending = true;
            } else {
              lastMeta.amsgEmotionDone = true;
              lastMeta.amsgEmotionError = EMOTION_EVAL_LATE_REASON;
            }
          } else {
            lastMeta.amsgEmotionDone = true;
            if (outcome.raw) lastMeta.amsgEmotionUpdate = outcome.raw;
            else if (outcome.error) lastMeta.amsgEmotionError = outcome.error;
          }
        }
        if (Object.keys(lastMeta).length > 0) {
          payloads = attachMetaAt(payloads, payloads.length - 1, lastMeta);
        }
      }

      // 發之前按真實字節預算過一遍：裝不下的大塊數據旁路存起來，push 只留引用鍵。
      // clientTaskId 當存儲鍵（每任務一份、下次觸發覆蓋），缺了就沒法旁路——那時超限會
      // 由庫拋 PUSH_PAYLOAD_TOO_LARGE，照樣不會靜默丟消息。缺了照樣走一趟，是為了讓
      // offloadOversizedPush 把「為什麼沒法旁路」吼出來，別只留一個光禿禿的超限錯。
      if (stash.charId) {
        const budgeted = [];
        for (const payload of payloads) {
          budgeted.push(await offloadOversizedPush(
            payload, ctx.writeState, stash.charId, stash.clientTaskId));
        }
        payloads = budgeted;
      }

      // 即時對話的通知策略：一定彈，按角色摺疊成一條，前台安靜、後台響鈴，一輪只響
      // 一聲（見 applyInstantNotificationPolicy）。第一段要重新提醒、後面幾段安靜
      // 更新，所以策略要知道自己是這一輪的第幾段。收件兜底不在這裡做——庫自己會在
      // 每條推送發出去之前記進服務端帳本，客戶端按帳本補收。
      if (stash.instant) {
        payloads = payloads.map((payload, index) =>
          applyInstantNotificationPolicy(payload, stash.charId, index === 0));
      }

      return { ...decision, pushPayloads: payloads };
    }

    return decision;
  },

  /**
   * 服務端工具執行：客戶端在 fire 時刻離線，數據工具全部在 worker 內跑完。
   * 單個工具失敗（含拋錯）都以失敗 JSON 回填給 LLM 讓它圓場，不失敗整條鏈。
   */
  async executeToolCalls(
    toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>,
    ctx: SessionCtx,
  ) {
    const stash = getFireStash(ctx.scratch);
    if (!stash) {
      throw new Error('AMSG2_FIRE_STASH_MISSING: executeToolCalls 讀不到 ctx.scratch.fire，檢查 amsg-server 是否仍共享 scratch');
    }
    // 搜索/Notion/飛書經代理 worker 轉發；地址來自前端同步的 tool_config。XHS Lite cookie 同拍注入。
    //
    // 這兩個注入寫的是 isolate 級全局，而庫到點最多併發跑 8 個任務（MAX_CONCURRENT=8）。
    // 現在安全的前提是：兩個值都來自全局 namespace 的 tool_config，所有角色同一份，
    // 併發寫的是同一個值。缺值時不覆蓋——tool_config 瞬時讀失敗的那個 fire 不該把併發中
    // 另一個 fire 已經注入好的值清成空。
    //
    // TODO(按角色配憑據)：應用層目前不支持（realtimeConfig 是全局單份，按角色的只有
    // char.xhsEnabled 這個開關）。哪天憑據改成按角色配，這裡必須改成顯式傳參——否則
    // 同一分鐘併發的兩個角色會互相串憑據，而且不會報錯。
    if (stash.proxyWorkerUrl) setProxyWorkerUrlOverride(stash.proxyWorkerUrl);
    if (stash.xhsCookie) XhsMcpClient.setCookie(stash.xhsCookie);

    const results = [];
    for (const toolCall of toolCalls) {
      const name = toolCall?.function?.name || '';
      let content: string;
      try {
        const args = toolCall?.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};
        const fingerprint = toolCallFingerprint(name, args);

        // 同名同參第二次直接打回，一次請求都不發。軟提示（下面那段回喂）擋不住時靠它兜底：
        // 轉滿上限會拋 AGENTIC_LOOP_EXCEEDED，任務不出清、下一分鐘整條從頭重跑，代價遠大於
        // 少查一次。只攔完全一樣的調用——換月份、換關鍵詞照常放行，多輪能力不受影響。
        // 只攔「連續原地重複」。遊戲型 MCP 的正常流程會是 get_state({}) → act(...)
        // → get_state({})；舊邏輯掃描整段歷史，把第二次狀態查詢也當重複，角色永遠看不到
        // 動作後的新狀態。中間只要有別的有效調用，就允許同名同參再次執行。
        const previousCall = stash.session.toolCalls[stash.session.toolCalls.length - 1];
        if (previousCall?.fingerprint === fingerprint) {
          // 計數交給 processLLMRound：連著重複到閾值就直接收尾，不陪它轉到輪次上限
          // （上限一到整條任務失敗重跑，用戶一個字都收不到）。
          stash.session.duplicateToolCalls += 1;
          console.log('[amsg:agentic]', {
            type: 'tool_duplicate',
            sessionId: ctx.sessionId,
            tool: name,
            count: stash.session.duplicateToolCalls,
          });
          results.push({
            tool_call_id: toolCall.id,
            role: 'tool' as const,
            content: buildDuplicateToolMessage(name),
          });
          continue;
        }

        // 三條去處，失敗語義一致（都回 ok:false，不拋），回喂 / 記帳 / 日誌共用下面這段：
        //   排程 → 在 D1 裡建下一條任務；MCP → 直連用戶配的服務器；其餘 → 內置數據工具。
        const result = name === AMSG_FIRE_SCHEDULE_TOOL
          ? await runFireScheduleTool(stash, ctx.scheduleTask, args, Date.now())
          : name === AMSG_FIRE_CANCEL_TOOL
            ? await runFireCancelTool(stash, ctx.cancelTask, args, Date.now())
            : name === AMSG_FIRE_RENEW_TOOL
              ? await runFireRenewTool(stash, ctx, args, Date.now())
              : name.startsWith(MCP_FIRE_NAME_PREFIX)
                ? await runMcpFireTool(stash, name, args)
                : await dispatchAgenticTool(name, args, stash.toolCtx);
        // duplicateToolCalls 語義是「連續打轉」；任何一個新調用跑過都說明任務仍在推進，
        // 立刻清零。否則兩次不相鄰的合法重複也會累計到閾值，提前誤殺遊戲流程。
        stash.session.duplicateToolCalls = 0;
        // ran 記的是「這次值不值得寫進工具痕跡」：查東西的看有沒有真去查，改排程的看有沒有
        // 真改成（見 toolDidSomething）。回餵給模型的措辭另有一套口徑（buildToolResultMessage
        // 裡的 neverRan），兩者不共用——痕跡是給用戶看的，只說真發生過的事。
        stash.session.toolCalls.push({ name, fingerprint, ran: toolDidSomething(name, result) });
        // 不再回裸 JSON：模型從裸 JSON 裡看不出「這一步已經做完了」，提示詞裡但凡有一句
        // 常駐的「先去查 X」就會每輪照做。這段話跟前台說的是同一套（見 agenticToolFeedback）。
        content = buildToolResultMessage({ name, result, history: stash.session.toolCalls });
        console.log('[amsg:agentic]', { type: 'tool_done', sessionId: ctx.sessionId, tool: name });
      } catch (error) {
        content = JSON.stringify({
          ok: false,
          reason: 'tool_error',
          message: error instanceof Error ? error.message : String(error),
        });
        console.warn('[amsg:agentic]', { type: 'tool_failed', sessionId: ctx.sessionId, tool: name, error: String(error) });
      }
      results.push({ tool_call_id: toolCall.id, role: 'tool' as const, content });
    }

    // 只掛在最後一條 tool 消息末尾（離模型下一次輸出最近），不逐條重複刷屏。
    if (feedsFinalRound(ctx.iteration, stash.maxToolIterations) && results.length > 0) {
      const last = results[results.length - 1];
      last.content = `${last.content}\n${FINAL_ROUND_NOTICE}`;
    }
    return results;
  },
};

/**
 * VAPID JWT 的 sub 字段：推送服務只要求它是個合法的 mailto: / https: 聯繫方式，
 * 內容不參與簽名校驗。但 scheduled() 一旦發現 email 為空就會整輪 return（一條任務
 * 都不處理、前端毫無提示），而「推送憑據」面板複製出來的 env 裡 VAPID_EMAIL 是註釋
 * 掉的可選項——照著部署必然缺它。所以這裡給個缺省值兜底，配了就用用戶配的。
 */
export const resolveVapidEmail = (raw: string | undefined): string =>
  raw?.trim() || 'mailto:noreply@sullyos.app';

/** worker 運行配置；導出便於單測釘住 VAPID 兜底。 */
export const buildWorkerConfig = (env: Env) => {
  // vapid 與 webpush 必須同源同一份：兩處各讀一次 env 時，改了一處漏另一處
  // 會變成「簽名用兜底、校驗用空值」這類只在真發推送時才暴露的坑。
  const vapid = {
    email: resolveVapidEmail(env.VAPID_EMAIL),
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };
  const nativeFcmReady = isFcmConfigured(env);
  // 上游在進入發送器前會檢查 VAPID 字段非空；純 FCM 部署用內部佔位值通過該檢查。
  // 普通 Web Push endpoint 仍只會走真實 VAPID，沒配真實值時配置自檢會明確提示。
  const effectiveVapid = nativeFcmReady && (!vapid.publicKey?.trim() || !vapid.privateKey?.trim())
    ? { email: vapid.email, publicKey: 'native-fcm', privateKey: 'native-fcm' }
    : vapid;
  const webpush = createHybridPushTransport(env, createWebCryptoWebPush(effectiveVapid));
  // 即時對話終態失敗的直發通道拿同一份 transport（見 sendInstantErrorPush）。
  configureInstantErrorPush(env.DB && env.AMSG_MASTER_KEY
    ? { webpush, db: env.DB as unknown as InstantErrorPushDeps['db'], masterKey: env.AMSG_MASTER_KEY }
    : null);
  // 跳過診斷要不要帶原文片段，跟著面板上那個變量走（見 ./skipDiagnostics）。
  configureSkipDiagnostics({ rawExcerpt: isDebugFlagOn(env.AMSG_DEBUG_LLM_RAW) });
  return {
    // db 缺省時 factory 自動用 createD1Adapter(env.DB)
    masterKey: env.AMSG_MASTER_KEY,
    serverToken: env.AMSG_SERVER_TOKEN,
    vapid: effectiveVapid,
    webpush,
    // 前端和 Worker 不同源，帶自定義頭的請求會先發 CORS 預檢，必須放行。
    // 單用戶自用默認全開；想收緊就把 '*' 換成自己的 SullyOS 站點 origin。
    // allowHeaders 顯式給：上游默認那份不含 Content-Encoding，而 gzip 上行要用它
    // （見 CORS_ALLOW_HEADERS 那段註釋）。
    cors: { origin: '*', allowHeaders: CORS_ALLOW_HEADERS },
    // 一次性 job 輸入的過期清理（amsg-server 2.6.0-next.21+）：cron 每跳順手把這個
    // 命名空間下超過天數沒更新的條目清掉。角色狀態那個命名空間（amsg:char:<id>，
    // 裝 fire_pack / tool_pack）不配 TTL——那些是要長期留著的，配了就等於定時把
    // 角色的雲端狀態抹掉。判據是行本來就有的 updated_at 列，不加列、不動表結構。
    clientStateTtl: { [AMSG_JOB_NAMESPACE]: AMSG_JOB_TTL_DAYS },
    // 滿血 fire-time hooks（onBeforeFire 現場填槽 + onLLMOutput 分類 +
    // executeToolCalls 服務端工具循環）；總超時用庫默認 240s，輪數由 onBeforeFire 按
    // 是否接入 MCP 返回 5 / 12；即時對話再把總超時抬到 INSTANT_TOTAL_TIMEOUT_MS。
    hooks: amsgHooks,
    // 租約不再顯式配：amsg-server 2.6.0-next.15 起投遞期間按心跳滾動續租（30s 一跳、
    // 90s TTL），fire 跑多久租約就滾多久——以前為了蓋住即時對話 600s 的 fire 把
    // claimLeaseMs 定格在 12 分鐘，代價是 isolate 中途死掉後任務要乾等 12 分鐘才被
    // 下一跳接手；心跳租約把這個恢復窗壓到 ~90s，還不用管單條超時抬到多高。
    // 收尾回執 + 過期跳過回執（config 級 hook）。
    // onFireSettled: 無論這次 fire 是發出去了、跳過了還是拋錯了都會調一次，self_log
    //   在這裡統一落盤（見 amsgFireSettled）。不用 onAfterSend——它只在真發出去那條路
    //   觸發，角色自排任務碰上「只做了副作用沒說話」就會漏帳變成幽靈任務。
    // onStaleSkip: 過期不補發時給面板留一句「為什麼沒響」（見 amsgStaleSkip）。
    onFireSettled: amsgFireSettled,
    onStaleSkip: amsgStaleSkip,
    // 同一個角色的多條任務不併發跑：兩條撞在一起時用戶會收到兩條互不知情的消息，
    // 而且 self_log 是讀-改-寫整份，後寫的會蓋掉先寫的那條「我說過什麼」。分組鍵取
    // 角色 id，上游按它同跳去重 + 跨跳看租約，被攔下的任務一個字段都不動，下一跳原樣再來。
    //
    // 後台任務（門牌整理這類）按種類另開一組：上面那兩條串行的理由它一條都不沾——不說話、
    // 也不寫 self_log（它在 onBeforeFire 就被 kind 分派接走了）。跟聊天擠同一組的話，一次
    // 門牌整理最長佔住這個角色 120 秒，而它恰恰是在一輪對話剛結束時起跑的：用戶下一句話
    // 的即時對話任務排在它後面，人就乾等著「正在輸入…」。同種後台任務之間仍按角色串行
    // ——同一角色兩份整理併發落地，就是拿兩份舊快照互相蓋。
    serializeBy: amsgSerializeKey,
  };
};

/**
 * 分組串行的鍵（見 buildWorkerConfig 裡 serializeBy 那段）。單拎出來是因為定時任務細帳
 * 也要用同一個函數認「這兩條是不是同一組」：各寫一份的話，哪天分組規則改了一邊，
 * 細帳就會把正常排隊的任務報成卡住。
 */
export const amsgSerializeKey = (task: { metadata?: Record<string, unknown> | null }): string | null => {
  const charId = typeof task.metadata?.charId === 'string' ? task.metadata.charId : null;
  if (!charId) return null;
  const kind = readTaskKind(task.metadata);
  return kind ? `${charId}#${kind}` : charId;
};

/** 環境自檢的結論。missing 為空就能正常幹活，warnings 是「能跑但有一塊是啞的」。 */
export interface WorkerEnvReport {
  ok: boolean;
  /** 缺失項的變量名，`DB` 指 D1 綁定。給機器讀的。 */
  missing: string[];
  /** 給人讀的整句，含「去哪兒補」，前端直接顯示。 */
  message: string;
  warnings: { code: string; message: string }[];
}

/** 缺了就一個請求都處理不了的兩樣東西，各自帶一句「去哪兒補」。 */
const REQUIRED_ENV = [
  {
    key: 'DB',
    label: 'D1 數據庫綁定',
    // D1 綁定不在 Variables and Secrets 那一欄，指錯地方比不指還費時間。
    how: '在 Settings → Bindings 里加一條 D1 database，變量名填 DB',
    isMissing: (env: Env) =>
      typeof (env.DB as { prepare?: unknown } | null | undefined)?.prepare !== 'function',
  },
  {
    key: 'AMSG_MASTER_KEY',
    label: 'AMSG_MASTER_KEY',
    how: '在 Settings → Variables and Secrets 里加，類型選 Secret',
    isMissing: (env: Env) => !env.AMSG_MASTER_KEY?.trim(),
  },
] as const;

/**
 * 進上游庫之前先看一眼 env 齊不齊。
 *
 * 存在的理由：這兩樣缺任何一樣，上游都是在建配置那一步拋異常，被它的全局 catch
 * 吞成一句「服務器內部錯誤」，而那個響應還不帶 CORS 頭——瀏覽器於是連這句話都不
 * 讓前端讀，控制台只剩一個 "Failed to fetch"。用戶拿著它既分不清是 D1 沒綁還是
 * 密鑰沒配，也分不清是不是自己網斷了。所以缺什麼在這兒就說什麼。
 */
export const inspectWorkerEnv = (env: Env): WorkerEnvReport => {
  const absent = REQUIRED_ENV.filter((item) => item.isMissing(env));
  const warnings: WorkerEnvReport['warnings'] = [];

  // 上游把 masterKey 當普通字符串做 SHA-256（deriveUserEncryptionKey），長度不對
  // 照樣跑得動，所以只提醒不攔——攔了會把已經在正常工作的實例打掛。真正的風險是
  // 它一旦和當初不一致，之前加密存進 D1 的任務就再也解不開了。
  const masterKey = env.AMSG_MASTER_KEY?.trim();
  if (masterKey && !/^[0-9a-f]{64}$/i.test(masterKey)) {
    warnings.push({
      code: 'MASTER_KEY_FORMAT',
      message: 'AMSG_MASTER_KEY 不是 64 位十六進制，可能是粘貼時少了幾位。它必須和當初生成的那一串完全一致，換一串的話已存的任務就解不開了。',
    });
  }
  // VAPID 缺了不影響讀寫任務，但 scheduled() 每分鐘會整輪 return，到點消息一條
  // 都發不出來——而界面上一切正常，這是最難自己查出來的一種壞法。
  const vapidReady = Boolean(env.VAPID_PUBLIC_KEY?.trim() && env.VAPID_PRIVATE_KEY?.trim());
  const fcmParts = [env.FCM_PROJECT_ID, env.FCM_SERVICE_ACCOUNT_EMAIL, env.FCM_SERVICE_ACCOUNT_PRIVATE_KEY]
    .map((value) => value?.trim());
  const fcmReady = fcmParts.every(Boolean);
  if (!vapidReady) {
    warnings.push({
      // 保留既有診斷碼，避免舊前端/排障腳本因為新增 FCM 通道而失配。
      code: 'VAPID_MISSING',
      message: fcmReady
        ? 'Capacitor FCM 通道已配置，但 VAPID 沒配齊：原生 App 可推送，瀏覽器/PWA Web Push 不可用。'
        : 'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY 沒配齊，且沒有完整 FCM 配置，到點消息不會推送出去。',
    });
  }
  if (fcmParts.some(Boolean) && !fcmReady) warnings.push({
    code: 'FCM_INCOMPLETE',
    message: 'FCM 配置只填了一部分；需要同時設置 FCM_PROJECT_ID、FCM_SERVICE_ACCOUNT_EMAIL、FCM_SERVICE_ACCOUNT_PRIVATE_KEY。',
  });
  if (!env.AMSG_SERVER_TOKEN?.trim()) {
    warnings.push({
      code: 'SERVER_TOKEN_MISSING',
      message: '沒設 AMSG_SERVER_TOKEN，這個 Worker 地址對公網開放，知道地址的人都能讀寫你的任務。',
    });
  }

  return {
    ok: absent.length === 0,
    missing: absent.map((item) => item.key),
    message: absent.length
      ? `Worker 配置不完整：${absent.map((item) => `缺 ${item.label}（${item.how}）`).join('；')}。`
      : 'Worker 配置齊全。',
    warnings,
  };
};

/**
 * 預檢放行的請求頭。
 *
 * 這一份同時餵給包裝層自己的響應（CORS_HEADERS）和上游 config 的 `cors.allowHeaders`
 * ——兩處**必須**是同一串：預檢放行的頭少一個，正式請求就會被瀏覽器攔下，而攔下的表現
 * 同樣是沒有下文的 "Failed to fetch"，從外面根本看不出是 CORS 的事。
 *
 * `Content-Encoding` 是給 gzip 上行用的。它不在 CORS 安全列表裡，所以帶上它的請求
 * 必過預檢；上游默認那份白名單裡沒有它，不顯式配的話，壓過的請求一條都發不出去。
 */
const CORS_ALLOW_HEADERS =
  'Content-Type, Content-Encoding, X-User-Id, X-Payload-Encrypted, X-Encryption-Version, '
  + 'X-Response-Encrypted, X-Client-Token';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
  'Access-Control-Max-Age': '86400',
};

const jsonWithCors = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });

// cron 觸發時 CF 傳進來的事件，只往上游轉手，沒必要為它引 workers-types。
type CfScheduledEvent = { scheduledTime: number; cron: string };

/**
 * 把上游的 schema 自查結果拆成「缺表 / 缺列」兩摞。
 *
 * 上游報的形如 `table:message_outbox`、`column:scheduled_messages.last_error`、
 * `index:uidx_uuid`，而體檢面板是按這兩類分開說話的（缺表 → 點連接就能建好；
 * 缺列 → 是升級後沒重連的典型症狀）。索引歸進「表」那一摞：對用戶來說都是
 * 「點一次重新連接」，沒必要多一個詞。
 *
 * 為什麼不自己列一份期望清單：手抄的那份會漏。這個判斷本身要守的就是
 * 「升級後老表沒長出新列、cron 每分鐘靜默掛」，而漏掉的恰恰會是最新加的那一列——
 * 於是體檢對著一個正在掛的庫回「表和列都齊了」，比不查更誤導人。上游那份是從
 * 建表語句現解析出來的，它加了什麼列，這裡就查什麼列。
 */
/** 上游 schema 自查的結果；查不了時是 null（見 inspectSchema）。 */
type SchemaProbe = Awaited<ReturnType<typeof upstream.getSchemaVersion>> | null;

/**
 * schema 自查查不動時的歸類代號。**只有這四個字面量會進 /debug 回執**，異常原文一個
 * 字都不帶——那上面可能掛著 SQL 片段，而這個端點是不設防的。
 *
 * 分這幾檔是因為用戶該做的事完全不同：`unsupported` 點一下「更新 Worker」就好，
 * `denied` 是後端自己的毛病、點什麼都沒用，`timeout` 再體檢一次多半就過了。
 * 混成一句「查不了」的話，界面只能說一句誰都用不上的廢話。
 */
export type AmsgSchemaProbeError = 'unsupported' | 'denied' | 'timeout' | 'other';

/**
 * 把 schema 自查拋出來的異常歸到上面四檔裡。
 *
 * `denied` 排在最前面，因為它的特徵串最硬（D1 的授權器只會報這一種）。2026-08-09
 * 真機上撞到的就是它：新建的 D1 庫裡自帶一張 Cloudflare 內部表 `_cf_KV`，上游遍歷
 * 全庫逐表問列時問到它，被 D1 一口回絕，整個自查斷在第一張表上。
 */
export const classifySchemaProbeError = (error: unknown): AmsgSchemaProbeError => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const name = error instanceof Error ? error.name : '';
  if (/SQLITE_AUTH/i.test(message) || /not authorized/i.test(message)) return 'denied';
  // 老 bundle 裡壓根沒有 getSchemaVersion，或者適配器沒實現 describeSchema。
  if (/is not a function/i.test(message) || /不支持 schema 自查/.test(message)) return 'unsupported';
  if (name === 'AbortError' || name === 'TimeoutError' || /timed? ?out/i.test(message)) return 'timeout';
  return 'other';
};

export const splitSchemaMissing = (missing: string[]) => ({
  missingTables: missing
    .filter((item) => item.startsWith('table:') || item.startsWith('index:'))
    .map((item) => item.slice(item.indexOf(':') + 1)),
  missingColumns: missing
    .filter((item) => item.startsWith('column:'))
    .map((item) => item.slice('column:'.length)),
});

type D1Like = {
  prepare(sql: string): {
    bind(...values: unknown[]): { first<T = unknown>(): Promise<T | null> };
    first<T = unknown>(): Promise<T | null>;
    all<T = unknown>(): Promise<{ results?: T[] }>;
  };
};

/** 推送服務判定訂閱已失效時回的狀態碼：410 = 已註銷/過期，404 = 端點根本不存在。 */
const PUSH_GONE_STATUSES = [410, 404];

/**
 * 推送到底推沒推出去：最近一次被推送服務判成「這條訂閱已經失效」是什麼時候。
 *
 * 這是「登記狀態全綠、到點一條都不來」的最後一塊拼圖。瀏覽器手裡有訂閱、庫裡也
 * 登記著同一條 endpoint，兩邊都自洽，但那條 endpoint 在推送服務（FCM / Mozilla /
 * Apple）那側早就作廢了，推過去只換回一個 410。這件事只有推送服務知道，前端和
 * Worker 自己都查不出來。
 *
 * 事實由上游 amsg-server 產生：投遞失敗時它把推送服務回的狀態碼結構化寫進任務的
 * `last_error.pushStatus`。這裡只是把它讀出來——**不去解析 `reason` 那句人話**，
 * 那是給用戶看的自由文本，拿它當接口用的話，上游改個措辭這裡就靜默失效。
 *
 * 只回狀態碼和時刻，不回 `last_error` 原文：那是一段沒有約束的錯誤摘要，而
 * `/debug` 這個端點是不設防的。
 *
 * 查不成（老庫還沒有 last_error 列、查詢被拒）返回 null = 「這一項沒查出來」，
 * 界面照實說查不了，不會因此給一個假綠燈。
 */
export const inspectPushDelivery = async (
  db: D1Like,
  registeredAtMs: number | null,
): Promise<{ gone: AmsgPushGoneFailure | null; registeredAtMs: number | null } | null> => {
  try {
    // 只看有失敗記錄的行，按最近更新排。訂閱一旦作廢，每條到點的任務都會撞上同一個
    // 410，最近那次必然排在最前面——取 20 條足夠，不必把整個任務表讀一遍。
    const rows = await db
      .prepare(
        `SELECT last_error FROM scheduled_messages
          WHERE last_error IS NOT NULL
          ORDER BY updated_at DESC
          LIMIT 20`,
      )
      .all<{ last_error: string | null }>();

    let gone: AmsgPushGoneFailure | null = null;
    for (const row of rows.results || []) {
      let record: { at?: unknown; pushStatus?: unknown } | null = null;
      try {
        const parsed = JSON.parse(row.last_error || 'null');
        record = parsed && typeof parsed === 'object' ? parsed : null;
      } catch {
        continue; // 存進去的不是 JSON（不該發生），跳過這一條就是了
      }
      const status = Number(record?.pushStatus);
      if (!PUSH_GONE_STATUSES.includes(status)) continue;
      const atMs = Date.parse(String(record?.at ?? ''));
      if (!Number.isFinite(atMs)) continue;
      if (!gone || atMs > gone.atMs) gone = { status, atMs };
    }

    return { gone, registeredAtMs };
  } catch {
    return null;
  }
};

/**
 * 只讀地看一眼庫裡的狀況：表齊不齊、列全不全、有沒有到點卻沒人處理的任務。
 *
 * 全程不寫庫。回出去的只有數數、schema 比對，和從失敗記錄裡認出的一個狀態碼——
 * 數出來的東西（待發條數、最老的一條過期了多久、卡住幾條）不指向任何角色、時間點
 * 或正文。判「是不是同一個角色在排隊」時會在內部解開過期任務的內容，但角色名、
 * 報錯原文都不出這個端點。
 */
const inspectStorage = async (
  env: Env,
  probe: { schema: SchemaProbe; error: AmsgSchemaProbeError | null },
) => {
  const { schema, error: schemaError } = probe;
  const db = env.DB as D1Like | undefined;
  if (typeof db?.prepare !== 'function') return { reachable: false as const };

  try {
    const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{
      name: string;
    }>();
    const present = new Set((tables.results || []).map((row) => row.name));

    // schema 齊不齊由上游說了算（它按自己的建表語句比對，見 splitSchemaMissing）。
    //
    // 查不了（schema 為 null）時報 **null，不是 true**：這一項的全部意義就是查出
    // 「升級完 Worker 沒重新連接」造成的表結構漂移——那種情況下 cron 每分鐘靜默失敗、
    // 主動消息整個停擺，而界面處處正常。查詢本身掛了卻回一句「表和列都齊了」，等於在
    // 唯一能發現這件事的地方給了假綠燈，比沒有這項檢查更糟。讓它照實說「查不了」，
    // 界面那一行顯示成灰色的未知，人至少知道還得自己確認一次。
    const { missingTables, missingColumns } = splitSchemaMissing(schema?.missing ?? []);

    if (!present.has('scheduled_messages')) {
      // 主表都不在，這個不用上游背書也是確定的：庫是空的。
      return { reachable: true as const, missingTables, missingColumns, schemaReady: false, schemaError };
    }
    // 主表在、但比對不出來 → 不知道。
    const schemaReady = schema ? missingTables.length === 0 && missingColumns.length === 0 : null;

    const nowIso = new Date().toISOString();
    const stats = await db
      .prepare(
        `SELECT COUNT(*) AS pending,
                SUM(CASE WHEN next_send_at <= ? THEN 1 ELSE 0 END) AS overdue,
                MIN(CASE WHEN next_send_at <= ? THEN next_send_at END) AS oldest
           FROM scheduled_messages WHERE status = 'pending'`,
      )
      .bind(nowIso, nowIso)
      .first<{ pending: number; overdue: number | null; oldest: string | null }>();

    // 一行表，條數和登記時刻一次拿全。登記時刻是判斷投遞失敗還算不算數的標尺：
    // 重置訂閱會覆蓋這一行、刷新時刻，比它更早的失敗都是上一條訂閱的舊帳。
    const pushRow = present.has('push_subscriptions')
      ? await db
        .prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS updatedAt FROM push_subscriptions')
        .first<{ n: number; updatedAt: number | null }>()
      : null;

    // 過期的那幾條各自算哪種情況（在等重試、正在發、排隊、真卡住）。只數數，
    // 報錯原文和角色名一概不出這個端點——細帳走要共享密鑰的 /tick-report。
    //
    // 讀不成（老庫還沒有 retry_after 這些列）時是 null，定時任務那一項退回只看
    // 「最老那條晚了多久」。表結構漂移恰恰是這個端點要查的東西，不能因為它把整份體檢帶掛。
    const overdue = stats?.overdue
      ? await readOverdueTasks(db as unknown as TickReportDb, {
        masterKey: env.AMSG_MASTER_KEY?.trim() || undefined,
        serializeKeyOf: amsgSerializeKey,
      }).catch((error) => {
        console.warn('[amsg:debug] 過期任務的細帳讀不了，定時任務一項退回只看晚了多久', error);
        return null;
      })
      : null;

    return {
      reachable: true as const,
      schemaReady,
      // null = 這次自查跑成了。有值時 schemaReady 必然是 null，界面照它選該說哪句話。
      schemaError,
      missingTables,
      missingColumns,
      // 單用戶 worker 只存一行。到點卻發不出去最常見的原因就是這行是空的——
      // 換了一台 worker 之後雲端訂閱是空的，而瀏覽器那側的訂閱一個字都沒變。
      pushSubscriptionRegistered: (pushRow?.n ?? 0) > 0,
      pushDelivery: await inspectPushDelivery(db, pushRow?.updatedAt ?? null),
      pendingTasks: stats?.pending ?? 0,
      overdueTasks: stats?.overdue ?? 0,
      oldestOverdueMinutes: stats?.oldest
        ? Math.floor((Date.now() - Date.parse(stats.oldest)) / 60000)
        : null,
      // 過期任務裡真卡住的、在失敗重試的各幾條，以及合起來的結論。null = 這次沒判出來。
      stuckTasks: overdue ? overdue.tasks.filter((task) => task.stuck).length : null,
      retryingTasks: overdue ? overdue.tasks.filter((task) => task.lastError !== null).length : null,
      overdueVerdict: overdue?.verdict ?? null,
    };
  } catch (error) {
    // 報錯類型而不是原文：原文可能帶 SQL 片段，而這個端點是不設防的。
    return { reachable: false as const, error: (error as Error)?.name || 'QueryFailed' };
  }
};

/**
 * 定時任務有沒有在被正常處理。
 *
 * 不寫心跳，靠到點了還沒發出去的任務反推——心跳要每分鐘寫一次庫，而這個判斷純讀、
 * 零副作用，問的還正好是用戶真正關心的那件事（任務有沒有被按時處理），比「tick 有沒有
 * 觸發」更貼。代價是手上沒有待發任務時無從判斷，那種情況下 cron 停沒停也確實不影響什麼。
 *
 * 「晚了多久」不能直接當「卡了多久」：重試期間任務的到點時刻不會往後挪，一條正在
 * 正常重試的任務晚個二三十分鐘很平常。所以逐條判出來的結論優先（見 utils/amsgTickReport）：
 *
 * - `stalled`：有任務真卡住了（一直沒人領，或者領了又沒了下文）。
 * - `failing`：沒卡住，但有任務在失敗重試，或者這次開跑晚得不正常。
 * - `healthy`：都在正常處理。
 *
 * 逐條判不了（老庫缺列）時才退回只看最老那條晚了多久。
 */
const judgeTick = (storage: Awaited<ReturnType<typeof inspectStorage>>) => {
  if (!storage.reachable || !('pendingTasks' in storage)) return 'unknown';
  if (!storage.pendingTasks) return 'idle';
  if (storage.overdueVerdict) return storage.overdueVerdict;
  const overdueMinutes = storage.oldestOverdueMinutes;
  if (overdueMinutes === null || overdueMinutes * 60_000 < TICK_STALL_MS) return 'healthy';
  return 'stalled';
};

/** DO 存「這個實例負責哪條任務」用的 storage 鍵。 */
const INSTANT_TICK_UUID_KEY = 'taskUuid';

const upstream = createSingleUserCloudflareWorker(buildWorkerConfig, {
  /**
   * cron 那條路上沒有調用方能看到錯誤響應——上游把異常 catch 掉之後，整輪就這麼無聲
   * 結束了。表結構漂移（升級後老表沒加列）撞上的正是這裡：cron 每分鐘靜默失敗、
   * 主動消息整個停擺，而界面上一切正常，沒人知道出了事。
   *
   * 這個 hook 是那條路唯一的出口，所以什麼都不做也要把它記下來。
   */
  onError({ stage, cause, path }) {
    const where = path ? `${stage} ${path}` : stage;
    console.error(`[amsg:upstream-error] ${where} → ${cause.name}: ${cause.message}`);
  },
});

/**
 * 庫的表結構跟當前這版代碼對不對得上。
 *
 * 這是「升級完 Worker 卻沒重新連接」的唯一可查證據：表結構漂移（新版要的列老表沒有）
 * 之後，cron 每分鐘靜默失敗、主動消息整個停擺，而配置自檢、任務列表、界面全都正常，
 * 隔著屏幕根本問不出來。missing 裡會直接點名缺哪張表、哪一列。
 *
 * 查不了不算錯（D1 沒綁之類）——報 null，讓面板照舊顯示其餘部分。
 *
 * 但**為什麼查不了要一起帶出去**：只往日誌裡寫一行的話，用戶看到的永遠是一句
 * 「查不了，不知道」，而這句話對他做什麼毫無幫助，隔著屏幕也問不出來。歸類見
 * classifySchemaProbeError。
 */
const inspectSchema = async (env: Env): Promise<{ schema: SchemaProbe; error: AmsgSchemaProbeError | null }> => {
  try {
    return { schema: await upstream.getSchemaVersion(env), error: null };
  } catch (error) {
    const kind = classifySchemaProbeError(error);
    console.warn(`[amsg:debug] schema 查不了（${kind}）`, error);
    return { schema: null, error: kind };
  }
};

/**
 * 即時對話的起跳器：把「立刻跑這一條」搬進 Durable Object 的 alarm 裡。
 *
 * 為什麼非得是 DO：客戶端發完就走（切後台、鎖屏、殺進程都行），所以這一跳不能掛在
 * 那個已經回了 202 的 HTTP 請求上——`ctx.waitUntil` 只給 30 秒，一輪帶工具循環的生成
 * 必被砍在半路。Cloudflare 上能「不依賴客戶端連接 + 長牆鍾」的入口只有三個：
 * Cron Trigger、Queue consumer、DO alarm，都是 15 分鐘。這裡選 DO 是因為它不用預建
 * 任何資源（namespace 隨 Worker 上傳自動創建），一鍵部署那條路一個額外 API 調用都不用加。
 *
 * **一條任務一個實例**（實例名 = 任務 uuid），所以幾條聊天同時在跑互不排隊。
 * 每個實例只碰自己那一條（`upstream.runTask(uuid)`），不會去掃別人的任務。
 *
 * cron 仍然留著：它是所有定時任務的正常投遞通道，同時也是這一跳萬一沒跑成時的兜底。
 */
export class InstantTickDO extends DurableObject<Env> {
  /**
   * 叫醒：記下要跑哪條、設一個立刻到期的 alarm，然後馬上返回——調用方還等著回 202。
   *
   * 已經掛著 alarm 就只覆蓋 uuid 不重設時間：同一個實例只服務同一條任務，重複叫醒
   * （客戶端重發）應該合併成一次，而不是排成兩次生成。
   */
  async kick(uuid: string): Promise<void> {
    await this.ctx.storage.put(INSTANT_TICK_UUID_KEY, uuid);
    if ((await this.ctx.storage.getAlarm()) !== null) return;
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** 獨立 invocation，15 分鐘牆鍾。跑掛了不重設 alarm——下一分鐘的 cron 會接著撿。 */
  async alarm(): Promise<void> {
    const uuid = await this.ctx.storage.get<string>(INSTANT_TICK_UUID_KEY);
    if (!uuid) {
      console.error('[amsg:instant-tick] alarm 醒了卻不知道要跑哪條，跳過（等 cron 兜底）');
      return;
    }
    const report = inspectWorkerEnv(this.env);
    if (!report.ok) {
      console.error(`[amsg:instant-tick] 整輪跳過：${report.message}`);
      return;
    }
    // 跑完就把 uuid 清掉：這個實例的活兒到此為止，留著只會讓下一次 kick 分不清新舊。
    // 放在 runTask 之前清是不行的——中途被回收就查不出這條到底跑沒跑。
    const result = await upstream.runTask(uuid, this.env);
    await this.ctx.storage.delete(INSTANT_TICK_UUID_KEY);
    if (!result.ran) {
      // 一次性任務發完即刪，所以 not_found 多半是「cron 搶先跑掉了」，屬正常。
      // 其餘幾種（未到期、退避窗口裡、配置不全）留一行，排障時能看出是哪種。
      console.warn(`[amsg:instant-tick] ${uuid} 沒跑：${result.reason}`);
    }
  }
}

/**
 * 版本號只有上游的 capabilities 才給，轉手問它一次；問不到不算錯，報 null。
 * 配置不全時直接不問：那一問必然失敗，還會在 Cloudflare 日誌裡留一條
 * 「fetch() unhandled error」——排障的人正盯著日誌看，別給他添噪音。
 */
const readServerVersion = async (request: Request, env: Env) => {
  if (!inspectWorkerEnv(env).ok) return null;
  try {
    const url = new URL(request.url);
    url.pathname = '/capabilities';
    url.search = '';
    const response = await upstream.fetch(new Request(url.toString(), { headers: request.headers }), env);
    if (response.status !== 200) return null;
    const body = await response.json() as { serverVersion?: string; features?: string[] };
    return { version: body.serverVersion ?? null, featureCount: body.features?.length ?? 0 };
  } catch {
    return null;
  }
};

/**
 * 在上游 worker 外面包一層配置自檢。多出來的四個行為：
 *   GET  /config-check  配置齊不齊（只讀 env，前端「連接並驗證」用的就是它）
 *   GET  /debug         上面那些再加庫和 cron 的狀況，給隔著屏幕幫人排障用
 *   GET  /tick-report   定時任務細帳：過期任務各自卡在哪、報錯原文、整輪報錯（見 ./tickReport，要共享密鑰）
 *   POST /instant-chat  即時對話：一個請求受理一輪聊天（見 ./instantChat）
 *   POST /self-update   自己去取最新代碼覆蓋自己（見 ./selfUpdate，要共享密鑰 + CF_API_TOKEN）
 *   GET/POST /cron-trigger  查看 / 暫停 / 恢復自己的 cron trigger（見 ./cronTrigger，認證同上）
 *   其它請求            配置不全時直接 503 + 說明缺什麼，不進上游
 */
// 兩個 handler 都只收 (request/event, env)：CF 還會給第三個參數 ctx，但這裡用不上——
// /instant-chat 回完 202 之後的那一跳跑在 InstantTickDO 的 alarm 裡，不佔這個請求的
// 生命週期（waitUntil 只有 30 秒，見 InstantTickDO 的註釋）。
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
    const method = request.method.toUpperCase();

    if (pathname.endsWith('/config-check')) {
      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
      // 刻意不校驗 X-Client-Token：worker 配了口令而前端沒填正是要診斷的情形之一，
      // 校驗了就查不出來。作為交換，這裡只回「配沒配」，不回任何值。
      //
      // 三個能力標誌，各答各的問題，前端全都要：
      //
      //   instantChat  這份代碼裡有沒有 /instant-chat 這條路由。老 bundle 沒有這個字段。
      //   instantTick  起跳器（INSTANT_TICK 綁定）接上了沒有——**即時對話真正能不能用**看它。
      //   workerVersion 這份 bundle 自己的版本，跟前端編譯進去的同一個常量比，不一樣就該更新。
      //
      // 為什麼「有路由」和「能用」得分開報：自更新是由**用戶當前那台 Worker 上的舊代碼**
      // 執行的，而舊代碼不認識 Durable Object，所以它傳上去的新 bundle 是不帶 INSTANT_TICK
      // 綁定的——代碼是新的、版本號也對上了，`/instant-chat` 卻只能回 503。這中間態沒有
      // 單獨的信號的話，前端會一邊說「已經是最新版」一邊發一條掛一條。再點一次更新（這次
      // 跑的是新代碼，會把綁定補上）就好，而讓用戶知道「還得再點一次」的正是這個字段。
      //
      // 同理，以後再加別的綁定也會撞上同一堵牆：自更新永遠由舊代碼執行。所以判斷「能不能
      // 用」一律看運行時真的有沒有那個綁定，別看版本號。
      return jsonWithCors(200, {
        success: true,
        data: {
          ...inspectWorkerEnv(env),
          instantChat: true,
          instantTick: !!env.INSTANT_TICK,
          // 這份代碼認不認識「後台任務」（metadata.amsgKind → handler，見 fireKinds.ts）。
          // 老 bundle 沒有這個字段，前端據此不去建那種任務——老 worker 會把它當聊天任務
          // 跑，然後卡在「本次任務指令缺失」終態失敗：任務行不在用戶的清單裡，面板一片
          // 正常，而門牌永遠不更新。報的是**這份代碼有沒有**，不是版本號：自更新永遠由
          // 舊代碼執行，版本號對上了不代表新邏輯真的在跑。
          backgroundJobs: true,
          workerVersion: AMSG_BUNDLE_VERSION,
        },
      });
    }

    if (pathname.endsWith('/debug')) {
      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
      // 全只讀、也不設防，所以能報什麼是有邊界的：只有配置齊不齊、schema 對不對、
      // 數出來的條數，以及本來就公開的 VAPID 公鑰。密鑰的值、用戶標識、任務正文、
      // 推送 endpoint 一概不出現——不是沒取到，是刻意不取。
      const probe = await inspectSchema(env);
      const storage = await inspectStorage(env, probe);
      return jsonWithCors(200, {
        success: true,
        data: {
          now: new Date().toISOString(),
          config: inspectWorkerEnv(env),
          server: await readServerVersion(request, env),
          storage,
          tick: judgeTick(storage),
          schema: probe.schema,
          vapidPublicKey: env.VAPID_PUBLIC_KEY?.trim() || null,
        },
      });
    }

    if (pathname.endsWith('/self-update')) {
      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
      if (method !== 'POST') {
        return jsonWithCors(405, {
          success: false,
          error: { code: 'METHOD_NOT_ALLOWED', message: '/self-update 只接受 POST' },
        });
      }
      // 排在下面那道配置門之前：配置缺了一半正是想更新一版試試的時候，
      // 被門擋住反而沒法自救。它自己校驗共享密鑰，不吃這道門的豁免。
      const result = await handleSelfUpdate(request, env);
      return jsonWithCors(result.ok ? 200 : 400, {
        success: result.ok,
        data: result.ok ? result : undefined,
        error: result.ok ? undefined : { code: result.code, message: result.message },
      });
    }

    if (pathname.endsWith('/cron-trigger')) {
      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
      // 跟 /self-update 一樣排在配置門之前，也一樣自己校驗共享密鑰、不吃這道門的豁免。
      // 認證沒過回 401；「讀不到 / 改不了」是 Worker 自己的配置問題，讀時當狀態報（200）、
      // 改時當失敗報（400）。
      if (method === 'GET') {
        const state = await handleCronTriggerRead(env, request);
        if (!state.supported && isCronTriggerAuthFailure(state.code)) {
          return jsonWithCors(401, {
            success: false,
            error: { code: state.code, message: state.message },
          });
        }
        return jsonWithCors(200, { success: true, data: state });
      }
      if (method !== 'POST') {
        return jsonWithCors(405, {
          success: false,
          error: { code: 'METHOD_NOT_ALLOWED', message: '/cron-trigger 只接受 GET 和 POST' },
        });
      }
      let enabled: unknown;
      try {
        enabled = ((await request.json()) as { enabled?: unknown } | null)?.enabled;
      } catch {
        enabled = undefined;
      }
      if (typeof enabled !== 'boolean') {
        return jsonWithCors(400, {
          success: false,
          error: { code: 'BAD_REQUEST', message: '請求體要是 { "enabled": true | false }' },
        });
      }
      const result = await handleCronTriggerWrite(env, request, enabled);
      if (result.ok) return jsonWithCors(200, { success: true, data: result });
      return jsonWithCors(isCronTriggerAuthFailure(result.code) ? 401 : 400, {
        success: false,
        error: { code: result.code, message: result.message },
      });
    }

    const report = inspectWorkerEnv(env);
    if (!report.ok) {
      // 預檢也得放行：帶自定義頭的請求會先發 OPTIONS，這一步被擋住的話正式請求
      // 根本發不出去，下面那句 503 用戶就永遠看不到。
      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
      return jsonWithCors(503, {
        success: false,
        error: { code: 'WORKER_CONFIG_MISSING', message: report.message, missing: report.missing },
      });
    }

    // 定時任務細帳。排在配置門之後：要讀庫、要主密鑰解出是哪個角色的任務。
    // 跟 /debug 不一樣，這裡會回報錯原文和角色名，所以跟上游其它端點同一道門：
    // 配了共享密鑰就必須帶對。
    if (pathname.endsWith('/tick-report')) {
      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
      if (method !== 'GET') {
        return jsonWithCors(405, {
          success: false,
          error: { code: 'METHOD_NOT_ALLOWED', message: '/tick-report 只接受 GET' },
        });
      }
      const token = env.AMSG_SERVER_TOKEN?.trim() ?? '';
      const clientToken = request.headers.get('X-Client-Token') ?? '';
      if (token && (!clientToken || !(await constantTimeEqual(clientToken, token)))) {
        return jsonWithCors(401, {
          success: false,
          error: { code: 'INVALID_CLIENT_TOKEN', message: '共享密鑰無效或缺失' },
        });
      }
      try {
        const report = await buildTickReport(env.DB as unknown as TickReportDb, {
          masterKey: env.AMSG_MASTER_KEY?.trim(),
          serializeKeyOf: amsgSerializeKey,
        });
        return jsonWithCors(200, { success: true, data: report });
      } catch (error) {
        // 讀不成多半是老庫還沒有新列。原因照實帶回去：能走到這裡的人已經過了共享密鑰那道門。
        const cause = summarizeErrorCause(error, 'request');
        return jsonWithCors(500, {
          success: false,
          error: { code: 'TICK_REPORT_FAILED', message: cause.message ? `${cause.name}: ${cause.message}` : cause.name },
        });
      }
    }

    // 即時對話：一個請求把「傳雲端狀態 + 建任務」串完，回 202 之後立刻起一跳。
    // 排在配置門之後，所以走到這裡 D1 和密鑰必然都在。
    if (pathname.endsWith('/instant-chat')) {
      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
      if (method !== 'POST') {
        return jsonWithCors(405, {
          success: false,
          error: { code: 'METHOD_NOT_ALLOWED', message: '/instant-chat 只接受 POST' },
        });
      }
      return handleInstantChat({ request, env, upstream, json: jsonWithCors });
    }

    return upstream.fetch(request, env);
  },

  async scheduled(event: CfScheduledEvent, env: Env): Promise<void> {
    // 定時任務這條路沒人看得見，配置不全時上游只會拋一個堆棧。寫明白點，
    // wrangler tail 裡一眼能看出是配置問題還是任務本身掛了。
    const report = inspectWorkerEnv(env);
    if (!report.ok) {
      console.error(`[amsg] 定時任務整輪跳過：${report.message}`);
      return;
    }
    // 整輪出錯時上游把原因放在返回值裡（同一份也會經 onError 記一行日誌）。CF 不看
    // scheduled 的返回值，這裡把它記進庫：日誌大多數人找不到，體檢面板的定時任務細帳
    // 讀的是庫裡這一份（見 ./tickReport）。只在出錯時寫，正常的一跳什麼都不寫。
    const outcome = await upstream.scheduled(event, env);
    await recordTickOutcome(env.DB as unknown as TickReportDb, outcome);
  },
};
