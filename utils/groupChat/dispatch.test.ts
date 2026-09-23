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
    userName: '用戶',
    ...overrides,
});

describe('[[ACTION:LEAVE_GROUP]] 退群命令', () => {
    beforeEach(() => {
        saveMessage.mockClear();
    });

    it('沒傳 onMemberLeave 時：標記被剝掉，正文照常落庫，不會觸發任何退群副作用', async () => {
        const onMemberLeave = vi.fn();
        await dispatchMemberActions(
            [{ charId: 'c1', content: '好的，那我先走了\n[[ACTION:LEAVE_GROUP]]' }],
            baseCtx(), // 不傳 onMemberLeave
        );
        expect(onMemberLeave).not.toHaveBeenCalled();
        expect(saveMessage).toHaveBeenCalledTimes(1);
        const saved = saveMessage.mock.calls[0][0];
        expect(saved.content).toBe('好的，那我先走了');
        expect(saved.content).not.toContain('LEAVE_GROUP');
    });

    it('傳了 onMemberLeave 時：連帶的告別文字先落庫為氣泡，退群回調帶正確的 charId/charName 觸發一次', async () => {
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

    it('純退群標記（沒有其它正文）：文字氣泡不落庫，但退群回調依然觸發一次', async () => {
        const onMemberLeave = vi.fn(async () => {});
        await dispatchMemberActions(
            [{ charId: 'c1', content: '[[ACTION:LEAVE_GROUP]]' }],
            baseCtx({ onMemberLeave }),
        );
        expect(onMemberLeave).toHaveBeenCalledTimes(1);
        expect(onMemberLeave).toHaveBeenCalledWith('c1', '小夏');
        expect(saveMessage).not.toHaveBeenCalled();
    });

    it('混著 PRIVATE 一起純退群（公開正文清空後提前 continue 的路徑）：退群回調也只觸發一次', async () => {
        const onMemberLeave = vi.fn(async () => {});
        await dispatchMemberActions(
            [{ charId: 'c1', content: '[[PRIVATE: 私下告訴你我要走了]]\n[[ACTION:LEAVE_GROUP]]' }],
            baseCtx({ onMemberLeave }),
        );
        expect(onMemberLeave).toHaveBeenCalledTimes(1);
        expect(onMemberLeave).toHaveBeenCalledWith('c1', '小夏');
    });

    it('沒有退群標記的普通消息：不觸發回調', async () => {
        const onMemberLeave = vi.fn(async () => {});
        await dispatchMemberActions(
            [{ charId: 'c1', content: '今天天氣不錯' }],
            baseCtx({ onMemberLeave }),
        );
        expect(onMemberLeave).not.toHaveBeenCalled();
    });
});

describe('group sticker format recovery', () => {
    const ctx: DispatchContext = {
        groupId: 'g-emoji', memberIds: ['c-emoji'], characters: [{ id: 'c-emoji', name: '角色' }] as any,
        emojis: [{ name: '開心', url: 'https://example.com/happy.png', categoryId: 'visible' }, { name: '私有', url: 'https://example.com/hidden.png', categoryId: 'hidden' }],
        categories: [{ id: 'visible', name: '公共' }, { id: 'hidden', name: '隱藏', allowedCharacterIds: ['other'] }] as any,
        refresh: async () => {}, addToast: () => {}, userName: '用戶',
    };
    afterEach(() => vi.restoreAllMocks());

    it.each(['[[你發送了表情包：開心]]', '[SEND_EMOJI: 開心]', '【發送了表情包: 開心】'])('dispatches %s as an emoji without losing text', async content => {
        const save = vi.spyOn(DB, 'saveMessage').mockResolvedValue(1 as any);
        await dispatchMemberActions([{ charId: 'c-emoji', content: content + '\n後一句' }], ctx);
        expect(save.mock.calls.map(([m]) => [m.type, m.content])).toEqual([['emoji', 'https://example.com/happy.png'], ['text', '後一句']]);
    });
    it('does not bypass pack visibility or activate unrelated action aliases', async () => {
        const save = vi.spyOn(DB, 'saveMessage').mockResolvedValue(1 as any);
        await dispatchMemberActions([{ charId: 'c-emoji', content: '[[你發送了表情包: 私有]]\n[ACTION:TRANSFER: 520]' }], ctx);
        expect(save.mock.calls.map(([m]) => [m.type, m.content])).toEqual([['text', '[ACTION:TRANSFER: 520]']]);
    });
});
