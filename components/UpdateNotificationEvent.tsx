import { SARUpdatePopup } from './os/SARUpdatePopup';
import { SAR_UPDATE_KEY, SAR_CHANGELOG, sarLaunch } from '../utils/sarUpdate';
/**
 * 全局版本更新提醒。
 *
 * 每個版本使用獨立的 localStorage key；用戶明確選擇「立刻體驗」或「先逛逛」後
 * 才會記為已讀，避免僅僅渲染過一次就把通知吞掉。
 */

import React from 'react';
import {
    ArrowRight, BellRinging, Briefcase, ChatTeardropDots, FileText, FolderOpen, PaperPlaneTilt, Sparkle, VideoCamera,
} from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { AppID } from '../types';
import { trackEvent } from '../utils/analytics';
import { requestProxyWorkerSettingsFocus } from '../utils/proxyWorker';

// 歷史 key —— 保留給備份兼容與舊版本日誌使用。
export const UPDATE_NOTIFICATION_KEY = 'sullyos_update_2026_04_seen';
export const UPDATE_NOTIFICATION_KEY_2026_05 = 'sullyos_update_2026_05_seen';
export const UPDATE_NOTIFICATION_KEY_2026_05_10 = 'sullyos_update_2026_05_10_seen';
export const UPDATE_NOTIFICATION_KEY_2026_05_17 = 'sullyos_update_2026_05_17_seen';
export const UPDATE_NOTIFICATION_KEY_2026_05_25 = 'sullyos_update_2026_05_25_seen';
export const UPDATE_NOTIFICATION_KEY_2026_06_05 = 'sullyos_update_2026_06_05_seen';
export const UPDATE_NOTIFICATION_KEY_2026_06_14 = 'sullyos_update_2026_06_14_seen';
export const UPDATE_NOTIFICATION_KEY_2026_06_21 = 'sullyos_update_2026_06_21_seen';
export const UPDATE_NOTIFICATION_KEY_2026_06_26 = 'sullyos_update_2026_06_26_seen';
export const UPDATE_NOTIFICATION_KEY_2026_07_10 = 'sullyos_update_2026_07_10_seen';
// 本次更新：主動消息 2.0。
export const UPDATE_NOTIFICATION_KEY_2026_08_03 = 'sullyos_update_2026_08_03_amsg2_seen';
// 本次更新：Live2D 視頻通話與陪伴桌面。
export const UPDATE_NOTIFICATION_KEY_2026_08_10 = 'sullyos_update_2026_08_10_live2d_seen';
// 本次更新：角色協同工作台。
export const UPDATE_NOTIFICATION_KEY_2026_08_30 = 'sullyos_update_2026_08_30_collaboration_seen';
// 例行維護補充：靜態網頁環境下部分聯網功能的數據流說明。
export const NETWORK_TRANSIT_NOTICE_KEY_2026_08 = 'sullyos_notice_2026_08_network_transit_seen';

export const FAQ_TARGET_SECTION_KEY = 'sullyos_faq_target_section';
export const CHANGELOG_2026_04 = 'changelog-2026-04';
export const CHANGELOG_2026_05 = 'changelog-2026-05';
export const CHANGELOG_2026_05_10 = 'changelog-2026-05-10';
export const CHANGELOG_2026_05_17 = 'changelog-2026-05-17';
export const CHANGELOG_2026_05_27 = 'changelog-2026-05-27';
export const CHANGELOG_2026_06_05 = 'changelog-2026-06-05';
export const CHANGELOG_2026_06_14 = 'changelog-2026-06-14';
export const CHANGELOG_2026_06_21 = 'changelog-2026-06-21';
export const CHANGELOG_2026_06_26 = 'changelog-2026-06-26';
export const CHANGELOG_2026_07_10 = 'changelog-2026-07-10';
export const CHANGELOG_2026_08_03 = 'changelog-2026-08-03';
export const CHANGELOG_2026_08_10 = 'changelog-2026-08-10';
export const CHANGELOG_2026_08_30 = 'changelog-2026-08-30';

/** storage 讀不出來時當成看過：寧可少彈一次，也別每次開機都糊用戶一臉。 */
const isUpdateSeen = (key: string): boolean => {
    try {
        return !!localStorage.getItem(key);
    } catch {
        return true;
    }
};

const markUpdateSeen = (key: string): void => {
    try {
        localStorage.setItem(key, Date.now().toString());
    } catch { /* storage 不可用時不阻斷按鈕行為 */ }
};

interface UpdatePopupProps {
    /** 這條用戶自己關掉了 —— 接著彈隊列裡的下一條。 */
    onDone: () => void;
    /**
     * 用戶點了「立刻體驗」這類按鈕、已經被帶去別的 App 了 —— 整串提醒收起來。
     * 後面那幾條不標已讀，下次啟動照彈，免得剛跳過去就被新彈窗蓋住。
     */
    onExit: () => void;
}

const COLLABORATION_FEATURES = [
    { icon: Briefcase, eyebrow: '兩種協同模式', text: '保留完整陪伴上下文，或只帶核心關係與少量相關記憶。' },
    { icon: FileText, eyebrow: '真正交付文件', text: '讀取 Word / PDF，製作並分享文檔，也能把成果交回日常聊天。' },
    { icon: FolderOpen, eyebrow: '製作、預覽、安裝', text: '氣泡、白框、界面、日記本、角色卡與世界書都能邊聊邊做。' },
] as const;

const CollaborationUpdatePopup: React.FC<UpdatePopupProps> = ({ onDone, onExit }) => {
    const { openApp } = useOS();

    React.useEffect(() => {
        trackEvent('弹出版本更新提醒', { 版本: CHANGELOG_2026_08_30 });
    }, []);

    const markSeen = () => markUpdateSeen(UPDATE_NOTIFICATION_KEY_2026_08_30);
    const handleOpenChat = () => {
        markSeen();
        openApp(AppID.Chat);
        onExit();
        trackEvent('点立刻体验', { 版本: CHANGELOG_2026_08_30 });
    };
    const handleGuide = () => {
        markSeen();
        try { sessionStorage.setItem(FAQ_TARGET_SECTION_KEY, CHANGELOG_2026_08_30); } catch { /* 打開手冊首頁 */ }
        openApp(AppID.FAQ);
        onExit();
        trackEvent('查看更新说明', { 版本: CHANGELOG_2026_08_30 });
    };
    const handleDismiss = () => {
        markSeen();
        onDone();
        trackEvent('跳过本次更新说明', { 版本: CHANGELOG_2026_08_30 });
    };

    return (
        <div
            className="collaboration-update-overlay fixed inset-0 z-[9998] flex items-start justify-center overflow-y-auto bg-[#10111a]/75 px-4 backdrop-blur-md"
            style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))', paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="collaboration-update-title"
        >
            <style>{`
                @keyframes collaborationUpdateIn { from { opacity:0; transform:translateY(22px) scale(.98); } to { opacity:1; transform:none; } }
                @keyframes collaborationUpdateReveal { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
                .collaboration-update-card{animation:collaborationUpdateIn 440ms cubic-bezier(.2,.8,.2,1) both}
                .collaboration-update-reveal{animation:collaborationUpdateReveal 380ms ease-out both}
                @media (prefers-reduced-motion:reduce){.collaboration-update-card,.collaboration-update-reveal{animation:none!important}}
            `}</style>
            <section className="collaboration-update-card relative my-auto w-full max-w-[23rem] overflow-hidden rounded-[2rem] bg-[#faf9f6] text-[#20212a] shadow-[0_28px_85px_rgba(0,0,0,.48)] ring-1 ring-white/20">
                <div className="relative overflow-hidden bg-[#20212a] px-6 pb-7 pt-6 text-white">
                    <div className="pointer-events-none absolute right-[-4rem] top-[-5rem] h-48 w-48 rounded-full border-[28px] border-[#7772ff]/20" aria-hidden="true" />
                    <div className="collaboration-update-reveal relative flex items-center justify-between">
                        <p className="text-[9px] font-bold tracking-[.3em] text-[#aaa6ff]">COLLABORATION · 2026.08.30</p>
                        <span className="rounded-full border border-[#8e89ff]/40 px-2.5 py-1 text-[9px] font-bold tracking-[.12em] text-[#c5c2ff]">NEW</span>
                    </div>
                    <div className="collaboration-update-reveal relative mt-8 max-w-[17rem]" style={{ animationDelay: '90ms' }}>
                        <p className="mb-2 text-[10px] font-semibold tracking-[.18em] text-[#9f9aff]">陪伴之外，一起把事情做好</p>
                        <h2 id="collaboration-update-title" className="text-[28px] font-black leading-[1.22] tracking-[-.04em]">角色現在有了<br />自己的協同工作台。</h2>
                        <p className="mt-3 text-[12px] leading-6 text-[#c9cad2]">還是同一個人，只是把更多注意力放在製作、檢查和交付上。</p>
                    </div>
                </div>

                <div className="px-6 pb-5 pt-5">
                    <div className="divide-y divide-[#e3e0d9]">
                        {COLLABORATION_FEATURES.map(({ icon: Icon, eyebrow, text }, index) => (
                            <div key={eyebrow} className="collaboration-update-reveal flex items-start gap-3 py-3 first:pt-0" style={{ animationDelay: `${170 + index * 65}ms` }}>
                                <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#ebe9ff] text-[#5650c9]"><Icon size={18} weight="duotone" /></div>
                                <div><p className="text-[12px] font-extrabold text-[#32303f]">{eyebrow}</p><p className="mt-1 text-[11px] leading-5 text-[#74737b]">{text}</p></div>
                            </div>
                        ))}
                    </div>

                    <div className="collaboration-update-reveal mt-3 border-l-2 border-[#6d67e8] bg-[#f0efff] px-3 py-2.5 text-[11px] leading-5 text-[#555172]" style={{ animationDelay: '370ms' }}>
                        入口：打開一位角色的 <b>ChatApp</b>，點輸入框左側的 <b>＋</b>，在加號菜單第一頁選擇 <b>「協同工作」</b>。
                    </div>

                    <div className="collaboration-update-reveal mt-5" style={{ animationDelay: '430ms' }}>
                        <button type="button" onClick={handleOpenChat} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#25242d] px-5 py-3.5 text-[13px] font-extrabold text-white transition-transform active:scale-[.975]">打開 ChatApp <ArrowRight size={16} weight="bold" /></button>
                        <div className="mt-1.5 grid grid-cols-2 gap-2">
                            <button type="button" onClick={handleGuide} className="rounded-xl py-2.5 text-[11px] font-semibold text-[#585465] active:bg-[#efedf0]">查看完整說明</button>
                            <button type="button" onClick={handleDismiss} className="rounded-xl py-2.5 text-[11px] font-semibold text-[#8b8990] active:bg-[#efedf0]">稍後看看</button>
                        </div>
                    </div>
                </div>
            </section>
        </div>
    );
};

const LIVE2D_FEATURES = [
    {
        icon: VideoCamera,
        eyebrow: '視頻通話',
        text: '電話裡切到「視頻」，VRM / Live2D 會跟著台詞做表情與動作。',
    },
    {
        icon: Sparkle,
        eyebrow: 'L2D 陪伴桌面',
        text: '在外觀裡啟用「觸感陪伴」，讓角色常駐桌面、回應觸摸並切換專屬框架。',
    },
] as const;

const Live2DUpdatePopup: React.FC<UpdatePopupProps> = ({ onDone, onExit }) => {
    const { openApp } = useOS();

    React.useEffect(() => {
        trackEvent('弹出版本更新提醒', { 版本: CHANGELOG_2026_08_10 });
    }, []);

    const handleGuide = () => {
        markUpdateSeen(UPDATE_NOTIFICATION_KEY_2026_08_10);
        try {
            sessionStorage.setItem(FAQ_TARGET_SECTION_KEY, CHANGELOG_2026_08_10);
        } catch { /* storage 不可用時仍可打開使用手冊首頁 */ }
        openApp(AppID.FAQ);
        onExit();
        trackEvent('点立刻体验', { 版本: CHANGELOG_2026_08_10 });
    };

    const handleDismiss = () => {
        markUpdateSeen(UPDATE_NOTIFICATION_KEY_2026_08_10);
        onDone();
        trackEvent('跳过本次更新说明', { 版本: CHANGELOG_2026_08_10 });
    };

    return (
        <div
            className="live2d-update-overlay fixed inset-0 z-[9998] flex items-start justify-center overflow-y-auto bg-[#070b14]/80 px-4 backdrop-blur-md"
            style={{
                paddingTop: 'max(1rem, env(safe-area-inset-top))',
                paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
            }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="live2d-update-title"
        >
            <style>{`
                @keyframes live2dUpdateOverlayIn { from { opacity: 0; } to { opacity: 1; } }
                @keyframes live2dUpdateCardIn {
                    from { opacity: 0; transform: translateY(22px) scale(.975); }
                    to { opacity: 1; transform: translateY(0) scale(1); }
                }
                @keyframes live2dUpdateReveal {
                    from { opacity: 0; transform: translateY(8px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                @keyframes live2dSignal { 0%, 100% { opacity: .35; } 50% { opacity: .9; } }
                .live2d-update-overlay { animation: live2dUpdateOverlayIn 220ms ease-out both; }
                .live2d-update-card { animation: live2dUpdateCardIn 460ms cubic-bezier(.2,.8,.2,1) both; }
                .live2d-update-reveal { animation: live2dUpdateReveal 420ms ease-out both; }
                .live2d-update-signal { animation: live2dSignal 2.4s ease-in-out infinite; }
                @media (prefers-reduced-motion: reduce) {
                    .live2d-update-overlay,
                    .live2d-update-card,
                    .live2d-update-reveal,
                    .live2d-update-signal { animation: none !important; }
                    .live2d-update-action { transition: none !important; }
                }
            `}</style>

            <section className="live2d-update-card relative my-auto w-full max-w-[23rem] overflow-hidden rounded-[2rem] bg-[#f5f7fb] text-[#17202b] shadow-[0_28px_90px_rgba(0,0,0,0.58)] ring-1 ring-white/20">
                <div className="relative min-h-[15.5rem] overflow-hidden bg-[linear-gradient(150deg,#111a2c_0%,#18283b_52%,#253a43_100%)] px-6 pb-7 pt-6 text-white">
                    <div className="pointer-events-none absolute -right-12 -top-10 h-44 w-44 rounded-full bg-[#6fffe1]/15 blur-3xl" aria-hidden="true" />
                    <div className="pointer-events-none absolute bottom-0 right-3 h-[12.5rem] w-[10rem]" aria-hidden="true">
                        <div className="absolute left-1/2 top-0 h-16 w-16 -translate-x-1/2 rounded-full border border-[#9effec]/25 bg-[#82dec8]/10 shadow-[0_0_32px_rgba(111,255,225,.12)]" />
                        <div className="absolute bottom-0 left-1/2 h-36 w-28 -translate-x-1/2 rounded-t-[50%] border-x border-t border-[#9effec]/20 bg-[linear-gradient(180deg,rgba(111,255,225,.08),rgba(58,91,104,.25))]" />
                        <div className="absolute inset-y-4 left-1/2 w-px bg-[#9effec]/20" />
                    </div>
                    <div className="live2d-update-signal pointer-events-none absolute inset-x-5 bottom-5 h-px bg-[linear-gradient(90deg,transparent,#76f7dc,transparent)]" aria-hidden="true" />

                    <div className="live2d-update-reveal relative flex items-center justify-between" style={{ animationDelay: '80ms' }}>
                        <p className="text-[9px] font-bold tracking-[0.3em] text-[#8be9d5]">LIVE2D · NOW IN FRAME</p>
                        <span className="rounded-full border border-[#8be9d5]/40 bg-[#8be9d5]/10 px-2.5 py-1 text-[9px] font-bold tracking-[0.14em] text-[#b8f8ea]">NEW · L2D</span>
                    </div>

                    <div className="live2d-update-reveal relative mt-8 max-w-[14.5rem]" style={{ animationDelay: '145ms' }}>
                        <p className="mb-2 text-[10px] font-semibold tracking-[0.22em] text-[#74d8c4]">從一張頭像，到真實在場</p>
                        <h2 id="live2d-update-title" className="text-[27px] font-black leading-[1.22] tracking-[-0.035em]">
                            這一次，ta 真正<br />出現在屏幕裡。
                        </h2>
                        <p className="mt-3 text-[12px] leading-6 text-[#c5d4dc]">
                            一套模型，兩種新的陪伴方式。
                        </p>
                    </div>
                </div>

                <div className="px-6 pb-5 pt-5">
                    <div className="divide-y divide-[#dce3e8]">
                        {LIVE2D_FEATURES.map(({ icon: Icon, eyebrow, text }, index) => (
                            <div
                                key={eyebrow}
                                className="live2d-update-reveal flex items-start gap-3 py-3 first:pt-0"
                                style={{ animationDelay: `${230 + index * 75}ms` }}
                            >
                                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#dff7f1] text-[#187864]">
                                    <Icon size={18} weight="duotone" />
                                </div>
                                <div className="min-w-0">
                                    <p className="text-[12px] font-extrabold tracking-[0.07em] text-[#1c4d45]">{eyebrow}</p>
                                    <p className="mt-1 text-[12px] leading-5 text-[#67747d]">{text}</p>
                                </div>
                            </div>
                        ))}
                    </div>

                    <p className="live2d-update-reveal mt-2 border-l-2 border-[#62cbb5] pl-3 text-[10px] leading-[1.7] text-[#7a878f]" style={{ animationDelay: '410ms' }}>
                        模型入口在「電話」的視頻模式；桌面入口在「外觀 → 觸感陪伴」。
                    </p>

                    <div className="live2d-update-reveal mt-5" style={{ animationDelay: '480ms' }}>
                        <button
                            type="button"
                            onClick={handleGuide}
                            className="live2d-update-action flex w-full items-center justify-center gap-2 rounded-2xl bg-[#176f60] px-5 py-3.5 text-[13px] font-extrabold tracking-[0.04em] text-white shadow-[0_10px_24px_rgba(23,111,96,0.25)] transition-transform duration-200 active:scale-[0.975]"
                        >
                            查看本次更新
                            <ArrowRight size={16} weight="bold" />
                        </button>
                        <button
                            type="button"
                            onClick={handleDismiss}
                            className="live2d-update-action mt-1.5 w-full py-2.5 text-[11px] font-semibold text-[#89949a] transition-colors active:text-[#4d585d]"
                        >
                            稍後看看
                        </button>
                    </div>
                </div>
            </section>
        </div>
    );
};

const AMSG2_FEATURES = [
    {
        icon: BellRinging,
        eyebrow: '到點就響',
        text: 'App 關著、手機鎖著，消息一樣送得到。',
    },
    {
        icon: ChatTeardropDots,
        eyebrow: '說一聲就行',
        text: '「明早八點叫我」，ta 自己把任務排上。',
    },
    {
        icon: PaperPlaneTilt,
        eyebrow: '話沒說完',
        text: '後台順手排下一條，事辦完了回來報備。',
    },
] as const;

const Amsg2UpdatePopup: React.FC<UpdatePopupProps> = ({ onDone, onExit }) => {
    const { openApp } = useOS();

    React.useEffect(() => {
        trackEvent('弹出版本更新提醒', { 版本: CHANGELOG_2026_08_03 });
    }, []);

    const handleGuide = () => {
        markUpdateSeen(UPDATE_NOTIFICATION_KEY_2026_08_03);
        // 直接展開這一版的更新說明：怎麼部署、有哪些邊界都寫在那頁裡。
        try {
            sessionStorage.setItem(FAQ_TARGET_SECTION_KEY, CHANGELOG_2026_08_03);
        } catch { /* storage 不可用就退回 FAQ 首頁，別攔著跳轉 */ }
        openApp(AppID.FAQ);
        onExit();
        trackEvent('点立刻体验', { 版本: CHANGELOG_2026_08_03 });
    };

    const handleDismiss = () => {
        markUpdateSeen(UPDATE_NOTIFICATION_KEY_2026_08_03);
        onDone();
        trackEvent('跳过本次更新说明', { 版本: CHANGELOG_2026_08_03 });
    };

    return (
        <div
            className="amsg-brief-overlay fixed inset-0 z-[9998] flex items-start justify-center overflow-y-auto bg-[#0c1020]/78 px-4 backdrop-blur-sm"
            style={{
                paddingTop: 'max(1rem, env(safe-area-inset-top))',
                paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
            }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="amsg-brief-title"
        >
            <style>{`
                @keyframes amsgBriefOverlayIn {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }
                @keyframes amsgBriefCardIn {
                    from { opacity: 0; transform: translateY(24px) scale(.975); }
                    to { opacity: 1; transform: translateY(0) scale(1); }
                }
                @keyframes amsgBriefReveal {
                    from { opacity: 0; transform: translateY(9px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                .amsg-brief-overlay { animation: amsgBriefOverlayIn 220ms ease-out both; }
                .amsg-brief-card { animation: amsgBriefCardIn 460ms cubic-bezier(.2,.8,.2,1) both; }
                .amsg-brief-reveal { animation: amsgBriefReveal 420ms ease-out both; }
                @media (prefers-reduced-motion: reduce) {
                    .amsg-brief-overlay,
                    .amsg-brief-card,
                    .amsg-brief-reveal { animation: none !important; }
                    .amsg-brief-action { transition: none !important; }
                }
            `}</style>

            <section className="amsg-brief-card relative my-auto w-full max-w-[23rem] overflow-hidden rounded-[2rem] bg-[#f7f8fd] text-[#232838] shadow-[0_28px_80px_rgba(8,11,26,0.5)] ring-1 ring-white/20">
                {/* 上半截是一塊深夜裡的鎖屏：功能本身長什麼樣，比講一遍更省事 */}
                <div className="relative overflow-hidden bg-[#171d33] px-6 pb-7 pt-6 text-[#f3f5ff]">
                    <div className="pointer-events-none absolute -right-12 -top-14 h-44 w-44 rounded-full bg-[#5b7cfa]/25 blur-2xl" aria-hidden="true" />

                    <div className="amsg-brief-reveal relative flex items-center justify-between" style={{ animationDelay: '90ms' }}>
                        <p className="text-[9px] font-bold tracking-[0.32em] text-[#93a9ff]">LOCK SCREEN · 02:47</p>
                        <span className="rounded-full border border-[#93a9ff]/45 px-2.5 py-1 text-[9px] font-bold tracking-[0.16em] text-[#b9c6ff]">NEW · 主動消息</span>
                    </div>

                    <div className="amsg-brief-reveal relative mt-7" style={{ animationDelay: '150ms' }}>
                        <p className="mb-2 text-[10px] font-semibold tracking-[0.24em] text-[#8fa4f5]">主動消息 2.0</p>
                        <h2 id="amsg-brief-title" className="max-w-[18rem] text-[27px] font-black leading-[1.25] tracking-[-0.035em]">
                            這回換 ta<br />自己挑時間找你。
                        </h2>
                        <p className="mt-3 text-[12px] leading-6 text-[#c6cce6]">
                            消息在後台生成、直接推到手機，你不用一直開著 App。
                        </p>
                    </div>

                    <div
                        className="amsg-brief-reveal relative mt-5 flex items-start gap-3 rounded-2xl bg-white/[0.12] px-3.5 py-3 ring-1 ring-white/15"
                        style={{ animationDelay: '210ms' }}
                    >
                        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#5b7cfa]/85 text-white">
                            <BellRinging size={15} weight="fill" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="flex items-baseline justify-between gap-2">
                                <p className="truncate text-[11px] font-bold text-white">Sully</p>
                                <span className="shrink-0 text-[9px] text-[#aab4d8]">02:47</span>
                            </div>
                            <p className="mt-0.5 text-[11px] leading-4 text-[#dfe4f7]">湯燉好了，說好要叫你的——起來喝一口再睡。</p>
                        </div>
                    </div>

                    <div className="absolute -bottom-3 -left-3 h-6 w-6 rounded-full bg-[#f7f8fd]" aria-hidden="true" />
                    <div className="absolute -bottom-3 -right-3 h-6 w-6 rounded-full bg-[#f7f8fd]" aria-hidden="true" />
                </div>

                <div className="px-6 pb-5 pt-5">
                    <div className="divide-y divide-[#dde1ef]">
                        {AMSG2_FEATURES.map(({ icon: Icon, eyebrow, text }, index) => (
                            <div
                                key={eyebrow}
                                className="amsg-brief-reveal flex items-start gap-3 py-3 first:pt-0"
                                style={{ animationDelay: `${260 + index * 70}ms` }}
                            >
                                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#e6ebff] text-[#3f5fd4]">
                                    <Icon size={18} weight="duotone" />
                                </div>
                                <div className="min-w-0">
                                    <p className="text-[12px] font-extrabold tracking-[0.08em] text-[#39456e]">{eyebrow}</p>
                                    <p className="mt-1 text-[12px] leading-5 text-[#6c7186]">{text}</p>
                                </div>
                            </div>
                        ))}
                    </div>

                    <p className="amsg-brief-reveal mt-2 border-l-2 border-[#8fa4f5] pl-3 text-[10px] leading-[1.7] text-[#848a9d]" style={{ animationDelay: '500ms' }}>
                        要用得先自己搭一個小後端，全程在網頁上點，大約 15 分鐘；步驟和邊界都寫在說明裡。
                    </p>

                    <div className="amsg-brief-reveal mt-5" style={{ animationDelay: '560ms' }}>
                        <button
                            type="button"
                            onClick={handleGuide}
                            className="amsg-brief-action flex w-full items-center justify-center gap-2 rounded-2xl bg-[#3f5fd4] px-5 py-3.5 text-[13px] font-extrabold tracking-[0.05em] text-white shadow-[0_10px_24px_rgba(63,95,212,0.28)] transition-transform duration-200 active:scale-[0.975]"
                        >
                            看看怎麼開
                            <ArrowRight size={16} weight="bold" />
                        </button>
                        <button
                            type="button"
                            onClick={handleDismiss}
                            className="amsg-brief-action mt-1.5 w-full py-2.5 text-[11px] font-semibold text-[#8b90a2] transition-colors active:text-[#4a4f60]"
                        >
                            先不折騰
                        </button>
                    </div>
                </div>
            </section>
        </div>
    );
};

const NetworkTransitNoticePopup: React.FC<UpdatePopupProps> = ({ onDone, onExit }) => {
    const { openApp } = useOS();

    React.useEffect(() => {
        trackEvent('弹出联网方式说明', { 版本: 'network-transit-2026-08' });
    }, []);

    const handleDismiss = () => {
        markUpdateSeen(NETWORK_TRANSIT_NOTICE_KEY_2026_08);
        onDone();
        trackEvent('知悉联网方式说明', { 去向: '关闭' });
    };

    const handleSettings = () => {
        markUpdateSeen(NETWORK_TRANSIT_NOTICE_KEY_2026_08);
        requestProxyWorkerSettingsFocus();
        openApp(AppID.Settings);
        onExit();
        trackEvent('知悉联网方式说明', { 去向: '设置' });
    };

    return (
        <div
            className="fixed inset-0 z-[9998] flex items-center justify-center overflow-hidden bg-[#111827]/65 px-4 backdrop-blur-sm"
            style={{
                paddingTop: 'max(1rem, env(safe-area-inset-top))',
                paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
            }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="network-transit-notice-title"
        >
            <section className="relative flex max-h-full w-full max-w-[23rem] flex-col overflow-hidden rounded-[2rem] bg-[#f8fafc] text-slate-700 shadow-[0_24px_80px_rgba(15,23,42,0.4)] ring-1 ring-white/30">
                <header className="shrink-0 bg-[linear-gradient(145deg,#334155,#475569)] px-6 pb-5 pt-6 text-white">
                    <div className="mb-3 inline-flex rounded-full bg-white/10 px-2.5 py-1 text-[9px] font-bold tracking-[0.16em] text-slate-200 ring-1 ring-white/15">
                        例行維護 · 說明補充
                    </div>
                    <h2 id="network-transit-notice-title" className="text-[21px] font-black tracking-[-0.02em]">
                        關於部分聯網功能
                    </h2>
                    <p className="mt-2 text-[11px] leading-5 text-slate-300">
                        這次只補充此前寫得不夠清楚的聯網路徑，功能和使用方式沒有變化。
                    </p>
                </header>

                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-6 py-5 text-[12px] leading-[1.75]">
                    <p>
                        例行排查中，我們發現部分功能對“請求會怎麼走”的說明不夠清楚。靜態網頁下，以下入口會在你實際啟用或使用時經過網絡 Worker：
                    </p>
                    <ul className="space-y-1.5 rounded-2xl bg-white px-3.5 py-3 text-[11px] leading-[1.65] ring-1 ring-slate-200/70">
                        <li><b>聊天 / 實時感知：</b>Brave 聯網搜索與新聞、Notion / 飛書日記、網頁鏈接讀取</li>
                        <li><b>音樂 App：</b>網易雲登錄狀態、搜索、歌單與播放相關請求</li>
                        <li><b>小紅書 Lite：</b>登錄校驗、搜索瀏覽、互動與發佈</li>
                        <li><b>語音 / 寫歌：</b>Fish Audio 語音合成、Replicate / ACE-Step</li>
                        <li><b>點單：</b>麥當勞與瑞幸 MCP</li>
                        <li><b>雲備份：</b>WebDAV；GitHub 的 Worker 中轉路徑當前默認關閉，僅在你手動開啟後使用</li>
                    </ul>
                    <p>
                        這些請求經過 Worker，只是為了替靜態網頁完成跨域請求並把結果返回。項目代碼不會將請求內容寫入數據庫、對象存儲或業務日誌；轉發完成後，項目側沒有可供回看或恢復的內容副本。Worker 源碼公開可查。
                    </p>
                    <div className="rounded-2xl bg-sky-50 px-3.5 py-3 text-[11px] leading-[1.7] text-sky-900 ring-1 ring-sky-100">
                        <p>
                            這和你平時使用<b>聯網搜索、第三方登錄或在線音樂</b>時的接口請求相近：只有主動使用對應功能時，當次必要數據才會經過服務端，不會把 Soren 的聊天記錄或本地資料整體上傳。
                        </p>
                        <p className="mt-1.5">
                            如果你平時能夠接受 API 中轉站，可以把它作為參照：API 中轉站能夠接觸完整的模型請求與聊天內容；這裡的 Worker 只接觸對應功能的當次請求，並在轉發後不保留請求內容。
                        </p>
                    </div>
                    <p className="text-[11px] text-slate-500">
                        介意中轉的話，可以關閉對應功能，或在設置中換成自己部署的 Worker。
                    </p>
                </div>

                <footer className="grid shrink-0 grid-cols-[0.9fr_1.1fr] gap-2.5 border-t border-slate-200/70 bg-[#f8fafc] px-6 pb-6 pt-3">
                    <button
                        type="button"
                        onClick={handleSettings}
                        className="rounded-2xl bg-slate-100 px-3 py-3 text-[11px] font-bold text-slate-600 transition-transform active:scale-[0.98]"
                    >
                        查看代理設置
                    </button>
                    <button
                        type="button"
                        onClick={handleDismiss}
                        className="rounded-2xl bg-slate-700 px-3 py-3 text-[12px] font-extrabold text-white shadow-lg shadow-slate-300 transition-transform active:scale-[0.98]"
                    >
                        我知道了
                    </button>
                </footer>
            </section>
        </div>
    );
};

/**
 * 這一批要彈的更新提醒，新的排前面。
 *
 * 同時上線好幾個功能時，各自值得單獨說一次，所以排成隊列：關掉一條接著彈下一條，
 * 已讀各記各的 key——點掉其中一條不影響另一條還會不會露面。
 */
const SARUpdateAnnouncement: React.FC<UpdatePopupProps> = ({ onDone, onExit }) => {
    const { openApp } = useOS();
    return <SARUpdatePopup onDone={onDone} onVisit={() => {
        sarLaunch.request(); openApp(AppID.VRWorld); onExit();
    }} onGuide={() => {
        try { sessionStorage.setItem(FAQ_TARGET_SECTION_KEY, SAR_CHANGELOG); } catch { /* 手冊首頁仍可打開 */ }
        openApp(AppID.FAQ); onExit();
    }}/>;
};

const UPDATE_QUEUE: { key: string; render: (props: UpdatePopupProps) => React.ReactNode }[] = [
    { key: SAR_UPDATE_KEY, render: (props) => <SARUpdateAnnouncement {...props} /> },
    { key: NETWORK_TRANSIT_NOTICE_KEY_2026_08, render: (props) => <NetworkTransitNoticePopup {...props} /> },
    { key: UPDATE_NOTIFICATION_KEY_2026_08_10, render: (props) => <Live2DUpdatePopup {...props} /> },
];

export const shouldShowUpdateNotification = (): boolean => UPDATE_QUEUE.some((entry) => !isUpdateSeen(entry.key));

interface UpdateNotificationControllerProps {
    onClose: () => void;
}

export const UpdateNotificationController: React.FC<UpdateNotificationControllerProps> = ({ onClose }) => {
    // 進場時把沒看過的挑出來定住。每次渲染重算的話，當前這條一被標記已讀就會自己從隊列裡
    // 消失、直接跳到下一條，用戶還沒來得及點——推進隊列的只能是下面 onDone 那一下。
    const [pending, setPending] = React.useState(() => UPDATE_QUEUE.filter((entry) => !isUpdateSeen(entry.key)));
    const current = pending[0];

    React.useEffect(() => {
        if (!current) onClose();
    }, [current, onClose]);

    if (!current) return null;

    return (
        <React.Fragment key={current.key}>
            {current.render({
                onDone: () => setPending((rest) => rest.slice(1)),
                onExit: onClose,
            })}
        </React.Fragment>
    );
};
