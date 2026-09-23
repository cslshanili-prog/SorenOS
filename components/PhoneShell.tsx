import FirstUseGuide from './FirstUseGuide';
import { useFirstUseGuideStep } from '../utils/firstUseGuide';
import AnniversaryGiftPopup from './os/AnniversaryGiftPopup';
import { shouldShowAnniversaryGift, markAnniversaryGiftSeen } from '../utils/anniversaryGifts';



import React, { useState, useEffect, useMemo, useRef, Suspense } from 'react';
import { IMPORT_IN_PROGRESS_KEY, useOS } from '../context/OSContext';
import StatusBar from './os/StatusBar';
import { SARModuleMonitor } from './sar/SARModuleMonitor';
import Launcher from '../apps/Launcher';
import CompanionLockChrome from './os/CompanionLockChrome';
import { loadCompanionFrameStyle } from './os/companionFrameStyles';
import { createPreloadableLazy, type PreloadableLazy } from './os/preloadableLazy';

// 按需懶加載各 App —— 切到對應 App 時才下載/解析其代碼塊，首屏只加載 Launcher 與外殼，
// 大體積 App（MemoryPalace / VRWorld / Songwriting 等）不再壓在主包裡。
// 默認導出直接 lazy；命名導出（SpecialMomentsApp）用 .then 適配成 { default }。
// Launcher 保持靜態導入：桌面常駐、需要秒開，不走懶加載。
//
// App 在用戶打開/按下圖標時立即加載；性能與網絡條件合適時，桌面穩定後也會低優先級串行預熱。
// 絕不能在冷啟動階段併發掃完整個列表：低端設備會同時下載、解壓和解析幾十個 chunk，
// 反而拖死用戶此刻真正要打開的那個 App。
const lazyApp = createPreloadableLazy;

const Settings = lazyApp(() => import('../apps/Settings'));
const Character = lazyApp(() => import('../apps/Character'));
const Chat = lazyApp(() => import('../apps/Chat'));
const ChatHub = lazyApp(() => import('../apps/ChatHub'));
const GroupChat = lazyApp(() => import('../apps/GroupChat'));
const ThemeMaker = lazyApp(() => import('../apps/ThemeMaker'));
const Appearance = lazyApp(() => import('../apps/Appearance'));
const Gallery = lazyApp(() => import('../apps/Gallery'));
const DateApp = lazyApp(() => import('../apps/DateApp'));
const UserApp = lazyApp(() => import('../apps/UserApp'));
const JournalApp = lazyApp(() => import('../apps/JournalApp'));
const ScheduleApp = lazyApp(() => import('../apps/ScheduleApp'));
const RoomApp = lazyApp(() => import('../apps/RoomApp'));
const CheckPhone = lazyApp(() => import('../apps/CheckPhone'));
const SocialApp = lazyApp(() => import('../apps/SocialApp'));
const StudyApp = lazyApp(() => import('../apps/StudyApp'));
const FAQApp = lazyApp(() => import('../apps/FAQApp'));
const GameApp = lazyApp(() => import('../apps/GameApp'));
const WorldbookApp = lazyApp(() => import('../apps/WorldbookApp'));
const NovelApp = lazyApp(() => import('../apps/NovelApp'));
const BankApp = lazyApp(() => import('../apps/BankApp'));
const XhsStockApp = lazyApp(() => import('../apps/XhsStockApp'));
const XhsFreeRoamApp = lazyApp(() => import('../apps/XhsFreeRoamApp'));
const BrowserApp = lazyApp(() => import('../apps/BrowserApp'));
const SongwritingApp = lazyApp(() => import('../apps/SongwritingApp'));
const MusicApp = lazyApp(() => import('../apps/MusicApp'));
const CallApp = lazyApp(() => import('../apps/CallApp'));
const VoiceDesignerApp = lazyApp(() => import('../apps/VoiceDesignerApp'));
const GuidebookApp = lazyApp(() => import('../apps/GuidebookApp'));
const LifeSimApp = lazyApp(() => import('../apps/LifeSimApp'));
const MemoryPalaceApp = lazyApp(() => import('../apps/MemoryPalaceApp'));
const HandbookApp = lazyApp(() => import('../apps/HandbookApp'));
const QQBridge = lazyApp(() => import('../apps/QQBridge'));
const HotNewsApp = lazyApp(() => import('../apps/HotNewsApp'));
const VRWorldApp = lazyApp(() => import('../apps/VRWorldApp'));
const WorldHomeApp = lazyApp(() => import('../apps/WorldHomeApp'));
const CharCreatorDevApp = lazyApp(() => import('../apps/CharCreatorDevApp'));
const SpecialMomentsApp = lazyApp(() => import('./ValentineEvent').then(m => ({ default: m.SpecialMomentsApp })));

// 僅供「桌面穩定後的空閒串行預熱」。嚴格 await 前一個再取下一個，且任何用戶操作都會停止隊列。
// 高頻 App 在前；低端設備/省流量/2G 由 shouldUseIdleAppPreload 整體跳過。
const APP_IDLE_PRELOAD_ORDER: PreloadableLazy[] = [
  ChatHub, Chat, Character, Settings, Appearance, GroupChat, RoomApp, CheckPhone,
  JournalApp, ScheduleApp, SocialApp, MusicApp, CallApp, Gallery, DateApp, UserApp,
  StudyApp, GameApp, NovelApp, BankApp, WorldbookApp, MemoryPalaceApp, HandbookApp,
  VRWorldApp, WorldHomeApp, LifeSimApp, SongwritingApp, GuidebookApp, FAQApp, HotNewsApp,
  XhsStockApp, XhsFreeRoamApp, BrowserApp, VoiceDesignerApp, ThemeMaker, QQBridge,
  SpecialMomentsApp, CharCreatorDevApp,
];

const IDLE_PRELOAD_START_MS = 600;
const IDLE_PRELOAD_GAP_MS = 250;
let idlePreloadCursor = 0;

// AppID → 懶加載組件，供「按下即預取」複用同一個模塊 Promise。
// AppID 由下方 import 引入，ES 模塊提升後全模塊可用。
const APP_BY_ID: Partial<Record<AppID, PreloadableLazy>> = {
  [AppID.Settings]: Settings, [AppID.Character]: Character, [AppID.Chat]: Chat, [AppID.ChatHub]: ChatHub,
  [AppID.GroupChat]: GroupChat, [AppID.ThemeMaker]: ThemeMaker, [AppID.Appearance]: Appearance,
  [AppID.Gallery]: Gallery, [AppID.Date]: DateApp, [AppID.User]: UserApp,
  [AppID.Journal]: JournalApp, [AppID.Schedule]: ScheduleApp, [AppID.Room]: RoomApp,
  [AppID.CheckPhone]: CheckPhone, [AppID.Social]: SocialApp, [AppID.Study]: StudyApp,
  [AppID.FAQ]: FAQApp, [AppID.Game]: GameApp, [AppID.Worldbook]: WorldbookApp,
  [AppID.Novel]: NovelApp, [AppID.Bank]: BankApp, [AppID.XhsStock]: XhsStockApp,
  [AppID.XhsFreeRoam]: XhsFreeRoamApp, [AppID.Browser]: BrowserApp, [AppID.Songwriting]: SongwritingApp,
  [AppID.Music]: MusicApp, [AppID.Call]: CallApp, [AppID.VoiceDesigner]: VoiceDesignerApp,
  [AppID.Guidebook]: GuidebookApp, [AppID.LifeSim]: LifeSimApp, [AppID.MemoryPalace]: MemoryPalaceApp,
  [AppID.Handbook]: HandbookApp, [AppID.QQBridge]: QQBridge, [AppID.HotNews]: HotNewsApp,
  [AppID.VRWorld]: VRWorldApp, [AppID.CharCreatorDev]: CharCreatorDevApp, [AppID.SpecialMoments]: SpecialMomentsApp,
  [AppID.WorldHome]: WorldHomeApp,
};
// AppIcon 的 pointerdown 只預取用戶正在點的 App；失敗時由 preloadableLazy 清緩存，點擊可正常重試。
setAppPayloadWarmer((id: AppID) => APP_BY_ID[id]?.preload());

import { Like520Controller, shouldShowLike520Popup } from './Like520Event';
import { QixiLaunchPopup } from './QixiLaunchPopup';
import { shouldShowQixiLaunchPopup } from '../utils/qixiLaunchPopup';
import { UpdateNotificationController, shouldShowUpdateNotification } from './UpdateNotificationEvent';
import { BackupReminderController } from './BackupReminderEvent';
import { shouldShowBackupReminder, markBackupReminderShown, daysSinceLastBackup } from '../utils/backupReminder';
import { formatBytes } from '../utils/format';
import { trackEvent } from '../utils/analytics';
import { AppID } from '../types';
import { shellHandlesSafeArea } from '../utils/safeAreaApps';
import { App as CapApp } from '@capacitor/app';
import { StatusBar as CapStatusBar, Style as StatusBarStyle } from '@capacitor/status-bar';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Capacitor } from '@capacitor/core';
import { isIOSStandaloneWebApp, resolveStatusBarMode } from '../utils/iosStandalone';
import AppErrorBoundary from './os/AppErrorBoundary';
import GlobalMiniPlayer from './os/GlobalMiniPlayer';
import PersonaSimIndicator from './os/PersonaSimIndicator';
import DreamSimIndicator from './os/DreamSimIndicator';
import ErrorDialog from './os/ErrorDialog';
import BootSequence from './os/BootSequence';
import { setAppPayloadWarmer, shouldUseIdleAppPreload } from './os/appPreload';
import { isBrowserBackGuardState, makeBrowserBackGuardState } from '../utils/browserBackGuard';

/*
// Internal Error Boundary Component
class AppErrorBoundary extends Component<{ children: React.ReactNode, onCloseApp: () => void, resetKey: string }, { hasError: boolean, error: Error | null, copyLabel: string }> {
    private copyLabelTimer: number | null = null;

    constructor(props: { children: React.ReactNode, onCloseApp: () => void, resetKey: string }) {
        super(props);
        this.state = { hasError: false, error: null, copyLabel: '複製報錯信息' };
    }

    static getDerivedStateFromError(error: Error) {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error("App Crash:", error, errorInfo);
    }

    // Reset error state only when the active app changes.
    componentDidUpdate(prevProps: { children: React.ReactNode, onCloseApp: () => void, resetKey: string }) {
        if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
            this.setState({ hasError: false, error: null, copyLabel: '複製報錯信息' });
        }
    }

    componentWillUnmount() {
        if (this.copyLabelTimer) window.clearTimeout(this.copyLabelTimer);
    }

    private updateCopyLabel = (label: string) => {
        if (this.copyLabelTimer) window.clearTimeout(this.copyLabelTimer);
        this.setState({ copyLabel: label });
        this.copyLabelTimer = window.setTimeout(() => {
            this.setState({ copyLabel: '複製報錯信息' });
            this.copyLabelTimer = null;
        }, 1800);
    };

    private handleCopy = async () => {
        const errText = this.state.error?.stack || this.state.error?.message || 'Unknown Error';

        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(errText);
                this.updateCopyLabel('已複製');
                return;
            }
        } catch {
            // Fall through to legacy copy path.
        }

        try {
            const textarea = document.createElement('textarea');
            textarea.value = errText;
            textarea.setAttribute('readonly', 'true');
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            textarea.style.pointerEvents = 'none';
            document.body.appendChild(textarea);
            textarea.focus();
            textarea.select();
            const copied = document.execCommand('copy');
            document.body.removeChild(textarea);
            if (copied) {
                this.updateCopyLabel('已複製');
                return;
            }
        } catch {
            // Fall through to prompt fallback.
        }

        window.prompt('請手動複製報錯信息', errText);
        this.updateCopyLabel('請手動複製');
    };

    render() {
        if (this.state.hasError) {
            return (
                <div className="w-full h-full flex flex-col items-center justify-center bg-slate-900 text-white p-6 text-center space-y-4">
                    <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f635.png" alt="error" className="w-10 h-10" />
                    <h2 className="text-lg font-bold">應用運行錯誤</h2>
                    <p className="text-xs text-slate-400 font-mono bg-black/30 p-3 rounded max-w-full overflow-auto max-h-40 select-text break-all whitespace-pre-wrap">
                        {this.state.error?.message || 'Unknown Error'}
                    </p>
                    <button
                        onClick={() => {
                            const errText = this.state.error?.message || 'Unknown Error';
                            navigator.clipboard?.writeText(errText).then(() => {}).catch(() => {});
                        }}
                        className="px-4 py-2 bg-slate-700 rounded-full text-xs active:scale-95 transition-transform"
                    >
                        複製錯誤信息
                    </button>
                    <button
                        onClick={() => { this.setState({ hasError: false }); this.props.onCloseApp(); }}
                        className="px-6 py-3 bg-red-600 rounded-full font-bold text-sm shadow-lg active:scale-95 transition-transform"
                    >
                        返回桌面
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}
*/

const DISCLAIMER_KEY = 'sullyos_disclaimer_accepted';

type ImportRecoveryMarker = {
  startedAt?: number;
  updatedAt?: number;
  phase?: string;
  source?: string;
  sourceSize?: number;
  current?: string;
  currentFile?: string;
  currentFileSize?: number;
  assetDone?: number;
  assetTotal?: number;
  itemDone?: number;
  itemTotal?: number;
  error?: string;
};

const getPendingImportMarker = (): ImportRecoveryMarker | null => {
  try {
    const raw = localStorage.getItem(IMPORT_IN_PROGRESS_KEY);
    return raw ? (JSON.parse(raw) as ImportRecoveryMarker) : null;
  } catch {
    return null;
  }
};

const getImportPhaseLabel = (phase?: string) => {
  switch (phase) {
    case 'parsing': return '解析備份文件';
    case 'assets': return '恢復備份素材';
    case 'database': return '寫入數據庫';
    case 'settings': return '恢復系統設置';
    case 'error': return '導入報錯';
    default: return '導入流程';
  }
};



const DisclaimerPopup: React.FC<{ onAccept: () => void }> = ({ onAccept }) => (
  <div className="fixed inset-0 z-[9999] flex items-center justify-center p-5 animate-fade-in">
    <div className="absolute inset-0 bg-black/60 backdrop-blur-md" />
    <div className="relative w-full max-w-sm bg-white/95 backdrop-blur-xl rounded-[2.5rem] shadow-2xl border border-white/30 overflow-hidden animate-slide-up">
      {/* Header */}
      <div className="pt-7 pb-3 px-6 text-center">
        <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4e2.png" alt="announcement" className="w-8 h-8 mb-2" />
        <h2 className="text-lg font-extrabold text-slate-800">免責聲明</h2>
        <p className="text-[11px] text-slate-400 mt-1">Disclaimer · 手抓糯米機 (Soren)</p>
      </div>

      {/* Content */}
      <div className="px-6 pb-4 max-h-[55vh] overflow-y-auto no-scrollbar space-y-3">
        <p className="text-[13px] text-slate-600 leading-relaxed">
          本項目「手抓糯米機 (Soren)」是一個<strong className="text-slate-800">完全開源、免費</strong>的軟件，僅供個人學習、研究與技術交流使用。
        </p>
        <ul className="text-[12px] text-slate-500 leading-relaxed space-y-1.5 list-none">
          <li className="flex gap-2"><span className="shrink-0">•</span><span>本軟件不提供任何明示或暗示的擔保，作者不對使用本軟件產生的任何後果承擔責任。</span></li>
          <li className="flex gap-2"><span className="shrink-0">•</span><span>用戶應自行承擔使用本軟件的一切風險，包括但不限於數據丟失、設備損壞等。</span></li>
          <li className="flex gap-2"><span className="shrink-0">•</span><span>本軟件生成的任何 AI 內容均不代表作者立場，用戶需自行判斷內容的準確性與合規性。</span></li>
          <li className="flex gap-2"><span className="shrink-0">•</span><span>禁止將本軟件用於任何違反當地法律法規的用途。</span></li>
        </ul>

        {/* Highlighted warning */}
        <div className="bg-red-50 border-2 border-red-200 rounded-2xl p-4 mt-3">
          <p className="text-[13px] font-bold text-red-600 text-center leading-relaxed">
            本程序完全免費！<br />
            如果您是通過<span className="underline decoration-2 decoration-red-400">付費購買</span>獲得此程序的，說明您已被倒賣欺騙。<br />
            請向售賣者維權追責！
          </p>
        </div>
      </div>

      {/* Footer */}
      <div className="px-6 pb-7 pt-2">
        <button
          onClick={onAccept}
          className="w-full py-3.5 bg-gradient-to-r from-indigo-500 to-purple-500 text-white font-bold rounded-2xl shadow-lg shadow-indigo-200 active:scale-95 transition-transform text-sm"
        >
          我已知悉，繼續使用
        </button>
      </div>
    </div>
  </div>
);

const ImportRecoveryPopup: React.FC<{
  marker: ImportRecoveryMarker | null;
  onLater: () => void;
  onReimport: () => void;
}> = ({ marker, onLater, onReimport }) => {
  if (!marker) return null;

  const phaseLabel = getImportPhaseLabel(marker.phase);
  const startedAt = marker.startedAt
    ? new Date(marker.startedAt).toLocaleString('zh-CN')
    : '';
  const updatedAt = marker.updatedAt
    ? new Date(marker.updatedAt).toLocaleString('zh-CN')
    : '';
  const sourceSize = formatBytes(marker.sourceSize);
  const currentFileSize = formatBytes(marker.currentFileSize);
  const hasAssetProgress = typeof marker.assetTotal === 'number' && marker.assetTotal > 0;
  const hasItemProgress = typeof marker.itemTotal === 'number' && marker.itemTotal > 0;
  const hasError = !!marker.error;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-5 animate-fade-in">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-md" />
      <div className="relative w-full max-w-sm bg-white/95 backdrop-blur-xl rounded-[2.5rem] shadow-2xl border border-white/30 overflow-hidden animate-slide-up">
        <div className="pt-7 pb-3 px-6 text-center">
          <h2 className="text-lg font-extrabold text-slate-800">{hasError ? '上次導入失敗了' : '上次導入被中斷了'}</h2>
          <p className="text-[11px] text-slate-400 mt-1">{hasError ? '錯誤信息已記錄在本機' : '數據還沒有完整恢復'}</p>
        </div>

        <div className="px-6 pb-4 space-y-3 max-h-[58vh] overflow-y-auto no-scrollbar">
          <p className="text-[13px] text-slate-600 leading-relaxed">
            {hasError
              ? '系統檢測到上一次導入過程中發生了錯誤。請重新導入同一個備份文件，避免數據只恢復了一半。'
              : '系統檢測到上一次導入沒有走到完成步驟，可能是瀏覽器或系統在導入過程中強制重啟了。請重新導入同一個備份文件，避免數據只恢復了一半。'}
          </p>
          {hasError && (
            <div className="bg-red-50 border border-red-200 rounded-2xl p-3 text-[12px] text-red-700 leading-relaxed whitespace-pre-wrap break-words select-text">
              {marker.error}
            </div>
          )}
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-3 text-[12px] text-amber-700 leading-relaxed">
            <div>中斷階段：{phaseLabel}</div>
            {marker.current && <div>當前部分：{marker.current}</div>}
            {hasItemProgress && <div>條目進度：{marker.itemDone || 0}/{marker.itemTotal}</div>}
            {hasAssetProgress && <div>素材進度：{marker.assetDone || 0}/{marker.assetTotal}</div>}
            {marker.currentFile && (
              <div className="break-all">當前文件：{marker.currentFile}{currentFileSize ? ` · ${currentFileSize}` : ''}</div>
            )}
            {startedAt && <div>開始時間：{startedAt}</div>}
            {updatedAt && <div>最後進度：{updatedAt}</div>}
            {marker.source && <div className="break-all">備份文件：{marker.source}{sourceSize ? ` · ${sourceSize}` : ''}</div>}
          </div>
        </div>

        <div className="px-6 pb-7 pt-2 grid grid-cols-2 gap-3">
          <button
            onClick={onLater}
            className="py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl active:scale-95 transition-transform text-sm"
          >
            稍後再說
          </button>
          <button
            onClick={onReimport}
            className="py-3 bg-gradient-to-r from-emerald-500 to-teal-500 text-white font-bold rounded-2xl shadow-lg shadow-emerald-200 active:scale-95 transition-transform text-sm"
          >
            去重新導入
          </button>
        </div>
      </div>
    </div>
  );
};

// App 懶加載佔位：關鍵是「延遲出現」。chunk 命中緩存/快速加載只需幾十毫秒，這種時長用戶
// 本就無感——但 Suspense fallback 會立刻渲染，佔位一閃反而把無感瞬切變成能被看見的打斷
// （loading spinner 閃爍反模式）。所以前 ~220ms 一律渲染空（無感），只有真的慢才浮現。
// 刻意「零動畫開銷」：之前那套呼吸/漣漪/上升微塵的持續動畫在 iOS 上會引起卡頓，且預熱命中後
// 這屏幾乎不出現 —— 收益小、代價大。現在只一次性淡入一個靜態柔光點（無 infinite 動畫），
// 透明底讓外殼虛化壁紙透出來。真卡住（>15s）才換成可點的刷新/返回兜底，避免低端設備
// 仍在正常解析單個大模塊時被 7 秒閾值過早判死。
const AppLoadingFallback: React.FC<{ onReturn?: () => void; animationEnabled?: boolean }> = ({ onReturn, animationEnabled = true }) => {
  const [show, setShow] = useState(false);
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    const t = animationEnabled ? setTimeout(() => setShow(true), 220) : null;
    // 卡死逃生口：iOS standalone PWA 從後台恢復 / 弱網時，動態 import 可能既不 resolve 也不 reject，
    // Suspense 會永遠停在這一屏（不報錯 → 錯誤邊界不觸發 → 不會自動刷新），用戶狂點中心光點卻毫無反應。
    // 超過 STALL_MS 仍未加載完 → 把「看著像按鈕其實不是」的光點換成真正可點的「刷新/返回」按鈕，
    // 既明確告訴用戶該點哪裡，又把靜默卡死變成一鍵可恢復。只動佔位 UI，不碰 import 邏輯。
    const stall = setTimeout(() => { setStalled(true); trackEvent('App 加载卡死超时'); }, 15_000);
    return () => { if (t) clearTimeout(t); clearTimeout(stall); };
  }, [animationEnabled]);
  if (stalled) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-slate-900/95 text-white p-6 text-center space-y-4" style={{ animation: 'appLoadIn 320ms ease-out both' }}>
        <style>{`@keyframes appLoadIn{from{opacity:0}to{opacity:1}}`}</style>
        <h2 className="text-base font-bold">加載有點慢…</h2>
        <p className="text-xs text-slate-300 max-w-xs leading-relaxed">
          首次打開會下載並解析功能代碼；網絡波動或設備性能較低都可能變慢。頁面仍在繼續加載，若長時間沒有恢復再刷新。
        </p>
        <div className="flex flex-col gap-3 w-full max-w-xs">
          <button
            type="button"
            onClick={() => { trackEvent('卡死页点刷新恢复'); window.location.reload(); }}
            className="w-full px-6 py-3 bg-red-600 rounded-full font-bold text-sm shadow-lg active:scale-95 transition-transform"
          >
            刷新恢復
          </button>
          {onReturn && (
            <button
              type="button"
              onClick={() => { onReturn(); trackEvent('从卡死页返回桌面'); }}
              className="w-full px-4 py-2 bg-slate-700 rounded-full text-xs font-bold active:scale-95 transition-transform"
            >
              返回桌面
            </button>
          )}
        </div>
      </div>
    );
  }
  if (!show) return null;
  // 靜態柔光點：僅一次性淡入，之後無任何持續動畫（零運行時開銷），透明底透出壁紙。
  return (
    <div className="w-full h-full flex items-center justify-center bg-transparent" style={{ animation: 'appLoadIn 280ms ease-out both' }}>
      <style>{`@keyframes appLoadIn{from{opacity:0}to{opacity:1}}`}</style>
      <div className="relative" style={{ width: 72, height: 72 }}>
        {/* 靜態柔光 */}
        <div className="absolute inset-0" style={{ borderRadius: '9999px', filter: 'blur(8px)', background: 'radial-gradient(circle, hsla(var(--primary-hue),75%,72%,0.42) 0%, hsla(var(--primary-hue),70%,60%,0.10) 50%, transparent 70%)' }} />
        {/* 靜態內核 */}
        <div className="absolute" style={{ left: '50%', top: '50%', width: 10, height: 10, transform: 'translate(-50%,-50%)', borderRadius: '9999px', background: 'radial-gradient(circle, #fff, hsla(var(--primary-hue),80%,75%,0.6) 60%, transparent)', boxShadow: '0 0 10px hsla(var(--primary-hue),80%,75%,0.6)' }} />
      </div>
    </div>
  );
};

const PhoneShell: React.FC = () => {
  const { theme, isLocked, unlock, activeApp, closeApp, openApp, virtualTime, isDataLoaded, toasts, unreadMessages, characters, handleBack, suspendedCall, resumeCall, activeCharacterId, errorDialog, dismissError } = useOS();
  const useIOSStandaloneLayout = isIOSStandaloneWebApp();

  // 三檔頂部狀態欄：安全顯示 / 緊湊顯示 / 隱藏。舊存檔仍由 hideStatusBar 兼容解析。
  // compact 把時間放進 safe-area，本體頂欄只讓出 max(safe-area, 1.5rem)，避免頂部再多一整行。
  const statusBarMode = resolveStatusBarMode(theme.statusBarMode, theme.hideStatusBar);
  useEffect(() => {
    document.documentElement.classList.toggle('sully-statusbar-hidden', statusBarMode === 'hidden');
    document.documentElement.classList.toggle('sully-statusbar-compact', statusBarMode === 'compact');
  }, [statusBarMode]);

  // 冷啟動「世界入場」是否已結束。結束前由 BootSequence 接管整屏（同時取代舊的黑屏 spinner）。
  const [bootDone, setBootDone] = useState(false);
  const bootAnimationEnabled = theme.bootAnimationEnabled !== false;
  useEffect(() => {
    // 本次啟動一旦選擇跳過，就記為已經完成；用戶稍後重新打開開關時不在桌面中途補播。
    if (!bootAnimationEnabled) setBootDone(true);
  }, [bootAnimationEnabled]);

  // 折中預熱策略：首屏/開機完全讓路；桌面穩定約 600ms 後，能力足夠的設備就逐個預熱。
  // 每次嚴格等待當前 chunk 下載 + 解析完成，再空一拍取下一個。用戶一按屏幕或進入 App，
  // 立刻取消所有尚未開始的任務；已經在飛的一個 import 無法中止，但最多只會與目標 App 並行一個。
  useEffect(() => {
    if (!bootDone || !isDataLoaded || activeApp !== AppID.Launcher) return;
    if (!shouldUseIdleAppPreload() || idlePreloadCursor >= APP_IDLE_PRELOAD_ORDER.length) return;

    let stoppedByInteraction = false;
    let startTimer: number | null = null;
    let gapTimer: number | null = null;
    let idleHandle: number | null = null;
    const requestIdle = (callback: () => void): number => {
      if (typeof (window as any).requestIdleCallback === 'function') {
        return (window as any).requestIdleCallback(callback, { timeout: 2_000 });
      }
      return window.setTimeout(callback, 250);
    };
    const cancelScheduled = () => {
      if (startTimer !== null) window.clearTimeout(startTimer);
      if (gapTimer !== null) window.clearTimeout(gapTimer);
      if (idleHandle !== null) {
        if (typeof (window as any).cancelIdleCallback === 'function') {
          (window as any).cancelIdleCallback(idleHandle);
        } else {
          window.clearTimeout(idleHandle);
        }
      }
      startTimer = null;
      gapTimer = null;
      idleHandle = null;
    };
    const scheduleStep = (delay: number) => {
      if (stoppedByInteraction || document.visibilityState !== 'visible') return;
      gapTimer = window.setTimeout(() => {
        gapTimer = null;
        idleHandle = requestIdle(() => {
          idleHandle = null;
          void runStep();
        });
      }, delay);
    };
    const runStep = async () => {
      if (stoppedByInteraction || document.visibilityState !== 'visible') return;
      const next = APP_IDLE_PRELOAD_ORDER[idlePreloadCursor++];
      if (!next) return;
      try {
        await next.preload();
      } catch {
        // 空閒預熱失敗不打擾用戶；真正點開時由 retryable preload 再試。
      }
      if (!stoppedByInteraction && idlePreloadCursor < APP_IDLE_PRELOAD_ORDER.length) {
        scheduleStep(IDLE_PRELOAD_GAP_MS);
      }
    };
    const stopForInteraction = () => {
      stoppedByInteraction = true;
      cancelScheduled();
    };
    const handleVisibilityChange = () => {
      cancelScheduled();
      if (document.visibilityState === 'visible' && !stoppedByInteraction) {
        startTimer = window.setTimeout(() => scheduleStep(0), IDLE_PRELOAD_START_MS);
      }
    };

    window.addEventListener('pointerdown', stopForInteraction, { capture: true, once: true });
    document.addEventListener('visibilitychange', handleVisibilityChange);
    startTimer = window.setTimeout(() => scheduleStep(0), IDLE_PRELOAD_START_MS);

    return () => {
      stoppedByInteraction = true;
      cancelScheduled();
      window.removeEventListener('pointerdown', stopForInteraction, { capture: true });
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [activeApp, bootDone, isDataLoaded]);

  // Disclaimer popup for first-time users
  const [showDisclaimer, setShowDisclaimer] = useState(() => {
    try {
      return !localStorage.getItem(DISCLAIMER_KEY);
    } catch {
      return true;
    }
  });

  const handleAcceptDisclaimer = () => {
    try {
      localStorage.setItem(DISCLAIMER_KEY, Date.now().toString());
    } catch { /* ignore */ }
    setShowDisclaimer(false);
  };

  const [importRecoveryMarker, setImportRecoveryMarker] = useState<ImportRecoveryMarker | null>(() => {
    try {
      if (!localStorage.getItem(DISCLAIMER_KEY)) return null;
      return getPendingImportMarker();
    } catch {
      return null;
    }
  });
  const [importRecoveryDismissed, setImportRecoveryDismissed] = useState(false);
  const showImportRecoveryPrompt = !!importRecoveryMarker;

  useEffect(() => {
    if (showDisclaimer || importRecoveryDismissed || importRecoveryMarker) return;
    const marker = getPendingImportMarker();
    if (marker) setImportRecoveryMarker(marker);
  }, [showDisclaimer, importRecoveryDismissed, importRecoveryMarker]);

  // 使用統計：導入中斷提醒彈出來時報一次。只帶「失敗/中斷」和階段這兩個固定枚舉，
  // marker 裡的報錯正文、備份文件名、當前文件名、各種進度數字一概不帶。
  useEffect(() => {
    if (showDisclaimer || !showImportRecoveryPrompt) return;
    const phase = importRecoveryMarker?.phase;
    // phase 是 marker 裡的字符串，只認這五個已知值，其餘一律歸 other，避免把未知原文發出去。
    const stage = phase === 'parsing' || phase === 'assets' || phase === 'database' || phase === 'settings' || phase === 'error'
      ? phase
      : 'other';
    const hasError = !!importRecoveryMarker?.error;
    trackEvent('弹出上次导入未完成提醒', { kind: hasError ? '失败' : '中断', stage });
    trackEvent('弹出导入中断恢复提醒', {
      中断类型: hasError ? '导入失败' : '导入被中断',
      中断阶段: getImportPhaseLabel(phase),
    });
  }, [showDisclaimer, showImportRecoveryPrompt, importRecoveryMarker]);

  const handleReimportFromRecovery = () => {
    setImportRecoveryDismissed(true);
    setImportRecoveryMarker(null);
    openApp(AppID.Settings);
    trackEvent('点去重新导入', { kind: importRecoveryMarker?.error ? '失败' : '中断' });
  };

  // 「致用戶的一封信」已下線：常量置 false，保留變量讓下面彈窗鏈的條件繼續成立（恆真/恆不顯示）。
  const showAuthorLetter = false;

  // Ta-da 週年贈禮先於更新公告，等基礎啟動提示、開機動畫與解鎖完成。
  const [showAnniversaryGift, setShowAnniversaryGift] = useState(false);
  const anniversaryAsked = useRef(false);
  const firstUseGuideActive = useFirstUseGuideStep() !== null;
  const anniversaryBlocked = firstUseGuideActive || showDisclaimer || showImportRecoveryPrompt || showAuthorLetter;
  // 待展示也佔住順序，避免同一輪 effects 同時開啟贈禮和更新公告。
  // Complete setup before promotional/release popups; disclaimer/recovery still have priority.
  const anniversaryHasPriority = firstUseGuideActive || showAnniversaryGift || (!anniversaryAsked.current && shouldShowAnniversaryGift());
  useEffect(() => {
    if (anniversaryAsked.current || anniversaryBlocked || !isDataLoaded || isLocked || (!bootDone && bootAnimationEnabled)) return;
    if (shouldShowAnniversaryGift()) {
      anniversaryAsked.current = true;
      setShowAnniversaryGift(true);
    }
  }, [anniversaryBlocked, isDataLoaded, isLocked, bootDone, bootAnimationEnabled]);

  // 本次版本首映：數據就緒且解鎖後出現一次，避免按鈕打開的 App 被鎖屏擋在背後。
  const [showUpdateNotification, setShowUpdateNotification] = useState(false);
  /**
   * 這次開機已經問過一輪了。
   *
   * 更新提醒可能不止一條（見 UpdateNotificationController 的隊列），用戶點「立刻體驗」
   * 跳去別的 App 時，剩下那幾條是故意不標已讀、留到下次啟動的。少了這道閘，彈窗一關
   * 下面的 effect 就會立刻再問一次「還有沒有沒看的」，然後把下一條糊在剛打開的頁面上。
   */
  const updateNoticeAsked = useRef(false);

  useEffect(() => {
    if (updateNoticeAsked.current) return;
    if (anniversaryHasPriority || showDisclaimer || showImportRecoveryPrompt || showAuthorLetter || showUpdateNotification) return;
    if (!isDataLoaded || isLocked) return;
    if (shouldShowUpdateNotification()) {
      updateNoticeAsked.current = true;
      setShowUpdateNotification(true);
    }
  }, [anniversaryHasPriority, showDisclaimer, showImportRecoveryPrompt, showAuthorLetter, showUpdateNotification, isDataLoaded, isLocked]);

  // 七夕特別活動推送：嚴格按北京時間 2026-08-19 判斷，用戶處理後永久不再彈。
  // 排在版本更新之後、日常維護提醒之前；按鈕只帶到「特別時光」，不替用戶選擇角色。
  const [showQixiLaunchPopup, setShowQixiLaunchPopup] = useState(false);
  const qixiLaunchAsked = useRef(false);
  useEffect(() => {
    if (qixiLaunchAsked.current) return;
    if (anniversaryHasPriority || showDisclaimer || showImportRecoveryPrompt || showAuthorLetter || showUpdateNotification) return;
    if (!isDataLoaded || isLocked) return;
    if (shouldShowQixiLaunchPopup()) {
      qixiLaunchAsked.current = true;
      setShowQixiLaunchPopup(true);
    }
  }, [anniversaryHasPriority, showDisclaimer, showImportRecoveryPrompt, showAuthorLetter, showUpdateNotification, isDataLoaded, isLocked]);

  // 520 特別活動彈窗（2026-05-20 當天，且沒被 dismiss / completed）
  // 一次性：用戶點過任何按鈕就標記 dismissed，下次刷新不再出現；
  // API 配置改成彈窗內嵌，配完直接進活動，不再需要把彈窗暫存讓位給 Settings。
  const [showLike520Popup, setShowLike520Popup] = useState(false);
  useEffect(() => {
    if (anniversaryHasPriority || showDisclaimer || showImportRecoveryPrompt || showAuthorLetter || showUpdateNotification || showQixiLaunchPopup) return;
    if (!isDataLoaded) return;
    if (shouldShowLike520Popup()) setShowLike520Popup(true);
  }, [anniversaryHasPriority, showDisclaimer, showImportRecoveryPrompt, showAuthorLetter, showUpdateNotification, showQixiLaunchPopup, isDataLoaded]);

  // 「該備份啦」提醒 — local-first 數據只在本機，隔 N 天（默認 7，可在設置裡改）沒導出就彈一次
  const [showBackupReminder, setShowBackupReminder] = useState(false);
  useEffect(() => {
    if (anniversaryHasPriority || showDisclaimer || showImportRecoveryPrompt || showAuthorLetter || showUpdateNotification || showQixiLaunchPopup || showLike520Popup) return;
    if (!isDataLoaded || isLocked) return;
    if (shouldShowBackupReminder()) {
      setShowBackupReminder(true);
      // 只報「從未備份 / 已過期」這一個二選一，不報具體天數、也不報用戶設的提醒間隔。
      trackEvent('弹出该备份啦提醒', { state: daysSinceLastBackup() == null ? '从未备份' : '已过期' });
    }
  }, [anniversaryHasPriority, showDisclaimer, showImportRecoveryPrompt, showAuthorLetter, showUpdateNotification, showQixiLaunchPopup, showLike520Popup, isDataLoaded, isLocked]);

  const dismissBackupReminder = () => {
    markBackupReminderShown();
    setShowBackupReminder(false);
    trackEvent('点知道了稍后再说');
  };
  const goBackupFromReminder = () => {
    markBackupReminderShown();
    setShowBackupReminder(false);
    openApp(AppID.Settings);
    trackEvent('点立即备份');
  };

  // Web browsers normally interpret an edge-swipe/back shortcut as leaving SullyOS.
  // While an app is open, keep one same-page history entry and translate that pop
  // into the same layered back action used by the native Android button. Nested
  // views may push their own entries above this one; landing back on our guard must
  // therefore not consume a second in-app layer.
  useEffect(() => {
    if (typeof window === 'undefined' || Capacitor.isNativePlatform()) return;

    const guardIsCurrent = isBrowserBackGuardState(window.history.state);
    if (activeApp === AppID.Launcher) {
      if (!guardIsCurrent) return;

      // A nested view can inherit our marker. Unwind every marked same-page entry
      // and stop as soon as the original browser entry is current again.
      let disposed = false;
      const releaseGuardEntries = () => {
        if (disposed || !isBrowserBackGuardState(window.history.state)) return;
        try { window.history.back(); } catch { /* leave browser history untouched */ }
      };
      window.addEventListener('popstate', releaseGuardEntries);
      releaseGuardEntries();
      return () => {
        disposed = true;
        window.removeEventListener('popstate', releaseGuardEntries);
      };
    }

    const armGuard = () => {
      try {
        window.history.pushState(
          makeBrowserBackGuardState(window.history.state),
          '',
          window.location.href,
        );
        return true;
      } catch {
        return false;
      }
    };

    if (!guardIsCurrent && !armGuard()) return;

    const onPopState = (event: PopStateEvent) => {
      // A nested panel was above the SullyOS guard and handled this back itself.
      if (isBrowserBackGuardState(event.state)) return;

      // Re-arm before navigating inside the OS so another quick swipe is safe too.
      armGuard();
      handleBack();
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [activeApp, handleBack]);

  // Capacitor Native Handling
  useEffect(() => {
    const initNative = async () => {
        if (Capacitor.isNativePlatform()) {
            try {
                await CapStatusBar.setOverlaysWebView({ overlay: true });
                await CapStatusBar.hide();
                await CapStatusBar.setStyle({ style: StatusBarStyle.Dark });

                const permStatus = await LocalNotifications.checkPermissions();
                if (permStatus.display !== 'granted') {
                    await LocalNotifications.requestPermissions();
                }
            } catch (e) {
                console.error("Native init failed", e);
            }
        }
    };
    initNative();

    // Handle Android Hardware Back Button
    const setupBackButton = async () => {
        if (Capacitor.isNativePlatform()) {
            try {
                await CapApp.removeAllListeners();
                CapApp.addListener('backButton', ({ canGoBack }) => {
                    if (isLocked) {
                        CapApp.exitApp();
                    } else {
                        handleBack(); // Delegate to OSContext logic
                    }
                });
            } catch (e) { console.log('Back button listener setup failed'); }
        }
    };

    setupBackButton();

    return () => {
        if (Capacitor.isNativePlatform()) {
            CapApp.removeAllListeners().catch(() => {});
        }
    };
  }, [activeApp, isLocked, closeApp, handleBack]);

  // Force scroll to top when app changes to prevent "push up" glitches on iOS
  useEffect(() => {
      window.scrollTo(0, 0);
  }, [activeApp]);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const wallpaper = theme.wallpaper;
    const backgroundValue = !wallpaper
      ? '#0f1115'
      : (wallpaper.startsWith('http') || wallpaper.startsWith('data:') || wallpaper.startsWith('blob:') || wallpaper.startsWith('./') || wallpaper.startsWith('/'))
        ? `url(${wallpaper})`
        : wallpaper;

    [document.documentElement, document.body].forEach((element) => {
      element.style.background = backgroundValue;
      element.style.backgroundPosition = 'center';
      element.style.backgroundSize = 'cover';
      element.style.backgroundRepeat = 'no-repeat';
    });
  }, [theme.wallpaper]);

  // 冷啟動：先放「世界入場」cinematic（數據沒就緒時它持續呼吸等待，絕不出現 spinner）。
  // BootSequence 在「數據就緒 + 停留夠時長」後推進退場，再交還控制權給下方的鎖屏/桌面。
  if (!bootDone && bootAnimationEnabled) {
    return <BootSequence dataReady={isDataLoaded} wallpaper={theme.wallpaper} style={theme.bootAnimationStyle} onDone={() => setBootDone(true)} />;
  }

  // 兜底：理論上 bootDone 時數據已就緒；萬一未就緒（極端慢）退化為最簡靜態深色屏，不閃 spinner。
  if (!isDataLoaded) {
    return <div className="w-full h-full" style={{ background: '#05060f' }} />;
  }

  const getBgStyle = (wp: string) => {
      const isUrl = wp.startsWith('http') || wp.startsWith('data:') || wp.startsWith('blob:') || wp.startsWith('./') || wp.startsWith('/');
      return isUrl ? `url(${wp})` : wp;
  };

  const bgImageValue = getBgStyle(theme.wallpaper);
  const lockBgImageValue = getBgStyle(theme.lockWallpaper || theme.wallpaper);
  const contentColor = theme.contentColor || '#ffffff';
  const acnhSkin = theme.skin === 'animalcrossing'; // 動森彩蛋：鎖屏換暖色草地點綴
  const storedCompanionFrame = theme.skin === 'companion' ? loadCompanionFrameStyle() : null;
  const companionLockFrame = storedCompanionFrame;

  if (isLocked) {
    const unreadCount = Object.values(unreadMessages).reduce((a,b) => a+b, 0);
    const unreadCharId = Object.keys(unreadMessages)[0];
    const unreadChar = unreadCharId ? characters.find(c => c.id === unreadCharId) : null;
    const lockCharacter = characters.find(c => c.id === activeCharacterId) || characters[0] || null;

        return (
      <div 
        onClick={() => {
            // Only ask once when permission is still undecided; don't keep poking blocked/denied browsers.
            if ('Notification' in window && Notification.permission === 'default') {
                Notification.requestPermission();
            }
            unlock();
        }}
        className="relative w-full h-full bg-cover bg-center cursor-pointer overflow-hidden group font-light select-none overscroll-none"
        style={{ backgroundImage: lockBgImageValue, color: contentColor, animation: 'lockReveal 600ms ease-out both' }}
      >
        {/* 鎖屏柔和淡入：與開機「世界入場」退場銜接；body 背景本就是壁紙，故是無縫融入而非硬切。 */}
        <style>{`@keyframes lockReveal{from{opacity:0}to{opacity:1}}`}</style>
        {acnhSkin ? (
            <div className="absolute inset-0 transition-all duration-700 group-hover:opacity-0"
                 style={{ background: 'linear-gradient(180deg, rgba(188,231,245,0.25) 0%, rgba(255,247,176,0.15) 45%, rgba(124,186,76,0.28) 100%)' }} />
        ) : (
            <div className="absolute inset-0 bg-black/5 backdrop-blur-sm transition-all group-hover:backdrop-blur-none group-hover:bg-transparent duration-700" />
        )}

        {/* 動森彩蛋：鎖屏飄葉 */}
        {acnhSkin && (
            <div className="absolute inset-0 pointer-events-none overflow-hidden">
                <svg viewBox="0 0 100 100" className="absolute w-14 h-14 opacity-80 -rotate-[25deg]" style={{ left: '10%', top: '12%' }}><path d="M50 8 C78 20 88 50 78 82 C74 92 60 96 50 92 C40 96 26 92 22 82 C12 50 22 20 50 8Z" fill="#9ED25F"/><path d="M50 14 L50 88" stroke="#5c8a30" strokeWidth="3" fill="none" opacity="0.5"/></svg>
                <svg viewBox="0 0 100 100" className="absolute w-12 h-12 opacity-75 rotate-[30deg] scale-x-[-1]" style={{ right: '12%', top: '20%' }}><path d="M50 8 C78 20 88 50 78 82 C74 92 60 96 50 92 C40 96 26 92 22 82 C12 50 22 20 50 8Z" fill="#7CBA4C"/><path d="M50 14 L50 88" stroke="#4d7a2a" strokeWidth="3" fill="none" opacity="0.5"/></svg>
                <svg viewBox="0 0 100 100" className="absolute w-16 h-16 opacity-70 rotate-[12deg]" style={{ left: '16%', bottom: '14%' }}><path d="M50 8 C78 20 88 50 78 82 C74 92 60 96 50 92 C40 96 26 92 22 82 C12 50 22 20 50 8Z" fill="#5FAE6E"/><path d="M50 14 L50 88" stroke="#356b3f" strokeWidth="3" fill="none" opacity="0.5"/></svg>
            </div>
        )}

        {companionLockFrame && (
          <CompanionLockChrome
            variant={companionLockFrame}
            hours={virtualTime.hours}
            minutes={virtualTime.minutes}
            activeCharacter={lockCharacter}
            unreadCharacter={unreadChar}
            unreadCount={unreadCount}
            preserveWallpaper={Boolean(theme.lockWallpaper)}
          />
        )}

        {!companionLockFrame && <div className="absolute top-24 w-full text-center drop-shadow-[0_2px_4px_rgba(0,0,0,0.3)]">
           <div className="text-8xl tracking-tighter opacity-95 font-bold">
             {virtualTime.hours.toString().padStart(2,'0')}<span className="animate-pulse">:</span>{virtualTime.minutes.toString().padStart(2,'0')}
           </div>
           {acnhSkin ? (
               <div className="text-lg tracking-widest opacity-90 mt-2 text-xs font-bold flex items-center justify-center gap-1.5">
                   <span>🍃</span><span>無人島生活</span><span>🍃</span>
               </div>
           ) : (
               <div className="text-lg tracking-widest opacity-90 mt-2 uppercase text-xs font-bold">Soren Simulation</div>
           )}
        </div>}

        {!companionLockFrame && unreadCount > 0 && (
            <div className="absolute top-[40%] left-4 right-4 animate-slide-up">
                <div className="bg-white/20 backdrop-blur-md rounded-2xl p-4 shadow-lg border border-white/10 flex items-center gap-4">
                    <div className="w-10 h-10 rounded-xl bg-green-500 flex items-center justify-center text-white shrink-0 shadow-sm">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6"><path fillRule="evenodd" d="M4.804 21.644A6.707 6.707 0 0 0 6 21.75a6.721 6.721 0 0 0 3.583-1.029c.774.182 1.584.279 2.417.279 5.322 0 9.75-3.97 9.75-9 0-5.03-4.428-9-9.75-9s-9.75 3.97-9.75 9c0 2.409 1.025 4.587 2.674 6.192.232.226.277.428.254.543a3.73 3.73 0 0 1-.814 1.686.75.75 0 0 0 .44 1.223ZM8.25 10.875a1.125 1.125 0 1 0 0 2.25 1.125 1.125 0 0 0 0-2.25ZM10.875 12a1.125 1.125 0 1 1 2.25 0 1.125 1.125 0 0 1-2.25 0Zm4.875-1.125a1.125 1.125 0 1 0 0 2.25 1.125 1.125 0 0 0 0-2.25Z" clipRule="evenodd" /></svg>
                    </div>
                    <div className="flex-1 min-w-0 text-white text-left">
                        <div className="font-bold text-sm flex justify-between">
                            <span>{unreadChar ? unreadChar.name : 'Message'}</span>
                            <span className="text-[10px] opacity-70">剛剛</span>
                        </div>
                        <div className="text-xs opacity-90 truncate">
                            {unreadCount > 1 ? `收到 ${unreadCount} 條新消息` : '發來了一條新消息'}
                        </div>
                    </div>
                </div>
            </div>
        )}

        {!companionLockFrame && <div className="absolute bottom-12 w-full flex flex-col items-center gap-3 animate-pulse opacity-80 drop-shadow-md">
          <div className="w-1 h-8 rounded-full bg-gradient-to-b from-transparent to-current"></div>
          <span className="text-[10px] tracking-widest uppercase font-semibold">Tap to Unlock</span>
        </div>}
      </div>
    );
  }

  const renderApp = () => {
    switch (activeApp) {
      case AppID.Settings: return <Settings />;
      case AppID.Character: return <Character />;
      case AppID.Chat: return <Chat />;
      case AppID.ChatHub: return <ChatHub />;
      case AppID.GroupChat: return <GroupChat />; 
      case AppID.ThemeMaker: return <ThemeMaker />;
      case AppID.Appearance: return <Appearance />;
      case AppID.Gallery: return <Gallery />;
      case AppID.Date: return <DateApp />; 
      case AppID.User: return <UserApp />;
      case AppID.Journal: return <JournalApp />; 
      case AppID.Schedule: return <ScheduleApp />;
      case AppID.Room: return <RoomApp />; 
      case AppID.CheckPhone: return <CheckPhone />;
      case AppID.Social: return <SocialApp />;
      case AppID.Study: return <StudyApp />; 
      case AppID.FAQ: return <FAQApp />; 
      case AppID.Game: return <GameApp />; 
      case AppID.Worldbook: return <WorldbookApp />;
      case AppID.Novel: return <NovelApp />; 
      case AppID.Bank: return <BankApp />;
      case AppID.XhsStock: return <XhsStockApp />;
      case AppID.XhsFreeRoam: return <XhsFreeRoamApp />;
      case AppID.Browser: return <BrowserApp />;
      case AppID.Songwriting: return <SongwritingApp />;
      case AppID.Music: return <MusicApp />;
      case AppID.Call: return <CallApp />;
      case AppID.VoiceDesigner: return <VoiceDesignerApp />;
      case AppID.Guidebook: return <GuidebookApp />;
      case AppID.LifeSim: return <LifeSimApp />;
      case AppID.MemoryPalace: return <MemoryPalaceApp />;
      case AppID.Handbook: return <HandbookApp />;
      case AppID.QQBridge: return <QQBridge />;
      case AppID.HotNews: return <HotNewsApp />;
      case AppID.SpecialMoments: return <SpecialMomentsApp />;
      case AppID.VRWorld: return <VRWorldApp />;
      case AppID.WorldHome: return <WorldHomeApp />;
      case AppID.CharCreatorDev: return <CharCreatorDevApp />;
      case AppID.Launcher:
      default: return <Launcher />;
    }
  };

  // 安全區策略（方案 B）：自理名單裡的 App 已全屏鋪底、自己給控件讓位，外殼不再加 padding；
  // 其餘尚未遷移、靠外殼兜底的 App，仍由外殼用單一來源變量 --safe-* 統一讓出安全區，避免頂欄懟進狀態欄。
  // 自理名單見 utils/safeAreaApps.ts（遷移一個 App = 把它加進名單 + 頂欄用 --chrome-top 自己讓位）。
  // TODO(safe-area-A): 把剩餘「未遷移」App 逐個改為自理安全區後，移除外殼這層兜底，實現全屏無色條。
  const shellPadsSafeArea = shellHandlesSafeArea(activeApp);

  return (
    <div className="relative w-full h-full overflow-hidden bg-gradient-to-br from-pink-200 via-purple-200 to-indigo-200 text-slate-900 font-sans select-none overscroll-none">
       {/* Optimized Background Layer */}
       {/* 壁紙底層：進 App 時只柔和虛化/壓暗作背景，不再做縮放「過場」——
          進 App 的過渡感統一交給 App 容器的淡入（見下方 animate-fade-in 包裹層）。 */}
       <div
         className="absolute inset-0 bg-cover bg-center transition-all duration-500 ease-[cubic-bezier(0.25,0.1,0.25,1)]"
         style={{
             backgroundImage: bgImageValue,
             filter: activeApp !== AppID.Launcher ? 'blur(10px)' : 'none',
             opacity: activeApp !== AppID.Launcher ? 0.6 : 1,
             backfaceVisibility: 'hidden',
             contain: useIOSStandaloneLayout ? undefined : 'strict'
         }}
       />
       
       <div className={`absolute inset-0 transition-all duration-500 ${activeApp === AppID.Launcher ? 'bg-transparent' : 'bg-white/50 backdrop-blur-3xl'}`} />
       
       {/* 外殼安全區兩種策略：
          - 未遷移 App：外殼鋪滿 body（含 --app-height 多出的 +safe-bottom 溢出區），用 padding 讓位安全區，
            內容只畫到可見 viewport 內，home 條上方留出 safe-bottom 視覺間隙。
          - 已遷移 App（彼方/聊天/群聊/桌面）：自理安全區。外殼直接把底邊收回到可見 viewport
            （bottom = --standalone-safe-area-bottom），不讓那多出來的 34px 把 App 底部控件壓到 home 條上。 */}
      <div
        className="sully-shell-content absolute top-0 left-0 right-0 z-10 overflow-hidden bg-transparent overscroll-none flex flex-col"
        style={
          shellPadsSafeArea
            ? { bottom: 0, paddingTop: 'var(--safe-top)', paddingBottom: 'var(--safe-bottom)' }
            : { bottom: 'var(--standalone-safe-area-bottom, 0px)' }
        }
      >
          <FirstUseGuide />
          {/* App Container */}
          <div className="flex-1 relative overflow-hidden" style={{ contain: useIOSStandaloneLayout ? undefined : 'layout style paint' }}>
            <AppErrorBoundary onCloseApp={closeApp} resetKey={`${activeApp}:${activeCharacterId || 'none'}`}>
              <Suspense fallback={<AppLoadingFallback onReturn={closeApp} animationEnabled={theme.appLoadingAnimationEnabled !== false} />}>
                {/* 統一「淡入」過渡：每次切換 App 時 key 變化 → 重新掛載並淡入，
                    讓所有 App 都像個人檔案那樣「漸變進去」，而非瞬間咚一下。
                    關鍵：只動 opacity、不做 scale/translate —— 否則會把整棵（常含大量頭像圖片的）
                    App 子樹柵格化進 transform 圖層，角色列表類 App 首幀會卡頓一下（停頓一秒）。
                    時長也壓短，進重 App 時不至於多等。 */}
                <div key={activeApp} className="w-full h-full" style={{ animation: 'appEnterFade 200ms ease-out both' }}>
                  <style>{`@keyframes appEnterFade{from{opacity:0}to{opacity:1}}`}</style>
                  {renderApp()}
                </div>
              </Suspense>
            </AppErrorBoundary>
          </div>

          {/* Overlays: Status Bar (Top) —— 常駐渲染：時鐘/電量條由開關+平台默認決定顯隱（StatusBar 內部 isStatusBarHidden），
              錯誤指示器、系統調試終端與開關無關、始終在。 */}
          <StatusBar />
          
          {/* Overlays: Suspended Call Bar */}
          {suspendedCall && activeApp !== AppID.Call && (
            <button
              onClick={resumeCall}
              className="absolute top-7 left-0 w-full z-[55] flex items-center justify-center gap-2 bg-emerald-500 text-white text-xs font-bold py-1.5 animate-pulse cursor-pointer active:bg-emerald-600 transition-colors"
            >
              <span className="w-2 h-2 rounded-full bg-white animate-ping" />
              <span>通話中 · {suspendedCall.charName}</span>
              <span className="opacity-70">點擊返回</span>
            </button>
          )}

          {/* Overlays: Global Mini Player (when music is playing in background) */}
          <GlobalMiniPlayer />
          {!isLocked && <SARModuleMonitor />}

          {/* Overlays: 人格模擬生成全局指示條 */}
          <PersonaSimIndicator />

          {/* Overlays: 夢境生成全局指示條 */}
          <DreamSimIndicator />

          {/* Overlays: Toasts (Top) */}
          <div className="absolute top-12 left-0 w-full flex flex-col items-center gap-2 pointer-events-none z-[60]">
              {toasts.map(toast => (
                 <div key={toast.id} className="animate-fade-in bg-white/95 backdrop-blur-xl px-4 py-3 rounded-2xl shadow-xl border border-black/5 flex items-start gap-3 max-w-[85%] ring-1 ring-white/20">
                     {toast.type === 'success' && <div className="w-2.5 h-2.5 rounded-full bg-green-500 shrink-0"></div>}
                     {toast.type === 'error' && <div className="w-2.5 h-2.5 rounded-full bg-red-500 shrink-0"></div>}
                     {toast.type === 'info' && <div className="w-2.5 h-2.5 rounded-full bg-primary shrink-0"></div>}
                     <span className="min-w-0 text-left text-xs font-bold text-slate-800 whitespace-normal break-words [overflow-wrap:anywhere] leading-5">{toast.message}</span>
                 </div>
              ))}
           </div>
       </div>

       {/* Global error dialog (長報錯走它, 替代單行 toast) */}
       <ErrorDialog
         isOpen={!!errorDialog}
         title={errorDialog?.title ?? ''}
         details={errorDialog?.details ?? ''}
         onClose={dismissError}
       />

       {/* First-time disclaimer popup */}
       {!anniversaryBlocked && !isLocked && showAnniversaryGift && (
         <AnniversaryGiftPopup onClose={() => {
           markAnniversaryGiftSeen();
           setShowAnniversaryGift(false);
         }} />
       )}
       {showDisclaimer && <DisclaimerPopup onAccept={handleAcceptDisclaimer} />}

       {/* Interrupted import recovery reminder */}
       {!showDisclaimer && showImportRecoveryPrompt && (
         <ImportRecoveryPopup
           marker={importRecoveryMarker}
           onLater={() => {
             setImportRecoveryDismissed(true);
             setImportRecoveryMarker(null);
             trackEvent('点稍后再说放着不管', { kind: importRecoveryMarker?.error ? '失败' : '中断' });
             trackEvent('导入恢复提醒选稍后再说', { 中断阶段: getImportPhaseLabel(importRecoveryMarker?.phase) });
           }}
           onReimport={handleReimportFromRecovery}
         />
       )}

       {/* 見面 · 劇情首映：解鎖後一次性出現 */}
       {!anniversaryHasPriority && !showDisclaimer && !showImportRecoveryPrompt && !showAuthorLetter && showUpdateNotification && (
         <UpdateNotificationController onClose={() => setShowUpdateNotification(false)} />
       )}

       {/* 七夕特別活動推送（北京時間 2026-08-19，當天至多出現一次） */}
       {!anniversaryHasPriority && !showDisclaimer && !showImportRecoveryPrompt && !showAuthorLetter && !showUpdateNotification && showQixiLaunchPopup && (
         <QixiLaunchPopup onClose={() => setShowQixiLaunchPopup(false)} />
       )}

       {/* 520 特別活動彈窗（2026-05-20 當天，一次性） */}
       {!anniversaryHasPriority && !showDisclaimer && !showImportRecoveryPrompt && !showAuthorLetter && !showUpdateNotification && !showQixiLaunchPopup && showLike520Popup && (
         <Like520Controller
           onClose={() => setShowLike520Popup(false)}
         />
       )}

       {/* 「該備份啦」提醒（local-first 數據只在本機，隔 N 天沒導出彈一次） */}
       {!anniversaryHasPriority && !showDisclaimer && !showImportRecoveryPrompt && !showAuthorLetter && !showUpdateNotification && !showQixiLaunchPopup && !showLike520Popup && showBackupReminder && (
         <BackupReminderController
           onDismiss={dismissBackupReminder}
           onGoBackup={goBackupFromReminder}
         />
       )}
    </div>
  );
};

export default PhoneShell;
