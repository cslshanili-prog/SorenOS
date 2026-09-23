import { describe, it, expect, beforeEach } from 'vitest';
import { DB, openDB } from './db';

// 捏臉自定義部件（cc_custom_parts）的備份往返回歸。
//
// 部件 src/shadowSrc 是 data:image，media/full 導出時會被 extractImagesInPlace 抽進 zip，
// JSON 裡只留 assets/*.png 路徑。導入必須經 importFullData 的 beforeWrite 鉤子把路徑還原回
// base64。歷史 bug：這一節 clearAndAdd 把 restoreAssets 傳成 false → beforeWrite 早退不還原，
// 導入回來部件圖裂成 assets/*.png 死鏈。此用例釘死「導入會對 cc 部件調用資產還原」。

async function seedStore(name: string, records: any[]): Promise<void> {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(name, 'readwrite');
        const store = tx.objectStore(name);
        store.clear();
        for (const r of records) store.put(r);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

beforeEach(async () => {
    await seedStore('cc_custom_parts', []);
});

describe('cc_custom_parts 備份往返：圖片資產還原', () => {
    it('導入時對部件調用 beforeWrite（restoreAssets=true），路徑還原回 base64', async () => {
        // 模擬導出後的形態：src/shadowSrc 已被抽成 zip 路徑（assets/*.png）
        const backupParts = [
            { id: 'fronthair_cc_1', categoryKey: 'fronthair', name: '雲朵', tintable: true,
              src: 'assets/asset_1.png', shadowSrc: 'assets/asset_2.png', createdAt: 1 },
            { id: 'decor_cc_2', categoryKey: 'decor', name: '星星', tintable: false,
              src: 'assets/asset_3.png', createdAt: 2 },
        ];

        // beforeWrite 模擬 restoreAssetsInPlace：把 assets/*.png 路徑換回 data:image。
        // 只有 restoreAssets=true 的 section 才會觸發它——這正是迴歸點。
        const restored: string[] = [];
        const beforeWrite = async (root: any) => {
            const walk = (o: any) => {
                if (!o || typeof o !== 'object') return;
                for (const k of Object.keys(o)) {
                    const v = o[k];
                    if (typeof v === 'string' && v.startsWith('assets/')) {
                        restored.push(v);
                        o[k] = `data:image/png;base64,RESTORED(${v})`;
                    } else if (v && typeof v === 'object') walk(v);
                }
            };
            walk(root);
        };

        await DB.importFullData({ customCreatorParts: backupParts } as any, { beforeWrite } as any);

        // beforeWrite 被調到了，三張圖路徑都被還原（bug 版本：restored 為空）
        expect(restored.sort()).toEqual(['assets/asset_1.png', 'assets/asset_2.png', 'assets/asset_3.png']);

        // 落庫的部件 src/shadowSrc 已是 data:image，不再是死鏈路徑
        const stored = (await DB.getRawStoreData('cc_custom_parts')).sort((a: any, b: any) => a.createdAt - b.createdAt);
        expect(stored).toHaveLength(2);
        expect(stored[0].src).toContain('data:image/png;base64,RESTORED(assets/asset_1.png)');
        expect(stored[0].shadowSrc).toContain('data:image/png;base64,RESTORED(assets/asset_2.png)');
        expect(stored[1].src).toContain('data:image/png;base64,RESTORED(assets/asset_3.png)');
        expect(stored.some((p: any) => typeof p.src === 'string' && p.src.startsWith('assets/'))).toBe(false);
    });
});
