/**
 * 主動消息 2.0「滿血」的前端狀態同步層。
 *
 * 打髒入口不止聊完一輪（useChatAI）：改人設 / 改記憶 / 刪改消息 / 面板取消任務這些會
 * 改變 fire_pack 內容的落庫路徑也會調 markAmsgStateDirty（大多匯在 OSContext 的
 * updateCharacter 落庫點），打髒後立即把所有髒角色的 fire_pack 批量上傳 worker 的
 * client_state；切後台（visibilitychange→hidden）也沖刷一次——iOS 只給幾秒存活窗口，
 * 必須一次請求寫完。
 *
 * 只對「已排程 AI 模式 amsg2 任務」的角色生效，其餘 markDirty 直接忽略。
 *
 * 髒標記有一份極輕量的 localStorage 底帳（只存 charId 數組，不存快照本體）：打髒時寫入、
 * 上傳成功後移除。請求還沒落地（在飛、或躺在退避重排裡）就被殺進程的話，下次啟動 OSContext 調 resumePendingAmsgStateSync
 * 按底帳重建快照補傳一次——否則那次改動雲端永遠不知道，角色到點帶舊上下文說話。
 *
 * 上傳失敗會**退避重試**，不能一失敗就把快照丟掉：雲端那份 fire_pack 是到點時角色
 * 唯一的上下文來源，刷不上去就意味著角色帶著舊上下文發消息（提的「最近聊的事」其實是
 * 上一次同步成功時的狀態，順帶 lastUserMessageAt 也舊，worker 側防穿幫閘的錨點判定
 * 跟著失真）。而最容易失敗的恰恰是切後台那次沖刷，也正是「睡前聊完 → 關 App → 凌晨
 * 觸發」這條最常見的路徑。
 *
 * 它和排程時那次上傳的區別只在失敗的處理方式：排程那次是硬要求（失敗就讓整個排程失敗，
 * 見 activeMsgClient 的 putClientStateOrThrow），這裡退避重試幾次，實在傳不上去就等
 * 下一輪聊天重新打髒標記。
 *
 * 雲端還有一份 tool_config（工具憑據 / MCP 服務器 / 代理地址），走的是同一套退避 + 底帳，
 * 入口是 syncAmsgToolConfig（見文件下半部分）。它不像 fire_pack 那樣每輪聊天重傳，
 * 所以那一次傳丟了就得靠自己補。
 */

import { APIConfig, CharacterProfile, GroupProfile, RealtimeConfig, UserProfile } from '../types';
import { ActiveMsgClient, isLlmCredentialsReady, owesInstantChatReply } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { hasActiveAiTask } from './amsg2Tasks';
import { AmsgChatPresence, CHAT_PRESENCE_HEARTBEAT_MS } from './amsgChatPresence';
import {
  buildCharChatCredRow,
  buildCharEmotionCredRow,
  knownCredIds,
  parseCharCredId,
  pickChangedCredRows,
  type LlmCredentialRow,
} from './amsgLlmCredentials';
import { trackEvent } from './analytics';
import { DB } from './db';
import { resolveUserProfileForChar } from './userPersona';

/** 失敗重試的退避起點，逐次翻倍（30s → 60s → 120s）。 */
const RETRY_BASE_MS = 30_000;
/**
 * 角色欠著即時對話回覆時，它的快照掛起不傳（見 flushAmsgState 裡的掛起段）；
 * 隔這麼久再來看一眼帳銷了沒有——銷帳走的是「回覆到了 / 判失敗」那幾條路，
 * 它們不會替這邊觸發沖刷。
 */
const INSTANT_DEFER_RECHECK_MS = 60_000;
/** 連續失敗幾次後放手，等下一輪聊天重新打髒標記——避免離線時無限重排。 */
const MAX_RETRIES = 3;
const HEADER = '[AmsgStateSync]';

export interface AmsgSyncSnapshot {
  char: CharacterProfile;
  userProfile: UserProfile;
  groups: GroupProfile[];
  realtimeConfig?: RealtimeConfig;
}

// charId → 最新快照。同角色多輪聊天只留最後一份，flush 永遠用最新狀態拼模板。
const dirty = new Map<string, AmsgSyncSnapshot>();
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let lifecycleBound = false;
let retryCount = 0;
/** 「退避打光了還是沒傳上去」每次會話只上報一次。 */
let staleStateReported = false;

// ─── 打髒後的合併窗口 ───
// 一輪聊天不止打一次髒，而且**不在同一個 tick**：收尾在 finally 裡、情緒 buff 落庫在
// 副 API 回來後的事件回調裡、記憶寫入又是一撥；用戶連刪幾條消息更是一次操作一個 tick。
// 微任務合併只能收攏同 tick 的連環調用，上面這些各自觸發一次「重讀 200 條近史 + 重建
// 系統提示詞 + gzip + 加密 + PUT ~40KB」的完整沖刷。這裡給一個短的固定合併窗口：
// 第一次打髒起 1.5s 內的都並進同一次上傳。數據丟失窗口不回退——底帳（persistDirtyMark）
// 在打髒那一刻就寫了，切後台有 visibilitychange 的立即沖刷，殺進程有啟動補傳。
/** 打髒合併窗口（固定窗口不順延：持續打髒也保證 1.5s 內必衝一次）。 */
export const FLUSH_DEBOUNCE_MS = 1_500;
let flushDebounceTimer: ReturnType<typeof setTimeout> | null = null;
/** 沖刷進行中又有人打髒，這次傳完得再跑一輪（丟棄的話那份快照就永遠躺在隊列裡了）。 */
let reflushRequested = false;

const queueFlush = () => {
  if (flushDebounceTimer != null) return;
  flushDebounceTimer = setTimeout(() => {
    flushDebounceTimer = null;
    void flushAmsgState('dirty');
  }, FLUSH_DEBOUNCE_MS);
};

// ─── 髒標記輕量持久化 ───
// 內存隊列在「打髒 → 請求還沒落地（在飛或在退避重排裡）就被殺進程」時會整個蒸發，
// 重開 App 也不補傳。這裡只把 charId 記進 localStorage 當底帳
// （快照本體下次啟動從 DB 重建，存本體只會留一份過期數據）。
export const AMSG2_PENDING_SYNC_LS_KEY = 'amsg2_pending_sync_char_ids';

const readPendingCharIds = (): string[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(AMSG2_PENDING_SYNC_LS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
};

const writePendingCharIds = (ids: string[]) => {
  // 存儲滿 / 隱私模式寫不進去就算了：底帳只是兜底，失敗不能影響內存隊列正常同步。
  try {
    if (ids.length === 0) localStorage.removeItem(AMSG2_PENDING_SYNC_LS_KEY);
    else localStorage.setItem(AMSG2_PENDING_SYNC_LS_KEY, JSON.stringify(ids));
  } catch { /* 見上 */ }
};

const persistDirtyMark = (charId: string) => {
  const ids = readPendingCharIds();
  if (!ids.includes(charId)) writePendingCharIds([...ids, charId]);
};

/**
 * 一批快照處理完（上傳成功 / 判定無處可傳）後清底帳。
 * 只清「內存裡已經不髒」的：上傳期間同角色又被打髒的話，新標記不能被這批的收尾抹掉。
 */
const prunePersistedMarks = (batch: AmsgSyncSnapshot[]) => {
  const settled = new Set(batch.map((s) => s.char.id).filter((id) => !dirty.has(id)));
  if (settled.size === 0) return;
  writePendingCharIds(readPendingCharIds().filter((id) => !settled.has(id)));
};

const bindLifecycleListener = () => {
  if (lifecycleBound || typeof document === 'undefined') return;
  lifecycleBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && dirty.size > 0) {
      void flushAmsgState('hidden');
    }
  });
};

/** 一輪聊完（或角色資料變更後）打髒標記；非 amsg2 AI 任務角色直接忽略。 */
export const markAmsgStateDirty = (snapshot: AmsgSyncSnapshot) => {
  const config = snapshot.char.activeMsg2Config;
  if (!config?.enabled || !hasActiveAiTask(config)) return;

  dirty.set(snapshot.char.id, snapshot);
  persistDirtyMark(snapshot.char.id);
  bindLifecycleListener();
  queueFlush();
};

/**
 * 全局素材變了（表情庫這類不屬於某個角色的東西）：每個角色的 fire_pack 裡都烤著一份
 * 打包那會兒的快照，所以逐個打髒。門在 markAmsgStateDirty 裡，沒開主動消息的角色自己會被篩掉。
 *
 * 表情庫尤其要緊：角色到點發的 [[SEND_EMOJI]] 引用的是包裡那份清單，用戶刪了 / 改了名字
 * 之後雲端還照著舊清單說話，客戶端反查不到就只能落降級文本氣泡。
 *
 * 傳的是 userProfileBase（沒套用任何身份的那份），不是已經套用好的 userProfile——不同角色
 * 可能在「分角色身份指定」裡各自綁了不同的身份卡（見 utils/userPersona.ts 的
 * resolveUserProfileForChar），一份套死的 userProfile 會讓沒綁自己那張卡的角色全部
 * 打髒成同一個名字。這裡逐個角色按自己的綁定重新解析。
 */
export const markAmsgStateDirtyForAll = (scope: {
  characters: CharacterProfile[];
  userProfileBase: UserProfile;
  groups: GroupProfile[];
  realtimeConfig: RealtimeConfig;
}) => {
  for (const char of scope.characters) {
    markAmsgStateDirty({
      char,
      userProfile: resolveUserProfileForChar(scope.userProfileBase, char.id),
      groups: scope.groups,
      realtimeConfig: scope.realtimeConfig,
    });
  }
};

/**
 * 把沒傳上去的快照放回待傳隊列。
 * 同角色已經有更新的快照時保留新的——舊快照的唯一價值就是「比雲端那份新」，
 * 已經被更新的一份取代後再塞回去只會讓下次上傳倒退。
 */
const requeue = (batch: AmsgSyncSnapshot[]) => {
  for (const snapshot of batch) {
    if (!dirty.has(snapshot.char.id)) dirty.set(snapshot.char.id, snapshot);
  }
};

/** 把所有髒角色的 fire_pack 批量上傳。失敗退避重排，快照留在隊列裡等下次。 */
export const flushAmsgState = async (reason: string): Promise<void> => {
  // 這次沖刷把隊列帶走了，還掛著的合併窗口就不用再響一次（響了也只是空跑一趟）。
  // 順手把句柄歸零：不歸零的話，外部觸發的沖刷（hidden / resume / 測試清理）之後
  // 隊列裡再打的髒會以為已有窗口在等，實際那個 timer 早沒了。
  if (flushDebounceTimer != null) { clearTimeout(flushDebounceTimer); flushDebounceTimer = null; }
  // 工具憑據欠著的話順手一起補：它和 fire_pack 一樣是「雲端那份過時了」，
  // 而且沖刷時機（切後台 / 聊完一輪）正是網絡多半又通了的時候。
  void runToolConfigSync(`flush:${reason}`);
  // LLM 憑據行同理，而且它欠著的後果更硬：雲端那份還是舊 Key 的話，已排程的任務
  // 到點全部 401。
  void runLlmCredentialSync(`flush:${reason}`);
  // 已經有一次在飛：這次的髒數據留在隊列裡，等那次落地後由 finally 補跑（直接 return
  // 的話，上傳期間打的髒就此擱淺，等不到任何人來傳）。
  if (flushing) { reflushRequested = true; return; }
  // 隊列空 = 沒有欠著的快照，之前那串失敗也就翻篇了，退避計數跟著歸零。
  if (dirty.size === 0) { retryCount = 0; return; }
  if (retryTimer != null) { clearTimeout(retryTimer); retryTimer = null; }
  // 欠著即時對話回覆（含 POST 還在飛、202 未回）的角色這次掛起不傳：那一輪的 fire_pack
  // 是 POST /instant-chat 帶上去的、多一段 chat（worker 到點全靠它拿這輪的對話），
  // 常規重建的包沒有 chat 段，現在覆蓋上去的話 worker 到點只會硬失敗（fire_pack 裡
  // 沒有 chat 段）。判定用 activeMsgClient 那份共用的 owesInstantChatReply——排程那條路
  // （scheduleCharacterTask 建任務前也要寫 fire_pack）跟這裡必須是同一把尺。
  // 快照連底帳一起留在隊列裡，銷帳後的下一次沖刷（含下面那個定時回看）照傳不誤。
  const deferredIds = new Set([...dirty.keys()].filter(owesInstantChatReply));
  if (deferredIds.size === dirty.size) {
    // 全都欠著回覆：這次一個都傳不了，排個回看就走（retryTimer 剛在上面清空過，直接排）。
    scheduleDeferredRecheck();
    return;
  }
  flushing = true;
  const batch = [...dirty.values()].filter((snapshot) => !deferredIds.has(snapshot.char.id));
  try {
    const globalConfig = await ActiveMsgStore.getGlobalConfig();
    if (!globalConfig.workerUrl?.trim()) {
      // 沒配 worker = 這些快照沒有去處，不是「傳失敗」，清掉即可（連底帳一起，
      // 掛起的那些同樣沒有去處）。
      const all = [...dirty.values()];
      dirty.clear();
      prunePersistedMarks(all);
      return;
    }

    for (const snapshot of batch) dirty.delete(snapshot.char.id);
    await ActiveMsgClient.syncCharFirePacks(batch.map((snapshot) => ({
      char: snapshot.char,
      config: snapshot.char.activeMsg2Config!,
      userProfile: snapshot.userProfile,
      groups: snapshot.groups,
      realtimeConfig: snapshot.realtimeConfig,
    })));
    retryCount = 0;
    // 傳上去了才清底帳；失敗路徑不清——底帳就是給「重試沒等到就被殺」兜底的。
    prunePersistedMarks(batch);
  } catch (error) {
    requeue(batch);
    if (retryCount < MAX_RETRIES) {
      const delay = RETRY_BASE_MS * 2 ** retryCount;
      retryCount += 1;
      console.warn(`${HEADER} flush(${reason}) 失敗，${Math.round(delay / 1000)}s 後重試（第 ${retryCount}/${MAX_RETRIES} 次）`, error);
      if (retryTimer != null) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => { void flushAmsgState('retry'); }, delay);
    } else {
      // 重排到頭了（多半是離線）。快照留在隊列裡：下次打髒標記 / 切後台都會再試，
      // 在那之前雲端仍是上一份，角色到點會帶舊上下文——所以這條要吼出來。
      console.error(`${HEADER} flush(${reason}) 連續 ${MAX_RETRIES} 次失敗，雲端 fire_pack 仍是上一份（角色到點會用舊上下文）`, error);
      // 用戶這一側完全無感：不報錯、不提示，只是角色到點說的話對不上最近發生的事。
      // 每次會話最多報一次（一輪退避打完才會走到這兒，但一次會話可以有好幾輪）。
      if (!staleStateReported) {
        staleStateReported = true;
        trackEvent('2.0云端状态同步失败');
      }
      retryCount = 0;
    }
  } finally {
    flushing = false;
    if (reflushRequested) {
      reflushRequested = false;
      // 兩種情況不用補跑：隊列空（上面那批把它一起帶走了）；已經排了退避重傳
      // （重傳本來就帶上隊列裡的全部快照，此刻再打一次只是立刻重蹈覆轍，還白吃一次退避額度）。
      // 失敗也不是一律不補跑：退避打光那條路不留 timer，此時飛行中打的髒會當場補跑一次
      // 並重開一輪退避——有新數據值得再試，且退避上限管著，不會變成死循環。
      if (dirty.size > 0 && retryTimer == null) void flushAmsgState('reflush');
    }
    // 還有掛起（欠即時對話回覆）的快照時排個回看，銷帳後把它們傳掉。
    if (deferredIds.size > 0 && retryTimer == null) scheduleDeferredRecheck();
  }
};

/** 排一個「即時對話銷帳後回來傳掛起快照」的回看。佔用 retryTimer 這一個槽。 */
const scheduleDeferredRecheck = () => {
  retryTimer = setTimeout(() => { void flushAmsgState('instant-chat-deferred'); }, INSTANT_DEFER_RECHECK_MS);
};

/**
 * 啟動補傳：上次會話打過髒、但沒等到上傳就被殺進程的角色，按 localStorage 底帳重建
 * 快照再傳一次。OSContext 在啟動數據加載完成後調用，characters 傳的就是剛從 DB 讀回
 * 的全量角色（快照數據源 = DB），上傳複用 markDirty → flush → syncCharFirePacks 原路。
 *
 * 殘留的 charId 可能已經刪角色 / 關掉 amsg2 / 任務全發完了——這些直接靜默清除底帳：
 * 找不到的角色沒得傳，markDirty 的門拒掉的角色也不該再賴在底帳裡。
 */
export const resumePendingAmsgStateSync = (scope: {
  characters: CharacterProfile[];
  userProfile: UserProfile;
  groups: GroupProfile[];
  realtimeConfig?: RealtimeConfig;
  /** 啟動時那份聊天 API 配置；缺了就補不了 LLM 憑據行的欠帳（其餘照常補）。 */
  apiConfig?: APIConfig;
}) => {
  // 工具憑據的欠帳也在這兒補。底帳只記「欠著一次」，憑據本體不落 localStorage
  // （那等於把 token 又抄一份到別的地方），補傳用啟動時這份最新配置——它本來就是
  // 雲端此刻該有的那一份。
  if (hasPersistedToolConfigMark()) syncAmsgToolConfig(scope.realtimeConfig);
  // LLM 憑據行同理（同樣只記欠帳、不落憑據本體）。
  if (scope.apiConfig && hasPersistedCredSyncMark()) syncAmsgLlmCredentials(scope.apiConfig);

  const pending = readPendingCharIds();
  if (pending.length === 0) return;

  // 先整個清掉：還該傳的角色下面 markDirty 會把 id 重新寫回去，不該傳的就此了帳。
  writePendingCharIds([]);
  for (const charId of pending) {
    const char = scope.characters.find((c) => c.id === charId);
    if (!char) continue; // 角色已刪除，靜默跳過
    markAmsgStateDirty({
      char,
      userProfile: scope.userProfile,
      groups: scope.groups,
      realtimeConfig: scope.realtimeConfig,
    });
  }
  // 當場沖刷，不等 markDirty 排的那個微任務——這份欠帳已經拖了一次進程生死了。
  if (dirty.size > 0) void flushAmsgState('resume');
};

// ─── 同角色活躍會話租約（Heartbeat）───
// 一輪真實用戶消息進入生成流程時啟動：立即寫一次 chat_presence，之後每 15s 續租，
// 成功/失敗/中斷後停止本地續租，遠端值靠 45s TTL 自然失效。它只代表「正在和這個角色
// 交互」，不是 App 在線狀態——切後台就停續租，別讓一個閒置可見標籤頁無限續租。

interface ChatPresenceLease {
  timer: ReturnType<typeof setInterval>;
  /** 本輪最新的「最近一條真實用戶消息」時間戳；續租時讀它，不吃閉包裡的陳舊值。 */
  lastUserMessageAt: number | null;
}

// charId → 心跳租約。同一 char 只保留一個 timer（重入只刷新 lastUserMessageAt）。
const chatPresenceLeases = new Map<string, ChatPresenceLease>();

/**
 * 實時感知配置（工具憑據）改動後，把雲端的兩份狀態一起對齊。
 *
 * 雲端有兩份東西依賴這套憑據，必須同進同退：
 *   1. tool_config —— 憑據本身；
 *   2. fire_pack 裡的系統提示詞 —— 它是**按當時的配置裁剪過**的，沒配的工具連說明都不注入
 *      （見 chatPrompts 的 notionEnabled / feishuEnabled / searchEnabled 門控）。
 *
 * 只更前者會留下一個窗口：雲端提示詞還在教角色用 Notion 日記，憑據已經被關掉了，角色到點
 * 照著舊提示詞調工具，拿回 not_configured。所以兩個動作合成一個入口，調用方無法只做一半。
 *
 * 誰需要刷新由 markAmsgStateDirty 內部的門決定（沒開 2.0 / 沒有待觸發 AI 任務的角色直接
 * 忽略），所以這裡可以無腦把全部角色遞進來。
 */
export const syncAmsgToolConfigAndPrompts = (
  realtimeConfig: RealtimeConfig,
  scope: { characters: CharacterProfile[]; userProfile: UserProfile; groups: GroupProfile[] },
) => {
  // 上傳失敗不打斷保存：本地配置已經生效，雲端那份由 syncAmsgToolConfig 自己退避重傳，
  // 傳不上去也留著底帳等下次啟動補（fire_pack 那種「下一輪聊天順手帶上」的便車，
  // tool_config 是坐不了的——沖刷只傳 fire_pack）。
  syncAmsgToolConfig(realtimeConfig);
  for (const char of scope.characters) {
    markAmsgStateDirty({ char, userProfile: scope.userProfile, groups: scope.groups, realtimeConfig });
  }
  void flushAmsgState('tool-config-change');
};

// ─── 工具憑據（tool_config）的重試與底帳 ───
// fire_pack 每輪聊天都會重傳，掉一次下一輪就補上；tool_config 不吃這條便車——它只在
// 用戶保存配置那一刻傳一次，那一次失敗就再沒有人會補。而它偏偏是有對外副作用的一份：
// 用戶刪掉的 MCP 服務器、換掉的 token，雲端還是舊的，worker 半夜照舊帶著舊憑據直連。
// 所以這裡給它配上和 fire_pack 同款的退避重試 + localStorage 底帳。

export const AMSG2_PENDING_TOOL_CONFIG_LS_KEY = 'amsg2_pending_tool_config';

/** 待上傳的那份配置。undefined 也是合法載荷（= 什麼都沒配），所以另用 flag 表示「欠著」。 */
let pendingToolConfig: RealtimeConfig | undefined;
let hasPendingToolConfig = false;
let toolConfigSyncing = false;
let toolConfigRetryCount = 0;
let toolConfigRetryTimer: ReturnType<typeof setTimeout> | null = null;

const writeToolConfigMark = (pending: boolean) => {
  // 存儲滿 / 隱私模式寫不進去就算了：底帳只是給「重試沒等到就被殺」兜底的。
  try {
    if (pending) localStorage.setItem(AMSG2_PENDING_TOOL_CONFIG_LS_KEY, '1');
    else localStorage.removeItem(AMSG2_PENDING_TOOL_CONFIG_LS_KEY);
  } catch { /* 見上 */ }
};

const hasPersistedToolConfigMark = (): boolean => {
  try { return localStorage.getItem(AMSG2_PENDING_TOOL_CONFIG_LS_KEY) === '1'; } catch { return false; }
};

const runToolConfigSync = async (reason: string): Promise<void> => {
  if (!hasPendingToolConfig || toolConfigSyncing) return;
  toolConfigSyncing = true;
  // 記下這次傳的是哪一份：上傳期間用戶又改了配置的話，清帳不能把新的那份一起清掉。
  const snapshot = pendingToolConfig;
  try {
    const globalConfig = await ActiveMsgStore.getGlobalConfig();
    if (!globalConfig.workerUrl?.trim()) {
      // 沒配 worker = 這份憑據沒有去處，不是「傳失敗」，連底帳一起清掉。
      hasPendingToolConfig = false;
      pendingToolConfig = undefined;
      writeToolConfigMark(false);
      return;
    }
    await ActiveMsgClient.syncToolConfig(snapshot);
    if (pendingToolConfig === snapshot) {
      hasPendingToolConfig = false;
      pendingToolConfig = undefined;
      writeToolConfigMark(false);
    }
    toolConfigRetryCount = 0;
  } catch (error) {
    if (toolConfigRetryCount < MAX_RETRIES) {
      const delay = RETRY_BASE_MS * 2 ** toolConfigRetryCount;
      toolConfigRetryCount += 1;
      console.warn(`${HEADER} tool_config(${reason}) 上傳失敗，${Math.round(delay / 1000)}s 後重試（第 ${toolConfigRetryCount}/${MAX_RETRIES} 次）`, error);
      if (toolConfigRetryTimer != null) clearTimeout(toolConfigRetryTimer);
      toolConfigRetryTimer = setTimeout(() => { void runToolConfigSync('retry'); }, delay);
    } else {
      // 退避打光了（多半是離線）。底帳留著：下次啟動 / 下次沖刷繼續補。
      console.error(`${HEADER} tool_config(${reason}) 連續 ${MAX_RETRIES} 次失敗，雲端仍是上一份工具配置（後台可能帶著已被刪掉的服務器或舊 token 調工具）`, error);
      toolConfigRetryCount = 0;
    }
  } finally {
    toolConfigSyncing = false;
  }
};

/**
 * 工具憑據上雲的唯一入口（實時感知保存、MCP 配置變更、代理地址改動都走它）。
 * 立即傳一次，失敗退避重試，並在 localStorage 留底帳等啟動 / 下次沖刷補傳。
 */
export const syncAmsgToolConfig = (realtimeConfig: RealtimeConfig | undefined): void => {
  pendingToolConfig = realtimeConfig;
  hasPendingToolConfig = true;
  toolConfigRetryCount = 0;
  if (toolConfigRetryTimer != null) { clearTimeout(toolConfigRetryTimer); toolConfigRetryTimer = null; }
  writeToolConfigMark(true);
  void runToolConfigSync('change');
};

// ─── LLM 憑據行（credRefs）的重傳 ───
//
// 雲端那張憑據表和 tool_config 處境一樣：只在用戶改配置那一刻傳一次，那一次丟了就再沒
// 人補。而它比 tool_config 更要命——傳不上去意味著**已排程的任務到點還在用舊 Key**，
// 換 Key 之後每條主動消息都是 401。所以退避重試 + localStorage 底帳整套跟著 tool_config
// 那份走，連觸發時機（每次沖刷順手補一次、啟動時按底帳補一次）都是同一批。
//
// 重算哪幾行：底帳裡記著的那些（= 真的用過的那些）。只重算「值是持久化配置的純函數」的
// 兩種用途——`chat`（定時主動消息）與 `emotion`（情緒評估）。`instant` 那一行不在這裡
// 重算：它的 model 是每一輪聊天的請求體終值（claude 系開思考時帶 -thinking 後綴），
// 靠這裡的配置推不出來；那一行由每次發消息的路徑自己按當輪終值覆蓋（值沒變就不發請求）。

export const AMSG2_PENDING_CRED_SYNC_LS_KEY = 'amsg2_pending_llm_creds';

/** 待重傳用的那份聊天配置。憑據本體不落 localStorage，底帳只記「欠著一次」。 */
let pendingCredApiConfig: APIConfig | undefined;
let hasPendingCredSync = false;
let credSyncing = false;
let credRetryCount = 0;
let credRetryTimer: ReturnType<typeof setTimeout> | null = null;

const writeCredSyncMark = (pending: boolean) => {
  // 存儲滿 / 隱私模式寫不進去就算了：底帳只是給「重試沒等到就被殺」兜底的。
  try {
    if (pending) localStorage.setItem(AMSG2_PENDING_CRED_SYNC_LS_KEY, '1');
    else localStorage.removeItem(AMSG2_PENDING_CRED_SYNC_LS_KEY);
  } catch { /* 見上 */ }
};

const hasPersistedCredSyncMark = (): boolean => {
  try { return localStorage.getItem(AMSG2_PENDING_CRED_SYNC_LS_KEY) === '1'; } catch { return false; }
};

/**
 * 按底帳裡記著的 credId，用當前配置重算出這幾行現在該是什麼值。
 * 角色已刪 / 憑據配不齊的那些直接跳過——沒得算，也不該拿一份殘缺的去覆蓋雲端。
 */
export const buildCredentialRowsToResync = async (
  apiConfig: APIConfig,
  characters?: CharacterProfile[],
): Promise<LlmCredentialRow[]> => {
  const wanted = knownCredIds()
    .map(parseCharCredId)
    .filter((parsed): parsed is { charId: string; purpose: 'chat' | 'emotion' } =>
      !!parsed && (parsed.purpose === 'chat' || parsed.purpose === 'emotion'));
  if (wanted.length === 0) return [];

  const all = characters ?? await DB.getAllCharacters();
  const byId = new Map(all.map((char) => [char.id, char]));
  const rows: LlmCredentialRow[] = [];
  for (const { charId, purpose } of wanted) {
    const char = byId.get(charId);
    if (!char) continue;
    const row = purpose === 'chat'
      ? buildCharChatCredRow(char, char.activeMsg2Config, apiConfig)
      : buildCharEmotionCredRow(charId, char.emotionConfig?.api, apiConfig);
    if (row) rows.push(row);
  }
  return rows;
};

const runLlmCredentialSync = async (reason: string): Promise<void> => {
  if (!hasPendingCredSync || credSyncing) return;
  credSyncing = true;
  // 記下這次算的是哪一份：上傳期間用戶又改了配置的話，清帳不能把新的那份一起清掉。
  const snapshot = pendingCredApiConfig;
  try {
    const globalConfig = await ActiveMsgStore.getGlobalConfig();
    // 沒配 worker、或這台 worker 還不認憑據表 = 這幾行沒有去處，不是「傳失敗」，連底帳一起清掉。
    if (!globalConfig.workerUrl?.trim() || !snapshot || !(await isLlmCredentialsReady())) {
      hasPendingCredSync = false;
      pendingCredApiConfig = undefined;
      writeCredSyncMark(false);
      return;
    }
    const rows = await buildCredentialRowsToResync(snapshot);
    // 值一個都沒變（多半是這次保存改的不是 API 那幾項）：不發請求，直接銷帳。
    if (pickChangedCredRows(rows).length > 0) await ActiveMsgClient.putLlmCredentials(rows);
    if (pendingCredApiConfig === snapshot) {
      hasPendingCredSync = false;
      pendingCredApiConfig = undefined;
      writeCredSyncMark(false);
    }
    credRetryCount = 0;
  } catch (error) {
    if (credRetryCount < MAX_RETRIES) {
      const delay = RETRY_BASE_MS * 2 ** credRetryCount;
      credRetryCount += 1;
      console.warn(`${HEADER} llm_credentials(${reason}) 上傳失敗，${Math.round(delay / 1000)}s 後重試（第 ${credRetryCount}/${MAX_RETRIES} 次）`, error);
      if (credRetryTimer != null) clearTimeout(credRetryTimer);
      credRetryTimer = setTimeout(() => { void runLlmCredentialSync('retry'); }, delay);
    } else {
      // 退避打光了（多半是離線）。底帳留著：下次啟動 / 下次沖刷繼續補。
      console.error(`${HEADER} llm_credentials(${reason}) 連續 ${MAX_RETRIES} 次失敗，雲端憑據仍是上一份（已排程的任務到點會用舊 Key）`, error);
      credRetryCount = 0;
    }
  } finally {
    credSyncing = false;
  }
};

/**
 * 聊天 API / 角色單獨 API / 情緒評估 API 改過之後，把雲端那幾行憑據對齊的唯一入口。
 *
 * 立即傳一次，失敗退避重試，並在 localStorage 留底帳等啟動 / 下次沖刷補傳。
 * 老 worker（不支持憑據表）上它是 no-op——那條路的憑據仍凍結在任務裡，靠
 * refreshApiCredentialsForPendingTasks 逐條補刷。
 */
export const syncAmsgLlmCredentials = (apiConfig: APIConfig): void => {
  pendingCredApiConfig = apiConfig;
  hasPendingCredSync = true;
  credRetryCount = 0;
  if (credRetryTimer != null) { clearTimeout(credRetryTimer); credRetryTimer = null; }
  writeCredSyncMark(true);
  void runLlmCredentialSync('change');
};

// ─── 清空 Worker 地址前的收尾 ───

/**
 * 「Worker 地址被清空」的判定。
 *
 * 地址一空，前端這邊的同步全停了，但 D1 裡的任務還在：cron 每分鐘照常消費、照燒 LLM
 * 照推送（推送訂閱也還在），只是內容越來越對不上——用戶以為自己關掉了一切，實際只是
 * 把自己變成了看不見的那一方。所以這一步不能靜悄悄地存下去。
 */
export const isWorkerUrlCleared = (prevUrl: string | undefined, nextUrl: string | undefined): boolean =>
  Boolean(prevUrl?.trim()) && !nextUrl?.trim();

/**
 * 取消遠端**全部**任務（清空 Worker 地址時用，此時還沒換地址，讀寫的都是舊那台）。
 *
 * 「全部」是字面意思，正在跑的即時對話也一起取消，跟角色級的
 * ActiveMsgClient.cancelAllTasksForChar（那邊刻意放過即時對話的行）不是一把尺 ——
 * 兩個調用方（清空 Worker 地址、清空雲端數據）要的都是「我不跟這台 worker 來往了」：
 * 地址一清，回覆推回來這邊也接不住了；雲端數據一清，角色上下文沒了，那一跳到點也只會
 * 硬失敗，留著它只是多一條要等 7 天才自動消失的失敗行。所以這裡不給調用方開過濾的口子。
 *
 * 盡力而為：逐條取消，單條失敗記數繼續跑完其餘的；清單都讀不到（網絡 / 鑑權）就
 * 回 listed:false，交給調用方提示用戶「遠端可能還掛著」。
 */
export const cancelAllRemoteAmsgTasks = async (): Promise<{
  total: number; failed: number; listed: boolean;
}> => {
  let uuids: string[];
  try {
    uuids = (await ActiveMsgClient.listAllTasks())
      .map((task: { uuid?: unknown }) => task?.uuid)
      .filter((uuid): uuid is string => typeof uuid === 'string' && !!uuid);
  } catch (error) {
    console.warn(`${HEADER} 清空地址前讀不到遠端任務清單，無法確認還剩幾條`, error);
    return { total: 0, failed: 0, listed: false };
  }
  let failed = 0;
  for (const uuid of uuids) {
    try { await ActiveMsgClient.cancelTask(uuid); } catch { failed += 1; }
  }
  return { total: uuids.length, failed, listed: true };
};

/** 「清空雲端數據」逐項的結果，界面照著它說清楚哪幾樣清乾淨了、哪幾樣沒有。 */
export interface AmsgCloudWipeResult {
  /** 任務表：讀到清單才有數，listed:false 表示清單壓根讀不出來。 */
  tasks: { total: number; failed: number; listed: boolean };
  /** 角色上下文清掉的條目數；這一步失敗時是 null。 */
  stateDeleted: number | null;
  /** 工具憑據有沒有當場補傳回去（它沒有別的補寫時機）。 */
  toolConfigRestored: boolean;
  /**
   * LLM 憑據表清掉的行數；這一步失敗時是 null。
   * 不當場補回去：這幾行由排程 / 發消息那兩條路按需重建（本地指紋底帳已經一起劃掉了）。
   */
  llmCredentialsDeleted: number | null;
  /** 推送訂閱的去向：重新登記了 / 刪掉了不再登記 / 沒弄成。 */
  push: 'reregistered' | 'deleted' | 'failed';
}

/**
 * 清空這個用戶在 worker D1 裡的全部數據：已排程的任務、同步上去的角色上下文與
 * 工具憑據、登記的 LLM 憑據行、推送訂閱登記。設置頁「清空雲端數據」按鈕走的就是這裡。
 *
 * 四樣各清各的，**一步失敗不短路後面幾步**。這一條是這個函數存在的意義：換過
 * AMSG_MASTER_KEY 之後，舊密文全解不開，而「列任務」恰恰要逐條解密（GET /messages），
 * 於是它必然是最先炸的那一步；偏偏這時候最需要被清掉的是 client_state（不清的話
 * 讀它的接口一直報錯）。串行短路的話用戶會一樣都清不成，正好卡在最需要它的場景裡。
 *
 * 任務清單讀不出來時不用另想辦法：解不開的任務到點會失敗，worker 每輪 cron 都會刪掉
 * 7 天前的失敗任務，它們會自己消失。
 *
 * @param options.pushRegistered 本機當前有沒有推送訂閱。有就覆蓋登記一份新的
 *   （worker 上按 user_id 存單行，PUT 一次就頂掉舊行，不用先刪、也就沒有「刪完沒
 *   登記上」的裸奔窗口）；沒有就只把雲端那行刪掉，不去申請通知權限。
 */
export const wipeAmsgCloudData = async (
  realtimeConfig: RealtimeConfig | undefined,
  options: { pushRegistered: boolean },
): Promise<AmsgCloudWipeResult> => {
  // 先收任務：清空過程中就不會再有任務到點觸發，跑到一半的狀態不至於被現場讀走。
  const tasks = await cancelAllRemoteAmsgTasks();

  let stateDeleted: number | null = null;
  let toolConfigRestored = false;
  try {
    const cleared = await ActiveMsgClient.clearClientState(realtimeConfig);
    stateDeleted = cleared.deleted;
    toolConfigRestored = cleared.toolConfigRestored;
  } catch (error) {
    console.warn(`${HEADER} 清空雲端狀態失敗`, error);
  }

  // 憑據表：和上面幾樣一樣自成一步，前面哪一步炸了都照清。老 worker 上沒有這張表，
  // 那時這一步會失敗——它本來就沒東西可清，報出來即可，不影響別的幾樣。
  let llmCredentialsDeleted: number | null = null;
  try {
    llmCredentialsDeleted = await ActiveMsgClient.deleteLlmCredentials({ all: true });
  } catch (error) {
    console.warn(`${HEADER} 清空雲端 LLM 憑據失敗`, error);
  }

  let push: AmsgCloudWipeResult['push'] = 'failed';
  try {
    if (options.pushRegistered) {
      await ActiveMsgClient.registerPushSubscription();
      push = 'reregistered';
    } else {
      await ActiveMsgClient.deleteRemotePushSubscription();
      push = 'deleted';
    }
  } catch (error) {
    console.warn(`${HEADER} 推送訂閱收尾失敗`, error);
  }

  return { tasks, stateDeleted, toolConfigRestored, llmCredentialsDeleted, push };
};

const writeChatPresence = (charId: string, lastUserMessageAt: number | null) => {
  const presence: AmsgChatPresence = {
    v: 1,
    charId,
    activeAt: Date.now(),
    lastUserMessageAt,
  };
  // 寫入失敗只 warn：心跳故障不能打斷正常聊天，下一次 interval 繼續嘗試；遠端 45s TTL 兜底。
  ActiveMsgClient.syncChatPresence(charId, presence).catch((error) => {
    console.warn(`${HEADER} 活躍會話租約寫入失敗（45s TTL 自然失效）`, error);
  });
};

/** 一輪真實用戶消息進入生成流程時啟動租約：立即寫一次，之後每 15s 續租。 */
export const startAmsgChatPresence = (charId: string, lastUserMessageAt: number | null) => {
  writeChatPresence(charId, lastUserMessageAt);

  const existing = chatPresenceLeases.get(charId);
  if (existing) {
    // 已有 timer：只刷新本輪最新的 lastUserMessageAt，複用同一個心跳。
    existing.lastUserMessageAt = lastUserMessageAt;
    return;
  }

  const timer = setInterval(() => {
    // 切後台不再續租：一個閒置可見標籤頁不該無限續租；回前台下一輪真實消息重建。
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const lease = chatPresenceLeases.get(charId);
    if (!lease) return;
    writeChatPresence(charId, lease.lastUserMessageAt);
  }, CHAT_PRESENCE_HEARTBEAT_MS);
  chatPresenceLeases.set(charId, { timer, lastUserMessageAt });
};

/** 停止本地續租（不發「離線」寫入，遠端靠 45s TTL 自然失效）。 */
export const stopAmsgChatPresence = (charId: string) => {
  const lease = chatPresenceLeases.get(charId);
  if (lease) {
    clearInterval(lease.timer);
    chatPresenceLeases.delete(charId);
  }
};
