/**
 * Service Worker → 頁面這條通道的體檢。
 *
 * 主動消息有兩條腿：推送到達時 SW 立刻喊頁面（實時），以及頁面自己隔幾秒數一眼本地
 * 收件箱（守望，見 activeMsgRuntime 的 sweepLocalInbox）。前者斷了之後功能表面上還是
 * 好的——消息照樣會到，只是慢那麼幾秒，用戶多半會當成「網絡有點卡」而不會來報，
 * 於是它可以壞很久沒人發現。iOS 上它幾乎必然是斷的：App 不在最前台時，SW 拿到的
 * 「當前有哪些頁面」名單直接是空的。
 *
 * 這裡做兩件事：把「頁面和 SW 是什麼關係」拍個快照，以及**用推送真正走的那條路**
 * 探一次通不通。兩者都只讀、不改任何狀態。
 */

/** 頁面與 Service Worker 的註冊關係。字段都取自瀏覽器，取不到就留空。 */
export interface SwRegistrationSnapshot {
  /** 這個環境有沒有 Service Worker（隱私模式 / 老瀏覽器可能沒有）。 */
  supported: boolean;
  /**
   * 頁面**受不受**當前 SW 控制。
   * 為 false 時 SW 仍可能通過 includeUncontrolled 找到頁面，所以它不等於「一定收不到」，
   * 但配合探測結果一起看就能說明問題。
   */
  controlled: boolean;
  /** SW 的作用域，和頁面路徑對不上的話 SW 根本管不到這個頁面。 */
  scope?: string;
  /** 頁面自己的路徑（不帶查詢串和 hash，那上面可能有不該進日誌的東西）。 */
  pagePath?: string;
  /** 三種狀態各自的 state，用來看是不是卡在等待激活。 */
  activeState?: string;
  waitingState?: string;
  installingState?: string;
  /** 已激活 SW 的腳本路徑，用來確認跑的是不是當前這份。 */
  activeScriptPath?: string;
  /** 裝成 PWA 獨立窗口打開的（iOS 上這種殼的行為跟瀏覽器標籤頁不一樣）。 */
  standalone?: boolean;
}

/** 一次通道探測的結果。兩條路分別記，為的是把「SW 沒在跑」和「SW 找不到頁面」分開。 */
export interface SwChannelProbeResult {
  /** 頁面遞了回信地址的那條路（MessageChannel）。它通 = SW 在跑、收得到頁面的消息。 */
  portAck: boolean;
  portMs?: number;
  /**
   * SW 自己把頁面找出來的那條路（clients.matchAll + postMessage）。
   * **推送通知頁面走的就是它**，所以只有這條的結果能代表真實鏈路。
   */
  clientsAck: boolean;
  clientsMs?: number;
  /** 等了多久放棄。 */
  waitedMs: number;
}

/** 從已有記錄看這條通道最近的狀態。 */
export interface SwChannelHealth {
  /**
   * - 'ok'：最近確實收到過 SW 喊的消息，實時這條腿是活的
   * - 'fallback-only'：有沖刷發生過，但沒有一次是 SW 喊的——全靠守望和補收在撈
   * - 'idle'：這段記錄里根本沒有沖刷，無從判斷（剛裝好、或一直沒收到消息）
   */
  status: 'ok' | 'fallback-only' | 'idle';
  /** 最近一次收到 SW 消息的時刻（ISO），從來沒有就是 undefined。 */
  lastSwMessageAt?: string;
  /** 各觸發源分別沖刷了幾次，按次數從多到少。 */
  flushByTrigger: Array<{ trigger: string; count: number }>;
}

/**
 * 判斷實時通道還活著沒有。
 *
 * 判據是「有沒有過 SW 喊頁面這件事」，而不是「消息到沒到」——消息最終總會到（兜底
 * 輪詢在撈），所以拿它當判據永遠看不出問題。反過來，一段時間裡沖刷全由兜底觸發，
 * 就說明實時那條腿斷了：功能看著正常，只是每條消息都白等最多一分鐘。
 */
export const summarizeChannelHealth = (
  entries: Array<{ event?: string; ts?: string; trigger?: unknown }>,
): SwChannelHealth => {
  const counts = new Map<string, number>();
  let lastSwMessageAt: string | undefined;

  for (const entry of entries) {
    if (entry.event === 'runtime-sw-message') {
      // 記錄不保證有序，取時間戳最大的那條。
      if (!lastSwMessageAt || String(entry.ts ?? '') > lastSwMessageAt) {
        lastSwMessageAt = entry.ts;
      }
    }
    if (entry.event === 'runtime-flush-start' && typeof entry.trigger === 'string') {
      counts.set(entry.trigger, (counts.get(entry.trigger) ?? 0) + 1);
    }
  }

  const flushByTrigger = [...counts.entries()]
    .map(([trigger, count]) => ({ trigger, count }))
    .sort((a, b) => b.count - a.count);

  const status: SwChannelHealth['status'] = lastSwMessageAt
    ? 'ok'
    : (flushByTrigger.length > 0 ? 'fallback-only' : 'idle');

  return { status, lastSwMessageAt, flushByTrigger };
};

/** 只留路徑：查詢串和 hash 上可能掛著不該進日誌的東西。 */
const pathOf = (url: string): string => {
  try {
    return new URL(url, location.href).pathname;
  } catch {
    return '?';
  }
};

export const captureSwRegistrationSnapshot = async (): Promise<SwRegistrationSnapshot> => {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return { supported: false, controlled: false };
  }

  const snapshot: SwRegistrationSnapshot = {
    supported: true,
    controlled: !!navigator.serviceWorker.controller,
    pagePath: typeof location !== 'undefined' ? pathOf(location.href) : undefined,
  };

  try {
    snapshot.standalone = typeof window !== 'undefined'
      && (window.matchMedia?.('(display-mode: standalone)').matches
        || (window.navigator as any)?.standalone === true);
  } catch { /* 拿不到就不記 */ }

  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration) {
      snapshot.scope = pathOf(registration.scope);
      snapshot.activeState = registration.active?.state;
      snapshot.waitingState = registration.waiting?.state;
      snapshot.installingState = registration.installing?.state;
      if (registration.active?.scriptURL) {
        snapshot.activeScriptPath = pathOf(registration.active.scriptURL);
      }
    }
  } catch { /* 取不到註冊信息就只回上面那幾項 */ }

  return snapshot;
};

/**
 * 探一次 SW 能不能喊到這個頁面。
 *
 * 發一條帶隨機串的探測給 SW，SW 會**分別**用兩條路回信；這裡等到兩條都回來、
 * 或者等夠 waitMs 為止。之所以要等而不是發完就走：沒回信才是要抓的現象，
 * 而「沒回信」只能靠等出來。
 *
 * 探測本身不改任何狀態，失敗也只是返回一份「都沒通」的結果。
 */
export const probeSwChannel = async (waitMs = 3_000): Promise<SwChannelProbeResult> => {
  const result: SwChannelProbeResult = { portAck: false, clientsAck: false, waitedMs: waitMs };

  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return result;

  let target: ServiceWorker | null = null;
  try {
    target = navigator.serviceWorker.controller
      || (await navigator.serviceWorker.getRegistration())?.active
      || null;
  } catch { /* 下面按拿不到處理 */ }
  if (!target) return result;

  const nonce = `probe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();

  return await new Promise<SwChannelProbeResult>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      result.waitedMs = Date.now() - startedAt;
      try { navigator.serviceWorker.removeEventListener('message', onClientsMessage); } catch { /* ignore */ }
      clearTimeout(timer);
      resolve(result);
    };

    // clients 這條路的回信會走頁面全局的 SW message 事件——跟真實推送落到同一個入口。
    const onClientsMessage = (event: MessageEvent) => {
      if (event.data?.type !== 'sw-channel-probe-ack' || event.data?.nonce !== nonce) return;
      result.clientsAck = true;
      result.clientsMs = Date.now() - startedAt;
      if (result.portAck) finish();
    };

    try {
      navigator.serviceWorker.addEventListener('message', onClientsMessage);
    } catch { /* 加不上監聽就只能靠超時收尾 */ }

    const timer = setTimeout(finish, waitMs);

    try {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event: MessageEvent) => {
        if (event.data?.type !== 'sw-channel-probe-port-ack' || event.data?.nonce !== nonce) return;
        result.portAck = true;
        result.portMs = Date.now() - startedAt;
        if (result.clientsAck) finish();
      };
      target.postMessage({ type: 'SW_CHANNEL_PROBE', nonce }, [channel.port2]);
    } catch {
      // 連消息都發不出去：兩條路都算不通，不用乾等滿。
      finish();
    }
  });
};
