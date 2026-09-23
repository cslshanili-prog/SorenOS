import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    measureValue,
    measureStoreUsage,
    summarizeUsage,
    categoryOfStore,
    readStorageOverview,
    requestPersistentStorage,
    formatBytes,
    binaryKindOfMime,
    calibrateBreakdown,
    type DatabaseUsage,
} from './storageStats';

// fake-indexeddb 由 test-setup.ts 注入。

let dbSeq = 0;
function openTestDb(stores: string[]): Promise<IDBDatabase> {
    const name = `storage_stats_test_${dbSeq++}`;
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(name, 1);
        req.onupgradeneeded = () => {
            for (const s of stores) req.result.createObjectStore(s, { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function putAll(db: IDBDatabase, store: string, items: any[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        const os = tx.objectStore(store);
        for (const it of items) os.put(it);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

const usageOf = (stores: DatabaseUsage['stores']): DatabaseUsage => ({ stores, failed: [] });

afterEach(() => { vi.unstubAllGlobals(); });

describe('measureValue', () => {
    it('二進制走 byteLength，不被 JSON 序列化撐爆', () => {
        // 記憶宮殿的向量表：直接 JSON.stringify 會變成 {"0":0.123,"1":...} 那種巨型字符串，
        // 既慢又把數字放大好幾倍。守住「按 byteLength 算」這條。
        const vector = new Float32Array(768).fill(0.123456789);
        const m = measureValue({ id: 'v1', vector });
        expect(m.bytes).toBeGreaterThanOrEqual(768 * 4);
        expect(m.bytes).toBeLessThan(768 * 4 + 200);
    });

    it('Blob 按 MIME 分種類記帳', () => {
        const m = measureValue({
            id: 'a',
            pic: new Blob(['x'.repeat(1000)], { type: 'image/png' }),
            model: new Blob(['y'.repeat(2000)], { type: 'application/zip' }),
        });
        expect(m.binaryBytes.image).toBe(1000);
        expect(m.binaryBytes.binary).toBe(2000);
        expect(m.bytes).toBeGreaterThanOrEqual(3000);
    });

    it('中文按 UTF-8 算，不是按字符數', () => {
        const m = measureValue('好'.repeat(100));
        expect(m.bytes).toBeGreaterThanOrEqual(300);
    });

    it('循環引用不拋，退化成只算二進制那部分', () => {
        const cyclic: any = { id: 'x', blob: new Blob(['z'.repeat(500)], { type: 'image/png' }) };
        cyclic.self = cyclic;
        const m = measureValue(cyclic);
        expect(m.bytes).toBe(500);
    });
});

describe('binaryKindOfMime', () => {
    it('圖 / 聲音 / 一坨二進制分得開', () => {
        expect(binaryKindOfMime('image/webp')).toBe('image');
        expect(binaryKindOfMime('audio/mpeg')).toBe('audio');
        expect(binaryKindOfMime('application/zip')).toBe('binary');
        expect(binaryKindOfMime('')).toBe('binary');
        expect(binaryKindOfMime(undefined)).toBe('binary');
    });
});

describe('measureStoreUsage', () => {
    it('小表全量精確，不標「約」', async () => {
        const db = await openTestDb(['messages']);
        const items = Array.from({ length: 50 }, (_, i) => ({ id: i, text: 'hello world' }));
        await putAll(db, 'messages', items);

        const usage = await measureStoreUsage(db, 'messages');
        const truth = items.reduce((n, it) => n + measureValue(it).bytes, 0);
        expect(usage.count).toBe(50);
        expect(usage.estimated).toBe(false);
        expect(usage.bytes).toBe(truth);
        db.close();
    });

    it('空表回 0', async () => {
        const db = await openTestDb(['messages']);
        const usage = await measureStoreUsage(db, 'messages');
        expect(usage).toMatchObject({ bytes: 0, count: 0, estimated: false });
        db.close();
    });

    it('大表是均勻跳採，不會被「前面全是小記錄」帶偏', async () => {
        // 真實形態：早期全是純文字短消息，後期混進帶圖的大消息。
        // 用「取前 N 條」的實現在這裡會低估一個數量級 —— 這條就是釘死跳採的守衛。
        const db = await openTestDb(['messages']);
        const items = Array.from({ length: 2000 }, (_, i) => ({
            id: i,
            text: i < 1500 ? 'hi' : 'x'.repeat(2000),
        }));
        await putAll(db, 'messages', items);

        const usage = await measureStoreUsage(db, 'messages');
        const truth = items.reduce((n, it) => n + measureValue(it).bytes, 0);

        expect(usage.count).toBe(2000);
        expect(usage.estimated).toBe(true);
        expect(usage.bytes).toBeGreaterThan(truth * 0.8);
        expect(usage.bytes).toBeLessThan(truth * 1.2);
        db.close();
    });
});

describe('summarizeUsage', () => {
    it('blob_assets 按 MIME 拆開：圖片算媒體、模型算角色', () => {
        const bd = summarizeUsage([{
            usage: usageOf([{
                store: 'blob_assets',
                bytes: 1000,
                count: 2,
                estimated: false,
                binaryBytes: { image: 600, binary: 300 },
            }]),
        }]);
        expect(bd.categories.find(c => c.key === 'characters')?.bytes).toBe(300);
        expect(bd.categories.find(c => c.key === 'media')?.bytes).toBe(700);
        expect(bd.totalBytes).toBe(1000);
    });

    it('沒登記過的新表落到「其他」，總量不會漏', () => {
        const bd = summarizeUsage([{
            usage: usageOf([
                { store: 'messages', bytes: 500, count: 1, estimated: false, binaryBytes: {} },
                { store: 'brand_new_2027_feature', bytes: 300, count: 1, estimated: false, binaryBytes: {} },
            ]),
        }]);
        expect(bd.categories.find(c => c.key === 'chat')?.bytes).toBe(500);
        expect(bd.categories.find(c => c.key === 'other')?.bytes).toBe(300);
        expect(bd.totalBytes).toBe(800);
    });

    it('整庫歸類的庫（主動消息）不按表名拆', () => {
        const bd = summarizeUsage([{
            usage: usageOf([
                { store: 'inbox', bytes: 100, count: 1, estimated: false, binaryBytes: {} },
                { store: 'kv', bytes: 50, count: 1, estimated: false, binaryBytes: {} },
            ]),
            forceCategory: 'activeMsg',
        }]);
        expect(bd.categories).toHaveLength(1);
        expect(bd.categories[0]).toMatchObject({ key: 'activeMsg', bytes: 150 });
    });

    it('任一表帶估算，那一類就標「約」', () => {
        const bd = summarizeUsage([{
            usage: usageOf([
                { store: 'messages', bytes: 100, count: 1, estimated: false, binaryBytes: {} },
                { store: 'groups', bytes: 900, count: 9999, estimated: true, binaryBytes: {} },
            ]),
        }]);
        expect(bd.categories.find(c => c.key === 'chat')?.estimated).toBe(true);
    });

    it('「其他」永遠排最後，其餘按大小降序', () => {
        const bd = summarizeUsage([{
            usage: usageOf([
                { store: 'misc_store', bytes: 9999, count: 1, estimated: false, binaryBytes: {} },
                { store: 'messages', bytes: 100, count: 1, estimated: false, binaryBytes: {} },
                { store: 'characters', bytes: 200, count: 1, estimated: false, binaryBytes: {} },
            ]),
        }]);
        expect(bd.categories.map(c => c.key)).toEqual(['characters', 'chat', 'other']);
    });

    it('讀不出來的表只記名字，不打斷統計', () => {
        const bd = summarizeUsage([{
            usage: { stores: [{ store: 'messages', bytes: 100, count: 1, estimated: false, binaryBytes: {} }], failed: ['broken_store'] },
        }]);
        expect(bd.totalBytes).toBe(100);
        expect(bd.failedStores).toEqual(['broken_store']);
    });
});

describe('categoryOfStore', () => {
    it('認識的表歸位，不認識的進「其他」', () => {
        expect(categoryOfStore('messages')).toBe('chat');
        expect(categoryOfStore('memory_vectors')).toBe('memory');
        expect(categoryOfStore('gallery')).toBe('media');
        expect(categoryOfStore('characters')).toBe('characters');
        expect(categoryOfStore('bank_transactions')).toBe('other');
    });
});

describe('readStorageOverview', () => {
    it('瀏覽器不給用量信息時回 null，不拿 0 頂上', async () => {
        // 關鍵：0 會被界面顯示成「你一點數據都沒有」，比「讀不到」誤導得多。
        vi.stubGlobal('navigator', {
            storage: {
                estimate: () => Promise.reject(new Error('SecurityError')),
                persisted: () => Promise.resolve(false),
            },
        });
        const ov = await readStorageOverview();
        expect(ov.supported).toBe(false);
        expect(ov.usageBytes).toBeNull();
        expect(ov.quotaBytes).toBeNull();
        expect(ov.persisted).toBe(false);
    });

    it('完全沒有 storage API 時整體降級，不拋', async () => {
        vi.stubGlobal('navigator', {});
        const ov = await readStorageOverview();
        expect(ov).toEqual({ supported: false, usageBytes: null, quotaBytes: null, indexedDbBytes: null, persisted: null });
    });

    it('查不了持久化狀態時回 null（≠ 沒拿到許可）', async () => {
        vi.stubGlobal('navigator', { storage: { estimate: () => Promise.resolve({ usage: 1024, quota: 4096 }) } });
        const ov = await readStorageOverview();
        expect(ov).toMatchObject({ supported: true, usageBytes: 1024, quotaBytes: 4096, persisted: null });
    });
});

describe('requestPersistentStorage', () => {
    it('申請被拒回 false，不拋', async () => {
        vi.stubGlobal('navigator', { storage: { persist: () => Promise.reject(new Error('denied')) } });
        expect(await requestPersistentStorage()).toBe(false);
    });

    it('瀏覽器沒有 persist 時回 false', async () => {
        vi.stubGlobal('navigator', { storage: {} });
        expect(await requestPersistentStorage()).toBe(false);
    });

    it('拿到許可回 true', async () => {
        vi.stubGlobal('navigator', { storage: { persist: () => Promise.resolve(true) } });
        expect(await requestPersistentStorage()).toBe(true);
    });
});

describe('formatBytes', () => {
    it('讀不到的時候顯示「—」而不是 0 B', () => {
        expect(formatBytes(null)).toBe('—');
        expect(formatBytes(undefined)).toBe('—');
        expect(formatBytes(NaN)).toBe('—');
        expect(formatBytes(-1)).toBe('—');
    });

    it('按量級換單位', () => {
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(1536)).toBe('1.5 KB');
        expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
        expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.50 GB');
    });
});

describe('computeStorageBreakdown（端到端）', () => {
    it('能把主庫裡的數據歸類，且不會憑空建出別的庫', async () => {
        const { openDB } = await import('./db');
        const { computeStorageBreakdown } = await import('./storageStats');

        const db = await openDB();
        await putAll(db, 'messages', [
            { id: 'e2e-1', charId: 'c1', content: '測試消息'.repeat(20) },
            { id: 'e2e-2', charId: 'c1', content: '測試消息'.repeat(20) },
        ]);

        // ActiveMsg 這類庫在測試環境裡並不存在。統計過程只能「連已有的庫」，
        // 絕不能因為去看一眼就把空庫建出來 —— 那會給用戶平白多出髒數據。
        const namesBefore = (await indexedDB.databases()).map(d => d.name).sort();

        const progressTicks: number[] = [];
        const breakdown = await computeStorageBreakdown(p => progressTicks.push(p.done));

        const namesAfter = (await indexedDB.databases()).map(d => d.name).sort();
        expect(namesAfter).toEqual(namesBefore);

        expect(breakdown.totalBytes).toBeGreaterThan(0);
        expect(breakdown.categories.find(c => c.key === 'chat')?.bytes).toBeGreaterThan(0);
        expect(progressTicks.length).toBeGreaterThan(0);

        db.close();
    });

    it('瀏覽器不給枚舉庫列表時走兜底名單，不存在的庫看一眼就刪乾淨', async () => {
        // 走兜底路徑（Firefox 126 之前沒有 databases()）。兜底名單裡的 ActiveMsg 在這個
        // 測試環境裡並不存在 —— 不帶版本號 open 一個不存在的庫會把它憑空建出來，
        // 這裡釘死「建出來了也要刪回去」，別給用戶留一堆空庫。
        const { computeStorageBreakdown } = await import('./storageStats');
        const spy = vi.spyOn(indexedDB, 'databases').mockRejectedValue(new Error('not supported'));
        try {
            await computeStorageBreakdown();
        } finally {
            spy.mockRestore();
        }
        const names = (await indexedDB.databases()).map(d => d.name);
        expect(names).not.toContain('ActiveMsg');
    });
});

describe('calibrateBreakdown（按瀏覽器實報折算）', () => {
    // 庫裡量到 1000（文本 600 + Blob 400），瀏覽器實報 800。
    // 差的 200 只可能壓在文本上——Blob 獨立落盤不參與 LevelDB 壓縮。
    const raw = () => summarizeUsage([{
        usage: usageOf([
            { store: 'messages', bytes: 600, count: 1, estimated: false, binaryBytes: {} },
            { store: 'blob_assets', bytes: 400, count: 1, estimated: false, binaryBytes: { image: 400 } },
        ]),
    }]);

    it('高估時只縮文本，二進制一個字節不動', () => {
        const bd = calibrateBreakdown(raw(), 800);
        expect(bd.calibrated).toBe(true);
        // 文本能分 800-400=400，原本 600 → 係數 2/3
        expect(bd.categories.find(c => c.key === 'chat')?.bytes).toBe(400);
        expect(bd.categories.find(c => c.key === 'media')?.bytes).toBe(400);
        expect(bd.totalBytes).toBe(800);
    });

    it('合計對齊實報值，不再出現「細分比總量還大」', () => {
        const bd = calibrateBreakdown(raw(), 800);
        expect(bd.totalBytes).toBeLessThanOrEqual(800);
    });

    it('我們沒高估時保持原樣，差額留給「其他佔用」去交代', () => {
        const bd = calibrateBreakdown(raw(), 5000);
        expect(bd.calibrated).toBe(false);
        expect(bd.totalBytes).toBe(1000);
    });

    it('讀不到實報值（非 Chrome）就不折算', () => {
        expect(calibrateBreakdown(raw(), null).calibrated).toBe(false);
    });

    it('二進制已經撐滿實報值時不硬折（口徑對不上，寧可不動）', () => {
        const bd = calibrateBreakdown(raw(), 300);
        expect(bd.calibrated).toBe(false);
        expect(bd.totalBytes).toBe(1000);
    });

    it('純二進制的庫不折算（沒有文本可縮）', () => {
        const onlyBinary = summarizeUsage([{
            usage: usageOf([{ store: 'blob_assets', bytes: 400, count: 1, estimated: false, binaryBytes: { image: 400 } }]),
        }]);
        expect(calibrateBreakdown(onlyBinary, 300).calibrated).toBe(false);
    });
});
