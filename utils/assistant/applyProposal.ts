/**
 * 提案卡片的「套用」「還原」（plans/ai-assistant.md 第 3 節）：美化 CSS（第 2 批）、預設（第 3 批）、世界書和桌面小組件（第 4 批）。
 * 套用前再檢查一次（資料可能變了）、記下那一刻的內容當快照，再寫；還原就是把快照寫回去。
 * 真的寫交給 write（畫面那頭接 updateTheme／updateCharacter／…），這裡不碰 React。
 */
import type { AssistantCssProposal, AssistantPresetBinding, AssistantPresetProposal, AssistantWidgetProposal, AssistantWorldbookProposal, MountedWorldbook, StoryTheaterPreset, StoryTheaterPresetDocument, Worldbook } from '../../types';
import { nextMounted, type WorldbookData } from './worldbookOps';
import type { WidgetData } from './widgetOps';
import type { CustomWidgetTemplate } from '../customWidget';
import type { MeetingPresetDoc, MeetingPresetRecord } from '../meetingPreset/types';
import { BUILTIN_PRESET } from '../presetBinding';
import { type PresetData, readBinding } from './presetOps';
import { buildCssWrite, type CssData, type CssWrite, cssTargetStillThere, findCssLocation, readLocationCss, validateLocationCss } from './cssLocations';

export type CssWriteFn = (write: CssWrite) => Promise<void> | void;

const locOf = (proposal: AssistantCssProposal) => {
    const loc = findCssLocation(proposal.location);
    if (!loc) throw new Error('這個位置已經不存在了');
    return loc;
};

export const applyCssProposal = async (proposal: AssistantCssProposal, data: CssData, write: CssWriteFn): Promise<AssistantCssProposal> => {
    const loc = locOf(proposal);
    if (!cssTargetStillThere(loc, proposal.targetId, data)) throw new Error('要改的角色或群已經不在了');
    if (proposal.css) {
        const errors = validateLocationCss(loc, proposal.css);
        if (errors.length) throw new Error(`檢查沒過：${errors[0]}`);
    }
    const existed = loc.target !== 'chatTheme' || data.customThemes.some(t => t.id === proposal.targetId);
    const snapshot = { css: existed ? readLocationCss(loc, proposal.targetId, data) : '', existed, at: Date.now() };
    const newTheme = proposal.newThemeName ? { id: proposal.targetId, name: proposal.newThemeName } : undefined;
    await write(buildCssWrite(loc, proposal.targetId, proposal.css, data, newTheme));
    return { ...proposal, status: 'applied', snapshot, appliedAt: Date.now() };
};

/** 套用之後用戶自己又改過（還原會把那些改動也蓋掉，畫面要先問） */
export const changedSinceApply = (proposal: AssistantCssProposal, data: CssData): boolean => {
    const loc = findCssLocation(proposal.location);
    if (!loc || proposal.status !== 'applied') return false;
    if (loc.target === 'chatTheme' && !data.customThemes.some(t => t.id === proposal.targetId)) return true;
    return readLocationCss(loc, proposal.targetId, data).trim() !== proposal.css.trim();
};

export const restoreCssProposal = async (proposal: AssistantCssProposal, data: CssData, write: CssWriteFn): Promise<AssistantCssProposal> => {
    const loc = locOf(proposal);
    if (!proposal.snapshot) throw new Error('這張卡片沒有快照，沒辦法還原');
    if (!proposal.snapshot.existed) {
        if (loc.target === 'chatTheme' && data.customThemes.some(t => t.id === proposal.targetId)) {
            await write({ kind: 'removeChatTheme', id: proposal.targetId });
        }
    } else {
        if (!cssTargetStillThere(loc, proposal.targetId, data)) throw new Error('要還原的角色或群已經不在了');
        await write(buildCssWrite(loc, proposal.targetId, proposal.snapshot.css, data));
    }
    return { ...proposal, status: 'restored' };
};

// ─── 預設（第 3 批） ───

/** 畫面那頭真的寫預設、改綁定 */
export interface PresetWriter {
    saveGeneral: (record: MeetingPresetRecord) => Promise<void> | void;
    deleteGeneral: (id: string) => Promise<void> | void;
    saveStory: (preset: StoryTheaterPreset) => Promise<void> | void;
    deleteStory: (id: string) => Promise<void> | void;
    /** value undefined＝清掉（場景預設回內建、角色／群回跟著場景預設） */
    setBinding: (binding: AssistantPresetBinding, value: string | undefined) => Promise<void> | void;
}

/** 綁定要寫的值：'builtin' 在場景預設上就是不設；'' 是跟著場景預設 */
const bindingValue = (binding: AssistantPresetBinding, bindTo: string): string | undefined => {
    if (!bindTo) return undefined;
    if (bindTo === BUILTIN_PRESET) return binding.kind === 'scene' ? undefined : BUILTIN_PRESET;
    return bindTo;
};

export const applyPresetProposal = async (proposal: AssistantPresetProposal, data: PresetData, writer: PresetWriter): Promise<AssistantPresetProposal> => {
    const now = Date.now();
    let snapshotDoc: unknown;
    if (proposal.doc) {
        if (proposal.presetKind === 'general') {
            const existing = data.general.find(r => r.id === proposal.presetId);
            if (!proposal.isNew && !existing) throw new Error('這份預設已經不在了');
            if (proposal.isNew && existing) throw new Error('這份預設已經建過了');
            const doc = proposal.doc as MeetingPresetDoc;
            snapshotDoc = existing ? existing.doc : null;
            await writer.saveGeneral(existing
                ? { ...existing, name: doc.name, doc, updatedAt: now }
                : { id: proposal.presetId, name: doc.name, doc, createdAt: now, updatedAt: now });
        } else {
            const existing = data.story.find(p => p.id === proposal.presetId);
            if (!proposal.isNew && !existing) throw new Error('這份預設已經不在了');
            if (proposal.isNew && existing) throw new Error('這份預設已經建過了');
            const doc = proposal.doc as StoryTheaterPresetDocument;
            snapshotDoc = existing ? existing.document : null;
            await writer.saveStory(existing
                ? { ...existing, name: doc.name, document: doc, updatedAt: now }
                : { id: proposal.presetId, name: doc.name, format: 'sullyos-story-preset', document: doc, createdAt: now, updatedAt: now });
        }
    }
    const bindings: Array<{ binding: AssistantPresetBinding; previous?: string }> = [];
    for (const binding of proposal.bindings || []) {
        bindings.push({ binding, previous: readBinding(binding, data) });
        await writer.setBinding(binding, bindingValue(binding, proposal.bindTo ?? proposal.presetId));
    }
    return {
        ...proposal,
        status: 'applied',
        appliedAt: now,
        snapshot: { ...(proposal.doc ? { doc: snapshotDoc } : {}), ...(bindings.length ? { bindings } : {}), at: now },
    };
};

/** 套用之後這份預設又被改過（還原會一起蓋掉，畫面要先問） */
export const presetChangedSinceApply = (proposal: AssistantPresetProposal, data: PresetData): boolean => {
    if (proposal.status !== 'applied' || !proposal.doc) return false;
    const current = proposal.presetKind === 'general'
        ? data.general.find(r => r.id === proposal.presetId)?.doc
        : data.story.find(p => p.id === proposal.presetId)?.document;
    return !current || JSON.stringify(current) !== JSON.stringify(proposal.doc);
};

export const restorePresetProposal = async (proposal: AssistantPresetProposal, data: PresetData, writer: PresetWriter): Promise<AssistantPresetProposal> => {
    const snapshot = proposal.snapshot;
    if (!snapshot) throw new Error('這張卡片沒有快照，沒辦法還原');
    if ('doc' in snapshot) {
        const now = Date.now();
        if (proposal.presetKind === 'general') {
            const existing = data.general.find(r => r.id === proposal.presetId);
            if (snapshot.doc === null) { if (existing) await writer.deleteGeneral(proposal.presetId); }
            else if (existing) {
                const doc = snapshot.doc as MeetingPresetDoc;
                await writer.saveGeneral({ ...existing, name: doc.name, doc, updatedAt: now });
            } else throw new Error('這份預設已經被刪了，沒辦法還原內容');
        } else {
            const existing = data.story.find(p => p.id === proposal.presetId);
            if (snapshot.doc === null) { if (existing) await writer.deleteStory(proposal.presetId); }
            else if (existing) {
                const doc = snapshot.doc as StoryTheaterPresetDocument;
                await writer.saveStory({ ...existing, name: doc.name, document: doc, updatedAt: now });
            } else throw new Error('這份預設已經被刪了，沒辦法還原內容');
        }
    }
    for (const { binding, previous } of snapshot.bindings || []) {
        await writer.setBinding(binding, previous);
    }
    return { ...proposal, status: 'restored' };
};

// ─── 世界書（第 4 批） ───

/** 畫面那頭真的寫：新增走 addWorldbook、改走 updateWorldbook（同一事務順便同步角色緩存）、掛載走 updateCharacter */
export interface WorldbookWriter {
    add: (book: Worldbook) => Promise<void> | void;
    update: (id: string, patch: Partial<Worldbook>) => Promise<void> | void;
    /** 只用在還原時刪掉 Sore 自己加的條目 */
    remove: (ids: string[]) => Promise<void> | void;
    setMounted: (charId: string, mounted: MountedWorldbook[]) => Promise<void> | void;
}

export const applyWorldbookProposal = async (proposal: AssistantWorldbookProposal, data: WorldbookData, writer: WorldbookWriter): Promise<AssistantWorldbookProposal> => {
    const byId = new Map(data.worldbooks.map(b => [b.id, b]));
    const missing = proposal.updates.find(u => !byId.has(u.id));
    if (missing) throw new Error('有條目已經不在了，這張卡片套不上去');
    if (proposal.adds.some(b => byId.has(b.id))) throw new Error('這些條目已經加過了');
    for (const m of proposal.mounts) if (!data.characters.some(c => c.id === m.charId)) throw new Error('要掛的角色已經不在了');
    const now = Date.now();
    const snapshot = {
        entries: proposal.updates.map(u => ({ ...byId.get(u.id)! })),
        mounts: proposal.mounts.map(m => ({ charId: m.charId, mounted: [...(data.characters.find(c => c.id === m.charId)?.mountedWorldbooks || [])] })),
        at: now,
    };
    for (const book of proposal.adds) await writer.add({ ...book, createdAt: now, updatedAt: now });
    for (const u of proposal.updates) await writer.update(u.id, { ...u.patch, updatedAt: now });
    // 套用完每條的樣子：沒改到的照原樣（整組掛載也要掛它們）、改到的套上改動、新加的
    const patches = new Map(proposal.updates.map(u => [u.id, u.patch]));
    const finalBooks = new Map<string, Worldbook>([
        ...data.worldbooks.map(b => [b.id, { ...b, ...(patches.get(b.id) || {}) }] as [string, Worldbook]),
        ...proposal.adds.map(b => [b.id, b] as [string, Worldbook]),
    ]);
    for (const m of proposal.mounts) {
        const current = data.characters.find(c => c.id === m.charId)?.mountedWorldbooks || [];
        await writer.setMounted(m.charId, nextMounted(current, m, finalBooks));
    }
    return { ...proposal, status: 'applied', appliedAt: now, snapshot };
};

/** 套用之後這幾條又被改過（還原會蓋掉，畫面要先問） */
export const worldbookChangedSinceApply = (proposal: AssistantWorldbookProposal, data: WorldbookData): boolean => {
    if (proposal.status !== 'applied' || !proposal.appliedAt) return false;
    const ids = new Set([...proposal.updates.map(u => u.id), ...proposal.adds.map(b => b.id)]);
    return data.worldbooks.some(b => ids.has(b.id) && b.updatedAt > proposal.appliedAt! + 2000);
};

export const restoreWorldbookProposal = async (proposal: AssistantWorldbookProposal, data: WorldbookData, writer: WorldbookWriter): Promise<AssistantWorldbookProposal> => {
    const snapshot = proposal.snapshot;
    if (!snapshot) throw new Error('這張卡片沒有快照，沒辦法還原');
    const existing = new Set(data.worldbooks.map(b => b.id));
    const added = proposal.adds.map(b => b.id).filter(id => existing.has(id));
    if (added.length) await writer.remove(added);
    for (const before of snapshot.entries) {
        if (!existing.has(before.id)) continue;
        const u = proposal.updates.find(x => x.id === before.id);
        // 只寫回這張卡片改過的欄位（原本沒有的欄位寫回 undefined）
        const patch = Object.fromEntries(Object.keys(u?.patch || {}).map(k => [k, (before as unknown as Record<string, unknown>)[k]])) as Partial<Worldbook>;
        await writer.update(before.id, patch);
    }
    for (const m of snapshot.mounts) {
        if (data.characters.some(c => c.id === m.charId)) await writer.setMounted(m.charId, m.mounted);
    }
    return { ...proposal, status: 'restored' };
};

// ─── 桌面小組件（第 4 批） ───

export interface WidgetWriter {
    /** 寫整份模板清單；removePlacedOf 有給的話，同時把桌面上用這個模板的每一份拿掉 */
    setTemplates: (templates: CustomWidgetTemplate[], removePlacedOf?: string) => Promise<void> | void;
    requestPlacement: (templateId: string) => void;
    cancelPlacement: (templateId: string) => void;
}

export const applyWidgetProposal = async (proposal: AssistantWidgetProposal, data: WidgetData, writer: WidgetWriter): Promise<AssistantWidgetProposal> => {
    const existing = data.templates.find(t => t.id === proposal.templateId);
    if (!proposal.isNew && !existing) throw new Error('這個小組件已經不在了');
    if (proposal.isNew && existing) throw new Error('這個小組件已經建過了');
    const now = Date.now();
    const template = { ...proposal.template, updatedAt: now };
    const next = existing ? data.templates.map(t => (t.id === template.id ? template : t)) : [...data.templates, template];
    // 先留字條再寫：桌面看到模板出現時字條已經在
    if (proposal.isNew && proposal.place) writer.requestPlacement(template.id);
    await writer.setTemplates(next);
    return { ...proposal, status: 'applied', appliedAt: now, snapshot: { template: existing ? { ...existing } : null, at: now } };
};

export const widgetChangedSinceApply = (proposal: AssistantWidgetProposal, data: WidgetData): boolean => {
    if (proposal.status !== 'applied' || !proposal.appliedAt) return false;
    const current = data.templates.find(t => t.id === proposal.templateId);
    return !current || current.updatedAt > proposal.appliedAt + 2000;
};

export const restoreWidgetProposal = async (proposal: AssistantWidgetProposal, data: WidgetData, writer: WidgetWriter): Promise<AssistantWidgetProposal> => {
    const snapshot = proposal.snapshot;
    if (!snapshot) throw new Error('這張卡片沒有快照，沒辦法還原');
    if (snapshot.template === null) {
        writer.cancelPlacement(proposal.templateId);
        await writer.setTemplates(data.templates.filter(t => t.id !== proposal.templateId), proposal.templateId);
    } else {
        const before = snapshot.template;
        const next = data.templates.some(t => t.id === before.id)
            ? data.templates.map(t => (t.id === before.id ? before : t))
            : [...data.templates, before];
        await writer.setTemplates(next);
    }
    return { ...proposal, status: 'restored' };
};
