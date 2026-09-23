/**
 * 主動消息鏈路的 trace ring buffer（localStorage）。
 *
 * 「無條件抓」的那一層通道日誌：不受 devDebug 勾選影響，開發者隨時能翻最近發生了什麼
 * （另外兩寫——console.info 和 appendDevDebugLog——各自留在調用方，語義不同）。
 *
 * 鍵名、容量、條目形狀只在這裡定義一次。寫在 activeMsgRuntime / useChatAI、
 * 讀在調試面板，幾處各抄一份的話，鍵一改（比如升 v2）讀側會靜默顯示空列表——
 * 調試面板騙人比沒有更糟。
 */

import { APP_VERSION, BUILD_LABEL } from './buildInfo';

const TRACE_LOG_KEY = 'instant_push_trace_log_v1';
/**
 * 留多少條。
 *
 * 一輪多段回覆本身就能打三四十條，再加上 SW 每喊一次頁面也記一條，200 條只夠翻回
 * 三四輪——而排障要的往往是「上午那次」。實測每條約 280 字節，400 條也就一百來 KB，
 * localStorage 裝得下，導出的文件也還是能直接發給人的大小。
 */
const TRACE_LOG_LIMIT = 400;

export interface InstantTraceEntry {
  ts?: string;
  event?: string;
  sessionId?: string;
  [key: string]: unknown;
}

/** 追加一條，超出容量丟最老的。讀寫失敗一律靜默：trace 不能反過來打斷正常鏈路。 */
export const appendInstantTraceEntry = (entry: InstantTraceEntry): void => {
  try {
    const raw = localStorage.getItem(TRACE_LOG_KEY);
    const list = raw ? JSON.parse(raw) : [];
    const next = Array.isArray(list) ? [...list, entry].slice(-TRACE_LOG_LIMIT) : [entry];
    localStorage.setItem(TRACE_LOG_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
};

/** 最近 limit 條，最新的排在最前（調試面板按這個順序顯示）。 */
export const readRecentInstantTraces = (limit: number): InstantTraceEntry[] => {
  try {
    const raw = localStorage.getItem(TRACE_LOG_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.slice(-limit).reverse() : [];
  } catch {
    return [];
  }
};

/**
 * 緩衝裡的**全部**條目（最新在最前），給「導出 trace」用。
 *
 * 面板上只顯示得下最近幾條，而排障要的恰恰是「一小時前那會兒發生了什麼」——這兩百條
 * 一直存著，缺的只是把它們拿出來的口子。遠端用戶手上沒有 DevTools（iOS 裝成 PWA 更是
 * 一點轍都沒有），這是唯一能把現場交出來的途徑。
 */
export const readAllInstantTraces = (): InstantTraceEntry[] =>
  readRecentInstantTraces(TRACE_LOG_LIMIT);

/**
 * 導出成一段能直接貼給開發者的文本。一條都沒有時返回空串，調用方據此不做動作。
 *
 * 帶上構建版本：同一段 trace 在新舊兩個構建上的含義可能完全不同（事件名會加、會改），
 * 不知道是哪個構建打的就只能靠猜，而這份東西存在的意義就是不用猜。
 */
export const formatInstantTraceLog = (): string => {
  const entries = readAllInstantTraces();
  if (entries.length === 0) return '';
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    build: BUILD_LABEL,
    count: entries.length,
    entries,
  }, null, 2);
};

// ─── Service Worker 那一側的日誌 ───
//
// SW 裡 console.log 出來的東西，在遠端用戶手上等於不存在（手機沒有 DevTools，裝成
// PWA 更沒有），於是「推送到沒到 SW、SW 有沒有喊到頁面」整段都看不見——而頁面這邊
// 的第一條記錄已經是「開始處理」了，中間那截空白恰恰是最要命的地方。
// SW 把它寫進一個獨立的小庫（見 worker/sw-keep-alive.ts），這裡把它讀出來一起導出。
const SW_TRACE_DB_NAME = 'ActiveMsgSwTrace';
const SW_TRACE_STORE = 'entries';

/**
 * 讀 SW 寫下的日誌。**不帶版本號打開**：庫歸 SW 建，頁面這邊只是來讀，
 * 帶版本號會在庫還沒被建過時觸發一次建庫、甚至跟 SW 搶升級。
 * 讀不到就返回空數組——SW 還沒裝新版、或者瀏覽器不給開，都不該讓導出整個失敗。
 */
export const readSwTraces = async (): Promise<InstantTraceEntry[]> => {
  if (typeof indexedDB === 'undefined') return [];
  try {
    const db = await new Promise<IDBDatabase | null>((resolve) => {
      const request = indexedDB.open(SW_TRACE_DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
    if (!db) return [];
    try {
      if (!db.objectStoreNames.contains(SW_TRACE_STORE)) return [];
      const rows = await new Promise<InstantTraceEntry[]>((resolve) => {
        const tx = db.transaction(SW_TRACE_STORE, 'readonly');
        const request = tx.objectStore(SW_TRACE_STORE).getAll();
        request.onsuccess = () => resolve((request.result || []) as InstantTraceEntry[]);
        request.onerror = () => resolve([]);
        tx.onabort = () => resolve([]);
      });
      return rows;
    } finally {
      // 頁面只是來讀一趟，讀完就還回去：連接開著會擋住 SW 後續的版本升級。
      try { db.close(); } catch { /* ignore */ }
    }
  } catch {
    return [];
  }
};

/** 導出文件裡那段「這台設備當時是什麼狀況」。都是環境信息，不含任何聊天內容。 */
const captureEnvSnapshot = (): Record<string, unknown> => {
  const snapshot: Record<string, unknown> = {};
  try {
    snapshot.userAgent = navigator.userAgent;
    snapshot.language = navigator.language;
    // 裝成 PWA 獨立窗口跑的，行為跟瀏覽器標籤頁不一樣（尤其 iOS）。
    snapshot.standalone = window.matchMedia?.('(display-mode: standalone)').matches
      || (navigator as any)?.standalone === true;
    snapshot.swSupported = 'serviceWorker' in navigator;
    snapshot.swControlled = 'serviceWorker' in navigator && !!navigator.serviceWorker.controller;
    snapshot.visibility = typeof document !== 'undefined' ? document.visibilityState : undefined;
    snapshot.online = navigator.onLine;
    // 導出這一刻設備的鐘。跟條目裡的時間戳對照能看出設備時鐘有沒有跑偏。
    snapshot.now = new Date().toISOString();
    snapshot.timezoneOffsetMin = new Date().getTimezoneOffset();
  } catch { /* 拿不到的就不記 */ }
  return snapshot;
};

/**
 * 導出「頁面 + SW 兩側合在一起」的完整現場。
 *
 * 兩側的記錄都帶 ISO 時間戳，合併後按時間排一次，讀的人就能直接看出
 * 「推送幾點到的 SW、SW 幾點喊的頁面、頁面幾點才動手」——這三個時刻之間的空檔，
 * 正是排這類故障唯一要看的東西。
 */
export const formatFullTraceLog = async (): Promise<string> => {
  const pageEntries = readAllInstantTraces();
  const swEntries = await readSwTraces();
  if (pageEntries.length === 0 && swEntries.length === 0) return '';

  const merged = [
    ...pageEntries.map((entry) => ({ side: 'page', ...entry })),
    ...swEntries.map((entry) => ({ side: 'sw', ...entry })),
  ].sort((a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? '')));

  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    build: BUILD_LABEL,
    env: captureEnvSnapshot(),
    count: merged.length,
    pageCount: pageEntries.length,
    swCount: swEntries.length,
    entries: merged,
  }, null, 2);
};
