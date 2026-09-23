import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DB, openDB } from './db';
import { runBlobGc, REF_SOURCE_STORES } from './blobGc';
import { putImageBlob, getBlobForRef, dataUrlToBlob } from './blobRef';

// fake-indexeddb 已由 test-setup.ts 注入。這組用例釘住孤兒 GC 的四條生死線：
//   1. 混用表守衛（最重要）：blob_assets 裡混居著 VRM 模型 / Live2D 運行時緩存 /
//      遺留陪伴語音，GC 的世界觀必須被 listBlobAssetIds 圈死在 img_ / b_ 前綴內，
//      外族 id 一根毛都不能少；
//   2. 基礎三件：老孤兒刪 / 被引用留（表行引用 + localStorage 引用）/ 新鮮留；
//   3. 安全閥：引用面枚舉拋錯 → 整輪放棄（aborted），一個不刪。
// 引用面清單見 utils/blobGc.ts 文件頭。

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const tinyBlob = () => new Blob(['x'], { type: 'application/octet-stream' });

async function clearStore(name: string): Promise<void> {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(name, 'readwrite');
        tx.objectStore(name).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function seedStore(name: string, records: any[]): Promise<void> {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(name, 'readwrite');
        const store = tx.objectStore(name);
        for (const r of records) store.put(r);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

beforeEach(async () => {
    // 每條用例都從乾淨的世界出發：blob 庫、本組會寫的引用面表、localStorage 全清，
    // 避免上一條用例的令牌 / 引用串味（GC 是全庫掃描，殘留會直接改變 deleted/kept 計數）
    for (const s of ['blob_assets', 'characters', 'songs']) {
        await clearStore(s);
    }
    localStorage.clear();
});

describe('混用表守衛（GC 的世界觀邊界）', () => {
    it('只刪 blobRef 命名空間的孤兒；同表混居的外族 id 與被引用令牌一根毛都不少', async () => {
        // 三個外族假行：VRM 模型 / Live2D 運行時緩存 / 遺留陪伴語音（與 blobRef 同表混居）
        await DB.putBlobAsset('video-avatar-1234-5678', tinyBlob());
        await DB.putBlobAsset('x:live2d-runtime-store-v1', tinyBlob());
        await DB.putBlobAsset('companion-startup-voice:y', tinyBlob());
        // 一個無引用的老孤兒（img_ 存量前綴，id 裡沒有時間戳 → GC 按「老」處理）
        await DB.putBlobAsset('img_orphan_dead', tinyBlob());
        // 一個被引用的老令牌：引用寫在 characters 表的行裡（引用面之一）
        await DB.putBlobAsset('img_alive_ref', tinyBlob());
        await seedStore('characters', [{ id: 'c1', name: '守衛用角色', avatar: 'blobref:img_alive_ref' }]);

        const result = await runBlobGc({ minAgeMs: 0 });

        expect(result.aborted).toBe(false);
        expect(result.deleted).toBe(1); // 僅那個孤兒
        expect(await DB.getBlobAsset('img_orphan_dead')).toBeNull();
        // kept 只數 img_ / b_ 命名空間：外族 id 根本不在 GC 的世界觀裡（連 kept 都不計）
        expect(result.kept).toBe(1);
        // 三個外族 id 與被引用 id 全部健在
        expect(await DB.getBlobAsset('video-avatar-1234-5678')).not.toBeNull();
        expect(await DB.getBlobAsset('x:live2d-runtime-store-v1')).not.toBeNull();
        expect(await DB.getBlobAsset('companion-startup-voice:y')).not.toBeNull();
        expect(await DB.getBlobAsset('img_alive_ref')).not.toBeNull();
    });
});

describe('GC 基礎三件', () => {
    it('老孤兒刪：img_ 前綴、無任何引用 → 被回收', async () => {
        await DB.putBlobAsset('img_orphan_dead', tinyBlob());

        const result = await runBlobGc({ minAgeMs: 0 });

        expect(result).toMatchObject({ deleted: 1, aborted: false });
        expect(await DB.getBlobAsset('img_orphan_dead')).toBeNull();
    });

    it('被引用留：songs 表行裡的令牌引用足以保住 Blob', async () => {
        await DB.putBlobAsset('img_song_cover_ref', tinyBlob());
        await seedStore('songs', [{ id: 's1', title: '封面歌', coverImage: 'blobref:img_song_cover_ref' }]);

        const result = await runBlobGc({ minAgeMs: 0 });

        expect(result).toMatchObject({ deleted: 0, aborted: false });
        expect(await DB.getBlobAsset('img_song_cover_ref')).not.toBeNull();
    });

    it('被引用留：localStorage 值裡的令牌引用足以保住 Blob', async () => {
        await DB.putBlobAsset('img_ls_backup_ref', tinyBlob());
        localStorage.setItem('acnh_wallpaper_backup', 'blobref:img_ls_backup_ref');

        const result = await runBlobGc({ minAgeMs: 0 });

        expect(result).toMatchObject({ deleted: 0, aborted: false });
        expect(await DB.getBlobAsset('img_ls_backup_ref')).not.toBeNull();
    });

    it('新鮮留：剛 put 的 b_ 令牌即使無引用，默認 72h 豁免窗口內不刪', async () => {
        // 真實鏈路生成新令牌（b_ 前綴內嵌創建時間），故意不落任何引用——
        // 模擬「已 put、引用還沒寫進持久化面」的競態窗口
        const token = await putImageBlob(dataUrlToBlob(TINY_PNG));

        const result = await runBlobGc(); // 不傳 minAgeMs：走默認 72h

        expect(result).toMatchObject({ deleted: 0, aborted: false });
        expect(await getBlobForRef(token)).not.toBeNull();
    });
});

describe('引用面分頁（跨頁不許漏 mark）', () => {
    // 此前全部用例都在單頁規模（< 200 行），分頁推進壞掉（早停、lastKey 取錯、排他邊界
    // 反了）一條都不會紅——而第 2 頁起的引用漏 mark 是刪活圖級別。這組用例把多頁釘住。
    const PAGE = 200;
    const fillerRows = (count: number) =>
        Array.from({ length: count }, (_, i) => ({ id: `c${String(i + 1).padStart(3, '0')}`, name: `填充${i + 1}` }));

    it('getStoreRowsPage 跨 3 頁每行恰好一次；恰好整頁時以空頁收尾', async () => {
        await seedStore('characters', fillerRows(450));
        const walk = async () => {
            const seen: string[] = [];
            let afterKey: IDBValidKey | null = null;
            let pages = 0;
            for (;;) {
                const { rows, lastKey } = await DB.getStoreRowsPage('characters', afterKey, PAGE);
                pages++;
                for (const r of rows) seen.push((r as { id: string }).id);
                if (lastKey === null || rows.length < PAGE) break;
                afterKey = lastKey;
            }
            return { seen, pages };
        };

        const three = await walk();
        expect(three.pages).toBe(3); // 200 + 200 + 50
        expect(three.seen.length).toBe(450);
        expect(new Set(three.seen).size).toBe(450); // 不重不漏

        // 恰好整頁（200 行）：末頁滿員時要多取一空頁收尾，同樣不重不漏
        await clearStore('characters');
        await seedStore('characters', fillerRows(PAGE));
        const exact = await walk();
        expect(exact.pages).toBe(2);
        expect(new Set(exact.seen).size).toBe(PAGE);
    });

    it('引用藏在第 3 頁的行裡也保得住，孤兒照刪', async () => {
        await DB.putBlobAsset('img_page3_ref', tinyBlob());
        await DB.putBlobAsset('img_orphan_dead', tinyBlob());
        const rows: any[] = fillerRows(449);
        rows.push({ id: 'c450', name: '第三頁引用', avatar: 'blobref:img_page3_ref' });
        await seedStore('characters', rows);

        const result = await runBlobGc({ minAgeMs: 0 });

        expect(result).toMatchObject({ deleted: 1, aborted: false });
        expect(await DB.getBlobAsset('img_page3_ref')).not.toBeNull();
        expect(await DB.getBlobAsset('img_orphan_dead')).toBeNull();
    });
});

describe('引用面清單拼寫守衛', () => {
    it('REF_SOURCE_STORES 裡的每個名字都必須是真實存在的 object store', async () => {
        // 名字寫錯時 getStoreRowsPage 的 contains 兜底會靜默返回空頁——那個面等於沒掃、
        // 無任何報錯，面上獨佔引用的圖會被當孤兒刪掉。這裡把拼寫與真實 schema 釘死。
        const db = await openDB();
        const existing = Array.from(db.objectStoreNames);
        for (const name of REF_SOURCE_STORES) {
            expect(existing).toContain(name);
        }
    });
});

describe('安全閥', () => {
    it('引用面枚舉拋錯 → aborted:true 且一個不刪', async () => {
        await DB.putBlobAsset('img_orphan_dead', tinyBlob());
        // 把表面枚舉搞壞（走 runBlobGc 的真實鏈路，而非直接對 blobStore.gc 造假源）
        const spy = vi.spyOn(DB, 'getStoreRowsPage').mockRejectedValue(new Error('枚舉炸了'));
        try {
            const result = await runBlobGc({ minAgeMs: 0 });
            expect(result.aborted).toBe(true);
            expect(result.deleted).toBe(0);
            // 出錯時孤兒也必須原地不動——寧可留孤兒，絕不在信息不全時刪圖
            expect(await DB.getBlobAsset('img_orphan_dead')).not.toBeNull();
        } finally {
            spy.mockRestore();
        }
    });
});
