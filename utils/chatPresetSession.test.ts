import { describe, it, expect } from 'vitest';
import { assembleChatPreset, buildBuiltinChatPresetDoc, buildChatPresetSlots, CHAT_AUTO_BEFORE } from './chatPresetSession';
import { CHAT_STYLE_ANCHOR, CHAT_STYLE_TALK } from './chatPresetText';
import type { MeetingPresetDoc } from './meetingPreset/types';

const emptyCore: any = new Proxy({}, { get: () => '' });
const segments: any = {
    charWorld: 'CW', relationship: '【稱呼與關係】', interact: '【互動功能】', lifeContext: '【日記】',
    format: '【聊天格式】', talk: CHAT_STYLE_TALK, emoji: '【表情包】', quote: '【引用】', actions: '【動作】', voice: '【語音】',
    live: '【實時狀態】', expression: '【表達】', anchor: '【回到你自己】',
};
const slots = buildChatPresetSlots({ segments, core: { ...emptyCore, identity: '【身份】', userProfile: '【用戶】' }, modes: '【雙語】', liveExtras: '【點單】' });
const char: any = { id: 'c1', name: '阿澈' };
const history = [
    { role: 'user', content: '在嗎' },
    { role: 'assistant', content: '在' },
    { role: 'user', content: [{ type: 'text', text: '看這張' }, { type: 'image_url', image_url: { url: 'x' } }] },
];

const stPreset = (extra: Partial<MeetingPresetDoc> = {}): MeetingPresetDoc => ({
    schema: 'soren.meeting-preset', version: 1, name: '日月', generation: {}, regexScripts: [], groups: [], globalVars: {},
    prompts: [
        { id: 'main', name: '主提示', enabled: true, role: 'system', content: '你是{{char}}，文筆細膩。' },
        { id: 'charDescription', name: '角色描述', enabled: true, role: 'system', content: '', slot: 'charDescription' },
        { id: 'chatHistory', name: '聊天記錄', enabled: true, role: 'system', content: '', slot: 'chatHistory' },
        { id: 'jailbreak', name: '破限', enabled: true, role: 'system', content: '照劇情走。' },
    ],
    ...extra,
});

const text = (m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));

describe('私聊自訂預設組裝', () => {
    it('匯入的 ST 預設：文風照它，資料和功能自動補；實時狀態補在聊天記錄後面', () => {
        const messages = assembleChatPreset({ doc: stPreset(), slots, history, char, userName: '小星' });
        expect(messages.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'system']);
        const head = text(messages[0]);
        expect(head.startsWith('你是阿澈，文筆細膩。')).toBe(true);
        expect(head).toContain('【身份】');
        for (const piece of ['【稱呼與關係】', '【日記】', '【互動功能】', '【聊天格式】', '【表情包】', '【引用】', '【動作】', '【語音】', '【雙語】']) expect(head).toContain(piece);
        // 功能照固定順序
        expect(head.indexOf('【聊天格式】')).toBeLessThan(head.indexOf('【表情包】'));
        // 文風不補
        expect(head).not.toContain('沉浸感');
        expect(JSON.stringify(messages)).not.toContain('【回到你自己】');
        const tail = text(messages[4]);
        expect(tail.indexOf('【實時狀態】')).toBeLessThan(tail.indexOf('照劇情走。'));
        expect(tail).toContain('【點單】');
        // 帶圖的那則原樣送
        expect(Array.isArray(messages[3].content)).toBe(true);
    });

    it('預設裡放了功能但關掉＝明確不要，不補', () => {
        const doc = stPreset();
        doc.prompts.splice(1, 0, { id: 'chatEmoji', name: '表情包', enabled: false, role: 'system', content: '', slot: 'chatEmoji' });
        const messages = assembleChatPreset({ doc, slots, history, char, userName: '小星' });
        expect(JSON.stringify(messages)).not.toContain('【表情包】');
        expect(JSON.stringify(messages)).toContain('【動作】');
    });

    it('預設自己擺了功能的位置就照它擺的', () => {
        const doc = stPreset();
        doc.prompts.push({ id: 'chatActions', name: '動作', enabled: true, role: 'system', content: '', slot: 'chatActions' });
        const messages = assembleChatPreset({ doc, slots, history, char, userName: '小星' });
        expect(text(messages[0])).not.toContain('【動作】');
        expect(text(messages[messages.length - 1]).endsWith('【動作】')).toBe(true);
    });

    it('內建私聊預設複製出來：文風條目都在、收尾在最後、結構是前段＋聊天記錄＋後段', () => {
        const doc = buildBuiltinChatPresetDoc();
        expect(doc.scenes).toEqual(['chat']);
        // 每個自動補的功能內建都有擺
        for (const slot of CHAT_AUTO_BEFORE) expect(doc.prompts.some(p => p.slot === slot)).toBe(true);
        const messages = assembleChatPreset({ doc, slots, history, char, userName: '小星' });
        expect(messages.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'system']);
        expect(text(messages[0])).toContain('1. **沉浸感**');
        const tail = text(messages[4]);
        expect(tail.startsWith('【實時狀態】')).toBe(true);
        expect(tail.trim().endsWith(CHAT_STYLE_ANCHOR.trim().split('\n').pop()!.replace('{{char}}', '阿澈'))).toBe(true);
        expect(tail).toContain('你就是 阿澈。');
    });
});
