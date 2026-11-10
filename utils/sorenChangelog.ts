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

export const CHANGELOG_SOREN_2026_11_10 = 'changelog-soren-2026-11-10';
export const CHANGELOG_SOREN_2026_11_09 = 'changelog-soren-2026-11-09';
export const CHANGELOG_SOREN_2026_10_22 = 'changelog-soren-2026-10-22';
export const CHANGELOG_SOREN_2026_09_30 = 'changelog-soren-2026-09-30';
export const CHANGELOG_SOREN_2026_09_23 = 'changelog-soren-2026-09-23';

export const SOREN_CHANGELOG_ENTRIES: SorenChangelogEntry[] = [
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
