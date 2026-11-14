/**
 * Sore 能改的美化位置（plans/ai-assistant.md 第 4 節第 2 批）。純邏輯：讀、檢查、算出要寫什麼；真的寫由畫面做。
 *
 * - 選擇器清單與檢查跟手動編輯／協同工作同一份（features/collaboration/makers.ts、utils/*Appearance.ts），不另抄。
 * - 白框 CSS 裡的提示音指令（@sully-sound 註釋）：讀的時候拿掉不給 Sore 看，寫的時候把原本的接回去，Sore 改美化不會弄丟提示音。
 * - 見面的 CSS 套用前一律過 scopeDateCss，所以只查語法、不查選擇器。
 * - 氣泡主題：只改「自訂」主題的 customCss；指定的名字不存在就新建一個（還原＝刪掉它）。
 */
import type { CharacterProfile, ChatTheme, GroupProfile, OSTheme } from '../../types';
import {
    BUBBLE_SELECTOR_GROUPS, bubbleSelector, formatSelectorGroups, PSYCHE_SELECTOR_GROUPS, psycheSelector,
    WHITEBOX_SELECTOR_GROUPS, whiteboxSelector,
} from '../../features/collaboration/makers';
import { JOURNAL_CSS_SCOPE_HINT, JOURNAL_CSS_SCOPE_REGEX, JOURNAL_CUSTOM_CSS_SELECTOR_GROUPS } from '../journalAppearance';
import { SCHEDULE_CSS_SCOPE_HINT, SCHEDULE_CSS_SCOPE_REGEX, SCHEDULE_CUSTOM_CSS_SELECTOR_GROUPS } from '../scheduleAppearance';
import { DATE_CSS_HOOKS, DATE_CUSTOM_CSS_MAX } from '../dateAppearance';
import { validateScopedCss } from '../scopedCss';
import { parseWhiteboxSound, stripWhiteboxSoundDirective, upsertWhiteboxSound } from '../whiteboxSound';

export type CssLocationId =
    | 'chat_chrome_global' | 'chat_chrome_char' | 'chat_chrome_group'
    | 'bubble_theme' | 'date' | 'thinking_chain' | 'journal' | 'schedule';

type TargetKind = 'none' | 'character' | 'group' | 'chatTheme';

export interface CssData {
    theme: OSTheme;
    characters: CharacterProfile[];
    groups: GroupProfile[];
    customThemes: ChatTheme[];
}

/** 真的要寫什麼：畫面照這個呼叫 updateTheme／updateCharacter／updateGroup／addCustomTheme／removeCustomTheme */
export type CssWrite =
    | { kind: 'theme'; patch: Partial<OSTheme> }
    | { kind: 'character'; id: string; patch: Partial<CharacterProfile> }
    | { kind: 'group'; id: string; patch: Partial<GroupProfile> }
    | { kind: 'chatTheme'; theme: ChatTheme }
    | { kind: 'removeChatTheme'; id: string };

interface CssLocationDef {
    id: CssLocationId;
    label: string;
    target: TargetKind;
    /** null＝不查選擇器（見面：套用時自動限定） */
    scope: { regex: RegExp; hint: string } | null;
    selectors: string;
    notes: string;
    maxLength?: number;
}

const DATE_SELECTORS = DATE_CSS_HOOKS.map(h => `${h.selector}（${h.label}）`).join('\n');

const CHROME_NOTES = `- 頂欄已自動留出狀態列安全區；裝飾要貼最頂用 top: calc(var(--safe-top) + 數值)。
- 不要藏掉 .sully-chat-back（返回鍵）、輸入框、送出鍵。
- 想讓裝飾溢出頂欄，給 .sully-chat-header 加 overflow: visible。
- .sully-chat-buffs button 帶內聯樣式，要 !important 才蓋得掉。
- 每輪頭像放氣泡上方：顯示 .sully-chat-turn-avatar-slot、隱藏 .sully-chat-message-avatar，給 .sully-chat-message-group-first 留頂部空間。
- 疊加順序：全域白框 → 角色（或群）白框，後面的蓋前面的。`;

export const CSS_LOCATIONS: CssLocationDef[] = [
    {
        id: 'chat_chrome_global', label: '聊天白框 · 全域', target: 'none',
        scope: { regex: whiteboxSelector, hint: '.sully-chat-* / .sully-bubble-* / .sully-schedule-change*' },
        selectors: formatSelectorGroups(WHITEBOX_SELECTOR_GROUPS), notes: CHROME_NOTES,
    },
    {
        id: 'chat_chrome_char', label: '聊天白框 · 角色', target: 'character',
        scope: { regex: whiteboxSelector, hint: '.sully-chat-* / .sully-bubble-* / .sully-schedule-change*' },
        selectors: formatSelectorGroups(WHITEBOX_SELECTOR_GROUPS), notes: CHROME_NOTES,
    },
    {
        id: 'chat_chrome_group', label: '聊天白框 · 群', target: 'group',
        scope: { regex: whiteboxSelector, hint: '.sully-chat-* / .sully-bubble-* / .sully-schedule-change*' },
        selectors: formatSelectorGroups(WHITEBOX_SELECTOR_GROUPS), notes: CHROME_NOTES,
    },
    {
        id: 'bubble_theme', label: '氣泡主題', target: 'chatTheme',
        scope: { regex: bubbleSelector, hint: '.sully-bubble-user / .sully-bubble-ai / .sully-voice-bar' },
        selectors: formatSelectorGroups(BUBBLE_SELECTOR_GROUPS),
        notes: `- 只能改「自訂」主題；target 寫主題名字，名字不存在會新建一個（底色用預設，外觀全靠這段 CSS）。
- 主題要在私聊點角色名 → 氣泡樣式裡選上才會套用。
- 氣泡尾巴、同一輪的首尾（-group-first / -group-last）、長文字、語音條都要顧到。`,
    },
    {
        id: 'date', label: '見面畫面', target: 'character', scope: null, selectors: DATE_SELECTORS, maxLength: DATE_CUSTOM_CSS_MAX,
        notes: `- 套用時會自動限定在 .date-root 裡，選擇器照上面的寫就好。
- .date-decoration-card 裡面是獨立頁面，CSS 管不到裡面。
- 淺色／深色都要顧：用 .date-root.date-theme-light／.date-theme-dark 分開寫。`,
    },
    {
        id: 'thinking_chain', label: '心象卡片（思考鏈）', target: 'character',
        scope: { regex: psycheSelector, hint: '.sully-psyche*' },
        selectors: formatSelectorGroups(PSYCHE_SELECTOR_GROUPS),
        notes: '- 標題、摺疊時的速覽、展開的正文要分得出來；短念頭和長段落都要好讀。',
    },
    {
        id: 'journal', label: '交換日記', target: 'none',
        scope: { regex: JOURNAL_CSS_SCOPE_REGEX, hint: JOURNAL_CSS_SCOPE_HINT },
        selectors: formatSelectorGroups(JOURNAL_CUSTOM_CSS_SELECTOR_GROUPS),
        notes: '- 選擇頁、列表、書寫雙頁、底部工具都要顧到；裝飾不能擋住正文、返回、新建、輸入。',
    },
    {
        id: 'schedule', label: '日程卡片', target: 'none',
        scope: { regex: SCHEDULE_CSS_SCOPE_REGEX, hint: SCHEDULE_CSS_SCOPE_HINT },
        selectors: formatSelectorGroups(SCHEDULE_CUSTOM_CSS_SELECTOR_GROUPS),
        notes: '- 桌面、房間、聊天裡的日程卡共用這段；可以在 .sully-schedule-root 宣告 --schedule-bg / --schedule-text / --schedule-accent 這類變數。',
    },
];

export const findCssLocation = (id: unknown): CssLocationDef | undefined =>
    typeof id === 'string' ? CSS_LOCATIONS.find(l => l.id === id.trim()) : undefined;

export const CSS_COMMON_RULES = `通用規矩：
- 只能用該位置列出的選擇器（和它們的後代、偽類、::before/::after），不能寫 body、html、:root、*、裸標籤開頭。
- 蓋過預設或內聯樣式用 !important，但別每行都加。
- 手機窄屏（約 390px）；裝飾偽元素要 pointer-events: none。
- 持續動畫只動 transform／opacity，不要對 blur、backdrop-filter 做動畫。
- 背景圖只能用用戶給的圖片網址，不要編網址。`;

// ─── 目標（角色／群／氣泡主題） ───

export interface ResolvedTarget { id: string; label: string; exists: boolean }

const targetsOf = (loc: CssLocationDef, data: CssData): Array<{ id: string; name: string }> => {
    if (loc.target === 'character') return data.characters.map(c => ({ id: c.id, name: c.name }));
    if (loc.target === 'group') return data.groups.map(g => ({ id: g.id, name: g.name }));
    if (loc.target === 'chatTheme') return data.customThemes.filter(t => t.type !== 'preset').map(t => ({ id: t.id, name: t.name }));
    return [];
};

/** target 可以是 id 或名字；名字重複就要它改用 id */
export const resolveCssTarget = (loc: CssLocationDef, target: unknown, data: CssData, opts?: { allowNew?: boolean }): ResolvedTarget | { error: string } => {
    if (loc.target === 'none') return { id: '', label: loc.label, exists: true };
    const raw = typeof target === 'string' ? target.trim() : '';
    const pool = targetsOf(loc, data);
    const kindLabel = loc.target === 'character' ? '角色' : loc.target === 'group' ? '群' : '自訂氣泡主題';
    if (!raw) return { error: `${loc.label}要指定是哪個${kindLabel}（target 填名字）。` };
    const byId = pool.find(p => p.id === raw);
    if (byId) return { id: byId.id, label: `${loc.label} · ${byId.name}`, exists: true };
    const byName = pool.filter(p => p.name.trim() === raw);
    if (byName.length === 1) return { id: byName[0].id, label: `${loc.label} · ${byName[0].name}`, exists: true };
    if (byName.length > 1) return { error: `有 ${byName.length} 個叫「${raw}」的${kindLabel}，用 id 指定：${byName.map(p => p.id).join('、')}` };
    if (loc.target === 'chatTheme' && opts?.allowNew) return { id: '', label: `${loc.label} · ${raw}（新的）`, exists: false };
    return { error: `找不到叫「${raw}」的${kindLabel}。有的：${pool.map(p => p.name).join('、') || '（一個都沒有）'}` };
};

// ─── 讀 ───

const chromeOf = (css?: string) => stripWhiteboxSoundDirective(css || '').trim();

export const readLocationCss = (loc: CssLocationDef, targetId: string, data: CssData): string => {
    switch (loc.id) {
        case 'chat_chrome_global': return chromeOf(data.theme.chatChromeCustomCss);
        case 'chat_chrome_char': return chromeOf(data.characters.find(c => c.id === targetId)?.chromeCustomCss);
        case 'chat_chrome_group': return chromeOf(data.groups.find(g => g.id === targetId)?.chromeCustomCss);
        case 'bubble_theme': return data.customThemes.find(t => t.id === targetId)?.customCss || '';
        case 'date': return data.characters.find(c => c.id === targetId)?.dateAppearance?.customCss || '';
        case 'thinking_chain': return data.characters.find(c => c.id === targetId)?.thinkingChainCustomCss || '';
        case 'journal': return data.theme.journalAppearance?.customCss || '';
        case 'schedule': return data.theme.scheduleCardAppearance?.customCss || '';
    }
};

/** 「讀取CSS」不給位置：各處有沒有設 */
export const describeCssStatus = (data: CssData): string => {
    const has = (css?: string) => !!stripWhiteboxSoundDirective(css || '').trim();
    const names = <T extends { name: string }>(items: T[], pick: (item: T) => string | undefined) =>
        items.filter(item => has(pick(item))).map(item => item.name).join('、') || '沒有';
    const visibleChars = data.characters.filter(c => !c.altOf);
    return [
        `chat_chrome_global（聊天白框 · 全域）：${has(data.theme.chatChromeCustomCss) ? '有' : '沒有'}`,
        `chat_chrome_char（聊天白框 · 角色）：有設的角色 ${names(visibleChars, c => c.chromeCustomCss)}`,
        `chat_chrome_group（聊天白框 · 群）：有設的群 ${names(data.groups, g => g.chromeCustomCss)}`,
        `bubble_theme（氣泡主題）：自訂主題 ${data.customThemes.filter(t => t.type !== 'preset').map(t => `${t.name}${has(t.customCss) ? '（有 CSS）' : ''}`).join('、') || '沒有'}`,
        `date（見面畫面）：有設的角色 ${names(visibleChars, c => c.dateAppearance?.customCss)}`,
        `thinking_chain（心象卡片）：有設的角色 ${names(visibleChars, c => c.thinkingChainCustomCss)}`,
        `journal（交換日記）：${has(data.theme.journalAppearance?.customCss) ? '有' : '沒有'}`,
        `schedule（日程卡片）：${has(data.theme.scheduleCardAppearance?.customCss) ? '有' : '沒有'}`,
        `角色：${visibleChars.map(c => c.name).join('、') || '沒有'}；群：${data.groups.map(g => g.name).join('、') || '沒有'}`,
    ].join('\n');
};

/** 「讀取CSS」給了位置：現在的內容＋可用選擇器＋規矩 */
export const describeLocation = (loc: CssLocationDef, target: ResolvedTarget, data: CssData): string => {
    const css = target.exists ? readLocationCss(loc, target.id, data) : '';
    return [
        `# ${target.label}`,
        `現在的 CSS：${css ? `\n\`\`\`css\n${css}\n\`\`\`` : '（空的）'}`,
        `可用選擇器：\n${loc.selectors}`,
        `這裡要注意：\n${loc.notes}`,
        CSS_COMMON_RULES,
    ].join('\n\n');
};

// ─── 檢查 ───

export const validateLocationCss = (loc: CssLocationDef, css: string): string[] => {
    if (loc.maxLength && css.length > loc.maxLength) return [`太長了（上限 ${loc.maxLength.toLocaleString()} 字）`];
    const errors: string[] = [];
    const scope = loc.scope || { regex: /[\s\S]*/, hint: '' };
    errors.push(...validateScopedCss(css, scope.regex, scope.hint).errors);
    if (/<\/?\s*(script|style)\b/i.test(css)) errors.push('CSS 裡不能有 <script> 或 <style> 標籤');
    return errors;
};

// ─── 寫 ───

const NEW_THEME_SIDE = { borderRadius: 18, opacity: 1 };
/** 新建氣泡主題的兩側底色（預覽也用這組，看起來才跟套用後一樣） */
export const NEW_THEME_SIDES = {
    user: { ...NEW_THEME_SIDE, textColor: '#ffffff', backgroundColor: '#6366f1' },
    ai: { ...NEW_THEME_SIDE, textColor: '#1e293b', backgroundColor: '#ffffff' },
};

export const newChatThemeId = () => `sore_theme_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

/** css 是 Sore 要的整段新內容（空字串＝清除）。新氣泡主題要給 newTheme（id、名字）。 */
export const buildCssWrite = (
    loc: CssLocationDef,
    targetId: string,
    css: string,
    data: CssData,
    newTheme?: { id: string; name: string },
): CssWrite => {
    const next = css.trim();
    const withSound = (old?: string) => {
        const sound = parseWhiteboxSound(old);
        const merged = sound ? upsertWhiteboxSound(next, sound) : next;
        return merged.trim() || undefined;
    };
    switch (loc.id) {
        case 'chat_chrome_global':
            return { kind: 'theme', patch: { chatChromeCustomCss: withSound(data.theme.chatChromeCustomCss) } };
        case 'chat_chrome_char':
            return { kind: 'character', id: targetId, patch: { chromeCustomCss: withSound(data.characters.find(c => c.id === targetId)?.chromeCustomCss) } };
        case 'chat_chrome_group':
            return { kind: 'group', id: targetId, patch: { chromeCustomCss: withSound(data.groups.find(g => g.id === targetId)?.chromeCustomCss) || '' } };
        case 'bubble_theme': {
            const existing = data.customThemes.find(t => t.id === targetId);
            if (existing) return { kind: 'chatTheme', theme: { ...existing, customCss: next || undefined } };
            return {
                kind: 'chatTheme',
                theme: {
                    id: newTheme?.id || newChatThemeId(), name: newTheme?.name || 'Sore 做的氣泡', type: 'custom',
                    user: { ...NEW_THEME_SIDES.user },
                    ai: { ...NEW_THEME_SIDES.ai },
                    customCss: next || undefined,
                },
            };
        }
        case 'date': {
            const char = data.characters.find(c => c.id === targetId);
            return { kind: 'character', id: targetId, patch: { dateAppearance: { ...(char?.dateAppearance || {}), customCss: next || undefined } } };
        }
        case 'thinking_chain':
            return { kind: 'character', id: targetId, patch: { thinkingChainCustomCss: next || undefined } };
        case 'journal':
            return { kind: 'theme', patch: { journalAppearance: { ...(data.theme.journalAppearance || {}), customCss: next || undefined } } };
        case 'schedule':
            return { kind: 'theme', patch: { scheduleCardAppearance: { ...(data.theme.scheduleCardAppearance || {}), customCss: next || undefined } } };
    }
};

/** 目標還在不在（套用、還原前再查一次：角色可能被刪了） */
export const cssTargetStillThere = (loc: CssLocationDef, targetId: string, data: CssData): boolean => {
    if (loc.target === 'none') return true;
    if (loc.target === 'chatTheme') return true; // 不在就新建
    return targetsOf(loc, data).some(t => t.id === targetId);
};
