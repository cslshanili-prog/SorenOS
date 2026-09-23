/**
 * 網易雲 API 響應緩存層
 *
 * 目標：進入 Music App / 桌面切換 / 反覆點擊頁面時，不再重複打網易雲接口。
 *
 * 設計：
 *   1. 內存 Map + localStorage 雙層。進程內快，刷新後仍有效。
 *   2. 每條記錄帶 TTL；不同 path 走不同的有效期（見 TTL_RULES）。
 *   3. Cookie 會作為 key 的鹽（僅取末尾 8 位做標識）——換帳號不會讀到上一個帳號的緩存。
 *   4. 同一個 key 的併發請求會合併成一個 in-flight promise，避免 bursty 重複請求。
 *   5. 寫操作（like / 簽到 / 登錄 / 登出）通過 invalidate 主動清掉相關路徑。
 *
 * 為什麼不走數據導入導出：
 *   這裡的 LS key 不在 OSContext 備份 allowlist 裡，後端只挑指定鍵做 backup。
 *   緩存隨時可以重建，沒必要增加備份體積。
 */

type Entry = { data: any; expires: number };

const LS_KEY = 'sully_music_api_cache_v1'; // 不參與 backup/import-export
const MAX_ENTRIES = 200;

/**
 * 每個 path 的默認 TTL（毫秒）。
 * 精確匹配優先於前綴匹配；沒匹配上 → 不緩存（直接走網絡）。
 */
const TTL_RULES: Array<{ path: string; ttl: number; exact?: boolean }> = [
  // 用戶側（合理地保守一點，防止登錄後看到舊數據）
  { path: '/login/status',       ttl: 60 * 1000 },
  { path: '/user/detail',        ttl: 5 * 60 * 1000 },
  { path: '/user/playlist',      ttl: 5 * 60 * 1000 },
  { path: '/user/record',        ttl: 5 * 60 * 1000 },
  { path: '/user/cloud',         ttl: 10 * 60 * 1000 },
  { path: '/user/subcount',      ttl: 5 * 60 * 1000 },
  { path: '/likelist',           ttl: 5 * 60 * 1000 },

  // 歌單內容
  { path: '/playlist/detail',    ttl: 10 * 60 * 1000 },
  { path: '/playlist/track/all', ttl: 10 * 60 * 1000 },

  // 歌詞基本不會改
  { path: '/lyric',              ttl: 24 * 60 * 60 * 1000 },

  // 榜單半小時夠了
  { path: '/toplist',            ttl: 30 * 60 * 1000 },

  // CDN 鏈接一般 ~20min 內有效，給短點避免點進去放不出來
  { path: '/song/url',           ttl: 90 * 1000 },
];

/**
 * 不應該被緩存的 path（即使沒匹配 TTL 也顯式列出，防止將來手滑加 TTL）：
 *   /search             —— keyword 空間太大，用戶會頻繁變
 *   /recommend/songs    —— 每日推薦，且帶隨機
 *   /personal_fm        —— 隨機電台
 *   /daily_signin       —— 寫
 *   /like               —— 寫
 *   /logout             —— 寫
 *   /login/cellphone    —— 寫
 *   /login/qr/*         —— 驗證碼態，必須實時
 *   /captcha/sent       —— 寫
 */

const MEM = new Map<string, Entry>();
const INFLIGHT = new Map<string, Promise<any>>();
let LOADED = false;

const stableStringify = (v: any): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
};

const cookieSalt = (cookie?: string): string => {
  const c = (cookie || '').trim();
  if (!c) return 'anon';
  // 取末尾 8 位作為帳號區分，避免把 cookie 明文落地到 key
  return c.length <= 8 ? c : c.slice(-8);
};

const getTtl = (path: string): number | null => {
  for (const r of TTL_RULES) {
    if (r.path === path) return r.ttl;
  }
  for (const r of TTL_RULES) {
    if (path.startsWith(r.path)) return r.ttl;
  }
  return null;
};

const load = () => {
  if (LOADED) return;
  LOADED = true;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw) as Record<string, Entry>;
    const now = Date.now();
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v.expires === 'number' && v.expires > now) {
        MEM.set(k, v);
      }
    }
  } catch {}
};

const persistNow = () => {
  try {
    // 逐出過期 + 容量裁剪（丟掉最早插入的）
    const now = Date.now();
    const arr: Array<[string, Entry]> = [];
    for (const [k, v] of MEM) {
      if (v.expires > now) arr.push([k, v]);
      else MEM.delete(k);
    }
    if (arr.length > MAX_ENTRIES) arr.splice(0, arr.length - MAX_ENTRIES);
    const out: Record<string, Entry> = {};
    for (const [k, v] of arr) out[k] = v;
    localStorage.setItem(LS_KEY, JSON.stringify(out));
  } catch {}
};

// 批量：同一 task 內多次寫只落盤一次。
// 用 microtask（Promise.resolve().then）而不是 setTimeout —— microtask 會在當前 task 末尾、
// 瀏覽器把頁面交給 unload 之前跑完；setTimeout 可能趕不上快速刷新。
let persistQueued = false;
const schedulePersist = () => {
  if (persistQueued) return;
  persistQueued = true;
  Promise.resolve().then(() => {
    persistQueued = false;
    persistNow();
  });
};

/**
 * 頁面卸載 / 切後台時同步落盤，兜住 microtask 也錯過的邊界情況。
 * pagehide 對 bfcache 有效；visibilitychange→hidden 對後台切換有效。
 */
if (typeof window !== 'undefined') {
  const flush = () => { persistQueued = false; persistNow(); };
  window.addEventListener('pagehide', flush);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}

const makeKey = (path: string, body: any, cookie?: string) =>
  `${cookieSalt(cookie)}|${path}|${stableStringify(body ?? {})}`;

/**
 * 包裝實際請求。不在緩存規則裡的 path → 直接打網絡。
 */
export async function cachedCall<T = any>(
  path: string,
  body: any,
  cookie: string | undefined,
  doCall: () => Promise<T>,
): Promise<T> {
  const ttl = getTtl(path);
  if (!ttl) return doCall();

  load();
  const key = makeKey(path, body, cookie);
  const now = Date.now();

  const hit = MEM.get(key);
  if (hit && hit.expires > now) return hit.data as T;

  const pending = INFLIGHT.get(key);
  if (pending) return pending as Promise<T>;

  const p = doCall().then(
    (res) => {
      MEM.set(key, { data: res, expires: Date.now() + ttl });
      INFLIGHT.delete(key);
      schedulePersist();
      return res;
    },
    (err) => {
      INFLIGHT.delete(key);
      throw err;
    },
  );
  INFLIGHT.set(key, p);
  return p;
}

/**
 * 按路徑前綴清除。cookie 傳入就只清當前帳號，不傳就全帳號清。
 * 用例：
 *   toggleLike 後       → invalidate('/likelist', cfg.cookie)
 *   簽到後              → invalidate('/user/subcount', cfg.cookie)
 *   登錄 / 登出 / 換帳號 → clearAll()
 */
export function invalidate(pathPrefix: string, cookie?: string) {
  load();
  const salt = cookie !== undefined ? cookieSalt(cookie) : null;
  for (const k of [...MEM.keys()]) {
    const sepA = k.indexOf('|');
    if (sepA < 0) continue;
    const sepB = k.indexOf('|', sepA + 1);
    if (sepB < 0) continue;
    const s = k.slice(0, sepA);
    const path = k.slice(sepA + 1, sepB);
    if (salt && s !== salt) continue;
    if (path.startsWith(pathPrefix)) MEM.delete(k);
  }
  schedulePersist();
}

export function clearAll() {
  MEM.clear();
  INFLIGHT.clear();
  try { localStorage.removeItem(LS_KEY); } catch {}
  LOADED = true;
}
