/// <reference lib="WebWorker" />

import { installReiSW } from '@rei-standard/amsg-sw';

/**
 * SW_VERSION: 改 SW 實質行為時（push handler / message protocol / 通知策略 / IDB 升級）
 * 手工 bump。前端 BuildBadge 通過 GET_SW_VERSION postMessage 協議讀取並顯示，
 * 也作為 source-bytes-changed 的 cache buster 讓瀏覽器 24h SW 緩存繞過去。
 *
 * 歷史：
 *  - 1.0.0: 初版 ActiveMsg 2.0 push + keep-alive
 *  - 1.1.0: 加 BuildBadge SW 版本協議 + 文案通用化
 *  - 1.2.0: iOS 前台跳過 showNotification
 *  - 1.3.0: 測試推送 metadata.test 強制彈通知
 *  - 1.4.0: Phase 2 Round 1 — ActiveMsg IDB v1→v2 (加 outbound_sessions /
 *           pending_tool_calls / reasoning_buffer 三個 store), 上線後老 SW 不升級
 *           會因為 VersionError 丟推送, 必須 bump 觸發字節比較 + 重裝。
 *  - 1.5.0: Phase 2 Round 2 — push handler 按 messageKind 分軌
 *           (content / reasoning / tool_request / error), 處理 _blob envelope,
 *           tool_request 按 visibility 決定 postMessage 或 showNotification。
 *  - 1.5.1: saveContentToInbox 兼容 directive-only push (body 空但 metadata.directives
 *           非空, e.g. LLM 只輸出 [[ACTION:POKE]] 時), 不再 early-return 漏掉副作用.
 *  - 1.5.2: saveContentToInbox gate 化簡到只看 charId — directive-only / 空 payload
 *           都信任 worker 契約, 不在 SW 二次驗證, 行為更可預測.
 *  - 1.6.0: amsg-instant 升 0.8.0-next.2, ReasoningPush 自動按字節切多 push.
 *           saveReasoningToBuffer 改累積式 (chunks[] 數組, read-modify-write),
 *           按 (messageIndex, chunkIndex) 保留每個分片, 主線程 claimReasoning
 *           取出時排序拼接. savePendingToolCall 之前清空同 sessionId 的 reasoning
 *           buffer — 鏡像主應用 `data = newResponse` 的"只保留最後一輪 reasoning"
 *           行為, 避免 agentic loop 跨輪汙染.
 *  - 1.7.0: content push 在沒有可見 client 時補一條系統通知（當時由應用層實現）。
 *           之前只有 tool_request 彈通知, content (含寫日記的 directive 回覆) 關瀏覽器 /
 *           後台凍結時零通知 — 用戶不知道要回前台, inbox 不 flush, 客戶端副作用 (寫 Notion)
 *           永遠不跑. 與 tool_request 同策略: 有可見 client 交給 in-app UI, 否則系統通知.
 *  - 1.9.0: 升級 amsg-sw 2.1.0-next.2，由插件接管 _multipart 透明重組。
 *           刪除了應用層的 reasoning chunking 邏輯，現收到完整 reasoningContent。
 *           content 通知兜底也交給 amsg-sw，應用層只負責寫 inbox / tool / emotion。
 *           修復了在應用關閉期間收到分片推送丟失的問題（通過 notificationclick 恢復及前台攔截 REI_AMSG_PUSH）。
 *  - 1.9.1: 升級 amsg-sw 2.1.1，沿用插件側 multipart 同 id 串行鎖和標準通知標題 fallback。
 *  - 1.10.0: saveReasoningToBuffer 寫完後 notifyClients('active-msg-reasoning')，讓主線程在
 *           "content 搶先於 reasoning 落庫" 的競態下把思維鏈回填到已存的首條回覆上，
 *           修復 instant 模式弱網/移動端思維鏈(心象)間歇丟失。
 *  - 1.10.1: 合併 1.10.0 思維鏈回填修復與 ReiStandard amsg-sw 2.1.1 升級。
 *  - 1.11.0: 加 process-sse-payload message 協議，SSE 直達 payload 也複用同一套
 *           ActiveMsg inbox / tool / emotion 路由。
 *  - 1.12.0: SSE 直達 payload 經 MessageChannel 回 ack，前台據此確認 SW 是否
 *           收下（含去重命中）。
 *  - 1.13.0: 接入 amsg-sw 通用 REI_AMSG_DELIVER + delivery dedupe。SSE bridge
 *           和 WebPush backup 統一在包層 showNotification 前去重。
 *  - 1.14.0: 升級 amsg-sw dedupe 語義：去重記錄區分業務處理與通知展示，
 *           SSE-first 且前台未展示通知時，WebPush backup 可在隱藏態只補通知。
 *  - 1.15.0: IndexedDB 連接韌性整治（修 Instant Push 確認超時）。
 *           1) openInboxDb 改單例複用 + onversionchange/onclose 失效自愈 —— 之前每條 push
 *              都新開一條 ActiveMsg 連接且從不 close，與主庫 (utils/db.ts) 的連接風暴一起
 *              撐爆 Chromium backing store，導致寫 inbox 失敗、永不 active-msg-received、超時。
 *           2) openInboxDb 的所有事務過 withInboxTx：onclose 清緩存是異步的，強關到回調之間
 *              命中 fast-path 會拿到將死連接、db.transaction() 同步拋 InvalidStateError，事務層
 *              兜一次「清緩存重開重試」(同 amsg-sw 2.3.0 的 withDedupeStore)。
 *           3) openInboxDb 修 blocked-then-unblocked 連接洩漏：onblocked 先 reject 但底層 open
 *              還活著，佔用方關閉後 onsuccess 仍觸發、留下能 block 升級/刪庫的孤兒連接；加
 *              settled 標記讓遲到的 onsuccess 直接 close。
 *           4) 升級 amsg-sw 2.2.0 → 2.3.0：包側 dedupe/queue/multipart 連接補 onclose + 事務級
 *              InvalidStateError 重開兜底；DELIVER ack 新增 businessError，落庫失敗 ok:true 仍帶
 *              錯誤，前台據此把超時文案精確化。
 *  - 1.15.1: 臨時加 instant push trace，定位 iOS PWA 後台導致的 SSE Load failed / backup push
 *            / SW inbox 落庫時序。
 *  - 1.16.0: 加 pushsubscriptionchange 監聽：瀏覽器換掉訂閱時 best-effort 用舊公鑰重訂，
 *            並往 ActiveMsg 庫 kv store 寫「訂閱已變化」標記（主線程據此把新訂閱逐條
 *            寫回已排程的遠端任務，見 utils/activeMsgRuntime.ts）。onupgradeneeded 補建
 *            kv store（SW-first 安裝時主線程 schema 還沒建過）。
 *  - 1.17.0: 升級 amsg-sw，通知的 silent 認 'when-visible' 這一檔：靜不靜音改由 SW 按
 *            收到推送那一刻的窗口可見性算，用戶看著頁面時安靜、切後台照常響鈴震動。
 *            老 SW 把這個字符串當真值，會一律靜音。
 *  - 1.18.0: SW 側 trace 落到獨立的 ActiveMsgSwTrace 庫（原來只寫 console.log，遠端用戶
 *            手上等於沒有），並把 notifyClients 記細：找到幾個頁面、各自可見性、
 *            postMessage 成沒成。排「推送到了、通知也彈了、界面半天不動」這類故障時，
 *            SW 到底有沒有喊到頁面是第一個要回答的問題。
 *  - 1.19.0: push handler 只分 content / emotion_update / error / result 四軌；
 *            _blob 信封、reasoning、tool_request 三條路線移除。
 */
const SW_VERSION = '1.19.0';

const PING_INTERVAL = 15_000;
const MAX_MANUAL_ALIVE_MS = 5 * 60_000;
const ACTIVE_MSG_DB_NAME = 'ActiveMsg';
// MUST be kept in sync with utils/activeMsgStore.ts:DB_VERSION. If SW pins a lower version while
// main thread is on v2, SW's open() will throw VersionError and push messages will be silently dropped.
const ACTIVE_MSG_DB_VERSION = 2;
const ACTIVE_MSG_INBOX_STORE = 'inbox';
// 下面三張表現在沒人讀寫（主線程啟動時清空過一次舊數據）。建表邏輯留著是為了不動庫版本：
// 刪表就得升 DB_VERSION，頁面和 SW 必須同步升級，否則老的一方打開庫直接 VersionError。
const ACTIVE_MSG_OUTBOUND_SESSIONS_STORE = 'outbound_sessions';
const ACTIVE_MSG_PENDING_TOOL_CALLS_STORE = 'pending_tool_calls';
const ACTIVE_MSG_REASONING_BUFFER_STORE = 'reasoning_buffer';
// 主線程 activeMsgStore.ts 的 kv store（記錄形狀 { id, value }）。SW 只往裡寫一條
// 固定 key 的「訂閱已變化」標記，key 必須與 utils/activeMsgRuntime.ts 的
// PUSH_SUBSCRIPTION_CHANGED_KV_ID 保持一致。
const ACTIVE_MSG_KV_STORE = 'kv';
const PUSH_SUBSCRIPTION_CHANGED_KV_ID = 'push_subscription_changed_v1';

let pingTimer: number | null = null;
let manualKeepAliveCount = 0;
let manualKeepAliveStartedAt = 0;

const proactiveSchedules = new Map<string, { charId: string; intervalMs: number }>();
const proactiveTimers = new Map<string, number>();

const sw = self as unknown as ServiceWorkerGlobalScope;

function summarizeAmsgPayload(payload: any): Record<string, any> {
  return {
    messageKind: payload?.messageKind ?? 'content',
    messageType: payload?.messageType,
    messageId: payload?.messageId,
    sessionId: payload?.sessionId,
    charId: payload?.metadata?.charId,
    chunk: payload?.messageIndex,
    total: payload?.totalMessages,
  };
}

// ─── SW 側 trace 的持久化 ───
//
// traceSw 原本只寫 console.log。SW 的 console 在遠端用戶那兒等於不存在（手機上沒有
// DevTools，裝成 PWA 更沒有），於是「SW 到底有沒有收到推送、有沒有喊到頁面」這一整段
// 全是盲區——排障時只能看到頁面側的記錄，而頁面側的第一條記錄已經是「開始處理」了。
//
// 存在**獨立的小庫**裡，不往 ActiveMsg 庫塞：那個庫一升版本就要走 onupgradeneeded，
// 主線程正開著舊版本連接的話會 blocked（openInboxDb 裡就為此寫了 onblocked 分支），
// 排障用的日誌不值得給收件箱這條關鍵路徑帶上這種風險。
const SW_TRACE_DB_NAME = 'ActiveMsgSwTrace';
const SW_TRACE_DB_VERSION = 1;
const SW_TRACE_STORE = 'entries';
/** 留多少條。一輪多段回覆能打十幾條，留夠翻幾輪的量。 */
const SW_TRACE_LIMIT = 300;

let swTraceDbPromise: Promise<IDBDatabase> | null = null;

function openSwTraceDb(): Promise<IDBDatabase> {
  if (swTraceDbPromise) return swTraceDbPromise;

  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(SW_TRACE_DB_NAME, SW_TRACE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SW_TRACE_STORE)) {
        db.createObjectStore(SW_TRACE_STORE, { keyPath: 'seq', autoIncrement: true });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // 跟另外兩個庫同款的失效自愈：被強關 / 別處升版本時清緩存，下次重開。
      db.onversionchange = () => {
        db.close();
        if (swTraceDbPromise === promise) swTraceDbPromise = null;
      };
      db.onclose = () => {
        if (swTraceDbPromise === promise) swTraceDbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      if (swTraceDbPromise === promise) swTraceDbPromise = null;
      reject(request.error);
    };
    request.onblocked = () => {
      if (swTraceDbPromise === promise) swTraceDbPromise = null;
      reject(new Error('sw trace db blocked'));
    };
  });

  swTraceDbPromise = promise;
  return promise;
}

/** 追加一條並把超出上限的最老記錄刪掉。整個函數的失敗都被調用方吞掉。 */
async function appendSwTrace(entry: Record<string, any>): Promise<void> {
  const db = await openSwTraceDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(SW_TRACE_STORE, 'readwrite');
    const store = tx.objectStore(SW_TRACE_STORE);
    store.add(entry);
    // 同一個事務裡 count 能看到剛 add 的那條，多出來的從最老的一頭刪。
    const countRequest = store.count();
    countRequest.onsuccess = () => {
      const excess = countRequest.result - SW_TRACE_LIMIT;
      if (excess <= 0) return;
      let removed = 0;
      const cursorRequest = store.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor || removed >= excess) return;
        cursor.delete();
        removed += 1;
        cursor.continue();
      };
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function traceSw(event: string, payload?: any, extra: Record<string, any> = {}) {
  const entry = {
    ts: new Date().toISOString(),
    event,
    swVersion: SW_VERSION,
    ...(payload !== undefined ? summarizeAmsgPayload(payload) : {}),
    ...extra,
  };
  try {
    console.log('[InstantTrace:SW]', entry);
  } catch { /* ignore */ }
  // 不 await：trace 是旁路，寫庫慢了 / 掛了都不能拖住推送處理本身。
  void appendSwTrace(entry).catch(() => { /* trace 寫不進去就算了 */ });
}

installReiSW(sw, {
  defaultIcon: './icons/icon-192.png',
  defaultBadge: './icons/icon-192.png',
  multipart: { enabled: true },
  onBusinessPayload: async (payload: any) => {
    traceSw('business-payload-start', payload);
    try {
      await saveIncomingActiveMessage(payload);
      traceSw('business-payload-done', payload);
    } catch (e) {
      traceSw('business-payload-error', payload, {
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  },
});

function hasActiveProactiveSchedules() {
  return proactiveTimers.size > 0;
}

function shouldKeepAlive() {
  return manualKeepAliveCount > 0 || hasActiveProactiveSchedules();
}

function stopPingLoop() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function ensurePingLoop() {
  if (pingTimer) return;

  pingTimer = setInterval(() => {
    if (manualKeepAliveCount > 0 && Date.now() - manualKeepAliveStartedAt > MAX_MANUAL_ALIVE_MS) {
      manualKeepAliveCount = 0;
      manualKeepAliveStartedAt = 0;
    }

    if (!shouldKeepAlive()) {
      stopPingLoop();
      return;
    }

    sw.registration.active?.postMessage({ type: 'ping' });
  }, PING_INTERVAL) as unknown as number;
}

function refreshKeepAlive() {
  if (shouldKeepAlive()) ensurePingLoop();
  else stopPingLoop();
}

function startKeepAlive() {
  manualKeepAliveCount += 1;
  if (!manualKeepAliveStartedAt) manualKeepAliveStartedAt = Date.now();
  refreshKeepAlive();
}

function stopKeepAlive() {
  if (manualKeepAliveCount > 0) manualKeepAliveCount -= 1;
  if (manualKeepAliveCount === 0) manualKeepAliveStartedAt = 0;
  refreshKeepAlive();
}

/**
 * 頁面地址裡只留路徑，不帶查詢串和 hash——排障要認的是「這是哪個頁面」，
 * 而查詢串/hash 上可能掛著不該進日誌的東西。
 */
function tracePathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '?';
  }
}

/**
 * 把消息喊給所有打開著的頁面。
 *
 * 這裡的 trace 記得比別處細，因為「推送到了、通知也彈了，頁面卻毫無反應」這類故障
 * 全卡在這一步，而它三種壞法長得一模一樣（都是頁面那邊什麼都沒發生）：
 *   1. matchAll 壓根沒找到頁面 → count 為 0
 *   2. 找到了但 postMessage 拋錯 → posted 少於 count，failures 裡有原因
 *   3. 都成了，是頁面自己沒處理 → 這裡全綠，頁面側卻沒有對應的收到記錄
 * 不把這三樣分開記，就只能靠猜。
 */
async function notifyClients(data: Record<string, any>) {
  let clients: readonly Client[] = [];
  let matchError: string | undefined;
  try {
    clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
  } catch (e) {
    matchError = e instanceof Error ? e.name : String(e);
  }

  let posted = 0;
  const failures: string[] = [];
  for (const client of clients) {
    try {
      client.postMessage(data);
      posted += 1;
    } catch (e) {
      failures.push(e instanceof Error ? e.name : String(e));
    }
  }

  traceSw('notify-clients', undefined, {
    type: data.type,
    charId: data.charId,
    sessionId: data.sessionId,
    count: clients.length,
    posted,
    targets: clients.map((client) => ({
      path: tracePathOf(client.url),
      visibility: (client as WindowClient).visibilityState,
      focused: (client as WindowClient).focused,
      // 凍結的頁面收得下 postMessage，但要等解凍才會處理——只有部分瀏覽器報這個字段。
      frozen: (client as any).frozen,
    })),
    ...(failures.length > 0 ? { failures } : {}),
    ...(matchError ? { matchError } : {}),
  });
}

function fireProactiveTrigger(charId: string) {
  void notifyClients({ type: 'proactive-trigger', charId });
}

function stopProactive(charId: string) {
  const timer = proactiveTimers.get(charId);
  if (timer) {
    clearInterval(timer);
    proactiveTimers.delete(charId);
  }
  proactiveSchedules.delete(charId);
}

function upsertProactive(config: { charId: string; intervalMs: number }) {
  const prev = proactiveSchedules.get(config.charId);
  const unchanged = prev && prev.intervalMs === config.intervalMs;
  if (unchanged && proactiveTimers.has(config.charId)) return;

  stopProactive(config.charId);
  proactiveSchedules.set(config.charId, config);

  const timer = setInterval(() => fireProactiveTrigger(config.charId), config.intervalMs) as unknown as number;
  proactiveTimers.set(config.charId, timer);
}

function syncProactive(configs: Array<{ charId: string; intervalMs: number }>) {
  const nextIds = new Set((configs || []).map((config) => config.charId));

  for (const charId of Array.from(proactiveSchedules.keys())) {
    if (!nextIds.has(charId)) stopProactive(charId);
  }

  for (const config of configs || []) {
    if (config && config.charId && config.intervalMs > 0) {
      upsertProactive(config);
    }
  }

  refreshKeepAlive();
}

function readPushPayload(event: PushEvent): any | null {
  if (!event.data) return null;

  try {
    return event.data.json();
  } catch {
    try {
      return { message: event.data?.text() };
    } catch {
      return null;
    }
  }
}

// 單例連接緩存。每條 push 都新開一條 ActiveMsg 連接且從不 close 的話, 會跟主庫
// (utils/db.ts) 的連接一起撐爆 Chromium backing store, 這裡 open 失敗 →
// saveContentToInbox 拋錯 → 永不 notifyClients('active-msg-received') → 頁面遲遲等不到
// 落庫。複用同一條連接, 失效 (版本升級 / 瀏覽器強制關閉) 時清緩存自愈, 下條 push 自動重開。
let inboxDbPromise: Promise<IDBDatabase> | null = null;

function openInboxDb(): Promise<IDBDatabase> {
  if (inboxDbPromise) return inboxDbPromise;

  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(ACTIVE_MSG_DB_NAME, ACTIVE_MSG_DB_VERSION);
    // onblocked 不是終態: 先 reject, 但底層 open request 還活著, 佔用方關閉後仍會觸發
    // onsuccess。用 settled 標記 promise 已 settle, 讓遲到的連接被 close 而非洩漏成
    // 一條沒人持有、卻能 block 後續升級 / 刪庫的孤兒連接。
    // 清緩存一律先比對 inboxDbPromise === promise: onclose/onerror 都是異步回調 —— 尤其
    // withInboxTx 強關後會清緩存並重開新 promise, 此時陳舊連接的遲到 onclose 不能把新單例
    // 誤清 (否則又憑空多開一條連接, 正是本次要消滅的 churn; 見 amsg-sw 2.3.0 同款守衛)。
    let settled = false;

    request.onerror = () => {
      if (inboxDbPromise === promise) inboxDbPromise = null; // 打開失敗別緩存 rejected promise
      settled = true;
      reject(request.error);
    };
    request.onblocked = () => {
      // Main thread or another SW connection holds the DB at a lower version and isn't closing.
      // Push will fail to persist; reject rather than hang forever so event.waitUntil unblocks.
      if (inboxDbPromise === promise) inboxDbPromise = null;
      settled = true;
      reject(new Error('IndexedDB open blocked (older version still open elsewhere)'));
    };
    request.onsuccess = () => {
      const db = request.result;
      // 已經 reject 過 (onblocked / onerror): 遲到的連接沒人接收, 直接 close, 否則它開著
      // 會 block 後續升級 / deleteDatabase。
      if (settled) {
        try { db.close(); } catch { /* ignore */ }
        return;
      }
      // 主線程升級版本時 close 讓位 + 清緩存; 瀏覽器強制關閉連接時也清緩存自愈。
      db.onversionchange = () => {
        db.close();
        if (inboxDbPromise === promise) inboxDbPromise = null;
      };
      db.onclose = () => {
        if (inboxDbPromise === promise) inboxDbPromise = null;
      };
      resolve(db);
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ACTIVE_MSG_INBOX_STORE)) {
        db.createObjectStore(ACTIVE_MSG_INBOX_STORE, { keyPath: 'messageId' });
      }
      // 這三張表沒人讀寫，只為讓 SW-first 安裝建出來的庫跟主線程 v2 schema 一致（見常量處註釋）。
      if (!db.objectStoreNames.contains(ACTIVE_MSG_OUTBOUND_SESSIONS_STORE)) {
        db.createObjectStore(ACTIVE_MSG_OUTBOUND_SESSIONS_STORE, { keyPath: 'sessionId' });
      }
      if (!db.objectStoreNames.contains(ACTIVE_MSG_PENDING_TOOL_CALLS_STORE)) {
        db.createObjectStore(ACTIVE_MSG_PENDING_TOOL_CALLS_STORE, { keyPath: 'sessionId' });
      }
      if (!db.objectStoreNames.contains(ACTIVE_MSG_REASONING_BUFFER_STORE)) {
        db.createObjectStore(ACTIVE_MSG_REASONING_BUFFER_STORE, { keyPath: 'sessionId' });
      }
      // kv 平時由主線程 activeMsgStore.ts 建；SW-first 安裝（主線程還沒開過庫就先
      // 收到 push / pushsubscriptionchange）時這裡補建，否則訂閱變化標記沒地方寫，
      // 主線程後續 transaction('kv') 也會 NotFoundError。
      if (!db.objectStoreNames.contains(ACTIVE_MSG_KV_STORE)) {
        db.createObjectStore(ACTIVE_MSG_KV_STORE, { keyPath: 'id' });
      }
    };
  });

  inboxDbPromise = promise;
  return promise;
}

function isInboxConnectionClosingError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: string; message?: string };
  return e.name === 'InvalidStateError' || /connection is closing/i.test(String(e.message || ''));
}

// 事務級一次重開兜底。單例的 onclose 清緩存是異步的: 連接被瀏覽器強關到 onclose 回調
// 跑之間, 命中 fast-path 的調用方會拿到一條將死的連接, db.transaction() 同步拋
// InvalidStateError —— 此時 saveContentToInbox 會在寫 inbox / fire active-msg-received 前
// 就掛掉, push 靜默丟、主線程超時。這裡捕獲該錯誤後清緩存、重開一次、重試一次
// (鏡像 amsg-sw 2.3.0 的 withDedupeStore), 守住這條關鍵路徑。重試上限 1 次; 失敗的
// 事務不會 commit, 故 run() 重跑是冪等的 (含 read-modify-write)。
async function withInboxTx(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => void,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const db = await openInboxDb();
    try {
      return await new Promise<void>((resolve, reject) => {
        let tx: IDBTransaction;
        try {
          tx = db.transaction(storeName, mode);
        } catch (e) {
          reject(e); // 連接 closing 時 db.transaction() 同步拋, 交給下面的重試判定
          return;
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error(`inbox tx error (${storeName})`));
        tx.onabort = () => reject(tx.error || new Error(`inbox tx aborted (${storeName})`));
        run(tx.objectStore(storeName));
      });
    } catch (e) {
      if (attempt === 0 && isInboxConnectionClosingError(e)) {
        inboxDbPromise = null; // 丟掉將死的緩存連接, 下一輪 openInboxDb 重開
        continue;
      }
      throw e;
    }
  }
}

// ─── content / inbox (kind=content) ───────────────────────────────────────────

async function saveContentToInbox(payload: any) {
  const charId = payload?.metadata?.charId;
  const charName = payload?.contactName || payload?.metadata?.charName || '主動消息';
  const body = String(payload?.message || payload?.body || '').trim();
  const notificationBody = typeof payload?.notification?.body === 'string'
    ? payload.notification.body.trim()
    : '';
  const previewBody = notificationBody || body;
  const messageId = String(payload?.messageId || `${charId || 'unknown'}-${Date.now()}`);
  const payloadTimestamp = payload?.timestamp;
  const parsedSentAt = payloadTimestamp ? new Date(payloadTimestamp).getTime() : NaN;
  const sentAt = Number.isFinite(parsedSentAt) ? parsedSentAt : Date.now();

  // 唯一不可恢復的是沒 charId — 沒法路由, 直接丟. 其它形態都接受:
  //   - body 非空 + directives 空 = 普通 content push (老路徑)
  //   - body 非空 + directives 非空 = content + 副作用混合 push
  //   - body 空 + directives 非空 = directive-only push (LLM 只輸 [[ACTION:POKE]] 等)
  //   - body 空 + directives 空 = worker bug 推白條 → 寫一條空 entry, flushInbox 跑空管線無害,
  //     最多讓 OSContext 彈一句默認 toast. 這種 case 應該在 worker 端修, SW 不二次驗證契約.
  if (!charId) {
    traceSw('content-drop-no-char', payload);
    return;
  }

  await withInboxTx(ACTIVE_MSG_INBOX_STORE, 'readwrite', (store) => {
    store.put({
      messageId,
      charId,
      charName,
      body,
      previewBody,
      avatarUrl: payload?.avatarUrl,
      source: payload?.source,
      messageType: payload?.messageType,
      messageSubtype: payload?.messageSubtype,
      // 任務身份由庫蓋在 push 頂層 (taskId / taskUuid / recurrenceType / occurrenceMs),
      // 客戶端端的防穿幫閘與任務認領都讀這幾個——兩條排程路徑 (用戶排 / 角色自排) 走的
      // 是同一份, 不會像各自往 metadata 抄那樣抄漏一個就判錯。
      taskId: payload?.taskId ?? null,
      taskUuid: payload?.taskUuid ?? null,
      recurrenceType: payload?.recurrenceType ?? null,
      occurrenceMs: payload?.occurrenceMs ?? null,
      // sessionId / messageIndex 放到 metadata 裡, 主線程 flushInboxToChat 據此標記是第幾條
      // (第 1 條才掛 metadata.thinkingChain).
      metadata: {
        ...(payload?.metadata || {}),
        sessionId: payload?.sessionId,
        messageIndex: payload?.messageIndex,
        totalMessages: payload?.totalMessages,
      },
      sentAt,
      receivedAt: Date.now(),
    });
  });
  traceSw('inbox-content-saved', payload, { bodyChars: body.length });

  await notifyClients({
    type: 'active-msg-received',
    charId,
    charName,
    body: previewBody,
    avatarUrl: payload?.avatarUrl,
    sentAt,
  });
}

// emotion_update push: worker 跑完副 API 情緒評估後推回的 buff 結果. 靜默寫進 inbox (不彈通知、
// 不計未讀), 客戶端 flushInboxToChat 看到 messageType==='emotion_update' 時調 applyEmotionEvalRaw
// 落 buff + 廣播 innerState, 不渲染成聊天消息. notifyClients 僅用來觸發一次 flush (前台時立即落 buff;
// 後台時 postMessage 排隊/丟棄, 回前台 visibilitychange flush 兜底).
async function saveEmotionUpdateToInbox(payload: any) {
  const charId = payload?.metadata?.charId;
  // emotionRaw 允許為空: worker 評估失敗/返回空時也會推一條 "done" 信號 (emotionRaw=''),
  // 仍需寫 inbox + notify, 讓客戶端 flush 時 fire 'instant-emotion-done' 熄滅 "情緒分析中" 徽章.
  const emotionRaw = payload?.metadata?.emotionRaw || '';
  if (!charId) {
    traceSw('emotion-drop-no-char', payload);
    return;
  }
  const messageId = String(payload?.messageId || `${charId}-emotion-${Date.now()}`);

  await withInboxTx(ACTIVE_MSG_INBOX_STORE, 'readwrite', (store) => {
    store.put({
      messageId,
      charId,
      charName: payload?.contactName || '',
      body: '',
      messageType: 'emotion_update',
      metadata: { charId, emotionRaw },
      sentAt: Date.now(),
      receivedAt: Date.now(),
    });
  });
  traceSw('inbox-emotion-saved', payload, { emotionChars: String(emotionRaw).length });

  // 觸發客戶端 flush (不帶真實內容, 客戶端 flush 時按 messageType 靜默處理). 不 showNotification.
  await notifyClients({ type: 'active-msg-received', charId, charName: payload?.contactName || '', body: '', emotionUpdate: true });
}

// ─── 路由總入口 ──────────────────────────────────────────────────────────────

async function saveIncomingActiveMessage(payload: any) {
  // 按 messageKind 分軌; 沒帶 messageKind 字段的當 content 處理.
  const messageKind: string = payload?.messageKind ?? 'content';
  traceSw('route-payload', payload, { route: messageKind });

  switch (messageKind) {
    case 'content':
      await saveContentToInbox(payload);
      return;

    case 'emotion_update':
      await saveEmotionUpdateToInbox(payload);
      return;

    case 'error':
      // 失敗告知 push: 不寫 inbox（不是聊天內容）。通知橫幅由包層按 notification.show
      // 決定（即時對話的終態失敗帶 show:'always' + 摺疊 + 靜音，前後台都彈）。這裡把
      // metadata 整份帶給頁面: 即時對話靠裡面的 taskUuid/reason 當場收尾那一輪
      // （落系統消息、熄燈），見 activeMsgRuntime 的 active-msg-error 分支。
      console.error('[amsg] error push', payload?.code, payload?.message, payload?.metadata?.reason);
      await notifyClients({
        type: 'active-msg-error',
        code: payload?.code,
        message: payload?.message,
        charId: payload?.metadata?.charId,
        metadata: payload?.metadata,
      });
      return;

    case 'result':
      // 宿主自定義結果（worker 的 ctx.emitResult），不是聊天內容: 不寫 inbox, 原樣
      // 轉給頁面按 resultKind 分流。落進 content 分支的話, 結果裡那些不是正文的字段
      // 會被當角色說的一句話渲染成氣泡。
      await notifyClients({ type: 'active-msg-result', payload });
      return;

    default:
      console.warn('[amsg] unknown messageKind, falling back to content', messageKind);
      await saveContentToInbox(payload);
  }
}

// 之前我們自己寫 sw.addEventListener('push')，現在全量交由 amsg-sw 的 installReiSW
// 在 onBusinessPayload 裡回調，所以這裡不再需要手寫 push 監聽。

// ─── pushsubscriptionchange：瀏覽器換掉了推送訂閱 ────────────────────────────
// 已排程任務體裡的 pushSubscription 是排程那一刻凍結的，訂閱一換端點，到點推送
// 全打到作廢端點上（靜默失聯）。這裡做兩件事，都是 best-effort：
//   1. 用舊訂閱的 applicationServerKey 立刻重訂，儘量別讓訂閱斷檔；
//   2. 無論重訂成敗都往 kv store 寫一條固定 key 的「訂閱已變化」標記——就算重訂
//      成功，新訂閱的端點也和任務體裡凍結的不一樣，遠端任務必須逐條刷新才能繼續
//      送達。主線程 ActiveMsgRuntime 啟動 / 收到下面的通知時消費標記（見
//      utils/activeMsgRuntime.ts 的 refreshPushSubscriptionIfMarked），全部寫回
//      成功才清。
// TS lib 的 ServiceWorkerGlobalScopeEventMap 還沒收這個事件名，監聽器手動收斂類型。
sw.addEventListener('pushsubscriptionchange', (event: Event) => {
  const e = event as Event & {
    waitUntil: (promise: Promise<unknown>) => void;
    oldSubscription?: PushSubscription | null;
  };
  traceSw('push-subscription-change', undefined, {
    hadOldSubscription: Boolean(e.oldSubscription),
  });

  e.waitUntil((async () => {
    let resubscribed = false;
    try {
      const applicationServerKey = e.oldSubscription?.options?.applicationServerKey;
      if (applicationServerKey) {
        await sw.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
        resubscribed = true;
      }
    } catch (err) {
      console.warn('[amsg] pushsubscriptionchange 重訂失敗（主線程稍後會走完整訂閱流程）', err);
    }

    try {
      await withInboxTx(ACTIVE_MSG_KV_STORE, 'readwrite', (store) => {
        store.put({
          id: PUSH_SUBSCRIPTION_CHANGED_KV_ID,
          value: { changedAt: Date.now(), resubscribed },
        });
      });
    } catch (err) {
      // 標記寫不進去只能靠日誌留痕：下一次訂閱相關操作（重開面板 / 重新排程）會
      // 走 ensurePushSubscription 的自檢把訂閱本身修好，但遠端舊任務要等用戶重存。
      console.warn('[amsg] 寫訂閱變化標記失敗', err);
    }

    // 頁面開著的話立刻處理，不用等下次啟動。
    await notifyClients({ type: 'active-msg-subscription-change', resubscribed });
  })());
});

sw.addEventListener('notificationclick', (event: NotificationEvent) => {
  const payload = event.notification.data?.payload || event.notification.data || {};
  const charId = payload?.metadata?.charId || payload?.charId || '';
  event.notification.close();

  event.waitUntil((async () => {
    const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (clients.length > 0) {
      const client = clients[0];
      await client.focus();
      client.postMessage({ type: 'active-msg-open', charId });
      return;
    }

    const openUrl = new URL(sw.registration.scope || sw.location.origin);
    openUrl.searchParams.set('openApp', 'chat');
    if (charId) openUrl.searchParams.set('activeMsgCharId', charId);
    await sw.clients.openWindow(openUrl.toString());
  })());
});

sw.addEventListener('message', (event: ExtendableMessageEvent) => {
  const { type } = event.data || {};

  switch (type) {
    case 'GET_SW_VERSION':
      // BuildBadge 通過 MessageChannel + port 協議查詢；不響應時 BuildBadge 顯示 sw@?
      event.ports[0]?.postMessage({ version: SW_VERSION });
      break;
    case 'SW_CHANNEL_PROBE': {
      // 頁面主動探一次「SW 還能不能喊到我」。兩條路各回一次，為的是把故障分開：
      //   - port 這條是「誰問誰答」，頁面把回信地址一起遞過來（BuildBadge 查版本走它）；
      //   - clients 這條要 SW 自己去把頁面找出來，**推送通知頁面走的正是它**。
      // 只有後者不通，說明 SW 活得好好的、只是找不到頁面——這兩種壞法在用戶那兒
      // 長得一模一樣（界面就是不動），不分開測就只能靠猜。
      const nonce = event.data?.nonce;
      traceSw('channel-probe-received', undefined, { nonce });
      event.ports[0]?.postMessage({ type: 'sw-channel-probe-port-ack', nonce, swVersion: SW_VERSION });
      // 故意複用 notifyClients：探測必須跟真實推送走同一條路才作數，
      // 順帶還留下一條 notify-clients 記錄（找到幾個頁面、各自什麼狀態）。
      event.waitUntil(notifyClients({ type: 'sw-channel-probe-ack', nonce, swVersion: SW_VERSION }));
      break;
    }
    case 'keepalive-start':
      startKeepAlive();
      break;
    case 'keepalive-stop':
      stopKeepAlive();
      break;
    case 'proactive-start':
      if (event.data.config) {
        syncProactive([...proactiveSchedules.values(), event.data.config]);
      }
      break;
    case 'proactive-stop':
      if (event.data.charId) {
        stopProactive(event.data.charId);
        refreshKeepAlive();
      } else {
        syncProactive([]);
      }
      break;
    case 'proactive-sync':
      syncProactive(event.data.configs || []);
      break;
  }
});

sw.addEventListener('install', () => {
  void sw.skipWaiting();
});

sw.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(sw.clients.claim());
});
