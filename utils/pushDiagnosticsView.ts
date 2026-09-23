/**
 * 設置頁「推送訂閱狀態」面板的文案層：把 BrowserPushState 這份讀數翻譯成用戶能看懂
 * 的一行行字。純函數、不碰 DOM，好讓判定邏輯能被單測釘住——面板本身是 .tsx，跑不進
 * 這個倉庫的 node 測試環境。
 */

import type { BrowserPushState, SubscribeFailureKind } from './pushSubscribeShared';

/** 這幾類失敗換多少次重試都是同一個結果，問題在設備/瀏覽器本身。 */
const DEVICE_LEVEL_FAILURES: SubscribeFailureKind[] = ['channel-unreachable', 'no-subscription', 'unsupported'];

/**
 * 失敗記錄還算不算數：手上已經有一條活訂閱，說明後來建成了，舊記錄留著只會誤導。
 * subscribeWithRetry 成功時本來就會清盤，這裡是防守——萬一訂閱是別的路徑建起來的
 * （換了瀏覽器、SW 自愈重訂），記錄不會被清，但它顯然已經過期了。
 */
export const hasLiveFailure = (state: BrowserPushState): boolean =>
  Boolean(state.lastSubscribeFailure) && (!state.endpoint || state.endpointDead);

/** 當前生效的失敗分類，沒有（或已過期）是 null。 */
export const liveFailureKind = (state: BrowserPushState): SubscribeFailureKind | null =>
  hasLiveFailure(state) ? state.lastSubscribeFailure!.kind : null;

export const describePermission = (permission: BrowserPushState['permission']): string => {
  if (permission === 'granted') return '已授權';
  if (permission === 'denied') return '已拒絕（要去瀏覽器的站點設置裡手動打開）';
  if (permission === 'default') return '還沒決定';
  return '不可用';
};

export const describeServiceWorker = (state: BrowserPushState): string => {
  if (state.swState === 'none') return '未註冊';
  const scope = state.swScope || '?';
  return state.swState === 'activated' ? `已激活（scope: ${scope}）` : `${state.swState}（scope: ${scope}）`;
};

export const describeSubscription = (state: BrowserPushState): string => {
  if (!state.endpoint) return '不存在';
  return state.endpointDead ? '已被瀏覽器吊銷' : '已建立';
};

/**
 * 「瀏覽器支持」這一行。
 *
 * 這行以前只答「接口齊不齊」，於是沒裝谷歌服務的國行安卓機上會顯示「是」——接口確實
 * 齊（Chromium 把 PushManager 編譯進去了），但底下根本沒有推送通道，用戶看到的就是
 * 「支持=是、權限=已授權、SW=已激活，訂閱就是建不出來」，完全無從下手。能力檢測查不
 * 出這種情況（查的是 JS 接口在不在），實際試過一次才知道，所以這裡把訂閱失敗的結論
 * 也算進來。
 */
export const describeSupport = (state: BrowserPushState): string => {
  if (state.capacitorNative) return '否（現在跑在 App 裡）';
  if (!state.supported) return '否（瀏覽器缺少推送相關接口）';
  const failure = liveFailureKind(state);
  if (failure === 'channel-unreachable') return '接口齊全，但連不上推送服務器';
  if (failure === 'no-subscription') return '接口齊全，但沒拿到訂閱';
  if (failure === 'unsupported') return '否（瀏覽器自稱支持，實際建不出訂閱）';
  return '是';
};

/** 「瀏覽器支持」這行要不要標紅。 */
export const isSupportBad = (state: BrowserPushState): boolean => {
  if (!state.supported || state.capacitorNative) return true;
  const failure = liveFailureKind(state);
  return failure !== null && DEVICE_LEVEL_FAILURES.includes(failure);
};

/** 「3 分鐘前」這種。剛發生的失敗和上週留下的記錄，排查價值差很遠。 */
export const describeElapsed = (at: number, now: number = Date.now()): string => {
  if (!at) return '';
  const minutes = Math.floor((now - at) / 60000);
  if (minutes < 1) return '剛剛';
  if (minutes < 60) return `${minutes} 分鐘前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小時前`;
  return `${Math.floor(hours / 24)} 天前`;
};
