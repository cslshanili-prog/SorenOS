import { AppID } from '../types';

// 「自理安全區」的 App 名單：這些 App 自己把內容鋪滿到劉海/home 條下，並用
// --chrome-top / --safe-bottom 給頂/底控件讓位，所以外殼（PhoneShell）不再統一加 padding，
// 劉海那塊顯示的就是 App 自己的背景色，實現頂部無縫。
// 不在名單裡的 App 仍由外殼兜底讓位安全區（見 docs：TODO(safe-area-A) 遷移計劃）。
export const SELF_SAFE_AREA_APPS: ReadonlySet<AppID> = new Set<AppID>([
    AppID.Launcher,
    AppID.VRWorld,
    AppID.Chat,
    AppID.ChatHub,
    AppID.GroupChat,
    AppID.Social,
    AppID.Moments,
    // 批量遷移（頂欄自理 safe-top，外層/內層拆見各 App）：
    AppID.Settings,
    AppID.Character,
    AppID.ThemeMaker,
    AppID.Appearance,
    AppID.Gallery,
    AppID.Date,
    AppID.User,
    AppID.Journal,
    AppID.Schedule,
    AppID.Room,
    AppID.CheckPhone,
    AppID.Study,
    AppID.FAQ,
    AppID.Game,
    AppID.Worldbook,
    AppID.Novel,
    AppID.Bank,
    AppID.XhsStock,
    AppID.XhsFreeRoam,
    AppID.Browser,
    AppID.Songwriting,
    AppID.Music,
    AppID.Call,
    AppID.VoiceDesigner,
    AppID.Guidebook,
    AppID.LifeSim,
    AppID.MemoryPalace,
    AppID.Handbook,
    AppID.QQBridge,
    AppID.HotNews,
    AppID.WorldHome,
    AppID.CharCreatorDev,
    AppID.SpecialMoments,
]);

// 外殼是否需要替這個 App 讓出安全區：不在自理名單裡的才需要。
export const shellHandlesSafeArea = (appId: AppID): boolean => !SELF_SAFE_AREA_APPS.has(appId);
