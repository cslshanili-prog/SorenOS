import { describe, it, expect } from 'vitest';
import {
    isBlobRef, BLOBREF_PREFIX,
    putImageBlob, getBlobForRef, deleteBlobRef, deleteBlobRefIfUnreferenced,
    dataUrlToBlob, blobToDataUrl,
    migrateDataUrlToRef, migrateAppearancePresetBlobRefs, resolveBlobRefsDeep,
} from './blobRef';
import { DB, openDB } from './db';

// fake-indexeddb 已由 test-setup.ts 注入；本組用例鎖住 base64 ⇄ Blob 遷移層的核心不變量：
// 令牌識別、Blob 存取、data URL 互轉無損、深度解析（備份導出前把令牌變回 data:image）。

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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

async function clearStore(name: string): Promise<void> {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(name, 'readwrite');
        tx.objectStore(name).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

describe('isBlobRef', () => {
    it('只認 blobref: 前綴，data:/http/空 都不是', () => {
        expect(isBlobRef(BLOBREF_PREFIX + 'x')).toBe(true);
        expect(isBlobRef('data:image/png;base64,AAAA')).toBe(false);
        expect(isBlobRef('https://a.com/b.png')).toBe(false);
        expect(isBlobRef('')).toBe(false);
        expect(isBlobRef(undefined)).toBe(false);
        expect(isBlobRef(null)).toBe(false);
    });
});

describe('dataUrl ⇄ Blob 無損互轉', () => {
    it('dataUrlToBlob 保留 mime 與字節', async () => {
        const blob = dataUrlToBlob(TINY_PNG);
        expect(blob.type).toBe('image/png');
        expect(blob.size).toBeGreaterThan(0);
        // 再轉回 data URL 應與原串一致
        const back = await blobToDataUrl(blob);
        expect(back).toBe(TINY_PNG);
    });
});

describe('putImageBlob / getBlobForRef / deleteBlobRef', () => {
    it('存進去能按令牌取回同樣字節，刪除後取不到', async () => {
        const blob = dataUrlToBlob(TINY_PNG);
        const ref = await putImageBlob(blob);
        expect(isBlobRef(ref)).toBe(true);

        const got = await getBlobForRef(ref);
        expect(got).not.toBeNull();
        expect(await blobToDataUrl(got!)).toBe(TINY_PNG);

        await deleteBlobRef(ref);
        expect(await getBlobForRef(ref)).toBeNull();
    });

    it('非令牌一律返回 null', async () => {
        expect(await getBlobForRef('data:image/png;base64,AAAA')).toBeNull();
        expect(await getBlobForRef('https://x/y.png')).toBeNull();
    });
});

describe('deleteBlobRefIfUnreferenced', () => {
    it('外觀預設仍引用時保留，引用移除後才刪除', async () => {
        const ref = await putImageBlob(dataUrlToBlob(TINY_PNG));
        await DB.saveAsset('appearance_preset_blobref_test', JSON.stringify({ wallpaper: ref }));

        expect(await deleteBlobRefIfUnreferenced(ref)).toBe(false);
        expect(await getBlobForRef(ref)).not.toBeNull();

        await DB.deleteAsset('appearance_preset_blobref_test');
        expect(await deleteBlobRefIfUnreferenced(ref)).toBe(true);
        expect(await getBlobForRef(ref)).toBeNull();
    });

    it('localStorage 皮膚備份仍引用時不會刪除', async () => {
        const ref = await putImageBlob(dataUrlToBlob(TINY_PNG));
        localStorage.setItem('acnh_wallpaper_backup_test', ref);

        expect(await deleteBlobRefIfUnreferenced(ref)).toBe(false);
        expect(await getBlobForRef(ref)).not.toBeNull();

        localStorage.removeItem('acnh_wallpaper_backup_test');
        expect(await deleteBlobRefIfUnreferenced(ref)).toBe(true);
    });

    // 內容去重（utils/blobDedupe.ts）會把同一張圖在十幾個引用面上收斂成同一個令牌，
    // 於是「壁紙」和「發過的聊天圖 / 相冊 / 角色頭像」很可能是同一個令牌。
    // 只查 assets + localStorage 的話，換壁紙就會把還被別處用著的圖刪掉。
    it.each([
        ['聊天記錄', 'messages', { id: 9001, type: 'image', content: '<REF>' }],
        ['相冊', 'gallery', { id: 'g_blobref_test', url: '<REF>' }],
        ['角色頭像', 'characters', { id: 'c_blobref_test', name: '小明', avatar: '<REF>' }],
        ['角色小屋傢俱', 'characters', {
            id: 'c_blobref_room_test', name: '小明',
            roomConfig: { items: [{ id: 'i1', image: '<REF>' }] },
        }],
    ])('令牌只被%s引用時不刪，那一面清掉後才刪', async (_面, storeName, row) => {
        const ref = await putImageBlob(dataUrlToBlob(TINY_PNG));
        await seedStore(storeName, [JSON.parse(JSON.stringify(row).replaceAll('<REF>', ref))]);

        try {
            expect(await deleteBlobRefIfUnreferenced(ref)).toBe(false);
            expect(await getBlobForRef(ref)).not.toBeNull();
        } finally {
            await clearStore(storeName);
        }

        expect(await deleteBlobRefIfUnreferenced(ref)).toBe(true);
        expect(await getBlobForRef(ref)).toBeNull();
    });
});

describe('migrateDataUrlToRef', () => {
    it('data: 遷移成令牌，且能取回原圖', async () => {
        const ref = await migrateDataUrlToRef(TINY_PNG);
        expect(isBlobRef(ref)).toBe(true);
        const blob = await getBlobForRef(ref);
        expect(await blobToDataUrl(blob!)).toBe(TINY_PNG);
    });

    it('非法 data URL 遷移失敗時原樣返回，不拋錯、不丟值', async () => {
        const bad = 'not-a-data-url';
        expect(await migrateDataUrlToRef(bad)).toBe(bad);
    });
});

describe('migrateAppearancePresetBlobRefs', () => {
    it('導入時立即遷移壁紙、鎖屏和自定義圖標，並複用相同圖片 Blob', async () => {
        const source: any = {
            id: 'preset_import_test',
            name: '導入測試',
            createdAt: 1,
            theme: {
                hue: 88,
                saturation: 14,
                lightness: 46,
                wallpaper: TINY_PNG,
                lockWallpaper: TINY_PNG,
                darkMode: false,
            },
            customIcons: { chat: TINY_PNG },
        };

        const migrated = await migrateAppearancePresetBlobRefs(source);
        expect(isBlobRef(migrated.theme.wallpaper)).toBe(true);
        expect(migrated.theme.lockWallpaper).toBe(migrated.theme.wallpaper);
        expect(migrated.customIcons?.chat).toBe(migrated.theme.wallpaper);
        expect(await blobToDataUrl((await getBlobForRef(migrated.theme.wallpaper))!)).toBe(TINY_PNG);
        expect(source.theme.wallpaper).toBe(TINY_PNG);
    });
});

describe('resolveBlobRefsDeep（備份導出前令牌 → data:image）', () => {
    it('深度遍歷把令牌就地換回 data URL，非令牌不動', async () => {
        const refA = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const refB = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const tree: any = {
            wallImage: refA,
            keep: 'https://x/y.png',
            gradient: 'linear-gradient(#fff,#000)',
            nested: { items: [{ image: refB }, { image: 'data:image/png;base64,AAAA' }] },
        };
        await resolveBlobRefsDeep(tree);
        expect(tree.wallImage).toBe(TINY_PNG);
        expect(tree.nested.items[0].image).toBe(TINY_PNG);
        // 非令牌保持原樣
        expect(tree.keep).toBe('https://x/y.png');
        expect(tree.gradient).toBe('linear-gradient(#fff,#000)');
        expect(tree.nested.items[1].image).toBe('data:image/png;base64,AAAA');
    });

    it('令牌對應的 Blob 已不存在時置空串（圖已丟，避免導出死令牌）', async () => {
        const ref = await putImageBlob(dataUrlToBlob(TINY_PNG));
        await deleteBlobRef(ref);
        const tree: any = { a: ref };
        await resolveBlobRefsDeep(tree);
        expect(tree.a).toBe('');
    });
});
