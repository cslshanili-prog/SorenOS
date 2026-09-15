import { describe, it, expect, vi, beforeEach } from 'vitest';

const saveMessage = vi.fn(async () => 1);
vi.mock('../db', () => ({
    DB: {
        saveMessage: (...args: any[]) => saveMessage(...args),
        getGroupMessages: async () => [],
        updateMessageMetadata: async () => {},
    },
}));

import { dispatchMemberActions, DispatchContext } from './dispatch';
import type { CharacterProfile } from '../../types';

const char = (id: string, name: string): CharacterProfile => ({ id, name } as CharacterProfile);

const baseCtx = (overrides?: Partial<DispatchContext>): DispatchContext => ({
    groupId: 'g1',
    memberIds: ['c1', 'c2'],
    characters: [char('c1', '小夏'), char('c2', '阿方')],
    emojis: [],
    categories: [],
    refresh: async () => {},
    addToast: () => {},
    userName: '用户',
    ...overrides,
});

describe('[[ACTION:LEAVE_GROUP]] 退群命令', () => {
    beforeEach(() => {
        saveMessage.mockClear();
    });

    it('没传 onMemberLeave 时：标记被剥掉，正文照常落库，不会触发任何退群副作用', async () => {
        const onMemberLeave = vi.fn();
        await dispatchMemberActions(
            [{ charId: 'c1', content: '好的，那我先走了\n[[ACTION:LEAVE_GROUP]]' }],
            baseCtx(), // 不传 onMemberLeave
        );
        expect(onMemberLeave).not.toHaveBeenCalled();
        expect(saveMessage).toHaveBeenCalledTimes(1);
        const saved = saveMessage.mock.calls[0][0];
        expect(saved.content).toBe('好的，那我先走了');
        expect(saved.content).not.toContain('LEAVE_GROUP');
    });

    it('传了 onMemberLeave 时：连带的告别文字先落库为气泡，退群回调带正确的 charId/charName 触发一次', async () => {
        const onMemberLeave = vi.fn(async () => {});
        await dispatchMemberActions(
            [{ charId: 'c1', content: '好的，那我先走了\n[[ACTION:LEAVE_GROUP]]' }],
            baseCtx({ onMemberLeave }),
        );
        expect(onMemberLeave).toHaveBeenCalledTimes(1);
        expect(onMemberLeave).toHaveBeenCalledWith('c1', '小夏');
        expect(saveMessage).toHaveBeenCalledTimes(1);
        expect(saveMessage.mock.calls[0][0].content).toBe('好的，那我先走了');
    });

    it('纯退群标记（没有其它正文）：文字气泡不落库，但退群回调依然触发一次', async () => {
        const onMemberLeave = vi.fn(async () => {});
        await dispatchMemberActions(
            [{ charId: 'c1', content: '[[ACTION:LEAVE_GROUP]]' }],
            baseCtx({ onMemberLeave }),
        );
        expect(onMemberLeave).toHaveBeenCalledTimes(1);
        expect(onMemberLeave).toHaveBeenCalledWith('c1', '小夏');
        expect(saveMessage).not.toHaveBeenCalled();
    });

    it('混着 PRIVATE 一起纯退群（公开正文清空后提前 continue 的路径）：退群回调也只触发一次', async () => {
        const onMemberLeave = vi.fn(async () => {});
        await dispatchMemberActions(
            [{ charId: 'c1', content: '[[PRIVATE: 私下告诉你我要走了]]\n[[ACTION:LEAVE_GROUP]]' }],
            baseCtx({ onMemberLeave }),
        );
        expect(onMemberLeave).toHaveBeenCalledTimes(1);
        expect(onMemberLeave).toHaveBeenCalledWith('c1', '小夏');
    });

    it('没有退群标记的普通消息：不触发回调', async () => {
        const onMemberLeave = vi.fn(async () => {});
        await dispatchMemberActions(
            [{ charId: 'c1', content: '今天天气不错' }],
            baseCtx({ onMemberLeave }),
        );
        expect(onMemberLeave).not.toHaveBeenCalled();
    });
});
