import { describe, expect, it } from 'vitest';
import { expandMacros, type MacroEnv } from './macros';
import { applyRegexScripts, parseStRegex } from './regex';
import { parseStPreset } from './stImport';
import { assembleMeetingPreset } from './assemble';
import type { MeetingRegexScript } from './types';

const env = (patch: Partial<MacroEnv> = {}): MacroEnv => ({
    charName: '凱恩', userName: '小雨', vars: {}, globalVars: {}, rng: () => 0, now: new Date('2026-11-06T13:05:09Z'), timeZone: 'Asia/Taipei', ...patch,
});

const regex = (patch: Partial<MeetingRegexScript>): MeetingRegexScript => ({
    id: 'r', scriptName: 'r', findRegex: '', replaceString: '', trimStrings: [], placement: [2], disabled: false,
    markdownOnly: false, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null, ...patch,
});

describe('expandMacros', () => {
    it('名字、變數、註解、trim', () => {
        const e = env();
        expect(expandMacros('{{setvar::心情:: 好 }}{{//這行不送}}{{char}}看著{{user}}，心情{{getvar::心情}}', e)).toBe('凱恩看著小雨，心情好');
        expect(expandMacros('a\n{{trim}}\nb', e)).toBe('ab');
        expect(expandMacros('{{ char }}', e)).toBe('凱恩');
    });

    it('參數裡的巨集先展開，由左到右', () => {
        const e = env();
        expect(expandMacros('{{setvar::x::{{random::甲::乙}}}}{{getvar::x}}', e)).toBe('甲');
        expect(expandMacros('{{setvar::n::1}}{{addvar::n::2}}{{getvar::n}} {{incvar::n}}', e)).toBe('3 4');
    });

    it('random 的三種寫法、roll、全域變數', () => {
        expect(expandMacros('{{random::a::b}}|{{random:c,d}}|{{random:e\\,f,g}}', env({ rng: () => 0 }))).toBe('a|c|e,f');
        expect(expandMacros('{{roll:1d6}} {{roll 3}} {{roll::2d1+3}}', env({ rng: () => 0 }))).toBe('1 1 5');
        expect(expandMacros('{{getglobalvar::字數}}', env({ globalVars: { 字數: '800' } }))).toBe('800');
    });

    it('時間跟著指定時區', () => {
        expect(expandMacros('{{time}} {{isodate}} {{weekday}} {{datetimeformat::YYYY/MM/DD HH:mm:ss}}', env()))
            .toBe('21:05 2026-11-06 星期五 2026/11/06 21:05:09');
    });

    it('認不得的原樣保留：輸出模板、拼錯的巨集', () => {
        const e = env();
        const template = '[Time|{{YYYY/MM/DD 星期X hh:mm AM/PM}}] [Seq|{{序号，如 01, 02}}] {{radom::a::b}} {{timestamp:YYYY}}';
        expect(expandMacros(template, e)).toBe(template);
        expect(expandMacros('{{未閉合', e)).toBe('{{未閉合');
    });
});

describe('正則', () => {
    it('parseStRegex：斜線寫法帶 flags，沒有斜線就是整串', () => {
        expect(parseStRegex('/a+/gi')?.flags).toBe('gi');
        expect(parseStRegex('^([\\s\\S]*)$')?.source).toBe('^([\\s\\S]*)$');
        expect(parseStRegex('/(/')).toBeNull();
    });

    it('三個時機各跑各的腳本；depth 範圍照 ST', () => {
        const scripts = [
            regex({ id: 'store', findRegex: '/甲/g', replaceString: '乙' }),
            regex({ id: 'prompt', findRegex: '/乙/g', replaceString: '丙', promptOnly: true, minDepth: 2 }),
            regex({ id: 'display', findRegex: '/<x>[\\s\\S]*?<\\/x>/g', replaceString: '', markdownOnly: true }),
        ];
        expect(applyRegexScripts('甲<x>藏</x>', scripts, { placement: 2, stage: 'store' })).toBe('乙<x>藏</x>');
        expect(applyRegexScripts('乙', scripts, { placement: 2, stage: 'prompt', depth: 1 })).toBe('乙');
        expect(applyRegexScripts('乙', scripts, { placement: 2, stage: 'prompt', depth: 2 })).toBe('丙');
        expect(applyRegexScripts('甲<x>藏</x>', scripts, { placement: 2, stage: 'display' })).toBe('甲');
        expect(applyRegexScripts('甲', scripts, { placement: 1, stage: 'store' })).toBe('甲');
    });

    it('替換字串：{{match}}、$1、trimStrings、巨集', () => {
        const script = regex({ findRegex: '/<t>(.*?)<\\/t>/', replaceString: '【$1】{{match}}{{user}}', trimStrings: ['#'] });
        expect(applyRegexScripts('<t>標#題</t>', [script], { placement: 2, stage: 'store', env: env() })).toBe('【標題】<t>標題</t>小雨');
    });
});

const ST_PRESET = {
    temperature: 1.1, top_p: 0.9, top_k: 0, frequency_penalty: 0.2, presence_penalty: 0.3, openai_max_tokens: 3000,
    assistant_prefill: '', wi_format: '{0}', scenario_format: '{{scenario}}',
    prompts: [
        { identifier: 'main', name: '主提示', role: 'system', content: '你是{{char}}。{{setvar::風格::冷淡}}' },
        { identifier: 'style', name: '文風', role: 'system', content: '文風：{{getvar::風格}}' },
        { identifier: 'off', name: '關掉的', role: 'system', content: '不該出現' },
        { identifier: 'divider', name: '==分隔==', role: 'system', content: '' },
        { identifier: 'charDescription', name: '角色描述', marker: true },
        { identifier: 'scenario', name: '場景', marker: true },
        { identifier: 'chatHistory', name: '聊天記錄', marker: true },
        { identifier: 'deep', name: '深度2', role: 'system', content: '深度二', injection_position: 1, injection_depth: 2, injection_order: 100 },
        { identifier: 'tail', name: '尾部', role: 'user', content: '字數：{{getglobalvar::字數總要求}}' },
        { identifier: 'unused', name: '沒排進順序', role: 'system', content: '不在 prompt_order' },
    ],
    prompt_order: [
        { character_id: 100000, order: [{ identifier: 'main', enabled: false }] },
        { character_id: 100001, order: ['main', 'style', 'off', 'divider', 'charDescription', 'scenario', 'chatHistory', 'deep', 'tail']
            .map(identifier => ({ identifier, enabled: identifier !== 'off' })) },
    ],
    extensions: {
        regex_scripts: [
            { id: 'r1', scriptName: '不送舊輸入', findRegex: '^([\\s\\S]*)$', replaceString: '', placement: [1], promptOnly: true, minDepth: 1 },
            { id: 'r2', scriptName: '包住本輪輸入', findRegex: '^([\\s\\S]*)$', replaceString: '<in>$1</in>', placement: [1], promptOnly: true, maxDepth: 0 },
        ],
        baibaiToolkit: { presetPromptGroups: { groups: [{ id: 'g1', name: '頭部', order: 0 }], prompts: { main: { groupId: 'g1' }, style: { groupId: 'g1' } } } },
        tavern_helper: { scripts: [{ name: '不收' }] },
    },
};

describe('parseStPreset', () => {
    const doc = parseStPreset(JSON.stringify(ST_PRESET), '日月西 v1.1.json');

    it('照 100001 的順序與開關，佔位變成 slot，沒排進順序的不收', () => {
        expect(doc.name).toBe('日月西 v1.1');
        expect(doc.prompts.map(p => p.id)).toEqual(['main', 'style', 'off', 'divider', 'charDescription', 'scenario', 'chatHistory', 'deep', 'tail']);
        expect(doc.prompts.find(p => p.id === 'off')?.enabled).toBe(false);
        expect(doc.prompts.find(p => p.id === 'scenario')?.slot).toBe('scenario');
        expect(doc.prompts.find(p => p.id === 'deep')?.inChat).toEqual({ depth: 2, order: 100 });
    });

    it('生成參數、正則、分組、全域變數名', () => {
        expect(doc.generation).toEqual({ temperature: 1.1, topP: 0.9, topK: undefined, frequencyPenalty: 0.2, presencePenalty: 0.3, maxTokens: 3000 });
        expect(doc.regexScripts.map(r => r.scriptName)).toEqual(['不送舊輸入', '包住本輪輸入']);
        expect(doc.groups).toEqual([{ id: 'g1', name: '頭部', promptIds: ['main', 'style'] }]);
        expect(doc.globalVars).toEqual({ 字數總要求: '' });
    });

    it('不是對話補全預設就拒收', () => {
        expect(() => parseStPreset('{"temp": 1}')).toThrow('Chat Completion');
        expect(() => parseStPreset('not json')).toThrow('JSON');
    });
});

describe('assembleMeetingPreset', () => {
    const doc = parseStPreset(JSON.stringify(ST_PRESET), 'p.json');
    const history = [
        { role: 'user' as const, content: '舊的輸入' },
        { role: 'assistant' as const, content: '回覆一' },
        { role: 'assistant' as const, content: '回覆二' },
        { role: 'user' as const, content: '本輪輸入' },
    ];

    it('照 ST 的順序拼：條目、佔位、聊天記錄、插入、尾部', () => {
        const { messages } = assembleMeetingPreset({
            doc,
            slots: { charDescription: '{{char}}是學生會長。', scenario: '放學後的教室', memory: '你們上週吵過架' },
            history,
            env: { charName: '凱恩', userName: '小雨' },
            globalVars: { 字數總要求: '800' },
        });
        expect(messages).toEqual([
            { role: 'system', content: '你是凱恩。' },
            { role: 'system', content: '文風：冷淡' },
            { role: 'system', content: '凱恩是學生會長。' },
            { role: 'system', content: '放學後的教室' },
            { role: 'system', content: '你們上週吵過架' },
            { role: 'assistant', content: '回覆一' },
            { role: 'system', content: '深度二' },
            { role: 'assistant', content: '回覆二' },
            { role: 'user', content: '<in>本輪輸入</in>' },
            { role: 'user', content: '字數：800' },
        ]);
    });

    it('後面的條目設的變數，前面的條目讀得到（兩遍）', () => {
        const ordered = { ...doc, prompts: [
            { id: 'a', name: 'a', enabled: true, role: 'system' as const, content: '讀：{{getvar::k}}' },
            { id: 'b', name: 'b', enabled: true, role: 'system' as const, content: '{{setvar::k::後設}}' },
            { id: 'chatHistory', name: 'h', enabled: true, role: 'system' as const, content: '', slot: 'chatHistory' as const },
        ] };
        const { messages } = assembleMeetingPreset({ doc: ordered, slots: {}, history: [], env: { charName: 'c', userName: 'u' } });
        expect(messages).toEqual([{ role: 'system', content: '讀：後設' }]);
    });

    it('聊天記錄佔位關掉就不送記錄；prefill 補在最後', () => {
        const noHistory = { ...doc, assistantPrefill: '好的，{{user}}。', prompts: doc.prompts.map(p => (p.slot === 'chatHistory' ? { ...p, enabled: false } : p)) };
        const { messages } = assembleMeetingPreset({ doc: noHistory, slots: {}, history, env: { charName: '凱恩', userName: '小雨' } });
        expect(messages.some(m => m.content.includes('回覆一'))).toBe(false);
        expect(messages[messages.length - 1]).toEqual({ role: 'assistant', content: '好的，小雨。' });
    });
});
