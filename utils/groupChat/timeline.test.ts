import { describe, it, expect } from 'vitest';
import { buildMemberTimeline } from './timeline';
import { Message } from '../../types';

const msg = (over: Partial<Message>): Message => ({
    id: 1,
    charId: 'c1',
    role: 'assistant',
    type: 'text',
    content: '內容',
    timestamp: 0,
    ...over,
} as Message);

const resolveSpeaker = (m: Message) => (m.charId === 'c1' ? '小夏' : '未知');

describe('buildMemberTimeline', () => {
    it('私聊和群聊按時間戳合併升序，帶來源標籤', () => {
        const privateMsgs = [
            msg({ id: 1, role: 'user', content: '今天好累', timestamp: 1000 }),
            msg({ id: 2, role: 'assistant', content: '早點睡', timestamp: 2000 }),
        ];
        const groupMsgs = [
            msg({ id: 3, role: 'assistant', groupId: 'g1', content: '早啊！', timestamp: 1500 }),
        ];
        const lines = buildMemberTimeline({ privateMsgs, groupMsgs, cap: 40, resolveSpeaker }).split('\n');
        expect(lines).toHaveLength(3);
        expect(lines[0]).toContain('[私聊]');
        expect(lines[0]).toContain('用戶: 今天好累');
        expect(lines[1]).toContain('[群聊]');
        expect(lines[1]).toContain('小夏: 早啊！');
        expect(lines[2]).toContain('[私聊]');
        expect(lines[2]).toContain('我: 早點睡');
    });

    it('cap 生效：合併後只留時間最近的 N 條', () => {
        const privateMsgs = Array.from({ length: 10 }, (_, i) =>
            msg({ id: i, role: 'user', content: `p${i}`, timestamp: i * 100 }));
        const groupMsgs = Array.from({ length: 10 }, (_, i) =>
            msg({ id: 100 + i, groupId: 'g1', content: `g${i}`, timestamp: i * 100 + 50 }));
        const lines = buildMemberTimeline({ privateMsgs, groupMsgs, cap: 5, resolveSpeaker }).split('\n');
        expect(lines).toHaveLength(5);
        // 末 5 條應是時間最大的：g7(750) p8(800) g8(850) p9(900) g9(950)
        expect(lines[4]).toContain('g9');
        expect(lines[0]).toContain('g7');
    });

    it('非文本消息用佔位符，base64 不會出現在時間線裡', () => {
        const groupMsgs = [
            msg({ id: 1, groupId: 'g1', type: 'image', content: 'data:image/jpeg;base64,AAAA', timestamp: 100 }),
            msg({ id: 2, groupId: 'g1', type: 'transfer', content: '[紅包] 88 Credits', metadata: { amount: '88' }, timestamp: 200 }),
        ];
        const text = buildMemberTimeline({ privateMsgs: [], groupMsgs, cap: 40, resolveSpeaker });
        expect(text).not.toContain('base64');
        expect(text).toContain('[圖片]');
        expect(text).toContain('[發紅包: 88]');
    });

    it('超長正文截斷到 80 字並加省略號', () => {
        const long = '啊'.repeat(120);
        const privateMsgs = [msg({ id: 1, role: 'user', content: long, timestamp: 100 })];
        const line = buildMemberTimeline({ privateMsgs, groupMsgs: [], cap: 40, resolveSpeaker });
        expect(line).toContain('啊'.repeat(80) + '…');
        expect(line).not.toContain('啊'.repeat(81));
    });

    it('空輸入返回空串', () => {
        expect(buildMemberTimeline({ privateMsgs: [], groupMsgs: [], cap: 40, resolveSpeaker })).toBe('');
    });
});
