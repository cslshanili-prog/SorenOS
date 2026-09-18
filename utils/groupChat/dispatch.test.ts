import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const saveMessage = vi.fn(async () => 1);
vi.mock('../db', () => ({
    DB: {
        saveMessage: (...args: any[]) => saveMessage(...args),
        getGroupMessages: async () => [],
        updateMessageMetadata: async () => {},
    },
}));

import { dispatchMemberActions, DispatchContext } from './dispatch';
import { DB } from '../db';
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

describe('group sticker format recovery', () => {
    const ctx: DispatchContext = {
        groupId: 'g-emoji', memberIds: ['c-emoji'], characters: [{ id: 'c-emoji', name: '角色' }] as any,
        emojis: [{ name: '开心', url: 'https://example.com/happy.png', categoryId: 'visible' }, { name: '私有', url: 'https://example.com/hidden.png', categoryId: 'hidden' }],
        categories: [{ id: 'visible', name: '公共' }, { id: 'hidden', name: '隐藏', allowedCharacterIds: ['other'] }] as any,
        refresh: async () => {}, addToast: () => {}, userName: '用户',
    };
    afterEach(() => vi.restoreAllMocks());

    it.each(['[[你发送了表情包：开心]]', '[SEND_EMOJI: 开心]', '【发送了表情包: 开心】'])('dispatches %s as an emoji without losing text', async content => {
        const save = vi.spyOn(DB, 'saveMessage').mockResolvedValue(1 as any);
        await dispatchMemberActions([{ charId: 'c-emoji', content: content + '\n后一句' }], ctx);
        expect(save.mock.calls.map(([m]) => [m.type, m.content])).toEqual([['emoji', 'https://example.com/happy.png'], ['text', '后一句']]);
    });
    it('does not bypass pack visibility or activate unrelated action aliases', async () => {
        const save = vi.spyOn(DB, 'saveMessage').mockResolvedValue(1 as any);
        await dispatchMemberActions([{ charId: 'c-emoji', content: '[[你发送了表情包: 私有]]\n[ACTION:TRANSFER: 520]' }], ctx);
        expect(save.mock.calls.map(([m]) => [m.type, m.content])).toEqual([['text', '[ACTION:TRANSFER: 520]']]);
    });
});
