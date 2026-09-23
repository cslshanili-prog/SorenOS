import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installTranslateCrashGuard } from './utils/translateCrashGuard';
import { ActiveMsgRuntime } from './utils/activeMsgRuntime';
import { KeepAlive } from './utils/keepAlive';
import { ProactiveChat } from './utils/proactiveChat';
import { VRScheduler } from './utils/vrWorld/scheduler';
import { installIOSStandaloneWorkaround } from './utils/iosStandalone';
import { installWakeListener } from './utils/proactivePushConfig';
import { initAnalytics } from './utils/analytics';
import { Capacitor } from '@capacitor/core';

// 默認構建不開啟時 Rollup 會整段裁掉；普通瀏覽器/PWA 不加載原生插件、不申請權限。
if (import.meta.env.VITE_AMSG_NATIVE_PUSH === 'true' && Capacitor.isNativePlatform()) {
  if (Capacitor.getPlatform() === 'android') {
    void import('./utils/unifiedPushRuntime').then(({ initUnifiedPushRuntime }) => initUnifiedPushRuntime());
  } else {
    void import('./utils/nativeAmsgPush').then(({ initNativeAmsgPush }) => initNativeAmsgPush());
  }
}

// Register the keep-alive Service Worker early so it's ready before any AI calls
KeepAlive.init().then(() => {
  // Resume any active proactive schedule after SW is ready
  ProactiveChat.resume();
  // Resume 「彼方」 autonomous-login schedules
  VRScheduler.resume();
  void ActiveMsgRuntime.init();
  // Record every wake the SW reports so the diagnostic panel can show "last received".
  installWakeListener();
});

installIOSStandaloneWorkaround();

// 使用統計。構建時沒配 VITE_UMAMI_* 就整個不生效，自部署實例默認如此。
// 用戶關掉開關、或瀏覽器開了 DNT，同樣在這裡就返回，連腳本都不會掛上去。
initAnalytics();

// 瀏覽器自動翻譯 (Chrome/Edge 等) 會改動 React 託管的 DOM，導致 reconcile 時
// insertBefore/removeChild 拋 NotFoundError 白屏。掛載前先打護欄。詳見該 util 註釋。
installTranslateCrashGuard();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
