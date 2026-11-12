/**
 * 查手機裡已經有的真角色對話搬進角色私聊線（關係線第 6 批 6c，Liora 2026-11-12 定：要搬）。
 * 腳本逐行拆成訊息，時間從那筆紀錄往前每行排開；兩邊的話題盒、好感照留在聯繫人上。
 * 兩邊手機各有一份鏡像（翻過來的），所以每對只搬一次：線上已經有訊息的就不碰。
 */
import type { CharacterProfile } from '../types';
import { DB } from './db';
import { messagesFromPhoneRecord, pairLineId } from './pairLine';

export async function migratePhoneChatsToPairLines(characters: CharacterProfile[]): Promise<number> {
    const ids = new Set(characters.map(c => c.id));
    const done = new Set<string>();
    let moved = 0;
    for (const owner of characters) {
        const contacts = owner.phoneState?.contacts || [];
        for (const r of owner.phoneState?.records || []) {
            if (r.type !== 'chat' || !r.contactId || !r.detail?.trim()) continue;
            const contact = contacts.find(c => c.id === r.contactId);
            const partnerId = contact?.kind === 'real' ? contact.linkedCharId : undefined;
            if (!partnerId || partnerId === owner.id || !ids.has(partnerId)) continue;
            const pairId = pairLineId(owner.id, partnerId);
            if (done.has(pairId)) continue;
            done.add(pairId);
            const [existing] = await DB.getRecentMessagesByCharId(pairId, 1, true);
            if (existing) continue;
            const msgs = messagesFromPhoneRecord({ pairId, ownerId: owner.id, partnerId, detail: r.detail, recordTimestamp: r.timestamp || Date.now() });
            for (const m of msgs) await DB.saveMessage(m as any);
            if (msgs.length) moved++;
        }
    }
    return moved;
}
