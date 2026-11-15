/**
 * 裝扮模板存在哪（plans/decoration-app.md 第 3 節）：assets 表的一列 JSON（跟舊的整套預設同一張表，
 * 完整／媒體備份會帶上，blob GC 也掃得到裡面的 blobref）。
 * 第一次讀的時候把舊的整套預設（chat_decoration_presets_v1）搬成模板；舊的那列留著不刪。
 */
import type { ChatTheme } from '../types';
import { DB } from './db';
import { migrateDataUrlToRef, migrateChatThemeBlobRefs } from './blobRef';
import { validateDecoration } from './chatDecoration';
import { presetToTemplate, sanitizeTemplate, type DecorationTemplate } from './decorationTemplates';

export const DECORATION_TEMPLATES_KEY = 'decoration_templates_v1';
export const LEGACY_DECORATION_PRESETS_KEY = 'chat_decoration_presets_v1';
/** 別的 App（例如聊天裡的快捷面板）想知道模板改了 */
export const DECORATION_TEMPLATES_CHANGED_EVENT = 'soren:decoration-templates-changed';

interface StoredTemplates {
    version: 1;
    templates: DecorationTemplate[];
    /** 舊的整套預設搬過了沒 */
    migratedLegacy?: boolean;
}

const parse = (raw: string | null): StoredTemplates | null => {
    if (!raw) return null;
    try {
        const v = JSON.parse(raw);
        if (!v || !Array.isArray(v.templates)) return null;
        return { version: 1, templates: v.templates.map(sanitizeTemplate).filter(Boolean) as DecorationTemplate[], migratedLegacy: !!v.migratedLegacy };
    } catch {
        return null;
    }
};

const write = async (data: StoredTemplates) => {
    await DB.saveAsset(DECORATION_TEMPLATES_KEY, JSON.stringify(data));
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(DECORATION_TEMPLATES_CHANGED_EVENT));
};

export const saveDecorationTemplates = async (templates: DecorationTemplate[]) => {
    await write({ version: 1, templates, migratedLegacy: true });
};

/**
 * 讀模板；還沒搬過舊預設就順便搬（新的氣泡交給 addBubble 存）。
 * 搬的時候一份壞掉就跳過那份，不擋其他的。
 */
export const loadDecorationTemplates = async (opts: {
    existingBubbles: ChatTheme[];
    addBubble: (bubble: ChatTheme) => Promise<void> | void;
}): Promise<{ templates: DecorationTemplate[]; migrated: number }> => {
    const stored = parse(await DB.getAsset(DECORATION_TEMPLATES_KEY)) || { version: 1 as const, templates: [] };
    if (stored.migratedLegacy) return { templates: stored.templates, migrated: 0 };

    let legacy: unknown[] = [];
    try {
        const raw = await DB.getAsset(LEGACY_DECORATION_PRESETS_KEY);
        const list = raw ? JSON.parse(raw) : [];
        if (Array.isArray(list)) legacy = list;
    } catch { /* 舊資料讀不了就算了 */ }

    const bubbles = [...opts.existingBubbles];
    const added: DecorationTemplate[] = [];
    for (const item of legacy) {
        try {
            const { template, newBubble } = await presetToTemplate(validateDecoration(item), bubbles, {
                migrateImage: migrateDataUrlToRef,
                migrateBubble: migrateChatThemeBlobRefs,
                newBubbleId: () => `decoration-${crypto.randomUUID()}`,
            });
            if (newBubble) {
                await opts.addBubble(newBubble);
                bubbles.push(newBubble);
            }
            added.push(template);
        } catch (error) {
            console.warn('[decoration] 舊的整套預設搬不過來，跳過', error);
        }
    }
    const templates = [...stored.templates, ...added];
    await write({ version: 1, templates, migratedLegacy: true });
    return { templates, migrated: added.length };
};
