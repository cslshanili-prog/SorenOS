// utils/memoryPalace/plateMutex.test.ts
//
// 迴歸守衛（門牌的「讀一份 → 改 → 整塊存回去」必須排隊）。
//
// 門牌是整塊對象存回去的形狀，而動它的路有四條，彼此完全不知道對方存在：雲端整理結果
// 落地、本地整理落庫、送達保證兜底併入、門牌面板上用戶手改。任意兩條撞在一起就是後寫
// 的把先寫的整塊蓋掉——用戶剛敲的字沒了，或者一整輪整理的成果沒了，而兩邊日誌都顯示
// 成功。各自在自己那條路里排隊是不夠的（面板原先就是這麼做的），隊伍必須是**按門牌**
// 的一條，所有路共用。
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 假門牌庫：底層是 IndexedDB，node 上沒有。排隊邏輯（本文件要測的）原樣跑真身。 */
const store = new Map<string, any>();

describe('mutatePlate — 同一塊門牌上的改動排隊走', () => {
  let mutatePlate: typeof import('./db').mutatePlate;
  let RoomPlateDB: typeof import('./db').RoomPlateDB;

  beforeEach(async () => {
    vi.resetModules();
    store.clear();
    const db = await import('./db');
    mutatePlate = db.mutatePlate;
    RoomPlateDB = db.RoomPlateDB;
    // 讀寫換成內存版 + 一拍延遲：不延遲的話兩條路根本撞不上，測試永遠綠。
    vi.spyOn(RoomPlateDB, 'get').mockImplementation(async (charId, room) => {
      await new Promise((r) => setTimeout(r, 5));
      return store.get(`${charId}:${room}`);
    });
    vi.spyOn(RoomPlateDB, 'save').mockImplementation(async (plate) => {
      await new Promise((r) => setTimeout(r, 5));
      store.set(plate.id, plate);
    });
  });

  // 這條是整件事的意義所在：兩條路同時改一塊門牌會怎樣。
  it('兩條路同時改同一塊門牌 → 一前一後，誰的改動都不會被整塊蓋掉', async () => {
    store.set('c1:user_room', {
      id: 'c1:user_room', charId: 'c1', room: 'user_room',
      entries: [{ id: 'e0', text: '原有', firstLearnedAt: 1, updatedAt: 1, sourceCount: 1 }],
      updatedAt: 1, version: 1,
    });

    // 一條是「雲端整理結果落地」，一條是「用戶在面板上手改」。誰先誰後不重要，
    // 重要的是後跑那條**看得見**先跑那條的結果。
    await Promise.all([
      mutatePlate('c1', 'user_room', (p) => ({
        ...p, entries: [...p.entries, { id: 'e1', text: '雲端整理加的', firstLearnedAt: 2, updatedAt: 2, sourceCount: 1 }],
        version: p.version + 1,
      })),
      mutatePlate('c1', 'user_room', (p) => ({
        ...p, entries: [...p.entries, { id: 'e2', text: '用戶手改加的', firstLearnedAt: 2, updatedAt: 2, sourceCount: 1 }],
        version: p.version + 1,
      })),
    ]);

    const final = store.get('c1:user_room');
    expect(final.entries.map((e: any) => e.id).sort(), '併發就是後寫的整塊蓋掉先寫的').toEqual(['e0', 'e1', 'e2']);
    expect(final.version, '版本號兩次都要跳').toBe(3);
  });

  // 不同門牌之間沒有任何共享狀態，排在一起只是白白變慢。
  it('不同門牌各排各的，不互相堵', async () => {
    const order: string[] = [];
    await Promise.all([
      mutatePlate('c1', 'user_room', (p) => { order.push('a'); return { ...p, version: p.version + 1 }; }),
      mutatePlate('c1', 'study', (p) => { order.push('b'); return { ...p, version: p.version + 1 }; }),
    ]);
    expect(order).toHaveLength(2);
    expect(store.has('c1:user_room')).toBe(true);
    expect(store.has('c1:study')).toBe(true);
  });

  it('change 回 null（不用改）→ 不落庫，也不佔著隊不放', async () => {
    const saved = await mutatePlate('c1', 'user_room', () => null);

    expect(saved).toBeNull();
    expect(RoomPlateDB.save).not.toHaveBeenCalled();
    // 後面的照常排得上
    await expect(mutatePlate('c1', 'user_room', (p) => ({ ...p, version: 9 }))).resolves.toMatchObject({ version: 9 });
  });

  // 一次落庫失敗不能把這塊門牌的隊伍掐斷——後面每一次都排不上的話，整理結果和用戶的
  // 手改會一起卡死，而卡住的原因（一次 IDB 抖動）早就過去了。
  it('一次落庫炸了 → 照常拋給調用方，但不把後面的堵死', async () => {
    vi.mocked(RoomPlateDB.save).mockRejectedValueOnce(new Error('IDB 配額滿了'));

    await expect(mutatePlate('c1', 'user_room', (p) => ({ ...p, version: 1 }))).rejects.toThrow('IDB 配額滿了');
    await expect(mutatePlate('c1', 'user_room', (p) => ({ ...p, version: 2 }))).resolves.toMatchObject({ version: 2 });
  });
});
