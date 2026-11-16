import { describe, it, expect } from 'vitest';
import { ChatPrompts } from './chatPrompts';
import { normalizeMessageContent } from './messageFormat';
import { applyActivePersona, resolveUserProfileForChar } from './userPersona';
import {
    formatUserVoiceContent,
    isUserVoiceMessage,
    readUserVoiceSttLang,
    userVoiceMeta,
    userVoiceShell,
} from './userVoice';

const char = { id: 'c1', name: '小角色', voiceProfile: { voiceId: 'char-voice' } } as any;
const t0 = Date.now() - 60_000;

describe('你的語音條（plans/user-voice.md）', () => {
    it('只有你發的、帶 userVoice 的文字訊息才算', () => {
        expect(isUserVoiceMessage({ role: 'user', type: 'text', metadata: userVoiceMeta('typed') } as any)).toBe(true);
        expect(isUserVoiceMessage({ role: 'user', type: 'text', metadata: {} } as any)).toBe(false);
        expect(isUserVoiceMessage({ role: 'assistant', type: 'text', metadata: userVoiceMeta('spoken') } as any)).toBe(false);
        expect(isUserVoiceMessage({ role: 'user', type: 'image', metadata: userVoiceMeta('typed') } as any)).toBe(false);
    });

    it('借殼只換聲音：你沒設聲音就是沒有，絕不借角色的聲音', () => {
        expect(userVoiceShell(char, { name: '我', voiceProfile: { voiceId: 'me' } } as any).voiceProfile).toEqual({ voiceId: 'me' });
        const shell = userVoiceShell(char, { name: '我' } as any);
        expect(shell.voiceProfile).toBeUndefined();
        expect(shell.name).toBe('我');
    });

    it('聲音跟著身份卡走：卡沒設不借真實身份的', () => {
        const base = {
            name: '真我', avatar: '', bio: '', voiceProfile: { voiceId: 'real' },
            personas: [
                { id: 'p1', name: '卡一', avatar: '', bio: '', voiceProfile: { voiceId: 'p1-voice' }, createdAt: 0, updatedAt: 0 },
                { id: 'p2', name: '卡二', avatar: '', bio: '', createdAt: 0, updatedAt: 0 },
            ],
        } as any;
        expect(applyActivePersona({ ...base, activePersonaId: 'p1' }).voiceProfile).toEqual({ voiceId: 'p1-voice' });
        expect(applyActivePersona({ ...base, activePersonaId: 'p2' }).voiceProfile).toBeUndefined();
        expect(applyActivePersona(base).voiceProfile).toEqual({ voiceId: 'real' });
        expect(resolveUserProfileForChar(base, { id: 'c1', name: 'x' } as any).voiceProfile).toEqual({ voiceId: 'real' });
    });

    it('記憶、歸檔看到的寫法是 [語音] 內容', () => {
        expect(formatUserVoiceContent('  晚安  ')).toBe('[語音] 晚安');
        expect(formatUserVoiceContent('')).toBe('[語音]');
        const m = { role: 'user', type: 'text', content: '今天好累', metadata: userVoiceMeta('spoken') } as any;
        expect(normalizeMessageContent(m, '小角色', '我')).toBe('[語音] 今天好累');
        expect(normalizeMessageContent({ ...m, metadata: {} }, '小角色', '我')).toBe('今天好累');
    });

    it('私聊歷史裡角色看得出你是用說的，一般訊息不受影響', () => {
        const history = [
            { id: 1, charId: 'c1', role: 'user', type: 'text', content: '我到家了', timestamp: t0, metadata: userVoiceMeta('typed') },
            { id: 2, charId: 'c1', role: 'user', type: 'text', content: '普通打字', timestamp: t0 + 1000 },
        ] as any[];
        const { apiMessages } = ChatPrompts.buildMessageHistory(history, 10, char, { name: '我' } as any, []);
        const texts = apiMessages.map((m: any) => String(m.content));
        expect(texts.some(t => t.includes('[語音] 我到家了'))).toBe(true);
        expect(texts.some(t => t.includes('普通打字') && !t.includes('[語音]'))).toBe(true);
    });

    it('說話辨識語言預設中文（台灣），存了不認得的值也回預設', () => {
        localStorage.removeItem('soren_user_voice_stt_lang');
        expect(readUserVoiceSttLang()).toBe('zh-TW');
        localStorage.setItem('soren_user_voice_stt_lang', 'ja-JP');
        expect(readUserVoiceSttLang()).toBe('ja-JP');
        localStorage.setItem('soren_user_voice_stt_lang', 'xx');
        expect(readUserVoiceSttLang()).toBe('zh-TW');
        localStorage.removeItem('soren_user_voice_stt_lang');
    });
});
