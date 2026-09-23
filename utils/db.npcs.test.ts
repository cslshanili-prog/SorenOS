import { describe, it, expect } from 'vitest';
import { DB } from './db';
import type { NPCProfile } from '../types';

// NPC 檔案的導出/導入 round-trip：npcs 是獨立於 characters 的 store，
// importFullData 內部有一份手寫的 availableStores/hasStore 白名單，
// 漏掉 STORE_NPCS 會導致 mergeStore('npcs', ...) 靜默跳過——即使 data.npcs
// 本身完整無損，導入後 NPC 名單也會清空。這個用例專盯這條白名單別再漏。
describe('NPC 檔案 (npcs) 導出/導入 round-trip', () => {
  it('exportFullData → JSON → importFullData 後 NPC 檔案都在', async () => {
    const npc: NPCProfile = {
      id: 'npc-rt-1',
      name: '測試 NPC',
      avatar: '',
      description: '一個用於迴歸測試的 NPC',
      relationships: [{ id: 'rel-1', targetId: 'user', description: '鄰居' }],
      createdAt: 1718900000000,
      updatedAt: 1718900000000,
    };

    await DB.saveNPC(npc);

    // 1) 導出 + 模擬寫文件/讀文件
    const exported = await DB.exportFullData();
    const onDisk = JSON.parse(JSON.stringify(exported));

    expect((onDisk.npcs as NPCProfile[]).find(n => n.id === 'npc-rt-1')?.name).toBe('測試 NPC');

    // 2) 清掉本地再導入（模擬換設備：NPC 名單被清空）
    await DB.deleteNPC('npc-rt-1');
    expect(await DB.getAllNPCs()).toHaveLength(0);

    await DB.importFullData(onDisk as any, {});

    // 3) 導入後 NPC 檔案應恢復
    const restored = (await DB.getAllNPCs()).find(n => n.id === 'npc-rt-1');
    expect(restored?.name).toBe('測試 NPC');
    expect(restored?.relationships).toEqual([{ id: 'rel-1', targetId: 'user', description: '鄰居' }]);
  });
});
