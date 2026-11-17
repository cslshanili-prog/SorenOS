/**
 * Soren 自己的更新日誌（使用幫助 → 更新日誌），2026-09-14 從上游分出來之後的部分。新的在前。
 *
 * 外層照日期一篇一篇（跟上游那些舊日誌同一個清單），每篇裡面照功能分節。頁面在 public/changelogs/，
 * 同一個樣板寫的；要加新的一篇就在最前面補一項、放一個 html。id 給「點通知直接打開這篇」用
 * （sessionStorage 的 FAQ_TARGET_SECTION_KEY），不要改舊的。
 */

export interface SorenChangelogEntry {
    id: string;
    title: string;
    subtitle: string;
    date: string;
    src: string;
    accent: string;
}

/** 更新提醒點「看看更新日誌」：打開使用幫助的更新日誌清單（不是某一篇） */
export const FAQ_TARGET_CHANGELOG_LIST = 'changelog-list';

export const CHANGELOG_SOREN_2026_11_18_API = 'changelog-soren-2026-11-18-api';
export const CHANGELOG_SOREN_2026_11_18 = 'changelog-soren-2026-11-18';
export const CHANGELOG_SOREN_2026_11_16 = 'changelog-soren-2026-11-16';
export const CHANGELOG_SOREN_2026_11_15 = 'changelog-soren-2026-11-15';
export const CHANGELOG_SOREN_2026_11_14 = 'changelog-soren-2026-11-14';
export const CHANGELOG_SOREN_2026_11_11 = 'changelog-soren-2026-11-11';
export const CHANGELOG_SOREN_2026_11_10 = 'changelog-soren-2026-11-10';
export const CHANGELOG_SOREN_2026_11_09 = 'changelog-soren-2026-11-09';
export const CHANGELOG_SOREN_2026_10_22 = 'changelog-soren-2026-10-22';
export const CHANGELOG_SOREN_2026_09_30 = 'changelog-soren-2026-09-30';
export const CHANGELOG_SOREN_2026_09_23 = 'changelog-soren-2026-09-23';

export const SOREN_CHANGELOG_ENTRIES: SorenChangelogEntry[] = [
    {
        id: CHANGELOG_SOREN_2026_11_18_API,
        title: '2026 年 11 月 18 日 · S4.1 副 API 中心與備援鏈',
        subtitle: '三組副 API（記憶、情緒／日程、主動消息）搬到系統設置集中填，從預設選 · 角色頁「跟系統設置」· 備援鏈：主用的掛了照順序換下一家再發一次、冷卻 5 分鐘、調用記錄標出來 · 雲端憑據跟著換',
        date: '2026-11-18',
        src: 'changelogs/2026-11-18-api.html',
        accent: 'from-sky-50 to-cyan-50 border-sky-200',
    },
    {
        id: CHANGELOG_SOREN_2026_11_18,
        title: '2026 年 11 月 18 日 · S4.0 行事曆與時間',
        subtitle: '行事曆取代時光契約（月曆／我的／TA 的，配角也能看）· 約定、待辦（角色自己記、自己勾）、紀念日 · 一天／一週／所有人生成，身份卡也能 · 旅行期間換時區 · 自動生成（本機＋雲端）· 時間系統：曆法掛世界、聊天線有自己的鐘、身份卡所在地、時間感知三檔',
        date: '2026-11-18',
        src: 'changelogs/2026-11-18.html',
        accent: 'from-rose-50 to-pink-50 border-rose-200',
    },
    {
        id: CHANGELOG_SOREN_2026_11_16,
        title: '2026 年 11 月 16 日 · 裝扮、聊天語言與你的聲音',
        subtitle: '裝扮 App 取代氣泡工坊（模板綁定、寫穿、預覽、Sore 能改）· 聊天語言：說話語言、夾雜、翻譯（雙語或 DeepL）· 身份卡音色＋私聊語音條 · 群聊你一句我一句、旁觀 ▸ · 切換聊天全螢幕、世界底下分組',
        date: '2026-11-16',
        src: 'changelogs/2026-11-16.html',
        accent: 'from-violet-50 to-fuchsia-50 border-violet-200',
    },
    {
        id: CHANGELOG_SOREN_2026_11_15,
        title: '2026 年 11 月 15 日 · S3.0 Sore 與預設',
        subtitle: 'AI 助手 Sore（答疑、美化、預設、世界書、小組件，按套用才寫、可還原）· 預設 App 與場景預設，私聊／群聊／電話／見面都能用 · 匯入 ST 角色卡、別家聊天、ST 聊天，私聊與見面匯出 · 世界書全局啟用 · 開場白清單 · 先加好友才能對話開關',
        date: '2026-11-15',
        src: 'changelogs/2026-11-15.html',
        accent: 'from-amber-50 to-orange-50 border-amber-200',
    },
    {
        id: CHANGELOG_SOREN_2026_11_14,
        title: '2026 年 11 月 14 日 · S2.0 關係線',
        subtitle: '一個角色認識好幾張身份卡、每張一條線 · 互相認識與小號 · 群聊裡好幾個你 · NPC 變配角、角色私聊、AI 生成配角 · 角色自己開小號 · 私下找人 · 畫風庫與鎖臉強度 · 資料庫生圖改版 · 編輯框全螢幕',
        date: '2026-11-14',
        src: 'changelogs/2026-11-14.html',
        accent: 'from-indigo-50 to-violet-50 border-indigo-200',
    },
    {
        id: CHANGELOG_SOREN_2026_11_11,
        title: '2026 年 11 月 11 日 · 桌面',
        subtitle: '自由排版（4×6 格、拖到哪放哪、往下擠）· Dock 能跟桌面互換、三種樣式 · 內建小組件換尺寸 · 八個範本 · 自己做小組件、匯入匯出 .widget.json',
        date: '2026-11-11',
        src: 'changelogs/2026-11-11.html',
        accent: 'from-amber-50 to-rose-50 border-amber-200',
    },
    {
        id: CHANGELOG_SOREN_2026_11_10,
        title: '2026 年 11 月 10 日 · 資料庫',
        subtitle: '相簿改成資料庫 · 描述、AI 寫與批次 AI 寫 · 分配給角色 · 角色原樣傳手邊的照片（含雲端）· 在資料庫生成 · 文件歸檔 · 私聊從資料庫發照片／文件',
        date: '2026-11-10',
        src: 'changelogs/2026-11-10.html',
        accent: 'from-sky-50 to-indigo-50 border-sky-200',
    },
    {
        id: CHANGELOG_SOREN_2026_11_09,
        title: '2026 年 11 月 9 日 · 見面改版',
        subtitle: '只留閱讀模式 · 匯入 SillyTavern 預設（巨集、正則、裝飾、編輯、匯出）· 一場一場的故事（大綱、總結、完結、時間）· 情緒褪色與線下情緒獨立 · 畫面美化 · 拍下這一刻 · 觀測協議回歸',
        date: '2026-11-09',
        src: 'changelogs/2026-11-9.html',
        accent: 'from-orange-50 to-amber-50 border-orange-200',
    },
    {
        id: CHANGELOG_SOREN_2026_10_22,
        title: '2026 年 10 月 22 日 · 銀行與購物中心',
        subtitle: '銀行改版（Net Worth、流水、固定收支）· 購物中心改版、角色主動下單 · 節假日與國際／台灣新聞 · 主動消息間隔與睡眠 · 好感度可正可負 · 見面分清說出口與旁白 · 世界書對齊 SillyTavern',
        date: '2026-10-22',
        src: 'changelogs/2026-10-22.html',
        accent: 'from-emerald-50 to-teal-50 border-emerald-200',
    },
    {
        id: CHANGELOG_SOREN_2026_09_30,
        title: '2026 年 9 月 30 日 · 朋友圈與多身份',
        subtitle: '共用的朋友圈貼文池 · NPC 正式入群與旁觀欄 · 雙向拉黑與臨時會話 · 同世界多身份隔離 · 精簡人設、對話範例、固定台詞 · 角色主動打電話 · AI 幫我回覆',
        date: '2026-09-30',
        src: 'changelogs/2026-9-30.html',
        accent: 'from-violet-50 to-indigo-50 border-violet-200',
    },
    {
        id: CHANGELOG_SOREN_2026_09_23,
        title: '2026 年 9 月 23 日 · Soren 起步',
        subtitle: '改名 Soren、全面繁體 · Chat 主頁 · 身份卡 · 群聊 NPC 客串、禁言、公告 · 錢包與購物中心初版 · 查手機「軌跡」· 角色自己傳照片 · 聊天設定全螢幕',
        date: '2026-09-23',
        src: 'changelogs/2026-9-23.html',
        accent: 'from-lime-50 to-stone-100 border-lime-200',
    },
];
