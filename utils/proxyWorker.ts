/**
 * 主代理 Worker 地址 —— 中心配置（單一可信源）
 *
 * SullyOS 一票聯網能力都通過同一個 Cloudflare Worker 代理轉發，源碼全在
 * `worker/index.js`（單文件，可一鍵搬到自己的 Cloudflare 帳號）。涉及：
 *   - 聯網搜索 / 實時新聞熱榜（Brave）       → /search /news
 *   - WebDAV 雲備份代理                       → /webdav
 *   - GitHub 雲備份代理（GFW 下走代理）       → /github
 *   - Notion 集成                             → /notion/*
 *   - 飛書多維表格集成                        → /feishu/*
 *   - 麥當勞 / 瑞幸 點單 MCP                   → /mcp/mcd /mcp/luckin
 *   - Cloudflare API 中轉（一鍵部署後端用）    → /cf-api
 *
 * 默認指向作者部署的公共實例。如果作者哪天不再維護、或你想完全自託管，
 * 把自己部署的 worker 地址填進「設置 → 網絡代理 (Worker)」即可，
 * 以上全部能力會自動切到你的實例，無需改任何代碼。
 *
 * 網易雲音樂（MusicContext）在播放器設置裡另有一個服務地址輸入框：留空 = 跟隨這裡，
 * 填了則只有音樂走那個地址。小紅書 Lite 的 serverUrl 指向用戶自己電腦上跑的服務，
 * 跟這裡是兩回事。
 */

export const DEFAULT_PROXY_WORKER = 'https://sullymeow.ccwu.cc';

const LS_KEY = 'sully_proxy_worker_url_v1';
const SETTINGS_FOCUS_SESSION_KEY = 'sully_settings_focus_proxy_worker_v1';

// 已死/棄用的歷史公共實例域名。老用戶 localStorage 裡如果還存著這些，
// 讀出來時自動當成"用的是默認"，回落到 DEFAULT_PROXY_WORKER（與
// MusicContext 的遷移邏輯一致：都指向同一個 worker，行為相同）。
//   - sully-n.qegj567.workers.dev：最早的 workers.dev 默認域名（國內超時）
//   - sullymeow.ccwu213.cc：舊公共自定義域名，註冊已過期、DNS 無法解析（2026-07 起）
const STALE_HOSTS = [/sully-n\.qegj567\.workers\.dev/i, /sullymeow\.ccwu213\.cc/i];

const normalize = (url: string): string => url.trim().replace(/\/+$/, '');

// 非瀏覽器運行時（amsg worker 等）沒有 localStorage，靠這個顯式注入用戶配置的
// 代理地址；瀏覽器端不設置，保持 localStorage 懶讀不變。
let runtimeOverrideUrl: string | null = null;

/**
 * 注入代理 worker 地址（無 localStorage 的運行時用，如 amsg worker 到點執行工具時）。
 * 傳空串/null 清除注入，回到 localStorage → 默認值 的正常解析順序。
 */
export const setProxyWorkerUrlOverride = (url: string | null): void => {
  const trimmed = normalize(url || '');
  runtimeOverrideUrl = /^https?:\/\//i.test(trimmed) ? trimmed : null;
};

/**
 * 讀取當前生效的主代理 worker 地址（已去尾斜槓）。懶讀 localStorage，
 * 用戶在設置裡改完、新發起的請求立刻生效，無需刷新頁面。
 */
export const getProxyWorkerUrl = (): string => {
  if (runtimeOverrideUrl) return runtimeOverrideUrl;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULT_PROXY_WORKER;
    const url = normalize(raw);
    if (!/^https?:\/\//i.test(url)) return DEFAULT_PROXY_WORKER;
    if (STALE_HOSTS.some((re) => re.test(url))) return DEFAULT_PROXY_WORKER;
    return url;
  } catch {
    return DEFAULT_PROXY_WORKER;
  }
};

/**
 * 寫入自定義 worker 地址。傳空、或傳的就是默認地址 → 清掉本地存儲（回到默認）。
 * 非法地址（不以 http(s):// 開頭）直接忽略，由調用方負責校驗提示。
 * 寫入成功後廣播一個自定義事件，讓"啟動時快照配置"的消費者（如音樂播放器）能實時跟隨。
 */
export const setProxyWorkerUrl = (url: string): void => {
  try {
    const trimmed = normalize(url || '');
    if (!trimmed || trimmed === DEFAULT_PROXY_WORKER) {
      localStorage.removeItem(LS_KEY);
      notifyProxyWorkerChanged();
      return;
    }
    if (!/^https?:\/\//i.test(trimmed)) return;
    localStorage.setItem(LS_KEY, trimmed);
    notifyProxyWorkerChanged();
  } catch {
    /* localStorage 不可用就當默認處理 */
  }
};

/**
 * 中心 Worker 地址變更事件。同一標籤頁內改 localStorage 不會觸發原生 'storage' 事件，
 * 所以用這個自定義事件通知那些"只在掛載時讀一次配置"的模塊（目前是音樂播放器）實時刷新。
 */
export const PROXY_WORKER_CHANGED_EVENT = 'sully:proxy-worker-changed';
const notifyProxyWorkerChanged = (): void => {
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new Event(PROXY_WORKER_CHANGED_EVENT));
    }
  } catch {
    /* 非瀏覽器環境（測試 / SSR）忽略 */
  }
};

/** 當前是否在用自定義（非默認）worker。用於設置頁提示文案。 */
export const isCustomProxyWorker = (): boolean => getProxyWorkerUrl() !== DEFAULT_PROXY_WORKER;

/** 從公告等入口打開設置時，請設置頁自動展開並定位到網絡代理。 */
export const requestProxyWorkerSettingsFocus = (): void => {
  try {
    sessionStorage.setItem(SETTINGS_FOCUS_SESSION_KEY, '1');
  } catch {
    /* sessionStorage 不可用時仍可正常打開設置，只是不自動定位。 */
  }
};

/** 一次性讀取定位請求，避免用戶以後每次打開設置都被拉到頁面底部。 */
export const consumeProxyWorkerSettingsFocus = (): boolean => {
  try {
    const requested = sessionStorage.getItem(SETTINGS_FOCUS_SESSION_KEY) === '1';
    if (requested) sessionStorage.removeItem(SETTINGS_FOCUS_SESSION_KEY);
    return requested;
  } catch {
    return false;
  }
};

/**
 * 把指向已死歷史實例的 url 改寫到當前生效的 worker（保留路徑和 query）；
 * 其餘地址原樣返回。給小紅書 serverUrl 這類「自己存一份地址」的模塊做存量遷移用——
 * 它們存的地址不走上面的 LS_KEY，得在自己的讀取層調這個。
 */
export const rewriteStaleWorkerUrl = (url: string): string => {
  if (typeof url !== 'string' || !url || !STALE_HOSTS.some((re) => re.test(url))) return url;
  const base = getProxyWorkerUrl();
  try {
    const u = new URL(url);
    return `${base}${u.pathname === '/' ? '' : u.pathname}${u.search}`;
  } catch {
    return base;
  }
};
