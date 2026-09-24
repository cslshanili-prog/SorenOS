import {
  ActiveMsg2GlobalConfig,
  ActiveMsg2InboxMessage,
  Amsg2ExpiredNoticeRecord,
} from '../types';

const DB_NAME = 'ActiveMsg';
// MUST be kept in sync with worker/sw-keep-alive.ts:ACTIVE_MSG_DB_VERSION.
// IMPORTANT: once a client opens v2, downgrade to a v1 codebase will fail to open this DB.
const DB_VERSION = 2;
const STORE_KV = 'kv';
const STORE_INBOX = 'inbox';
// 下面三張表現在沒人讀寫，只在 clearLegacyInstantPushStores 裡清空一次舊數據。
// 建表邏輯留著是為了不動庫版本：刪表就得升 DB_VERSION，頁面和 SW 必須同步升級，
// 否則老的一方打開庫直接 VersionError、推送靜默丟失。
const STORE_OUTBOUND_SESSIONS = 'outbound_sessions';
const STORE_PENDING_TOOL_CALLS = 'pending_tool_calls';
const STORE_REASONING_BUFFER = 'reasoning_buffer';
const GLOBAL_CONFIG_KEY = 'global-config';
/** 刪庫被別的連接擋住時最多等多久（見 deleteDB 的註釋）。 */
const DELETE_DB_BLOCKED_TIMEOUT_MS = 3000;

const EXPIRED_NOTICES_PREFIX = 'amsg2_expired_notices_';
const EXPIRED_NOTICES_MAX = 10;
const EXPIRED_NOTICES_TTL_MS = 48 * 3600_000;

type KvRecord<T = unknown> = {
  id: string;
  value: T;
};

// Keep the shared web/PWA build unchanged. The private Capacitor build may
// provide its own Worker URL so the native shell works without manual setup.
const capacitorDefaultWorkerUrl = import.meta.env.VITE_AMSG_NATIVE_PUSH === 'true'
  ? String(import.meta.env.VITE_AMSG_DEFAULT_WORKER_URL || '').trim()
  : '';

const defaultGlobalConfig: ActiveMsg2GlobalConfig = {
  userId: '',
  workerUrl: capacitorDefaultWorkerUrl,
};

// 單例連接緩存。同 utils/db.ts 的根因: 原本每個 op 都新開一條 ActiveMsg 連接且從不
// close, 跟主庫一起在併發下撐爆 Chromium backing store, 連帶 SW 寫 inbox 也失敗。
// 複用同一條連接, 並在連接被外部失效 (版本升級 / 瀏覽器強制關閉) 時清緩存自愈。
let dbPromise: Promise<IDBDatabase> | null = null;

const openDB = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise;

  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    // onblocked 不是終態: 先 reject, 但底層 open request 還活著, 佔用方關閉後仍會觸發
    // onsuccess。用 settled 標記 promise 已 settle, 讓遲到的連接被 close 而非洩漏成
    // 一條沒人持有、卻能 block 後續升級 / 刪庫的孤兒連接。
    // 清緩存一律先比對 dbPromise === promise: onclose/onerror 等都是異步回調, 若期間已
    // 重開並緩存了新 promise (如 SW withInboxTx 強關後重試), 陳舊連接的回調不能把新單例
    // 誤清, 否則又憑空多開一條連接 (見 amsg-sw 2.3.0 同款守衛)。
    let settled = false;

    request.onerror = () => {
      if (dbPromise === promise) dbPromise = null; // 打開失敗別緩存 rejected promise
      settled = true;
      reject(request.error);
    };
    request.onblocked = () => {
      // SW or another tab holds an older version; can't upgrade. Reject so callers don't hang.
      if (dbPromise === promise) dbPromise = null;
      settled = true;
      reject(new Error('IndexedDB open blocked — close other tabs / unregister SW and retry'));
    };
    request.onsuccess = () => {
      const db = request.result;
      // 已經 reject 過 (onblocked / onerror): 遲到的連接沒人接收, 直接 close, 否則它開著
      // 會 block 後續升級 / deleteDatabase。
      if (settled) {
        try { db.close(); } catch { /* ignore */ }
        return;
      }
      // 另一個 tab / SW 升級版本時主動 close 讓位 + 清緩存; 強制關閉時也清緩存自愈。
      db.onversionchange = () => {
        db.close();
        if (dbPromise === promise) dbPromise = null;
      };
      db.onclose = () => {
        if (dbPromise === promise) dbPromise = null;
      };
      resolve(db);
    };
    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE_KV)) {
        db.createObjectStore(STORE_KV, { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains(STORE_INBOX)) {
        db.createObjectStore(STORE_INBOX, { keyPath: 'messageId' });
      }

      // v2 的三張閒置表（見常量處註釋），建出來只為跟 SW 那邊的 schema 保持一致。
      if (!db.objectStoreNames.contains(STORE_OUTBOUND_SESSIONS)) {
        db.createObjectStore(STORE_OUTBOUND_SESSIONS, { keyPath: 'sessionId' });
      }

      if (!db.objectStoreNames.contains(STORE_PENDING_TOOL_CALLS)) {
        db.createObjectStore(STORE_PENDING_TOOL_CALLS, { keyPath: 'sessionId' });
      }

      if (!db.objectStoreNames.contains(STORE_REASONING_BUFFER)) {
        db.createObjectStore(STORE_REASONING_BUFFER, { keyPath: 'sessionId' });
      }
    };
  });

  dbPromise = promise;
  return promise;
};

const getKv = async <T>(id: string): Promise<T | null> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_KV, 'readonly');
    const request = tx.objectStore(STORE_KV).get(id);
    request.onsuccess = () => resolve((request.result as KvRecord<T> | undefined)?.value ?? null);
    request.onerror = () => reject(request.error);
  });
};

const setKv = async <T>(id: string, value: T): Promise<void> => {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_KV, 'readwrite');
    tx.objectStore(STORE_KV).put({ id, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

// XHS 筆記緩衝: push 沖刷時把 worker 捎回的筆記寫進來, [[XHS_SHARE]]/評論/點贊 重放時讀.
// 存在 KV 是因為內存單例 (pushLastXhsNotesRef) 跨 SW 喚醒 / 頁面回收會清空 —— 移動端
// 收到 push 和沖刷之間常隔一次後台重載, 筆記一丟 XHS_SHARE 就靜默掉卡片.
const XHS_SESSION_NOTES_PREFIX = 'xhs_session_notes:';
const XHS_SESSION_NOTES_TTL_MS = 3 * 60 * 60 * 1000;

export type XhsSessionNotes = {
  notes: unknown[];
  xsecTokens: Array<[string, string]>;
  savedAt: number;
};

// 寫入時順手清理過期條目, 防 KV 無界增長.
const pruneStaleXhsSessionNotes = async (): Promise<void> => {
  try {
    const db = await openDB();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_KV, 'readwrite');
      const store = tx.objectStore(STORE_KV);
      const cutoff = Date.now() - XHS_SESSION_NOTES_TTL_MS;
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        const rec = cursor.value as KvRecord<{ savedAt?: number }> | undefined;
        if (rec && typeof rec.id === 'string' && rec.id.startsWith(XHS_SESSION_NOTES_PREFIX)) {
          const savedAt = Number(rec.value?.savedAt ?? 0);
          if (savedAt < cutoff) cursor.delete();
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch { /* prune 盡力而為, 失敗不影響主流程 */ }
};

const generateUuidV4 = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.random() * 16 | 0;
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
};

export const ActiveMsgStore = {
  /**
   * 刪掉整個 ActiveMsg 庫。只給「重置全部數據」用。
   *
   * 2.0 的連接信息（worker 地址、共享密鑰、主密鑰、用戶 id）住在這個庫裡，跟角色、
   * 聊天記錄那個主庫（AetherOS_Data）是分開的兩個庫。重置只刪主庫的話，角色全沒了
   * 而連接信息還在，雲端那批任務照樣到點跑、照樣燒 API 額度、照樣往這台設備推消息，
   * 本地卻已經沒有任何記錄知道它們存在。
   *
   * Service Worker 也開著這個庫（見 worker/sw-keep-alive.ts），它那條連接不歸頁面管，
   * 所以 deleteDatabase 可能一直 blocked。超時後照常往下走，不把重置卡在這裡：重置的
   * 下一步就是刷新頁面，頁面一刷新連接就斷，庫會在那之後被刪掉。
   */
  async deleteDB(): Promise<void> {
    if (dbPromise) {
      try { (await dbPromise).close(); } catch { /* ignore */ }
      dbPromise = null;
    }
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      const finish = () => resolve();
      // blocked 不是終態：佔用方關閉後仍會觸發 onsuccess。超時兜底只是不再等它。
      const timer = setTimeout(finish, DELETE_DB_BLOCKED_TIMEOUT_MS);
      const settle = () => { clearTimeout(timer); finish(); };
      request.onsuccess = settle;
      request.onerror = () => {
        console.warn('[ActiveMsgStore] 刪庫失敗', request.error);
        settle();
      };
      request.onblocked = () => {
        console.warn('[ActiveMsgStore] 刪庫被佔用方擋住，等頁面刷新後自行完成');
      };
    });
  },

  async getGlobalConfig(): Promise<ActiveMsg2GlobalConfig> {
    const stored = await getKv<ActiveMsg2GlobalConfig>(GLOBAL_CONFIG_KEY);
    const config = { ...defaultGlobalConfig, ...(stored || {}) };
    // Older App installs may already have persisted an empty URL. Fill only
    // that empty value in the private build; an explicit non-empty URL wins.
    if (!config.workerUrl?.trim() && capacitorDefaultWorkerUrl) {
      config.workerUrl = capacitorDefaultWorkerUrl;
    }
    return config;
  },

  async saveGlobalConfig(updates: Partial<ActiveMsg2GlobalConfig>): Promise<ActiveMsg2GlobalConfig> {
    const current = await this.getGlobalConfig();
    const next: ActiveMsg2GlobalConfig = {
      ...current,
      ...updates,
      updatedAt: Date.now(),
    };
    await setKv(GLOBAL_CONFIG_KEY, next);
    return next;
  },

  async ensureUserId(): Promise<string> {
    const current = await this.getGlobalConfig();
    if (current.userId) return current.userId;

    const userId = generateUuidV4();
    await this.saveGlobalConfig({ userId });
    return userId;
  },

  async saveInboxMessage(message: ActiveMsg2InboxMessage): Promise<void> {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_INBOX, 'readwrite');
      tx.objectStore(STORE_INBOX).put(message);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  /**
   * 收件箱裡現在有幾條。**只數個數，不讀內容**——給前台那趟定期巡查用。
   *
   * 巡查每幾秒就要跑一次，不能每回都把整表讀出來再原樣丟掉。count() 不反序列化任何
   * 記錄，空表時幾乎不花時間；數出來是 0 就到此為止，有貨才去走完整的沖刷。
   */
  async countInboxMessages(): Promise<number> {
    const db = await openDB();
    return new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORE_INBOX, 'readonly');
      const request = tx.objectStore(STORE_INBOX).count();
      request.onsuccess = () => resolve(request.result || 0);
      request.onerror = () => reject(request.error);
    });
  },

  async listInboxMessages(): Promise<ActiveMsg2InboxMessage[]> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_INBOX, 'readonly');
      const request = tx.objectStore(STORE_INBOX).getAll();
      request.onsuccess = () => {
        const messages = (request.result || []) as ActiveMsg2InboxMessage[];
        messages.sort((a, b) => (a.sentAt || a.receivedAt) - (b.sentAt || b.receivedAt));
        resolve(messages);
      };
      request.onerror = () => reject(request.error);
    });
  },

  // 單事務原子 claim: getAll + delete 同一個 readwrite tx。IndexedDB 跨連接
  // (跨 tab / 跨 SW / 同 tab 多 caller) 對同一 object store 的 readwrite 事務
  // 是 serializable 的, 第二個 caller 會等第一個 commit 後才進入, 所以同一條
  // inbox 消息絕不可能被兩個 caller 同時 claim。這是把 race 關在 IDB 層。
  //
  // 已知取捨 (TODO): 這是"先 ack 後處理"語義 —— 調用方拿到 messages 後若
  // saveMessage 拋錯, 消息已經從 inbox 刪了, 會丟。當前沒修是因為:
  //   1. DB.saveMessage 用 IDB add(), 失敗極罕見 (quota / corruption)
  //   2. 改成"先 save 後 ack" 會需要把 list 和 delete 拆開, 反而把這裡的
  //      原子性優勢讓出去, 重新打開併發讀到同一項的窗口
  // 真要補防丟, 加一層 dead-letter / try-catch 後 put 回 inbox, 而不是
  // 拆開這個事務。
  async consumeInboxMessages(): Promise<ActiveMsg2InboxMessage[]> {
    const db = await openDB();
    return new Promise<ActiveMsg2InboxMessage[]>((resolve, reject) => {
      const tx = db.transaction(STORE_INBOX, 'readwrite');
      const store = tx.objectStore(STORE_INBOX);
      const request = store.getAll();
      let messages: ActiveMsg2InboxMessage[] = [];
      request.onsuccess = () => {
        messages = (request.result || []) as ActiveMsg2InboxMessage[];
        // 一個 user turn 可能產 N 條 push (multi-chunk pushPayloads). FCM 投遞不嚴格
        // 保序, 必須按 (sessionId, messageIndex) 排序才能拿到正確氣泡順序. 沒 sessionId
        // 的走 sentAt fallback.
        messages.sort((a, b) => {
          const aSess = a.metadata?.sessionId as string | undefined;
          const bSess = b.metadata?.sessionId as string | undefined;
          if (aSess && aSess === bSess) {
            const aIdx = Number(a.metadata?.messageIndex ?? 0);
            const bIdx = Number(b.metadata?.messageIndex ?? 0);
            return aIdx - bIdx;
          }
          return (a.sentAt || a.receivedAt) - (b.sentAt || b.receivedAt);
        });
        messages.forEach((m) => store.delete(m.messageId));
      };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve(messages);
      tx.onabort = () => reject(tx.error || new Error('inbox consume aborted'));
      tx.onerror = () => reject(tx.error);
    });
  },

  /**
   * 清空 v2 的三張閒置表（outbound_sessions / pending_tool_calls / reasoning_buffer）。
   * outbound_sessions 裡存過 API key 副本和整段消息快照，從來沒被清過；只給
   * instantPushLegacyCleanup 調，一個事務清完。
   */
  async clearLegacyInstantPushStores(): Promise<void> {
    const db = await openDB();
    const stores = [STORE_OUTBOUND_SESSIONS, STORE_PENDING_TOOL_CALLS, STORE_REASONING_BUFFER]
      .filter((name) => db.objectStoreNames.contains(name));
    if (stores.length === 0) return;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(stores, 'readwrite');
      for (const name of stores) tx.objectStore(name).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('legacy store clear aborted'));
    });
  },

  // ─── XHS 筆記緩衝 (持久化) ─────────────────────────────────────────────────
  async saveXhsSessionNotes(
    sessionId: string,
    payload: { notes: unknown[]; xsecTokens: Array<[string, string]> },
  ): Promise<void> {
    if (!sessionId) return;
    await setKv<XhsSessionNotes>(`${XHS_SESSION_NOTES_PREFIX}${sessionId}`, {
      notes: payload.notes,
      xsecTokens: payload.xsecTokens,
      savedAt: Date.now(),
    });
    await pruneStaleXhsSessionNotes();
  },

  async getXhsSessionNotes(sessionId: string): Promise<XhsSessionNotes | null> {
    if (!sessionId) return null;
    return getKv<XhsSessionNotes>(`${XHS_SESSION_NOTES_PREFIX}${sessionId}`);
  },

  // ─── 防穿幫閘·作廢回執台帳 ───

  async getExpiredNotices(charId: string): Promise<Amsg2ExpiredNoticeRecord[]> {
    const list = await getKv<Amsg2ExpiredNoticeRecord[]>(`${EXPIRED_NOTICES_PREFIX}${charId}`);
    return Array.isArray(list) ? list : [];
  },

  /** 合併新候選（按 id 去重），順手清 48h 前的老記錄，封頂 10 條防無界增長。 */
  async upsertExpiredNotices(charId: string, records: Amsg2ExpiredNoticeRecord[]): Promise<Amsg2ExpiredNoticeRecord[]> {
    const byId = new Map((await this.getExpiredNotices(charId)).map((r) => [r.id, r]));
    for (const record of records) {
      if (!byId.has(record.id)) byId.set(record.id, record);
    }
    const cutoff = Date.now() - EXPIRED_NOTICES_TTL_MS;
    const alive = [...byId.values()]
      .filter((r) => r.createdAt >= cutoff)
      .sort((a, b) => b.occurrenceMs - a.occurrenceMs);
    // 超限時先淘汰已告知的（Codex #11）——「作廢 ≠ 消失」是設計底線，未告知回執
    // 不允許被靜默截斷；真溢出（病態場景）保最新未告知並 warn 留痕。
    let next = alive;
    if (alive.length > EXPIRED_NOTICES_MAX) {
      const unnotified = alive.filter((r) => !r.notifiedAt);
      const notified = alive.filter((r) => r.notifiedAt);
      next = [...unnotified, ...notified].slice(0, EXPIRED_NOTICES_MAX);
      if (unnotified.length > EXPIRED_NOTICES_MAX) {
        console.warn('[ActiveMsgStore] 未告知作廢回執超上限，最舊的被截斷', { charId, dropped: unnotified.length - EXPIRED_NOTICES_MAX });
      }
    }
    await setKv(`${EXPIRED_NOTICES_PREFIX}${charId}`, next);
    return next;
  },

  async markExpiredNoticesNotified(charId: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    const idSet = new Set(ids);
    const next = (await this.getExpiredNotices(charId)).map((r) =>
      idSet.has(r.id) ? { ...r, notifiedAt: r.notifiedAt ?? Date.now() } : r);
    await setKv(`${EXPIRED_NOTICES_PREFIX}${charId}`, next);
  },
};

/**
 * 備份用：把主動消息 2.0 的全局配置整份取出來（Worker 地址、密鑰、即時對話開關等）。
 *
 * 這份配置存在自己的 `ActiveMsg` 庫裡，不在主庫那份 store 清單內，所以必須單獨取一次
 * 掛進備份包。沒配過 Worker 就返回 undefined，讓備份裡乾脆不出現這個鍵。
 *
 * 整份帶走而不是挑字段：這裡將來加了新配置，備份會自動跟上，不用再想起來同步一次。
 */
export async function exportAmsg2GlobalConfig(): Promise<ActiveMsg2GlobalConfig | undefined> {
  try {
    const config = await ActiveMsgStore.getGlobalConfig();
    return config.workerUrl?.trim() ? config : undefined;
  } catch (e) {
    console.warn('[amsg2] 讀取全局配置失敗，備份將不含這一項', e);
    return undefined;
  }
}

/**
 * 備份用：把上面那份配置寫回去。
 *
 * `instantChatSupported` 不還原——它記的是「上次探到那台 Worker 跑不跑得動即時對話」，
 * 是一次探測的結果而不是用戶的選擇。備份裡那個值可能已經過時（Worker 後來更新過 / 退回過），
 * 照抄回來要麼白擋一次、要麼在跑不動的 Worker 上放行。留空表示「還沒探過」，
 * 握手時會補探一次，之後就有準數了。
 */
export async function importAmsg2GlobalConfig(
  config: ActiveMsg2GlobalConfig | null | undefined,
): Promise<void> {
  if (!config || typeof config !== 'object') return;
  const { instantChatSupported: _dropped, ...restorable } = config;
  await ActiveMsgStore.saveGlobalConfig({ ...restorable, instantChatSupported: undefined });
}

export const maskActiveMsgUserId = (userId: string) => {
  if (!userId) return '未生成';
  if (userId.length <= 12) return userId;
  return `${userId.slice(0, 8)}••••${userId.slice(-8)}`;
};
