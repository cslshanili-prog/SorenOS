/**
 * Shared Web Push subscribe helpers used by the Proactive Push and 主動消息 2.0
 * paths. Both hit the same browser race / encoding quirks; this file is the
 * single source of truth so a future browser-quirk patch lands in one place.
 *
 * 同時也是「瀏覽器這一側推送現狀」的唯一讀法（readBrowserPushState 及它下面那
 * 幾個 detect*）——設置頁的狀態面板拿它顯示，各層不用各寫一份廠商判定。
 */

// unsubscribe() resolve 後 Chromium 內部 PushMessagingAppIdentifier 把當前
// 訂閱標成 removed-sentinel; 這段時間裡緊接著的 subscribe() 會直接吐
// `permanently-removed.invalid` 哨兵, 而不是去 FCM 拿新端點. 等一會再試就好.
// 桌面 Chrome ~ 300ms 夠, 移動端 / iOS PWA 給 800ms 起步, 失敗再線性退避.
export const SUBSCRIBE_SETTLE_MS = 800;
/** 總嘗試次數 (含首次), 不是"重試次數". 當前: 1 次首試 + 2 次重試 = 3 次. */
export const SUBSCRIBE_ATTEMPTS_MAX = 3;

/** Convert base64url string to Uint8Array<ArrayBuffer> (for VAPID applicationServerKey). */
export function b64uToBytes(b64u: string): Uint8Array<ArrayBuffer> {
  const padded = b64u.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (b64u.length % 4)) % 4);
  const bin = atob(padded);
  // 顯式拿 ArrayBuffer 而不是默認 ArrayBufferLike, 否則 PushManager.subscribe 在
  // 嚴格 TS lib (ArrayBufferView<ArrayBuffer>) 下會判 SharedArrayBuffer 不兼容.
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64u(buf: ArrayBuffer | null | undefined): string {
  if (!buf) return '';
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * True if a subscription's endpoint is a Chrome-internal "permanently
 * removed" sentinel.  Browsers occasionally revoke subscriptions due to
 * long inactivity, abuse signals, or the site being visited too rarely;
 * `getSubscription()` then returns an object whose endpoint URL is
 * `https://permanently-removed.invalid/...`.  `.invalid` is an RFC 2606
 * reserved TLD that never resolves, so any push send would fail with a
 * generic upstream error (which Cloudflare Workers wraps as HTTP 530).
 */
export function isDeadPushEndpoint(endpoint: string | null | undefined): boolean {
  if (!endpoint) return false;
  return endpoint.includes('permanently-removed.invalid');
}

/**
 * Web Push 三件套能力檢測: Service Worker / PushManager / Notification。
 * 全齊返回 null; 缺任何一個返回可直接展示給用戶的原因文案。
 *
 * 為什麼要細分: X瀏覽器 / Via 這類 WebView 殼瀏覽器常見「SW 能註冊成功但沒有
 * PushManager / Notification」(2026-07 用戶實測: 診斷裡 sw: active、notif:
 * unsupported, 卻被報"不支持 Service Worker") —— 籠統文案會把用戶引去查 SW /
 * 重裝 PWA, 實際是內核沒有 Web Push 能力, 只能換瀏覽器。Notification 也必須
 * 在這裡查掉: 只查 PushManager 的話, 後續 `Notification.permission` 在沒有該
 * API 的環境會直接 ReferenceError。
 */
export function describePushCapabilityGap(): string | null {
  const swSupported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  const pushSupported = typeof window !== 'undefined' && 'PushManager' in window;
  const notifSupported = typeof Notification !== 'undefined';
  if (swSupported && pushSupported && notifSupported) return null;
  const missing = [
    !swSupported ? 'Service Worker' : '',
    !pushSupported ? 'Push API' : '',
    !notifSupported ? '系統通知接口 (Notification)' : '',
  ].filter(Boolean).join('、');
  return `當前瀏覽器缺少 ${missing}，內核沒有網頁推送能力（X瀏覽器 / Via 等 WebView 殼瀏覽器的通病）—— 請換 Chrome / Edge / Firefox 等完整內核瀏覽器`;
}

/**
 * 訂閱建不出來時，是卡在哪一類。面板據此決定「瀏覽器支持」那行怎麼寫，
 * 各推送層據此掛自己的失敗代號。
 *
 * 'channel-unreachable' 是最難自己看出來的一類：瀏覽器接口全在、權限也給了，
 * 但底下那條通往推送服務商的路不通。Chromium 系（Chrome / Edge）安卓版的網頁
 * 推送是轉交系統裡的谷歌服務（GMS）去註冊的，國行安卓機默認不裝 GMS，於是
 * 能力檢測全綠、subscribe() 必掛。
 *
 * 'no-subscription' 是它的鄰居：subscribe() 既沒拋錯、也沒給訂閱，直接兌現成空。
 * 拿不到任何錯誤對象，所以只報事實、不替瀏覽器猜原因。
 */
export type SubscribeFailureKind =
  | 'channel-unreachable'
  | 'no-subscription'
  | 'unsupported'
  | 'permission'
  | 'state'
  | 'zombie'
  | 'unknown';

export interface SubscribeFailure {
  kind: SubscribeFailureKind;
  /** 可直接展示給用戶的整句。 */
  text: string;
  /** 失敗發生的時刻（epoch ms）。面板拿它說「多久之前試的」，避免展示陳年舊帳。 */
  at: number;
}

const LAST_SUBSCRIBE_FAILURE_KEY = 'push_last_subscribe_failure_v1';

/**
 * 記下 / 讀出 / 清掉「最近一次訂閱失敗」。
 *
 * 為什麼要落盤：失敗原文以前只走 toast，一閃而過，用戶回頭想看就沒了——而這類
 * 失敗恰恰是最需要照著原文排查的。落盤之後設置頁的面板能把它固定顯示出來。
 *
 * 推送鏈路（主動消息 2.0 / Proactive Push）共用這一份記錄，
 * 因為底下調的是同一個 `pushManager.subscribe()`，失敗原因是設備級的、不分鏈路。
 *
 * 寫在 subscribeWithRetry 裡面而不是各調用方：調用方漏寫一處，那條路徑的失敗就
 * 又變回一閃而過。localStorage 在 Service Worker 裡不存在，所以帶 typeof 守衛。
 */
export function rememberSubscribeFailure(failure: SubscribeFailure): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(LAST_SUBSCRIBE_FAILURE_KEY, JSON.stringify(failure));
  } catch { /* 存不下就算了，診斷信息沒到丟了要攔流程的地步 */ }
}

export function readSubscribeFailure(): SubscribeFailure | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(LAST_SUBSCRIBE_FAILURE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.text !== 'string' || typeof parsed.kind !== 'string') return null;
    return { kind: parsed.kind, text: parsed.text, at: typeof parsed.at === 'number' ? parsed.at : 0 };
  } catch {
    return null;
  }
}

export function clearSubscribeFailure(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(LAST_SUBSCRIBE_FAILURE_KEY);
  } catch { /* 同上 */ }
}

/**
 * 從訂閱端點認出推送廠商。端點域名是各廠商寫死的，認不出就說「未識別廠商」，
 * 不猜。設置頁拿它顯示「推送通道」那一行——用戶排障時第一句話往往是「我用的
 * Chrome」，能直接對上 Google FCM 就省一輪來回。
 */
export function detectPushChannel(endpoint: string | null | undefined): string {
  if (!endpoint) return '未知';
  if (/fcm\.googleapis\.com|android\.googleapis\.com/i.test(endpoint)) return 'Google FCM (Chrome / Edge / 安卓)';
  if (/updates\.push\.services\.mozilla\.com/i.test(endpoint)) return 'Mozilla autopush (Firefox)';
  if (/notify\.windows\.com|wns2/i.test(endpoint)) return 'Windows WNS (Edge)';
  if (/web\.push\.apple\.com/i.test(endpoint)) return 'Apple APNs (Safari / iOS PWA)';
  return '未識別廠商';
}

/**
 * 頁面是不是跑在 Capacitor 打包的原生殼裡（安卓/iOS 的 WebView），而不是普通
 * 瀏覽器標籤頁。探全局而不 import `@capacitor/core`，這個文件才能繼續被 SW
 * 側的打包 tree-shake 掉。
 */
export function detectCapacitorNative(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (window as any).Capacitor;
  if (!cap) return false;
  if (typeof cap.isNativePlatform === 'function') {
    try { return !!cap.isNativePlatform(); } catch { /* ignore */ }
  }
  // 老版本 Capacitor 沒有 isNativePlatform，退回讀 platform。
  return cap.platform === 'android' || cap.platform === 'ios';
}

/**
 * 在 iOS Safari 裡、但沒走「添加到主屏幕」的 PWA 啟動。iOS 的 Web Push 只在
 * 主屏 PWA 裡可用，這種情況得先引導用戶裝到主屏，光講權限沒用。
 */
export function detectIosNeedsPwa(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isIos = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && 'ontouchend' in document);
  if (!isIos) return false;
  // iOS 老的 navigator.standalone 和 display-mode 媒體查詢，任一為真都算已裝主屏。
  const standalone =
    (navigator as any).standalone === true ||
    (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches);
  return !standalone;
}

/** 瀏覽器這一側的推送現狀。跟具體哪台 worker 無關，各推送層都能拿去顯示。 */
export interface BrowserPushState {
  /** Web Push 三件套齊不齊（SW / Push API / Notification）。 */
  supported: boolean;
  /** 缺件時的整句說明，齊了是 null。取自 describePushCapabilityGap。 */
  capabilityGap: string | null;
  permission: NotificationPermission | 'unavailable';
  /** 已註冊 SW 的 scope，沒註冊是 null。 */
  swScope: string | null;
  /** 'activated' | 'installing' | 'waiting' | 'redundant' | 'none' */
  swState: string;
  /** 當前瀏覽器訂閱的端點，沒訂閱是 null。 */
  endpoint: string | null;
  /** 端點是不是 `permanently-removed.invalid` 殭屍哨兵。 */
  endpointDead: boolean;
  /** 推送廠商，見 detectPushChannel。 */
  channel: string;
  iosNeedsPwa: boolean;
  capacitorNative: boolean;
  /**
   * 最近一次訂閱失敗的記錄，沒失敗過是 null。
   *
   * 這是判斷「接口都在但這台設備實際推不了」的**唯一**可靠依據：能力檢測查的是
   * JS 接口在不在，而 Chromium 的 PushManager 是編譯進去的，跟底下有沒有推送通道
   * 無關，所以沒 GMS 的安卓機能力檢測照樣全綠。只有真的試過一次才知道。
   */
  lastSubscribeFailure: SubscribeFailure | null;
}

/**
 * 讀一次瀏覽器側的推送現狀，給設置頁的狀態面板用。
 *
 * 全程只讀、不請求權限、不建訂閱、不碰任何 worker——面板刷新會反覆調它，帶副作用
 * 的話用戶點一下「刷新」就可能被彈權限框。探測中途拋錯按「讀不到」處理，讓面板
 * 顯示得出「未註冊 / 不存在」，比整塊空著強。
 */
export async function readBrowserPushState(): Promise<BrowserPushState> {
  const capabilityGap = describePushCapabilityGap();
  const supported = capabilityGap === null;
  const permission: BrowserPushState['permission'] =
    typeof Notification === 'undefined' ? 'unavailable' : Notification.permission;

  let swScope: string | null = null;
  let swState = 'none';
  let endpoint: string | null = null;
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        swScope = reg.scope;
        const worker = reg.active || reg.waiting || reg.installing;
        swState = worker ? worker.state : 'none';
        // 殼瀏覽器可能有 SW 卻沒有 PushManager，這裡不能無條件點下去。
        const sub = await reg.pushManager?.getSubscription();
        endpoint = sub?.endpoint || null;
      }
    } catch { /* 讀不到就維持默認值 */ }
  }

  return {
    supported,
    capabilityGap,
    permission,
    swScope,
    swState,
    endpoint,
    endpointDead: isDeadPushEndpoint(endpoint),
    channel: detectPushChannel(endpoint),
    iosNeedsPwa: detectIosNeedsPwa(),
    capacitorNative: detectCapacitorNative(),
    lastSubscribeFailure: readSubscribeFailure(),
  };
}

/**
 * Translate the browser's raw subscribe() rejection into a Chinese,
 * end-user-actionable hint.  The common cases on Android phones without
 * Google Play Services (or in third-party Chromium-based browsers that
 * advertise `PushManager` but route through FCM internally) are
 * `AbortError` / generic network errors when the FCM endpoint cannot be
 * reached.  We surface those distinctly so the user knows it's not a
 * permission issue.
 */
export function explainSubscribeError(e: unknown): Omit<SubscribeFailure, 'at'> {
  const err = e as { name?: string; message?: string } | null;
  const name = err?.name || '';
  const msg = err?.message || String(e || '未知錯誤');
  if (name === 'NotAllowedError') {
    return {
      kind: 'permission',
      text: '瀏覽器拒絕創建訂閱（NotAllowedError）——通常是站點權限被攔截或處於隱身模式',
    };
  }
  if (name === 'NotSupportedError') {
    return {
      kind: 'unsupported',
      text: '當前瀏覽器不支持網頁推送——常見於手機自帶的精簡瀏覽器，或沒裝谷歌服務的國行安卓機上的 Chrome / Edge。同一台手機上可以換 Firefox 試試（它的推送不經過谷歌），或者用電腦',
    };
  }
  if (name === 'AbortError' || /push service|FCM|network/i.test(msg)) {
    return {
      kind: 'channel-unreachable',
      text: '連不上推送服務器——瀏覽器接口都在，但底下那條通往推送服務商的路走不通。Chrome / Edge 的網頁推送要轉交系統裡的谷歌服務（GMS）去註冊，國行安卓機（華為 / 小米 / OPPO / vivo）出廠就不帶 GMS，裝了也還得連得上谷歌的服務器。同一台手機上換 Firefox 最有希望（它走 Mozilla 自己的推送服務器，完全不碰谷歌），或者換電腦',
    };
  }
  if (name === 'InvalidStateError') {
    return {
      kind: 'state',
      text: '訂閱狀態衝突（InvalidStateError）——可能舊訂閱沒清乾淨，刷新頁面或再點一次「重置訂閱」',
    };
  }
  return { kind: 'unknown', text: `訂閱創建失敗（${name || 'Error'}：${msg}）` };
}

/**
 * Subscribe with retry on zombie sentinel.  Wait between attempts is linear:
 * 800ms before attempt #2, 1600ms before attempt #3.  No wait before the
 * first attempt — caller is responsible for any required settle delay after
 * its own unsubscribe().
 */
export async function subscribeWithRetry(
  reg: ServiceWorkerRegistration,
  vapidPublicKey: string,
  logPrefix: string,
): Promise<{ sub: PushSubscription | null; failure?: SubscribeFailure }> {
  // 成敗都要落一次盤：失敗留原因給面板顯示，成功清掉上一次的，否則修好之後面板
  // 還掛著一條陳年失敗，比不顯示更誤導。
  const fail = (partial: Omit<SubscribeFailure, 'at'>) => {
    const failure: SubscribeFailure = { ...partial, at: Date.now() };
    rememberSubscribeFailure(failure);
    return { sub: null, failure };
  };

  for (let attempt = 0; attempt < SUBSCRIBE_ATTEMPTS_MAX; attempt++) {
    let sub: PushSubscription | null;
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64uToBytes(vapidPublicKey),
      });
    } catch (e) {
      console.warn(`${logPrefix} pushManager.subscribe failed`, e);
      return fail(explainSubscribeError(e));
    }
    // 安卓 Firefox 實測：連不上 Mozilla 的推送服務器時，subscribe() 既不拋錯、也不給訂閱，
    // 而是直接兌現成 null。少這一手的話，下一行讀 endpoint 就拋 TypeError——用戶看到的是
    // 一句「can't access property "endpoint"」的英文報錯，面板上還一條失敗記錄都留不下。
    if (!sub) {
      console.warn(`${logPrefix} pushManager.subscribe resolved without a subscription`);
      return fail({
        kind: 'no-subscription',
        text: '瀏覽器沒給出推送訂閱——沒報錯，也沒拿到訂閱。換個網絡、或者換個瀏覽器再試試',
      });
    }
    if (!isDeadPushEndpoint(sub.endpoint)) {
      clearSubscribeFailure();
      return { sub };
    }
    try { await sub.unsubscribe(); } catch (e) {
      // 如果連 unsubscribe 都拋, 下一次 subscribe() 大概率還是同一個 zombie,
      // 但仍然兜底重試 (重試上限擋著不會死循環).
      console.warn(`${logPrefix} unsubscribe of zombie endpoint threw`, e);
    }
    const isLast = attempt === SUBSCRIBE_ATTEMPTS_MAX - 1;
    if (!isLast) {
      const wait = SUBSCRIBE_SETTLE_MS * (attempt + 1);
      console.warn(`${logPrefix} subscribe() returned zombie endpoint; retry #${attempt + 1} after ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  return fail({
    kind: 'zombie',
    text: `瀏覽器持續返回 permanently-removed.invalid（已嘗試 ${SUBSCRIBE_ATTEMPTS_MAX} 次）— 可能是由於站點參與度 (Site Engagement) 過低或瀏覽器內部數據殘留導致。請嘗試清理站點數據後重試，或更換設備/瀏覽器`,
  });
}
