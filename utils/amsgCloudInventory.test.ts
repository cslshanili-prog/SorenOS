// utils/amsgCloudInventory.test.ts
// 守的是「看得見」這件事本身：清點要能把三條線索合起來，一條斷了不拖累另外兩條，
// 而且斷了要如實說出來——把一份殘缺的清單當全集，用戶就會照著它誤判「本地有、雲端
// 沒有」，反過來把還在用的東西當成乾淨的。
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./activeMsgClient', () => ({
  ActiveMsgClient: {
    listAllTasks: vi.fn(),
    listLlmCredentials: vi.fn(),
    listCloudNamespaces: vi.fn(),
  },
}));

import {
  collectCloudInventory,
  formatCloudSize,
  isEmptyEntry,
  parseCharNamespace,
} from './amsgCloudInventory';
import { ActiveMsgClient } from './activeMsgClient';
import type { CharacterProfile } from '../types';

const char = (id: string, name: string): CharacterProfile =>
  ({ id, name } as CharacterProfile);

const tasksMock = () => vi.mocked(ActiveMsgClient.listAllTasks);
const credsMock = () => vi.mocked(ActiveMsgClient.listLlmCredentials);
const nsMock = () => vi.mocked(ActiveMsgClient.listCloudNamespaces);

beforeEach(() => {
  tasksMock().mockReset().mockResolvedValue([]);
  credsMock().mockReset().mockResolvedValue([]);
  nsMock().mockReset().mockResolvedValue([]);
});

describe('雲端清點', () => {
  it('三條線索合成一行：任務數、憑據用途、上下文佔用', async () => {
    tasksMock().mockResolvedValue([
      { uuid: 'u1', charId: 'char-1', messageSubtype: 'chat' },
      { uuid: 'u2', charId: 'char-1', messageSubtype: 'chat' },
      { uuid: 'u3', charId: 'char-1', messageSubtype: 'instant-chat' },
    ]);
    credsMock().mockResolvedValue([
      { credId: 'char:char-1/chat' },
      { credId: 'char:char-1/instant' },
      { credId: 'global/weather' },
    ]);
    nsMock().mockResolvedValue([
      { namespace: 'amsg:char:char-1', entryCount: 3, byteSize: 40960, updatedAt: 111 },
    ]);

    const { live, orphans } = await collectCloudInventory([char('char-1', '小明')]);

    expect(orphans).toHaveLength(0);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      charId: 'char-1',
      local: { name: '小明' },
      taskCount: 2,
      // 即時對話那行不是殘留，是用戶此刻正等著的一輪，單獨數
      instantCount: 1,
      credPurposes: ['chat', 'instant'],
      state: { entryCount: 3, byteSize: 40960, updatedAt: 111 },
    });
  });

  it('本地沒有的角色進孤兒堆，本地有的進在用堆', async () => {
    tasksMock().mockResolvedValue([{ uuid: 'u1', charId: 'char-gone', messageSubtype: 'chat' }]);
    nsMock().mockResolvedValue([
      { namespace: 'amsg:char:char-live', entryCount: 1, byteSize: 100, updatedAt: null },
    ]);

    const { live, orphans } = await collectCloudInventory([char('char-live', '還在')]);

    expect(live.map((e) => e.charId)).toEqual(['char-live']);
    expect(orphans.map((e) => e.charId)).toEqual(['char-gone']);
  });

  // 這條是這個界面的理由：沒排過任務、沒配過單獨 API 的角色，只在 client_state 裡留了
  // 一份上下文。任務表和憑據表都問不到它，只有命名空間清單看得見。
  it('只在雲端留了上下文的角色也能被發現', async () => {
    nsMock().mockResolvedValue([
      { namespace: 'amsg:char:char-ghost', entryCount: 2, byteSize: 32768, updatedAt: 1 },
    ]);

    const { orphans } = await collectCloudInventory([]);

    expect(orphans.map((e) => e.charId)).toEqual(['char-ghost']);
    expect(orphans[0].state?.byteSize).toBe(32768);
  });

  it('全局命名空間不攤到角色頭上', async () => {
    nsMock().mockResolvedValue([
      { namespace: 'amsg:global', entryCount: 3, byteSize: 900, updatedAt: 1 },
      { namespace: 'amsg:job', entryCount: 1, byteSize: 500, updatedAt: 2 },
      { namespace: 'amsg:char:char-1', entryCount: 1, byteSize: 100, updatedAt: 3 },
    ]);

    const { globals, orphans } = await collectCloudInventory([]);

    expect(globals.map((g) => g.namespace)).toEqual(['amsg:global', 'amsg:job']);
    expect(orphans).toHaveLength(1);
  });

  // 換過主密鑰之後舊密文解不開，任務清單必然最先炸——而那正是最需要看見雲端還剩什麼
  // 的時候。一條斷了另外兩條要照常出結果。
  it('任務清單讀不到，憑據和命名空間照樣出結果，並把缺口說出來', async () => {
    tasksMock().mockRejectedValue(new Error('decryption failed'));
    credsMock().mockResolvedValue([{ credId: 'char:char-1/chat' }]);
    nsMock().mockResolvedValue([
      { namespace: 'amsg:char:char-1', entryCount: 1, byteSize: 200, updatedAt: 1 },
    ]);

    const { orphans, gaps } = await collectCloudInventory([]);

    expect(orphans).toHaveLength(1);
    expect(orphans[0].credPurposes).toEqual(['chat']);
    expect(gaps).toEqual([{ kind: 'tasks', message: 'decryption failed' }]);
  });

  it('老 worker 給不出命名空間清單時，清單照出但標明不是全集', async () => {
    tasksMock().mockResolvedValue([{ uuid: 'u1', charId: 'char-1', messageSubtype: 'chat' }]);
    nsMock().mockRejectedValue(new Error('這台 Worker 還沒有「列出雲端命名空間」的能力'));

    const { orphans, gaps } = await collectCloudInventory([]);

    expect(orphans[0].taskCount).toBe(1);
    // 問不到 ≠ 沒有，所以是 null 而不是 0
    expect(orphans[0].state).toBeNull();
    expect(gaps.map((g) => g.kind)).toEqual(['namespaces']);
  });

  it('佔用大的排前面，問不到大小時按任務數排', async () => {
    tasksMock().mockResolvedValue([
      { uuid: 'a', charId: 'char-a', messageSubtype: 'chat' },
      { uuid: 'b', charId: 'char-b', messageSubtype: 'chat' },
      { uuid: 'c', charId: 'char-b', messageSubtype: 'chat' },
    ]);
    nsMock().mockRejectedValue(new Error('nope'));

    const { orphans } = await collectCloudInventory([]);

    expect(orphans.map((e) => e.charId)).toEqual(['char-b', 'char-a']);
  });

  it('不認識形狀的 credId 不當角色', async () => {
    credsMock().mockResolvedValue([
      { credId: 'global/weather' },
      { credId: '亂七八糟' },
    ]);

    const { live, orphans } = await collectCloudInventory([]);

    expect(live).toHaveLength(0);
    expect(orphans).toHaveLength(0);
  });
});

describe('小工具', () => {
  it('parseCharNamespace 只認角色命名空間', () => {
    expect(parseCharNamespace('amsg:char:char-1')).toBe('char-1');
    expect(parseCharNamespace('amsg:global')).toBeNull();
    expect(parseCharNamespace('amsg:char:')).toBeNull();
  });

  it('isEmptyEntry：四樣都沒有才算空', () => {
    const base = { charId: 'c', local: null, taskCount: 0, instantCount: 0, credPurposes: [], state: null };
    expect(isEmptyEntry(base)).toBe(true);
    expect(isEmptyEntry({ ...base, taskCount: 1 })).toBe(false);
    expect(isEmptyEntry({ ...base, state: { entryCount: 1, byteSize: 10, updatedAt: null } })).toBe(false);
    // 問不到大小（state 為 null）不等於有東西
    expect(isEmptyEntry({ ...base, state: { entryCount: 0, byteSize: 0, updatedAt: null } })).toBe(true);
  });

  it('formatCloudSize 換單位', () => {
    expect(formatCloudSize(512)).toBe('512 B');
    expect(formatCloudSize(32768)).toBe('32.0 KB');
    expect(formatCloudSize(2 * 1024 * 1024)).toBe('2.0 MB');
  });
});
