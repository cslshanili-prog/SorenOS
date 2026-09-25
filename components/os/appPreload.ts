import { AppID } from '../../types';

type PreloadConnection = {
  saveData?: boolean;
  effectiveType?: string;
};

type PreloadNavigator = {
  hardwareConcurrency?: number;
  deviceMemory?: number;
  connection?: PreloadConnection;
};

/** Low-end / constrained devices keep all bandwidth and CPU for explicit user actions. */
export const shouldUseIdleAppPreload = (
  nav: PreloadNavigator = navigator as Navigator & PreloadNavigator,
): boolean => {
  const connection = nav.connection;
  if (connection?.saveData) return false;
  if (connection?.effectiveType === 'slow-2g' || connection?.effectiveType === '2g') return false;
  if (typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency > 0 && nav.hardwareConcurrency <= 4) return false;
  if (typeof nav.deviceMemory === 'number' && nav.deviceMemory > 0 && nav.deviceMemory <= 4) return false;
  return true;
};

// AppID → 該 App 代碼塊的 import 工廠（路徑相對本文件 components/os/）。
// 與 PhoneShell 的 lazy 定義指向同一批模塊；Vite 按模塊 URL 去重，
// 「按下即預取」與「空閒預取/懶加載」共用同一份 chunk，絕不重複下載。
// 新增 App 時若忘記在此登記，僅會少一次按下預取優化，不影響功能（打開時照常懶加載）。
const importers: Partial<Record<AppID, () => Promise<unknown>>> = {
  [AppID.Settings]: () => import('../../apps/Settings'),
  [AppID.Character]: () => import('../../apps/Character'),
  [AppID.Chat]: () => import('../../apps/Chat'),
  [AppID.GroupChat]: () => import('../../apps/GroupChat'),
  [AppID.ThemeMaker]: () => import('../../apps/ThemeMaker'),
  [AppID.Appearance]: () => import('../../apps/Appearance'),
  [AppID.Gallery]: () => import('../../apps/Gallery'),
  [AppID.Date]: () => import('../../apps/DateApp'),
  [AppID.User]: () => import('../../apps/UserApp'),
  [AppID.Journal]: () => import('../../apps/JournalApp'),
  [AppID.Schedule]: () => import('../../apps/ScheduleApp'),
  [AppID.Room]: () => import('../../apps/RoomApp'),
  [AppID.CheckPhone]: () => import('../../apps/CheckPhone'),
  [AppID.Moments]: () => import('../../apps/MomentsApp'),
  [AppID.Social]: () => import('../../apps/SocialApp'),
  [AppID.Study]: () => import('../../apps/StudyApp'),
  [AppID.FAQ]: () => import('../../apps/FAQApp'),
  [AppID.Game]: () => import('../../apps/GameApp'),
  [AppID.Worldbook]: () => import('../../apps/WorldbookApp'),
  [AppID.Novel]: () => import('../../apps/NovelApp'),
  [AppID.Bank]: () => import('../../apps/BankApp'),
  [AppID.XhsStock]: () => import('../../apps/XhsStockApp'),
  [AppID.XhsFreeRoam]: () => import('../../apps/XhsFreeRoamApp'),
  [AppID.Browser]: () => import('../../apps/BrowserApp'),
  [AppID.Songwriting]: () => import('../../apps/SongwritingApp'),
  [AppID.Music]: () => import('../../apps/MusicApp'),
  [AppID.Call]: () => import('../../apps/CallApp'),
  [AppID.VoiceDesigner]: () => import('../../apps/VoiceDesignerApp'),
  [AppID.Guidebook]: () => import('../../apps/GuidebookApp'),
  [AppID.LifeSim]: () => import('../../apps/LifeSimApp'),
  [AppID.MemoryPalace]: () => import('../../apps/MemoryPalaceApp'),
  [AppID.Handbook]: () => import('../../apps/HandbookApp'),
  [AppID.QQBridge]: () => import('../../apps/QQBridge'),
  [AppID.HotNews]: () => import('../../apps/HotNewsApp'),
  [AppID.SpecialMoments]: () => import('../ValentineEvent'),
  [AppID.VRWorld]: () => import('../../apps/VRWorldApp'),
  [AppID.CharCreatorDev]: () => import('../../apps/CharCreatorDevApp'),
};

// 已發起預取的 App（去重，避免同一圖標多次 pointerdown 重複觸發）。
const requested = new Set<AppID>();

// 負載預熱掛鉤：由 PhoneShell 注入，按 AppID 複用對應 React.lazy 的模塊 Promise。
// 解耦放這裡是為了讓 AppIcon（pointerdown）也能觸發，而無需直接依賴 PhoneShell 的 lazy 定義。
let payloadWarmer: ((id: AppID) => Promise<unknown> | undefined) | null = null;
export const setAppPayloadWarmer = (fn: (id: AppID) => Promise<unknown> | undefined): void => { payloadWarmer = fn; };

/**
 * 「按下即預取」：手指剛按到圖標（pointerdown，早於 tap 完成約 100ms）即預熱該 App。
 * 這裡只加載用戶正在按下的一個 App，不在冷啟動時批量預取。優先複用 PhoneShell 的模塊 Promise；
 * 未注入時退化為直接預取 Vite 模塊。
 */
export const preloadApp = (id: AppID): void => {
  if (requested.has(id)) return;
  requested.add(id);
  const request = payloadWarmer ? payloadWarmer(id) : importers[id]?.();
  if (!request) {
    requested.delete(id);
    return;
  }
  void request.catch(() => { requested.delete(id); });
};
