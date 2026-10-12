import { describe, it, expect } from 'vitest';
import { formatDateUserInput, splitDateUserInput, spokenPartOfDateInput } from './dateUserInput';
import { DatePrompts } from './datePrompts';
import type { CharacterProfile, Message, UserProfile } from '../types';

describe('splitDateUserInput / formatDateUserInput', () => {
    it('Liora 的例子：只有「好。」是說出口的，後面是旁白', () => {
        const text = '“好。” 但我其實一點也不餓，過來只是想看著他';
        expect(splitDateUserInput(text)).toEqual([
            { kind: 'spoken', text: '“好。”' },
            { kind: 'narration', text: '但我其實一點也不餓，過來只是想看著他' },
        ]);
        expect(formatDateUserInput(text)).toBe('【說出口的】“好。”\n【旁白】但我其實一點也不餓，過來只是想看著他');
        expect(spokenPartOfDateInput(text)).toBe('“好。”');
    });
    it('照原順序穿插；「」『』和英文直引號都認', () => {
        const text = '我放下杯子，「好啊。」然後看著他 "你呢？"';
        expect(formatDateUserInput(text)).toBe('【旁白】我放下杯子，\n【說出口的】「好啊。」\n【旁白】然後看著他\n【說出口的】"你呢？"');
    });
    it('沒有引號：整段原樣（當成全說出口，跟以前一樣）', () => {
        expect(splitDateUserInput('好啊，走吧')).toBeNull();
        expect(formatDateUserInput('好啊，走吧')).toBe('好啊，走吧');
        expect(spokenPartOfDateInput('好啊，走吧')).toBe('好啊，走吧');
    });
    it('整段都在引號裡：原樣；沒閉合的開引號後面全算說出口的', () => {
        expect(formatDateUserInput('「嗯，我知道。」')).toBe('「嗯，我知道。」');
        expect(formatDateUserInput('我小聲說「其實我')).toBe('【旁白】我小聲說\n【說出口的】「其實我');
    });
});

describe('見面提示詞接上分界', () => {
    const char = { id: 'c1', name: '小白', systemPrompt: '你是小白', memories: [] } as unknown as CharacterProfile;
    const user = { name: '阿明' } as UserProfile;
    let id = 1;
    const msg = (o: Partial<Message>): Message => ({ id: id++, charId: 'c1', role: 'user', type: 'text', content: '', timestamp: Date.now(), ...o } as Message);

    it('系統提示教怎麼讀；本輪和歷史裡見面的用戶話都標好；私聊的不動', async () => {
        const userText = '「好。」但我其實一點也不餓';
        const { messages } = await DatePrompts.buildSessionPayload({
            char, userProfile: user, emojis: [], variant: 'send', userText,
            allMsgs: [
                msg({ content: '「晚點見」我笑了笑', metadata: { source: 'date' } as any }),
                msg({ content: '「這是私聊」不是旁白' }),
                msg({ role: 'assistant', content: '[normal] 開場白', metadata: { source: 'date' } as any }),
                msg({ content: userText, metadata: { source: 'date' } as any }),
            ],
        });
        const sys = String(messages[0].content);
        expect(sys).toContain('你聽得到什麼、看得到什麼');
        expect(sys).toContain('心裡的想法、動機和感受你不知道');
        expect(sys).not.toContain('伸手替');
        const all = JSON.stringify(messages);
        expect(all).toContain('【說出口的】「晚點見」\\n【旁白】我笑了笑');
        expect(all).toContain('「這是私聊」不是旁白');
        const last = String(messages[messages.length - 1].content);
        expect(last.startsWith('【說出口的】「好。」\n【旁白】但我其實一點也不餓')).toBe(true);
    });
});

describe('開場方式：讓 ta 來找我', () => {
    const char = { id: 'c1', name: '小白', systemPrompt: '你是小白', memories: [] } as unknown as CharacterProfile;
    const user = { name: '阿明' } as UserProfile;
    const userPrompt = (openingMode?: 'approach' | 'invite') => String(DatePrompts.buildPeekPayload({
        char, userProfile: user, allMsgs: [], emojis: [], openingMode,
    }).messages[1].content);

    it('invite：角色主動來見用戶，停在留給用戶回應的地方，不代寫用戶反應', () => {
        const p = userPrompt('invite');
        expect(p).toContain('由你主動以合理的方式去見阿明');
        expect(p).toContain('停在留給阿明回應的地方');
        expect(p).toContain('都留給阿明自己寫');
        expect(p).not.toContain('用戶正在悄悄靠近');
    });
    it('默認／approach 照舊是用戶悄悄靠近', () => {
        expect(userPrompt()).toContain('用戶正在悄悄靠近你所在的地點');
        expect(userPrompt('approach')).toContain('用戶正在悄悄靠近你所在的地點');
    });
});
