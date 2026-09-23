import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

export interface UnifiedPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  distributor: string;
  temporary: boolean;
  vapidPublicKey: string;
}

export interface UnifiedPushStatus {
  native: boolean;
  distributors: string[];
  distributor: string | null;
  subscription: UnifiedPushSubscription | null;
  lastError: string | null;
  permission: 'granted' | 'denied' | 'prompt';
}

export interface UnifiedPushStoredMessage {
  payload: string;
  receivedAt: number;
}

interface UnifiedPushNativePlugin {
  getStatus(): Promise<Omit<UnifiedPushStatus, 'permission'>>;
  register(options: { vapidPublicKey: string }): Promise<{ pending: boolean }>;
  unregister(): Promise<void>;
  drainPendingPushes(): Promise<{ messages: UnifiedPushStoredMessage[]; launchPayload?: string }>;
  addListener(
    eventName: 'pushReceived' | 'notificationTapped' | 'registrationChanged',
    listener: (event: any) => void,
  ): Promise<PluginListenerHandle>;
}

const NativeUnifiedPush = registerPlugin<UnifiedPushNativePlugin>('AmsgUnifiedPush');

export const isUnifiedPushPlatform = (): boolean =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

const readPermission = async (): Promise<UnifiedPushStatus['permission']> => {
  const result = await LocalNotifications.checkPermissions();
  if (result.display === 'granted') return 'granted';
  if (result.display === 'denied') return 'denied';
  return 'prompt';
};

export const getUnifiedPushStatus = async (): Promise<UnifiedPushStatus> => {
  if (!isUnifiedPushPlatform()) {
    return {
      native: false,
      distributors: [],
      distributor: null,
      subscription: null,
      lastError: null,
      permission: 'denied',
    };
  }

  const [status, permission] = await Promise.all([
    NativeUnifiedPush.getStatus(),
    readPermission(),
  ]);
  return { ...status, permission };
};

const requireNotificationPermission = async (): Promise<void> => {
  const current = await LocalNotifications.checkPermissions();
  const result = current.display === 'prompt'
    ? await LocalNotifications.requestPermissions()
    : current;
  if (result.display !== 'granted') {
    throw new Error('通知權限未授予，UnifiedPush 收到消息後無法顯示系統通知。');
  }
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 獲取一條標準 Web Push 訂閱，可直接交給 AMSG Worker。 */
export const ensureUnifiedPushSubscription = async (
  vapidPublicKey: string,
): Promise<{ endpoint: string; keys: { p256dh: string; auth: string } }> => {
  if (!isUnifiedPushPlatform()) throw new Error('UnifiedPush 僅用於 Android 原生 App。');
  await requireNotificationPermission();

  const before = await NativeUnifiedPush.getStatus();
  if (!before.distributor && before.distributors.length === 0) {
    throw new Error('沒有檢測到 UnifiedPush 服務。請先安裝並打開 ntfy 的無 Firebase 版本，允許它後台運行後再試。');
  }

  await NativeUnifiedPush.register({ vapidPublicKey });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const status = await NativeUnifiedPush.getStatus();
    const subscription = status.subscription;
    if (
      subscription?.endpoint
      && subscription.keys?.p256dh
      && subscription.keys?.auth
      && subscription.vapidPublicKey === vapidPublicKey
    ) {
      return { endpoint: subscription.endpoint, keys: subscription.keys };
    }
    if (status.lastError) throw new Error(`UnifiedPush 註冊失敗：${status.lastError}`);
    await delay(250);
  }

  throw new Error('UnifiedPush 註冊超時。請確認 ntfy 已打開並允許它在後台運行。');
};

export const readUnifiedPushSubscription = async () =>
  (await getUnifiedPushStatus()).subscription;

export const drainUnifiedPushMessages = () => NativeUnifiedPush.drainPendingPushes();

export const addUnifiedPushListener = (
  eventName: 'pushReceived' | 'notificationTapped' | 'registrationChanged',
  listener: (event: any) => void,
) => NativeUnifiedPush.addListener(eventName, listener);
