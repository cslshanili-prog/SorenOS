import { describe, it, expect, beforeEach } from 'vitest';
import { DB, openDB } from './db';

// fake-indexeddb 已通過 test-setup.ts 注入。
// 這組用例鎖住 #1「游標分批讀」(getStoreDataChunked) 的契約：分批讀出的結果集必須與
// getRawStoreData 的整表 getAll 完全一致（條數、順序、內容），且回調可以是 async、批邊界
// 不漏不重。這是給 v2 流式導出當地基的迴歸守衛——讀法換了但數據一條都不能少。

// gallery store keyPath 'id'，直接拿 raw 事務塞數據，避開上層方法的額外語義。
async function seedGallery(records: any[]): Promise<void> {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('gallery', 'readwrite');
        const store = tx.objectStore('gallery');
        store.clear();
        for (const r of records) store.put(r);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function collectChunked(storeName: string, batchSize?: number): Promise<any[]> {
    const out: any[] = [];
    await DB.getStoreDataChunked(storeName, batch => { out.push(...batch); }, batchSize);
    return out;
}

beforeEach(async () => {
    await seedGallery([]);
});

describe('getStoreDataChunked（游標分批讀）', () => {
    it('結果集與 getRawStoreData 的 getAll 完全一致（條數/順序/內容）', async () => {
        // 亂序寫入，驗證兩種讀法都按主鍵升序、彼此一致
        const ids = [37, 5, 128, 1, 999, 64, 2, 500, 88, 7];
        await seedGallery(ids.map(id => ({ id, url: `img_${id}`, tag: id % 2 ? 'odd' : 'even' })));

        const viaGetAll = await DB.getRawStoreData('gallery');
        const viaCursor = await collectChunked('gallery', 4); // batchSize < 總數，強制多批

        expect(viaCursor).toHaveLength(viaGetAll.length);
        expect(viaCursor).toEqual(viaGetAll); // 逐條深比，順序也必須一致
        // 主鍵升序：1,2,5,7,37,...
        expect(viaCursor.map((r: any) => r.id)).toEqual([1, 2, 5, 7, 37, 64, 88, 128, 500, 999]);
    });

    it('空表：onBatch 一次都不調，正常結束', async () => {
        let calls = 0;
        await DB.getStoreDataChunked('gallery', () => { calls++; });
        expect(calls).toBe(0);
    });

    it('批邊界：總數正好是 batchSize 整數倍，不漏不重不多跑空批', async () => {
        await seedGallery(Array.from({ length: 200 }, (_, i) => ({ id: i + 1, url: `u${i}` })));
        const batches: number[] = [];
        await DB.getStoreDataChunked('gallery', batch => { batches.push(batch.length); }, 50);
        // 200 / 50 = 4 個滿批，不該多出一個空批
        expect(batches).toEqual([50, 50, 50, 50]);
        const all = await collectChunked('gallery', 50);
        expect(all).toHaveLength(200);
        expect(new Set(all.map((r: any) => r.id)).size).toBe(200); // 無重複
    });

    it('batchSize 大於總數：一批讀完', async () => {
        await seedGallery(Array.from({ length: 30 }, (_, i) => ({ id: i + 1 })));
        const batches: number[] = [];
        await DB.getStoreDataChunked('gallery', batch => { batches.push(batch.length); }, 200);
        expect(batches).toEqual([30]);
    });

    it('回調是 async（中途 await 讓出主線程）也不丟數據、不報事務失活', async () => {
        await seedGallery(Array.from({ length: 120 }, (_, i) => ({ id: i + 1, url: `u${i}` })));
        const out: any[] = [];
        await DB.getStoreDataChunked('gallery', async batch => {
            await new Promise(r => setTimeout(r, 0)); // 跨過事務自動提交點
            out.push(...batch);
        }, 40);
        expect(out).toHaveLength(120);
        expect(out.map((r: any) => r.id)).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
    });

    it('store 不存在：直接返回，不拋錯', async () => {
        await expect(
            DB.getStoreDataChunked('__nonexistent_store__', () => { throw new Error('不該被調用'); })
        ).resolves.toBeUndefined();
    });
});

describe('streamRawStoreData（單事務逐條讀）', () => {
    it('結果與 getAll 完全一致，並保持主鍵順序', async () => {
        await seedGallery([9, 2, 7, 1].map(id => ({ id, url: `img_${id}` })));
        const expected = await DB.getRawStoreData('gallery');
        const actual: any[] = [];
        await DB.streamRawStoreData('gallery', item => actual.push(item));
        expect(actual).toEqual(expected);
        expect(actual.map(item => item.id)).toEqual([1, 2, 7, 9]);
    });

    it('掃描期間發起的寫事務會等快照讀完，新記錄不會混進本次導出', async () => {
        await seedGallery(Array.from({ length: 20 }, (_, i) => ({ id: i + 1, url: `u${i}` })));
        const seen: number[] = [];
        let queuedWrite: Promise<void> | undefined;
        await DB.streamRawStoreData('gallery', (item) => {
            seen.push(item.id);
            if (!queuedWrite) {
                queuedWrite = (async () => {
                    const db = await openDB();
                    await new Promise<void>((resolve, reject) => {
                        const tx = db.transaction('gallery', 'readwrite');
                        tx.objectStore('gallery').put({ id: 999, url: 'late' });
                        tx.oncomplete = () => resolve();
                        tx.onerror = () => reject(tx.error);
                    });
                })();
            }
        });
        await queuedWrite;

        expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
        expect((await DB.getRawStoreData('gallery')).map(item => item.id)).toContain(999);
    });

    it('同步消費回調報錯會中止事務並把原錯誤拋回調用方', async () => {
        await seedGallery([{ id: 1 }, { id: 2 }]);
        await expect(DB.streamRawStoreData('gallery', item => {
            if (item.id === 2) throw new Error('serialize failed');
        })).rejects.toThrow('serialize failed');
    });

    it('store 不存在時直接返回', async () => {
        await expect(DB.streamRawStoreData('__nonexistent_store__', () => {
            throw new Error('不該被調用');
        })).resolves.toBeUndefined();
    });
});
