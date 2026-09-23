import { describe, it, expect, vi } from 'vitest';
import { DB } from './db';
import { loadCharacterContextRange } from './chatContextRange';
import type { CharacterProfile } from '../types';
import { getReliableMemoryPalaceHighWaterMark, setReliableMemoryPalaceHighWaterMark } from './memoryPalace/highWaterMark';

// 記憶宮殿水位線自愈：瀏覽器清掉 IndexedDB（消息自增 id 歸零重計）但 localStorage
// 倖存時，殘留的 mp_lastMsgId_ 高水位會把該角色所有新消息（含剛發的那條）從
// hwm 過濾讀取裡擋掉 —— 請求只剩 system 消息、上游 400。不變式：合法水位是某條
// 既有消息的 id，新消息的自增 id 必然大於它；出現新 id ≤ 水位即證明水位失效。
describe('saveMessage 記憶宮殿水位線自愈', () => {
    it('正常新消息不改變合法鏡像，且只讀取水位之後的新消息', async () => {
        const profile = { id: 'normal-new-hwm', contextRangeMode: 'adaptive', autoArchiveEnabled: true } as CharacterProfile;
        const oldId = await DB.saveMessage({ charId: profile.id, role: 'assistant', type: 'text', content: '舊回覆' });
        await setReliableMemoryPalaceHighWaterMark(profile.id, oldId);
        const mirror = await DB.getAssetRaw(`mp_hwm_v1_${profile.id}`);
        const newId = await DB.saveMessage({ charId: profile.id, role: 'user', type: 'text', content: '新消息' });
        expect(await DB.getAssetRaw(`mp_hwm_v1_${profile.id}`)).toEqual(mirror);
        expect(await getReliableMemoryPalaceHighWaterMark(profile.id)).toBe(oldId);
        expect((await loadCharacterContextRange(profile)).messages.map(m => m.id)).toEqual([newId]);
    });

    it('清理失效鏡像後，後台重讀不會再次隱藏剛保存的消息', async () => {
        const profile = { id: 'new-message-stale-mirror', contextRangeMode: 'adaptive', autoArchiveEnabled: true } as CharacterProfile;
        await setReliableMemoryPalaceHighWaterMark(profile.id, 99999);
        const id = await DB.saveMessage({ charId: profile.id, role: 'user', type: 'text', content: '新消息' });
        await getReliableMemoryPalaceHighWaterMark(profile.id);
        expect((await loadCharacterContextRange(profile)).messages.map(m => m.id)).toContain(id);
    });

    it.each([false, true])('事務中止時消息和鏡像一起回滾，本地水位不動（推送=%s）', async (push) => {
        const charId = `hwm-abort-${push}`;
        const mirrorKey = `mp_hwm_v1_${charId}`;
        await setReliableMemoryPalaceHighWaterMark(charId, 99999);
        const mirror = await DB.getAssetRaw(mirrorKey);
        const originalDelete = IDBObjectStore.prototype.delete;
        const spy = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
            const request = originalDelete.call(this, key);
            if (this.name === 'assets' && key === mirrorKey) this.transaction.abort();
            return request;
        });
        try {
            const message = { charId, role: 'user', type: 'text', content: '不能提交' } as const;
            // fake-indexeddb 的主動 abort 可先用 null error 拒絕；這裡驗證不允許成功提交。
            await expect(push ? DB.saveMessageOnce('abort-delivery', message) : DB.saveMessage(message)).rejects.not.toBeUndefined();
        } finally { spy.mockRestore(); }
        expect(await DB.getMessagesByCharId(charId, true)).toEqual([]);
        expect(await DB.getAssetRaw(mirrorKey)).toEqual(mirror);
        expect(localStorage.getItem(`mp_lastMsgId_${charId}`)).toBe('99999');
    });

    it('刪除最新的已歸檔消息不會降低水位，其他角色寫入也不會改它', async () => {
        const charId = 'hwm-deleted-latest';
        const id = await DB.saveMessage({ charId, role: 'user', type: 'text', content: '已歸檔' });
        await setReliableMemoryPalaceHighWaterMark(charId, id);
        await DB.deleteMessage(id);
        await DB.saveMessage({ charId: 'hwm-other-character', role: 'user', type: 'text', content: '其他角色' });
        expect(await getReliableMemoryPalaceHighWaterMark(charId)).toBe(id);
        await DB.saveMessage({ charId, role: 'user', type: 'text', content: '新消息' });
        expect(await getReliableMemoryPalaceHighWaterMark(charId)).toBe(id);
    });

    it('推送首次落庫清理只有鏡像中的失效水位，重複投遞不清理合法水位', async () => {
        const charId = 'push-stale-mirror';
        await DB.saveAssetRaw(`mp_hwm_v1_${charId}`, { msgId: 99999 });
        const payload = { charId, role: 'assistant', type: 'text', content: '推送' } as const;
        const id = await DB.saveMessageOnce('delivery-stale', payload);
        expect(await DB.getAssetRaw(`mp_hwm_v1_${charId}`)).toBeNull();
        expect(await getReliableMemoryPalaceHighWaterMark(charId)).toBe(0);
        await setReliableMemoryPalaceHighWaterMark(charId, id);
        expect(await DB.saveMessageOnce('delivery-stale', payload)).toBe(id);
        expect(await getReliableMemoryPalaceHighWaterMark(charId)).toBe(id);
    });

    it('後台校準和新消息併發時，失效鏡像不會重新汙染本地水位', async () => {
        for (const readFirst of [true, false]) {
            const charId = `concurrent-hwm-${readFirst}`;
            await setReliableMemoryPalaceHighWaterMark(charId, 99999);
            const read = () => getReliableMemoryPalaceHighWaterMark(charId);
            const write = () => DB.saveMessage({ charId, role: 'user', type: 'text', content: '新消息' });
            await Promise.all(readFirst ? [read(), write()] : [write(), read()]);
            expect(await getReliableMemoryPalaceHighWaterMark(charId)).toBe(0);
            expect((await DB.getRecentMessagesByCharId(charId, 10)).map(m => m.content)).toContain('新消息');
        }
    });

    it('殘留高水位 ≥ 新消息 id → 落庫時自動移除，該消息能被默認讀取到', async () => {
        localStorage.setItem('mp_lastMsgId_char-stale', '99999');
        const id = await DB.saveMessage({ charId: 'char-stale', role: 'user', type: 'text', content: '你好' } as any);
        expect(id).toBeLessThan(99999);
        expect(localStorage.getItem('mp_lastMsgId_char-stale')).toBeNull();
        // 水位清掉後，默認（hwm 過濾）讀取要能看到這條消息 —— 之前 400 的根因就是這裡讀出空數組
        const msgs = await DB.getRecentMessagesByCharId('char-stale', 10);
        expect(msgs.map(m => m.content)).toContain('你好');
    });

    it('正常水位（小於新消息 id）原樣保留', async () => {
        localStorage.setItem('mp_lastMsgId_char-ok', '1');
        const id = await DB.saveMessage({ charId: 'char-ok', role: 'user', type: 'text', content: 'hi' } as any);
        expect(id).toBeGreaterThan(1);
        expect(localStorage.getItem('mp_lastMsgId_char-ok')).toBe('1');
    });

    it('群聊消息同時校驗並清理失效的群水位鍵', async () => {
        localStorage.setItem('mp_lastMsgId_group_g1', '99999');
        await DB.saveMessage({ charId: 'char-x', groupId: 'g1', role: 'user', type: 'text', content: 'g' } as any);
        expect(localStorage.getItem('mp_lastMsgId_group_g1')).toBeNull();
    });
});
