import { describe, it, expect, vi, afterEach } from 'vitest';
import { DB } from './db';
import { syncButtonLabel, syncToastText, upsertChatCard } from './chatCardSync';

const card = { role: 'assistant' as const, type: 'phone_card' as const, content: '[卡] 新內容', metadata: { phoneCard: { app: 'X', title: 't' } } };

describe('upsertChatCard（同步到私聊可以按第二次）', () => {
    afterEach(() => vi.restoreAllMocks());

    it('那張卡還在、同一個角色 → 原地更新', async () => {
        vi.spyOn(DB, 'getMessageById').mockResolvedValue({ id: 7, charId: 'c1' } as any);
        const replace = vi.spyOn(DB, 'replaceMessageFields').mockResolvedValue();
        const save = vi.spyOn(DB, 'saveMessage').mockResolvedValue(99);
        expect(await upsertChatCard(7, 'c1', card)).toEqual({ id: 7, updated: true });
        expect(replace).toHaveBeenCalledWith(7, { type: 'phone_card', content: '[卡] 新內容', metadata: card.metadata });
        expect(save).not.toHaveBeenCalled();
    });

    it('卡被刪了、沒同步過、或 id 指到別人的私聊 → 重新發一張', async () => {
        const save = vi.spyOn(DB, 'saveMessage').mockResolvedValue(99);
        vi.spyOn(DB, 'replaceMessageFields').mockResolvedValue();
        vi.spyOn(DB, 'getMessageById').mockResolvedValueOnce(undefined as any).mockResolvedValueOnce({ id: 7, charId: 'other' } as any);
        expect(await upsertChatCard(7, 'c1', card)).toEqual({ id: 99, updated: false });
        expect(await upsertChatCard(7, 'c1', card)).toEqual({ id: 99, updated: false });
        expect(await upsertChatCard(undefined, 'c1', card)).toEqual({ id: 99, updated: false });
        expect(save).toHaveBeenCalledTimes(3);
        expect(save.mock.calls[0][0]).toMatchObject({ charId: 'c1', type: 'phone_card', content: '[卡] 新內容' });
    });

    it('按鈕與提示文字', () => {
        expect(syncButtonLabel(false, false)).toBe('同步到私聊');
        expect(syncButtonLabel(true, false)).toContain('再同步一次');
        expect(syncButtonLabel(true, true)).toBe('同步中…');
        expect(syncToastText(true)).toContain('更新');
        expect(syncToastText(false)).toBe('已同步到私聊');
    });
});
