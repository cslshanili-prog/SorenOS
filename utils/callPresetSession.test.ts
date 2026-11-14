import { describe, it, expect } from 'vitest';
import { assembleCallPreset, buildBuiltinCallPresetDoc, buildCallPresetSlots, CALL_AUTO_BEFORE } from './callPresetSession';
import { resolveCallPresetId } from './presetBinding';

const core: any = new Proxy({ identity: '【身份】', impression: '【印象】' }, { get: (t: any, k) => t[k] ?? '' });
const segments = { scene: '【場景】', talk: '【說話方式】', voiceActing: '【語音演出】', format: '【格式】', voiceLang: '', time: '【時間】' };
const slots = buildCallPresetSlots({ core, segments, video: '【視訊】', modes: '', fixedLine: '【固定台詞】' });
const char: any = { id: 'c1', name: '阿澈' };
const history = [{ role: 'user', content: '喂' }];
const st: any = {
    schema: 'soren.meeting-preset', version: 1, name: '短句', generation: {}, regexScripts: [], groups: [], globalVars: {},
    prompts: [
        { id: 'main', name: '主提示', enabled: true, role: 'system', content: '你是{{char}}，講話很短。' },
        { id: 'charDescription', name: '角色描述', enabled: true, role: 'system', content: '', slot: 'charDescription' },
        { id: 'chatHistory', name: '聊天記錄', enabled: true, role: 'system', content: '', slot: 'chatHistory' },
    ],
};

describe('電話自訂預設組裝', () => {
    it('匯入的預設：主提示在前，Soren 資料和電話功能照補，說話方式（文風）不補', () => {
        const messages = assembleCallPreset({ doc: st, slots, history, char, userName: '小星' });
        expect(messages.map(m => m.role)).toEqual(['system', 'user']);
        const sys = String(messages[0].content);
        expect(sys.startsWith('你是阿澈，講話很短。')).toBe(true);
        for (const piece of ['【身份】', '【印象】', '【固定台詞】', '【時間】', '【場景】', '【語音演出】', '【格式】', '【視訊】']) expect(sys).toContain(piece);
        expect(sys).not.toContain('【說話方式】');
        // 格式補在最後，最貼近通話記錄
        expect(sys.trim().endsWith('【格式】')).toBe(true);
    });

    it('內建電話預設：每個會補的功能都有擺，文風條目在', () => {
        const doc = buildBuiltinCallPresetDoc();
        expect(doc.scenes).toEqual(['call']);
        for (const slot of CALL_AUTO_BEFORE) expect(doc.prompts.some(p => p.slot === slot)).toBe(true);
        expect(doc.prompts.some(p => p.id === 'call_style_talk' && p.content.includes('電話裡的人不會像寫作文一樣說話'))).toBe(true);
    });

    it('用哪份：角色自己的 > 電話場景預設 > 內建；builtin 是明確選內建', () => {
        expect(resolveCallPresetId({}, { presetSceneDefaults: { call: 'p1' } })).toBe('p1');
        expect(resolveCallPresetId({ callPresetId: 'p2' }, { presetSceneDefaults: { call: 'p1' } })).toBe('p2');
        expect(resolveCallPresetId({ callPresetId: 'builtin' }, { presetSceneDefaults: { call: 'p1' } })).toBeUndefined();
        // 私聊的場景預設不會跑到電話
        expect(resolveCallPresetId({}, { presetSceneDefaults: { chat: 'p1' } })).toBeUndefined();
    });
});
