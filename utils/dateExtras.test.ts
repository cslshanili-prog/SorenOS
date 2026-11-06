import { describe, expect, it } from 'vitest';
import { buildLengthLine, buildScenarioBlock, describeLength, expandGreeting, pickGreeting, presetLengthGlobals, scenarioText } from './dateExtras';
import { DatePrompts } from './datePrompts';
import { buildMeetingPresetPayload } from './meetingPresetSession';
import type { CharacterProfile, Message, UserProfile } from '../types';
import type { MeetingPresetDoc } from './meetingPreset/types';

const makeChar = (overrides: Partial<CharacterProfile> = {}): CharacterProfile => ({
    id: 'c1', name: '凱恩', avatar: '', description: '', systemPrompt: '你是凱恩。', memories: [], ...overrides,
} as CharacterProfile);
const user = { name: '小雨', bio: '' } as UserProfile;
const msg = (id: number, role: 'user' | 'assistant', content: string): Message => ({ id, charId: 'c1', role, type: 'text', content, timestamp: id, metadata: { source: 'date' } } as Message);
const sysText = (messages: Array<{ role: string; content: any }>) => messages.filter(m => m.role === 'system').map(m => String(m.content)).join('\n');

describe('開場白', () => {
    const list = [{ id: 'a', text: '一' }, { id: 'b', text: '二' }, { id: 'c', text: '   ' }];

    it('空白的不算；有上一條就換一條', () => {
        expect(pickGreeting([], undefined)).toBeUndefined();
        expect(pickGreeting([{ id: 'x', text: ' ' }])).toBeUndefined();
        for (const r of [0, 0.4, 0.99]) expect(pickGreeting(list, 'a', () => r)?.id).toBe('b');
        expect(pickGreeting(list, undefined, () => 0.99)?.id).toBe('b');
        // 只有一條就算跟上次一樣也照用
        expect(pickGreeting([list[0]], 'a')?.id).toBe('a');
    });

    it('{{char}}／{{user}} 換掉，認不得的巨集原樣留著', () => {
        expect(expandGreeting('  {{char}}看向{{user}}。{{未知}}\n', '凱恩', '小雨')).toBe('凱恩看向小雨。{{未知}}');
    });
});

describe('回應字數', () => {
    it('描述', () => {
        expect(describeLength(undefined)).toBe('');
        expect(describeLength({ min: 800, max: 1200 })).toBe('800–1200 字');
        expect(describeLength({ min: 1200, max: 800 })).toBe('800–1200 字');
        expect(describeLength({ min: 800 })).toBe('至少 800 字');
        expect(describeLength({ max: 500 })).toBe('最多 500 字');
        expect(describeLength({ min: 0, max: -3 })).toBe('');
        expect(buildLengthLine(makeChar())).toBe('');
        expect(buildLengthLine(makeChar({ dateResponseLength: { max: 500 } }))).toContain('最多 500 字');
    });

    it('預設裡讀字數的全域變數才蓋，其它不動', () => {
        const char = makeChar({ dateResponseLength: { min: 800, max: 1200 } });
        expect(presetLengthGlobals({ 字数总要求: '600', 文风: 'x' }, char)).toEqual({ overrides: { 字数总要求: '800–1200 字' }, mapped: true });
        expect(presetLengthGlobals({ 文风: 'x' }, char)).toEqual({ overrides: {}, mapped: false });
        expect(presetLengthGlobals({ 字数总要求: '600' }, makeChar())).toEqual({ overrides: {}, mapped: false });
    });
});

describe('劇情大綱', () => {
    it('沒填不帶；填了先換名字', () => {
        expect(buildScenarioBlock(makeChar())).toBe('');
        expect(scenarioText(makeChar({ dateScenario: ' {{char}}在書店等{{user}} ' }), '小雨')).toBe('凱恩在書店等小雨');
        expect(buildScenarioBlock(makeChar({ dateScenario: '雨夜' }))).toContain('### 當前劇情大綱\n雨夜');
    });
});

describe('內建模式帶上大綱和字數', () => {
    const char = makeChar({ dateScenario: '{{user}}在雨夜的書店', dateResponseLength: { min: 300, max: 600 } });

    it('見面正文', async () => {
        const { messages } = await DatePrompts.buildSessionPayload({
            char, userProfile: user, emojis: [], userText: '「你好」', variant: 'send',
            allMsgs: [msg(1, 'assistant', '他抬頭。'), msg(2, 'user', '「你好」')],
        });
        const sys = sysText(messages);
        expect(sys).toContain('### 當前劇情大綱\n小雨在雨夜的書店');
        expect(sys).toContain('這一輪正文大約 300–600 字');
        expect(sys.indexOf('### 當前劇情大綱')).toBeLessThan(sys.indexOf('### 場景上下文'));
    });

    it('感知頁開場也看大綱（字數不管開場）', () => {
        const { messages } = DatePrompts.buildPeekPayload({ char, userProfile: user, allMsgs: [], emojis: [] });
        const all = messages.map(m => String(m.content)).join('\n');
        expect(all).toContain('小雨在雨夜的書店');
        expect(all).not.toContain('這一輪正文大約');
    });

    it('都沒填就一字不多', async () => {
        const { messages } = await DatePrompts.buildSessionPayload({
            char: makeChar(), userProfile: user, emojis: [], userText: '「你好」', variant: 'send', allMsgs: [msg(2, 'user', '「你好」')],
        });
        expect(sysText(messages)).not.toMatch(/當前劇情大綱|回應長度/);
    });
});

describe('自訂預設模式帶上大綱和字數', () => {
    const base: MeetingPresetDoc = {
        schema: 'soren.meeting-preset', version: 1, name: 't', generation: {}, regexScripts: [], groups: [], globalVars: {},
        prompts: [
            { id: 'main', name: 'main', enabled: true, role: 'system', content: '字數：{{getglobalvar::字数总要求}}' },
            { id: 'scenario', name: 'sc', enabled: true, role: 'system', content: '', slot: 'scenario' },
            { id: 'chatHistory', name: 'h', enabled: true, role: 'system', content: '', slot: 'chatHistory' },
        ],
    };
    const char = makeChar({ dateScenario: '{{char}}和{{user}}在書店', dateResponseLength: { min: 800, max: 1200 } });
    const run = (doc: MeetingPresetDoc) => buildMeetingPresetPayload({
        preset: doc, char, userProfile: user, emojis: [], userText: '「你好」', allMsgs: [msg(2, 'user', '「你好」')],
    });

    it('大綱進「場景」佔位；預設讀字數變數就蓋過去，不另外補一句', async () => {
        const { messages } = await run({ ...base, globalVars: { 字数总要求: '600' } });
        expect(messages[0].content).toBe('字數：800–1200 字');
        expect(messages[1].content).toBe('凱恩和小雨在書店');
        expect(messages.some(m => m.content.includes('### 回應長度'))).toBe(false);
    });

    it('預設沒讀字數就由 Soren 補一句；{{scenario}} 也拿得到大綱', async () => {
        const doc: MeetingPresetDoc = { ...base, prompts: [{ id: 'main', name: 'main', enabled: true, role: 'system', content: '場景：{{scenario}}' }, base.prompts[2]] };
        const { messages } = await run(doc);
        expect(messages[0].content).toBe('場景：凱恩和小雨在書店');
        const lengthAt = messages.findIndex(m => m.content.includes('### 回應長度'));
        expect(lengthAt).toBeGreaterThan(0);
        expect(messages[lengthAt].content).toContain('800–1200 字');
    });
});
