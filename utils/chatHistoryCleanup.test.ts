import { beforeEach, describe, expect, it } from 'vitest';
import { DB, openDB } from './db';
import { CHAT_CLEANUP_CONFIRMATION, deleteChatHistoryCleanup, prepareChatHistoryCleanup } from './chatHistoryCleanup';
import { CONTENT_FAVORITES_INDEX_ASSET_ID, listContentFavorites, resolveContentFavorite, saveMessageContentFavorite } from './contentFavorites';

const confirmed = { reviewed: true, text: CHAT_CLEANUP_CONFIRMATION };
const seed = async (charId: string, count = 6) => {
    const ids: number[] = [];
    for (let n = 0; n < count; n++) ids.push(await DB.saveMessage({ charId, role: n % 2 ? 'assistant' : 'user', type: 'text', content: `正文 ${n}`, timestamp: 1700000000000 + n }));
    return ids;
};
beforeEach(() => localStorage.clear());

describe('聊天記錄區間永久清理', () => {
    it('兩次確認缺一不可，確認文字必須完全一致，取消/錯誤輸入都不刪記錄', async () => {
        const ids = await seed('cleanup-confirm');
        const plan = await prepareChatHistoryCleanup('cleanup-confirm', { fromId: ids[1], toId: ids[3] });
        for (const confirmation of [{ reviewed: false, text: CHAT_CLEANUP_CONFIRMATION }, { reviewed: true, text: '' }, { reviewed: true, text: '我確定刪除' }, { reviewed: true, text: CHAT_CLEANUP_CONFIRMATION + ' ' }]) {
            await expect(deleteChatHistoryCleanup(plan, confirmation)).rejects.toThrow('兩次確認');
            expect(await DB.countMessagesByCharId(plan.charId)).toBe(6);
        }
    });

    it('包含起止邊界，只刪除當前角色私有記錄，其他角色和群聊保留', async () => {
        const ids = await seed('cleanup-scope');
        const other = await DB.saveMessage({ charId: 'cleanup-other', role: 'user', type: 'text', content: '其他角色' });
        const group = await DB.saveMessage({ charId: 'cleanup-scope', groupId: 'g1', role: 'user', type: 'text', content: '群聊' });
        const last = await DB.saveMessage({ charId: 'cleanup-scope', role: 'user', type: 'text', content: '' });
        localStorage.setItem('mp_lastMsgId_cleanup-scope', String(ids[2]));
        const plan = await prepareChatHistoryCleanup('cleanup-scope', { fromId: last, toId: ids[2] });
        expect(plan.ids).toEqual([...ids.slice(2), last]);
        expect(plan.afterWaterlineCount).toBe(4);
        expect(await deleteChatHistoryCleanup(plan, confirmed)).toBe(5);
        expect((await DB.getMessagesByCharId('cleanup-scope', true)).map(message => message.id)).toEqual(ids.slice(0, 2));
        expect(await DB.getMessageById(other)).toBeTruthy();
        expect(await DB.getMessageById(group)).toBeTruthy();
        expect(localStorage.getItem('mp_lastMsgId_cleanup-scope')).toBe(String(ids[2]));
    });

    it('保留最近 N 條，確認期間新來的消息也保留', async () => {
        const ids = await seed('cleanup-retain');
        const plan = await prepareChatHistoryCleanup('cleanup-retain', { keepRecent: 2 });
        expect(plan.ids).toEqual(ids.slice(0, 4));
        const arrival = await DB.saveMessage({ charId: plan.charId, role: 'user', type: 'text', content: '確認期間新收到' });
        await deleteChatHistoryCleanup(plan, confirmed);
        expect((await DB.getMessagesByCharId(plan.charId, true)).map(message => message.id)).toEqual([...ids.slice(-2), arrival]);
        expect((await prepareChatHistoryCleanup(plan.charId, { keepRecent: 200 })).ids).toEqual([]);
    });

    it('選中原文被編輯時事務整體回滾，不留下刪了一半的記錄和語音', async () => {
        const ids = await seed('cleanup-edit');
        await DB.saveAssetRaw(`voice_msg_${ids[0]}`, { originalText: '語音' });
        const plan = await prepareChatHistoryCleanup('cleanup-edit', { fromId: ids[0], toId: ids[4] });
        await DB.updateMessage(ids[3], '確認期間手動編輯');
        await expect(deleteChatHistoryCleanup(plan, confirmed)).rejects.toThrow('記錄已變化');
        expect(await DB.countMessagesByCharId(plan.charId)).toBe(6);
        expect(await DB.getAssetRaw(`voice_msg_${ids[0]}`)).toBeTruthy();
        expect((await DB.getMessageById(ids[3]))?.content).toBe('確認期間手動編輯');
    });

    it('有選中消息在另一窗口被刪除時，保留其餘全部原文並要求重新確認', async () => {
        const ids = await seed('cleanup-missing');
        const plan = await prepareChatHistoryCleanup('cleanup-missing', { fromId: ids[0], toId: ids[4] });
        await DB.deleteMessage(ids[3]);
        await expect(deleteChatHistoryCleanup(plan, confirmed)).rejects.toThrow('記錄已變化');
        expect((await DB.getMessagesByCharId(plan.charId, true)).map(message => message.id)).toEqual(ids.filter(id => id !== ids[3]));
    });

    it('思維鏈等附屬內容改變也需要重新確認', async () => {
        const ids = await seed('cleanup-metadata');
        const plan = await prepareChatHistoryCleanup('cleanup-metadata', { fromId: ids[0], toId: ids[3] });
        await DB.updateMessageMetadata(ids[2], previous => ({ ...previous, thinkingChain: '確認期間新增的思維鏈' }));
        await expect(deleteChatHistoryCleanup(plan, confirmed)).rejects.toThrow('記錄已變化');
        expect(await DB.countMessagesByCharId(plan.charId)).toBe(6);
    });

    it('多批不連續主鍵清理不會跨過其他角色的消息', async () => {
        const own: number[] = [], other: number[] = [];
        for (let i = 0; i < 130; i++) {
            own.push(await DB.saveMessage({ charId: 'cleanup-interleaved', role: 'user', type: 'text', content: `本角色${i}` }));
            other.push(await DB.saveMessage({ charId: 'cleanup-interleaved-other', role: 'user', type: 'text', content: `其他角色${i}` }));
        }
        const plan = await prepareChatHistoryCleanup('cleanup-interleaved', { fromId: own[0], toId: own.at(-1)! });
        expect(await deleteChatHistoryCleanup(plan, confirmed)).toBe(130);
        expect(await DB.countMessagesByCharId(plan.charId)).toBe(0);
        expect((await DB.getMessagesByCharId('cleanup-interleaved-other', true)).map(message => message.id)).toEqual(other);
    });

    it('收藏圖片保留，普通聊天語音緩存同步刪除', async () => {
        await DB.deleteAsset(CONTENT_FAVORITES_INDEX_ASSET_ID);
        const id = await DB.saveMessage({ charId: 'cleanup-favorite', role: 'assistant', type: 'image', content: 'data:image/png;base64,QUJD' });
        const message = (await DB.getMessageById(id))!;
        await saveMessageContentFavorite(message, '角色');
        await DB.saveAssetRaw(`voice_msg_${id}`, { originalText: '緩存' });
        const plan = await prepareChatHistoryCleanup(message.charId, { fromId: id, toId: id });
        await deleteChatHistoryCleanup(plan, confirmed);
        expect(await DB.getAssetRaw(`voice_msg_${id}`)).toBeNull();
        const favorite = (await listContentFavorites())[0];
        const resolved = await resolveContentFavorite(favorite);
        expect('imageUrl' in resolved && resolved.imageUrl).toBe(message.content);
    });

    it('清理劇情陪伴副本後保留中央正文及其他角色，並移除懸空副本引用', async () => {
        const central = await DB.saveMessage({ charId: 'story-thread', role: 'assistant', type: 'text', content: '劇情正文', metadata: { source: 'story_theater', theaterId: 'story' } });
        const own = await DB.saveMessage({ charId: 'cleanup-mirror', role: 'assistant', type: 'text', content: '劇情正文', metadata: { source: 'story_theater_memory', theaterId: 'story', theaterCentralId: central } });
        const other = await DB.saveMessage({ charId: 'other-actor', role: 'assistant', type: 'text', content: '劇情正文' });
        await DB.updateMessageMetadata(central, () => ({ source: 'story_theater', theaterId: 'story', theaterMirrorIds: { 'cleanup-mirror': own, 'other-actor': other } }));
        await deleteChatHistoryCleanup(await prepareChatHistoryCleanup('cleanup-mirror', { fromId: own, toId: own }), confirmed);
        expect((await DB.getMessageById(central))?.metadata?.theaterMirrorIds).toEqual({ 'other-actor': other });
        expect(await DB.getMessageById(other)).toBeTruthy();
    });

    it('十萬條記錄可保留最近 200 條，預覽只保留 ID 和指紋', async () => {
        const db = await openDB();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('messages', 'readwrite');
            for (let i = 0; i < 100050; i++) tx.objectStore('messages').add({ charId: 'cleanup-large', role: 'user', type: 'text', content: `記錄${i}`, timestamp: 1700000000000 + i });
            tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
        });
        const plan = await prepareChatHistoryCleanup('cleanup-large', { keepRecent: 200 });
        expect(plan.ids).toHaveLength(99850);
        expect(JSON.stringify(plan)).not.toContain('記錄');
        expect(await deleteChatHistoryCleanup(plan, confirmed)).toBe(99850);
        const left = await DB.getMessagesByCharId('cleanup-large', true);
        expect(left).toHaveLength(200);
        expect(left[0].content).toBe('記錄99850');
        expect(left.at(-1)?.content).toBe('記錄100049');
    }, 120000);
});
