
import React from 'react';
import { OSProvider } from './context/OSContext';
import { MusicProvider } from './context/MusicContext';
import PhoneShell from './components/PhoneShell';
import BuildBadge from './components/BuildBadge';
import DevDebugPanel from './components/DevDebugPanel';
import Amsg2DebugPanel from './components/Amsg2DebugPanel';
import VRBroadcast from './components/VRBroadcast';
import WorldBroadcast from './components/WorldBroadcast';
import ChatBroadcast from './components/ChatBroadcast';
import { isIOSStandaloneWebApp } from './utils/iosStandalone';
import { installDevDebugLifecycleCapture } from './utils/devDebug';

const App: React.FC = () => {
  React.useEffect(() => {
    // 常駐監聽前後台 / 焦點 / 網絡事件；抓不抓由 devDebug 的 lifecycle 類勾選決定
    installDevDebugLifecycleCapture();
  }, []);

  const useAbsoluteShell = typeof window !== 'undefined' && isIOSStandaloneWebApp();
  const shellClassName = useAbsoluteShell
    ? 'fixed inset-0 w-full h-full bg-transparent overflow-hidden'
    : 'relative w-full bg-transparent overflow-hidden';
  const shellStyle = useAbsoluteShell
    ? { height: 'var(--app-height, 100lvh)', minHeight: 'var(--app-height, 100lvh)' }
    : { height: 'var(--app-height, 100lvh)', minHeight: 'var(--app-height, 100lvh)' };

  return (
    <>
      <div
        className={shellClassName}
        style={shellStyle}
      >
        <div
          className={`${useAbsoluteShell ? 'absolute' : 'fixed'} inset-0 w-full h-full z-0 bg-transparent`}
          style={{ transform: 'translateZ(0)' }}
        >
          <OSProvider>
            <MusicProvider>
              <PhoneShell />
            </MusicProvider>
            {/* 掛在 Provider 裡面才能直接讀 characters（省掉輪詢 IndexedDB），
                面板自身用 portal 渲染到 body，繞開上面那層 transform 對 fixed 定位的影響。 */}
            <Amsg2DebugPanel />
          </OSProvider>
        </div>
      </div>
      <BuildBadge />
      <DevDebugPanel />
      <VRBroadcast />
      <WorldBroadcast />
      <ChatBroadcast />
    </>
  );
};

export default App;
