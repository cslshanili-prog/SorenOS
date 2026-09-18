import { describe, it, expect } from 'vitest';
import { DB } from './db';
import type { NPCProfile } from '../types';

// NPC 档案的导出/导入 round-trip：npcs 是独立于 characters 的 store，
// importFullData 内部有一份手写的 availableStores/hasStore 白名单，
// 漏掉 STORE_NPCS 会导致 mergeStore('npcs', ...) 静默跳过——即使 data.npcs
// 本身完整无损，导入后 NPC 名单也会清空。这个用例专盯这条白名单别再漏。
describe('NPC 档案 (npcs) 导出/导入 round-trip', () => {
  it('exportFullData → JSON → importFullData 后 NPC 档案都在', async () => {
    const npc: NPCProfile = {
      id: 'npc-rt-1',
      name: '测试 NPC',
      avatar: '',
      description: '一个用于回归测试的 NPC',
      relationships: [{ id: 'rel-1', targetId: 'user', description: '邻居' }],
      createdAt: 1718900000000,
      updatedAt: 1718900000000,
    };

    await DB.saveNPC(npc);

    // 1) 导出 + 模拟写文件/读文件
    const exported = await DB.exportFullData();
    const onDisk = JSON.parse(JSON.stringify(exported));

    expect((onDisk.npcs as NPCProfile[]).find(n => n.id === 'npc-rt-1')?.name).toBe('测试 NPC');

    // 2) 清掉本地再导入（模拟换设备：NPC 名单被清空）
    await DB.deleteNPC('npc-rt-1');
    expect(await DB.getAllNPCs()).toHaveLength(0);

    await DB.importFullData(onDisk as any, {});

    // 3) 导入后 NPC 档案应恢复
    const restored = (await DB.getAllNPCs()).find(n => n.id === 'npc-rt-1');
    expect(restored?.name).toBe('测试 NPC');
    expect(restored?.relationships).toEqual([{ id: 'rel-1', targetId: 'user', description: '邻居' }]);
  });
});
