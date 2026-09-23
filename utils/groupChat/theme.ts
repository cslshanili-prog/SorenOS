// 氣泡主題解析 —— 從 apps/Chat.tsx 抽出的共享邏輯（私聊/群聊共用）。
// presets 作參數傳入，避免 utils → components 反向依賴。
import { ChatTheme } from '../../types';

/**
 * 按主題 id 解析出完整 ChatTheme：custom 優先 → preset → default 兜底；
 * legacy/導入主題可能缺 user 或 ai 側（直接用會讓 MessageItem 讀
 * styleConfig.borderRadius 崩掉），用 default 對應側補全。
 */
export function resolveChatTheme(
    themeId: string | undefined,
    customThemes: ChatTheme[],
    presets: Record<string, ChatTheme>,
    fallbackId: string = 'default',
): ChatTheme {
    const fallback = presets[fallbackId];
    const id = themeId || fallbackId;
    const found = customThemes.find(t => t.id === id) || presets[id] || fallback;
    return {
        ...found,
        user: { ...fallback.user, ...(found.user || {}) },
        ai: { ...fallback.ai, ...(found.ai || {}) },
    };
}

/**
 * 氣泡工坊的 CSS 選擇器在私聊裡直接作用於整頁；群聊允許每個成員使用不同主題，
 * 因此要給每套主題加上消息級作用域，避免 A 的 `.sully-bubble-ai` 串到 B。
 *
 * 編輯器只允許規則以 `.sully-bubble-user` / `.sully-bubble-ai` / `.sully-voice-bar`
 * 開頭；這裡同時兼容逗號列表和 @media / @supports 內的規則。
 */
export function scopeBubbleThemeCss(css: string | undefined, scopeSelector: string): string {
    if (!css?.trim() || !scopeSelector.trim()) return '';
    return css.replace(
        /(^|[,{])(\s*)(\.sully-(?:bubble-(?:user|ai)|voice-bar)\b)/gmu,
        (_whole, boundary: string, whitespace: string, selector: string) =>
            `${boundary}${whitespace}${scopeSelector} ${selector}`,
    );
}
