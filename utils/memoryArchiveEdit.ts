/**
 * 改一筆神經鏈接的記憶（日總結）正文——神經鏈接編輯頁和羈絆的拾光共用同一條路，兩邊永遠是同一份
 * （plans/bond-batch2.md 4.2）。
 *
 * - 有宮殿關聯、宮殿開著：改宮殿節點（重算向量），檔案記錄跟著改。
 * - 宮殿關著：這筆變成獨立的傳統記錄（拿掉關聯），之後再開宮殿也不會被蓋回去。
 *
 * 回傳一個「把這筆改掉」的函式，呼叫端套在自己手上那份 memories 上（編輯頁套在表單、羈絆套在最新的角色卡）。
 */
import type { MemoryFragment } from '../types';
import { MemoryNodeDB } from './memoryPalace/db';
import { updateStoredMemoryNode } from './memoryPalace/vectorStore';

export async function editMemorySummary(args: {
    charId: string;
    memory: MemoryFragment | undefined;
    summary: string;
    linkedEnabled: boolean;
    embedding: Parameters<typeof updateStoredMemoryNode>[2];
    remote: Parameters<typeof updateStoredMemoryNode>[3];
}): Promise<(memories: MemoryFragment[]) => MemoryFragment[]> {
    const { charId, memory, summary, linkedEnabled } = args;
    if (linkedEnabled && memory?.palaceMemoryId) {
        const source = await MemoryNodeDB.getById(memory.palaceMemoryId);
        if (!source || source.charId !== charId) throw new Error('關聯的宮殿記憶已不存在，檔案文本仍保留；關閉宮殿後可按傳統檔案編輯');
        await updateStoredMemoryNode(memory.palaceMemoryId, { content: summary }, args.embedding, args.remote);
    }
    const id = memory?.id;
    return (memories: MemoryFragment[]) => memories.map(item => (item.id === id
        ? { ...item, summary, palaceMemoryId: linkedEnabled ? item.palaceMemoryId : undefined } : item));
}
