import { describe, it, expect } from 'vitest';
import { DB } from './db';
import type { CharacterProfile } from '../types';

// 復現「人格模擬生活記錄導出再導入後消失」的報障：
// simLogs 存在 char.phoneState.simLogs，應隨角色一起 round-trip。
describe('生活記錄 (phoneState.simLogs) 導出/導入 round-trip', () => {
  it('exportFullData → JSON → importFullData 後 simLogs 仍在', async () => {
    const char = {
      id: 'sim-rt-char',
      name: '阿狸',
      persona: '測試角色',
      phoneState: {
        records: [],
        simLogs: [
          // 新版：帶完整腳本快照（可重播），導出導入須把 script.beats 一起帶走
          { id: 'sim-1', mode: 'daily', theme: '雨天', title: '一個雨天', summary: '', ending: 'soft', beatsCount: 12, memoryText: '下了一天的雨。', timestamp: 1718900000000,
            script: { title: '一個雨天', summary: '', ending: 'soft', beats: [
              { kind: 'lock', time: '07:00', monologue: '不想起床。' },
              { kind: 'thought', monologue: '又下雨了。', vibe: 'numb' },
              { kind: 'end' },
            ] } },
          // 舊版：沒有 script 快照，導入後仍應保持「沒有」（只能發送、不能重播）
          { id: 'sim-2', mode: 'event', theme: '搬家', title: '搬家那天', summary: '', ending: 'open', beatsCount: 20, memoryText: '箱子堆滿了客廳。', timestamp: 1718990000000 },
        ],
      },
    } as unknown as CharacterProfile;

    await DB.saveCharacter(char);

    // 1) 導出（DB 層路徑，等價於設置-導出讀 characters store 的內容）
    const exported = await DB.exportFullData();
    // 2) 模擬寫文件 + 讀文件
    const onDisk = JSON.parse(JSON.stringify(exported));

    // 導出物裡必須帶著 simLogs
    const exportedChar = (onDisk.characters as CharacterProfile[]).find(c => c.id === 'sim-rt-char');
    expect(exportedChar?.phoneState?.simLogs?.length).toBe(2);

    // 3) 清掉再導入
    await DB.saveCharacter({ ...char, phoneState: { records: [] } } as any); // 模擬導入前本地無記錄
    await DB.importFullData(onDisk as any, {});

    // 4) 導入後從 DB 重新讀
    const all = await DB.getAllCharacters();
    const restored = all.find(c => c.id === 'sim-rt-char');
    const restoredLogs = restored?.phoneState?.simLogs;
    expect(restoredLogs?.length).toBe(2);
    expect(restoredLogs?.[0].memoryText).toBe('下了一天的雨。');
    // 新版腳本快照完整 round-trip → 導入後仍可重播
    expect(restoredLogs?.[0].script?.beats?.length).toBe(3);
    expect(restoredLogs?.[0].script?.beats?.[0].monologue).toBe('不想起床。');
    // 舊版沒有 script，導入後依舊沒有（不會憑空冒出來）
    expect(restoredLogs?.[1].script).toBeUndefined();
  });
});
