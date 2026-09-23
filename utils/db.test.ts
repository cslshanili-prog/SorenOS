import { describe, it, expect, vi } from 'vitest';
import { DB, openDB } from './db';

// fake-indexeddb 已通過 test-setup.ts 注入。這組用例鎖住「單例連接複用」這條修復:
// 修復前 openDB 每次調用都 indexedDB.open() 新開一條連接 (a !== b, 且每個 DB 操作
// 都觸發一次 open) —— 在記憶管線併發下堆出幾十條連接撐爆 backing store。修復後複用
// 同一條連接。

describe('openDB 單例連接複用', () => {
  it('多次 openDB 返回同一條連接 (不再每次新開)', async () => {
    const a = await openDB();
    const b = await openDB();
    expect(a).toBe(b);
  });

  it('連續 DB 操作複用已緩存連接, 不再觸發新的 indexedDB.open', async () => {
    await openDB(); // 確保單例已建立 (冪等)
    const openSpy = vi.spyOn(indexedDB, 'open');
    try {
      await DB.getAllCharacters();
      await DB.getAllCharacters();
      await DB.getAllCharacters();
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }
  });
});

// 單例只解決「複用」, 還得保證連接被外部失效後能自愈, 否則下次拿到的還是死連接。
// 這裡直接觸發掛在連接上的 onversionchange / onclose 回調, 驗證緩存被清、下次 openDB 重開。
describe('openDB 失效自愈', () => {
  it('onversionchange 觸發後 close 讓位並清緩存, 下次 openDB 重開新連接', async () => {
    const a = await openDB();
    // 模擬另一個 tab 升級版本時瀏覽器派發的 versionchange
    (a as unknown as { onversionchange?: (e: Event) => void }).onversionchange?.(new Event('versionchange'));
    const b = await openDB();
    expect(b).not.toBe(a);
  });

  it('onclose 觸發後清緩存, 下次 openDB 重開新連接', async () => {
    const a = await openDB();
    // 真實場景: 瀏覽器是先強制關閉連接、再 fire close 事件。先 close(a) 讓 fake-indexeddb
    // 進入"連接已關"的真實狀態 (否則 a 會作為一條開著的孤兒連接殘留, 拖累後面的刪庫),
    // 再手動觸發我們掛的 onclose 處理器 (它只負責清緩存, 不負責關連接)。
    a.close();
    (a as unknown as { onclose?: (e: Event) => void }).onclose?.(new Event('close'));
    const b = await openDB();
    expect(b).not.toBe(a);
  });

  it('陳舊連接遲到的 onclose 不誤清已重開的新單例 (=== promise 守衛)', async () => {
    const a = await openDB();
    // 重開: 觸發 a 的 onversionchange (會 close a + 清緩存), 再 openDB 拿到新單例 b
    (a as unknown as { onversionchange?: (e: Event) => void }).onversionchange?.(new Event('versionchange'));
    const b = await openDB();
    expect(b).not.toBe(a);
    // 此刻才遲到觸發 a (陳舊連接) 的 onclose —— 不帶守衛會把 b 誤清成 null，
    // 下次 openDB 憑空多開一條連接 (正是本次要消滅的 churn)。帶守衛則 b 保留。
    (a as unknown as { onclose?: (e: Event) => void }).onclose?.(new Event('close'));
    const c = await openDB();
    expect(c).toBe(b);
  });
});

// 現有版本高於當前 build 的 DB_VERSION 時 (用戶先跑過更新的 build / 另一 tab 升過級 /
// SW 緩存了更新的 bundle), 帶 DB_VERSION 打開會拋 VersionError —— 舊邏輯直接 reject,
// 整個 origin 的 IndexedDB 全掛 (SYSTEM ERROR、美化讀不出來、線下進不去)。修復後回退到
// 「不帶版本號打開」, 連到現有更高版本 (store 是超集, 讀寫兼容)。
describe('openDB 版本回退 (現有版本高於當前 build)', () => {
  it('遇到 VersionError 時不帶版本號回退打開, 不再整庫報錯', async () => {
    await DB.deleteDB(); // 復位 + 清掉單例連接

    // 裸開一條「比 DB_VERSION 更高」的連接建庫後關閉, 製造現有版本偏高的現場
    const hi = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('AetherOS_Data', 999);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    hi.close();

    // openDB 帶 DB_VERSION(<999) 打開 → VersionError → 回退到不帶版本號 → 連到 v999
    const db = await openDB();
    expect(db).toBeTruthy();
    expect(db.version).toBe(999);

    await DB.deleteDB(); // 收尾, 避免汙染後續用例
  });
});

describe('DB.deleteDB', () => {
  it('刪庫前先關掉單例連接, 不被本頁自己的連接 block', async () => {
    await openDB(); // 建立單例連接
    // 修復前: 單例連接一直開著 → deleteDatabase 被 onblocked 卡住, 這裡會 hang/超時。
    // 修復後: deleteDB 先 close 單例再刪, 正常 resolve。
    await expect(DB.deleteDB()).resolves.toBeUndefined();
  });
});

// blocked-then-unblocked 連接洩漏: onblocked 先 reject, 但底層 open request 還活著 ——
// 佔用方關閉後 onsuccess 仍會觸發。修復前那條遲到的連接沒人持有也沒緩存, 開著會 block
// 後續升級/刪庫; 修復後 settled 守衛讓它被 close。這裡復現整條鏈路, 用「事後 deleteDatabase
// 不被 block」來證明孤兒連接確實被關掉了。
describe('openDB blocked-then-unblocked 不洩漏連接', () => {
  it('佔用方關閉後遲到的 onsuccess 關掉孤兒連接, 不 block 後續刪庫', async () => {
    await DB.deleteDB(); // 復位到 version 0, 讓下面能從低版本起步

    // 一條 raw 連接佔住 v50 且不掛 onversionchange (模擬不肯讓位的舊 tab)
    const blocker = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('AetherOS_Data', 50);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });

    // openDB 要升到 DB_VERSION(51) → 被 blocker 擋住 → reject
    await expect(openDB()).rejects.toBeTruthy();

    // 放行: 關掉 blocker, 那條掛起的 51-open 會走完 onsuccess (此時 settled=true → 應 close)
    blocker.close();
    await new Promise((r) => setTimeout(r, 50)); // 等事件隊列把 onsuccess 跑掉

    // 若孤兒連接沒被關, 這裡 deleteDatabase 會觸發 onblocked → reject; 關掉了則正常 resolve
    await expect(new Promise<void>((resolve, reject) => {
      const del = indexedDB.deleteDatabase('AetherOS_Data');
      del.onsuccess = () => resolve();
      del.onerror = () => reject(del.error);
      del.onblocked = () => reject(new Error('deleteDatabase 被 block —— 有孤兒連接沒關閉'));
    })).resolves.toBeUndefined();
  });
});
