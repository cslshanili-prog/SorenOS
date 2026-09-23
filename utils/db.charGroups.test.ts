import { describe, it, expect } from 'vitest';
import { DB } from './db';
import type { CharacterProfile, CharacterGroup } from '../types';

// 角色分組的導出/導入 round-trip：
// 分組定義存獨立 store（character_groups），角色只帶 groupId 指針——
// 兩邊必須同進退，漏掉任何一邊都會讓導入端全員回落「未分組」。
describe('角色分組 (character_groups + groupId) 導出/導入 round-trip', () => {
  it('exportFullData → JSON → importFullData 後分組定義與角色 groupId 都在', async () => {
    const group: CharacterGroup = { id: 'cgroup-rt-1', name: '測試分組', createdAt: 1718900000000 };
    const char = {
      id: 'cgroup-rt-char',
      name: '小組員',
      avatar: '',
      description: '',
      systemPrompt: '',
      memories: [],
      groupId: 'cgroup-rt-1',
    } as unknown as CharacterProfile;

    await DB.saveCharacterGroup(group);
    await DB.saveCharacter(char);

    // 1) 導出 + 模擬寫文件/讀文件
    const exported = await DB.exportFullData();
    const onDisk = JSON.parse(JSON.stringify(exported));

    // 導出物裡必須同時帶著分組定義和角色的 groupId
    expect((onDisk.characterGroups as CharacterGroup[]).find(g => g.id === 'cgroup-rt-1')?.name).toBe('測試分組');
    expect((onDisk.characters as CharacterProfile[]).find(c => c.id === 'cgroup-rt-char')?.groupId).toBe('cgroup-rt-1');

    // 2) 清掉本地再導入（模擬換設備：分組被刪、角色 groupId 被清）
    await DB.deleteCharacterGroup('cgroup-rt-1');
    await DB.saveCharacter({ ...char, groupId: undefined } as any);
    await DB.importFullData(onDisk as any, {});

    // 3) 導入後分組定義與指針都應恢復
    const groups = await DB.getCharacterGroups();
    expect(groups.find(g => g.id === 'cgroup-rt-1')?.name).toBe('測試分組');
    const restored = (await DB.getAllCharacters()).find(c => c.id === 'cgroup-rt-char');
    expect(restored?.groupId).toBe('cgroup-rt-1');
  });
});
