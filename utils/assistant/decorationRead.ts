/**
 * Sore「讀取聊天裝扮」（plans/decoration-app.md 第 7 節）：某個聊天現在穿什麼。
 * 只讀，照聊天畫面真的怎麼合併來算（utils/chatDecoration.ts 的 resolveDecorationTheme、chatFineTuneCss 的 mergeChatFineTune），
 * 標出哪些是這個角色自己蓋過全局的。
 */
import type { CharacterProfile, ChatTheme, GroupProfile, OSTheme } from '../../types';
import { PRESET_THEMES } from '../../components/chat/ChatConstants';
import { LAYOUT_DEFAULTS, resolveDecorationTheme } from '../chatDecoration';
import { CHAT_FINE_TUNE_KEYS, mergeChatFineTune } from '../chatFineTuneCss';
import { BUILTIN_SOUNDS, parseWhiteboxSound, resolveActiveSound, type WhiteboxSound } from '../whiteboxSound';
import type { CssData } from './cssLocations';

/** 佈局欄位的中文名（值照原樣給，之後改的時候要用原值） */
export const LAYOUT_FIELD_LABELS: Record<string, string> = {
    chatAvatarMode: '頭像出現頻率', chatEmojiSize: '表情包大小', chatAvatarShape: '頭像形狀', chatAvatarSize: '頭像大小',
    chatAvatarVisibility: '顯示哪邊頭像', chatAvatarPlacement: '頭像位置', chatAvatarAlign: '頭像對齊', chatAvatarOffsetY: '頭像上下微調(px)',
    chatBubbleFontSize: '正文字號(0=默認)', chatBubbleLineHeight: '行距(0=默認)', chatBubbleIndent: '氣泡縮進(px)', chatSnapToEdge: '消息貼邊',
    chatModuleAlign: '卡片位置', chatBubbleStyle: '氣泡風格', chatMessageSpacing: '消息間距', chatShowTimestamp: '時間戳',
    chatHeaderStyle: '頂欄風格', chatInputStyle: '輸入框風格', chatChromeStyle: '整體外框', chatHeaderAlign: '頂欄對齊',
    chatHeaderDensity: '頂欄高度', chatStatusStyle: '狀態樣式', chatSendButtonStyle: '送出鈕', chatHideHeaderBuffs: '隱藏頂欄情緒標籤',
};
const LAYOUT_KEYS = Object.keys(LAYOUT_DEFAULTS) as Array<keyof typeof LAYOUT_DEFAULTS>;

const allThemes = (data: CssData): ChatTheme[] => [...Object.values(PRESET_THEMES), ...data.customThemes];
const themeName = (data: CssData, id?: string) => {
    if (!id) return '默認';
    const found = allThemes(data).find(t => t.id === id);
    return found ? `${found.name}${found.customCss?.trim() ? '（有自己的 CSS）' : ''}` : `${id}（找不到這套，畫面會退回默認）`;
};
const lines = (css?: string) => (css?.trim() ? css.trim().split('\n').length : 0);
const soundText = (s: WhiteboxSound | null | undefined) => {
    if (!s?.src || s.src === 'none') return '沒有／靜音';
    const name = BUILTIN_SOUNDS[s.src]?.label || (s.src.startsWith('data:') ? '自己上傳的音檔' : s.src.startsWith('http') ? '外鏈音檔' : s.src);
    return `${name}，音量 ${Math.round((s.volume ?? 0.6) * 100)}%`;
};
const bgText = (value: string | null | undefined) => (value ? (value.startsWith('http') ? '外鏈圖片' : '有一張圖片') : '沒有');
const fmt = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

const layoutLines = (effective: Partial<OSTheme>, overridden: Set<string>) => LAYOUT_KEYS.map(key => {
    const value = (effective as Record<string, unknown>)[key] ?? LAYOUT_DEFAULTS[key];
    return `- ${key}（${LAYOUT_FIELD_LABELS[key] || key}）= ${fmt(value)}${overridden.has(key) ? '　← 這個角色自己的' : ''}`;
});

export const describeGlobalDecoration = (data: CssData): string => {
    const t = data.theme;
    return [
        '# 全局默認（沒有自己設定的聊天都用這套）',
        t.decorationTemplateId ? '全局用的是裝扮 App 裡的模板' : '全局是自己的設定（沒用模板）',
        `氣泡主題：${themeName(data, t.chatDefaultBubbleStyle)}`,
        `背景：${bgText(t.chatBackground)}；底紋 ${t.chatBackgroundStyle || 'plain'}`,
        `提示音：${soundText(resolveActiveSound(undefined, undefined, t.chatChromeCustomCss, t.chatSound))}`,
        `白框 CSS（chat_chrome_global）：${lines(t.chatChromeCustomCss)} 行`,
        '佈局：',
        ...layoutLines(t, new Set()),
    ].join('\n');
};

export const describeCharacterDecoration = (char: CharacterProfile, data: CssData): string => {
    const theme = data.theme;
    const base = resolveDecorationTheme(theme, char);
    const effective = { ...base, ...mergeChatFineTune(base, char.chatFineTune) };
    const overridden = new Set<string>();
    if (char.chatFineTune?.enabled !== false) {
        for (const key of LAYOUT_KEYS) if ((char.chatAppearance as Record<string, unknown> | undefined)?.[key] !== undefined) overridden.add(key);
    }
    if (char.chatFineTune?.enabled === true) {
        for (const key of CHAT_FINE_TUNE_KEYS) if (char.chatFineTune[key] !== undefined) overridden.add(key);
    }
    const ownSound = parseWhiteboxSound(char.chromeCustomCss) ?? (char.chatSound?.src ? char.chatSound : null);
    const activeSound = resolveActiveSound(char.chromeCustomCss, char.chatSound, base.chatChromeCustomCss, theme.chatSound);
    return [
        `# ${char.name} 的聊天裝扮`,
        char.decorationTemplateId ? '用的是裝扮 App 裡的模板（改模板，這個聊天跟著變；在這裡直接改會變成自訂）' : '沒有用模板',
        `氣泡主題：${char.bubbleStyle ? `${themeName(data, char.bubbleStyle)}（自己選的）` : `跟著全局：${themeName(data, theme.chatDefaultBubbleStyle)}`}`,
        `背景：${char.chatBackground !== undefined ? `${bgText(char.chatBackground)}（自己的）` : `跟著全局：${bgText(theme.chatBackground)}`}；底紋 ${effective.chatBackgroundStyle || 'plain'}`,
        `提示音：${soundText(activeSound)}${ownSound ? '（自己的）' : '（跟著全局）'}`,
        `白框 CSS：角色自己的（chat_chrome_char）${lines(char.chromeCustomCss)} 行；${char.chatDecorationCssIsolated ? '不疊全局 CSS（用匯入的獨立 CSS）' : `疊在全局 ${lines(theme.chatChromeCustomCss)} 行之上`}`,
        `佈局：${overridden.size ? `有 ${overridden.size} 項是這個角色自己的，其餘跟著全局` : '全部跟著全局'}${char.chatFineTune?.enabled === false ? '（角色的單獨佈局目前關著）' : ''}`,
        ...layoutLines(effective, overridden),
        '要看 CSS 全文用「讀取CSS」。',
    ].join('\n');
};

export const describeGroupDecoration = (group: GroupProfile, data: CssData): string => {
    const theme = data.theme;
    const own = parseWhiteboxSound(group.chromeCustomCss) ?? (group.chatSound?.src ? group.chatSound : null);
    return [
        `# 群「${group.name}」的聊天裝扮`,
        '群自己只有白框 CSS、提示音、我的氣泡；佈局和背景跟著全局（用「讀取聊天裝扮」target="全局" 看）。',
        `我的氣泡：${group.userBubbleThemeId ? themeName(data, group.userBubbleThemeId) : `跟著全局：${themeName(data, theme.chatDefaultBubbleStyle)}`}`,
        `成員氣泡：${group.memberBubbleIndependent ? '每位成員用自己私聊的氣泡' : '統一'}`,
        `提示音：${soundText(own ?? resolveActiveSound(undefined, undefined, theme.chatChromeCustomCss, theme.chatSound))}${own ? '（群自己的）' : '（跟著全局）'}`,
        `白框 CSS（chat_chrome_group）：${lines(group.chromeCustomCss)} 行，疊在全局 ${lines(theme.chatChromeCustomCss)} 行之上`,
    ].join('\n');
};

/** target：角色名／群名／id，或「全局」；不給＝全局加上有自己設定的聊天清單 */
export const describeChatDecoration = (target: unknown, data: CssData): { ok: boolean; content: string } => {
    const raw = typeof target === 'string' ? target.trim() : '';
    const visibleChars = data.characters.filter(c => !c.altOf);
    if (!raw || /^(全局|全域|global|默認|預設)$/i.test(raw)) {
        const own = visibleChars.filter(c => c.bubbleStyle || c.chatBackground !== undefined || c.chromeCustomCss?.trim() || c.chatFineTune?.enabled || c.chatSound?.src);
        return {
            ok: true,
            content: [
                describeGlobalDecoration(data),
                '',
                `有自己裝扮的角色：${own.map(c => c.name).join('、') || '沒有'}`,
                `群：${data.groups.map(g => g.name).join('、') || '沒有'}`,
                '要看某個聊天：target 給角色名或群名。',
            ].join('\n'),
        };
    }
    const chars = data.characters.filter(c => c.id === raw || c.name === raw);
    const groups = data.groups.filter(g => g.id === raw || g.name === raw);
    if (chars.length + groups.length > 1) return { ok: false, content: `「${raw}」有好幾個同名的，改用 id：${[...chars, ...groups].map(x => `${x.name}=${x.id}`).join('、')}` };
    if (chars[0]) return { ok: true, content: describeCharacterDecoration(chars[0], data) };
    if (groups[0]) return { ok: true, content: describeGroupDecoration(groups[0], data) };
    return { ok: false, content: `找不到「${raw}」。角色：${visibleChars.map(c => c.name).join('、') || '沒有'}；群：${data.groups.map(g => g.name).join('、') || '沒有'}` };
};
