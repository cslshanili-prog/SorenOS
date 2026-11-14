import { SAR_CHANGELOG } from '../utils/sarUpdate';
import { FAQ_TARGET_CHANGELOG_LIST, SOREN_CHANGELOG_ENTRIES } from '../utils/sorenChangelog';

import React, { useEffect, useState } from 'react';
import { useOS } from '../context/OSContext';
import { Sparkle } from '@phosphor-icons/react';
import {
    FAQ_TARGET_SECTION_KEY,
    CHANGELOG_2026_04,
    CHANGELOG_2026_05,
    CHANGELOG_2026_05_10,
    CHANGELOG_2026_05_17,
    CHANGELOG_2026_05_27,
    CHANGELOG_2026_06_05,
    CHANGELOG_2026_06_14,
    CHANGELOG_2026_06_21,
    CHANGELOG_2026_06_26,
    CHANGELOG_2026_07_10,
    CHANGELOG_2026_08_03,
    CHANGELOG_2026_08_10,
    CHANGELOG_2026_08_30,
} from '../components/UpdateNotificationEvent';
import { trackEvent } from '../utils/analytics';
import { FAQ_DATA } from '../utils/faqData';


interface ChangelogEntry {
    id: string;
    title: string;
    subtitle: string;
    date: string;
    src: string;
    accent: string;
}

const CHANGELOG_ENTRIES: ChangelogEntry[] = [
    // Soren 自己的更新（2026-09-14 起），新的在前；清單在 utils/sorenChangelog.ts
    ...SOREN_CHANGELOG_ENTRIES,
    {
        id: SAR_CHANGELOG,
        title: '2026 年 9 月 11 日 · 彼方來信 · SAR',
        subtitle: 'SAR 活動室與星級故事 · 釣魚和恐龍花園 · 芯片、推演與模塊 · 私聊發送習慣 · PNG 圖片分享',
        date: '2026-09-11',
        src: 'changelogs/2026-9-11.html',
        accent: 'from-emerald-50 to-amber-50 border-emerald-200',
    },
    {
        id: CHANGELOG_2026_08_30,
        title: '2026 年 8 月 30 日 · 協同工作台',
        subtitle: '角色協同工作雙模式 · Word / PDF 與文件交付 · 可安裝美化、角色卡和世界書 · 獨立文件庫與歸檔記憶 · 協同數據隨系統備份導入導出',
        date: '2026-08-30',
        src: 'changelogs/2026-8-30.html',
        accent: 'from-indigo-100 to-stone-100 border-indigo-200',
    },
    {
        id: CHANGELOG_2026_08_10,
        title: '2026 年 8 月 10 日 · Live2D 陪伴升級',
        subtitle: '新增 VRM / Live2D 視頻通話 · 新增面向 Live2D 的「觸感陪伴」桌面主題',
        date: '2026-08-10',
        src: 'changelogs/2026-8-10.html',
        accent: 'from-emerald-100 to-sky-100 border-emerald-200',
    },
    {
        id: CHANGELOG_2026_08_03,
        title: '2026 年 8 月 3 日 · 主動消息 2.0',
        subtitle: '角色到點自己發消息，App 關著也收得到 · 三種排任務的方式（面板 / 聊天裡說一句 / 角色給自己排）· 到點現取時間天氣節日熱搜與當天作息 · 連發不重樣、只做事時不推空消息 · 後台照樣能用 MCP 與搜索 · 想找話說的那類會讓路，鬧鐘和承諾照發 · 需自部署 Cloudflare Worker + D1',
        date: '2026-08-03',
        src: 'changelogs/2026-8-3.html',
        accent: 'from-violet-100 to-sky-100 border-violet-200',
    },
    {
        id: CHANGELOG_2026_07_10,
        title: '2026 年 7 月 10 日 · 生活統計',
        subtitle: '檔案「生活統計」四模塊 + 角色注入代記 · 彼方全服寫詩 · 捏人換畫風 + PSD 批量導入 + 手辦區 · 神經鏈接角色分組 · 小屋裝修大升級 + 家園「凌晨」段 · 記憶宮殿門牌（測試中）· 專屬提示鈴聲 · 壁紙/小屋圖改存 Blob · 一大批 iOS 適配與散修',
        date: '2026-07-10',
        src: 'changelogs/2026-7-10.html',
        accent: 'from-rose-100 to-violet-100 border-rose-200',
    },
    {
        id: CHANGELOG_2026_06_26,
        title: '2026 年 6 月 26 日 · 夢境盲盒',
        subtitle: '小屋夢境系統（進屋刷新 · 集齊 13 款夢境盲盒）· 查手機聯繫人模式 + 智能體（char 的小手機）· 見面狀態欄與設置前移 · 日程窺得更細 · 時間感知歸位神經鏈接 · TTS 新增魚聲 API',
        date: '2026-06-26',
        src: 'changelogs/2026-6-26.html',
        accent: 'from-indigo-100 to-violet-100 border-indigo-200',
    },
    {
        id: CHANGELOG_2026_06_21,
        title: '2026 年 6 月 21 日 · 查手機翻新',
        subtitle: '查手機 UI 翻新 + 新增「人格模擬」（可指定一場 Screenlife 演出，設置裡可選是否發送給角色）· 外觀新增手遊風 · 小紅書 Lite 可直接分享帖子給角色',
        date: '2026-06-21',
        src: 'changelogs/2026-6-21.html',
        accent: 'from-violet-100 to-fuchsia-100 border-violet-200',
    },
    {
        id: CHANGELOG_2026_06_14,
        title: '2026 年 6 月 14 日 · 家園上線',
        subtitle: '小屋翻新 · 「家園」多角色大世界（真實時間 / 模擬時間二選一）· 瑞幸咖啡點單',
        date: '2026-06-14',
        src: 'changelogs/2026-6-14.html',
        accent: 'from-violet-100 to-purple-100 border-violet-200',
    },
    {
        id: CHANGELOG_2026_06_05,
        title: '2026 年 6 月 5 日 · 彼方上線',
        subtitle: '角色自主登入的 VR 小世界 · 郵局漂流信 · 留言簿原話上牆 · 隱藏小人',
        date: '2026-06-05',
        src: 'changelogs/2026-6-5.html',
        accent: 'from-indigo-100 to-purple-100 border-indigo-200',
    },
    {
        id: CHANGELOG_2026_05_27,
        title: '2026 年 5 月 27 日 · 小更新',
        subtitle: '情緒 buff 也接入 Instant Push · 發完即走，聊天和情緒都不用一直開著 App（附配置視頻）',
        date: '2026-05-27',
        src: 'changelogs/2026-5-27.html',
        accent: 'from-rose-100 to-amber-100 border-rose-200',
    },
    {
        id: CHANGELOG_2026_05_17,
        title: '2026 年 5 月 17 日 · 小更新',
        subtitle: 'Instant Push 上線 · 發完文本就能鎖屏走人，AI 回覆自己回來',
        date: '2026-05-17',
        src: 'changelogs/2026-5-17.html',
        accent: 'from-teal-100 to-sky-100 border-teal-200',
    },
    {
        id: CHANGELOG_2026_05_10,
        title: '2026 年 5 月 10 日 · 小更新',
        subtitle: '「心象」上線 · 模型思考鏈可視化 + 約會（見面模式）bug 修復',
        date: '2026-05-10',
        src: 'changelogs/2026-5-10.html',
        accent: 'from-purple-100 to-indigo-100 border-purple-200',
    },
    {
        id: CHANGELOG_2026_05,
        title: '2026 年 5 月更新',
        subtitle: 'GitHub 備份 · 音樂 App 網絡優化 · 麥當勞 MCP · SULLY 默認皮膚 等',
        date: '2026-05',
        src: 'changelogs/2026-5.html',
        accent: 'from-amber-100 to-orange-100 border-amber-200',
    },
    {
        id: CHANGELOG_2026_04,
        title: '2026 年 4 月更新',
        subtitle: '向量記憶 · 更新說明與配置指南',
        date: '2026-04',
        src: 'changelogs/2026-4.html',
        accent: 'from-indigo-100 to-purple-100 border-indigo-200',
    },
];

type Tab = 'faq' | 'changelog';

const FAQApp: React.FC = () => {
    const { closeApp } = useOS();
    const [tab, setTab] = useState<Tab>('faq');
    const [activeChangelog, setActiveChangelog] = useState<ChangelogEntry | null>(null);

    useEffect(() => {
        try {
            const target = sessionStorage.getItem(FAQ_TARGET_SECTION_KEY);
            if (target) {
                sessionStorage.removeItem(FAQ_TARGET_SECTION_KEY);
                if (target === FAQ_TARGET_CHANGELOG_LIST) { setTab('changelog'); return; }
                const entry = CHANGELOG_ENTRIES.find(e => e.id === target);
                if (entry) {
                    setTab('changelog');
                    setActiveChangelog(entry);
                }
            }
        } catch { /* ignore */ }
    }, []);

    const handleBack = () => {
        if (activeChangelog) {
            setActiveChangelog(null);
            return;
        }
        closeApp();
    };

    const headerTitle = activeChangelog
        ? activeChangelog.title
        : tab === 'changelog' ? '更新日誌' : '常見問題';

    return (
        <div className="h-full w-full bg-slate-50 flex flex-col font-light">
            {/* Header */}
            <div className="bg-white/70 backdrop-blur-md border-b border-white/40 shrink-0 sticky top-0 z-10" style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="flex items-center px-4 py-3">
                    <div className="flex items-center gap-2 w-full">
                        <button onClick={handleBack} className="p-2 -ml-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                            </svg>
                        </button>
                        <h1 className="text-xl font-medium text-slate-700 tracking-wide">{headerTitle}</h1>
                    </div>
                </div>
            </div>

            {/* Tab switcher (hidden when viewing a specific changelog) */}
            {!activeChangelog && (
                <div className="shrink-0 bg-white/60 backdrop-blur-md border-b border-slate-200/60 px-4 py-2">
                    <div className="inline-flex bg-slate-100 rounded-full p-1 gap-1">
                        <button
                            onClick={() => { setTab('faq'); trackEvent('切换常见问题标签页', { tab: 'faq' }); }}
                            className={`px-4 py-1.5 rounded-full text-xs font-bold transition-all ${
                                tab === 'faq'
                                    ? 'bg-white text-indigo-600 shadow-sm'
                                    : 'text-slate-500 active:scale-95'
                            }`}
                        >
                            常見問題
                        </button>
                        <button
                            onClick={() => { setTab('changelog'); trackEvent('切换常见问题标签页', { tab: 'changelog' }); }}
                            className={`px-4 py-1.5 rounded-full text-xs font-bold transition-all ${
                                tab === 'changelog'
                                    ? 'bg-white text-indigo-600 shadow-sm'
                                    : 'text-slate-500 active:scale-95'
                            }`}
                        >
                            更新日誌
                        </button>
                    </div>
                </div>
            )}

            {/* Content area */}
            {activeChangelog ? (
                <div className="flex-1 bg-[#faf7f2] overflow-hidden">
                    <iframe
                        key={activeChangelog.id}
                        src={activeChangelog.src}
                        title={activeChangelog.title}
                        className="w-full h-full border-0"
                    />
                </div>
            ) : tab === 'faq' ? (
                <div className="flex-1 overflow-y-auto p-5 pb-20 no-scrollbar">
                    {/* Intro Banner */}
                    <div className="bg-gradient-to-r from-pink-100 to-indigo-100 p-5 rounded-3xl mb-6 shadow-sm">
                        <h2 className="text-lg font-bold text-slate-700 mb-2 flex items-center gap-2">
                            <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f338.png" className="w-5 h-5 inline" alt="" /> 新手必讀小貼士 <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f338.png" className="w-5 h-5 inline" alt="" />
                        </h2>
                        <p className="text-xs text-slate-600 leading-relaxed opacity-90">
                            歡迎來到這裡！為了讓你和角色的互動更順暢，如果遇到問題，請先看看下面有沒有答案哦~
                            <br/>
                            (如果不看公告直接提問，大家可能不知道怎麼幫你，也會消耗群友的耐心呢)
                        </p>
                    </div>

                    {/* FAQ Cards */}
                    <div className="space-y-4">
                        {FAQ_DATA.map((item, index) => (
                            <div key={index} className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100 animate-slide-up" style={{ animationDelay: `${index * 50}ms` }}>
                                <div className="flex items-start gap-4">
                                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xl shrink-0 ${item.color.split(' ')[0]}`}>
                                        <img src={item.icon} className="w-5 h-5 inline" alt="" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <h3 className={`text-sm font-bold mb-2 ${item.color.split(' ')[1]}`}>{item.q}</h3>

                                        <div className="space-y-2">
                                            <div className="flex gap-2 items-start">
                                                <span className="text-xs font-bold text-slate-400 shrink-0 mt-0.5">原因:</span>
                                                <p className="text-xs text-slate-600 leading-relaxed whitespace-pre-wrap">{item.reason}</p>
                                            </div>
                                            <div className="flex gap-2 items-start bg-slate-50 p-2 rounded-lg">
                                                <span className="text-xs font-bold text-green-500 shrink-0 mt-0.5 flex items-center gap-0.5"><Sparkle size={12} weight="fill" /> 解決:</span>
                                                <p className="text-xs text-slate-700 leading-relaxed whitespace-pre-wrap font-medium">{item.solution}</p>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>

                    <div className="mt-8 text-center text-[10px] text-slate-400">
                        Soren Help Center • v1.1
                    </div>
                </div>
            ) : (
                <div className="flex-1 overflow-y-auto p-5 pb-20 no-scrollbar">
                    <div className="bg-gradient-to-r from-indigo-100 to-purple-100 p-5 rounded-3xl mb-6 shadow-sm">
                        <h2 className="text-lg font-bold text-slate-700 mb-2 flex items-center gap-2">
                            <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/2728.png" className="w-5 h-5 inline" alt="" /> 版本更新記錄
                        </h2>
                        <p className="text-xs text-slate-600 leading-relaxed opacity-90">
                            這裡存放每一次重要更新的詳細說明。點擊卡片查看完整內容。
                        </p>
                    </div>

                    <div className="space-y-3">
                        {CHANGELOG_ENTRIES.map((entry) => (
                            <button
                                key={entry.id}
                                onClick={() => setActiveChangelog(entry)}
                                className={`w-full text-left bg-gradient-to-br ${entry.accent} border rounded-2xl p-4 shadow-sm active:scale-[0.98] transition-transform`}
                            >
                                <div className="flex items-start gap-3">
                                    <div className="w-12 h-12 rounded-2xl bg-white/70 flex items-center justify-center shrink-0 shadow-sm">
                                        <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4d6.png" className="w-6 h-6" alt="" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-baseline justify-between gap-2">
                                            <h3 className="text-sm font-bold text-slate-800">{entry.title}</h3>
                                            <span className="text-[10px] text-slate-500 font-mono shrink-0">{entry.date}</span>
                                        </div>
                                        <p className="text-[11px] text-slate-600 mt-1 leading-relaxed">{entry.subtitle}</p>
                                        <div className="mt-2 text-[11px] font-bold text-indigo-600 flex items-center gap-1">
                                            查看完整更新說明
                                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3"><path d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
                                        </div>
                                    </div>
                                </div>
                            </button>
                        ))}
                    </div>

                    <div className="mt-8 text-center text-[10px] text-slate-400">
                        Soren Changelog • 更多版本將在這裡陸續歸檔
                    </div>
                </div>
            )}
        </div>
    );
};

export default FAQApp;
