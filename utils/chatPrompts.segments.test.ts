import { describe, it, expect } from 'vitest';
import { CHAT_STABLE_SEGMENT_ORDER, ChatPrompts } from './chatPrompts';
import { CHAT_STYLE_ANCHOR, CHAT_STYLE_EXPRESSION, CHAT_STYLE_TALK, fillChatNames } from './chatPresetText';

// 私聊提示詞分段（plans/preset-library.md 第 2 批）：內建送出照舊是 stable／volatileState／recencyTail，
// 段只是同一串字的切法——照順序接回去必須一字不差，自訂預設才敢一段一段搬。

const run = (char: any, user: any) => ChatPrompts.buildSystemPromptParts(char, user, [], [], [], []);

describe('私聊提示詞分段', () => {
    const cases: Array<[string, any]> = [
        ['最少欄位', { id: 'c1', name: '小角色', systemPrompt: '冷淡的新同事' }],
        ['功能全開', {
            id: 'c2', name: '阿澈', systemPrompt: '溫柔', worldview: '現代', dateInvite: true, charCall: true, allowCharBlockUser: true,
            chatVoiceEnabled: true, chatVoiceLang: 'ja', chatCollaborationEnabled: true, onlineActions: true, vrState: { enabled: true, title: 't' },
        }],
    ];
    for (const [label, char] of cases) {
        it(`${label}：段照順序接回去就是送出的那串`, async () => {
            const parts = await run(char, { name: '小星' });
            expect(CHAT_STABLE_SEGMENT_ORDER.map(key => parts.segments[key]).join('')).toBe(parts.stable);
            expect(parts.segments.live).toBe(parts.volatileState);
            expect(parts.segments.expression + parts.segments.anchor).toBe(parts.recencyTail);
        });
    }

    it('文風三段：內建送出用的就是 chatPresetText 的字，換上名字', async () => {
        const parts = await run({ id: 'c1', name: '阿澈', systemPrompt: 'x' }, { name: '小星' });
        expect(parts.segments.talk).toBe(CHAT_STYLE_TALK);
        expect(parts.segments.expression).toBe(fillChatNames(CHAT_STYLE_EXPRESSION, '阿澈', '小星'));
        expect(parts.segments.anchor).toBe(fillChatNames(CHAT_STYLE_ANCHOR, '阿澈', '小星'));
        expect(parts.segments.anchor).toContain('你就是 阿澈。');
        expect(parts.segments.expression).toContain('小星 給你反饋時');
    });

    it('各段的開頭落在該落的地方', async () => {
        const { segments } = await run({ id: 'c1', name: '阿澈', systemPrompt: 'x', chatVoiceEnabled: false }, { name: '小星' });
        expect(segments.format.startsWith('### 聊天 App 行為規範')).toBe(true);
        expect(segments.talk.startsWith('1. **沉浸感**')).toBe(true);
        expect(segments.emoji.startsWith('3. **格式要求**')).toBe(true);
        expect(segments.quote.startsWith('4. **引用功能')).toBe(true);
        expect(segments.actions.startsWith('6. **可用動作**')).toBe(true);
        expect(segments.voice).toContain('語音消息功能當前未開啟');
    });

    it('換名字不會把名字裡的大括號再換一次', () => {
        expect(fillChatNames('{{char}} 和 {{user}}', '{{user}}', 'B')).toBe('{{user}} 和 B');
    });
});
