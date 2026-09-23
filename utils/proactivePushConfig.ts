/**
 * Config + wire-up for the optional Cloudflare Worker that accelerates
 * Proactive Chat via Web Push.  All state lives in localStorage so the
 * Service Worker and the main thread can both read it synchronously.
 *
 * When disabled or misconfigured, every function becomes a no-op and the
 * existing local-timer path in proactiveChat.ts keeps working unchanged.
 *
 * Worker URL / VAPID public key / client token are baked in here as
 * constants — end users never see them.  After deploying the Worker via
 * the Cloudflare dashboard (see worker/proactive-push/README.md), fill
 * these three values and rebuild.  VAPID public keys are meant to be
 * public; the client token is weak "through obscurity" gating for a
 * personal-scale deployment.
 */

// ═══════════════════════════════════════════════════════════════════
//   FILL THESE IN AFTER DEPLOYING THE CLOUDFLARE WORKER
//
//   VAPID 公私鑰在 utils/pushVapid.ts (push_vapid_v1) — 默認空，由用戶在
//   Settings → 推送憑據 (VAPID) 裡生成；跟主動消息 2.0 用同一份，避免互相
//   unsubscribe 搶同一個 pushManager 訂閱。
// ═══════════════════════════════════════════════════════════════════
const WORKER_URL = 'https://noir2.cc.cd';
const CLIENT_TOKEN = 'weqwqewqeqwdcsccagdgs32132';
// ═══════════════════════════════════════════════════════════════════

// ── 全局停用開關（KILL SWITCH）─────────────────────────────────────
// 主動消息 Push 加速這層已經全局下線（設置面板也藏了）。已經開過的用戶
// localStorage 裡 proactive_push_enabled_v1 還是 'true'，光藏 UI 改不了，
// 他們的客戶端會照常心跳、Worker 照常發 wake push。把這裡設成 true 後，
// loadPushConfig() 一律返回 enabled=false：心跳不再啟動、不再向 Worker
// 註冊，Worker 在心跳窗口（默認 5 分鐘）內自動對這些設備停發。
// 注意：只關掉 Worker 加速層，proactiveChat.ts 的本地定時主動消息不受影響。
const FORCE_DISABLED = true;
// ───────────────────────────────────────────────────────────────────

import { loadPushVapid, isPushVapidReady } from './pushVapid';
import { KeepAlive } from './keepAlive';
import {
  SUBSCRIBE_SETTLE_MS,
  bytesToB64u,
  describePushCapabilityGap,
  isDeadPushEndpoint,
  readBrowserPushState,
  subscribeWithRetry,
} from './pushSubscribeShared';

const ENABLED_STORAGE_KEY = 'proactive_push_enabled_v1';
const LAST_WAKE_AT_KEY = 'proactive_push_last_wake_at_v1';
const LAST_WAKE_CHAR_KEY = 'proactive_push_last_wake_char_v1';

export interface ProactivePushConfig {
  enabled: boolean;
  workerUrl: string;
  vapidPublicKey: string;
  clientToken: string;
}

export function loadPushConfig(): ProactivePushConfig {
  let enabled = false;
  // 全局 kill switch：下線後無論 localStorage 裡存的是什麼，一律當關閉處理。
  if (!FORCE_DISABLED) {
    try {
      enabled = localStorage.getItem(ENABLED_STORAGE_KEY) === 'true';
    } catch { /* ignore */ }
  }
  return {
    enabled,
    workerUrl: WORKER_URL.trim().replace(/\/+$/, ''),
    vapidPublicKey: loadPushVapid().vapidPublicKey,
    clientToken: CLIENT_TOKEN.trim(),
  };
}

/** Only the user-controlled enabled flag is persisted. URL/keys come from constants. */
export function savePushConfig(enabled: boolean) {
  try {
    localStorage.setItem(ENABLED_STORAGE_KEY, enabled ? 'true' : 'false');
  } catch { /* ignore */ }
}

/** True if constants are filled AND the user toggle is on. */
export function isPushConfigReady(cfg: ProactivePushConfig = loadPushConfig()): boolean {
  return cfg.enabled
    && cfg.workerUrl.startsWith('https://')
    && isPushVapidReady();
}

/** True if the deployment constants have been filled in (regardless of toggle). */
export function isPushConfigAvailable(): boolean {
  return WORKER_URL.startsWith('https://') && isPushVapidReady();
}

// ---------- Web Push subscription helpers ----------
//
// b64uToBytes / bytesToB64u / isDeadPushEndpoint / explainSubscribeError /
// subscribeWithRetry / SUBSCRIBE_SETTLE_MS 全部從 pushSubscribeShared.ts 取,
// 與主動消息 2.0 共用同一份實現.

interface SubscriptionInfo {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * 舊 API 名 — 調用方 (apps/Settings.tsx 等) 還在引用, 保留為薄包裝.
 * 實現在 pushSubscribeShared.ts 的 isDeadPushEndpoint.
 */
export function isDeadSubscriptionEndpoint(endpoint: string | null | undefined): boolean {
  return isDeadPushEndpoint(endpoint);
}

interface SubscribeAttempt {
  sub: SubscriptionInfo | null;
  reason?: string;
}

export async function getOrCreateSubscription(vapidPublicKey: string): Promise<SubscribeAttempt> {
  const capabilityGap = describePushCapabilityGap();
  if (capabilityGap) {
    return { sub: null, reason: capabilityGap };
  }

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();

  if (sub) {
    // Drop the existing sub if it's been zombified by the browser
    // (`permanently-removed.invalid` endpoint) — those can never deliver.
    if (isDeadPushEndpoint(sub.endpoint)) {
      try { await sub.unsubscribe(); } catch { /* ignore */ }
      // 等瀏覽器清內部 removed 標記, 否則後面 subscribe() 又拿到死哨兵
      await new Promise(r => setTimeout(r, SUBSCRIBE_SETTLE_MS));
      sub = null;
    }
  }

  if (sub) {
    // If an old subscription exists with a different VAPID key, we'd get
    // errors on send — re-subscribe in that case.
    try {
      const existingKey = bytesToB64u(sub.options.applicationServerKey);
      if (existingKey && existingKey !== vapidPublicKey) {
        await sub.unsubscribe();
        await new Promise(r => setTimeout(r, SUBSCRIBE_SETTLE_MS));
        sub = null;
      }
    } catch {
      // Fall through; try to reuse.
    }
  }

  if (!sub) {
    if (Notification.permission === 'default') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return { sub: null, reason: '通知權限未授予' };
    } else if (Notification.permission === 'denied') {
      return { sub: null, reason: '通知權限已被拒絕（請到瀏覽器站點設置裡手動開啟）' };
    }
    const fresh = await subscribeWithRetry(reg, vapidPublicKey, '[ProactivePush]');
    if (!fresh.sub) return { sub: null, reason: fresh.failure?.text };
    sub = fresh.sub;
  }

  const p256dh = bytesToB64u(sub.getKey('p256dh'));
  const auth = bytesToB64u(sub.getKey('auth'));
  if (!p256dh || !auth) return { sub: null, reason: '訂閱缺少加密公鑰（p256dh / auth）' };
  return { sub: { endpoint: sub.endpoint, p256dh, auth } };
}

function buildHeaders(cfg: ProactivePushConfig): HeadersInit {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.clientToken) headers['X-Client-Token'] = cfg.clientToken;
  return headers;
}

/**
 * Register or update a schedule on the Worker.  Returns true on success.
 * Failures are swallowed — the local-timer path still works regardless.
 */
export async function registerScheduleOnWorker(charId: string, intervalMs: number): Promise<boolean> {
  const cfg = loadPushConfig();
  if (!isPushConfigReady(cfg)) return false;

  const { sub } = await getOrCreateSubscription(cfg.vapidPublicKey);
  if (!sub) return false;

  try {
    const res = await fetch(`${cfg.workerUrl}/subscribe`, {
      method: 'POST',
      headers: buildHeaders(cfg),
      body: JSON.stringify({
        subscription: {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        charId,
        intervalMs,
      }),
    });
    return res.ok;
  } catch (e) {
    console.warn('[ProactivePush] /subscribe failed', e);
    return false;
  }
}

export async function unregisterScheduleOnWorker(charId: string): Promise<boolean> {
  const cfg = loadPushConfig();
  if (!isPushConfigReady(cfg)) return false;

  const reg = await navigator.serviceWorker?.ready?.catch(() => null);
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return false;

  try {
    const res = await fetch(`${cfg.workerUrl}/unsubscribe`, {
      method: 'POST',
      headers: buildHeaders(cfg),
      body: JSON.stringify({ endpoint: sub.endpoint, charId }),
    });
    return res.ok;
  } catch (e) {
    console.warn('[ProactivePush] /unsubscribe failed', e);
    return false;
  }
}

async function sendHeartbeat(cfg: ProactivePushConfig): Promise<void> {
  const reg = await navigator.serviceWorker?.ready?.catch(() => null);
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return;

  try {
    await fetch(`${cfg.workerUrl}/heartbeat`, {
      method: 'POST',
      headers: buildHeaders(cfg),
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
  } catch {
    // Heartbeat failures are expected occasionally (offline, Worker restart);
    // the Worker will simply stop firing after the window closes and pick
    // back up when the next successful heartbeat arrives.
  }
}

// ---------- Heartbeat timer (2-min cadence while any schedule is active) ----------

const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let visListener: (() => void) | null = null;

function shouldHeartbeat(): boolean {
  const cfg = loadPushConfig();
  if (!isPushConfigReady(cfg)) return false;
  // Only heartbeat while the tab is visible — the whole point is "app is alive".
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return false;
  return true;
}

async function heartbeatTick() {
  if (!shouldHeartbeat()) return;
  const cfg = loadPushConfig();
  await sendHeartbeat(cfg);
}

export function startHeartbeat() {
  if (heartbeatTimer) return;
  const cfg = loadPushConfig();
  if (!isPushConfigReady(cfg)) return;

  // Fire one immediately so the Worker knows we're alive right now.
  void heartbeatTick();
  heartbeatTimer = setInterval(heartbeatTick, HEARTBEAT_INTERVAL_MS);

  if (typeof document !== 'undefined' && !visListener) {
    visListener = () => {
      if (document.visibilityState === 'visible') void heartbeatTick();
    };
    document.addEventListener('visibilitychange', visListener);
  }
}

export function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (visListener && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', visListener);
    visListener = null;
  }
}

// ---------- Upfront subscribe (decoupled from schedules) ----------

export interface SubscribeResult {
  ok: boolean;
  reason?: string;
  endpoint?: string;
}

/**
 * Request notification permission, build a Push subscription, and POST it to
 * the Worker as a "ping" record (intervalMs = a sentinel large value so cron
 * never fires for it; charId = '__ping__' so it doesn't collide with real
 * character schedules).  After this succeeds the user has a working endpoint
 * in D1 even before any character has proactive-msg enabled, which is what
 * /test needs to verify the round-trip.
 */
export async function ensureSubscribed(): Promise<SubscribeResult> {
  const cfg = loadPushConfig();
  if (!cfg.workerUrl.startsWith('https://')) {
    return { ok: false, reason: 'Worker URL 未配置' };
  }
  if (!isPushVapidReady()) {
    return { ok: false, reason: 'VAPID 公鑰未配置, 請到 Settings → 推送憑據 (VAPID) 生成' };
  }
  const capabilityGap = describePushCapabilityGap();
  if (capabilityGap) {
    return { ok: false, reason: capabilityGap };
  }

  // Request permission first so the popup is tied to the user's click.
  if (Notification.permission === 'default') {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return { ok: false, reason: '通知權限未授予' };
  } else if (Notification.permission === 'denied') {
    return { ok: false, reason: '通知權限已被拒絕（請到瀏覽器站點設置裡手動開啟）' };
  }

  const { sub, reason: subReason } = await getOrCreateSubscription(cfg.vapidPublicKey);
  if (!sub) return { ok: false, reason: subReason || '訂閱創建失敗（未知原因）' };

  // Register a sentinel row so /test can find the endpoint by URL.  We use a
  // very large intervalMs so the cron sweep never picks it up — this row is
  // purely an addressable record of "endpoint X belongs to this device".
  try {
    const NEVER_FIRE_INTERVAL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
    const res = await fetch(`${cfg.workerUrl}/subscribe`, {
      method: 'POST',
      headers: buildHeaders(cfg),
      body: JSON.stringify({
        subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        charId: '__ping__',
        intervalMs: NEVER_FIRE_INTERVAL_MS,
      }),
    });
    if (!res.ok) return { ok: false, reason: `Worker /subscribe 返回 HTTP ${res.status}`, endpoint: sub.endpoint };
  } catch (e: any) {
    return { ok: false, reason: `Worker 連接失敗：${e?.message || '網絡錯誤'}`, endpoint: sub.endpoint };
  }

  return { ok: true, endpoint: sub.endpoint };
}

/** Ask the Worker to fire a one-shot test push at this device's endpoint. */
export async function sendTestPush(): Promise<{ ok: boolean; status?: number; reason?: string; deadSubscription?: boolean }> {
  const cfg = loadPushConfig();
  if (!cfg.workerUrl.startsWith('https://')) return { ok: false, reason: 'Worker URL 未配置' };

  const reg = await navigator.serviceWorker?.ready?.catch(() => null);
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return { ok: false, reason: '本設備沒有現有訂閱，請先點"開啟系統通知"' };

  // Browser-side zombie-endpoint guard — bail before bothering the Worker.
  // Otherwise Worker will fetch permanently-removed.invalid → 530 from CF.
  if (isDeadSubscriptionEndpoint(sub.endpoint)) {
    return {
      ok: false,
      deadSubscription: true,
      reason: '訂閱已被瀏覽器吊銷（permanently-removed.invalid），點"重置訂閱"重建一次',
    };
  }

  try {
    const res = await fetch(`${cfg.workerUrl}/test`, {
      method: 'POST',
      headers: buildHeaders(cfg),
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    const data = await res.json().catch(() => ({})) as any;
    if (!res.ok) return { ok: false, status: res.status, reason: data?.error || data?.reason || `HTTP ${res.status}` };
    if (!data?.ok) return { ok: false, status: data?.status, reason: data?.reason || data?.error || '推送失敗' };
    return { ok: true, status: data?.status };
  } catch (e: any) {
    return { ok: false, reason: e?.message || '網絡錯誤' };
  }
}

/**
 * Tear the local subscription down and rebuild it from scratch.  Used by the
 * diagnostic panel's "重置訂閱" button to recover from
 * `permanently-removed.invalid` zombies, scope changes, or a stuck VAPID-key
 * mismatch.  Also tells the Worker to forget the dead row so /test won't
 * keep finding it.
 */
export async function resetSubscription(): Promise<{ ok: boolean; reason?: string; endpoint?: string }> {
  const cfg = loadPushConfig();
  if (!cfg.workerUrl.startsWith('https://')) {
    return { ok: false, reason: 'Worker URL 未配置' };
  }
  if (!isPushVapidReady()) {
    return { ok: false, reason: 'VAPID 公鑰未配置, 請到 Settings → 推送憑據 (VAPID) 生成' };
  }
  const capabilityGap = describePushCapabilityGap();
  if (capabilityGap) {
    return { ok: false, reason: capabilityGap };
  }

  const reg = await navigator.serviceWorker?.ready?.catch(() => null);
  const oldSub = reg ? await reg.pushManager.getSubscription() : null;
  const oldEndpoint = oldSub?.endpoint;

  // Tell Worker to drop the row first so /test won't keep returning the
  // dead endpoint.  Best-effort — failures here are non-fatal.
  if (oldEndpoint) {
    try {
      await fetch(`${cfg.workerUrl}/unsubscribe`, {
        method: 'POST',
        headers: buildHeaders(cfg),
        body: JSON.stringify({ endpoint: oldEndpoint }),
      });
    } catch { /* ignore */ }
  }

  if (oldSub) {
    try { await oldSub.unsubscribe(); } catch { /* ignore */ }
    // 等瀏覽器清內部 PushMessagingAppIdentifier removed 標記; 不等的話緊接
    // 著的 subscribe() 大概率又拿到 zombie sentinel, 進入 subscribeWithRetry
    // 的重試鏈路也會多走一輪.
    await new Promise(r => setTimeout(r, SUBSCRIBE_SETTLE_MS));
  }

  // ensureSubscribed will re-create from clean slate (permission, fresh
  // PushSubscription, fresh D1 row).
  return ensureSubscribed();
}

/**
 * 升級版重置: resetSubscription 的 subscribeWithRetry 全跑完仍拿到 zombie 時
 * (Chromium 內部 PushMessagingAppIdentifier 被鎖死在 MarkedForRemoval 狀態,
 * pushManager.unsubscribe 清不掉這個標記), 唯一可編程的逃離路徑是 unregister
 * Service Worker 再 register 一遍 — 新 SW 拿到新的 sw_registration_id, 綁死
 * 在舊 id 上的壞 PushMessagingAppIdentifier 自然失效.
 *
 * 副作用:
 *  - SW 短暫下線 (< 1s), 期間收到的 push 會真丟. 但深度重置本來就是"已經
 *    收不到 push"才點的, 不存在"原本能收的現在丟了".
 *  - SW 內的 proactive setInterval 全清. 調用方 (Settings.tsx 的 "深度重置"
 *    handler) 必須在 deepResetSubscription resolve 後調一次
 *    `ProactiveChat.resume()` 把 schedule 推回新 SW, 否則主動消息悄悄不響.
 *  - KeepAlive 計數器清零. 跟"正在長 fetch"撞同一時刻概率近零, 不補救.
 */
export async function deepResetSubscription(): Promise<{ ok: boolean; reason?: string; endpoint?: string }> {
  const cfg = loadPushConfig();
  if (!cfg.workerUrl.startsWith('https://')) {
    return { ok: false, reason: 'Worker URL 未配置' };
  }
  if (!isPushVapidReady()) {
    return { ok: false, reason: 'VAPID 公鑰未配置, 請到 Settings → 推送憑據 (VAPID) 生成' };
  }
  const capabilityGap = describePushCapabilityGap();
  if (capabilityGap) {
    return { ok: false, reason: capabilityGap };
  }

  // 1) 拿現有 sub 的 endpoint, 通知 Worker 刪 D1 行 (best-effort)
  let oldEndpoint: string | undefined;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) {
      const sub = await reg.pushManager.getSubscription();
      oldEndpoint = sub?.endpoint;
      if (oldEndpoint) {
        try {
          await fetch(`${cfg.workerUrl}/unsubscribe`, {
            method: 'POST',
            headers: buildHeaders(cfg),
            body: JSON.stringify({ endpoint: oldEndpoint }),
          });
        } catch { /* ignore */ }
      }
      // 2) 本地 unsubscribe (拿不掉 MarkedForRemoval 標記, 但走完流程)
      if (sub) {
        try { await sub.unsubscribe(); } catch { /* ignore */ }
      }
    }
  } catch { /* 拿不到 reg 也繼續; SW unregister 才是關鍵 */ }

  // 3) Unregister 全部 SW registration — 關鍵步驟
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map(r => r.unregister().catch(() => false)));
  } catch (e) {
    console.warn('[ProactivePush] SW unregister failed', e);
  }

  // 4) 經 KeepAlive 走應用 boot 路徑重 register — 同 scriptUrl + scope
  try {
    await KeepAlive.reregister();
  } catch (e: any) {
    return { ok: false, reason: `Service Worker 重新註冊失敗: ${e?.message || e}` };
  }

  // 5) 再保險等一次 ready (KeepAlive 內已 await 過, 這裡防 race)
  try {
    await navigator.serviceWorker.ready;
  } catch (e: any) {
    return { ok: false, reason: `Service Worker ready 失敗: ${e?.message || e}` };
  }

  // 6) 等 controller 切換 — 否則後續 postToSW (proactive sync) 會被 swallow.
  //    新 SW activate 時已 clients.claim(), controllerchange 應該很快; 5s 兜底.
  await new Promise<void>((resolve) => {
    if (navigator.serviceWorker.controller) {
      resolve();
      return;
    }
    const onChange = () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onChange);
      resolve();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onChange);
    setTimeout(() => {
      navigator.serviceWorker.removeEventListener('controllerchange', onChange);
      resolve();
    }, 5000);
  });

  // 7) Fresh subscribe + POST /subscribe — 走 ensureSubscribed 全流程
  return ensureSubscribed();
}

// ---------- Diagnostic info ----------

export interface PushDiagnostics {
  /** Web Push 三件套齊不齊：Service Worker / Push API / Notification */
  supported: boolean;
  /** Notification.permission (or 'unavailable' if API missing) */
  permission: 'default' | 'granted' | 'denied' | 'unavailable';
  /** SW registration scope, or null if not registered */
  swScope: string | null;
  /** SW state: 'activated' | 'installing' | 'waiting' | 'redundant' | 'none' */
  swState: string;
  /** Current Push subscription endpoint, or null */
  endpoint: string | null;
  /** True if endpoint is a `permanently-removed.invalid` zombie sentinel */
  endpointDead: boolean;
  /** Friendly name of the push channel (FCM/Mozilla/Windows/Apple/...) */
  channel: string;
  /** True if the deployment constants are in place */
  workerConfigured: boolean;
  /** True if the user-facing toggle is on */
  enabled: boolean;
  /** ms since epoch of the last wake we received, or null */
  lastWakeAt: number | null;
  /** charId of the last wake, or null */
  lastWakeChar: string | null;
  /** True if we are inside an iOS Safari that is NOT a standalone PWA */
  iosNeedsPwa: boolean;
  /** True if we are running inside a Capacitor native app (Android/iOS WebView) */
  capacitorNative: boolean;
}

export async function getPushDiagnostics(): Promise<PushDiagnostics> {
  const cfg = loadPushConfig();
  // 瀏覽器那一半（支持/權限/SW/端點/廠商/平台）讀共用的 readBrowserPushState，
  // 這裡只補 proactive-push 自己的三樣：worker 配沒配、開關開沒開、上次喚醒。
  const browser = await readBrowserPushState();

  let lastWakeAt: number | null = null;
  let lastWakeChar: string | null = null;
  try {
    const v = localStorage.getItem(LAST_WAKE_AT_KEY);
    if (v) lastWakeAt = parseInt(v, 10) || null;
    lastWakeChar = localStorage.getItem(LAST_WAKE_CHAR_KEY);
  } catch { /* ignore */ }

  return {
    supported: browser.supported,
    permission: browser.permission === 'unavailable' ? 'unavailable' : browser.permission,
    swScope: browser.swScope,
    swState: browser.swState,
    endpoint: browser.endpoint,
    endpointDead: browser.endpointDead,
    channel: browser.channel,
    workerConfigured: cfg.workerUrl.startsWith('https://') && isPushVapidReady(),
    enabled: cfg.enabled,
    lastWakeAt,
    lastWakeChar,
    iosNeedsPwa: browser.iosNeedsPwa,
    capacitorNative: browser.capacitorNative,
  };
}

// ---------- Last-wake tracking via SW postMessage ----------

let wakeListenerInstalled = false;

/** Install a one-time global listener that records every wake the SW reports. */
export function installWakeListener() {
  if (wakeListenerInstalled) return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  wakeListenerInstalled = true;
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data: any = event.data;
    if (!data || data.type !== 'proactive-wake-received') return;
    try {
      if (data.t) localStorage.setItem(LAST_WAKE_AT_KEY, String(data.t));
      if (data.charId) localStorage.setItem(LAST_WAKE_CHAR_KEY, String(data.charId));
    } catch { /* ignore */ }
  });
}
