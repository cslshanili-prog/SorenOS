import { describe, expect, it } from 'vitest';
import { DB } from './db';
import { primaryLine } from './chatLine';

// 關係線（plans/persona-line-batch1-2.md）：一條線永遠讀不到另一條線的私聊。
// 主線＝沒標 personaKey 的訊息；只給 charId 的舊呼叫就是主線。
describe('私聊訊息按關係線讀', () => {
    const charId = 'line-c1';
    const B = { charId, personaKey: 'pB' };

    it('主線、其他線、群訊息互不混', async () => {
        const a1 = await DB.saveMessage({ charId, role: 'user', type: 'text', content: 'A 的第一句' });
        const b1 = await DB.saveMessage({ charId, personaKey: 'pB', role: 'user', type: 'text', content: 'B 的第一句' });
        const a2 = await DB.saveMessage({ charId, role: 'assistant', type: 'text', content: 'A 的回覆' });
        await DB.saveMessage({ charId, groupId: 'g1', role: 'assistant', type: 'text', content: '群裡說的' });
        const b2 = await DB.saveMessage({ charId, personaKey: 'pB', role: 'assistant', type: 'text', content: 'B 的回覆' });

        const ids = (ms: { id: number }[]) => ms.map(m => m.id);
        expect(ids(await DB.getMessagesByCharId(charId, true))).toEqual([a1, a2]);
        expect(ids(await DB.getMessagesByCharId(primaryLine(charId), true))).toEqual([a1, a2]);
        expect(ids(await DB.getMessagesByCharId(B, true))).toEqual([b1, b2]);

        expect(ids(await DB.getRecentMessagesByCharId(charId, 10, true))).toEqual([a1, a2]);
        expect(ids(await DB.getRecentMessagesByCharId(B, 1, true))).toEqual([b2]);

        const withCount = await DB.getRecentMessagesWithCount(B, 10);
        expect(ids(withCount.messages)).toEqual([b1, b2]);
        expect(withCount.totalCount).toBe(2);

        expect(ids((await DB.getMessagesFromId(charId, a2)).messages)).toEqual([a2]);
        expect(ids((await DB.getMessagesFromId(B, b1)).messages)).toEqual([b1, b2]);

        const firstA = await DB.getFirstMessageTimestamp(charId);
        const firstB = await DB.getFirstMessageTimestamp(B);
        expect(firstA).not.toBeNull();
        expect(firstB).not.toBeNull();
    });
});
