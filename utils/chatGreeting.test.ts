import { describe, expect, it } from 'vitest';
import { chatGreetingMessage, hasChatGreeting } from './chatGreeting';

describe('私聊開場白', () => {
    const char = { name: '阿岳', chatGreetings: [{ id: 'a', text: '  ' }, { id: 'b', text: '{{user}}，你來啦。我是{{char}}。' }] };
    it('挑有字的那段、換名字', () => {
        expect(hasChatGreeting(char)).toBe(true);
        expect(hasChatGreeting({ chatGreetings: [{ id: 'x', text: ' ' }] })).toBe(false);
        expect(chatGreetingMessage(char, '小晴')).toEqual({ content: '小晴，你來啦。我是阿岳。', metadata: { chatGreeting: true, greetingId: 'b' } });
    });
    it('沒有開場白、拉黑中都不送', () => {
        expect(chatGreetingMessage({ name: 'A' }, 'B')).toBeNull();
        expect(chatGreetingMessage({ ...char, chatBlock: { by: 'user' } as any }, '小晴')).toBeNull();
    });
    it('好幾段隨機挑', () => {
        const two = { name: 'A', chatGreetings: [{ id: '1', text: '一' }, { id: '2', text: '二' }] };
        expect(chatGreetingMessage(two, 'B', () => 0)?.content).toBe('一');
        expect(chatGreetingMessage(two, 'B', () => 0.99)?.content).toBe('二');
    });
});
