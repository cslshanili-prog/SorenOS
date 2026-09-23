import { describe, expect, it } from 'vitest';
import type { CharacterProfile, Message } from '../types';
import { DB } from './db';
import { loadStoryActorContext, replaceStoryTheaterReply } from './storyTheaterReply';

describe('劇情重寫上下文和保存', () => {
    it('本劇情的用戶/助手鏡像都不迴流，仍保留其他來源和劇情的可見原文', async () => {
        const char = { id: 'reroll-actor', contextRangeMode: 'manual', contextLimit: 20, contextRangePolicyVersion: 1 } as CharacterProfile;
        for (const [content, metadata] of [
            ['私聊', { source: 'chat' }],
            ['別的劇情', { source: 'story_theater_memory', theaterId: 'other' }],
            ['本輪輸入', { source: 'story_theater_memory', theaterId: 'current' }],
            ['舊回覆', { source: 'story_theater_memory', theaterId: 'current' }],
        ] as const) await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'text', content, metadata });
        expect((await loadStoryActorContext(char, 'current', 20)).map(message => message.content)).toEqual(['私聊', '別的劇情']);
    });
    const seed = async (id: string): Promise<Message> => {
        const centralId = await DB.saveMessage({ charId: id, role: 'assistant', type: 'text', content: '舊回覆' });
        const mirrorId = await DB.saveMessage({ charId: id + '-actor', role: 'assistant', type: 'text', content: '舊回覆' });
        await DB.updateMessageMetadata(centralId, () => ({ theaterMirrorIds: { actor: mirrorId } }));
        return (await DB.getMessagesByCharId(id, true))[0];
    };
    it('成功後原位原子替換，中央正文和鏡像不會多出一條', async () => {
        const old = await seed('reroll-save');
        await replaceStoryTheaterReply(old, '新回覆', { theaterPromptTokens: 123 });
        const rows = await DB.getMessagesByCharId(old.charId, true);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: old.id, content: '新回覆', metadata: { theaterPromptTokens: 123 } });
        expect((await DB.getMessagesByCharId(old.charId + '-actor', true))[0].content).toBe('新回覆');
    });
    it('任意鏡像在請求期間被編輯，整個事務回滾保留用戶修改和原正文', async () => {
        const old = await seed('reroll-conflict');
        const mirrorId = Number((old.metadata?.theaterMirrorIds as Record<string, number>).actor);
        await DB.updateMessage(mirrorId, '手動編輯');
        await expect(replaceStoryTheaterReply(old, '新回覆', {})).rejects.toThrow('已被修改');
        expect((await DB.getMessagesByCharId(old.charId, true))[0].content).toBe('舊回覆');
        expect((await DB.getMessagesByCharId(old.charId + '-actor', true))[0].content).toBe('手動編輯');
    });
});
