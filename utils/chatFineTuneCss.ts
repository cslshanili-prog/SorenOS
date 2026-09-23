/**
 * 聊天細節微調 CSS 生成器（外觀 → 聊天細節）。
 *
 * 收編自社區作者「毛豆腐和麵機」（DC）的「神秘拼好碼」美化 CSS（致謝見 README 鳴謝）：
 * 隱藏頭像、頭像位置/對齊/微調、消息貼邊、氣泡縮進、正文字號/行距。
 * 選擇器沿用她的版本已在真實 DOM 上驗證過的形態
 * （錨 .group.justify-* 與 .sully-bubble-* 結構），生成規則帶 !important
 * 以壓過 Tailwind 工具類。
 *
 * 注入位置：Chat.tsx 在用戶自定義白框 CSS（chatChromeCustomCss / 角色
 * chromeCustomCss）**之前**插入本樣式——同為 !important 時後者勝，老用戶
 * 手寫的美化代碼永遠能覆蓋這裡的可視化設置，互不打架。
 *
 * 全部字段缺省時返回空串（一個 <style> 都不注入，現狀零變化）。
 */

import type { ChatFineTuneFields, ChatFineTuneOverride } from '../types';

/** 微調字段清單（合併 / 重置 / 快照都以這份為準，加字段只改這裡一處）。 */
export const CHAT_FINE_TUNE_KEYS = [
    'chatAvatarVisibility', 'chatAvatarPlacement', 'chatAvatarAlign', 'chatAvatarOffsetY',
    'chatBubbleFontSize', 'chatBubbleLineHeight', 'chatBubbleIndent', 'chatSnapToEdge',
    // chatModuleAlign 不生成 CSS（HTML/心象卡片位置經 MessageItem 佈局屬性生效），
    // 但同屬微調字段：合併/重置/角色覆蓋/備份都跟這份清單走。
    'chatModuleAlign',
] as const satisfies ReadonlyArray<keyof ChatFineTuneFields>;

/**
 * 「全局打底，角色可覆蓋」的合併規則：
 * - override 缺省或 enabled 不為 true → 原樣返回全局值（角色完全跟隨全局）；
 * - enabled=true → 已定義（!== undefined）的字段逐個覆蓋全局，未定義的字段跟隨全局。
 *   注意顯式 0 / 'both' / false 也算「已定義」——角色可以藉此把某項壓回默認，
 *   即使全局設了別的值（UI 的「回默認」按鈕依賴這一點）。
 * 返回值只含微調字段的淺拷貝，餵給 buildChatFineTuneCss 即可。
 */
export function mergeChatFineTune(global: ChatFineTuneFields, override?: ChatFineTuneOverride | null): ChatFineTuneFields {
    const merged: ChatFineTuneFields = {};
    for (const key of CHAT_FINE_TUNE_KEYS) {
        const value = override?.enabled === true && override[key] !== undefined ? override[key] : global[key];
        if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
    }
    return merged;
}

const AI_AVATAR = '.sully-chat-root .group.justify-start > [class~="absolute"][class~="z-0"]';
const USER_AVATAR = '.sully-chat-root .group.justify-end > [class~="absolute"][class~="z-0"]';
const AI_BESIDE_AVATAR = '.sully-chat-root .sully-chat-message-ai > .sully-chat-message-avatar-slot';
const USER_BESIDE_AVATAR = '.sully-chat-root .sully-chat-message-user > .sully-chat-message-avatar-slot';
const TURN_AVATAR = '.sully-chat-root .sully-chat-turn-avatar-slot';
const DEFAULT_AVATAR = '.sully-chat-root .sully-chat-message-avatar';
const GROUP_FIRST = '.sully-chat-root .sully-chat-message-group-first:not(.sully-chat-message-module)';
const MESSAGE_CONTENT = '.sully-chat-root .sully-chat-message-content:not(.sully-html-wrap)';
const AI_BODY = '.sully-chat-root .sully-bubble-ai > div[class~="select-text"]';
const USER_BODY = '.sully-chat-root .sully-bubble-user > div[class~="select-text"]';
// 貼邊/縮進只該動普通氣泡：HTML 卡片（280px 定寬模塊，包裝層帶 .sully-html-wrap）
// 的默認位置就是"視覺居中"的約定，:not() 繞開讓它不隨美化挪窩。
const AI_WRAP = '.sully-chat-root .group.justify-start [class~="max-w-[72%]"].ml-12:not(.sully-html-wrap)';
const USER_WRAP = '.sully-chat-root .group.justify-end [class~="max-w-[72%]"].mr-12:not(.sully-html-wrap)';
// 心象卡片（思考鏈，僅 AI 側）與氣泡共用包裝層，:not() 繞不開——包裝層被貼邊/縮進挪動時
// 給它一個反向 margin 抵消，釘回默認位置（ml-12 = 48px），與 HTML 卡片同一"模塊不挪窩"約定。
const AI_PSYCHE = '.sully-chat-root .group.justify-start .sully-psyche';
const DEFAULT_WRAP_MARGIN = 48;

const hideRule = (sel: string) =>
    `${sel} { display: none !important; visibility: hidden !important; opacity: 0 !important; pointer-events: none !important; }`;

export function buildChatFineTuneCss(theme: ChatFineTuneFields): string {
    const rules: string[] = [];
    const vis = theme.chatAvatarVisibility || 'both';
    const hideAi = vis === 'hide_ai' || vis === 'hide_both';
    const hideUser = vis === 'hide_user' || vis === 'hide_both';

    // 隱藏規則最後追加：這樣“每輪上方”的 display:block 不會意外把用戶主動隱藏的一側重新顯示。
    const hideRules: string[] = [];
    if (hideAi) hideRules.push(hideRule(AI_AVATAR));
    if (hideUser) hideRules.push(hideRule(USER_AVATAR));

    // ── 貼邊（只對隱藏了頭像的一側收回空位）──
    if (theme.chatSnapToEdge) {
        if (hideAi) rules.push(`${AI_WRAP} { margin-left: 0 !important; }`);
        if (hideUser) rules.push(`${USER_WRAP} { margin-right: 0 !important; }`);
    }

    // ── 頭像對齊 + 垂直微調 ──
    const align = theme.chatAvatarAlign || 'bottom';
    const offY = theme.chatAvatarOffsetY || 0;
    if (align !== 'bottom' || offY !== 0) {
        const both = `${AI_BESIDE_AVATAR}, ${USER_BESIDE_AVATAR}`;
        if (align === 'top') {
            rules.push(`${both} { bottom: auto !important; top: -0.5rem !important;${offY ? ` transform: translateY(${offY}px) !important;` : ''} }`);
        } else if (align === 'center') {
            rules.push(`${both} { bottom: auto !important; top: 50% !important; transform: translateY(calc(-50% + ${offY}px)) !important; }`);
        } else {
            rules.push(`${both} { transform: translateY(${offY}px) !important; }`);
        }
    }

    // ── 氣泡與頭像側的間距（貼邊側不重複設置，貼邊優先）──
    const indent = theme.chatBubbleIndent || 0;
    if (indent > 0) {
        if (!(theme.chatSnapToEdge && hideAi)) rules.push(`${AI_WRAP} { margin-left: ${indent}px !important; }`);
        if (!(theme.chatSnapToEdge && hideUser)) rules.push(`${USER_WRAP} { margin-right: ${indent}px !important; }`);
    }

    // ── 心象卡片釘回默認位置 ──
    // AI 側包裝層被挪動多少，就給心象反向補多少：貼邊時包裝層 48→0（補 48px），
    // 縮進時 48→indent（補 48-indent，可為負）。包裝層沒動就不出規則。
    if (theme.chatSnapToEdge && hideAi) {
        rules.push(`${AI_PSYCHE} { margin-left: ${DEFAULT_WRAP_MARGIN}px !important; }`);
    } else if (indent > 0) {
        rules.push(`${AI_PSYCHE} { margin-left: ${DEFAULT_WRAP_MARGIN - indent}px !important; }`);
    }

    // ── 正文字號 / 行距（沿用社區版的四層選擇器：容器/內層行/內聯繼承/引用行）──
    const fs = theme.chatBubbleFontSize || 0;
    const lh = theme.chatBubbleLineHeight || 0;
    if (fs > 0 || lh > 0) {
        const decl = `${fs > 0 ? ` font-size: ${fs}px !important;` : ''}${lh > 0 ? ` line-height: ${lh} !important;` : ''}`;
        const inheritDecl = `${fs > 0 ? ' font-size: inherit !important;' : ''}${lh > 0 ? ' line-height: inherit !important;' : ''}`;
        rules.push(`${AI_BODY}, ${USER_BODY} {${decl} }`);
        rules.push(`${AI_BODY} div, ${USER_BODY} div {${decl} }`);
        rules.push(`${AI_BODY} strong, ${AI_BODY} em, ${AI_BODY} span, ${USER_BODY} strong, ${USER_BODY} em, ${USER_BODY} span {${inheritDecl} }`);
        rules.push(`${AI_BODY} [class*="text-[13px]"], ${USER_BODY} [class*="text-[13px]"] {${decl} }`);
    }

    // ── 每輪頭像置於整組氣泡上方 ──
    if ((theme.chatAvatarPlacement || 'beside') === 'above_group') {
        rules.push(`${TURN_AVATAR} { display: block !important; top: 0 !important; bottom: auto !important; transform: none !important; }`);
        rules.push(`${DEFAULT_AVATAR} { display: none !important; }`);
        rules.push(`${GROUP_FIRST} { padding-top: calc(var(--sully-chat-message-avatar-size, 36px) + 8px) !important; }`);
        rules.push(`${MESSAGE_CONTENT} { margin-left: 0 !important; margin-right: 0 !important; }`);
    }

    rules.push(...hideRules);
    return rules.length ? `/* 聊天細節微調（外觀 App 生成，用戶自定義 CSS 可覆蓋） */\n${rules.join('\n')}` : '';
}
