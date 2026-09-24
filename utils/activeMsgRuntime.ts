import { loadCharacterContextMessages } from './chatContextRange';
import { ActiveMsg2InboxMessage, ActiveMsg2TaskRecord, APIConfig, RealtimeConfig, UserProfile } from '../types';
import { DB } from './db';
import { ChatPrompts } from './chatPrompts';
import { settleCloudDelayedReply } from './delayedReply';
import { ActiveMsgStore } from './activeMsgStore';
import { ActiveMsgClient, type AmsgOutboxEntry, type RemoteTaskStatus } from './activeMsgClient';
import { AMSG_CHAT_FAIL_KEY, AMSG_SELF_LOG_KEY, amsgStateNamespace, parseChatFailRecord, parseSelfLog } from './amsgFirePack';
import {
  applyAssistantPostProcessing,
  type PostProcessDirective,
  type XhsCaches,
} from './applyAssistantPostProcessing';
import { drainPendingDiaries } from './pendingDiary';
import { applyEmotionEvalRaw } from './emotionApply';
import { CHAT_GEN_EVENTS, announceChatGen, announceEmotionDone } from './chatGenEvents';
import { processNewMessagesWithAutoArchive } from './memoryPalace/autoArchive';
import { loadMusicHooks } from '../context/MusicContext';
import type { XhsNote } from './realtimeContext';
import { appendDevDebugLog, makeDebugLogger } from './devDebug';
import { getLastRealUserMessageAt, shouldExpireFire } from './amsg2ExpireGuard';
import {
  AMSG_INSTANT_CHAT_PENDING_EVENT,
  INSTANT_CHAT_STATUS_CHECK_INTERVAL_MS,
  clearInstantChatPending,
  drainOutbox,
  failInstantChatPending,
  getInstantChatPending,
  listInstantChatPendings,
  settleInstantChatApiLog,
  settleInstantChatExpiredNotices,
} from './amsgInstantChat';
import { dispatchAmsgResult } from './amsgResults';
import { flushAmsgState } from './amsgStateSync';
import { describeInstantChatFailure, pruneStaleTasks, type RemoteTaskLastError } from './amsg2Tasks';
// 線協議常量的唯一出處是 shared（amsg-sw 只是 re-export 同一份）。
import { MULTIPART_FAILURE_REASON } from '@rei-standard/amsg-shared';
import { appendInstantTraceEntry } from './instantTraceLog';
import { captureSwRegistrationSnapshot, probeSwChannel } from './swChannelProbe';
import { trackEvent } from './analytics';

// 同一個 category，兩個 tag——保持 console 裡現有的 [ActiveMsg] / [amsg] 標籤，
// 方便用戶 / 文檔裡 grep 歷史報錯信息。兩條 tag 都歸 amsg 一類。
const log = makeDebugLogger('amsg', 'ActiveMsg');
const logAmsg = makeDebugLogger('amsg', 'amsg');

let initialized = false;

// 三寫：console.info + 無條件 localStorage ring（instantTraceLog，遠端排障事後導出用）
// + 用戶勾控的 devDebug。
function activeMsgTrace(event: string, details: Record<string, unknown> = {}): void {
  const entry = {
    ts: new Date().toISOString(),
    sessionId: typeof details.sessionId === 'string' ? details.sessionId : undefined,
    event,
    visibility: typeof document !== 'undefined' ? document.visibilityState : 'n/a',
    online: typeof navigator !== 'undefined' ? navigator.onLine : undefined,
    ...details,
  };
  try {
    console.info('[InstantTrace]', entry);
  } catch { /* ignore */ }
  appendInstantTraceEntry(entry);
  // 也掛進 devDebug 的 amsg 類目：勾了之後 trace 跟其它主動消息日誌一起被
  // 複製 / 下載導出。gate 由 isCaptureEnabled('amsg') 自動管，未勾時零成本。
  appendDevDebugLog('amsg', { label: `trace:${event}`, data: entry });
}

// ─── push 路徑模塊級 XHS 共享狀態 ─────────────────────────────────────────────
//
// 本地 fetch 路徑 useChatAI 用 useRef 持有 5 個 cache Map + 單次調用閉包的 lastXhsNotesRef.
// 生命週期 = useChatAI mount 期間 (刷頁面 / 切角色 = 清). 跨多次 send / 跨工具調用都共享.
//
// push 路徑在 React 之外跑 (SW postMessage → activeMsgRuntime 監聽器), 沒 useRef.
// 改成模塊級單例: 跟本地路徑"應用打開期間共享, 刷頁面就清"行為字節級對齊.
//
// 筆記列表來自 worker 隨 push 捎回的 metadata.xhsSession（落庫後在沖刷時讀回這裡），
// applyAssistantPostProcessing 重放 [[XHS_SHARE: 序號]] 等標籤時讀同一份 ref.
//
// 主進程刷新 / 瀏覽器關閉 → 清空, 跟本地路徑 useChatAI 重 mount 清 useRef 等價.
// 不寫 IndexedDB — 行為與本地路徑對齊, 不引入持久化代價.
export const pushXhsCaches: XhsCaches = {
  xsecTokenCache: new Map(),
  noteTitleCache: new Map(),
  commentUserIdCache: new Map(),
  commentAuthorNameCache: new Map(),
  commentParentIdCache: new Map(),
};
export const pushLastXhsNotesRef: { current: XhsNote[] } = { current: [] };

// 防穿幫閘·送達判定緩存：一次 fire 的多分段 push 必須同吞同放（不能吞一半），
// 按「任務 + occurrence」記住首段判定。Web Push/FCM 不保證分段按序到達，邏輯
// 上的最後一段可能最先到，所以不能在 messageIndex===totalMessages 時立即刪除；
// 保留 5 分鐘 TTL，讓遲到分段仍復用同一決定。
// （導出僅為讓 activeMsgRuntime.test.ts 用真實 TTL 校驗重判邊界，運行時不消費。）
export const EXPIRE_DECISION_TTL_MS = 5 * 60_000;
type ExpireDecisionEntry = { expired: boolean; expiresAt: number };
const expireDecisionByFire = new Map<string, ExpireDecisionEntry>();

/**
 * 送達判定的 get-or-compute（帶 TTL 過期清掃）。從吞沒閘裡抽出來單測：
 *   - 同一 fireKey 的多次調用只 evaluate 一次——一次 fire 的多分段 push 同吞同放；
 *   - TTL 過後同 key 才允許重新 evaluate（遲到分段仍復用同一決定）。
 * cache 由調用方注入：運行時傳模塊級 expireDecisionByFire，測試傳臨時 Map 做隔離。
 * 行為與內聯版逐字節對齊（先掃過期、再 get、缺失才 compute-and-set）。
 */
export async function resolveFireExpireDecision(
  cache: Map<string, ExpireDecisionEntry>,
  fireKey: string,
  now: number,
  evaluate: () => Promise<boolean>,
): Promise<boolean> {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  let cached = cache.get(fireKey);
  if (!cached) {
    cached = { expired: await evaluate(), expiresAt: now + EXPIRE_DECISION_TTL_MS };
    cache.set(fireKey, cached);
  }
  return cached.expired;
}

type MemoryPalaceGlobalConfig = {
  embedding: { baseUrl: string; apiKey: string; model: string; dimensions: number };
  lightLLM: { baseUrl: string; apiKey: string; model: string };
};

/** 從 localStorage 讀 memoryPalaceConfig — OSContext 同步存的是 os_memory_palace_config key */
const loadMemoryPalaceConfigFromLocalStorage = (): MemoryPalaceGlobalConfig | undefined => {
  try {
    const raw = localStorage.getItem('os_memory_palace_config');
    if (!raw) return undefined;
    return JSON.parse(raw) as MemoryPalaceGlobalConfig;
  } catch {
    return undefined;
  }
};

/** 從 localStorage 讀 APIConfig (與 OSContext load 邏輯保持一致, 但這裡在 React 之外跑) */
const loadApiConfigFromLocalStorage = (): APIConfig => {
  const fallback: APIConfig = { baseUrl: '', apiKey: '', model: '' };
  try {
    const raw = localStorage.getItem('os_api_config');
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return {
      baseUrl: parsed.baseUrl || '',
      apiKey: parsed.apiKey || '',
      model: parsed.model || '',
      ...parsed,
    };
  } catch {
    return fallback;
  }
};

/** 從 localStorage 讀 RealtimeConfig — 整個 push 路徑裡我們不會再回連 LLM, 但 ChatParser
 *  及 DIARY 寫入(可執行的副作用)需要這些配置, 缺失時返回 undefined 讓消費方走 fallback。 */
const loadRealtimeConfigFromLocalStorage = (): RealtimeConfig | undefined => {
  const raw = (() => {
    try {
      return localStorage.getItem('os_realtime_config');
    } catch {
      // 隱私模式 / 存儲被禁：跟「沒配過」同樣處理，但值得留一行。
      console.warn('[amsg2] 讀不到 os_realtime_config（存儲不可用），按沒配過處理');
      return null;
    }
  })();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as RealtimeConfig;
  } catch {
    // 「沒配過」和「配過但存壞了」都會走到 undefined，而後者會讓這一輪打髒上傳的
    // fire_pack 少掉整塊實時內容（天氣 / 熱搜 / 節日），把雲端那份好的蓋掉。行為上
    // 仍按沒配過走——現場沒有別的東西可用——但必須留痕，否則用戶只會看到「主動消息
    // 裡怎麼不提天氣了」而查無可查。
    console.warn('[amsg2] os_realtime_config 存的內容解析不了，這一輪按沒配過處理');
    return undefined;
  }
};

/**
 * 用 applyAssistantPostProcessing 把 push 收到的 inbox message 走一遍 13 步管線。
 * skipSecondPassLLM=true: 不回連 LLM (worker 現在還沒續跑能力, Phase 2 才解決),
 * 二輪標籤 (RECALL / SEARCH / READ_DIARY / FS_READ_DIARY / READ_NOTE / XHS_*) 留在
 * 原文裡, 由 ChatParser.sanitize 等步驟兜底剝掉。
 * 副作用類標籤 (POKE / TRANSFER / ADD_EVENT / schedule_message / 寫日記) 仍會執行。
 * 失敗時拋出, 由調用方決定是否重新入隊。
 */
/**
 * 已經取回來、等這條消息真處理完了才能刪的一份雲端旁路副本。
 *
 * 取回就刪是不行的：落庫半路失敗會把這條消息壓回收件箱重試，而重試那一趟去讀同一個鍵
 * 已經是空的——心象卡片、小紅書卡片數據這一輪就永久沒了，用戶側還看不到任何報錯
 * （回覆照常上屏，只是少了東西）。刪只是讓 D1 乾淨一點（鍵每任務固定、下次觸發直接
 * 覆蓋），值不上這個代價。
 */
type OffloadedCleanup = { namespace: string; ref: string; what: string };

/**
 * 這條消息處理成功之後，把它取用過的那幾份雲端旁路副本刪掉。
 * 盡力而為：刪不掉只 warn（下次觸發會覆蓋，不影響正確性）。
 */
const runOffloadedCleanups = async (cleanups: OffloadedCleanup[]): Promise<void> => {
  for (const { namespace, ref, what } of cleanups) {
    try {
      await ActiveMsgClient.clearClientStateValue(namespace, ref);
    } catch (error) {
      log.warn(`清空旁路存儲的${what}失敗（下次觸發會覆蓋，不影響正確性）`, { ref, error });
    }
  }
};

/**
 * 取回 worker 旁路存下的 XHS 會話數據（push 裝不下時才有，見 offloadOversizedPush）。
 * 雲端那份不在這裡刪，登記進 cleanups、等整條消息處理成功後再刪（見 OffloadedCleanup）。
 *
 * 取不回來就拋錯：調用方會把這條消息壓回收件箱重試，而不是發一條「說分享了卻沒有卡片」
 * 的消息出去。
 */
const fetchOffloadedXhsSession = async (
  message: ActiveMsg2InboxMessage,
  cleanups: OffloadedCleanup[],
): Promise<any | null> => {
  const ref = (message.metadata as any)?.xhsSessionRef;
  if (typeof ref !== 'string' || !ref) return null;

  const namespace = amsgStateNamespace(message.charId);
  const raw = await ActiveMsgClient.readClientStateValue(namespace, ref);
  if (raw == null) {
    // 鍵不在了：同任務的下一次觸發已經把它覆蓋/清掉了，這條 push 是遲到的老消息。
    // 重試也取不回來，按「沒有卡片數據」繼續——比卡在收件箱裡反覆重試強。
    log.warn('旁路存儲裡沒有這份 XHS 會話數據（多半被下一次觸發覆蓋了）', { ref, charId: message.charId });
    return null;
  }

  const parsed = JSON.parse(raw);
  cleanups.push({ namespace, ref, what: 'XHS 會話數據' });
  return parsed;
};

/**
 * 取回 worker 旁路存下的一段附贈內容（情緒評估原文 / 思考鏈——它倆撐爆一條 push 時
 * worker 會整段挪進 client_state、只在 metadata 留個引用鍵，見 worker 的
 * offloadOversizedPush）。雲端那份登記進 cleanups，等整條消息處理成功後再刪
 * （見 OffloadedCleanup）。
 *
 * 取不回來只返回 null、**不拋錯**：這條消息本身（角色說的那句話）已經完整送到了，
 * 為了一次情緒更新 / 一張心象卡片把它壓回收件箱反覆重試，用戶看到的是回覆遲遲不上屏。
 *
 * XHS 那份不走這裡：卡片數據缺了角色的話就和內容對不上，得拋錯重試，見
 * fetchOffloadedXhsSession。
 */
const fetchOffloadedExtra = async (
  message: ActiveMsg2InboxMessage,
  /** metadata 上的引用鍵字段名。 */
  refField: 'amsgEmotionRef' | 'amsgReasoningRef',
  /** 日誌裡怎麼稱呼它 + 取不到時這一輪少了什麼。 */
  labels: { what: string; whenMissing: string },
  /** 取回成功時把「這份雲端副本可以刪了」登記進來，由調用方在處理成功後統一刪。 */
  cleanups: OffloadedCleanup[],
): Promise<string | null> => {
  const ref = (message.metadata as any)?.[refField];
  if (typeof ref !== 'string' || !ref) return null;

  const namespace = amsgStateNamespace(message.charId);
  try {
    const raw = await ActiveMsgClient.readClientStateValue(namespace, ref);
    if (raw == null) {
      // 鍵不在了：同角色的下一輪已經把它覆蓋/清掉了，這條是遲到的老消息。
      log.warn(`旁路存儲裡沒有這份${labels.what}（多半被下一輪覆蓋了）`, { ref, charId: message.charId });
      return null;
    }
    cleanups.push({ namespace, ref, what: labels.what });
    return raw;
  } catch (error) {
    log.warn(`取旁路存儲的${labels.what}失敗（${labels.whenMissing}）`, { ref, error });
    return null;
  }
};

const fetchOffloadedEmotionUpdate = (
  message: ActiveMsg2InboxMessage,
  cleanups: OffloadedCleanup[],
) => fetchOffloadedExtra(message, 'amsgEmotionRef', {
  what: '情緒評估', whenMissing: '這一輪情緒不更新，回覆照常',
}, cleanups);

const fetchOffloadedReasoning = (
  message: ActiveMsg2InboxMessage,
  cleanups: OffloadedCleanup[],
) => fetchOffloadedExtra(message, 'amsgReasoningRef', {
  what: '思考鏈', whenMissing: '這條沒有心象卡片，回覆照常',
}, cleanups);

/**
 * 雲端跑出來的一份評估原文 → 落 buff + 把 innerState 廣播給下一輪。
 *
 * 兩種形態共用這一處：單獨一條 emotion_update 消息（metadata.emotionRaw），或掛在
 * 即時對話最後一條回覆的 metadata.amsgEmotionUpdate 上。
 * 解析只認 applyEmotionEvalRaw 這一套（與本地評估路徑同一份），別在任何一側另寫一個。
 */
const landCloudEmotionResult = async (charId: string, raw: string): Promise<void> => {
  try {
    const chars = await DB.getAllCharacters();
    const ch = chars.find((c) => c.id === charId);
    if (!ch) return;
    const innerState = await applyEmotionEvalRaw(raw, ch);
    if (innerState) {
      window.dispatchEvent(new CustomEvent('emotion-innerstate-updated', {
        detail: { charId, innerState },
      }));
    }
  } catch (e) {
    console.warn('[flush:emotion_update] apply failed', e);
  }
};

// ─── 情緒評估晚投的補落輪詢 ───
// worker 那頭評估沒趕上回復的順風車（push 上是 amsgEmotionRef + amsgEmotionPending），
// 結果要等 worker 收尾時才寫進旁路存儲。這裡對著引用鍵每隔一跳讀一次，讀到就走
// landCloudEmotionResult 落 buff（與正常路徑同一份解析）、熄燈、刪雲端副本；跳數用盡
// 還沒等到才按失敗收尾——評估自身在 worker 有 120s 超時，這個窗口蓋住它再留餘量。
// 每角色最多一個在跑；新一輪的情緒結論到達時舊輪詢作廢（舊結果落下去會蓋掉新 buff）。
const LATE_EMOTION_POLL_INTERVAL_MS = 20_000;
const LATE_EMOTION_POLL_MAX_TRIES = 8;
// value 是各輪詢獨有的會話對象：tick 的 await 期間被 cancel / 被新一輪頂替時，
// 比對引用就能發現自己已經不是當前那一輪，靜默退場。
const lateEmotionPolls = new Map<string, { timer: ReturnType<typeof setTimeout> }>();

export const cancelLateEmotionPoll = (charId: string): void => {
  const entry = lateEmotionPolls.get(charId);
  if (entry) {
    clearTimeout(entry.timer);
    lateEmotionPolls.delete(charId);
  }
};

/** 晚投情緒的補落輪詢。intervalMs / maxTries 僅供測試收窄，生產調用不傳。 */
export const startLateEmotionPoll = (
  charId: string,
  ref: string,
  charName: string,
  opts?: { intervalMs?: number; maxTries?: number },
): void => {
  const intervalMs = opts?.intervalMs ?? LATE_EMOTION_POLL_INTERVAL_MS;
  const maxTries = opts?.maxTries ?? LATE_EMOTION_POLL_MAX_TRIES;
  cancelLateEmotionPoll(charId);
  const namespace = amsgStateNamespace(charId);
  const entry = { timer: undefined as unknown as ReturnType<typeof setTimeout> };
  let tries = 0;
  const tick = async (): Promise<void> => {
    tries += 1;
    let raw: string | null = null;
    try {
      raw = await ActiveMsgClient.readClientStateValue(namespace, ref);
    } catch (error) {
      // 讀失敗當「還沒到」：網絡抖一下不該終結這輪補落。
      logAmsg.warn('晚投情緒補落這一跳沒讀到（下一跳再試）', { charId, ref, error });
    }
    // await 期間被 cancel / 被新一輪頂替 → 靜默退場，別把舊結果落到新 buff 上。
    if (lateEmotionPolls.get(charId) !== entry) return;
    if (raw) {
      lateEmotionPolls.delete(charId);
      await landCloudEmotionResult(charId, raw);
      announceEmotionDone(charId);
      activeMsgTrace('runtime-late-emotion-landed', { charId, tries });
      // 用完即刪（同旁路取回的口徑）；刪不掉下次觸發會覆蓋，只 warn。
      try {
        await ActiveMsgClient.clearClientStateValue(namespace, ref);
      } catch (error) {
        logAmsg.warn('晚投情緒副本清理失敗（下次觸發會覆蓋）', { charId, ref, error });
      }
      return;
    }
    if (tries >= maxTries) {
      lateEmotionPolls.delete(charId);
      announceChatGen(CHAT_GEN_EVENTS.emotionFailed, {
        charId, charName,
        reason: '雲端情緒評估最終沒等到（副 API 太慢或報錯），這一輪不更新',
      });
      announceEmotionDone(charId);
      return;
    }
    entry.timer = setTimeout(() => { void tick(); }, intervalMs);
  };
  // 首跳也等一個間隔：push 剛到那一刻 worker 多半還沒寫完旁路，立刻讀必空。
  entry.timer = setTimeout(() => { void tick(); }, intervalMs);
  lateEmotionPolls.set(charId, entry);
};

/**
 * SW 轉來的 error push（即時對話終態失敗的直發告知）→ 當場收尾那一輪：落系統消息、
 * 熄燈、銷帳。與 60s 點名兜底殊途同歸——failInstantChatPending 認 uuid，誰先到誰收尾，
 * 晚到的一方對不上帳直接走人，不會重複落說明。失敗文案與點名路徑同一份翻譯
 * （describeInstantChatFailure），兩條路對用戶說同樣的話。export 只為單測。
 */
export const handleInstantErrorPushMessage = async (data: unknown): Promise<void> => {
  const meta = (data as { metadata?: Record<string, unknown> } | null)?.metadata;
  const charId = typeof meta?.charId === 'string' && meta.charId ? meta.charId : null;
  const taskUuid = typeof meta?.taskUuid === 'string' && meta.taskUuid ? meta.taskUuid : null;
  // 不是即時對話的失敗告知（缺這兩個字段）→ 不歸這裡管
  if (!charId || !taskUuid) return;
  const reason = typeof meta?.reason === 'string' && meta.reason ? meta.reason : null;
  // worker 掛在 push 上的穩定 code（老 worker 沒這個字段 → 走通用文案）。帶上它，
  // 秒級到達的這條直發告知才和 60s 點名那條說同一句話。
  const errorCode = typeof meta?.errorCode === 'string' && meta.errorCode ? meta.errorCode : undefined;
  const described = reason
    ? describeInstantChatFailure({ reason, ...(errorCode ? { errorCode } : {}) })
    : null;
  await failInstantChatPending(charId, taskUuid, described ?? undefined);
};

/**
 * 分片消息拼不起來時給用戶的那句話。
 *
 * 一條推送裝不下的內容（長回覆、推理模型的思考過程）會被切成分片逐條發出，SW 收齊
 * 還原。`reason` 說的是這一條為什麼廢了（amsg-sw 2.4.0-next.4 起帶；見 shared 的
 * `MULTIPART_FAILURE_REASON`），值得分開說：
 *
 *   - 等超時是**最常見也最無害**的一種——分片在路上、設備剛好離線了，跟用戶說
 *     「沒等齊」就夠，他重開一下多半就好；
 *   - 其餘幾種（分片對不上、超出本地限額、拼不回來、存儲寫不進去、本地把分片關了）
 *     說明發送端或鏈路真出了問題，重開沒用，得讓用戶知道這不是網絡抖一下。
 *
 * export 只為單測。
 */
export const describeMultipartFailure = (reason: unknown): string => {
  if (reason === MULTIPART_FAILURE_REASON.TTL_EXPIRED) {
    return '有一條消息沒接收完整（分片沒在時限內到齊），重開一下試試';
  }
  if (reason === MULTIPART_FAILURE_REASON.STORAGE_FAILED) {
    return '有一條消息沒接收完整：本機存儲寫不進去，清點空間後重試';
  }
  // 剩下的都是「發送端和接收端對不上」這一類，用戶自己做不了什麼，但要照實說，
  // 別讓他以為重開就能好。
  return '有一條消息沒接收完整（分片數據有問題），可以讓對方重發一次';
};

/**
 * 角色在本地已經不存在了：刪角色時遠端取消失敗留下的殘留，或者導入備份之後 id 對不上。
 * 與「暫時讀不到」區分開——這種重試多少次都沒用，得去把遠端那條還在到點跑的任務取消掉。
 */
export class OrphanedCharacterError extends Error {
  constructor(readonly charId: string) {
    super(`character not found for charId=${charId}`);
    this.name = 'OrphanedCharacterError';
  }
}

/** 處理失敗重試幾次後放棄（放棄 = 退回存原稿保底，見 resolveInboxFailureAction）。 */
export const MAX_INBOX_PROCESS_ATTEMPTS = 3;

export type InboxFailureAction = 'orphan' | 'retry' | 'degrade';

/**
 * 一條 push 處理失敗之後該怎麼辦。
 *
 * 默認是**留著重試**而不是就地存原稿：原稿裡的表情 / 卡片 / 轉帳都還是標記形態，存進
 * 聊天記錄後渲染層會把標記剝掉，用戶看到的是殘缺版，而角色下一輪讀歷史卻會當成
 * 「我已經發過表情、轉過帳了」——一次暫時的故障就這麼變成永久的錯誤前提。
 * 本地存儲的故障通常是暫時的，等一會兒重來一遍就好。
 *
 * 重試到上限還不行，才退回存原稿：那時候多半是真壞了，讓用戶看到殘缺版也好過什麼都沒有。
 */
export const resolveInboxFailureAction = (
  error: unknown,
  attempts: number,
): InboxFailureAction => {
  if (error instanceof OrphanedCharacterError) return 'orphan';
  return attempts < MAX_INBOX_PROCESS_ATTEMPTS ? 'retry' : 'degrade';
};

/**
 * 已經落庫的、屬於這條 push 的助手消息。
 *
 * 後處理是逐條落庫的（十幾處 DB.saveMessage），中途失敗時前面幾條已經在聊天記錄裡了。
 * 重試是整條從頭再跑，不先把這些清掉就會寫重——而重複進了聊天記錄是永久的。
 * 認領的依據是每條氣泡都繼承的 metadata.activeMsg2.messageId（每條 push 唯一，
 * 見 processInboxMessageWithPostProcessing 的 mcdInheritMeta）。
 */
export const findInboxArtifacts = <T extends { role: string; metadata?: any }>(
  messages: T[],
  messageId: string,
): T[] => messages.filter((m) =>
  m.role === 'assistant' && m.metadata?.activeMsg2?.messageId === messageId);

/**
 * 清場時可以刪的消息類型——只有「渲染型氣泡」：正文、表情包、HTML 卡片。
 *
 * 副作用產物（轉帳卡 / 戳一戳 / 音樂卡 / 新聞卡 / 日程提示 / 生活卡 / 小紅書卡…）一律
 * 留在原地：重試那一趟壓根不會再產一遍（副作用要麼隨 directives 走、本輪不重放，要麼像
 * XHS 那樣被 disabledXhsSideEffects 關掉），刪了就是永久少一張卡——而錢和日程是真的。
 *
 * 白名單制，將來新增的類型默認按「不刪」處理：寧可重複一條氣泡，也不憑空刪掉一張卡。
 */
export const PURGEABLE_ARTIFACT_TYPES: ReadonlySet<string> = new Set(['text', 'emoji', 'html_card']);

/**
 * 把這條 push 上一趟寫下的**渲染型氣泡**從聊天記錄裡刪掉。
 *
 * 返回兩個數，別混為一談：
 *   - removed：這次真刪了幾條（只數渲染型氣泡）；
 *   - evidence：上一趟到底有沒有留下過東西（連副作用產物一起數）。副作用要不要重放看它。
 */
export const purgeInboxArtifacts = async (
  message: ActiveMsg2InboxMessage,
): Promise<{ removed: number; evidence: number }> => {
  const recent = await DB.getRecentMessagesByCharId(message.charId, 200);
  const stale = findInboxArtifacts(recent, message.messageId);
  const purgeable = stale.filter((m) => PURGEABLE_ARTIFACT_TYPES.has(m.type));
  if (purgeable.length > 0) await DB.deleteMessages(purgeable.map((m) => m.id));
  return { removed: purgeable.length, evidence: stale.length };
};

/**
 * 重試前的清場：把上一次跑到一半寫進去的氣泡刪掉，並告訴調用方副作用還要不要重放。
 *
 * 後處理的順序是「先跑副作用（轉帳 / 加日程 / 戳一戳 / 排程），再渲染氣泡」，
 * 所以**只要看到上一趟留下的任何一條消息，就說明副作用那一步上次已經整段跑完了**。
 * 這時重放等於轉兩次帳、加兩次日程，比丟內容嚴重得多——所以這一趟只補渲染，不帶 directives。
 * 一條都沒留下才說明上次死在副作用途中，那時 directives 還得照常帶上，
 * 否則這條消息的副作用就徹底沒了。
 *
 * 「憑據」和「刪除對象」是兩回事：副作用產物（轉帳卡等）算憑據但不刪——它們跟正文氣泡
 * 帶著同一個 activeMsg2.messageId，刪掉又不重放的話，那張卡就永遠回不來了。
 */
const prepareInboxRetry = async (
  message: ActiveMsg2InboxMessage,
): Promise<{ replayDirectives: boolean }> => {
  if (!(message.processAttempts && message.processAttempts > 0)) return { replayDirectives: true };
  const { removed, evidence } = await purgeInboxArtifacts(message);
  if (evidence === 0) return { replayDirectives: true };
  log.warn('重試前清掉上次寫了一半的氣泡（副作用上次已跑完，本輪不重放，產物留在原地）', {
    messageId: message.messageId,
    removed,
    evidence,
  });
  return { replayDirectives: false };
};

const processInboxMessageWithPostProcessing = async (
  message: ActiveMsg2InboxMessage,
  // 由 flushInboxToChat 按 resolveInboxPersistTimestamp 算好: 離線補收 = sentAt,
  // 在線送達 = undefined (落庫走 DB.saveMessage 默認的寫庫當刻)。
  persistTimestamp?: number,
): Promise<void> => {
  // 這一趟從雲端旁路存儲取回來的東西，等整條消息處理成功了再去刪（見 OffloadedCleanup）。
  const offloadedCleanups: OffloadedCleanup[] = [];
  const characters = await DB.getAllCharacters();
  const char = characters.find(c => c.id === message.charId);
  if (!char) {
    // 一個角色都讀不到，多半是本地存儲本身出了問題，而不是「這個角色被刪了」——
    // 按可重試的普通失敗處理，別把還在用的任務當孤兒取消掉。
    if (characters.length === 0) {
      throw new Error(`character lookup returned empty for charId=${message.charId}`);
    }
    throw new OrphanedCharacterError(message.charId);
  }

  // 這是不是一次重試？是的話先清掉上次的半成品，並決定副作用要不要再跑一遍。
  const { replayDirectives } = await prepareInboxRetry(message);

  const userProfile: UserProfile = (await DB.getUserProfile())
    ?? { name: 'User', avatar: '', bio: '' };
  // 按角色可見性過濾表情包：後處理落庫時靠 emojis.find(e => e.name === name) 反查 URL，
  // 若傳全量表情，名字衝突時會把 A 的 [[SEND_EMOJI: x]] 匹配到 B 名下的同名表情，導致
  // A 發出綁定給 B 的表情包。本地聊天路徑喂的是 aiVisibleEmojis（已過濾），主動消息路徑
  // 之前漏了這步，這裡複用同一套過濾收口（與 activeMsgClient.buildCompletePrompt 對齊）。
  const { emojis, categories } = ChatPrompts.filterVisibleEmojis(
    await DB.getEmojis(),
    await DB.getEmojiCategories(),
    message.charId,
  );
  const contextMsgs = await loadCharacterContextMessages(char);

  const apiConfig = loadApiConfigFromLocalStorage();
  const realtimeConfig = loadRealtimeConfigFromLocalStorage();

  // Phase 1: 副作用 (DIARY 寫入等) 會調 DB.saveMessage, 它內部已經 fire 'messages-updated' 事件;
  // 但 OSContext 真正驅動 chat UI 重新 reloadMessages 的是 lastMsgTimestamp, 而那個 state 現在
  // 只由 'active-msg-received' handler 改。為了讓 push 路徑下的 per-chunk 落庫也立刻反映到 UI,
  // 用一個獨立的 side-channel 事件 'active-msg-progress': OSContext 監聽它後只 setLastMsgTimestamp,
  // 不 fire toast / 不增加未讀。
  // 單條 inbox message 進來時 fire 一次 'active-msg-received' 即可保證 toast / 未讀 / 通知一次發生。
  const dispatchProgress = () => {
    window.dispatchEvent(new CustomEvent('active-msg-progress', {
      detail: { charId: message.charId },
    }));
  };

  // messageIndex 來源: SW 在 saveContentToInbox 把 payload.messageIndex 寫到 metadata, 1-based
  // (第 1 條 → messageIndex=1); 沒這個字段時 ?? 0 fallback.
  const sessionId: string | undefined = (message as any).sessionId
    || (message.metadata && (message.metadata as any).sessionId);
  const messageIndex: number = (message as any).messageIndex
    ?? (message.metadata && (message.metadata as any).messageIndex)
    ?? 0;
  // 思考鏈掛在第一條 content push 的 metadata.amsgReasoning 上（太長時挪進 client_state、
  // 只留 amsgReasoningRef，見 worker/amsg/src/index.ts 的 offloadOversizedPush），
  // 只在第一條上取，渲染成第一條 assistant message 的 metadata.thinkingChain。
  // 定時任務那條路 worker 刻意不帶思考（prompt 裡沒有「心象」提示詞，原始推理腔當卡片
  // 是穿幫），所以這裡也不會有值——收側不用另設門。
  let reasoningContent: string | undefined;
  if (messageIndex <= 1) {
    const inlineReasoning = (message.metadata as any)?.amsgReasoning;
    const metaReasoning = typeof inlineReasoning === 'string' && inlineReasoning
      ? inlineReasoning
      : await fetchOffloadedReasoning(message, offloadedCleanups);
    if (typeof metaReasoning === 'string' && metaReasoning.trim()) {
      reasoningContent = metaReasoning;
    }
  }

  // XHS 工具在 worker 裡跑. worker 把 directive 引用到的筆記/xsecToken 隨最後一條 push 的
  // metadata.xhsSession 帶回來 (稀疏 {idx, note}, idx 1-based, 見 worker/amsg/src/agentic.ts
  // buildXhsSessionPayload), 這裡重建成按序號取卡的數組先落庫, 下面的恢復塊再讀回內存單例
  // ——XHS_SHARE / 點贊 / 評論重放才能按序號找到卡片.
  // 裝不進一條 push（4KB 密文上限）的時候 worker 會把整份挪進 client_state、只在
  // metadata 留一個 xhsSessionRef 指過來（見 worker/amsg/src/index.ts 的
  // offloadOversizedPush）。這裡按鍵取回，取到就跟內聯那份走同一條落庫路徑。
  // 取不回來時拋錯交給上層重試——靜默跳過的話，角色說分享了幾張、卡片卻少幾張。
  const xhsSession = (message.metadata && (message.metadata as any).xhsSession)
    || await fetchOffloadedXhsSession(message, offloadedCleanups);
  if (sessionId && xhsSession && Array.isArray(xhsSession.notes) && xhsSession.notes.length > 0) {
    try {
      const maxIdx = Math.max(...xhsSession.notes.map((e: any) => Number(e?.idx) || 0));
      const rebuilt: Array<XhsNote | null> = new Array(Math.max(0, maxIdx)).fill(null);
      for (const entry of xhsSession.notes) {
        const i = Number(entry?.idx);
        if (Number.isInteger(i) && i >= 1 && entry?.note) rebuilt[i - 1] = entry.note as XhsNote;
      }
      await ActiveMsgStore.saveXhsSessionNotes(sessionId, {
        notes: rebuilt as XhsNote[],
        xsecTokens: Array.isArray(xhsSession.xsecTokens) ? xhsSession.xsecTokens : [],
      });
    } catch (e) {
      console.warn('[ActiveMsg] persist xhsSession from push failed', sessionId, e);
    }
  }

  // 恢復本 session 工具抓到的 XHS 筆記: 上面落了庫, 這裡讀回內存單例.
  // 跨 SW 喚醒 / 頁面回收後內存 ref 被清空, 不恢復的話 [[XHS_SHARE]] / 評論 / 點贊
  // 會因 lastXhsNotesRef 為空而靜默掉卡片. 持久化優先於內存 (同 session 時兩者等價, 重載後只剩持久化).
  if (sessionId) {
    try {
      const persisted = await ActiveMsgStore.getXhsSessionNotes(sessionId);
      if (persisted?.notes?.length) {
        pushLastXhsNotesRef.current = persisted.notes as XhsNote[];
        for (const [noteId, token] of (persisted.xsecTokens || [])) {
          pushXhsCaches.xsecTokenCache.set(noteId, token);
        }
      }
    } catch (e) {
      console.warn('[ActiveMsg] restore xhs session notes failed', sessionId, e);
    }
  }

  await applyAssistantPostProcessing(message.body || '', {
    char,
    userProfile,
    emojis,
    categories,
    realtimeConfig,
    // 雲端回覆裡的發照片（worker 以 soren_tag 送回）要靠它才生得出來；沒配就照舊剝掉不生
    imageGenConfig: apiConfig.imageGenConfig,
    // 日程改動按「角色說這句話的那一刻」判，不是按現在——這條可能在收件箱裡躺了一夜，
    // 昨晚的「22:00 改成陪你聊天」不該落到今天的 22:00 上。
    spokenAt: message.sentAt,
    contextMsgs,
    // fullMessages / initialData: worker 不會傳過來 (Phase 2 才有續跑), 二輪 LLM 又被關掉,
    // 這兩個字段在 skipSecondPassLLM=true 時實際上不會被消費; 給個最小佔位避免 undefined NPE。
    fullMessages: [],
    initialData: null,
    historyMsgCount: contextMsgs.length,
    // 把 source / activeMsg2 元數據通過 mcdInheritMeta 繼承到每條 assistant message, 這樣
    // UI 還能區分 "這條是 push 來的"。
    mcdInheritMeta: {
      source: 'active_msg_2',
      activeMsg2: {
        messageId: message.messageId,
        taskId: message.taskId,
        messageType: message.messageType,
        messageSubtype: message.messageSubtype,
        avatarUrl: message.avatarUrl,
        sentAt: message.sentAt,
        receivedAt: message.receivedAt,
      },
      // push 自己那份也得鋪進去：worker 隨這條 push 捎回來、要落到氣泡上給用戶看的東西
      // （amsgToolTrace 這類）只有這一條路進 metadata，漏了就靜默沒了。
      // 注意它排在最後，同名字段會蓋掉上面那幾個固定的——worker 哪天往 push metadata 裡
      // 塞了個叫 source / activeMsg2 的字段，重試認領就會跟著歪。
      ...(message.metadata || {}),
    },
    xhsCaches: pushXhsCaches,
    lastXhsNotesRef: pushLastXhsNotesRef,
    api: {
      baseUrl: apiConfig.baseUrl,
      headers: {
        'Content-Type': 'application/json',
        ...(apiConfig.apiKey ? { Authorization: `Bearer ${apiConfig.apiKey}` } : {}),
      },
      // effectiveApi 在 push 路徑裡沒人讀 — skipSecondPassLLM=true 把所有二輪 LLM 入口都堵了。
      // 留著只為滿足 ctx 類型形狀; Phase 2 worker 走續跑時也不會讓客戶端再發 LLM 請求, 所以這裡
      // 長期就是個空架子, 不要花精力同步 os_api_presets / os_available_models 等運行時切換。
      effectiveApi: {
        baseUrl: apiConfig.baseUrl,
        apiKey: apiConfig.apiKey,
        model: apiConfig.model,
      },
    },
    hooks: {
      // setMessages 在 React 外面跑, 沒法直接 setState, 只 fire 一次 progress 事件讓
      // OSContext 推 lastMsgTimestamp, 然後 Chat.tsx 自然 reloadMessages 重新讀庫。
      setMessages: () => { dispatchProgress(); },
      // push 路徑 deliberately 靜默 toast — 避免在用戶沒在 chat 這個角色時狂彈 toast。
      // 如果真要給用戶可見反饋, 應該走 'active-msg-received' 那條線 (toast / 未讀 / 通知)。
      addToast: (msg: string, type: 'info' | 'success' | 'error') => {
        console.log('[push:toast]', type, msg);
      },
      // 日程改動沒落地是個例外：角色的消息裡已經寫著「那我今晚不睡了」，日程卡卻紋絲
      // 不動，用戶看到的是兩邊對不上而沒有任何解釋。走 active-msg-process-failed——
      // 已有的可見通道，自帶每角色 60 秒節流，不會因為一串推送而狂彈。
      notifyScheduleChangeFailed: (note: string) => {
        notifyInboxProcessFailed(message, 'schedule-missed', '后处理', note);
      },
      // musicHooks: 由 MusicProvider 註冊到模塊級 slot, 與 useChatAI 同一份, 見 MusicContext.loadMusicHooks.
      // slot 未填充時 (理論上 MusicProvider 未 mount, 實際單頁應用不會發生) 退化為 undefined,
      // ChatParser 會靜默丟棄 MUSIC_ACTION 標籤 — 跟 Phase 1 老行為兜底一致, 不會引入新 failure mode.
      // 注意 snapshot 時序: 這裡讀取的是 push 送達時的 current song, 而不是 AI 當時看到的那幀.
      // 本地 fetch 路徑也有相同窗口 (LLM 響應耗時內 current 可能漂移), 接受同一 trade-off.
      musicHooks: loadMusicHooks() ?? undefined,
    },
    skipSecondPassLLM: true,
    // 把 worker hook 塞進 metadata.directives 的副作用結構化重放出來 (POKE/TRANSFER/ADD_EVENT/
    // schedule_message/MUSIC_ACTION/XHS_*). applyAssistantPostProcessing 會反向拼回 tag 餵給
    // chatParser + 內聯 XHS handler.
    // 一個 user turn 可能產 N 條 push, directives 只應該
    // replay 一次. worker 把 directives 掛在最後一條 push 上,
    // 這裡加 isLastChunk 守衛雙保險, 防未來 worker bug 在多條 push 都塞 directives.
    // 老 worker (無 messageIndex/totalMessages 字段) ?? 0 fallback, 0===0 也算 last.
    // replayDirectives=false = 這是重試、且上次已經把副作用跑完了（見 prepareInboxRetry）。
    directives: replayDirectives && isLastChunk(message) ? extractDirectives(message) : [],
    reasoningContent,
    // 這條 push 拆出的每條氣泡共用一個時間戳 (跟降級存原稿路徑同口徑), 見
    // resolveInboxPersistTimestampForMessage。
    messageTimestamp: persistTimestamp,
    // 三種情況跳過擬人打字延遲、一次性回填，共同點是「用戶已經讀過這句話了，再演一遍
    // 打字過程只剩乾等」：
    //   1. 補收：內容幾小時前就在雲端生成完了，慢放期間用戶插的話還會把時間戳倒掛的
    //      口子撐開（見 resolveBackfillTimestamp）。判據是補收路徑蓋的標記，**不是**
    //      到達時間——那個會被補收自己改寫（見 isOutboxBackfill 的說明）。
    //   2. 在收件箱裡躺了一陣才被撈出來的。
    //   3. 送達時人不在場：系統通知已經把整句話完整顯示過，他是看著通知點進來的。
    // App 在前台時收到的實時消息照舊慢放——那才是「角色正在你眼前打字」的場景。
    instantRender: shouldRenderInstantly(message.metadata, message.receivedAt, Date.now()),
  });

  // ─── 即時對話（amsg2）的情緒評估結果 ───
  // 雲端跟主回覆並行跑完的那份，掛在最後一條 push 的 metadata 上（裝不下時挪進
  // client_state、只留 amsgEmotionRef，見 worker 的 offloadOversizedPush）。
  // 跟單獨一條 emotion_update 消息走同一條消費鏈：同一個 applyEmotionEvalRaw
  // 落 buff、同一個 'emotion-innerstate-updated' 喂下一輪、同一個 emotionDone
  // 熄燈，不另寫第二套解析。
  //
  // 排在正文落庫之後：這一條消息的本體是角色說的那句話，情緒只是附贈，
  // 順序反了的話正文出問題時情緒已經先落了。
  //
  // amsgEmotionDone 是「這一輪的評估已經有結論了」，成敗都帶：只在有結果時才發信號的話，
  // 評估一失敗徽章就得亮到十幾分鍾後才由安全網熄，而用戶看到的是「情緒永遠不更新」。
  const emotionDone = (message.metadata as any)?.amsgEmotionDone === true;
  // 晚投標記：評估沒趕上這條回覆的順風車，worker 收尾時才把結果寫進旁路存儲。
  // 此刻旁路鍵多半還是空的，跳過一次性取回（免得白打一個「被下一輪覆蓋了」的 warn），
  // 改為對引用鍵輪詢補落，燈繼續亮著。
  const emotionPending = (message.metadata as any)?.amsgEmotionPending === true;
  const inlineEmotionUpdate = (message.metadata as any)?.amsgEmotionUpdate;
  // 這條消息帶來了新一輪的情緒結論（成 / 敗 / 晚投）→ 上一輪還在跑的補落輪詢作廢：
  // 舊結果這時再落下去會蓋掉新一輪的 buff。
  if (emotionDone || emotionPending || (typeof inlineEmotionUpdate === 'string' && !!inlineEmotionUpdate)) {
    cancelLateEmotionPoll(message.charId);
  }
  const emotionUpdateRaw = typeof inlineEmotionUpdate === 'string' && inlineEmotionUpdate
    ? inlineEmotionUpdate
    : (emotionPending ? null : await fetchOffloadedEmotionUpdate(message, offloadedCleanups));
  if (emotionUpdateRaw) {
    await landCloudEmotionResult(message.charId, emotionUpdateRaw);
  } else if (emotionPending) {
    const pendingRef = (message.metadata as any)?.amsgEmotionRef;
    if (typeof pendingRef === 'string' && pendingRef) {
      startLateEmotionPoll(message.charId, pendingRef, message.charName || '');
    } else {
      // 標了 pending 卻沒給引用鍵（worker bug）：沒法輪詢，按「有結論但沒結果」收尾。
      announceChatGen(CHAT_GEN_EVENTS.emotionFailed, {
        charId: message.charId, charName: message.charName || '',
        reason: '雲端情緒評估晚投但缺少引用鍵（worker 可能有 bug），這一輪不更新',
      });
      announceEmotionDone(message.charId);
    }
  } else if (emotionDone) {
    // 雲端跑了但沒跑出東西。不靜默熄燈——彈一條 toast，否則用戶只看到「情緒更新中」滅了、
    // 情緒沒變、沒有任何解釋。worker 捎回來的那句原因（副 API 的狀態碼 / 模型沒輸出）
    // 直接給用戶看：他自己部署的 worker，「可查日誌」對多數人等於沒說。
    const workerReason = (message.metadata as any)?.amsgEmotionError;
    // 統一走 announceChatGen（chatGenEvents 的唯一派發出口），別再手寫 dispatchEvent。
    announceChatGen(CHAT_GEN_EVENTS.emotionFailed, {
      charId: message.charId, charName: message.charName || '',
      reason: typeof workerReason === 'string' && workerReason
        ? `雲端情緒評估失敗——${workerReason}`
        : '雲端情緒評估無輸出（副 API 報錯或模型沒返回內容，可查 worker 日誌）',
    });
  }
  if (emotionDone || emotionUpdateRaw) {
    announceEmotionDone(message.charId);
    activeMsgTrace('runtime-emotion-done', {
      sessionId: getInstantSessionId(message),
      messageId: message.messageId,
      charId: message.charId,
    });
  }

  // ─── push 尾段 ───
  // Memory Palace 緩衝區處理在這裡跑 (跟本地 fetch 路徑 finally 段對齊, 不依賴 React).
  // 情緒評估不在這裡跑: 雲端已經跟主回覆一起跑完, 結果就是上面落的那份.
  await runPushTailPipeline(message, char, userProfile);

  // 到這裡這條消息才算真的落定（上面任何一步拋錯都會讓它被壓回收件箱重試），
  // 這時候刪雲端那幾份旁路副本才是安全的。不 await：刪是讓 D1 乾淨點的收尾動作，
  // 不能讓一次網絡往返拖住收件箱裡後面幾條的落庫。
  void runOffloadedCleanups(offloadedCleanups);
};

/**
 * 這條 inbox message 是不是它所在 session 的**最後一條 chunk**.
 * messageIndex == totalMessages → 最後一條 ✓
 * 都缺失 (老 worker / proactive push 單 push) → 0 === 0 也認 last
 */
function isLastChunk(message: ActiveMsg2InboxMessage): boolean {
  const mi = Number(message.metadata?.messageIndex ?? 0);
  const tm = Number(message.metadata?.totalMessages ?? 0);
  return mi === tm;
}

/**
 * 送達時的作廢判定（防穿幫閘·客戶端兜底層）。worker onBeforeFire 已做同一
 * 判定，但它讀的 fire_pack 隨 amsgStateSync 最多滯後 15s+，且判定通過後還有
 * 10-30s 生成窗口，期間用戶又說話就會撞車——這裡用本地全量歷史再判一次。
 * 判定所需字段全部來自 push 自己帶的，不依賴本地 config——push 在途期間任務被 renew
 * 換錨也不會誤判。其中 recurrenceType / occurrenceMs 讀 push 頂層那份（庫蓋的，兩條
 * 排程路徑同源）；策略與錨點是應用自己的語義，仍在任務 metadata 裡。
 *
 * **讀不到聊天記錄時拋錯，不猜。** 拿不準就先別開口：調用方會把消息壓回收件箱、
 * 過一會兒等本地存儲緩過來再判一次（見 flushInboxToChatImpl 的 expire-unknown 分支）。
 * 猜「放行」的代價是角色可能當著正在聊天的用戶冒出一句定時問候，一眼假。
 */
/**
 * 一次 fire 的歸屬鍵：吞放緩存按它記（多分段同吞同放），trace 也按它歸組。
 *
 * 必須含 occurrence——sessionId 對循環任務的每次觸發、對同一次的每次重試都可能重複，
 * 裸用會把上次的判定串給下一次。兩處調用抄兩份的話，改一處就會靜默失聯（緩存按新鍵
 * 存、trace 按舊鍵歸組），所以公式只在這裡寫一次。
 */
const buildFireKey = (message: ActiveMsg2InboxMessage): string =>
  `${(message.metadata as any)?.amsgClientTaskId}:${message.occurrenceMs ?? ''}`;

async function evaluateScheduledPushExpired(message: ActiveMsg2InboxMessage): Promise<boolean> {
  const meta = (message.metadata || {}) as Record<string, any>;
  const messages = await DB.getRecentMessagesByCharId(message.charId, 200);
  const input = {
    policy: meta.amsgExpirePolicy,
    lastUserMessageAt: getLastRealUserMessageAt(messages),
    nowMs: Date.now(),
    // 窗口錨定到點時刻而不是送達時刻：生成+送達可能比到點晚十幾分鍾，拿 Date.now()
    // 算 10 分鐘窗會把撞上對話的消息誤放行。
    occurrenceMs: message.occurrenceMs ?? undefined,
  };
  const expired = shouldExpireFire(input);
  // 判定輸入原樣留一行，**放行也留**。吞掉是這條鏈路上唯一「用戶什麼都看不到」的出口
  // （不進聊天流、不彈提示、還會去雲端帳本銷帳），事後只剩這一行說得出發生過什麼；
  // 而放行同樣要留——三種去向（吞了 / 放行了 / 閘沒跑，見調用方的
  // runtime-expire-gate-skipped）各留各的痕，才不用靠別的 trace 反推是哪一種。
  // 判定每次 fire 只跑一趟（多分段共用緩存），不會刷屏。
  // 與 worker 的 [amsg:expire-skip] / [amsg:expire-pass] 字段同源：兩邊結論分叉時
  // （worker 放行、客戶端吞掉）對照著看就知道是哪個字段不一樣。
  activeMsgTrace(expired ? 'runtime-expire-decision-swallow' : 'runtime-expire-decision-pass', {
    sessionId: buildFireKey(message),
    messageId: message.messageId,
    charId: message.charId,
    taskId: message.taskId,
    // 判定本身已經不看任務類型了（一次性和循環同一條規則），但排查時得認得出這是哪種任務。
    recurrenceType: message.recurrenceType ?? undefined,
    ...input,
  });
  return expired;
}

/**
 * 雲端自述日誌裡這條 push 對應的條目 id。
 *
 * 格式跟 worker 寫日誌時用的那一份對齊（`<clientTaskId>@<觸發時刻>`，見 amsgFirePack
 * 的 AmsgSelfLogEntry.id 與 worker/amsg/src/index.ts 的 amsgFireSettled）——兩邊拼法
 * 必須一模一樣，差一個字符就對不上號。缺任務歸屬鍵時 worker 用的是字面量 'task'。
 * 觸發時刻缺失（老 push 不帶）返回 null：沒有 id 就沒法精確認領，寧可不動。
 */
export const buildSelfLogEntryId = (message: ActiveMsg2InboxMessage): string | null => {
  const occurrenceMs = message.occurrenceMs;
  if (typeof occurrenceMs !== 'number' || !Number.isFinite(occurrenceMs)) return null;
  const clientTaskId = (message.metadata as any)?.amsgClientTaskId;
  const owner = typeof clientTaskId === 'string' && clientTaskId ? clientTaskId : 'task';
  return `${owner}@${occurrenceMs}`;
};

/**
 * 被兜底閘吞掉的這條，順手把雲端「我說過什麼」裡對應的那條也撤掉。
 *
 * 不撤的話：worker 發完就把正文記進了 client_state 的 self_log，而這條消息在客戶端被吞、
 * 用戶一個字都沒看到；下一次到點的 prompt 裡【這之後你又主動發過】赫然列著它，角色接著
 * 往下說一句沒人看過的話。
 *
 * 只摘被吞的那一條，其餘原樣留著：日誌裡別的條目是用戶真收到過的話，跟著一起抹掉的話
 * 角色反而會把說過的再說一遍；角色自排的任務清單同理，缺一塊下次就會把同一件事再排一遍。
 * 摘完整份空了（沒有條目也沒有任務）就直接寫空串——空日誌和沒有日誌對 worker 是同一件事
 * （parseSelfLog 拿不到 → 重新建一份空的），比留一份空殼 JSON 省事。
 *
 * 值是裸 JSON，跟 worker 寫這份時的口徑一致（amsgFireSettled 裡也是 JSON.stringify 直傳，
 * 不走 fire_pack 那套壓縮）。
 *
 * best-effort：讀寫失敗只留 warn，不影響「吞」這個動作本身（與 worker 側 writeLastSkip 同語義）。
 */
export const revokeSwallowedSelfLogEntry = async (
  charId: string,
  entryId: string,
): Promise<'no-log' | 'not-found' | 'cleared' | 'rewritten'> => {
  const namespace = amsgStateNamespace(charId);
  const raw = await ActiveMsgClient.readClientStateValue(namespace, AMSG_SELF_LOG_KEY);
  const selfLog = parseSelfLog(raw ?? '');
  if (!selfLog) return 'no-log';
  const revoked = selfLog.entries.find((e) => e.id === entryId);
  if (!revoked) return 'not-found';

  const rest = selfLog.entries.filter((e) => e.id !== entryId);
  if (rest.length === 0 && selfLog.tasks.length === 0) {
    await ActiveMsgClient.clearClientStateValue(namespace, AMSG_SELF_LOG_KEY);
    return 'cleared';
  }
  // 連發計數也要跟著退回去，規則跟 appendSelfLogEntry 的加法一一對應（reply 當初就沒加，
  // 這裡也不減）。不減的話，用戶清空聊天記錄那條吞消息的分支會留下一筆糊塗帳：那時
  // lastUserMessageAt 是 null，下一次 fire 的 reconcileSelfLogWithPack 歸零條件夠不到，
  // 這些用戶根本沒看見的消息會一直佔著連發額度，直到額度滿、正常的主動消息被攔下，
  // 面板還說「你未回覆期間 ta 連發已到上限」。
  await ActiveMsgClient.writeClientStateValue(
    namespace,
    AMSG_SELF_LOG_KEY,
    JSON.stringify({
      ...selfLog,
      entries: rest,
      unansweredSends: Math.max(0, selfLog.unansweredSends - (revoked.reply ? 0 : 1)),
    }),
  );
  return 'rewritten';
};

/**
 * 認領到新任務之後廣播的事件名。detail 只帶 charId，監聽方（OSContext）自己重讀角色、
 * 把新任務合併進內存清單並打髒。事件名和 detail 形狀是兩側的約定，改這裡要同步改那邊。
 */
export const AMSG2_TASKS_ADOPTED_EVENT = 'amsg2-tasks-adopted';

/**
 * 把 worker 帶回來的「角色自排任務」補進該角色的本地清單。
 *
 * 冪等: 同 uuid 已經在清單裡就不重複加(同一條 push 重放、或者 fire 重跑發了兩次都可能撞上).
 * best-effort: 寫不進去不影響這條消息本身——任務在遠端好好的, 下次面板拉遠端清單還能看見,
 * 只是這一刻本地少一行. 為它拋錯會把已經收到的消息一起搞掛.
 *
 * 落庫之後要廣播一聲: 這裡跑在 React 之外, 只寫 IndexedDB 的話內存裡那份角色清單還是舊的,
 * 任務面板列不出這條、按任務數 / 憑據 / 訂閱這幾道門做判斷的地方也都看不見它。
 */
async function adoptSelfScheduledTasks(message: ActiveMsg2InboxMessage): Promise<void> {
  const incoming = (message.metadata as any)?.amsgSelfScheduled;
  if (!Array.isArray(incoming) || incoming.length === 0) return;
  const charId = (message.metadata as any)?.charId;
  if (typeof charId !== 'string' || !charId) return;

  try {
    const char = (await DB.getAllCharacters()).find((c) => c.id === charId);
    if (!char) return;
    const existing = char.activeMsg2Config?.tasks ?? [];
    const known = new Set(existing.map((t: ActiveMsg2TaskRecord) => t.taskUuid));
    const added = incoming.filter((t: any) => t?.taskUuid && !known.has(t.taskUuid));
    if (added.length === 0) return;

    await DB.saveCharacter({
      ...char,
      activeMsg2Config: {
        ...(char.activeMsg2Config ?? { enabled: true }),
        tasks: pruneStaleTasks([...existing, ...added], Date.now()),
      },
    });
    console.log('[ActiveMsg] 認領角色自排任務', added.map((t: any) => t.taskUuid));
    // 只在真的新增了任務時才廣播（上面 added.length === 0 已經提前 return），
    // 免得同一條 push 重放時白白讓 UI 重讀一遍角色。
    try {
      window.dispatchEvent(new CustomEvent(AMSG2_TASKS_ADOPTED_EVENT, { detail: { charId } }));
    } catch { /* SSR-safe / not browser, ignore */ }
  } catch (e) {
    console.warn('[ActiveMsg] adopt self-scheduled tasks failed', charId, e);
  }
}

/**
 * 把 worker 帶回來的「角色取消 / 改期了既有任務」落到本地清單（amsgTaskMutations，
 * 與 adoptSelfScheduledTasks 對稱的消帳側）。
 *
 * 冪等：取消的 uuid 本地已經沒有、改期的時間已經一致時都是 no-op（同一條 push 重放安全）。
 * best-effort：失敗只 warn——遠端行已經刪掉 / 改掉了，本地這一刻沒跟上只是面板顯示舊，
 * 下次對帳還能拉平，為它拋錯會把已經收到的消息一起搞掛。
 */
async function applyRemoteTaskMutations(message: ActiveMsg2InboxMessage): Promise<void> {
  const raw = (message.metadata as any)?.amsgTaskMutations;
  if (!raw || typeof raw !== 'object') return;
  const cancelled: string[] = Array.isArray(raw.cancelled)
    ? raw.cancelled.filter((u: unknown) => typeof u === 'string' && u)
    : [];
  const renewed: Array<{ taskUuid: string; sendAt: string }> = Array.isArray(raw.renewed)
    ? raw.renewed.filter((r: any) => typeof r?.taskUuid === 'string' && typeof r?.sendAt === 'string')
    : [];
  if (cancelled.length === 0 && renewed.length === 0) return;
  const charId = (message.metadata as any)?.charId;
  if (typeof charId !== 'string' || !charId) return;

  try {
    const char = (await DB.getAllCharacters()).find((c) => c.id === charId);
    const existing = char?.activeMsg2Config?.tasks ?? [];
    if (!char || existing.length === 0) return;

    const gone = new Set(cancelled);
    const renewedAt = new Map(renewed.map((r) => [r.taskUuid, r.sendAt]));
    const next = existing
      .filter((t: ActiveMsg2TaskRecord) => !gone.has(t.taskUuid))
      .map((t: ActiveMsg2TaskRecord) => {
        const sendAt = renewedAt.get(t.taskUuid);
        return sendAt && t.nextSendAt !== sendAt
          ? { ...t, firstSendTime: sendAt, nextSendAt: sendAt }
          : t;
      });
    const changed = next.length !== existing.length
      || next.some((t: ActiveMsg2TaskRecord, i: number) => t !== existing[i]);
    if (!changed) return;

    await DB.saveCharacter({
      ...char,
      activeMsg2Config: { ...(char.activeMsg2Config ?? { enabled: true }), tasks: next },
    });
    console.log('[ActiveMsg] 消帳角色取消/改期的任務', { cancelled, renewed });
    // 與認領共用同一個事件：監聽方（OSContext）做的是「重讀角色」，增刪改對它是一回事。
    try {
      window.dispatchEvent(new CustomEvent(AMSG2_TASKS_ADOPTED_EVENT, { detail: { charId } }));
    } catch { /* SSR-safe / not browser, ignore */ }
  } catch (e) {
    console.warn('[ActiveMsg] apply remote task mutations failed', charId, e);
  }
}

/** 把 worker 推給的 directives 從 inbox message metadata 裡挖出來; 沒有就空數組. */
function extractDirectives(message: ActiveMsg2InboxMessage): PostProcessDirective[] {
  const raw = message.metadata && (message.metadata as any).directives;
  if (!Array.isArray(raw)) return [];
  // 字段形狀由 worker classifier 保證 (跟 PostProcessDirective union 一致); 這裡只做輕量校驗
  // 防 metadata 被改壞. 不識別的 type 不拋錯, applyAssistantPostProcessing 內部 default 分支會 warn.
  return raw.filter((d) => d && typeof d === 'object' && typeof (d as any).type === 'string');
}

function getInstantSessionId(message: ActiveMsg2InboxMessage): string | undefined {
  return (message as any).sessionId
    || (message.metadata && (message.metadata as any).sessionId);
}

function getInstantMessageIndex(message: ActiveMsg2InboxMessage): number {
  return Number((message as any).messageIndex ?? (message.metadata as any)?.messageIndex ?? 0);
}

/**
 * 跑 push 路徑的尾段: Memory Palace 緩衝區處理 + 通知 UI 重讀角色 buff.
 *
 * Memory Palace 直接在這裡跑 (pipeline 內部 self-contained, 不依賴 React state).
 */
async function runPushTailPipeline(
  message: ActiveMsg2InboxMessage,
  char: import('../types').CharacterProfile,
  userProfile: UserProfile,
): Promise<void> {
  // 1. Memory Palace
  const mpConfig = loadMemoryPalaceConfigFromLocalStorage();
  const mpEmb = mpConfig?.embedding;
  const mpLLMConfigured = mpConfig?.lightLLM;
  const apiConfig = loadApiConfigFromLocalStorage();
  const mpLLM = (mpLLMConfigured?.baseUrl)
    ? mpLLMConfigured
    : { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model };

  if ((char as any).memoryPalaceEnabled && mpEmb?.baseUrl && mpEmb?.apiKey && mpLLM.baseUrl) {
    try {
      const recentMsgs = await DB.getRecentMessagesByCharId(char.id, 50);
      // fire-and-forget: pipeline 內部有併發鎖 + 水位線檢查, 不會搶著跑兩份
      void processNewMessagesWithAutoArchive(
        recentMsgs,
        char.id,
        char.name,
        mpEmb,
        mpLLM,
        userProfile?.name || '',
        false,
        (stage) => { console.log('[push:memory-palace]', stage); },
      ).catch((e) => {
        console.warn('[push:memory-palace] processNewMessages failed', e);
      });
    } catch (e) {
      console.warn('[push:memory-palace] tail kickoff failed', e);
    }
  }

  // 2. 情緒評估在 worker 跑 (副 API), 結果隨 push 回來由 landCloudEmotionResult 落 buff.
  // 這裡不觸發客戶端 eval (否則 worker + 客戶端雙跑雙扣費).

  // 順手通過 message 觸發 'emotion-updated' (跟 useChatAI line 382 一致), 讓 UI 重新讀 char.
  // 注意: 這裡的 emotion-updated 是給 ChatHeader 的 buff 顯示信號, 不是情緒 eval 完成信號 —
  // 真正的 eval 完成由 useChatAI 內 evaluateEmotionBackground 自己 dispatch 同名事件.
  try {
    window.dispatchEvent(new CustomEvent('emotion-updated', { detail: { charId: char.id } }));
  } catch { /* SSR-safe / not browser, ignore */ }
}

/**
 * 「剛送達」與「補收」的分界（毫秒），只用來決定**要不要慢放擬人打字節奏**。
 *
 * 後處理管線每條氣泡之間夾 0.5~2 秒 setTimeout，模擬角色正在打字。實時收到時這是對的；
 * 補收的消息早在幾小時前就在雲端生成完了，再慢放一遍只會讓用戶乾等著一條條冒，
 * 而且這段時間裡用戶來得及插話，把時間戳倒掛的口子撐開（見 resolveBackfillTimestamp）。
 *
 * 取 2 分鐘：前台連收幾條排隊處理最多幾十秒，仍算剛到；而「看到通知再點進來」通常
 * 好幾分鐘起步，會落到補收那一側。
 */
export const INBOX_FRESH_DELIVERY_WINDOW_MS = 2 * 60_000;

/**
 * 這條消息是不是從雲端帳本補收回來的（true = 一次性回填，不演打字）。
 *
 * **判據是補收路徑寫庫時蓋的那個標記，不是消息上的到達時間。** 補收在寫庫時會把整批
 * 消息的到達時間統一改寫成「現在」（一次 Date.now() 全批共用），所以拿到達時間去問
 * 「這條是不是剛到的」，答案永遠是「剛到」——補收就這麼把自己偽裝成了實時消息，然後
 * 一條條演打字，而它的內容其實早就在系統通知裡被完整讀過了。
 * 這個標記只有補收路徑帶，SW 直送的那份刻意不帶（見 outboxPushToInbox）。
 * 純函數，邊界值見 activeMsgRuntime.test.ts。
 */
export const isOutboxBackfill = (metadata: Record<string, any> | undefined): boolean =>
  metadata?.amsgOutboxBackfill === true;

/**
 * 這條 inbox 消息是不是剛落到設備上的（true = 保留打字節奏，false = 一次性回填）。
 *
 * 判據用 receivedAt（消息落到這台設備的時刻）而不是 sentAt：它剔除了雲端到設備之間的
 * 網絡延遲，問的正是「這條在收件箱裡躺了多久沒人消費」。receivedAt 缺失/非法時按剛到
 * 處理——寧可多慢放一條補收的，也別把用戶正看著的實時消息一次性刷出來。
 * 純函數，邊界值見 activeMsgRuntime.test.ts。
 */
export const isFreshInboxDelivery = (
  receivedAt: number | undefined,
  now: number,
): boolean => {
  if (typeof receivedAt !== 'number' || !Number.isFinite(receivedAt) || receivedAt <= 0) return true;
  return now - receivedAt <= INBOX_FRESH_DELIVERY_WINDOW_MS;
};

/**
 * 頁面最近一次回到前台的時刻（epoch 毫秒）。0 = 這一輩子還沒可見過 / 沒人報過。
 * 只在內存裡，刷新即忘——它要回答的問題也只在本次會話內有意義。
 */
let pageBecameVisibleAt = 0;

/** 頁面回到前台了。init 時（當時就可見的話）和每次 visibilitychange 轉 visible 時報一次。 */
export const notePageBecameVisible = (at: number = Date.now()): void => {
  pageBecameVisibleAt = at;
};

/**
 * 這條消息落到設備時，用戶是不是不在這個頁面上（true = 不在，跳過慢放）。
 *
 * 慢放（擬人打字節奏）的意義是「角色正在你眼前打字」。人不在場時，系統通知已經把整句話
 * 完整顯示過了，再點進來看它一個字一個字重演一遍，剩下的只有等待。
 *
 * 判據是「送達時刻早於頁面最近一次回到前台」：
 *   - App 在前台時收到 → receivedAt 落在這段可見期內 → 在場，保留慢放
 *   - 切後台 / 鎖屏時收到，點通知進來 → 回到前台的時刻晚於 receivedAt → 缺席，跳過
 *   - 冷啟動（點通知才把 App 拉起來）→ 頁面首次可見也晚於 receivedAt → 缺席，跳過
 *
 * 兩處保守退讓，都倒向「保留慢放」：receivedAt 缺失/非法（老 push 可能不帶），以及還沒
 * 記錄過回到前台的時刻（0）——後者若不擋住，會把每一條消息都判成缺席。
 * 純函數，邊界值見 activeMsgRuntime.test.ts。
 */
export const wasDeliveredWhileAway = (
  receivedAt: number | undefined,
  becameVisibleAt: number = pageBecameVisibleAt,
): boolean => {
  if (typeof receivedAt !== 'number' || !Number.isFinite(receivedAt) || receivedAt <= 0) return false;
  if (!Number.isFinite(becameVisibleAt) || becameVisibleAt <= 0) return false;
  return receivedAt < becameVisibleAt;
};

/**
 * 這條要不要跳過擬人打字慢放、一次性回填（true = 跳過）。
 *
 * 三條判據任一成立就跳過，共同點是「用戶已經讀過這句話了，再演一遍打字只剩乾等」：
 *   1. 從雲端帳本補收回來的——內容早就生成完、通知也念過了；
 *   2. 在收件箱裡躺過一陣才被撈出來的；
 *   3. 送達那會兒人不在頁面上，是看著系統通知點進來的。
 *
 * 第 1 條**必須單獨判**，不能指望第 2、3 條順帶撈到：補收在寫庫時會把整批消息的到達
 * 時間統一改寫成「現在」，而第 2、3 條問的都是到達時間——於是它們雙雙得出「剛到的、
 * 用戶還在場」，補收就這麼把自己偽裝成了實時消息。線上那八條補收回來的消息一條條重演
 * 打字，就是這麼來的。
 * 純函數，邊界值見 activeMsgRuntime.test.ts。
 */
export const shouldRenderInstantly = (
  metadata: Record<string, any> | undefined,
  receivedAt: number | undefined,
  now: number,
  becameVisibleAt?: number,
): boolean =>
  isOutboxBackfill(metadata)
  || !isFreshInboxDelivery(receivedAt, now)
  || wasDeliveredWhileAway(receivedAt, becameVisibleAt);

/**
 * 算一條 inbox 消息落庫該用的時間戳：一律取 sentAt（雲端真正把這句話發出去的那一刻）。
 * 返回 undefined = 不指定，走 DB.saveMessage 默認的寫庫當刻（Date.now()）。
 *
 * 為什麼不按「消息夠不夠新」二選一：那個判據回答不了「用戶在不在場」——到點彈的通知，
 * 用戶隔幾分鐘才點進來，消息就會被標成他點進來的那一刻。而在線送達時 sentAt 距落庫
 * 只有幾秒，標 sentAt 一樣顯示「剛剛」，觀感沒有差別。
 *
 * 標 sentAt 不會打亂聊天流的順序：氣泡位置只看自增 id（db.ts 按 charId 索引游標讀、
 * Chat.tsx 的 displayMessages 不排序），timestamp 只決定氣泡上顯示的那個數字。
 * 唯一要防的是「位置在下、數字往回走」的倒掛，那個交給 resolveBackfillTimestamp
 * 精確判定，實際落庫口徑以 resolveInboxPersistTimestampForMessage 為準。
 *
 * 為什麼不用「用戶設定的觸發時刻」（occurrenceMs）：雲端餵給模型的「現在是幾點」用的是
 * 實際開跑那一刻（worker/amsg/src/index.ts），角色正文裡提到的時間跟 sentAt 對齊；
 * 雲端那份自述日誌記的也是 sentAt 口徑。
 *
 * 主路徑（applyAssistantPostProcessing 逐條落庫）與降級存原稿路徑共用這一個口徑，
 * 別再各算各的。sentAt 缺失/非法（老 push 可能不帶）返回 undefined。
 * 純函數，邊界值見 activeMsgRuntime.test.ts。
 */
export const resolveInboxPersistTimestamp = (
  sentAt: number | undefined,
  now: number,
): number | undefined => {
  if (typeof sentAt !== 'number' || !Number.isFinite(sentAt) || sentAt <= 0) return undefined;
  // 時鐘偏差導致 sentAt 跑到未來時不採用——別把氣泡標到還沒到的時間。
  return sentAt > now ? undefined : sentAt;
};

/**
 * 補收的時間戳還能不能用（本地已經有更晚的消息就不能）。
 *
 * 「打開 App」和「後台補投的 push 送到」之間隔著好幾秒，用戶來得及先說一句。這時候把
 * 補收的消息按 sentAt 落庫，聊天流裡就會出現：08:01 用戶說「早安」，下面緊跟著一條標著
 * 昨晚 23:00 的角色消息（顯示順序按自增 id，時間戳卻在往回走）。
 * 本地已有比它更晚的消息 → 退回寫庫當刻，時間戳跟著顯示順序走，不倒掛。
 * 純函數，兩個方向見單測。
 */
export const resolveBackfillTimestamp = (
  persistTimestamp: number | undefined,
  latestLocalMessageAt: number | undefined,
): number | undefined => {
  if (persistTimestamp === undefined) return undefined;
  if (typeof latestLocalMessageAt !== 'number' || !Number.isFinite(latestLocalMessageAt)) {
    return persistTimestamp;
  }
  return latestLocalMessageAt > persistTimestamp ? undefined : persistTimestamp;
};

/**
 * 一條 inbox 消息最終的落庫時間戳：先取 sentAt，再看本地有沒有更晚的消息（有就退回
 * 寫庫當刻，防時間戳倒掛）。
 *
 * 每條都要查一次近史——後處理管線隨後也會讀同一份（contextMsgs），多這一次游標讀可忽略。
 * 查不到近史時沿用 sentAt（寧可標 sentAt，也別把隔夜的消息標成現在）。
 */
const resolveInboxPersistTimestampForMessage = async (
  message: ActiveMsg2InboxMessage,
  now: number,
): Promise<number | undefined> => {
  const persistTimestamp = resolveInboxPersistTimestamp(message.sentAt || message.receivedAt, now);
  if (persistTimestamp === undefined) return undefined;
  try {
    const recent = await DB.getRecentMessagesByCharId(message.charId, 200);
    // 取最大值而不是最後一條：本地消息按自增 id 排，時間戳本來就可能不是單調的。
    const latest = recent.reduce(
      (max, m) => (typeof m.timestamp === 'number' && m.timestamp > max ? m.timestamp : max),
      0,
    );
    return resolveBackfillTimestamp(persistTimestamp, latest || undefined);
  } catch (e) {
    log.warn('查不到本地最新消息時刻，補收時間戳按 sentAt 落', { messageId: message.messageId, error: e });
    return persistTimestamp;
  }
};

/**
 * 重試前等多久（毫秒），按這條消息已經失敗的次數取。
 *
 * 這條路上最常見的失敗是 IndexedDB 的「將死連接」：App 切後台時系統強關連接，頁面剛
 * 解凍就處理推送，正好撞在重建窗口裡，`db.transaction()` 同步拋 InvalidStateError
 * （形態見 db.ts 的 onclose 註釋——當次失敗，下一次調用就自愈）。自愈是毫秒級的，
 * 而推送通知早把這句話完整顯示過了，聊天界面再讓用戶對著「正在輸入」等半分鐘，
 * 觀感上就是「通知都看到了，App 裡還沒有」。
 *
 * 所以第一檔壓到 1 秒。真的連著失敗再拉長，避免存儲持續故障時空轉
 * （連掛到 MAX_INBOX_PROCESS_ATTEMPTS 就不重試了，退回存原稿保底）。
 */
export const resolveInboxRetryDelay = (attempts: number): number => {
  const ladder = [1_000, 5_000, 30_000];
  const nth = Number.isFinite(attempts) ? Math.floor(attempts) : 1;
  return ladder[Math.min(Math.max(nth, 1), ladder.length) - 1];
};
let inboxRetryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 排一次自動重試。
 * 「等下次打開 App」不能當作重試時機——用戶不會為一條沒出現的消息去重啟，
 * 在他一直開著 App 聊天的時候，那條消息就永遠躺在收件箱裡了。
 */
const scheduleInboxRetry = (attempts: number) => {
  if (inboxRetryTimer != null) return;   // 已經排了就不重複排，一次重試會帶上全部積壓
  inboxRetryTimer = setTimeout(() => {
    inboxRetryTimer = null;
    void flushInboxToChat('重試');
  }, resolveInboxRetryDelay(attempts));
};

/** 寫回收件箱等下次處理（帶上失敗次數），並排一次自動重試。 */
/**
 * 這一趟沖刷裡被寫回收件箱、還要再處理一次的消息。
 *
 * 雲端帳本的銷帳口徑是「這條消息在客戶端有著落了」——落庫、按重複丟棄、被防穿幫閘
 * 吞掉都算有著落，唯獨寫回收件箱不算：帳一銷，下次就再也拉不回來了，而它還沒處理完。
 * 所以這裡反過來記「沒著落的」，沖刷收尾時從本批裡刨掉它們再銷帳。
 *
 * 用模塊級集合而不是層層傳參：沖刷本身是串行鏈（flushChain），同一時刻只有一趟在跑，
 * 每趟開頭清空即可。
 */
const retainedInboxMessageIds = new Set<string>();

const requeueForRetry = async (message: ActiveMsg2InboxMessage, attempts: number): Promise<void> => {
  retainedInboxMessageIds.add(message.messageId);
  try {
    await ActiveMsgStore.saveInboxMessage({ ...message, processAttempts: attempts });
    scheduleInboxRetry(attempts);
  } catch (reputErr) {
    // 寫回也失敗，大概率同一根因（存儲關停 / 配額滿）。消息到此為止，留個明確的日誌。
    log.error('requeue failed, message lost', { messageId: message.messageId, error: reputErr });
  }
};

// ─── 多段消息的等齊守衛 ───
//
// 一次生成可能拆成好幾條 push（metadata.messageIndex 從 1 數起），Web Push 不保證按序
// 到達。App 開著時每收到一條就 flush 一次，兩段落進兩批的話 consumeInboxMessages 那次
// 「同批按段序排」根本夠不著——聊天記錄的顯示順序 = IndexedDB 自增 id = 落庫先後，後段
// 先到就永久顛倒，用戶看到的是「後半句 + 前半句」。
//
// 所以段序靠後的消息落庫前先看一眼：更小的段序是不是都有著落了（在本批裡，或者已經
// 落過庫）。沒有就寫回收件箱等幾秒再來一次。**必須有上限**——前段真丟了（worker 只發了
// 一半 / 那條 push 被系統丟掉）不能永遠扣著後段不給用戶看。

/** 段序靠後的消息最多扣住幾次；超了按現狀放行（順序可能是亂的，但至少不會消失）。 */
export const MAX_INBOX_ORDER_HOLDS = 3;
/** 扣住之後隔多久再看一眼。前一段通常就在路上，幾秒足夠。 */
const INBOX_ORDER_HOLD_DELAY_MS = 3_000;

/** messageId → 已經扣住幾次。釋放（落庫 / 放行）時刪掉，不會無界增長。 */
const inboxOrderHolds = new Map<string, number>();
let inboxOrderHoldTimer: ReturnType<typeof setTimeout> | null = null;

const scheduleInboxOrderRecheck = () => {
  if (inboxOrderHoldTimer != null) return;   // 已經排了就不重複排，一次重看會帶上全部積壓
  inboxOrderHoldTimer = setTimeout(() => {
    inboxOrderHoldTimer = null;
    void flushInboxToChat('等齊重看');
  }, INBOX_ORDER_HOLD_DELAY_MS);
};

/**
 * 近史裡這個 session 已經落過庫的段序。
 *
 * 認領依據跟 findInboxArtifacts 同款——都是後處理落庫時由 mcdInheritMeta 繼承下來的
 * metadata（這裡用 sessionId + messageIndex，那裡用 activeMsg2.messageId）。
 * 一條 push 會被拆成好幾個氣泡，段序相同，去重後返回。
 */
export const findPersistedChunkIndexes = <T extends { role: string; metadata?: any }>(
  messages: T[],
  sessionId: string,
): Set<number> => {
  const indexes = new Set<number>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    if (m.metadata?.sessionId !== sessionId) continue;
    const idx = Number(m.metadata?.messageIndex ?? 0);
    if (Number.isFinite(idx) && idx > 0) indexes.add(idx);
  }
  return indexes;
};

/** 這條消息前面還缺哪幾段（1 數到 messageIndex-1，凡是沒著落的都算）。 */
export const findMissingChunkIndexes = (messageIndex: number, seen: Set<number>): number[] => {
  const missing: number[] = [];
  for (let i = 1; i < messageIndex; i += 1) {
    if (!seen.has(i)) missing.push(i);
  }
  return missing;
};

/**
 * 前面的分段還沒著落 → 寫回收件箱、過幾秒再看，返回 true 表示這條這次先不處理。
 *
 * 三種情況一律放行（返回 false）：沒有 session / 本來就是第一段、前面的段都齊了、
 * 扣到上限了。查近史或寫回收件箱失敗也放行——扣住的代價是消息遲遲不出現，比順序錯更重。
 */
const holdUntilEarlierChunksLand = async (
  message: ActiveMsg2InboxMessage,
  batch: ActiveMsg2InboxMessage[],
): Promise<boolean> => {
  const sessionId = getInstantSessionId(message);
  const messageIndex = getInstantMessageIndex(message);
  if (!sessionId || messageIndex <= 1) return false;

  let missing: number[];
  try {
    const seen = new Set<number>();
    for (const other of batch) {
      if (other.messageId !== message.messageId && getInstantSessionId(other) === sessionId) {
        seen.add(getInstantMessageIndex(other));
      }
    }
    const recent = await DB.getRecentMessagesByCharId(message.charId, 200);
    for (const idx of findPersistedChunkIndexes(recent, sessionId)) seen.add(idx);
    missing = findMissingChunkIndexes(messageIndex, seen);
  } catch (e) {
    log.warn('等齊守衛查不到近史，這條照常落庫', { messageId: message.messageId, error: e });
    inboxOrderHolds.delete(message.messageId);
    return false;
  }

  if (missing.length === 0) {
    inboxOrderHolds.delete(message.messageId);
    return false;
  }

  const holds = (inboxOrderHolds.get(message.messageId) ?? 0) + 1;
  if (holds > MAX_INBOX_ORDER_HOLDS) {
    inboxOrderHolds.delete(message.messageId);
    log.warn('前面的分段一直沒來，按現狀放行（順序可能是亂的）', {
      messageId: message.messageId, sessionId, messageIndex, missing,
    });
    activeMsgTrace('runtime-chunk-hold-giveup', {
      sessionId, messageId: message.messageId, messageIndex, missing,
    });
    return false;
  }

  try {
    // 原樣寫回（不動 processAttempts）——「前面那段還沒來」不是處理失敗。
    await ActiveMsgStore.saveInboxMessage(message);
    // 還要再來一趟，這一輪不許銷帳（見 retainedInboxMessageIds）。
    retainedInboxMessageIds.add(message.messageId);
  } catch (e) {
    log.warn('等齊守衛寫回收件箱失敗，這條照常落庫', { messageId: message.messageId, error: e });
    inboxOrderHolds.delete(message.messageId);
    return false;
  }
  inboxOrderHolds.set(message.messageId, holds);
  scheduleInboxOrderRecheck();
  activeMsgTrace('runtime-chunk-hold', {
    sessionId, messageId: message.messageId, messageIndex, missing, holds,
  });
  return true;
};

/**
 * 送達失敗發生在哪一段。**每條上報都要帶**：不帶的話面板上會多出一個空分組，
 * 而空分組恰恰是最需要被看見的那種「不知道哪來的」。
 */
type InboxFailureStage = '收发' | '防穿帮闸' | '后处理' | '补收';

/**
 * 告訴用戶「有條消息沒能正常顯示」。
 * push 路徑平時是故意不彈 toast 的（用戶沒在看這個角色時會很吵），但這裡是失敗提醒，
 * 頻率極低且用戶需要知道，所以照發——由 OSContext 那側統一節流。
 */
const notifyInboxProcessFailed = (
  message: ActiveMsg2InboxMessage,
  kind: 'retrying' | 'degraded' | 'swallowed' | 'schedule-missed',
  /**
   * 這條是在哪一段掛的。同一個 kind 有好幾個發射點（「重試中」就有三個），不分段的話
   * 面板上只看得到「有多少次失敗」，看不出該去查哪條路——取值寫死在各個調用點上。
   */
  stage: InboxFailureStage,
  /**
   * 給用戶看的那句話，由發起方按具體原因寫好。同一個 kind 底下不止一種情況
   * （日程沒落地就分「沒有對得上的時段」和「格式沒認出來」），這裡原樣帶過去，
   * 讓 OSContext 講準確的那句而不是一句蓋全部的話。不傳就用 kind 的默認文案。
   */
  note?: string,
) => {
  // 送達端唯一的埋點，而且只報失敗：成功那條不報，免得攢出一份「誰幾點收到過消息」的
  // 時間線（跟「發消息本身不打點」同一條口徑，見 docs/analytics.md）。
  // 三個代號都是這個函數入參上寫死的取值，角色名 / 內容 / messageId 一概不帶
  // （note 是給界面看的人話，同樣不進埋點）。
  trackEvent('主动消息送达失败', {
    kind: kind === 'degraded' ? '原文降级'
      : kind === 'swallowed' ? '被跳过'
        : kind === 'schedule-missed' ? '日程没落地'
          : '重试中',
    stage,
  });
  try {
    window.dispatchEvent(new CustomEvent('active-msg-process-failed', {
      detail: { charId: message.charId, charName: message.charName, kind, note },
    }));
  } catch { /* SSR-safe */ }
};

/**
 * 角色已經不在本地了，把它留在遠端的任務清掉——否則這條任務會一直到點觸發、
 * 一直推給一個不存在的角色。取消不掉也不要緊（網絡問題），下一條推過來時還會再試一次。
 */
const cancelOrphanedRemoteTasks = async (charId: string): Promise<void> => {
  try {
    const { targets, failed } = await ActiveMsgClient.cancelAllTasksForChar(charId, []);
    log.warn('清理遠端孤兒任務', { charId, targets: targets.length, failed: failed.size });
  } catch (e) {
    log.warn('清理遠端孤兒任務失敗（下次收到同角色 push 時會再試）', { charId, error: e });
  }
};

/**
 * 收件箱這條消息在處理途中拋了錯，按跟後處理失敗同一套去向收尾。
 *
 * 後處理管線自己那圈 try/catch 只蓋住 applyAssistantPostProcessing 那一小截；查近史去重、
 * 認領角色自排任務、防穿幫閘、等齊守衛、算落庫時間戳這些步驟同樣會讀本地存儲，同樣會因
 * IndexedDB 被佔 / 配額滿而拋錯。收件箱已經在 consumeInboxMessages 那一刻被原子取空，
 * 讓異常冒出去就等於整批消息憑空蒸發（既不在聊天記錄、也不在收件箱、也沒有任何提示）。
 *
 * 三條去向沿用 resolveInboxFailureAction：角色沒了就去清遠端任務，還能重試就壓回收件箱，
 * 試到上限則明確告訴用戶有一條被跳過了。
 */
const handleInboxStageFailure = async (
  message: ActiveMsg2InboxMessage,
  error: unknown,
): Promise<void> => {
  const attempts = (message.processAttempts ?? 0) + 1;
  const action = resolveInboxFailureAction(error, attempts);

  if (action === 'orphan') {
    log.warn('inbox message 的角色已不存在，丟棄並清理遠端孤兒任務', {
      messageId: message.messageId, charId: message.charId,
    });
    await cancelOrphanedRemoteTasks(message.charId);
    return;
  }

  if (action === 'retry') {
    log.warn('處理 inbox message 時拋錯，壓回收件箱重試', {
      messageId: message.messageId, attempts, error,
    });
    await requeueForRetry(message, attempts);
    notifyInboxProcessFailed(message, 'retrying', '收发');
    return;
  }

  // 試到上限還是拋：本地存儲這時候基本是真出問題了。這裡不退回存原稿——拋錯的位置
  // 未必是「內容還沒落庫」（可能已經落了一半），再補一份原稿會跟殘留氣泡並排出現。
  log.error('處理 inbox message 反覆拋錯，這條跳過', {
    messageId: message.messageId, attempts, error,
  });
  notifyInboxProcessFailed(message, 'swallowed', '收发');
};

/**
 * 這一趟沖刷是誰發起的。
 *
 * 「SW通知」是唯一的實時路徑——推送一到就喊頁面。其餘全是兜底：輪詢、回前台、啟動、
 * 補收，它們都帶著幾秒到一分鐘不等的固有延遲。所以這個字段實際回答的是
 * 「實時通道還活著嗎」：一段時間裡的沖刷全由兜底觸發，就說明它斷了。
 */
export type FlushTrigger =
  | 'SW通知'          // Service Worker 收到推送後喊頁面（唯一的實時路徑）
  | '點通知進入'      // 用戶點系統通知把 App 喚到前台
  | '回到前台'        // 頁面重新可見
  | '啟動'            // App 冷啟動時的兜底排空
  | '重試'            // 上一趟處理失敗，定時重來
  | '等齊重看'        // 多段消息扣住後段，隔幾秒回頭看前段到了沒
  | '上線補收'        // 開 App 自動去雲端帳本撈後台期間漏掉的
  | '手動補收'        // 用戶點「找回沒收到的消息」
  | '輪詢補收'        // 即時對話 60 秒點名順手把帳本上的撈回來
  | '原生收件箱'      // 原生殼把消息塞進收件箱後觸發
  | '原生推送'       // 原生殼收到推送後觸發
  | '本地巡查';       // 前台每幾秒數一眼本地收件箱，自己發現躺著的消息

const flushInboxToChatImpl = async (trigger: FlushTrigger): Promise<string[]> => {
  const pendingMessages = await ActiveMsgStore.consumeInboxMessages();
  // 這一趟真正落進聊天流的那幾條（見 flushInboxToChat 的返回值說明）。
  const landedMessageIds: string[] = [];
  activeMsgTrace('runtime-flush-start', { count: pendingMessages.length, trigger });
  // 這一趟處理誰「還沒著落」的記帳從空開始（見 retainedInboxMessageIds）。
  retainedInboxMessageIds.clear();
  // ─── 落庫前的 messageId 去重 ───
  // 同一條推送有兩條可達的「第二次到達」路徑：① outbox 補收先落了庫，被推送服務
  // 延遲的原始 Web Push 幾分鐘後才送達（補收繞過 SW，delivery-dedupe 裡沒有記錄）；
  // ② 補收銷帳時 best-effort cancelTask 沒攔住重試，worker 重跑整個 fire——重疊段號
  // 複用相同 messageId（`msg_task_{行id}@{occurrenceMs}_hook_{i}` 是確定性規則）。
  // 聊天近史裡已經有這個 activeMsg2.messageId 的，直接丟棄：不落庫、不彈 toast、
  // 不重放 directives。只對首次處理（processAttempts=0）做——重試那幾條的半成品
  // 氣泡剛被 prepareInboxRetry 清場，近史裡查到的正是「該重跑」的證據，不能誤殺。
  const persistedIdsByChar = new Map<string, Set<string>>();
  const isAlreadyPersisted = async (charId: string, messageId: string): Promise<boolean> => {
    if (!messageId) return false;
    let ids = persistedIdsByChar.get(charId);
    if (!ids) {
      const recent = await DB.getRecentMessagesByCharId(charId, 200);
      ids = new Set(
        recent
          .map((m: any) => m?.metadata?.activeMsg2?.messageId)
          .filter((id: unknown): id is string => typeof id === 'string' && !!id),
      );
      persistedIdsByChar.set(charId, ids);
    }
    return ids.has(messageId);
  };
  try {
  // consumeInboxMessages 是 "先 ack 後處理" 語義 —— inbox 已經原子地清空。
  // 這裡 per-message try/catch: 單條處理拋錯 (quota / DB 故障 / postprocess 異常) 不連累
  // 後續條目。Phase 1 改成: 先嘗試走 applyAssistantPostProcessing (與本地 fetch 路徑
  // 行為對齊 — emoji / 翻譯 / HTML / 引用 / chunking 全部複用同一管線); 如果走管線失敗,
  // 降級回原來的 "原文一次性 saveMessage" 防止消息丟失。dispatchEvent 始終 fire 一次,
  // 保證 toast / 未讀 / 通知語義不變。
  for (const message of pendingMessages) {
    // 這一層是**整批消息的最後一道防線**：消息在 consumeInboxMessages 那一刻就已經從
    // 收件箱裡沒了，下面任何一步拋出去的異常都會穿過整個 for 循環，剩下的消息既沒落進
    // 聊天記錄、也沒回到收件箱——用戶那邊只看到「正在輸入…」一直亮到 60s 點名判失敗，
    // 角色的回覆徹底消失。所以整段都得包住，不能只包後處理那一小截。
    try {
      // 'active-msg-received' 事件裡的 sentAt 維持原口徑（發送時刻優先）：
      // 它只喂 toast / 未讀預覽，不進聊天記錄，別跟落庫口徑攪在一起。
      const eventSentAt = message.sentAt || message.receivedAt || Date.now();
      activeMsgTrace('runtime-inbox-message', {
        sessionId: (message as any).sessionId || (message.metadata as any)?.sessionId,
        messageId: message.messageId,
        charId: message.charId,
        messageType: message.messageType,
        bodyChars: typeof message.body === 'string' ? message.body.length : undefined,
        // 這條推送落到設備上的時刻（SW 寫收件箱時打的），以及從那一刻起在收件箱裡
        // 躺了多久才輪到它。用戶抱怨的「通知都看到了，界面半天沒字」量的就是這個數：
        // 它跟正文長短無關，純粹是「沒人來撈」的時間。
        receivedAt: message.receivedAt,
        waitedMs: typeof message.receivedAt === 'number' && message.receivedAt > 0
          ? Date.now() - message.receivedAt
          : undefined,
        // 第幾段 / 共幾段：多段回覆的延遲要按段看才有意義。
        chunk: (message.metadata as any)?.messageIndex,
        total: (message.metadata as any)?.totalMessages,
        // 重試過幾次（0 = 第一次處理）。
        attempts: message.processAttempts ?? 0,
      });

      // 見上面 isAlreadyPersisted 的註釋：這條已經在聊天記錄裡了（補收先到、真推送遲到，
      // 或重試重跑的重疊段），第二份原樣丟棄。
      if (!(message.processAttempts && message.processAttempts > 0)
        && await isAlreadyPersisted(message.charId, message.messageId)) {
        log.warn('這條消息已在聊天記錄裡（補收先到/重試重跑的第二份），丟棄', { messageId: message.messageId, charId: message.charId });
        activeMsgTrace('runtime-inbox-duplicate-dropped', { messageId: message.messageId, charId: message.charId });
        continue;
      }

      // emotion_update: worker 跑完副 API 情緒評估後推回的 buff 結果. 不渲染成聊天消息, 直接落 buff +
      // 廣播 innerState (useChatAI 監聽 'emotion-innerstate-updated' → setEvolvedNarrative 喂下一輪).
      // 識別條件用 messageType==='emotion_update' 或 metadata.emotionRaw 存在 —— 後者兜底舊 SW
      // (<1.8.0 不認 emotion_update messageKind, 會把它當 content 存進 inbox, 但 metadata.emotionRaw
      // 仍被 saveContentToInbox 透傳進來). 這樣情緒落地不依賴 SW 是否升級.
      if (message.messageType === 'emotion_update' || (message.metadata as any)?.emotionRaw) {
        const emotionRaw = (message.metadata as any)?.emotionRaw;
        if (emotionRaw) {
          await landCloudEmotionResult(message.charId, String(emotionRaw));
        } else {
          // worker 端評估失敗/空結果時 emotionRaw 是空串（worker 無論成敗都推一條用來熄燈）。
          // 過去這裡靜默跳過 —— 用戶只看到「情緒更新中」滅了、情緒沒變、無任何報錯（真實反饋）。
          // 派發失敗事件讓 OSContext 彈 toast。2026-07-17+ 的 worker 會把具體原因帶在
          // metadata.emotionError（副 API HTTP 狀態等）；舊 worker 沒這字段就給通用文案。
          const workerReason = (message.metadata as any)?.emotionError;
          announceChatGen(CHAT_GEN_EVENTS.emotionFailed, {
            charId: message.charId, charName: '',
            reason: typeof workerReason === 'string' && workerReason
              ? `雲端評估失敗——${workerReason}`
              : '雲端情緒評估無輸出（副 API 報錯或模型沒返回內容，可查 worker 日誌）',
          });
        }
        // 無論成功與否都通知 useChatAI 熄滅 "情緒更新中" 徽章 (buff 已落 / 或這輪沒結果).
        announceEmotionDone(message.charId);
        activeMsgTrace('runtime-emotion-done', {
          sessionId: (message as any).sessionId || (message.metadata as any)?.sessionId,
          messageId: message.messageId,
          charId: message.charId,
        });
        continue;
      }

      // 角色到點自己給自己排的任務：worker 直接在 D1 建了行，客戶端這邊並不知道它存在。
      // 記帳排在防穿幫閘**之前**——「這條消息該不該說出口」和「這條任務存不存在」是兩回事。
      // 排在閘後面的話，被吞的那條 push 會把任務認領一起帶走：面板列不出來、用戶取消不掉，
      // 而它照常到點觸發；訂閱登記和憑據刷新也都夠不著它，成了推不出去又刪不掉的幽靈。
      await adoptSelfScheduledTasks(message);
      // 對稱的另一半：角色在 fire 裡取消 / 改期掉的既有任務，本地清單跟著消帳。
      // 同樣排在閘之前——D1 行已經沒了（或換了時間），消息被吞不改變這個事實。
      await applyRemoteTaskMutations(message);

      // ─── 防穿幫閘·客戶端兜底 ───
      // 只攔定時任務的 push（source==='scheduled' 且帶策略字段）；instant 聊天
      // 回覆 source==='instant'，與這道閘無關。吞掉 = 不進聊天流、不重放
      // directives（作廢消息的副作用一併作廢）；生成 token 浪費掉，換不穿幫。
      // 系統通知層面：content push 默認可能在前台/後台先展示；頁面線程無權追回
      // 已彈通知。防通知主力是 worker 預檢 + chat_presence 活躍會話租約。
      // 排程現狀塊不在這裡記——useChatAI 組請求時獨立檢出，兩側結論一致。
      if (message.source === 'scheduled' && (message.metadata as any)?.amsgExpirePolicy) {
        // 緩存鍵必須含 occurrence（Codex #2）：sessionId 對循環任務的每次 occurrence、
        // 對同一次的每次重試都可能重複——裸 sessionId 會把上次的判定串給下一次
        // （第一次放行 → 後續永遠放行；第一次吞 → 後續全吞）。公式見 buildFireKey。
        const fireKey = buildFireKey(message);
        const now = Date.now();
        // 多分段 push 的一次 fire 共用一個決定（同吞同放）：get-or-compute + TTL 清掃
        // 抽進 resolveFireExpireDecision，見其單測。
        let expired: boolean;
        try {
          expired = await resolveFireExpireDecision(
            expireDecisionByFire,
            fireKey,
            now,
            () => evaluateScheduledPushExpired(message),
          );
        } catch (gateErr) {
          // 判不出來「用戶此刻是不是正在跟這個角色聊天」。壓回收件箱等本地存儲緩過來再判，
          // 別猜——猜錯的那一面是角色當著正在進行的對話冒出一句定時問候。
          // （evaluate 拋錯時 resolveFireExpireDecision 不寫緩存，所以下次是真的重判。）
          const attempts = (message.processAttempts ?? 0) + 1;
          if (attempts < MAX_INBOX_PROCESS_ATTEMPTS) {
            log.warn('防穿幫閘判定失敗，壓回收件箱稍後重判', { messageId: message.messageId, attempts, error: gateErr });
            await requeueForRetry(message, attempts);
            notifyInboxProcessFailed(message, 'retrying', '防穿帮闸');
            continue;
          }
          // 壓到上限還是判不了：本地存儲這時候基本是真出問題了，讓角色繼續冒新消息只會更亂。
          // 按吞掉處理（與閘判定為「已作廢」同一個出口），但要明確告訴用戶有這麼一條被跳過了。
          log.error('防穿幫閘重試到上限仍判不了，按作廢吞掉', { messageId: message.messageId, attempts, error: gateErr });
          activeMsgTrace('runtime-expire-swallow-unknown', {
            sessionId: fireKey,
            messageId: message.messageId,
            charId: message.charId,
            taskId: message.taskId,
          });
          notifyInboxProcessFailed(message, 'swallowed', '防穿帮闸');
          continue;
        }
        if (expired) {
          activeMsgTrace('runtime-expire-swallow', {
            sessionId: fireKey,
            messageId: message.messageId,
            charId: message.charId,
            taskId: message.taskId,
          });
          // 吞掉的是「這次要說的話」，雲端那份「我說過什麼」也得跟著撤，否則下一次到點
          // 角色會接著一句沒人看過的話往下說。不 await：這是一次網絡往返，不能讓它拖住
          // 收件箱裡後面幾條的落庫；失敗只 warn（見 revokeSwallowedSelfLogEntry）。
          const selfLogEntryId = buildSelfLogEntryId(message);
          if (selfLogEntryId) {
            void revokeSwallowedSelfLogEntry(message.charId, selfLogEntryId)
              .catch((e) => log.warn('撤銷雲端自述日誌條目失敗（下次重傳 fire_pack 時整份作廢）', {
                charId: message.charId, entryId: selfLogEntryId, error: e,
              }));
          }
          continue;
        }
      } else if (message.source === 'scheduled') {
        // 這條定時 push 沒帶策略字段（老 worker 發的），閘整個沒跑。留一行把它跟
        // 「閘跑了、放行了」區分開——不然排查時兩者長得一模一樣，只能靠別的 trace
        // 反推，而反推恰恰是這條鏈路最不該有的東西。
        activeMsgTrace('runtime-expire-gate-skipped', {
          messageId: message.messageId,
          charId: message.charId,
          taskId: message.taskId,
          reason: 'no-policy-field',
        });
      }

      // 多段消息的等齊守衛：前面的段還沒著落就先扣住這條（見 holdUntilEarlierChunksLand）。
      // 排在防穿幫閘後面——這次 fire 整個被吞掉的話，沒必要為它的後半段白等幾秒。
      if (await holdUntilEarlierChunksLand(message, pendingMessages)) continue;

      // 落庫時間戳按「在線送達 vs 離線補收」二選一（undefined = 交給 DB.saveMessage 默認取
      // 寫庫當刻），主路徑與下面的降級存原稿路徑共用這一個值，兩條路一個口徑。
      // sentAt 缺失時退到 receivedAt（老 worker 的 push 可能不帶 sentAt）。
      const persistTimestamp = await resolveInboxPersistTimestampForMessage(message, Date.now());

      // 白名單制: AI 文本類型基本封閉 (amsg-shared MESSAGE_TYPE 4 個 + SullyOS 3 個 legacy 別名);
      // 非 AI 類型 (forum / event / system / 未來擴展) 不可枚舉, 不進 post-processing 防把它們當 AI 輸出亂解析.
      // Phase 1 老白名單隻列了 text/assistant/normal, 漏了整個 amsg-shared 集合, 導致所有 push 都
      // 走 raw fallback (post-processing / directive 重放 / emoji / chunking 全部跳過). Round 2 補全.
      const ASSISTANT_TEXT_TYPES = new Set([
        // SullyOS legacy
        'text', 'assistant', 'normal',
        // amsg-shared MESSAGE_TYPE union (instant/fixed/prompted/auto) — 全是 LLM 輸出
        'instant', 'fixed', 'prompted', 'auto',
      ]);
      const looksLikeAssistantText = !message.messageType
        || ASSISTANT_TEXT_TYPES.has(message.messageType);

      let routed = false;

      if (looksLikeAssistantText) {
        try {
          await processInboxMessageWithPostProcessing(message, persistTimestamp);
          routed = true;
        } catch (postErr) {
          const attempts = (message.processAttempts ?? 0) + 1;
          const action = resolveInboxFailureAction(postErr, attempts);

          if (action === 'orphan') {
            // 角色都不在了，這條消息沒有落點，提醒用戶也沒有意義。真正該處理的是遠端那條
            // 還在到點跑的任務——不取消掉它，以後每到點都會再推一條（而且每次真燒一輪 LLM）。
            log.warn('inbox message 的角色已不存在，丟棄並清理遠端孤兒任務', { messageId: message.messageId, charId: message.charId });
            await cancelOrphanedRemoteTasks(message.charId);
            continue;
          }

          if (action === 'retry') {
            // 不就地存原稿：殘缺版進了聊天記錄是永久的，而這類故障通常是暫時的。
            log.warn('post-processing failed, requeue for retry', { messageId: message.messageId, attempts, error: postErr });
            await requeueForRetry(message, attempts);
            notifyInboxProcessFailed(message, 'retrying', '后处理');
            continue;
          }

          // 重試到頭，退回存原稿保底：用戶至少看得到內容，代價是表情 / 卡片 / 副作用都沒了，
          // 所以這條要明確告訴用戶「可能不完整」，別讓它悄悄混進歷史。
          // 存原稿前也要清一遍：這一趟同樣可能寫了幾條氣泡才掛，不清的話原稿會跟它們並排出現。
          log.error('post-processing failed，重試到上限，退回存原稿', { messageId: message.messageId, attempts, error: postErr });
          try {
            await purgeInboxArtifacts(message);
          } catch (purgeErr) {
            log.warn('存原稿前清理半成品失敗（原稿照存，可能與殘留氣泡並存）', { messageId: message.messageId, error: purgeErr });
          }
          notifyInboxProcessFailed(message, 'degraded', '后处理');
        }
      }

      if (!routed) {
        try {
          await DB.saveMessage({
            charId: message.charId,
            role: 'assistant',
            type: 'text',
            content: message.body,
            timestamp: persistTimestamp,
            metadata: {
              source: 'active_msg_2',
              activeMsg2: {
                messageId: message.messageId,
                taskId: message.taskId,
                messageType: message.messageType,
                messageSubtype: message.messageSubtype,
                avatarUrl: message.avatarUrl,
                sentAt: message.sentAt,
                receivedAt: message.receivedAt,
              },
              ...(message.metadata || {}),
            },
          });
        } catch (e) {
          log.warn('saveMessage failed, requeue to inbox', { messageId: message.messageId, error: e });
          retainedInboxMessageIds.add(message.messageId);
          try {
            await ActiveMsgStore.saveInboxMessage(message);
          } catch (reputErr) {
            // re-put 也掛了 (大概率同一根因, 比如 quota / DB 關停), 沒救了, 至少留個日誌
            log.error('requeue failed, message lost', { messageId: message.messageId, error: reputErr });
          }
          // requeue 後跳過這條消息的 dispatchEvent —— UI 不該誤以為收到了
          continue;
        }
        // 情緒附贈也要在這裡消費：結果就掛在這條 push 的 metadata 上，而全倉庫唯一的
        // 消費點在 post-processing 內部——走到降級這條路說明那邊失敗到頭了，光把 metadata
        // 原樣抄進聊天記錄的話結果永遠無人再讀：「情緒更新中」徽章亮滿十來分鐘的安全網，
        // 然後彈「worker 可能是舊版」的假告警，其實結論早就到了本地。best-effort：情緒是
        // 附贈，消費失敗不能連累「原稿已落庫」這個事實（與上面銷帳塊同一口徑）。
        const degradedCleanups: OffloadedCleanup[] = [];
        try {
          const degradedEmotionDone = (message.metadata as any)?.amsgEmotionDone === true;
          // 晚投標記（同主路徑口徑）：評估沒趕上這條 push 的順風車，結果要等 worker 收尾
          // 才寫進旁路存儲。此刻旁路鍵多半還空著，跳過一次性取回（立刻讀只會白打一個
          // 「被下一輪覆蓋了」的 warn），改為對引用鍵輪詢補落，燈繼續亮著。
          const degradedEmotionPending = (message.metadata as any)?.amsgEmotionPending === true;
          const degradedInline = (message.metadata as any)?.amsgEmotionUpdate;
          // 這條消息帶來了新一輪的情緒結論（成 / 敗 / 晚投）→ 上一輪還在跑的補落輪詢作廢：
          // 舊結果這時再落下去會蓋掉新一輪的 buff（同主路徑）。
          if (degradedEmotionDone || degradedEmotionPending || (typeof degradedInline === 'string' && !!degradedInline)) {
            cancelLateEmotionPoll(message.charId);
          }
          const degradedUpdateRaw = typeof degradedInline === 'string' && degradedInline
            ? degradedInline
            : (degradedEmotionPending ? null : await fetchOffloadedEmotionUpdate(message, degradedCleanups));
          if (degradedUpdateRaw) {
            await landCloudEmotionResult(message.charId, degradedUpdateRaw);
          } else if (degradedEmotionPending) {
            const degradedPendingRef = (message.metadata as any)?.amsgEmotionRef;
            if (typeof degradedPendingRef === 'string' && degradedPendingRef) {
              // 輪詢等到結果就落 buff + 熄燈 + 刪雲端副本；跳數用盡由它自己報失敗收尾。
              startLateEmotionPoll(message.charId, degradedPendingRef, message.charName || '');
            } else {
              // 標了 pending 卻沒給引用鍵（worker bug）：沒法輪詢，按「有結論但沒結果」收尾。
              announceChatGen(CHAT_GEN_EVENTS.emotionFailed, {
                charId: message.charId, charName: message.charName || '',
                reason: '雲端情緒評估晚投但缺少引用鍵（worker 可能有 bug），這一輪不更新',
              });
              announceEmotionDone(message.charId);
            }
          }
          if (degradedEmotionDone || degradedUpdateRaw) announceEmotionDone(message.charId);
          // 原稿落了、情緒也消費完了，雲端那份才可以刪（同主路徑口徑）。
          void runOffloadedCleanups(degradedCleanups);
        } catch (e) {
          log.warn('降級存原稿路徑消費情緒結果失敗（原稿已落庫，不受影響）', { messageId: message.messageId, error: e });
        }
      }

      // 走到這裡 = 這條真的落進聊天流了（主路徑落庫完 / 降級存了原稿）。上面每一個
      // continue 都是「沒上屏」：閘吞了、跟已有的重了、等前面的分段、壓回收件箱重試。
      landedMessageIds.push(message.messageId);
      // 交給雲端的延遲自動回覆回來了（認任務 uuid）：這筆待回銷掉，本地到點就不會再回一次。
      settleCloudDelayedReply(message.charId, message.taskUuid);

      // 不管走 post-processing 還是 raw fallback, 單條 inbox message 觸發一次 'active-msg-received',
      // 驅動 toast / 未讀 / 通知。body 用原文做預覽即可。
      window.dispatchEvent(new CustomEvent('active-msg-received', {
        detail: {
          charId: message.charId,
          charName: message.charName,
          body: message.previewBody || message.body,
          avatarUrl: message.avatarUrl,
          sentAt: eventSentAt,
        },
      }));
      activeMsgTrace('runtime-active-msg-received-dispatched', {
        sessionId: (message as any).sessionId || (message.metadata as any)?.sessionId,
        messageId: message.messageId,
        charId: message.charId,
      });

      // 即時對話的「正在輸入…」在這裡熄：**欠著的那一輪**（認 taskUuid）的**末段**到了。
      // 只認 uuid、不認「這個角色開口了」：定時任務的主動消息、被頂掉的上一輪遲到的
      // 回覆都可能先落地，它們不是用戶在等的那一輪——按角色銷帳的話，60s 點名連同
      // outbox 兜底當場全停，這一輪的推送真丟了就再也沒人去補。
      // 認末段（messageIndex >= totalMessages）而不是隨便哪一段：第一段就銷帳的話，
      // 後續段丟在路上時兜底同樣全停，用戶永遠只看到半截回覆。段號缺失（單段消息 /
      // 舊 worker）當末段處理，保持舊行為。
      const pendingForChar = getInstantChatPending(message.charId);
      if (pendingForChar && message.taskUuid === pendingForChar.uuid) {
        const segIndex = Number((message.metadata as any)?.messageIndex);
        const segTotal = Number((message.metadata as any)?.totalMessages);
        const isLastSegment = !Number.isFinite(segTotal) || segTotal <= 1
          || (Number.isFinite(segIndex) && segIndex >= segTotal);
        if (isLastSegment && clearInstantChatPending(message.charId)) {
          scheduleNextInstantChatStatusCheck();
          // 「API 調用記錄」裡那筆（發出去時記的）在這裡補完：用量掛在末條推送上，
          // 而這裡正好是認末段的地方。
          settleInstantChatApiLog(pendingForChar.uuid, message.metadata as Record<string, any> | null);
          // 隨這一輪上雲的「任務被作廢」回執到這裡才真的銷帳。發出時（worker 回 202）
          // 只是記帳：202 僅表示受理，那一輪要是整個失敗了，回執得留著下輪重新注入，
          // 否則角色永遠不知道自己許過的那條排程已經沒了。認 uuid，上一輪遲到的結論
          // 不許銷新一輪的帳。
          void settleInstantChatExpiredNotices(message.charId, pendingForChar.uuid);
          // 這條回覆是從 outbox 補收回來的 = 真推送沒送到 = 那條任務行多半正掛在
          // 2/4/6 分鐘的重試隊列裡，跑起來就是同一輪的第二份回覆。盡力取消；
          // 正常送達的路不帶這個標記（行發完即刪，也無從取消），一個多餘請求都不發。
          if ((message.metadata as any)?.amsgOutboxBackfill) {
            // 取消失敗別靜默吞：重試跑起來就是同一輪的第二份回覆（重疊段有上面的
            // messageId 去重兜著，多出的段攔不住），至少留下一條可查的痕。
            ActiveMsgClient.cancelTask(pendingForChar.uuid).catch((e) => {
              log.warn('補收銷帳後取消重試任務失敗（若重試已在跑，重複段會被落庫去重攔下）', { uuid: pendingForChar.uuid, error: e });
            });
          }
          // 末段先到、中段還丟在路上的亂序場景：銷帳後 pending 沒了，常規兜底不會再看
          // 這一輪——離場前按這輪的 uuid 補掃一次 outbox，把缺的段撿回來。
          void sweepSettledInstantRound(message.charId, pendingForChar.uuid);
          // 掛起沒傳的 fire_pack（銷帳前擋板攔下的那些）現在可以走了，別等 60s 回看。
          void flushAmsgState('instant-chat-settled');
        }
      }
    } catch (stageErr) {
      // 收尾本身不許再拋（它是最後一道防線），拋了就真的什麼都不剩了。
      try {
        await handleInboxStageFailure(message, stageErr);
      } catch (handlerErr) {
        log.error('inbox message 處理失敗後的收尾也掛了，這條到此為止', {
          messageId: message.messageId, error: handlerErr,
        });
      }
    }
  }
  } finally {
    // 有著落的那些去雲端帳本上銷帳。這一步是純收尾：銷不掉只是下次會再拉回來一趟，
    // 落庫那層的去重會把它擋下，所以不 await、失敗也只 warn，不連累已經落庫的事實。
    const settled = pendingMessages
      .map((m) => m.messageId)
      .filter((id) => !!id && !retainedInboxMessageIds.has(id));
    retainedInboxMessageIds.clear();
    if (settled.length > 0) {
      void ActiveMsgClient.ackOutboxMessages(settled).catch((e) => {
        log.warn('雲端帳本銷帳失敗（下次拉回來會被去重擋下）', { count: settled.length, error: e });
      });
    }
  }
  return landedMessageIds;
};

/**
 * 一輪即時對話銷帳後的補掃：再拉一次雲端帳本。末段先到時中段可能還丟在路上，而銷帳後
 * 所有按 pending 走的兜底都不會再看這一輪。寫進來的段落走原沖刷管線（保序 hold 會把它
 * 插回正確位置）。盡力而為：失敗就算了，正常路徑什麼都掃不到。
 */
const sweepSettledInstantRound = async (charId: string, uuid: string): Promise<void> => {
  const entries = await drainOutboxAndFlush('輪詢補收');
  if (entries === null) {
    log.warn('即時對話銷帳後補掃沒讀成（缺段只能等下一輪順帶）', { charId, uuid });
  }
};

// 串行化所有 flush. 兩個原因:
//   1. 防併發 flush 交錯 saveMessage —— 顯示順序 = IndexedDB 自增 id = saveMessage 調用先後
//      (見 db.ts getRecentMessagesByCharId 按 charId 索引游標取, 即 id 順序), 併發就會亂序.
//   2. 返回的 promise 在"本次及之前排隊的 flush"全部完成後才 resolve, 這樣調用方能
//      await flushInboxToChat() 保證 round-1 旁白已落庫, 再去跑 tool runner (它會觸發 round-2),
//      從根上消除跨輪 B 搶在 A 前面入庫 (用戶看到的 "B+A").
// 每段都吞掉自身異常, 保證鏈不被一個失敗的 flush 卡死.
let flushChain: Promise<unknown> = Promise.resolve();
/**
 * 排空收件箱、把裡面的消息衝進聊天流。
 *
 * 返回**這一趟真正落進聊天流**的 messageId 名單。絕大多數調用方不看它（沖刷是純副作用），
 * 但手動補收要拿它跟自己寫進收件箱的名單對一次才敢說「補回了 N 條」——寫進收件箱只是
 * 排上隊，防穿幫閘、落庫去重、多段等齊都可能把它攔在上屏之前。整趟掛掉時返回空數組
 * （異常在這裡吞掉，跟原來一樣不外拋）。
 *
 * （導出僅為讓 activeMsgRuntime.test.ts 走真庫釘「主路徑 / 降級路徑落庫時間戳同口徑」，
 *   運行時入口仍是 ActiveMsgRuntime.init 掛的監聽器。）
 *
 * trigger 是**必填**的：收件箱裡的消息可能被七八條路撈出來，光看「沖刷跑了」分不清是
 * 推送實時喊醒的、還是等滿 60 秒被兜底輪詢撈的——而這兩件事對用戶是天壤之別（前者
 * 立刻，後者最壞差一分鐘）。設成必填而不是給個默認值，是為了讓新加的調用點漏傳時
 * 編譯就報錯，而不是靜默記成一個查不出所以然的「未知」。
 */
export const flushInboxToChat = (trigger: FlushTrigger): Promise<string[]> => {
  const next = flushChain.then(async () => {
    try {
      return await flushInboxToChatImpl(trigger);
    } catch (e) {
      log.warn('flushInboxToChat failed', { trigger, error: e });
      return [];
    }
  });
  flushChain = next;
  return next;
};

// ─── 前台收件箱守望 ───
//
// Service Worker 把消息存進收件箱後會喊頁面一聲，但那一聲在 iOS 上經常喊不到：App 不在
// 最前台時，SW 拿到的「當前有哪些頁面」名單直接是空的，喊了也沒人聽見，消息就那麼躺在
// 庫裡，沒有任何人記得它還沒上屏。（線上實測：一輪 8 條推送，8 次全是空名單；同一台
// 設備同一個 SW，頁面在前台時探測卻是幾毫秒就回。）
//
// 所以這裡不再等人來喊，改成頁面自己隔幾秒數一眼收件箱。**庫裡有沒有貨，本身就是那個
// 「還有話沒傳到」的記號**，不需要 SW 額外再留什麼標記。SW 那一聲從此只是加速：喊到了
// 更快，喊不到也不影響消息能不能上屏。
const LOCAL_INBOX_WATCH_INTERVAL_MS = 3_000;
let localInboxWatchTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 數一眼本地收件箱，有貨才沖刷。**全程不走網絡**——跟「去雲端帳本撈一圈」
 * （drainOutboxAndFlush，要分頁拉、還要逐條查任務狀態）完全是兩回事，別混。
 *
 * 空表時只有一次 IndexedDB count，所以敢幾秒跑一趟；數出來是 0 就直接走人，連 trace
 * 都不記——否則幾秒一條空轉記錄，幾分鐘就能把排障真正要看的那些頂出緩衝區。
 *
 * （導出僅為讓 activeMsgRuntime.test.ts 直接釘住「空表不動手、有貨才沖刷」；
 *   運行時入口是下面的 scheduleLocalInboxWatch 和 init 裡掛的那兩個喚醒事件。）
 */
export const sweepLocalInbox = async (): Promise<void> => {
  try {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    const pending = await ActiveMsgStore.countInboxMessages();
    if (pending <= 0) return;
    await flushInboxToChat('本地巡查');
  } catch (e) {
    log.warn('本地收件箱巡查沒跑成（下一跳還會再來）', { error: e });
  }
};

/**
 * 把巡查排到下一跳。**不管頁面可不可見都排下去**，這是故意的：
 *
 * iOS 會把後台的頁面整個掛起，掛起期間定時器不走、事件也不發，恢復時既不保證有
 * visibilitychange 也不保證有別的信號。只要這條鏈一直排著，頁面一旦重新跑起來，被凍住
 * 的那一跳立刻就補上了——正確性不押在「某個事件必須送達」上。不可見時 sweepLocalInbox
 * 自己會走人，瀏覽器也會把後台定時器節流，空轉不費什麼。
 *
 * 上一跳跑完才排下一跳（而不是固定間隔硬發），免得沖刷本身慢放二十秒時排隊堆積。
 */
const scheduleLocalInboxWatch = (): void => {
  if (localInboxWatchTimer != null) clearTimeout(localInboxWatchTimer);
  localInboxWatchTimer = setTimeout(() => {
    localInboxWatchTimer = null;
    void sweepLocalInbox().finally(() => scheduleLocalInboxWatch());
  }, LOCAL_INBOX_WATCH_INTERVAL_MS);
};

// ─── 補收兜底 + 即時對話狀態點名 ────────────────────────────────────────────
// 推送是會靜默丟的（換網、代理斷流、系統壓制、SW 沒醒）。雲端每條推送發出去之前都在
// 服務端帳本上記了一行，客戶端落庫之後銷帳，所以「哪些沒收下」是查得出來的事實。
//
// 拉帳本的時機分兩類，別混：
//   1. 上線補收（catchUpMissedPushes）——冷啟動、回到前台各一次，帶節流。**不看有沒有
//      在等回覆**。定時主動消息是雲端到點自己發的，客戶端從來不知道自己在等它，
//      要是只在「欠著回覆」時才拉，它的推送丟了就永遠沒人去撈（那正是這條路存在的理由）。
//   2. 等回覆時的點名（runInstantChatStatusCheck）——每 60s 一跳，下結論前必拉一次最新的。
//      **不受節流管**：為省一次往返而跳過，就可能拿著舊帳本去判「回覆取不回」。
//
// 兩類共用 drainOutboxAndFlush，也共用同一個節流時鐘——點名拉過之後，緊跟著的上線補收
// 那一趟就會被擋下。
//
// 帳本是按用戶存的、不分角色，所以一趟就把所有角色欠的都撈回來了，不用逐個角色拉。

/**
 * 兩趟上線補收之間至少隔這麼久。
 *
 * 擋的是「切標籤頁回來一次、SW 通知一次、點通知進來一次」這種幾秒內連著觸發好幾回。
 * 取 60s 跟點名週期同檔：推送真丟了的話，用戶下次上線就該看到，不必更密；而比這更密
 * 的往返只是白付 RTT。手動補收不受這條限制（用戶自己知道丟了才點）。
 */
export const OUTBOX_CATCH_UP_MIN_INTERVAL_MS = 60_000;

/** 上一趟帳本拉取的時刻（不分入口，點名那幾條也記在這兒）。0 = 這個會話還沒拉過。 */
let lastOutboxDrainAt = 0;

/** 只給單測用：把節流時鐘撥回從沒拉過的狀態。 */
export const resetOutboxCatchUpThrottleForTesting = (): void => { lastOutboxDrainAt = 0; };

/**
 * 「有 N 條太舊了，沒能補回來」——廣播出去讓 OSContext 彈一句。
 *
 * 只報數量，不報角色名也不報內容：這條路上手裡只有帳本條目，正文還是密文，而且
 * 一趟可能跨好幾個角色。用戶需要知道的是「剛才有東西沒了、去哪兒看不了」，具體
 * 是哪條本來就已經拿不回來了。
 */
const notifyOutboxStaleDropped = (count: number): void => {
  // 跟送達端其它失敗共用一個事件名，只多一個寫死的代號。條數不進上報——屬性只能是
  // 固定枚舉（見 docs/analytics.md），而且這一格要的是「有沒有人在丟消息」，不是丟了幾條。
  trackEvent('主动消息送达失败', { kind: '超时丢弃', stage: '补收' satisfies InboxFailureStage });
  try {
    window.dispatchEvent(new CustomEvent('active-msg-backfill-stale', { detail: { count } }));
  } catch { /* SSR-safe */ }
};

/**
 * 拉一次雲端帳本、把補收到的沖刷進聊天流。
 *
 * 返回這一趟讀到的全部條目；**讀失敗返回 null**。兩者不能混：「沒讀成」不構成任何
 * 結論（網絡抖一下、請求被掐斷都會讀失敗，回覆可能好好地躺在帳本上），調用方要拿它下
 * 「回覆取不回」的判決時只能認前者。
 *
 * trigger 由調用方給：這個函數被上線補收、手動補收、60 秒點名三條路共用，而排障時
 * 要分的正是「是誰把消息撈回來的」——記成同一個就白記了。
 */
const drainOutboxAndFlush = async (trigger: FlushTrigger): Promise<AmsgOutboxEntry[] | null> => {
  lastOutboxDrainAt = Date.now();
  try {
    const { written, ackNow, entries, staleDropped } = await drainOutbox();
    // 不打算走聊天流的那些當場銷帳，免得每趟都把它們撈回來。純收尾，不 await。
    if (ackNow.length > 0) {
      void ActiveMsgClient.ackOutboxMessages(ackNow).catch((e) => {
        log.warn('帳本上跳過的條目銷帳失敗（下次會再撈一遍）', { count: ackNow.length, error: e });
      });
    }
    // 超窗銷掉的那些必須說一聲。這條路是**開 App 就自動跑**的，銷掉之後帳本上就乾淨了：
    // 用戶後來去點「找回沒收到的消息」，看到的是一句「帳本上沒有漏收的消息，這條鏈路是
    // 通的」——他剛丟了消息，界面卻在告訴他一切正常。這一句是那件事唯一的出口。
    if (staleDropped > 0) notifyOutboxStaleDropped(staleDropped);
    if (written > 0) await flushInboxToChat(trigger);
    return entries;
  } catch (e) {
    log.warn('補收失敗（等下一次時機再試）', { error: e });
    return null;
  }
};

/**
 * 上線就去帳本上撈一次漏掉的推送。冷啟動、回到前台各調一次。
 *
 * **不看有沒有即時對話在等回覆**——這正是這個入口存在的全部理由。定時主動消息由雲端
 * 到點自己發，客戶端沒有任何「我在等它」的本地狀態，推送在路上丟了（代理斷流、推送
 * 服務連不上、SW 沒醒）之後，唯一能把內容找回來的地方就是服務端帳本。掛在「欠著回覆」
 * 上的話，這類消息就是發出去即失蹤：worker 日誌全綠、任務照常消費、訂閱也沒被退回，
 * 用戶那邊只是再也收不到。
 *
 * 返回值只為單測斷言與日誌：
 *   - 'drained'：這趟真去拉了（讀到什麼、有沒有落庫看 drainOutboxAndFlush）；
 *   - 'throttled'：離上一趟不夠 OUTBOX_CATCH_UP_MIN_INTERVAL_MS，跳過；
 *   - 'worker-unset'：沒配 Worker，一個請求都不發；
 *   - 'failed'：讀帳本拋了（已在裡面 warn 過），下次時機再試。
 */
export const catchUpMissedPushes = async (
  trigger: 'startup' | 'foreground' | 'manual',
): Promise<'drained' | 'throttled' | 'worker-unset' | 'failed'> => {
  // 手動那趟是用戶自己發現丟了消息才點的，不受節流管。
  if (trigger !== 'manual'
    && lastOutboxDrainAt > 0
    && Date.now() - lastOutboxDrainAt < OUTBOX_CATCH_UP_MIN_INTERVAL_MS) {
    return 'throttled';
  }

  // 沒配過 Worker 的用戶一個請求都不該發。不靠 ensureWorkerReady 拋錯來兜：那條路每次
  // 回前台都會 warn 一行，控制台會被刷滿，而「沒配」根本不是異常。
  try {
    const config = await ActiveMsgStore.getGlobalConfig();
    if (!config?.workerUrl?.trim()) return 'worker-unset';
  } catch (e) {
    log.warn('讀不到主動消息配置，這趟補收先跳過', { error: e });
    return 'failed';
  }

  const entries = await drainOutboxAndFlush(trigger === 'manual' ? '手動補收' : '上線補收');
  return entries === null ? 'failed' : 'drained';
};

/**
 * 用戶在設置面板上手動點的那次補收：「我這兩天有消息沒收到，去帳本上找找」。
 *
 * 跟自動那條路的兩處不同，都因為「用戶自己知道自己丟了消息」這一點：
 *   1. 不受節流管——點了就該去問；
 *   2. 頭一趟也把帳本存量當補收處理（treatBacklogAsMissed），不走「整批銷帳、一條不上屏」。
 *      自動路徑分不清存量裡哪些是真丟的、哪些是當時收到了只是老版本客戶端不會銷帳，
 *      倒出來就是把用戶收過的消息重放一遍；這個判斷只有用戶自己做得了。
 *
 * 時效窗口照舊（超過 OUTBOX_BACKFILL_MAX_AGE_MS 的只銷帳不上屏），所以 written 會
 * 小於 scanned——UI 拿這三個數字如實告訴用戶「翻了多少條、補回來幾條、幾條太舊了」。
 * `stale` 單獨給一個數而不是讓 UI 拿 scanned-written 去減：那個差裡還混著思維鏈、
 * 工具請求這些本來就不進聊天流的條目，減出來會把「丟了 3 條」說成「丟了 11 條」。
 *
 * `written` 數的是**真的上了屏**的條數，不是寫進收件箱的條數：中間還隔著一趟沖刷，
 * 防穿幫閘、落庫去重、多段等齊都會把消息攔在上屏之前。按收件箱那個數報的話，界面會
 * 說「補回 3 條，去聊天裡看看」，用戶翻遍聊天記錄一條也找不到。
 *
 * 這條路不廣播 active-msg-backfill-stale：用戶正盯著這個按鈕等結果，面板會把三個
 * 數字一起說清楚，再彈一條 toast 就是同一件事說兩遍。
 *
 * 讀帳本失敗**照常拋**，讓面板報錯：手動操作沒有「下次再說」，用戶在等一個明確結果。
 */
export const catchUpMissedPushesManually = async (): Promise<{
  written: number;
  scanned: number;
  stale: number;
}> => {
  lastOutboxDrainAt = Date.now();
  const { written, writtenIds, ackNow, entries, staleDropped } = await drainOutbox({ treatBacklogAsMissed: true });
  if (ackNow.length > 0) {
    void ActiveMsgClient.ackOutboxMessages(ackNow).catch((e) => {
      log.warn('帳本上跳過的條目銷帳失敗（下次會再撈一遍）', { count: ackNow.length, error: e });
    });
  }
  // 報給用戶的是「上了屏幾條」，所以要等沖刷跑完、再拿這一趟落庫的名單跟自己寫進收件箱
  // 的名單對一次。只認自己那幾條：同一趟沖刷可能順手把收件箱裡別人（推送剛寫的）留下的
  // 也帶走了，那些不是這次補收的功勞。
  const landed = written > 0 ? new Set(await flushInboxToChat('手動補收')) : new Set<string>();
  const persisted = writtenIds.filter((id) => landed.has(id)).length;
  return { written: persisted, scanned: entries.length, stale: staleDropped };
};

let instantChatStatusPollTimer: ReturnType<typeof setTimeout> | null = null;

// ─── 狀態查詢連續失敗的判死線 ───
// 「不按時長宣判」只對**雲端還答得上話**的等待成立（pending 是雲端親口說的，等多久都對）。
// 但 worker 被刪（未知路由回 HTML 頁）、共享密鑰被換（401）這類用戶自己動過環境的場景，
// 查詢這一步會永遠拋錯——雲端的結論永遠問不出來，待收記錄就永遠銷不了帳：「正在輸入…」
// 跨重啟常亮、每 60s 空轉一跳、該角色的 fire_pack 同步被無限期掛起。聯網狀態下連續
// 多次問不出話，就把這一輪明確判死並告訴用戶去檢查 worker 配置，不再無限等。
// 計數按任務 uuid 記，查詢成功或換了輪次就清零；斷網（navigator.onLine=false）不計數
// ——那是這台設備暫時沒網，不是 worker 的錯。
const instantStatusCheckFailures = new Map<string, number>();
const INSTANT_STATUS_CHECK_MAX_FAILURES = 5;

/**
 * 頁面回到前台了：先記下時刻，再把後台期間攢下的活兒補上。
 *
 * **順序有要求**：`notePageBecameVisible()` 必須排在 flush 之前。後台期間攢下的那條
 * 消息正是「用戶看著通知點進來」的那條，flush 要靠這個時刻判出「送達時人不在場」
 * 才會跳過擬人慢放；反過來的話它會被當成實時消息又演一遍打字，而且不報任何錯。
 *
 * 補的這幾件事：
 *  - flush：頁面被凍結（iOS PWA / 移動端後台）時 SW 那條 postMessage 可能丟失，
 *    消息卡在收件箱裡不刷新（「離開後台消息不返回」）。
 *  - 上線補收：後台期間丟掉的推送去帳本上撈回來。**不管有沒有在等回覆**——定時主動
 *    消息丟了的話客戶端沒有任何本地狀態知道它來過（見 catchUpMissedPushes）。自帶節流。
 *  - 即時對話點名：欠著回覆就立刻點一次，不用再等滿 60 秒。後台不排下一跳，週期從這裡接上。
 *  - 待寫日記：寫 Notion/飛書的 fetch 後台會被凍結打斷，回前台補打。
 */
export const handlePageBecameVisible = (): void => {
  notePageBecameVisible();
  void (async () => {
    await flushInboxToChat('回到前台');
    void catchUpMissedPushes('foreground');
    void runInstantChatStatusCheck();
    void drainPendingDiaries(loadRealtimeConfigFromLocalStorage(), (charId) => {
      window.dispatchEvent(new CustomEvent('active-msg-progress', { detail: { charId } }));
    });
  })();
};

/**
 * 還欠著回覆時，把下一跳點名排到 60s 後；一條都不欠就直接撤掉定時器。
 *
 * 每次待收記錄變動都重排一次（受理 / 收到回覆 / 判失敗都會調）。絕大多數時候一條
 * 待收記錄都沒有，那時一個定時器都不留，不給所有人加一條輪詢。
 */
const scheduleNextInstantChatStatusCheck = () => {
  if (instantChatStatusPollTimer != null) {
    clearTimeout(instantChatStatusPollTimer);
    instantChatStatusPollTimer = null;
  }
  if (listInstantChatPendings().length === 0) return;
  instantChatStatusPollTimer = setTimeout(() => {
    instantChatStatusPollTimer = null;
    void runInstantChatStatusCheck();
  }, INSTANT_CHAT_STATUS_CHECK_INTERVAL_MS);
};

/**
 * 即時對話的「一直等」狀態機。客戶端不按時長宣判——worker 一次 fire 最長 10 分鐘、
 * 失敗重試間隔 2/4/6 分鐘，任何固定的客戶端超時都會搶在雲端結論之前把還在路上的
 * 回覆判死（甚至順手 cancel 掉）。這裡的做法是：還欠著回覆時，前台每 60s 點名問一次
 * 那條任務行：
 *   pending → 繼續等（雲端還在跑或在排隊重試；nextSendAt 過期是重試中的常態，不當信號）；
 *   completed（一次性任務 = 已失敗）→ 補收兜底後落一條帶 lastError 的失敗說明；
 *   gone → 補收兜底後要麼已收到（銷帳在 flush 裡做掉了），要麼明確告知取不回；
 *   查詢失敗（網絡）→ 什麼都不做，等下一跳。
 *
 * 冷啟動、回到前台、60s 定時器三個時機都走這一個入口。頁面不可見時直接走人，**也不排
 * 下一跳**：後台每分鐘醒一次去打網絡毫無意義（用戶看不見結果，移動端還會被系統掐），
 * 回前台的 visibilitychange 會立刻再點一次名，週期從那時接上。
 *
 * 每一輪下結論前都先拉一次 outbox：到點沒收到最常見的原因是推送丟了而不是生成失敗，
 * 不拉就報失敗的話，用戶會為一條其實已經生成好的回覆重發一遍（再燒一輪 LLM）。
 */
export const runInstantChatStatusCheck = async (): Promise<void> => {
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
  const pendings = listInstantChatPendings();
  // 計數器只留還在等的輪次（銷帳走別的路時這裡順手清，別攢垃圾）。
  const activeUuids = new Set(pendings.map((p) => p.uuid));
  for (const uuid of [...instantStatusCheckFailures.keys()]) {
    if (!activeUuids.has(uuid)) instantStatusCheckFailures.delete(uuid);
  }
  // 帳本是按用戶存的，一趟就把所有角色欠的都撈回來了——放在循環外拉，幾個角色同時
  // 等著回覆時也只有一次往返。
  //
  // 這趟不走上線補收那個節流：點名的語義是「下結論之前必須拿最新的帳本」，為省一次
  // 往返而跳過，就可能拿著幾十秒前的舊結論去判「回覆取不回」。冷啟動那一刻可能跟
  // 上線補收撞上一次，那是「用戶正等著回覆」才有的場景，多一次往返換判斷可靠，值。
  if (pendings.length > 0) await drainOutboxAndFlush('輪詢補收');
  for (const pending of pendings) {
    // 補收那一步如果把回覆放進來了，flush 裡已經銷帳了——這一輪就此結束。
    if (getInstantChatPending(pending.charId)?.uuid !== pending.uuid) continue;

    let status: RemoteTaskStatus;
    try {
      status = await ActiveMsgClient.getRemoteTaskStatus(pending.uuid);
    } catch (e) {
      // 設備自己沒網不算 worker 的失敗——這種失敗攢不出「worker 失聯」的結論。
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        log.warn('即時對話狀態查詢失敗（設備離線，等下一跳）', { uuid: pending.uuid, error: e });
        continue;
      }
      const count = (instantStatusCheckFailures.get(pending.uuid) ?? 0) + 1;
      if (count < INSTANT_STATUS_CHECK_MAX_FAILURES) {
        instantStatusCheckFailures.set(pending.uuid, count);
        log.warn('即時對話狀態查詢失敗（等下一跳）', { uuid: pending.uuid, count, error: e });
        continue;
      }
      // 聯網狀態下連問 N 次都問不出話：worker 多半已經不在了（被刪 / 密鑰換了 / 路由變了）。
      // 明確判死這一輪，別讓「正在輸入」永亮、fire_pack 同步無限期掛起。
      instantStatusCheckFailures.delete(pending.uuid);
      const lastError = e instanceof Error ? e.message : String(e);
      log.warn('即時對話狀態查詢連續失敗，按雲端失聯收場', { uuid: pending.uuid, count, error: e });

      // 判死之前先把遠端那行了結掉。
      //
      // 這條路跟 completed / gone 不一樣：那兩條是雲端親口給的結論（行已失敗 / 行沒了），
      // 沒什麼可取消的；而這裡從頭到尾沒問出過話，那行完全可能正掛在 2/4/6 分鐘的重試
      // 梯子上。不取消就宣判的話，用戶照著說明重發一遍，原來那行隨後又跑成功——一輪
      // 對話燒兩次 LLM，聊天流裡冒出兩份幾乎一樣的回覆。
      //
      // 取消失敗**不改判**：會走到這裡的典型場景（worker 被刪、共享密鑰被換）正是取消
      // 也一樣打不通的場景，要求取消成功才準判死，等於把「正在輸入…永亮」這個原病重新
      // 請回來。改的是措辭：取消沒落地時如實告訴用戶那行可能還會自己跑完。
      let taskCancelled = false;
      try {
        await ActiveMsgClient.cancelTask(pending.uuid);
        taskCancelled = true;
      } catch (cancelErr) {
        log.warn('判死前取消遠端任務失敗（那行可能還會自己跑完並推過來）', {
          uuid: pending.uuid, error: cancelErr,
        });
      }

      await failInstantChatPending(pending.charId, pending.uuid,
        `聯繫不上雲端 worker（連續 ${count} 次狀態查詢失敗：${lastError.slice(0, 120)}）。`
        + 'worker 可能已被刪除或共享密鑰已變，去「設置 → 主動消息 2.0」重新連接並驗證'
        + (taskCancelled ? '' : '；雲端那條任務也沒能取消，它要是自己跑完了，這一輪的回覆稍後可能還會送到'));
      continue;
    }
    instantStatusCheckFailures.delete(pending.uuid);

    if (status.state === 'pending') {
      if (status.retryCount) log.warn('即時對話雲端在重試', { uuid: pending.uuid, retryCount: status.retryCount });
      continue;
    }

    // completed / gone：再兜一次帳本（落帳與刪行之間有窗口），仍沒有才下結論。
    const entries = await drainOutboxAndFlush('輪詢補收');
    if (getInstantChatPending(pending.charId)?.uuid !== pending.uuid) continue;

    // 上游的 completed = 行還在、但已經出了 pending 隊列（sent / failed 都算這個碼）。
    // 而一次性任務發成功會把行刪掉、查出來是 gone——所以還查得到的 completed 行只可能是 failed。
    if (status.state === 'completed') {
      // 行級 lastError（409 捎來的，amsg-server 2.6.0-next.15 起）一起帶進去：chat_fail
      // 是 worker 自己寫的、拿不到 pushStatus 那個數，而「訂閱失效了，去重置」這句最有用
      // 的話正好只有它推得出來。兩份說的是同一跳，合起來看才完整。
      let reason = await readInstantChatFailReason(pending.charId, pending.uuid, status.lastError);
      // chat_fail 一條都沒留下（isolate 連人帶痕一起沒了那種）時，只用行上這份。
      if (!reason && status.lastError) {
        reason = describeInstantChatFailure(status.lastError) ?? undefined;
      }
      log.warn('即時對話雲端任務已失敗', { charId: pending.charId, uuid: pending.uuid, reason });
      await failInstantChatPending(pending.charId, pending.uuid, reason ?? '生成失敗（雲端沒記下原因）');
    } else {
      // 「取不回」的結論 = 行沒了 **且帳本讀到了、裡面確實沒有這一輪**。帳本這一步
      // 沒讀成（null）的話，結論就建立在一次失敗的網絡讀上——等下一跳再問，
      // 別把一次抖動判成生成失敗（用戶會重發、再燒一輪，隨後補收又把原回覆放出來）。
      if (entries === null) {
        log.warn('即時對話雲端那行已經沒了，但帳本沒讀成——這一跳不下結論', { charId: pending.charId, uuid: pending.uuid });
        continue;
      }
      // gone 不都是「發成功後行被刪」：skip-push（模型空輸出 / 純拒答 / 只做副作用）的
      // 一次性行同樣被上游當成功消費刪掉，worker 在那一刻寫過 chat_fail。不讀的話給
      // 用戶的解釋是「雲端已處理但回覆沒能取回」——把「沒生成出來」說成了「取不回」。
      const reason = await readInstantChatFailReason(pending.charId, pending.uuid);
      log.warn('即時對話雲端那行已經沒了，回覆也取不回', { charId: pending.charId, uuid: pending.uuid, reason });
      await failInstantChatPending(pending.charId, pending.uuid, reason);
    }
  }
  scheduleNextInstantChatStatusCheck();
};

/**
 * 雲端 chat_fail 留痕的一次點名讀，翻成給用戶看的人話；讀不到 / uuid 對不上 / 網絡
 * 失敗都返回 undefined（這是提示通道，絕不硬失敗）。completed 和 gone 兩個分支共用：
 * worker 在 fire 收尾失敗、過期跳過、以及 skip-push（空輸出）三處都會留痕。
 * 記錄認 uuid：讀到的是別輪的（比如上一輪失敗的陳痕）就當沒有，報籠統原因。
 *
 * `rowLastError` 是上游寫在任務行上的那份（有就傳）。兩份記的是同一跳，各有各的長處：
 * chat_fail 認得 `empty-generation` 這類只有 SullyOS 這邊定義的機器碼，行上那份則帶著
 * `pushStatus`——推送服務回的狀態碼只有上游發 push 的那一步知道，worker 的 fire 收尾
 * 鉤子上讀不到。所以原因用 chat_fail 的，機讀字段以行上那份打底。
 */
const readInstantChatFailReason = async (
  charId: string,
  uuid: string,
  rowLastError?: RemoteTaskLastError | null,
): Promise<string | undefined> => {
  try {
    const raw = await ActiveMsgClient.readClientStateValue(
      amsgStateNamespace(charId), AMSG_CHAT_FAIL_KEY,
    );
    const record = parseChatFailRecord(raw);
    if (record?.uuid !== uuid) return undefined;
    return describeInstantChatFailure(
      {
        ...(rowLastError ?? {}),
        at: new Date(record.at).toISOString(),
        reason: record.reason,
        // worker 那份寫的是 fire 拋錯時錯誤對象上的 code，跟行上那份同源同義；
        // 它沒寫（老 worker / 這一檔本來就沒有 code）時沿用行上那份。
        ...(record.errorCode ? { errorCode: record.errorCode } : {}),
      },
      record.retryCount,
    ) ?? undefined;
  } catch (e) {
    log.warn('即時對話失敗原因取不到（報個籠統的）', { uuid, error: e });
    return undefined;
  }
};

// ─── 訂閱變化標記（SW 寫，這裡讀/清）────────────────────────────────────────
// 瀏覽器換掉推送訂閱時 SW 的 pushsubscriptionchange 會往 ActiveMsg 庫 kv store 寫
// 一條固定 key 的標記（見 worker/sw-keep-alive.ts，key 與記錄形狀兩邊必須一致）。
// 這裡在啟動 / 收到 SW 通知時消費它：把新訂閱登記到 worker 上那一份用戶級訂閱
// （ActiveMsgClient.registerPushSubscription），成功才清標記，失敗留著下次再試。
// 一次覆蓋寫就覆蓋了全部任務——包括角色自排的那些客戶端不知道的任務。

export const PUSH_SUBSCRIPTION_CHANGED_KV_ID = 'push_subscription_changed_v1';
const ACTIVE_MSG_DB_NAME = 'ActiveMsg';
const ACTIVE_MSG_KV_STORE = 'kv';

/**
 * 不帶版本號打開 ActiveMsg 庫（跟著現有版本走，永不觸發升級/降級衝突）。
 * 打開前先讓 ActiveMsgStore 把 schema 建到當前版本——對一個不存在的庫做無版本號
 * open 會建出沒有任何 store 的 v1 空殼，誰先按版本升級誰說了算，kv 可能就沒了。
 * 用完即關：這是一條一次性的旁路連接，別跟單例連接池搶著常駐（連接風暴前科見
 * activeMsgStore.ts 註釋）。
 */
const withActiveMsgKv = async <T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> => {
  await ActiveMsgStore.getGlobalConfig();
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(ACTIVE_MSG_DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(ACTIVE_MSG_KV_STORE, mode);
      const request = run(tx.objectStore(ACTIVE_MSG_KV_STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error || request.error);
      tx.onabort = () => reject(tx.error || new Error('ActiveMsg kv tx aborted'));
    });
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
};

const hasPushSubscriptionChangeMarker = async (): Promise<boolean> =>
  Boolean(await withActiveMsgKv('readonly', (store) => store.get(PUSH_SUBSCRIPTION_CHANGED_KV_ID)));

const clearPushSubscriptionChangeMarker = async (): Promise<void> => {
  await withActiveMsgKv('readwrite', (store) => store.delete(PUSH_SUBSCRIPTION_CHANGED_KV_ID));
};

/**
 * 有「訂閱已變化」標記就把新訂閱登記上去；返回值只為單測斷言。
 *   - 'no-marker'：沒有標記（或讀標記本身失敗——那就等下次，別為一句自檢攔啟動）；
 *   - 'refreshed'：登記成功，標記已清；
 *   - 'kept'：拋錯，標記保留，下次啟動或下次 SW 通知再試。
 */
export const refreshPushSubscriptionIfMarked = async (): Promise<'no-marker' | 'refreshed' | 'kept'> => {
  let marked = false;
  try {
    marked = await hasPushSubscriptionChangeMarker();
  } catch (e) {
    log.warn('讀取訂閱變化標記失敗，跳過本次訂閱自檢', { error: e });
    return 'no-marker';
  }
  if (!marked) return 'no-marker';

  try {
    await ActiveMsgClient.registerPushSubscription();
    await clearPushSubscriptionChangeMarker();
    log.info('訂閱變化已登記到 worker');
    return 'refreshed';
  } catch (e) {
    log.warn('登記新的推送訂閱失敗，標記保留下次再試', { error: e });
    // 訂閱換了卻登記不上去 = 之後所有到點推送都石沉大海，而用戶這側一點感覺都沒有
    // （角色就是不說話了）。只報「發生了」，錯誤原文裡可能帶 push endpoint，不帶。
    trackEvent('2.0推送订阅自检失败');
    return 'kept';
  }
};

const handleDeepLink = () => {
  const currentUrl = new URL(window.location.href);
  const charId = currentUrl.searchParams.get('activeMsgCharId');
  const openApp = currentUrl.searchParams.get('openApp');

  if (openApp === 'chat' && charId) {
    window.dispatchEvent(new CustomEvent('active-msg-open', {
      detail: { charId },
    }));
  }

  // 參數只要出現過就從地址欄清掉，不管齊不齊——角色 id 留在 URL 裡，
  // 收藏、分享、截圖都會把它帶出去。統計側另有 data-exclude-search 兜底
  // （見 utils/analytics.ts），這裡管的是地址欄本身。
  if (charId !== null || openApp !== null) {
    currentUrl.searchParams.delete('openApp');
    currentUrl.searchParams.delete('activeMsgCharId');
    // Keep same-page navigation markers (for example the browser back guard)
    // while removing only the consumed deep-link parameters from the URL.
    window.history.replaceState(window.history.state, '', currentUrl.toString());
  }
};

export const ActiveMsgRuntime = {
  async init() {
    if (initialized) return;
    initialized = true;

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (event) => {
        const type = event.data?.type;
        if (type) {
          activeMsgTrace('runtime-sw-message', {
            type,
            sessionId: event.data?.sessionId,
            charId: event.data?.charId,
          });
        }
        if (type === 'active-msg-received') {
          void flushInboxToChat('SW通知');
          return;
        }

        // SW 的 pushsubscriptionchange 寫完標記後會通知一聲：頁面開著就立刻消費，
        // 不用等下次啟動。真正的判定/清理都在 refreshPushSubscriptionIfMarked 裡，
        // 通知丟了也沒關係（啟動兜底會再查一遍標記）。
        if (type === 'active-msg-subscription-change') {
          void refreshPushSubscriptionIfMarked();
          return;
        }

        // 即時對話終態失敗的直發告知（worker 判死那一刻推的 error push）：當場收尾，
        // 不用等 60s 點名。metadata 對不上號的在裡面被靜默略過。
        if (type === 'active-msg-error') {
          void handleInstantErrorPushMessage(event.data);
          return;
        }

        // 雲端後台任務跑完送回來的結果（worker 的 emitResult）。這裡是「推送直達」那條腿；
        // 另一條腿是上線補收（drainOutbox），兩邊指的是同一個分發口。銷帳不在這裡做——
        // 推來的這一份服務端帳本上也有一行，等補收那條路照常劃掉。所以同一條結果被消化
        // 兩次是常態，兩條腿還可能同時在跑（推送剛到、頁面正好回到前台）：分發口自己排隊
        // 串行（見 amsgResults），handler 各自保證重複消化不改壞數據。
        if (type === 'active-msg-result') {
          void dispatchAmsgResult(event.data?.payload);
          return;
        }

        if (type === 'REI_AMSG_PUSH') {
          const subEvent = event.data?.event;
          const payload = event.data?.payload;

          if (subEvent === 'rei-amsg-multipart-expired') {
            logAmsg.warn('multipart expired', payload);
            window.dispatchEvent(new CustomEvent('active-msg-error', {
              detail: { message: describeMultipartFailure(payload?.reason) },
            }));
          }
          return;
        }

        if (type === 'active-msg-open') {
          // 先把 inbox 落庫再廣播, 用戶回到界面時消息已經在了.
          void (async () => {
            await flushInboxToChat('點通知進入');
            window.dispatchEvent(new CustomEvent('active-msg-open', {
              detail: { charId: event.data?.charId },
            }));
          })();
        }
      });
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        // 切走也記一筆。排「消息在收件箱躺了很久」時要回答的是「那段時間頁面在幹嘛」，
        // 而只記「回來了」的話，前面那段空白到底是頁面沒在跑、還是在跑但沒人喊它，
        // 事後分不出來。
        activeMsgTrace('runtime-page-visibility', { state: document.visibilityState });
        if (document.visibilityState !== 'visible') return;
        handlePageBecameVisible();
      });
      // 冷啟動那一下（點通知才把 App 拉起來）沒有 visibilitychange 可聽，這裡補一次：
      // 不補的話「回到前台的時刻」一直是 0，從通知進來的第一條判不出「送達時人不在」。
      if (document.visibilityState === 'visible') notePageBecameVisible();
    }

    // 瀏覽器把後台頁面凍起來 / 解凍。凍結期間 JS 完全不跑，SW 喊過來的消息會排隊等
    // 解凍——這跟「SW 壓根沒喊」在事後看長得一模一樣（頁面側都是一段空白），只有這兩
    // 個事件能把它們分開。移動端和 iOS 的 PWA 凍得尤其積極。
    // 不是所有瀏覽器都發這兩個事件，收不到就當沒有，不影響其它判斷。
    if (typeof document !== 'undefined') {
      document.addEventListener('freeze', () => {
        activeMsgTrace('runtime-page-freeze');
      });
      document.addEventListener('resume', () => {
        activeMsgTrace('runtime-page-resume');
      });
    }

    // 頁面「剛活過來」的那一下，立刻數一眼收件箱，不用乾等守望的下一跳。
    // pageshow：iOS 把 App 掛起後恢復、以及 bfcache 前進/後退時會發，而 visibilitychange
    //   不一定發——線上記錄裡就有「只見進後台、不見回前台」的斷檔。
    // focus：切回窗口或標籤頁。
    // 這兩個可能跟 visibilitychange 撞在一起重複觸發，但收件箱是「取出即刪」、沖刷又都
    // 走同一條串行鏈，重複最多是多數一次個數，不會把同一條消息演兩遍。
    if (typeof window !== 'undefined') {
      window.addEventListener('pageshow', () => { void sweepLocalInbox(); });
      window.addEventListener('focus', () => { void sweepLocalInbox(); });
    }

    // 受理一輪即時對話之後（useChatAI 那邊寫記錄 + 廣播），把點名週期排上。
    if (typeof window !== 'undefined') {
      window.addEventListener(AMSG_INSTANT_CHAT_PENDING_EVENT, () => scheduleNextInstantChatStatusCheck());
    }

    // 訂閱自檢兜底：後台期間 SW 收到 pushsubscriptionchange 寫了標記、而通知丟失
    // （頁面沒開著）時，啟動這裡把它消費掉。fire-and-forget——它要打網絡請求，
    // 不能攔著下面的 inbox flush。
    void refreshPushSubscriptionIfMarked();

    // SW→頁面通道體檢：拍一張註冊關係的快照，再用推送真正走的那條路探一次通不通。
    // 這條通道斷了之後主動消息不會消失、只會慢幾十秒（兜底輪詢還在撈），表面上一切
    // 正常，所以必須主動去測——等用戶來報的時候，它可能已經壞了好幾天。
    // fire-and-forget：探測要等回信，不能攔著下面的沖刷。
    void (async () => {
      try {
        const registration = await captureSwRegistrationSnapshot();
        activeMsgTrace('runtime-sw-registration', { ...registration });
        const probe = await probeSwChannel();
        activeMsgTrace('runtime-sw-channel-probe', { ...probe });
      } catch (e) {
        log.warn('SW 通道體檢沒做成（不影響功能）', { error: e });
      }
    })();

    // 啟動兜底: 先 flush 落庫 (含上次被殺進程時卡在 inbox 的消息).
    await flushInboxToChat('啟動');
    // 上次不在線時丟掉的推送去帳本上撈回來。**這一趟無條件跑**：定時主動消息的推送
    // 丟了之後，本地不會留下任何「有條消息沒到」的痕跡，帳本是唯一的線索來源
    // （見 catchUpMissedPushes）。沒配 Worker 的用戶在裡面就返回了，不打網絡。
    void catchUpMissedPushes('startup');
    // 上次會話發出去、回來前進程就沒了的那一輪：指示燈靠 localStorage 記錄掛回來，
    // 內容靠雲端點名那一步補回來（它自帶補收，還順手把 60s 的點名週期排上）。
    if (listInstantChatPendings().length > 0) {
      void runInstantChatStatusCheck();
    }
    void drainPendingDiaries(loadRealtimeConfigFromLocalStorage(), (charId) => {
      window.dispatchEvent(new CustomEvent('active-msg-progress', { detail: { charId } }));
    });
    // 收件箱守望開跑。放在最後：上面那趟啟動沖刷已經把積壓清乾淨了，這裡接管後續。
    scheduleLocalInboxWatch();
    handleDeepLink();
  },
};
