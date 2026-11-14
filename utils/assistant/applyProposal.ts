/**
 * 提案卡片的「套用」「還原」（plans/ai-assistant.md 第 3 節）：美化 CSS（第 2 批）、預設（第 3 批）。
 * 套用前再檢查一次（資料可能變了）、記下那一刻的內容當快照，再寫；還原就是把快照寫回去。
 * 真的寫交給 write（畫面那頭接 updateTheme／updateCharacter／…），這裡不碰 React。
 */
import type { AssistantCssProposal, AssistantPresetBinding, AssistantPresetProposal, StoryTheaterPreset, StoryTheaterPresetDocument } from '../../types';
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
