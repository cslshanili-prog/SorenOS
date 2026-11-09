/**
 * 預設管理頁的編輯動作（純函式，回傳新的 doc）：條目新增／刪除／上下移、正則上下移、複製預設。
 *
 * 條目的送出順序是 doc.prompts 的順序；分組（doc.groups）只管介面怎麼分區，畫面上同一區的順序照
 * group.promptIds。上下移只跟「同一區的鄰居」換位置，doc.prompts 和 promptIds 一起換，兩邊不會走樣。
 */

import type { MeetingPresetDoc, MeetingPresetPrompt } from './types';

const makePromptId = () => `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

/** 不在任何分組裡的條目，畫面上歸到「未分組／全部條目」那區 */
export const UNGROUPED_SECTION_ID = '__rest__';

/** 某一區（分組或未分組）在畫面上的條目 id，照畫面順序 */
export const sectionPromptIds = (doc: MeetingPresetDoc, sectionId: string): string[] => {
    const exists = new Set(doc.prompts.map(p => p.id));
    if (sectionId !== UNGROUPED_SECTION_ID) {
        return (doc.groups.find(g => g.id === sectionId)?.promptIds || []).filter(id => exists.has(id));
    }
    const grouped = new Set(doc.groups.flatMap(g => g.promptIds));
    return doc.prompts.filter(p => !grouped.has(p.id)).map(p => p.id);
};

const sectionOf = (doc: MeetingPresetDoc, promptId: string): string =>
    doc.groups.find(g => g.promptIds.includes(promptId))?.id || UNGROUPED_SECTION_ID;

/** 跟同一區的上一個／下一個換位置；到頭了就原樣 */
export const movePrompt = (doc: MeetingPresetDoc, promptId: string, direction: -1 | 1): MeetingPresetDoc => {
    const section = sectionOf(doc, promptId);
    const ids = sectionPromptIds(doc, section);
    const at = ids.indexOf(promptId);
    const neighbor = ids[at + direction];
    if (at < 0 || !neighbor) return doc;
    const prompts = [...doc.prompts];
    const a = prompts.findIndex(p => p.id === promptId);
    const b = prompts.findIndex(p => p.id === neighbor);
    [prompts[a], prompts[b]] = [prompts[b], prompts[a]];
    const groups = doc.groups.map(g => {
        if (g.id !== section) return g;
        const next = [...g.promptIds];
        const i = next.indexOf(promptId);
        const j = next.indexOf(neighbor);
        if (i >= 0 && j >= 0) [next[i], next[j]] = [next[j], next[i]];
        return { ...g, promptIds: next };
    });
    return { ...doc, prompts, groups };
};

/** 在某一區最後面加一個空白條目（送出順序上也接在那區最後一個後面，但不越過聊天記錄）；回傳新 doc 和新條目 */
export const addPrompt = (doc: MeetingPresetDoc, sectionId: string): { doc: MeetingPresetDoc; prompt: MeetingPresetPrompt } => {
    const prompt: MeetingPresetPrompt = { id: makePromptId(), name: '新條目', enabled: true, role: 'system', content: '' };
    const chatIndex = doc.prompts.findIndex(p => p.slot === 'chatHistory');
    // 聊天記錄不算：新條目預設送在聊天記錄前面，要放後面再用排序移
    const ids = sectionPromptIds(doc, sectionId).filter(id => id !== doc.prompts[chatIndex]?.id);
    const last = ids[ids.length - 1];
    const lastIndex = last ? doc.prompts.findIndex(p => p.id === last) : -1;
    // 那區是空的（或只有聊天記錄）：放在聊天記錄前面，沒有聊天記錄就放最後
    const fallback = chatIndex >= 0 ? chatIndex : doc.prompts.length;
    const insertAt = lastIndex >= 0 ? lastIndex + 1 : fallback;
    const prompts = [...doc.prompts.slice(0, insertAt), prompt, ...doc.prompts.slice(insertAt)];
    const groups = sectionId === UNGROUPED_SECTION_ID
        ? doc.groups
        : doc.groups.map(g => (g.id === sectionId ? { ...g, promptIds: [...g.promptIds, prompt.id] } : g));
    return { doc: { ...doc, prompts, groups }, prompt };
};

/** 資料位置（聊天記錄、角色描述這些）不能刪，只能關 */
export const canDeletePrompt = (prompt: MeetingPresetPrompt): boolean => !prompt.slot;

export const removePrompt = (doc: MeetingPresetDoc, promptId: string): MeetingPresetDoc => {
    const target = doc.prompts.find(p => p.id === promptId);
    if (!target || !canDeletePrompt(target)) return doc;
    return {
        ...doc,
        prompts: doc.prompts.filter(p => p.id !== promptId),
        groups: doc.groups.map(g => ({ ...g, promptIds: g.promptIds.filter(id => id !== promptId) })),
    };
};

/** 正則照清單順序一條接一條跑；上下移就是換順序 */
export const moveRegexScript = (doc: MeetingPresetDoc, scriptId: string, direction: -1 | 1): MeetingPresetDoc => {
    const at = doc.regexScripts.findIndex(r => r.id === scriptId);
    const to = at + direction;
    if (at < 0 || to < 0 || to >= doc.regexScripts.length) return doc;
    const regexScripts = [...doc.regexScripts];
    [regexScripts[at], regexScripts[to]] = [regexScripts[to], regexScripts[at]];
    return { ...doc, regexScripts };
};

/** 複製一份：深拷貝，名字加「（副本）」 */
export const duplicatePresetDoc = (doc: MeetingPresetDoc): MeetingPresetDoc => ({
    ...JSON.parse(JSON.stringify(doc)),
    name: `${doc.name}（副本）`,
});
