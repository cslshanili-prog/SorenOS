import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { DB } from './db';
import { applyRealConversationToPhoneState, upsertContact } from './relationshipChat';
import { stripBackupImages } from './backupExport';
import { assembleV2Backup, createV2ArrayFieldWriter, writeV2Backup } from './backupFormat';
import type { CharacterProfile } from '../types';

const result = {
    partnerName: '乙', partnerCharId: 'b', detail: '我: 晚上見。\n對方: 好呀。', delta: 5,
    learnedNew: '喜歡下雨天', timestamp: 1700000000000, recordId: 'a-to-b',
};

describe('查手機對話保存與備份', () => {
    it('異步結果基於最新狀態合併，保留期間新加的聯繫人、記錄、備註和話題盒', () => {
        const old = applyRealConversationToPhoneState(undefined, result).phoneState;
        const live = {
            ...old,
            contacts: upsertContact(old.contacts!.map(c => ({ ...c, note: '剛改的備註', affinity: 20,
                topicBox: [{ id: 'topic', text: '一起吃飯', createdAt: 1, span: 100 }], archivedThru: 100 })),
            { name: '丙', kind: 'npc' }),
            records: [...old.records, { id: 'new', type: 'chat', title: '丙', detail: '不會丟失的對話', timestamp: 2 }],
            sendToChat: false,
        };
        const next = applyRealConversationToPhoneState(live, { ...result, detail: '續說', partnerNote: '舊備註' }).phoneState;
        expect(next.records.map(r => r.id)).toEqual(['a-to-b', 'new']);
        expect(next.records[1]).toEqual(live.records[1]);
        expect(next.contacts).toHaveLength(2);
        expect(next.contacts![0]).toMatchObject({ note: '剛改的備註', affinity: 25, archivedThru: 100, topicBox: live.contacts[0].topicBox });
        expect(next.sendToChat).toBe(false);
        expect(live.records[0].detail).toBe(result.detail);
    });

    it.each(['full', 'text_only'] as const)('%s：完整原文、真實/NPC 聯繫人和話題盒隨分片 ZIP 恢復', async mode => {
        const phoneState = applyRealConversationToPhoneState(undefined, result).phoneState;
        phoneState.sendToChat = false; // 不依賴主聊天裡的 phone_card 副本
        phoneState.contacts = upsertContact(phoneState.contacts!, { name: '丙', kind: 'npc' });
        phoneState.contacts[0].topicBox = [{ id: 'topic', text: '歸檔總結', createdAt: 1, span: 100 }];
        phoneState.contacts[0].archivedThru = 100;
        phoneState.contacts[0].avatar = 'data:image/png;base64,AAAA';
        phoneState.records[0].detail = Array.from({ length: 110 }, (_, i) => `${i % 2 ? '對方' : '我'}: 消息 ${i}`).join('\n');
        phoneState.records.push({ id: 'npc', contactId: phoneState.contacts[1].id, type: 'chat', title: '丙', detail: '我: 你好\n對方: 在呢', timestamp: 2 });
        const char = { id: 'a', name: '甲', phoneState } as CharacterProfile;
        await DB.importFullData({ characters: [char], messages: [] } as any);

        const zip = new JSZip();
        let manifest;
        if (mode === 'text_only') {
            // 與設置頁相同：游標逐條剝圖、寫預分片，不能只測 DB.exportFullData。
            const writer = createV2ArrayFieldWriter(zip, 'characters');
            await DB.streamRawStoreData('characters', item => { writer.appendSync([stripBackupImages(item)]); });
            manifest = await writeV2Backup(zip, {}, { mode, prewrittenStores: { characters: await writer.finish() } });
        } else {
            manifest = await writeV2Backup(zip, { characters: await DB.getRawStoreData('characters') }, { mode });
        }
        const bytes = await zip.generateAsync({ type: 'uint8array' });
        const data = await assembleV2Backup(await JSZip.loadAsync(bytes), manifest);
        await DB.importFullData({ characters: [], messages: [] } as any);
        expect(await DB.getAllCharacters()).toEqual([]);
        await DB.importFullData(data as any);
        const restored = (await DB.getAllCharacters()).find(c => c.id === char.id)!;
        expect(restored.phoneState).toEqual(mode === 'text_only' ? stripBackupImages(phoneState) : phoneState);
        expect(restored.phoneState!.records[0].detail.split('\n')).toHaveLength(110);
    });
});
