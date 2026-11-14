import { describe, it, expect } from 'vitest';
import { assembleGroupPreset, buildBuiltinGroupPresetDoc } from './groupPresetSession';
import { GROUP_STYLE_ATMOSPHERE, GROUP_STYLE_QUALITY, buildDirectorInstruction, withoutGroupStyle } from './groupChat/prompts';
import { resolveGroupPresetId } from './presetBinding';

const st = (extra: any = {}): any => ({
    schema: 'soren.meeting-preset', version: 1, name: '小說', generation: {}, regexScripts: [], groups: [], globalVars: {},
    assistantPrefill: '<content>',
    prompts: [
        { id: 'main', name: '主提示', enabled: true, role: 'system', content: '你要扮演{{char}}，寫成小說體。' },
        { id: 'chatHistory', name: '聊天記錄', enabled: true, role: 'system', content: '', slot: 'chatHistory' },
        { id: 'jb', name: '破限', enabled: true, role: 'system', content: '每次至少 800 字。' },
    ],
    ...extra,
});
const base = { scene: '【群場景】', members: '【成員檔案】', memberNames: ['阿澈', '小遙'], userName: '小星' };

describe('群聊自訂預設組裝', () => {
    it('導演：預設在前，群場景、成員檔案補上，任務在聊天記錄那格，JSON 格式鎖在最後，預填不送', () => {
        const messages = assembleGroupPreset({ ...base, doc: st(), mode: 'director', task: '【任務】' });
        expect(messages.map(m => m.role)).toEqual(['system', 'user', 'system', 'system']);
        const head = String(messages[0].content);
        expect(head.startsWith('你要扮演阿澈、小遙，寫成小說體。')).toBe(true);
        expect(head).toContain('【群場景】');
        expect(head).toContain('【成員檔案】');
        expect(JSON.stringify(messages[1].content)).toContain('【任務】');
        expect(String(messages[2].content)).toBe('每次至少 800 字。');
        expect(String(messages[3].content)).toContain('JSON');
        expect(JSON.stringify(messages)).not.toContain('<content>');
    });

    it('輪流：格式鎖是「只寫自己的台詞」', () => {
        const messages = assembleGroupPreset({ ...base, memberNames: ['阿澈'], doc: st(), mode: 'roundRobin', task: '【任務】' });
        expect(String(messages[messages.length - 1].content)).toContain('只輸出「阿澈」自己要在群裡發的話');
    });

    it('預設沒有聊天記錄格、或關掉了：任務照樣送', () => {
        const noHistory = st({ prompts: [{ id: 'main', name: '主提示', enabled: true, role: 'system', content: '主' }] });
        expect(JSON.stringify(assembleGroupPreset({ ...base, doc: noHistory, mode: 'director', task: '【任務】' }))).toContain('【任務】');
        const off = st();
        off.prompts[1].enabled = false;
        expect(JSON.stringify(assembleGroupPreset({ ...base, doc: off, mode: 'director', task: '【任務】' }))).toContain('【任務】');
    });

    it('任務不跑預設的正則（那是給單人對話記錄的）', () => {
        const withRegex = st({ regexScripts: [{ id: 'r', scriptName: 'r', findRegex: '/任務/g', replaceString: 'X', trimStrings: [], placement: [1], disabled: false, markdownOnly: false, promptOnly: true, runOnEdit: false, substituteRegex: 0, minDepth: null, maxDepth: null }] });
        expect(JSON.stringify(assembleGroupPreset({ ...base, doc: withRegex, mode: 'director', task: '【任務】' }))).toContain('【任務】');
    });

    it('導演指令拿掉兩段文風後，U 還是 U、互動結構、格式都還在', () => {
        const full = buildDirectorInstruction({ text: 'A: 嗨', attachedImagesNote: '', attachedImages: [] } as any, '通用: [哈哈]');
        expect(full).toContain(GROUP_STYLE_ATMOSPHERE);
        expect(full).toContain(GROUP_STYLE_QUALITY);
        const stripped = withoutGroupStyle(full);
        expect(stripped).not.toContain('#### 一、群聊的樂子');
        expect(stripped).toContain('#### 三、U 還是 U');
        expect(stripped).toContain('#### 五、互動結構');
        expect(stripped).toContain('### 輸出格式 (JSON Array)');
    });

    it('內建群聊預設：兩段文風是文字條目；群自己選的 > 群聊場景預設 > 內建', () => {
        const doc = buildBuiltinGroupPresetDoc();
        expect(doc.scenes).toEqual(['group']);
        expect(doc.prompts.find(p => p.id === 'group_style_atmosphere')?.content).toBe(GROUP_STYLE_ATMOSPHERE.trim());
        expect(resolveGroupPresetId({}, { presetSceneDefaults: { group: 'p1' } })).toBe('p1');
        expect(resolveGroupPresetId({ presetId: 'builtin' }, { presetSceneDefaults: { group: 'p1' } })).toBeUndefined();
        expect(resolveGroupPresetId({}, { presetSceneDefaults: { chat: 'p1' } })).toBeUndefined();
    });
});
