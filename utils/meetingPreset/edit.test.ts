import { describe, expect, it } from 'vitest';
import { addPrompt, duplicatePresetDoc, movePrompt, moveRegexScript, removePrompt, sectionPromptIds, UNGROUPED_SECTION_ID } from './edit';
import { buildStPreset, stPresetFileName } from './stExport';
import { parseStPreset } from './stImport';
import type { MeetingPresetDoc, MeetingPresetPrompt, MeetingRegexScript } from './types';

const prompt = (id: string, patch: Partial<MeetingPresetPrompt> = {}): MeetingPresetPrompt => ({ id, name: id, enabled: true, role: 'system', content: `${id} 的內容`, ...patch });
const regex = (id: string): MeetingRegexScript => ({
    id, scriptName: id, findRegex: '/a/g', replaceString: 'b', trimStrings: [], placement: [2], disabled: false,
    markdownOnly: true, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null,
});

const makeDoc = (patch: Partial<MeetingPresetDoc> = {}): MeetingPresetDoc => ({
    schema: 'soren.meeting-preset', version: 1, name: '測試預設', generation: { temperature: 1.1, maxTokens: 4000 },
    prompts: [
        prompt('a'), prompt('x'), prompt('b', { inChat: { depth: 2, order: 50 } }),
        prompt('charDescription', { name: '角色', slot: 'charDescription', content: '' }),
        prompt('mem', { name: '記憶', slot: 'memory', content: '' }),
        prompt('chatHistory', { name: '聊天記錄', slot: 'chatHistory', content: '' }),
    ],
    regexScripts: [regex('r1'), regex('r2'), regex('r3')],
    groups: [{ id: 'g1', name: '文風', promptIds: ['a', 'b'] }],
    globalVars: { 字數: '800' },
    ...patch,
});

describe('預設編輯 · 條目', () => {
    it('分區：分組照 promptIds，其餘歸未分組', () => {
        const doc = makeDoc();
        expect(sectionPromptIds(doc, 'g1')).toEqual(['a', 'b']);
        expect(sectionPromptIds(doc, UNGROUPED_SECTION_ID)).toEqual(['x', 'charDescription', 'mem', 'chatHistory']);
    });

    it('上下移只跟同一區的鄰居換，送出順序和分組一起換；到頭不動', () => {
        const doc = makeDoc();
        const moved = movePrompt(doc, 'b', -1);
        expect(moved.prompts.map(p => p.id)).toEqual(['b', 'x', 'a', 'charDescription', 'mem', 'chatHistory']);
        expect(moved.groups[0].promptIds).toEqual(['b', 'a']);
        expect(movePrompt(doc, 'a', -1)).toBe(doc);
        expect(movePrompt(doc, 'chatHistory', 1)).toBe(doc);
        expect(movePrompt(doc, 'x', 1).prompts.map(p => p.id).slice(0, 4)).toEqual(['a', 'charDescription', 'b', 'x']);
    });

    it('新增：接在那區最後一個後面，分組記上；空的區放在聊天記錄前', () => {
        const { doc, prompt: added } = addPrompt(makeDoc(), 'g1');
        expect(doc.prompts.map(p => p.id).indexOf(added.id)).toBe(3);
        expect(doc.groups[0].promptIds).toEqual(['a', 'b', added.id]);
        expect(added).toMatchObject({ name: '新條目', enabled: true, role: 'system', content: '' });

        const empty = makeDoc({ groups: [...makeDoc().groups, { id: 'g2', name: '空組', promptIds: [] }] });
        const result = addPrompt(empty, 'g2');
        expect(result.doc.prompts.map(p => p.id).indexOf(result.prompt.id)).toBe(5);

        // 未分組的最後一個是聊天記錄：新條目放在它前面
        const rest = addPrompt(makeDoc(), UNGROUPED_SECTION_ID);
        expect(rest.doc.prompts.map(p => p.id).slice(-2)).toEqual([rest.prompt.id, 'chatHistory']);
        expect(rest.doc.groups).toEqual(makeDoc().groups);

        // 只有聊天記錄的區、整份沒有聊天記錄
        const onlyChat = makeDoc({ prompts: [prompt('a'), prompt('chatHistory', { slot: 'chatHistory', content: '' })], groups: [{ id: 'g1', name: '文風', promptIds: ['a'] }] });
        expect(addPrompt(onlyChat, UNGROUPED_SECTION_ID).doc.prompts.map(p => p.id).at(-1)).toBe('chatHistory');
        const noChat = makeDoc({ prompts: [prompt('a')], groups: [] });
        expect(addPrompt(noChat, UNGROUPED_SECTION_ID).doc.prompts.map(p => p.id)[0]).toBe('a');
    });

    it('刪除：一般條目連分組一起刪；資料佔位刪不掉', () => {
        const doc = makeDoc();
        const removed = removePrompt(doc, 'a');
        expect(removed.prompts.map(p => p.id)).not.toContain('a');
        expect(removed.groups[0].promptIds).toEqual(['b']);
        expect(removePrompt(doc, 'chatHistory')).toBe(doc);
        expect(removePrompt(doc, 'mem')).toBe(doc);
    });
});

describe('預設編輯 · 正則與複製', () => {
    it('正則上下移；到頭不動', () => {
        const doc = makeDoc();
        expect(moveRegexScript(doc, 'r3', -1).regexScripts.map(r => r.id)).toEqual(['r1', 'r3', 'r2']);
        expect(moveRegexScript(doc, 'r1', -1)).toBe(doc);
    });

    it('複製是深拷貝，名字加副本', () => {
        const doc = makeDoc();
        const copy = duplicatePresetDoc(doc);
        expect(copy.name).toBe('測試預設（副本）');
        copy.prompts[0].content = '改掉';
        expect(doc.prompts[0].content).toBe('a 的內容');
    });
});

describe('預設匯出（SillyTavern 格式）', () => {
    it('照 ST 的欄位寫：順序、開關、插入深度、佔位、參數、正則、分組', () => {
        const doc = makeDoc({ prompts: makeDoc().prompts.map(p => (p.id === 'x' ? { ...p, enabled: false } : p)) });
        const data: any = buildStPreset(doc);
        expect(data.temperature).toBe(1.1);
        expect(data.openai_max_tokens).toBe(4000);
        expect(data).not.toHaveProperty('top_p');
        expect(data.prompt_order[0].character_id).toBe(100001);
        expect(data.prompt_order[0].order).toContainEqual({ identifier: 'x', enabled: false });
        expect(data.prompts.find((p: any) => p.identifier === 'b')).toMatchObject({ injection_position: 1, injection_depth: 2, injection_order: 50 });
        expect(data.prompts.find((p: any) => p.identifier === 'chatHistory')).toMatchObject({ marker: true });
        expect(data.prompts.find((p: any) => p.identifier === 'mem')).toMatchObject({ marker: false, content: '' });
        expect(data.extensions.regex_scripts.map((r: any) => r.id)).toEqual(['r1', 'r2', 'r3']);
        expect(data.extensions.baibaiToolkit.presetPromptGroups.prompts.a).toEqual({ groupId: 'g1' });
    });

    it('丟回 Soren：沒改過就整份還原（變數值、Soren 佔位都在）', () => {
        const doc = makeDoc();
        const back = parseStPreset(JSON.stringify(buildStPreset(doc)), '測試預設.json');
        expect(back).toEqual(doc);
    });

    it('在酒館改過（指紋對不上）就照一般 ST 檔讀，酒館的修改不會被蓋掉', () => {
        const data: any = buildStPreset(makeDoc());
        data.prompts.find((p: any) => p.identifier === 'a').content = '酒館裡改的';
        const back = parseStPreset(JSON.stringify(data), '改過.json');
        expect(back.name).toBe('改過');
        expect(back.prompts.find(p => p.id === 'a')?.content).toBe('酒館裡改的');
        expect(back.prompts.find(p => p.id === 'b')?.inChat).toEqual({ depth: 2, order: 50 });
        expect(back.groups).toEqual([{ id: 'g1', name: '文風', promptIds: ['a', 'b'] }]);
        expect(back.regexScripts).toEqual(makeDoc().regexScripts);
    });

    it('檔名去掉不合法字元', () => {
        expect(stPresetFileName(makeDoc({ name: 'a/b:c?' }))).toBe('a b c.json');
        expect(stPresetFileName(makeDoc({ name: '  ' }))).toBe('見面預設.json');
    });
});
