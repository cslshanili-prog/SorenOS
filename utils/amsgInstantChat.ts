/**
 * 即時對話（instant chat）的客戶端這一半。
 *
 * 一輪聊天在這條路上的樣子：按下發送 → 一個 POST 上雲（受理即 202）→ 界面掛著
 * 「正在輸入…」→ 雲端跑完把回覆推回來 → 收件箱同一條管線入庫、指示燈滅。
 * 客戶端發完那一刻就自由了，切後台、殺進程都行。
 *
 * 這份模塊管五件事：
 *   1. 開關（唯一門檻在設置頁，運行時只讀這一份存下來的配置）；
 *   2. 「這一輪還欠著一條回覆」的待收記錄——它得**扛得住重啟**，不然重開 App
 *      指示燈就沒了，用戶以為消息丟了；
 *   3. 「這一輪還欠著哪幾條作廢回執」的台帳：回執隨 chat 段上了雲，但要等回覆真的
 *      落庫才銷帳，雲端整輪失敗時它們得退回未告知、下輪重注；
 *   4. 推送丟了的兜底：拉服務端消息帳本，把還沒收下的塞回收件箱走原路入庫；
 *   5. 收尾：雲端點名說這條任務已經失敗（或那行已經沒了）時，先拉一次帳本，
 *      還是沒有才算這一輪失敗、允許重發。等了多久本身不構成結論。
 *
 * 刻意不在這裡 flush 收件箱：flushInboxToChat 住在 activeMsgRuntime，那邊反過來要用
 * 這裡的記錄，互相 import 會成環。所以這裡只管「寫進收件箱」，沖刷由調用方接著做。
 */

import { ActiveMsg2InboxMessage, CharacterProfile, GroupProfile, RealtimeConfig, UserProfile } from '../types';
import { ActiveMsgClient, type AmsgOutboxEntry, type InstantChatProbeOutcome } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { trackEvent } from './analytics';
import { cloudApiCallLogId, recordCloudApiCall, settleCloudApiCall } from './apiCallLog';
import { announceEmotionDone } from './chatGenEvents';
import { dispatchAmsgResult } from './amsgResults';
import { DB } from './db';
import type { AmsgEmotionEvalSpec } from '../worker/amsg/src/emotionEval';

const HEADER = '[AmsgInstantChat]';

/** 還欠著回覆時，前台每隔這麼久去雲端點名問一次任務狀態。不到明確報錯不放棄。 */
export const INSTANT_CHAT_STATUS_CHECK_INTERVAL_MS = 60_000;

/** 待收記錄的落盤位置。存 localStorage 而不是內存：重啟後指示燈要還在。 */
export const AMSG_INSTANT_CHAT_PENDING_LS_KEY = 'amsg2_instant_chat_pending';

/** 待收記錄變動時廣播；Chat 界面據此點亮/熄滅「正在輸入…」。detail 只帶 charId。 */
export const AMSG_INSTANT_CHAT_PENDING_EVENT = 'amsg-instant-chat-pending';

export interface AmsgInstantChatPending {
  charId: string;
  /** 這一輪在雲端那條任務的 uuid；連發下一條時用它頂掉未認領的這條。 */
  uuid: string;
  /** 受理時刻（epoch ms），排查時看「這一輪等了多久」用。 */
  acceptedAt: number;
  /** 角色名快照（全局橫幅顯示用）。必填：唯一寫入方恆定帶上（角色名為空就是空串）。 */
  charName: string;
}

type PendingMap = Record<string, AmsgInstantChatPending>;

const readPendingMap = (): PendingMap => {
  try {
    const parsed = JSON.parse(localStorage.getItem(AMSG_INSTANT_CHAT_PENDING_LS_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: PendingMap = {};
    for (const [charId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const record = value as Partial<AmsgInstantChatPending> | null;
      if (record && typeof record.uuid === 'string' && typeof record.acceptedAt === 'number') {
        // charName 的形狀防禦是「防 localStorage 損壞/手改」，不是兼容什麼舊記錄——
        // 這個 key 與寫入方同一次發佈上線，缺名就按空串補齊。
        result[charId] = {
          charId,
          uuid: record.uuid,
          acceptedAt: record.acceptedAt,
          charName: typeof record.charName === 'string' ? record.charName : '',
        };
      }
    }
    return result;
  } catch {
    return {};
  }
};

const writePendingMap = (map: PendingMap) => {
  // 存儲滿 / 隱私模式寫不進去就算了：指示燈沒了比整輪聊天掛掉好。
  try {
    if (Object.keys(map).length === 0) localStorage.removeItem(AMSG_INSTANT_CHAT_PENDING_LS_KEY);
    else localStorage.setItem(AMSG_INSTANT_CHAT_PENDING_LS_KEY, JSON.stringify(map));
  } catch { /* 見上 */ }
};

const announcePendingChanged = (charId: string) => {
  try {
    window.dispatchEvent(new CustomEvent(AMSG_INSTANT_CHAT_PENDING_EVENT, { detail: { charId } }));
  } catch { /* SSR / 單測環境沒有 window */ }
};

/** 這個角色此刻還欠著一條雲端回覆嗎（沒有 = null）。 */
export const getInstantChatPending = (charId: string): AmsgInstantChatPending | null =>
  readPendingMap()[charId] ?? null;

export const listInstantChatPendings = (): AmsgInstantChatPending[] => Object.values(readPendingMap());

/** 受理成功後記一筆。同角色只留最新一條——頂替之後舊 uuid 已經沒人認領了。 */
export const setInstantChatPending = (
  charId: string,
  uuid: string,
  acceptedAt = Date.now(),
  charName = '',
): void => {
  const map = readPendingMap();
  map[charId] = { charId, uuid, acceptedAt, charName };
  writePendingMap(map);
  announcePendingChanged(charId);
};

/** 回覆到了（或這一輪判定失敗）→ 銷帳。沒有記錄時是冪等 no-op。 */
export const clearInstantChatPending = (charId: string): boolean => {
  const map = readPendingMap();
  if (!map[charId]) return false;
  delete map[charId];
  writePendingMap(map);
  announcePendingChanged(charId);
  return true;
};

// ─── 隨這一輪上雲的作廢回執 ───

/**
 * 防穿幫閘作廢掉的任務，要在下一輪聊天裡告訴角色一聲（「那條任務沒了」）。這些回執
 * 隨即時對話的 chat 段凍進雲端那一輪，但**回覆真的落庫之前不能銷帳**：雲端整輪失敗
 * （模型空輸出被判 skip-push、fire 重試打光）時回執不會重來，角色永遠不知道自己許下
 * 的那件事已經作廢，既不會續期也不會解釋。
 *
 * 所以這裡只是個「這一輪欠著哪幾條回執」的台帳，落 localStorage（跨得過刷新，
 * 雲端那一輪本來就可能橫跨一次重啟）。真正銷帳（寫 notifiedAt）由落庫那一側點名調
 * settleInstantChatExpiredNotices；判定失敗走 discard，回執退回未告知、下輪重注。
 */
export const AMSG_INSTANT_CHAT_STAGED_NOTICES_LS_KEY = 'amsg2_instant_chat_staged_notices';

interface StagedNotices {
  charId: string;
  /** 這些回執跟著雲端哪一輪走的。銷帳時對不上就不動——那是上一輪的帳。 */
  uuid: string;
  ids: string[];
}

type StagedNoticesMap = Record<string, StagedNotices>;

const readStagedNotices = (): StagedNoticesMap => {
  try {
    const parsed = JSON.parse(localStorage.getItem(AMSG_INSTANT_CHAT_STAGED_NOTICES_LS_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: StagedNoticesMap = {};
    for (const [charId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const record = value as Partial<StagedNotices> | null;
      if (record && typeof record.uuid === 'string' && Array.isArray(record.ids)) {
        const ids = record.ids.filter((id): id is string => typeof id === 'string' && !!id);
        if (ids.length) result[charId] = { charId, uuid: record.uuid, ids };
      }
    }
    return result;
  } catch {
    return {};
  }
};

const writeStagedNotices = (map: StagedNoticesMap) => {
  // 寫不進去（存儲滿 / 隱私模式）就當這一輪沒記：回執會在下一輪重新注入，不會丟。
  try {
    if (Object.keys(map).length === 0) localStorage.removeItem(AMSG_INSTANT_CHAT_STAGED_NOTICES_LS_KEY);
    else localStorage.setItem(AMSG_INSTANT_CHAT_STAGED_NOTICES_LS_KEY, JSON.stringify(map));
  } catch { /* 見上 */ }
};

/**
 * 記一筆「這幾條回執跟著 uuid 這一輪上雲了，還沒銷帳」。同角色只留最新一輪：
 * 連發時新那一輪會把老回執連同新的一起重新注入（它們還沒被標記告知過）。
 */
export const stageInstantChatExpiredNotices = (charId: string, uuid: string, ids: string[]): void => {
  const kept = ids.filter(Boolean);
  const map = readStagedNotices();
  if (kept.length === 0) delete map[charId];
  else map[charId] = { charId, uuid, ids: kept };
  writeStagedNotices(map);
};

/** 這個角色此刻欠著哪一輪的哪幾條回執（沒有 = null）。排查和測試用。 */
export const getStagedInstantChatExpiredNotices = (charId: string): StagedNotices | null =>
  readStagedNotices()[charId] ?? null;

/** 從台帳裡取出並刪掉這一輪的記錄；uuid 對不上（已經是新一輪了）返回空數組、不動記錄。 */
const popStagedNotices = (charId: string, uuid?: string): string[] => {
  const map = readStagedNotices();
  const record = map[charId];
  if (!record) return [];
  if (uuid && record.uuid !== uuid) return [];
  delete map[charId];
  writeStagedNotices(map);
  return record.ids;
};

/**
 * 這一輪的回覆真的落庫了 → 把隨它上雲的作廢回執銷帳（寫 notifiedAt，下輪不再注入）。
 *
 * **由落庫那一側調**：即時對話的回覆是走推送、經收件箱沖刷管線進 DB 的，銷帳時機只有
 * 那邊知道（activeMsgRuntime 認末段到齊、銷掉待收記錄的同一處）。uuid 傳這一輪的
 * taskUuid，對不上就什麼都不做——那是上一輪的帳，銷掉等於把新一輪的回執也吞了。
 *
 * 返回真正銷掉的 id（沒有可銷的返回空數組）。寫庫失敗只 warn：台帳已經取走，
 * 最壞情況是這幾條回執下輪再說一遍，比反覆銷不掉卡住整條路強。
 */
export const settleInstantChatExpiredNotices = async (charId: string, uuid?: string): Promise<string[]> => {
  const ids = popStagedNotices(charId, uuid);
  if (ids.length === 0) return [];
  try {
    await ActiveMsgStore.markExpiredNoticesNotified(charId, ids);
  } catch (error) {
    console.warn(`${HEADER} 作廢回執銷帳失敗（下一輪會再說一遍）`, { charId, ids, error });
  }
  return ids;
};

/** 這一輪沒成 → 台帳作廢、回執退回「未告知」，下一輪重新注入（回執不丟）。 */
export const discardInstantChatExpiredNotices = (charId: string, uuid?: string): string[] =>
  popStagedNotices(charId, uuid);

// ─── 開關 ───

/**
 * ready=false 時卡在哪一道。三檔不是「用戶沒開」，調用方要分開收場：
 *   config-unreadable  這一刻問不出來（明確報錯等重發，絕不悄悄退回本地）
 *   worker-outdated    問到了，那台 Worker 確實跑不動（退回本地生成，提示去更新 Worker）
 *   worker-unreachable 這一刻夠不著雲端（退回本地生成，但別叫人去更新——多半是網絡）
 *
 * 後兩檔都得留痕：用戶的主觀意願是「上雲」，實際走的卻是本地，不留痕就是一次靜默分流。
 */
export type InstantChatReadinessReason =
  | 'disabled'
  | 'char-disabled'
  | 'no-worker-url'
  | 'worker-outdated'
  | 'worker-unreachable'
  | 'config-unreadable';

export interface InstantChatReadiness {
  ready: boolean;
  reason?: InstantChatReadinessReason;
}

// ─── 存量說「跑不動」時的現探 ───
//
// 存量是粘的：一旦寫成 false，只有下一次探測成功才翻得回來，而探測原本只掛在握手
// （一次會話一次）和打開設置頁兩處。用戶不進設置頁，就會一直卡在本地生成。
//
// 所以這裡補一次**懶重探**：只有存量已經是 false 時才探，且帶冷卻。成本壓得很準——
// 狀態正常的人一次額外請求都不加，只有已經降級的人付這點延遲，而他們本來就在走一條
// 對自己未必通的本地路徑，拿 0.4 秒換回雲端完全值得。

/** 存量已經是 false 時，最多每隔這麼久現探一次，看能不能翻回來。 */
export const INSTANT_CHAT_REPROBE_COOLDOWN_MS = 30_000;

/** 現探卡這麼久還沒回話就算了，這一輪照常走本地——絕不把用戶按在發送鍵上乾等。 */
export const INSTANT_CHAT_REPROBE_TIMEOUT_MS = 3_000;

let lastReprobeAt = 0;
/** 上一次現探問到了什麼。冷卻期內沿用它，別讓同一段時間裡的消息報出忽左忽右的原因。 */
let lastReprobeOutcome: InstantChatProbeOutcome = 'unknown';
/** 同一刻好幾條消息一起進來時共用同一次探測，別打出一串併發的 /config-check。 */
let reprobeInFlight: Promise<InstantChatProbeOutcome> | null = null;

/**
 * 把冷卻清零，讓下一條消息立刻重探。
 * 網絡剛恢復時調（online 事件），換 Worker / 改配置的地方也可以調。
 */
export const resetInstantChatReprobeCooldown = (): void => { lastReprobeAt = 0; };

// 切代理節點不會觸發 online，所以這個監聽只是「便宜的加速」，不是恢復的唯一指望——
// 真正兜底的是上面那道冷卻到期後的現探。
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('online', resetInstantChatReprobeCooldown);
}

/**
 * 現探一次，返回這次問到了什麼。冷卻期內不探，沿用上一次的結論。
 */
const reprobeInstantChatSupport = async (): Promise<InstantChatProbeOutcome> => {
  if (reprobeInFlight) return reprobeInFlight;
  if (Date.now() - lastReprobeAt < INSTANT_CHAT_REPROBE_COOLDOWN_MS) return lastReprobeOutcome;
  lastReprobeAt = Date.now();
  const task = (async () => {
    try {
      const result = await ActiveMsgClient.probeInstantChatSupportDetailed({
        timeoutMs: INSTANT_CHAT_REPROBE_TIMEOUT_MS,
      });
      return result.outcome;
    } catch {
      return 'unknown' as const;
    }
  })();
  reprobeInFlight = task;
  try {
    lastReprobeOutcome = await task;
    return lastReprobeOutcome;
  } finally {
    reprobeInFlight = null;
  }
};

/**
 * 即時對話此刻走不走得通，外加「走不通是因為什麼」。
 *
 * 門檻四道：角色沒單獨關（傳了 char 才查）、設置頁開了、那台 Worker 跑得動、Worker
 * 地址填著。
 *
 * 「跑得動」平時讀的是**存量**（config.instantChatSupported），由 probeInstantChatSupport
 * 在握手和打開設置頁時刷新。走存量是為了省 RTT：狀態正常的人一條消息都不該多花一次
 * 網絡往返。undefined = 還沒探過，放行——那一檔說明我們不知道，不是知道它不行。
 *
 * 只有存量已經是 false（= 上一次明確探到跑不動）時，這裡才補一次現探，看能不能翻回來，
 * 詳見 reprobeInstantChatSupport。額外開銷精確落在已經降級的那批人身上，而他們本來就在
 * 走一條對自己未必通的本地路徑。
 *
 * 為什麼這道門非要有：跑不動的 Worker 上這條路是**發一條掛一條**（老 bundle 被 waitUntil
 * 砍在 30 秒，新 bundle 少了起跳器則直接 503），而開關還寫著「已開啟」。讓位給本地生成
 * 頂多是少一個後台能力，比讓用戶對著「正在輸入」乾等強。
 *
 * 配置讀不出來（IndexedDB 被別的標籤頁 versionchange 卡住、iOS 存儲壓力…）單獨成一檔：
 * 它不等於「用戶沒開」。當成沒開的話這一輪會悄悄退回本地直連生成——用戶按完發送隨手
 * 鎖屏，本地 fetch 被系統掐掉，回來時既沒有回覆也沒有報錯，設置頁還寫著「已開啟」。
 * 所以這裡就地 warn 一聲，調用方按這個 reason 單獨收場（useChatAI 裡這一檔會留一條
 * trace，並且明確報錯等用戶重發，不發起本地生成）。
 */
export const resolveInstantChatReadiness = async (
  char?: Pick<CharacterProfile, 'activeMsg2Config'>,
): Promise<InstantChatReadiness> => {
  // 角色自己關了 → 這一輪回到本地前台生成。這是用戶的主動選擇，跟「全局沒開」同一
  // 待遇：靜默走本地，不 warn 不留 trace。undefined = 跟隨全局默認開，只認顯式 false；
  // 全局配置都不用讀——讀出什麼這一輪都不上雲。
  if (char?.activeMsg2Config?.instantChatEnabled === false) {
    return { ready: false, reason: 'char-disabled' };
  }
  let config: Awaited<ReturnType<typeof ActiveMsgStore.getGlobalConfig>>;
  try {
    config = await ActiveMsgStore.getGlobalConfig();
  } catch (error) {
    console.warn(`${HEADER} 全局配置讀不出來，這一輪判斷不了即時對話開沒開（按走不通處理，但這不是「沒開」）`, error);
    return { ready: false, reason: 'config-unreadable' };
  }
  if (!config.instantChatEnabled) return { ready: false, reason: 'disabled' };
  // 地址排在能力前面：沒填地址時那份能力位多半是上一台 Worker 留下的存量，
  // 報「Worker 太舊」會把人指去點一個根本沒連上的東西。
  if (!config.workerUrl?.trim()) return { ready: false, reason: 'no-worker-url' };
  // 開著、地址也在，但存量說那台 Worker 上這條路是壞的。
  //
  // 先現探一次再下結論：這份 false 可能是**舊版本**在一次網絡抖動裡寫下的誤判（那會兒
  // 「探不到」和「探到不行」共用一個 false），也可能是用戶當時真的還沒更新 Worker。
  // 不重探的話，前者要一直等到用戶碰巧打開設置頁才糾正得過來。
  if (config.instantChatSupported === false) {
    const outcome = await reprobeInstantChatSupport();
    if (outcome === 'supported') {
      console.info(`${HEADER} 重探到那台 Worker 現在跑得動即時對話（存量是過期結論），這一輪照常上雲`);
      return { ready: true };
    }
    // 靜默讓位正是「靜默分流」那個老坑，所以兩檔都就地 warn 一聲，調用方還會額外留一條
    // trace——用戶至少查得到「為什麼開了卻走本地」。兩檔的去向不同，別混：
    if (outcome === 'unsupported') {
      console.warn(`${HEADER} 開關是開的，但那台 Worker 跑不動即時對話（缺起跳器或還是舊 bundle）：這一輪本地生成。去設置頁點「更新 Worker」`);
      return { ready: false, reason: 'worker-outdated' };
    }
    // 夠不著雲端時別叫人去更新 Worker——他多半點不動，而且問題也不在那兒。
    console.warn(`${HEADER} 開關是開的，但這一刻夠不著雲端（問不出新結論）：這一輪本地生成，連上了會自己回到雲端`);
    return { ready: false, reason: 'worker-unreachable' };
  }
  return { ready: true };
};

/** 只關心「走不走得通」的調用點用這個（設置頁的互斥門）。要區分原因走上面那個。 */
export const isInstantChatReady = async (): Promise<boolean> =>
  (await resolveInstantChatReadiness()).ready;

// ─── 「這一輪走的哪條路」廣播給界面 ───
//
// 開關寫著「已開啟」、消息卻在本地生成，這中間的落差過去只留在 console 和觀察窗裡，
// 普通用戶查不到——他能看到的只有一條讀不懂的網絡報錯。所以每一輪都把結論播出去，
// 由輸入框上方那條小提示接住。

/** detail 是 InstantChatRouteDetail。每一輪都發，包括「這一輪回到雲端了」。 */
export const AMSG_INSTANT_CHAT_ROUTE_EVENT = 'amsg-instant-chat-route';

export interface InstantChatRouteDetail {
  charId: string;
  /** null = 這一輪走的雲端（界面上把提示收起來）；否則是讓位給本地生成的原因。 */
  reason: InstantChatReadinessReason | null;
}

export const announceInstantChatRoute = (detail: InstantChatRouteDetail): void => {
  try {
    window.dispatchEvent(new CustomEvent(AMSG_INSTANT_CHAT_ROUTE_EVENT, { detail }));
  } catch { /* SSR / 測試環境無 window */ }
};

// ─── 發這一輪 ───

// POST /instant-chat 在飛（發出到 202 之間）的角色。待收記錄要等 202 才寫，而掛起
// fire_pack 常規上傳的那道擋板（amsgStateSync）原本只認待收記錄——慢網上傳幾 MB 的
// 那幾秒裡，別處打髒觸發的常規包（沒有 chat 段）可能晚於 POST 內部那次 client-state
// 寫入落地，把帶 chat 段的包蓋掉，worker 到點只會硬失敗。所以從按下發送那一刻起就
// 佔位，擋板認「佔位或待收」，202 後由待收記錄接棒，失敗則釋放。
const inFlightSends = new Set<string>();

/** POST /instant-chat 正在飛（還沒等到 202/失敗）嗎。amsgStateSync 的掛起擋板用。 */
export const isInstantChatSendInFlight = (charId: string): boolean => inFlightSends.has(charId);

export interface InstantChatSendResult {
  ok: boolean;
  uuid?: string;
  /** 失敗時給用戶看的整句（已經是能照著做的話）。 */
  error?: string;
}

/**
 * 把這一輪交給雲端。**只有 202 才算發出去**，別的一律 ok:false，由調用方明確報錯、
 * 允許重發，絕不悄悄退回本地生成。
 *
 * 連發兩條時帶上一條還沒銷帳的 uuid：包裝層會盡力取消那條未認領的任務，兩句話合成
 * 一次回覆。上一條已經在跑了（取消不掉）也不影響這一條，最多兩句相近的回覆。
 */
export const sendInstantChatTurn = async (params: {
  char: CharacterProfile;
  chatMessages: Array<{ role: string; content: unknown }>;
  /** 本地生成這一輪會用的憑據（effectiveApi），雲端必須用同一份。 */
  api: { baseUrl: string; apiKey: string; model: string };
  /** 本地這一輪會發的採樣溫度；開思考時本地不發溫度，這裡也就不傳。 */
  temperature?: number;
  maxTokens?: number;
  /**
   * 本地這一輪會額外塞進請求體的字段（現在只有思考鏈那三件：thinking /
   * reasoning_effort / extra_body，見 useChatAI 的 shouldSendThinkingParams 分支）。
   * 原樣帶給 worker 展開——雲端發出去的請求體必須和本地一字不差，不然開思考的
   * 角色一開即時對話心象卡片就靜默消失。不傳就是本地也不發。
   */
  extraBody?: Record<string, unknown>;
  userProfile: UserProfile;
  groups: GroupProfile[];
  realtimeConfig: RealtimeConfig;
  /**
   * 這一輪的情緒評估，一起交給雲端跑（提示詞模板 + 副 API 憑據）。
   * 不傳就是這一輪不評估（角色沒開情緒評估 / 本輪跳過）。
   */
  emotionEval?: AmsgEmotionEvalSpec;
}): Promise<InstantChatSendResult> => {
  const supersedes = getInstantChatPending(params.char.id);
  inFlightSends.add(params.char.id);
  // 這一輪在「API 調用記錄」裡的那一筆：本地這條路只經手一個 POST，真正的模型請求
  // 是雲端發的，日誌的全局攔截器夠不著——不在這兒記，用戶就會看到聊天從記錄裡消失。
  // meta 跟本地生成那條路對齊（useChatAI 傳給 safeFetchJson 的那份），兩條路在列表裡
  // 長得一樣，只多一個雲端標記。
  const logMeta = {
    appName: '消息',
    charId: params.char.id,
    charName: params.char.name,
    purpose: '聊天回覆',
  };
  try {
    const { uuid } = await ActiveMsgClient.sendInstantChat({
      char: params.char,
      chatMessages: params.chatMessages,
      api: params.api,
      ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
      ...(params.maxTokens ? { maxTokens: params.maxTokens } : {}),
      ...(params.extraBody ? { extraBody: params.extraBody } : {}),
      userProfile: params.userProfile,
      groups: params.groups,
      realtimeConfig: params.realtimeConfig,
      ...(params.emotionEval ? { emotionEval: params.emotionEval } : {}),
      ...(supersedes ? { supersedesUuid: supersedes.uuid } : {}),
    });
    // 先記待收再釋放佔位（finally），擋板的兩個信號無縫交接，不留「都不認」的空窗。
    setInstantChatPending(params.char.id, uuid, Date.now(), params.char.name);
    recordCloudApiCall({
      id: cloudApiCallLogId(uuid),
      route: 'cloud-instant-chat',
      baseUrl: params.api.baseUrl,
      model: params.api.model,
      messages: params.chatMessages,
      meta: logMeta,
    });
    // 頂掉的那一輪也得收尾：客戶端從這一刻起不再等它的回覆了（雲端把兩句合成一次回，
    // 它已經在跑的情況下頂不掉，但那份回覆也認不回這條記錄）。不收的話它會一直寫著
    // 「雲端生成中」，直到 5 天后被裁掉。
    if (supersedes) {
      settleCloudApiCall({ id: cloudApiCallLogId(supersedes.uuid), ok: true, superseded: true });
    }
    return { ok: true, uuid };
  } catch (error: any) {
    // 只報失敗、只有事件名（跟送達端那幾條同一條口徑）：失敗原因裡帶著 HTTP 狀態和
    // 上游報文，不進上報。用戶側同一時刻已經有明確的報錯提示，這裡只記「發生過」。
    trackEvent('即时对话发送失败');
    // 沒交上去的這一輪同樣進記錄：界面上那句報錯關掉就沒了，而日誌裡留得住——
    // 交不上去往往跟這次要發的東西有多大有關，輸入構成就在這條記錄裡。
    recordCloudApiCall({
      id: `cloud-send-failed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      route: 'cloud-instant-chat',
      baseUrl: params.api.baseUrl,
      model: params.api.model,
      messages: params.chatMessages,
      meta: logMeta,
      sendFailed: true,
    });
    return { ok: false, error: error?.message || String(error) };
  } finally {
    inFlightSends.delete(params.char.id);
  }
};

/**
 * 這一輪回來了 → 把「API 調用記錄」裡那筆掛著的補完。
 *
 * `metadata` 是這一輪**最後一條**推送帶回來的那份：雲端把用量（`amsgUsage`）和工具
 * 痕跡（`amsgToolTrace`）都掛在末條上。補收路徑拿到的是同一份（帳本存的就是推送信封
 * 的副本），所以推送丟了也照樣補得上。
 *
 * 雲端回傳的用量只有**最後一次**模型調用那一份——帶工具的一輪會連著調好幾次模型，
 * 中間幾次的數在雲端就沒留下。跑過工具就把這筆標成「只算末輪」，讓用戶知道這個數字
 * 偏小，別拿它去跟帳單對齊。
 */
export const settleInstantChatApiLog = (uuid: string, metadata?: Record<string, any> | null): void => {
  const num = (value: unknown): number | undefined =>
    (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  const usage = metadata?.amsgUsage;
  const toolTrace = metadata?.amsgToolTrace;
  settleCloudApiCall({
    id: cloudApiCallLogId(uuid),
    ok: true,
    promptTokens: num(usage?.promptTokens),
    completionTokens: num(usage?.completionTokens),
    tokensPartial: Array.isArray(toolTrace) && toolTrace.length > 0,
  });
};

// ─── 推送丟了的兜底：拉服務端消息帳本 ───

/**
 * 推送信封 → 收件箱記錄。
 *
 * 字段映射必須和 SW 收到真推送時寫的那一份一致（worker/sw-keep-alive.ts 的
 * saveContentToInbox），否則同一條消息經兩條路進來會長得不一樣：時間戳口徑、
 * 多段等齊守衛、防穿幫閘讀的全是這些字段。
 */
export const outboxPushToInbox = (
  payload: Record<string, any>,
  receivedAt: number,
): ActiveMsg2InboxMessage | null => {
  const charId = payload?.metadata?.charId;
  if (typeof charId !== 'string' || !charId) return null;
  const body = String(payload?.message || payload?.body || '').trim();
  const notificationBody = typeof payload?.notification?.body === 'string'
    ? payload.notification.body.trim()
    : '';
  const parsedSentAt = payload?.timestamp ? new Date(payload.timestamp).getTime() : NaN;
  return {
    messageId: String(payload?.messageId || `${charId}-outbox-${receivedAt}`),
    charId,
    charName: payload?.contactName || payload?.metadata?.charName || '主動消息',
    body,
    previewBody: notificationBody || body,
    avatarUrl: payload?.avatarUrl,
    source: payload?.source,
    messageType: payload?.messageType,
    messageSubtype: payload?.messageSubtype,
    taskId: payload?.taskId ?? null,
    taskUuid: payload?.taskUuid ?? null,
    recurrenceType: payload?.recurrenceType ?? null,
    occurrenceMs: payload?.occurrenceMs ?? null,
    metadata: {
      ...(payload?.metadata || {}),
      sessionId: payload?.sessionId,
      messageIndex: payload?.messageIndex,
      totalMessages: payload?.totalMessages,
      // 走到這裡 = 真推送沒送到、從雲端副本撿回來的。銷帳那邊靠它決定要不要順手
      // 取消還掛在重試隊列裡的任務行（正常送達的路沒這個標記，一個多餘請求不發）。
      // SW 那份映射（saveContentToInbox）刻意沒有這個鍵：它只在補收路徑為真。
      amsgOutboxBackfill: true,
    },
    sentAt: Number.isFinite(parsedSentAt) ? parsedSentAt : receivedAt,
    receivedAt,
  };
};

/**
 * 補收的時效窗口：比這更早落帳的條目不再往聊天流裡放，直接銷帳。
 *
 * 兩個理由。一是**噪音**：隔太久才補上來的「早上好」既尷尬又打斷當下的對話，
 * 而這條路本來是為「推送剛剛丟了」準備的，正常補收都在幾十秒到幾分鐘內完成。
 * 二是**接上帳本這一刻的存量**：帳本從建表起就在攢行，而客戶端是這一版才開始銷帳的，
 * 頭一次拉會把歷史積壓一次性倒出來——不掐時效的話，那些早就落過庫的老消息會因為
 * 超出近史去重的查詢窗口而重新上屏。
 *
 * 定在兩天而不是一天：真實場景裡用戶是「週五晚上丟了一條，週日才想起來打開」，
 * 一天的窗口連隔夜加一個白天都蓋不住，人還沒意識到丟了消息，唯一的副本就已經在
 * 上一次開 App 時被銷掉了。兩天能蓋住「隔一夜 + 第二天想起來」這個最常見的節奏。
 *
 * 超窗的那些不會無聲無息地消失，見 OutboxDrainResult.staleDropped。
 */
export const OUTBOX_BACKFILL_MAX_AGE_MS = 48 * 60 * 60 * 1000;

export interface OutboxDrainResult {
  /** 寫進收件箱、等著沖刷落庫的條數。 */
  written: number;
  /**
   * 寫進收件箱的那幾條的 messageId。
   *
   * 「寫進收件箱」離「上了屏」還差一道沖刷（防穿幫閘、落庫去重、多段等齊都可能把它
   * 攔下）。調用方要如實告訴用戶「補回了幾條」時，得拿這份名單跟沖刷那邊真正落庫的
   * 名單對一次，光看 written 會把被攔下的也算成補回來了。
   */
  writtenIds: string[];
  /** 不走聊天流、當場就能銷帳的 messageId（太老的、不進聊天流的那幾類）。 */
  ackNow: string[];
  /** 這一趟從帳本上讀到的全部條目。調用方按輪次下結論時要看它。 */
  entries: AmsgOutboxEntry[];
  /**
   * 這一趟裡**因為超出時效窗口**被銷掉的聊天內容條數。
   *
   * 單獨數出來，是因為這一檔跟 ackNow 裡其它幾類的性質完全不同：思維鏈、工具請求
   * 那些本來就不該進聊天流，銷掉不損失任何東西；而這一檔是**用戶本該收到、現在
   * 永久拿不回來的消息**。混在一起的話，「開一次 App 就把唯一的副本銷掉了」這件事
   * 從頭到尾沒有任何一處說得出口——用戶後來去點「找回沒收到的消息」，只會看到
   * 一句「帳本上沒有漏收的消息，這條鏈路是通的」。
   */
  staleDropped: number;
}

/**
 * 「這台設備已經接上服務端帳本」的標記。
 *
 * 帳本是服務端從建表那一刻起就在攢的，而銷帳是客戶端這一版才有的能力。所以**第一次**
 * 拉帳本時上面躺著的並不是「我丟了的消息」，而是這套機制生效之前積累下來的存量——
 * 當成補收放進聊天流的話，用戶會被自己這段時間收過的消息重放一遍（定時問候、多段
 * 回覆全部再來一次）。時效窗口擋不住這一檔：存量的年齡本來就在窗口之內。
 *
 * 所以首次接管那一趟只做一件事：**存量整批銷帳，一條都不往聊天流裡放**。銷乾淨了才
 * 記這個標記，下一趟起才按正常補收處理。
 */
export const AMSG_OUTBOX_ADOPTED_LS_KEY = 'amsg2_outbox_adopted_v1';

const hasAdoptedOutbox = (): boolean => {
  try {
    return !!localStorage.getItem(AMSG_OUTBOX_ADOPTED_LS_KEY);
  } catch {
    // 存儲讀不出來（隱私模式 / 存儲關停）時按**已接管**處理：這一檔下標記永遠也寫不
    // 進去，當成未接管的話每一趟都會把當趟條目整批銷掉，補收就永久失效了——推送真丟
    // 的時候一條都補不回來，比偶爾多倒一次存量嚴重得多。
    return true;
  }
};

const markOutboxAdopted = (): void => {
  try {
    localStorage.setItem(AMSG_OUTBOX_ADOPTED_LS_KEY, JSON.stringify({ at: Date.now() }));
  } catch { /* 寫不進去就下次再接管一遍，反正存量已經銷掉了 */ }
};

/**
 * 首次接管：帳本上的存量整批銷帳、不進聊天流。
 *
 * 兩類例外照常走補收：
 *   - 用戶**此刻正等著的那幾輪**（taskUuid 跟待收記錄對得上）：那是剛剛發生的事，不是
 *     歷史積壓——否則第一次接管恰好趕上用戶發消息時，那一輪的回覆會被當存量銷掉，用戶
 *     等來的是一句「回覆沒能取回」。
 *   - **後台任務的結果**（`messageKind: 'result'`）：它們本來就是靠補收到達的（不彈通知
 *     的結果上游只落帳本、不發推送），跟存量一起銷掉的話，雲端跑完的門牌整理會一聲不響
 *     地蒸發。而且它們不進聊天流，沒有「重放一遍」這回事——首次接管要防的是刷屏，不是
 *     數據落地。換設備 / 重裝 PWA / 清過 localStorage 的用戶走的正是這條路。
 *
 * 銷帳成功才記標記。沒銷乾淨就這一趟什麼都不做、也不記標記：沒銷掉的條目下次還會
 * 拉回來，那時仍按接管處理。反過來（先記標記再銷帳）一旦銷帳失敗，剩下的存量下一趟
 * 就會被當成補收倒進聊天流，正是這裡要防的那件事。
 */
const adoptOutboxBacklog = async (entries: AmsgOutboxEntry[]): Promise<OutboxDrainResult> => {
  const awaitedUuids = new Set(listInstantChatPendings().map((pending) => pending.uuid));
  const isAwaited = (entry: AmsgOutboxEntry) => !!entry.taskUuid && awaitedUuids.has(entry.taskUuid);
  const isResult = (entry: AmsgOutboxEntry) => entry.push?.messageKind === 'result';
  const keep = (entry: AmsgOutboxEntry) => isAwaited(entry) || isResult(entry);
  const backlogIds = entries.filter((entry) => !keep(entry)).map((entry) => entry.messageId);

  if (backlogIds.length > 0) {
    try {
      await ActiveMsgClient.ackOutboxMessages(backlogIds);
    } catch (error) {
      console.warn(`${HEADER} 帳本存量沒銷乾淨，這一趟先不接管（下次重來）`, error);
      return { written: 0, writtenIds: [], ackNow: [], entries, staleDropped: 0 };
    }
  }
  markOutboxAdopted();
  console.log(`${HEADER} 第一次接上雲端帳本：存量 ${backlogIds.length} 條直接銷帳，不往聊天流裡放`);

  // 上面整批銷掉的存量走的是 ackOutboxMessages，不經過 backfillOutboxEntries，所以
  // 不會計進 staleDropped——那批是「這台設備接上帳本之前的歷史」，不是「本該收到卻
  // 過期了」，報給用戶只會讓人以為剛丟了一堆消息。
  return { ...await backfillOutboxEntries(entries.filter(keep)), entries };
};

/**
 * 這條帳本行對應的消息，本地聊天記錄裡是不是已經有了。
 *
 * 判據跟沖刷那側的落庫去重是同一條：每條落庫氣泡都繼承 `metadata.activeMsg2.messageId`
 * （見 activeMsgRuntime.flushInboxToChatImpl 裡的 isAlreadyPersisted）。兩處各留一份是
 * 因為這個模塊不能反過來 import activeMsgRuntime（會成環，見文件頭），改判據時兩邊一起改。
 *
 * 近史查詢按角色緩存：一趟補收裡同一個角色常常有好幾條要核對。查不出來就按「本地沒有」
 * 處理——這一檔只決定要不要跟用戶說「拿不回來了」，寧可多說一次也別把丟消息說成沒事。
 */
const isPushAlreadyInChat = async (
  push: Record<string, any>,
  cache: Map<string, Set<string>>,
): Promise<boolean> => {
  const charId = push?.metadata?.charId;
  const messageId = push?.messageId;
  if (typeof charId !== 'string' || !charId) return false;
  if (typeof messageId !== 'string' || !messageId) return false;
  let ids = cache.get(charId);
  if (!ids) {
    try {
      const recent = await DB.getRecentMessagesByCharId(charId, 200);
      ids = new Set(
        recent
          .map((m: any) => m?.metadata?.activeMsg2?.messageId)
          .filter((id: unknown): id is string => typeof id === 'string' && !!id),
      );
    } catch (error) {
      console.warn(`${HEADER} 核對本地聊天記錄失敗，這條按「本地沒有」處理`, { charId, error });
      ids = new Set<string>();
    }
    cache.set(charId, ids);
  }
  return ids.has(messageId);
};

/**
 * 把帳本條目寫回收件箱走原路入庫。
 *
 * 只有正文類（`content` 與情緒結果）才往收件箱裡放。思維鏈、工具請求、錯誤通知
 * 這幾類補收回來已經沒有意義：思維鏈要掛在正文上、工具請求那頭的雲端早就收工了、
 * 隔了一陣子的報錯彈出來只會讓人摸不著頭腦。它們照樣要銷帳，不然每次拉都拉回來。
 *
 * `result`（worker 的 emitResult 送回來的後台產物）不進收件箱——它不是聊天內容，
 * 交給 amsgResults 按 resultKind 派活，消化成功才銷帳。這類結果**本來就是靠補收
 * 到達的**：不彈通知的結果上游只落帳本、不發推送，所以這條路是它唯一的入口，
 * 跟著上面那批一起銷帳丟掉的話，後台跑完的東西會一聲不響地全部蒸發。
 */
const backfillOutboxEntries = async (
  entries: AmsgOutboxEntry[],
): Promise<Omit<OutboxDrainResult, 'entries'>> => {
  const now = Date.now();
  const ackNow: string[] = [];
  const writtenIds: string[] = [];
  let written = 0;
  let staleDropped = 0;
  // 超齡行核對本地聊天記錄時用的近史緩存，一趟補收內每個角色只查一次。
  const persistedIdsByChar = new Map<string, Set<string>>();
  // 收件箱裡已經躺著的那些，各自是什麼時候到這台設備的。
  //
  // 補收拉回來的這批，跟 Service Worker 直送進收件箱的那批是同一批消息、同一個主鍵，
  // 寫進去就是整條覆蓋。如果連「到達時間」也一起覆蓋成現在，這條消息在收件箱裡躺了多久
  // 就再也查不出來了（永遠顯示「剛到」），而「送達時用戶在不在場」正是靠它判的——判錯
  // 的後果是：明明是用戶離開時到的、通知早就完整念過一遍的消息，回來還要一條條重演打字。
  // 所以已經有到達時間的，保留原值；這一趟只覆蓋內容，不改它第一次落地的時刻。
  const knownReceivedAt = new Map<string, number>();
  try {
    for (const existing of await ActiveMsgStore.listInboxMessages()) {
      if (typeof existing.receivedAt === 'number' && existing.receivedAt > 0) {
        knownReceivedAt.set(existing.messageId, existing.receivedAt);
      }
    }
  } catch (error) {
    // 讀不到就按「全是新的」處理：頂多是時間戳記成現在，不該攔住補收本身。
    console.warn(`${HEADER} 讀收件箱已有到達時間失敗（這批按新到處理）`, { error });
  }

  for (const entry of entries) {
    const push = entry.push || {};
    const kind = typeof push.messageKind === 'string' ? push.messageKind : 'content';
    if (kind === 'result') {
      // 聊天那道兩天的時效窗刻意不套在結果上：結果晚到本來就是常態（正是為此才上雲的），
      // 隔一天回來照樣該落地，跟「隔一天才彈出來的報錯」不是一回事。
      // 但「多晚算太晚」得有人管——帳本留 28 天，換設備 / 重裝 PWA 的用戶第一次接上帳本
      // 會把老結果一次性拉回來。這裡不替各種產物定規矩，只把帳本上記的時間原樣交給認領
      // 它的那一方，由它按自己的語義判（門牌整理的上限見 PLATE_RESULT_MAX_AGE_MS）。
      if (await dispatchAmsgResult(push, { createdAt: entry.createdAt })) ackNow.push(entry.messageId);
      continue;
    }
    if (kind !== 'content' && kind !== 'emotion_update') {
      ackNow.push(entry.messageId);
      continue;
    }
    if (entry.createdAt > 0 && now - entry.createdAt > OUTBOX_BACKFILL_MAX_AGE_MS) {
      // 超齡不等於用戶沒收到。帳本行躺到超齡，最常見的成因恰恰是**消息早就送達了**，
      // 只是收尾那筆銷帳是 fire-and-forget（鎖屏 / 切後台就被掐斷），帳一直掛著沒銷。
      // 所以先拿 messageId 去本地聊天記錄裡核對一遍：找得到就只是補一次銷帳，既不算
      // 「拿不回來了」，也不該彈那句「已經拿不回來了」的紅字——用戶明明看過這條消息。
      if (await isPushAlreadyInChat(push, persistedIdsByChar)) {
        ackNow.push(entry.messageId);
        continue;
      }
      // 數出來交給調用方說給用戶聽：這一銷，這條消息就永久沒了（見 staleDropped）。
      staleDropped += 1;
      ackNow.push(entry.messageId);
      continue;
    }
    const message = outboxPushToInbox(push, now);
    if (!message) {
      // 連角色都認不出來（信封缺 metadata.charId），留著也沒人能處理。
      ackNow.push(entry.messageId);
      continue;
    }
    // 情緒結果在 SW 那側是單獨一條寫法，這裡顯式對齊：沖刷管線靠這個字段分流，
    // 認不出來就會被當成一條正文氣泡渲染出去。
    if (kind === 'emotion_update') message.messageType = 'emotion_update';
    // 這條 SW 早就送到過（只是還沒被沖刷消費）：保住它真正落地的那個時刻。
    const firstSeenAt = knownReceivedAt.get(message.messageId);
    if (firstSeenAt != null) message.receivedAt = firstSeenAt;
    try {
      await ActiveMsgStore.saveInboxMessage(message);
      written += 1;
      writtenIds.push(message.messageId);
    } catch (error) {
      // 寫不進去就**不銷帳**，下次拉回來再試。
      console.warn(`${HEADER} 補收寫入收件箱失敗（帳沒銷，下次再來）`, { messageId: entry.messageId, error });
    }
  }

  if (written > 0) console.log(`${HEADER} 從雲端帳本補收 ${written} 條（推送多半是丟了）`);
  if (staleDropped > 0) {
    console.warn(`${HEADER} 帳本上有 ${staleDropped} 條超出補收窗口，只銷帳不上屏（這些消息拿不回來了）`);
  }
  return { written, writtenIds, ackNow, staleDropped };
};

/**
 * 拉一次服務端消息帳本，把還沒收下的寫回收件箱走原路入庫。
 *
 * 跟以前那套「本地比對著猜哪些沒收到」的關鍵差別：**帳本是服務端記的事實**，
 * 客戶端不再需要拿最近幾條聊天記錄去反推。讀失敗照常拋——「沒讀成」和「讀到了、
 * 裡面確實沒有」是兩個結論，調用方要拿它下判決時只能認後者。
 *
 * 頭一次拉走的是另一條路（見 adoptOutboxBacklog）：那一趟帳本上裝的是存量，不是
 * 「我丟了的消息」。
 *
 * 調用方拿到 written > 0 之後要自己 flush 一次收件箱（見文件頭注：不在這裡 flush
 * 是為了避免和 activeMsgRuntime 成環）。要跟用戶報「補回了幾條」的，還得拿 writtenIds
 * 跟沖刷返回的落庫名單對一次——寫進收件箱不等於上了屏。
 */
export const drainOutbox = async (
  options?: {
    /**
     * 頭一趟也把存量當「我丟了的消息」補收（默認 false = 走 adoptOutboxBacklog 整批銷帳）。
     *
     * 只給用戶手點的那次補收用：自動路徑分不清存量裡哪些是真丟的、哪些是當時收到了只是
     * 客戶端還不會銷帳，倒出來就是重放；而用戶是察覺到「消息沒來」才去點那個按鈕的，
     * 這個判斷他自己做得了。按補收處理之後照樣記下接管標記，後面回到自動路徑。
     */
    treatBacklogAsMissed?: boolean;
  },
): Promise<OutboxDrainResult> => {
  const entries = await ActiveMsgClient.listOutboxEntries();
  if (!hasAdoptedOutbox()) {
    if (!options?.treatBacklogAsMissed) return await adoptOutboxBacklog(entries);
    markOutboxAdopted();
  }
  return { ...await backfillOutboxEntries(entries), entries };
};

/**
 * 這一輪收尾成「沒等到回覆」：銷帳 + 在聊天流裡留一條說明。
 *
 * 只在雲端給了明確結論之後調（任務行已失敗 / 行沒了而 outbox 裡也沒有），所以這裡
 * 不再去 cancel 那條任務——失敗的行不會再跑，沒了的行也沒什麼可取消的。
 *
 * `uuid` 是這個結論說的是哪一輪，**必傳**：從查到結論到落這條說明之間隔著網絡往返
 * （查失敗原因要去雲端點名讀一份 chat_fail 留痕），這期間用戶完全可能
 * 又發了一條，待收記錄已經換成新的 uuid 了。不認 uuid 就動手的話，銷掉的是新那一輪
 * 的帳——「正在輸入」當場熄滅，聊天流裡還多一條它其實沒失敗的說明。對不上就直接走人，
 * 讓新那一輪自己走完它的判定。
 *
 * `reason` 是雲端記下的失敗原因（有就帶給用戶看）。沿用本地路徑失敗時那條系統消息的
 * 形態（`[…]` 的方括號系統消息），用戶能直接看到發生了什麼、也知道可以重發。
 * 寫庫失敗只 warn——指示燈該滅還是得滅。
 */
export const failInstantChatPending = async (
  charId: string,
  uuid: string,
  reason?: string,
): Promise<void> => {
  if (getInstantChatPending(charId)?.uuid !== uuid) return;
  if (!clearInstantChatPending(charId)) return;
  // 這一輪隨 chat 段上雲的作廢回執跟著作廢：沒銷帳 = 還是「未告知」，下一輪會重新
  // 注入。銷掉的話角色永遠不知道那條任務被作廢過，聊天裡許下的承諾就這麼沒了。
  discardInstantChatExpiredNotices(charId, uuid);
  // 「情緒更新中」那盞燈也在這裡熄。
  //
  // 平時它的熄滅信號搭在最後一條回覆的推送上（metadata.amsgEmotionDone，見
  // activeMsgRuntime 收側）。可這一輪要是一條推送都沒有——模型空輸出/純拒答被 worker
  // 判成 skip-push，或者整條 fire 硬失敗——那個信號永遠不會到，燈只能乾等十來分鐘的
  // 安全網（useChatAI 的 cloudEvalTimeoutMs，按 worker fire 上限推導），中途還會彈一句
  // 「worker 可能是舊版」的誤導提示。雲端已經點名說這一輪沒成，就是最確定的熄燈時機。
  //
  // 派在寫庫之前：寫庫失敗只 warn，燈不該被它連累（同上面那句註釋的口徑）。
  announceEmotionDone(charId);
  // 只報失敗、只有事件名：雲端點名說這一輪沒成（或回覆取不回來）。這一格漲起來說明
  // 雲端生成或推送鏈路在掉隊，比用戶來報「一直在輸入」早得多。
  trackEvent('即时对话云端任务失败');
  // 「API 調用記錄」裡那筆掛著的也收尾，否則它會一直寫著「雲端生成中」直到被裁掉。
  settleCloudApiCall({ id: cloudApiCallLogId(uuid), ok: false });
  try {
    await DB.saveMessage({
      charId,
      role: 'system',
      type: 'text',
      content: reason
        ? `[即時對話沒能完成：${reason}。可以重新發一次。]`
        : '[即時對話沒能完成：雲端已處理這條消息，但回覆沒能取回（推送和雲端副本都沒拿到）。可以重新發一次。]',
    });
    window.dispatchEvent(new CustomEvent('active-msg-progress', { detail: { charId } }));
  } catch (error) {
    console.warn(`${HEADER} 失敗說明寫入失敗`, { charId, error });
  }
};
