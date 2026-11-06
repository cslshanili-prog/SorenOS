import { describe, expect, it } from 'vitest';
import { buildMeetingPresetPayload } from './meetingPresetSession';
import { ContextBuilder, CORE_SECTION_ORDER } from './context';
import type { CharacterProfile, Message, UserProfile } from '../types';
import type { MeetingPresetDoc } from './meetingPreset/types';

const char = {
    id: 'c1', name: '凱恩', avatar: '', description: '會長', systemPrompt: '你是凱恩。', memories: [],
    worldview: '學園都市', dateVoiceEnabled: true,
    mountedWorldbooks: [{ id: 'w1', title: '前', content: '世界書在前', position: 0, constant: true }, { id: 'w2', title: '深', content: '深度條目', position: 4, depth: 0, constant: true }],
} as unknown as CharacterProfile;
const user = { name: '小雨', bio: '學生' } as UserProfile;
const msg = (id: number, role: 'user' | 'assistant', content: string): Message => ({ id, charId: 'c1', role, type: 'text', content, timestamp: id, metadata: { source: 'date' } } as Message);

const doc: MeetingPresetDoc = {
    schema: 'soren.meeting-preset', version: 1, name: 't', generation: { temperature: 1.2 }, regexScripts: [], groups: [], globalVars: {},
    prompts: [
        { id: 'main', name: 'main', enabled: true, role: 'system', content: '主提示：{{char}}' },
        { id: 'worldInfoBefore', name: 'wb', enabled: true, role: 'system', content: '', slot: 'worldInfoBefore' },
        { id: 'charDescription', name: 'cd', enabled: true, role: 'system', content: '', slot: 'charDescription' },
        { id: 'personaDescription', name: 'pd', enabled: true, role: 'system', content: '', slot: 'personaDescription' },
        { id: 'chatHistory', name: 'h', enabled: true, role: 'system', content: '', slot: 'chatHistory' },
    ],
};

describe('buildMeetingPresetPayload', () => {
    it('Soren 的各段照佔位放，沒放的補在聊天記錄前；世界書深度條目插進對話', async () => {
        const { messages, generation } = await buildMeetingPresetPayload({
            preset: doc, char, userProfile: user, emojis: [], userText: '「你好」',
            allMsgs: [msg(1, 'assistant', '他抬頭。'), msg(2, 'user', '「你好」')],
        });
        expect(generation).toEqual({ temperature: 1.2 });
        expect(messages[0]).toEqual({ role: 'system', content: '主提示：凱恩' });
        expect(messages[1].content).toContain('世界書在前');
        expect(messages[2].content).toContain('你是凱恩。');
        expect(messages[3].content).toContain('### 互動對象 (User)');
        // 記憶、語氣標籤沒有佔位 → 補在聊天記錄前
        const voiceAt = messages.findIndex(m => m.content.includes('台詞的語氣標籤'));
        // 歷史照 Soren 的格式帶時間和來源標記（同內建模式）
        const historyAt = messages.findIndex(m => m.role === 'assistant' && m.content.endsWith('[約會] 他抬頭。'));
        expect(voiceAt).toBeGreaterThan(3);
        expect(voiceAt).toBeLessThan(historyAt);
        expect(messages.slice(-2)).toEqual([{ role: 'user', content: '「你好」' }, { role: 'system', content: '深度條目' }]);
        // 內建模式的格式規則不帶
        expect(messages.some(m => m.content.includes('散文敘事') || m.content.includes('表達底線'))).toBe(false);
    });
});

describe('ContextBuilder.buildCoreSections', () => {
    it('buildCoreContext 就是各段照順序接起來', () => {
        const sections = ContextBuilder.buildCoreSections(char, user, true);
        expect(ContextBuilder.buildCoreContext(char, user, true)).toBe(CORE_SECTION_ORDER.map(key => sections[key]).join(''));
    });
});
