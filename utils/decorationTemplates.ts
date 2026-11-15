/**
 * 裝扮模板（plans/decoration-app.md 第 3 節）：一套佈局＋氣泡＋背景＋提示音＋白框 CSS，指定給全局、角色、群。
 *
 * 寫穿：聊天畫面照舊讀角色／全局／群原本那些欄位，模板只是「寫進這些欄位的來源」。
 * - 指定模板＝先把那個聊天的裝扮欄位清回「跟著全局」，再把模板有的項目寫進去，記下 decorationTemplateId。
 * - 模板沒填的項目＝跟著全局（給全局用時＝系統默認）。到處同一個意思，不會有「這項不管、留著舊的」。
 * - 別處（舊的聊天裝扮面板、Sore、氣泡工坊）改了裝扮欄位 → 那個聊天自動解除綁定、變「自訂」（detach*）。
 * - 「自訂」也用同一個編輯器：先把現在的樣子抽成模板形狀（templateFrom*），存的時候用同一套 patch 寫回去。
 *
 * 這裡全是純函式；存在哪、寫給誰由 utils/decorationTemplateStore.ts 和裝扮 App 負責。
 */
import type { CharacterProfile, ChatTheme, GroupProfile, OSTheme } from '../types';
import { LAYOUT_DEFAULTS, pickDecorationLayout, resolveDecorationTheme, validateBubble, validateDecoration, type DecorationLayout, type DecorationPreset } from './chatDecoration';
import { CHAT_FINE_TUNE_KEYS, mergeChatFineTune } from './chatFineTuneCss';
import { parseWhiteboxSound, stripWhiteboxSoundDirective, type WhiteboxSound } from './whiteboxSound';

export type ChatBackgroundStyle = NonNullable<OSTheme['chatBackgroundStyle']>;

export interface DecorationTemplate {
    id: string;
    name: string;
    /** 佈局（LAYOUT_DEFAULTS 那些欄位）；沒有＝跟著全局 */
    layout?: DecorationLayout;
    /** 氣泡主題 id（指過去，不內嵌）；沒有＝跟著全局 */
    bubbleThemeId?: string;
    /** 背景：image 是 blobref／網址，null＝不要圖；沒有＝跟著全局 */
    background?: { image: string | null; style: ChatBackgroundStyle };
    /** 提示音：src 'none'＝靜音；沒有＝跟著全局 */
    sound?: WhiteboxSound;
    /** 白框 CSS（不帶 @sully-sound 註釋，聲音另存）；沒有＝跟著全局 */
    css?: string;
    /** 給角色時 CSS 疊在全局 CSS 之上（預設取代全局）；群一律疊 */
    cssStacksOnGlobal?: boolean;
    createdAt: number;
    updatedAt: number;
}

/** 模板形狀的草稿（編輯器裡改的那份，自訂也用它） */
export type DecorationDraft = Omit<DecorationTemplate, 'id' | 'name' | 'createdAt' | 'updatedAt'>;

/** line：角色的某條關係線（非主線的身份鍵）；沒有＝主線 */
export type DecorationTargetRef = { kind: 'global' } | { kind: 'character'; id: string; line?: string } | { kind: 'group'; id: string };

const BG_STYLES: ChatBackgroundStyle[] = ['plain', 'grid', 'paper', 'mesh'];
const LAYOUT_KEYS = Object.keys(LAYOUT_DEFAULTS) as Array<keyof typeof LAYOUT_DEFAULTS>;

const hasText = (v?: string | null) => !!v && !!v.trim();
const ownSound = (s?: WhiteboxSound | null): WhiteboxSound | undefined => (s && s.src ? { src: s.src, volume: s.volume ?? 0.6 } : undefined);

// ─── 寫穿：模板（或草稿）→ 各對象的欄位 ───

/** 角色的裝扮欄位全清（＝跟著全局） */
export const CHARACTER_DECORATION_RESET: Partial<CharacterProfile> = {
    chatAppearance: undefined, chatFineTune: undefined, bubbleStyle: undefined, chatBackground: undefined,
    chromeCustomCss: undefined, chatSound: undefined, chatSoundBound: undefined, chatDecorationCssIsolated: undefined,
};

export const GROUP_DECORATION_RESET: Partial<GroupProfile> = {
    chromeCustomCss: undefined, chatSound: undefined, chatSoundBound: undefined, userBubbleThemeId: undefined,
};

/** 角色要寫的 patch；templateId 給了就記綁定，沒給＝存成自訂 */
export const characterPatchFromDraft = (draft: DecorationDraft, templateId?: string): Partial<CharacterProfile> => {
    const patch: Partial<CharacterProfile> = { ...CHARACTER_DECORATION_RESET, decorationTemplateId: templateId };
    let appearance: Partial<OSTheme> | undefined;
    if (draft.layout) {
        appearance = { ...LAYOUT_DEFAULTS, ...draft.layout };
        patch.chatFineTune = { enabled: true };
    }
    if (draft.background) {
        patch.chatBackground = draft.background.image || '';
        appearance = { ...(appearance || {}), chatBackgroundStyle: draft.background.style };
    }
    if (appearance) patch.chatAppearance = appearance;
    if (draft.bubbleThemeId) patch.bubbleStyle = draft.bubbleThemeId;
    if (draft.css !== undefined) {
        patch.chromeCustomCss = stripWhiteboxSoundDirective(draft.css);
        patch.chatDecorationCssIsolated = !draft.cssStacksOnGlobal;
    }
    if (draft.sound) {
        patch.chatSound = draft.sound;
        patch.chatSoundBound = false;
    }
    return patch;
};

/** 全局要寫的 patch：沒填的項目回到系統默認 */
export const themePatchFromDraft = (draft: DecorationDraft, templateId?: string): Partial<OSTheme> => ({
    ...LAYOUT_DEFAULTS,
    ...(draft.layout || {}),
    chatDefaultBubbleStyle: draft.bubbleThemeId,
    chatBackground: draft.background?.image || undefined,
    chatBackgroundStyle: draft.background?.style || 'plain',
    chatChromeCustomCss: draft.css !== undefined ? stripWhiteboxSoundDirective(draft.css) : undefined,
    chatSound: draft.sound,
    decorationTemplateId: templateId,
});

/** 群要寫的 patch：只有白框 CSS、提示音、我的氣泡；佈局和背景群本來就跟著全局 */
export const groupPatchFromDraft = (draft: DecorationDraft, templateId?: string): Partial<GroupProfile> => ({
    ...GROUP_DECORATION_RESET,
    ...(draft.css !== undefined ? { chromeCustomCss: stripWhiteboxSoundDirective(draft.css) } : {}),
    ...(draft.sound ? { chatSound: draft.sound, chatSoundBound: false } : {}),
    ...(draft.bubbleThemeId ? { userBubbleThemeId: draft.bubbleThemeId } : {}),
    decorationTemplateId: templateId,
});

/** 群吃不到的項目（畫面上要講清楚） */
export const groupIgnoredParts = (draft: DecorationDraft): string[] => [
    ...(draft.layout ? ['佈局'] : []),
    ...(draft.background ? ['背景'] : []),
];

// ─── 抽出：現在的樣子 → 草稿（編輯「自訂」用） ───

const pickFullLayout = (source: Partial<OSTheme>): DecorationLayout => {
    const out: Record<string, unknown> = {};
    for (const key of LAYOUT_KEYS) out[key] = (source as Record<string, unknown>)[key] ?? LAYOUT_DEFAULTS[key];
    return pickDecorationLayout(out);
};

/** 角色現在有沒有自己的佈局（跟畫面合併規則一樣算） */
const characterHasOwnLayout = (char: CharacterProfile): boolean => {
    const appearance = (char.chatAppearance || {}) as Record<string, unknown>;
    if (char.chatFineTune?.enabled !== false && LAYOUT_KEYS.some(k => appearance[k] !== undefined)) return true;
    return char.chatFineTune?.enabled === true && CHAT_FINE_TUNE_KEYS.some(k => char.chatFineTune![k] !== undefined);
};

export const templateFromCharacter = (char: CharacterProfile, theme: OSTheme): DecorationDraft => {
    const draft: DecorationDraft = {};
    if (characterHasOwnLayout(char)) {
        const base = resolveDecorationTheme(theme, char);
        draft.layout = pickFullLayout({ ...base, ...mergeChatFineTune(base, char.chatFineTune) });
    }
    if (char.bubbleStyle) draft.bubbleThemeId = char.bubbleStyle;
    const bgStyle = char.chatAppearance?.chatBackgroundStyle;
    if (char.chatBackground !== undefined || (bgStyle && BG_STYLES.includes(bgStyle))) {
        draft.background = { image: char.chatBackground || null, style: bgStyle && BG_STYLES.includes(bgStyle) ? bgStyle : (theme.chatBackgroundStyle || 'plain') };
    }
    if (char.chromeCustomCss !== undefined && (hasText(stripWhiteboxSoundDirective(char.chromeCustomCss)) || char.chatDecorationCssIsolated)) {
        draft.css = stripWhiteboxSoundDirective(char.chromeCustomCss);
        draft.cssStacksOnGlobal = !char.chatDecorationCssIsolated;
    }
    const sound = parseWhiteboxSound(char.chromeCustomCss) ?? ownSound(char.chatSound);
    if (sound) draft.sound = sound;
    return draft;
};

export const templateFromTheme = (theme: OSTheme): DecorationDraft => {
    const draft: DecorationDraft = { layout: pickFullLayout(theme) };
    if (theme.chatDefaultBubbleStyle) draft.bubbleThemeId = theme.chatDefaultBubbleStyle;
    if (theme.chatBackground || (theme.chatBackgroundStyle && theme.chatBackgroundStyle !== 'plain')) {
        draft.background = { image: theme.chatBackground || null, style: theme.chatBackgroundStyle || 'plain' };
    }
    if (hasText(stripWhiteboxSoundDirective(theme.chatChromeCustomCss))) draft.css = stripWhiteboxSoundDirective(theme.chatChromeCustomCss);
    const sound = parseWhiteboxSound(theme.chatChromeCustomCss) ?? ownSound(theme.chatSound);
    if (sound) draft.sound = sound;
    return draft;
};

export const templateFromGroup = (group: GroupProfile): DecorationDraft => {
    const draft: DecorationDraft = {};
    if (group.userBubbleThemeId) draft.bubbleThemeId = group.userBubbleThemeId;
    if (hasText(stripWhiteboxSoundDirective(group.chromeCustomCss))) {
        draft.css = stripWhiteboxSoundDirective(group.chromeCustomCss);
        draft.cssStacksOnGlobal = true;
    }
    const sound = parseWhiteboxSound(group.chromeCustomCss) ?? ownSound(group.chatSound);
    if (sound) draft.sound = sound;
    return draft;
};

export const draftOfTemplate = (template: DecorationTemplate): DecorationDraft => {
    const { id: _id, name: _name, createdAt: _c, updatedAt: _u, ...draft } = template;
    return structuredClone(draft);
};

// ─── 狀態：這個聊天現在用什麼 ───

export type DecorationStatus =
    | { kind: 'template'; template: DecorationTemplate }
    | { kind: 'custom' }
    /** 角色、群：什麼都沒設，跟著全局 */
    | { kind: 'follow' };

export const characterHasOwnDecoration = (char: CharacterProfile): boolean =>
    !!char.bubbleStyle || char.chatBackground !== undefined || hasText(char.chromeCustomCss) || !!char.chatDecorationCssIsolated
    || !!char.chatSound?.src || characterHasOwnLayout(char)
    || (!!char.chatAppearance?.chatBackgroundStyle && BG_STYLES.includes(char.chatAppearance.chatBackgroundStyle));

export const groupHasOwnDecoration = (group: GroupProfile): boolean =>
    !!group.userBubbleThemeId || hasText(group.chromeCustomCss) || !!group.chatSound?.src;

export const statusOf = (
    target: { decorationTemplateId?: string },
    templates: DecorationTemplate[],
    hasOwn: boolean,
): DecorationStatus => {
    const template = target.decorationTemplateId ? templates.find(t => t.id === target.decorationTemplateId) : undefined;
    if (template) return { kind: 'template', template };
    return hasOwn ? { kind: 'custom' } : { kind: 'follow' };
};

export const characterStatus = (char: CharacterProfile, templates: DecorationTemplate[]) => statusOf(char, templates, characterHasOwnDecoration(char));
export const groupStatus = (group: GroupProfile, templates: DecorationTemplate[]) => statusOf(group, templates, groupHasOwnDecoration(group));
/** 全局沒有「跟著誰」：沒綁模板就是自訂 */
export const themeStatus = (theme: OSTheme, templates: DecorationTemplate[]): DecorationStatus => statusOf(theme, templates, true);

/** 誰在用這份模板 */
export const templateUsage = (
    templateId: string,
    data: { theme: OSTheme; characters: CharacterProfile[]; groups: GroupProfile[] },
): DecorationTargetRef[] => [
    ...(data.theme.decorationTemplateId === templateId ? [{ kind: 'global' } as const] : []),
    ...data.characters.filter(c => !c.altOf && c.decorationTemplateId === templateId).map(c => ({ kind: 'character', id: c.id } as const)),
    ...data.groups.filter(g => g.decorationTemplateId === templateId).map(g => ({ kind: 'group', id: g.id } as const)),
];

/**
 * 寫穿要寫的全部對象：templateUsage 加上小號、非主線（聊天裡的快捷面板能把某條線綁到模板）。
 * 非主線沒設的欄位照主線（utils/chatLine.ts），所以模板沒填的項目在那條線上是「跟著主線」。
 */
export const templateBindings = (
    templateId: string,
    data: { theme: OSTheme; characters: CharacterProfile[]; groups: GroupProfile[] },
): DecorationTargetRef[] => [
    ...(data.theme.decorationTemplateId === templateId ? [{ kind: 'global' } as const] : []),
    ...data.characters.flatMap(c => [
        ...(c.decorationTemplateId === templateId ? [{ kind: 'character', id: c.id } as const] : []),
        ...Object.entries(c.lines || {}).filter(([, own]) => own?.decorationTemplateId === templateId).map(([line]) => ({ kind: 'character', id: c.id, line } as const)),
    ]),
    ...data.groups.filter(g => g.decorationTemplateId === templateId).map(g => ({ kind: 'group', id: g.id } as const)),
];

// ─── 自動解除綁定：別處改了裝扮欄位 ───

const CHARACTER_DECORATION_KEYS = Object.keys(CHARACTER_DECORATION_RESET) as Array<keyof CharacterProfile>;
const GROUP_DECORATION_KEYS = Object.keys(GROUP_DECORATION_RESET) as Array<keyof GroupProfile>;
const THEME_DECORATION_KEYS: Array<keyof OSTheme> = [...LAYOUT_KEYS, 'chatDefaultBubbleStyle', 'chatBackground', 'chatBackgroundStyle', 'chatChromeCustomCss', 'chatSound'];

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const touches = <T extends object>(prev: T, patch: Partial<T>, keys: Array<keyof T>) =>
    keys.some(k => Object.prototype.hasOwnProperty.call(patch, k) && !same(prev[k], patch[k]));

/** patch 動到了裝扮欄位、又不是模板自己寫的 → 順手解除綁定 */
export const detachCharacterPatch = (prev: CharacterProfile, patch: Partial<CharacterProfile>): Partial<CharacterProfile> =>
    (prev.decorationTemplateId && !Object.prototype.hasOwnProperty.call(patch, 'decorationTemplateId') && touches(prev, patch, CHARACTER_DECORATION_KEYS)
        ? { ...patch, decorationTemplateId: undefined } : patch);

export const detachThemePatch = (prev: OSTheme, patch: Partial<OSTheme>): Partial<OSTheme> =>
    (prev.decorationTemplateId && !Object.prototype.hasOwnProperty.call(patch, 'decorationTemplateId') && touches(prev, patch, THEME_DECORATION_KEYS)
        ? { ...patch, decorationTemplateId: undefined } : patch);

export const detachGroupPatch = (prev: GroupProfile, patch: Partial<GroupProfile>): Partial<GroupProfile> =>
    (prev.decorationTemplateId && !Object.prototype.hasOwnProperty.call(patch, 'decorationTemplateId') && touches(prev, patch, GROUP_DECORATION_KEYS)
        ? { ...patch, decorationTemplateId: undefined } : patch);

// ─── 模板清單的小工具 ───

export const newTemplateId = () => `dtpl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

export const makeTemplate = (name: string, draft: DecorationDraft, now = Date.now()): DecorationTemplate => ({
    ...structuredClone(draft), id: newTemplateId(), name: name.trim().slice(0, 60) || '我的裝扮', createdAt: now, updatedAt: now,
});

/** 跟現有的撞名就加編號（「我的裝扮 2」），清單裡才分得出來 */
export const uniqueTemplateName = (name: string, existing: Array<{ name: string }>): string => {
    const base = name.trim().slice(0, 60) || '我的裝扮';
    if (!existing.some(t => t.name === base)) return base;
    for (let i = 2; ; i++) if (!existing.some(t => t.name === `${base} ${i}`)) return `${base} ${i}`;
};

/** 原地複製一份：誰也沒指定 */
export const duplicateTemplate = (template: DecorationTemplate, existing: DecorationTemplate[], now = Date.now()): DecorationTemplate => {
    const base = `${template.name}（副本）`;
    let name = base;
    for (let i = 2; existing.some(t => t.name === name); i++) name = `${base} ${i}`;
    return { ...structuredClone(template), id: newTemplateId(), name, createdAt: now, updatedAt: now };
};

/** 一行字講這份模板有什麼 */
export const describeDraft = (draft: DecorationDraft, bubbleName: (id: string) => string): string => {
    const parts: string[] = [];
    if (draft.bubbleThemeId) parts.push(`氣泡 ${bubbleName(draft.bubbleThemeId)}`);
    if (draft.layout) parts.push('佈局');
    if (draft.background) parts.push(draft.background.image ? '背景圖' : '背景底紋');
    if (draft.sound) parts.push(draft.sound.src === 'none' ? '靜音' : '提示音');
    if (draft.css !== undefined && hasText(draft.css)) parts.push(`CSS ${draft.css.trim().split('\n').length} 行`);
    return parts.join(' · ') || '全部跟著全局';
};

// ─── 舊的整套預設、匯入匯出（sullyos-chat-decoration v1） ───

const canonical = (v: unknown): unknown => (Array.isArray(v) ? v.map(canonical)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().filter(k => (v as Record<string, unknown>)[k] !== undefined).map(k => [k, canonical((v as Record<string, unknown>)[k])])) : v);
const normalizedBubble = (b: ChatTheme) => {
    try { const v = validateBubble(b); return JSON.stringify(canonical({ user: v.user, ai: v.ai, css: v.customCss || '' })); } catch { return null; }
};
/** 兩套氣泡長得一樣嗎（不看 id、名字、欄位順序） */
export const sameBubble = (a: ChatTheme, b: ChatTheme) => {
    const x = normalizedBubble(a);
    return x !== null && x === normalizedBubble(b);
};

export interface PresetConversionDeps {
    /** data: 圖片轉 blobref */
    migrateImage: (dataUrl: string) => Promise<string>;
    /** 內嵌氣泡的圖片轉 blobref */
    migrateBubble: (bubble: ChatTheme) => Promise<ChatTheme>;
    newBubbleId: () => string;
}

/** 舊預設／匯入的檔 → 模板；內嵌的氣泡跟已有的一模一樣就沿用，不然多存一套 */
export const presetToTemplate = async (
    raw: DecorationPreset,
    existingBubbles: ChatTheme[],
    deps: PresetConversionDeps,
    now = Date.now(),
): Promise<{ template: DecorationTemplate; newBubble?: ChatTheme }> => {
    const preset = validateDecoration(raw);
    const p = preset.parts;
    const draft: DecorationDraft = {};
    let newBubble: ChatTheme | undefined;
    if (p.layout) draft.layout = { ...LAYOUT_DEFAULTS, ...p.layout };
    if (p.bubbles) {
        const migrated = await deps.migrateBubble({ ...p.bubbles, type: 'custom' });
        const found = existingBubbles.find(b => sameBubble(b, migrated) || sameBubble(b, p.bubbles!));
        if (found) draft.bubbleThemeId = found.id;
        else {
            newBubble = { ...migrated, id: deps.newBubbleId(), name: p.bubbles.name || `${preset.name} 的氣泡`, type: 'custom' };
            draft.bubbleThemeId = newBubble.id;
        }
    }
    if (p.background) {
        const image = p.background.image ? (p.background.image.startsWith('data:') ? await deps.migrateImage(p.background.image) : p.background.image) : null;
        draft.background = { image, style: p.background.style || 'plain' };
    }
    if (p.css !== undefined) {
        draft.css = stripWhiteboxSoundDirective(p.css);
        const embedded = parseWhiteboxSound(p.css);
        if (embedded && p.sound === undefined) draft.sound = embedded;
    }
    if (p.sound !== undefined) draft.sound = p.sound ? { src: p.sound.src, volume: p.sound.volume ?? 0.6 } : { src: 'none' };
    return { template: makeTemplate(preset.name, draft, now), newBubble };
};

/** 模板 → 可以分享的檔（圖片還是 blobref／網址，匯出前要再過 portableTree） */
export const templateToPresetDraft = (template: DecorationTemplate, bubbles: ChatTheme[]): DecorationPreset => {
    const parts: DecorationPreset['parts'] = {};
    if (template.layout) parts.layout = { ...LAYOUT_DEFAULTS, ...template.layout };
    const bubble = template.bubbleThemeId ? bubbles.find(b => b.id === template.bubbleThemeId) : undefined;
    if (bubble) parts.bubbles = validateBubble(structuredClone(bubble));
    if (template.background) parts.background = { image: template.background.image, style: template.background.style };
    if (template.sound) parts.sound = template.sound.src === 'none' ? null : { src: template.sound.src, volume: template.sound.volume ?? 0.6 };
    if (template.css !== undefined) parts.css = template.css;
    return { format: 'sullyos-chat-decoration', version: 1, name: template.name, parts };
};

/** 存檔讀回來時檢查一份模板；壞的回 null（整份清單不因為一份壞掉就全丟） */
export const sanitizeTemplate = (value: unknown): DecorationTemplate | null => {
    if (!value || typeof value !== 'object') return null;
    const v = value as Record<string, any>;
    if (typeof v.id !== 'string' || !v.id || typeof v.name !== 'string') return null;
    try {
        const out: DecorationTemplate = {
            id: v.id, name: v.name.slice(0, 60) || '我的裝扮',
            createdAt: Number(v.createdAt) || 0, updatedAt: Number(v.updatedAt) || 0,
        };
        if (v.layout) out.layout = pickDecorationLayout(v.layout);
        if (typeof v.bubbleThemeId === 'string' && v.bubbleThemeId) out.bubbleThemeId = v.bubbleThemeId;
        if (v.background && BG_STYLES.includes(v.background.style)) out.background = { image: typeof v.background.image === 'string' ? v.background.image : null, style: v.background.style };
        if (v.sound && typeof v.sound.src === 'string' && v.sound.src) out.sound = { src: v.sound.src, volume: typeof v.sound.volume === 'number' ? v.sound.volume : 0.6 };
        if (typeof v.css === 'string') out.css = v.css;
        if (v.cssStacksOnGlobal === true) out.cssStacksOnGlobal = true;
        return out;
    } catch {
        return null;
    }
};
