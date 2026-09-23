import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addUploadedCompanionOutfit } from './companionWardrobe';

// 外觀設置裡換 / 移除「桌面陪伴形象」時，會把舊令牌對應的 Blob 刪掉。
//
// 可這個令牌通常不止頂層 imageRef 一處在用：衣櫃（companionAvatar.imageWardrobe）會把
// 「現在穿的這套」原樣固化成一條條目，令牌同時佔著條目的 id 和 imageRef 兩個值位
// （utils/companionWardrobe.ts）。「優化資源存儲」的遷移也刻意讓頂層與衣櫃條目轉成同一個令牌。
//
// 所以無條件刪舊令牌 = 換一次形象，衣櫃裡那套舊衣服就永久裂圖，再也切不回去穿。

const source = readFileSync(path.resolve(__dirname, '../apps/Appearance.tsx'), 'utf8');

const outfit = (ref: string, fileName: string, importedAt: number) => ({
    id: ref, imageRef: ref, fileName, mimeType: 'image/png', importedAt,
});

describe('衣櫃確實跟頂層 imageRef 共用令牌', () => {
    it('導入一套，衣櫃裡就留下一條同令牌的條目', () => {
        const ref = 'blobref:b_outfit_a';
        const config = addUploadedCompanionOutfit(undefined, outfit(ref, '連衣裙.png', 1));

        expect(config.imageRef).toBe(ref);
        expect(config.imageWardrobe?.map(item => item.imageRef)).toEqual([ref]);
        expect(config.imageWardrobe?.map(item => item.id)).toEqual([ref]);
    });

    it('換穿新的一套之後，上一套仍留在衣櫃裡等著切回去', () => {
        const first = 'blobref:b_outfit_a';
        const second = 'blobref:b_outfit_b';
        const afterFirst = addUploadedCompanionOutfit(undefined, outfit(first, '連衣裙.png', 1));
        const afterSecond = addUploadedCompanionOutfit(afterFirst, outfit(second, '毛衣.png', 2));

        expect(afterSecond.imageRef).toBe(second);
        // 頂層已經不指著 first 了，但衣櫃還指著 —— 這時候刪 first 的 Blob 就是破圖
        expect(afterSecond.imageWardrobe?.map(item => item.imageRef)).toEqual([first, second]);
    });
});

describe('換 / 移除桌面静态形象前先問一句衣櫃', () => {
    it('守衛認 imageRef 與 id 兩個值位，非數組的老數據也頂得住', () => {
        expect(source).toContain('const isCompanionOutfitKeptInWardrobe');
        expect(source).toContain('if (!Array.isArray(wardrobe)) return false;');
        expect(source).toContain('outfit?.imageRef === ref || outfit?.id === ref');
    });

    it('兩處 deleteBlobRef(previousRef) 都被守衛攔著', () => {
        const calls = [...source.matchAll(/deleteBlobRef\(previousRef\)/g)];
        // 換圖（handleCompanionPortraitUpload）與移除（removeCompanionUpload）各一處
        expect(calls).toHaveLength(2);
        for (const call of calls) {
            const before = source.slice(Math.max(0, call.index - 300), call.index);
            expect(before).toContain('!isCompanionOutfitKeptInWardrobe(');
        }
    });

    it('舊的無條件裸刪寫法不再存在', () => {
        expect(source).not.toMatch(/if \(previousRef && previousRef !== imageRef\) await deleteBlobRef\(previousRef\);/);
        expect(source).not.toMatch(/\n\s*await deleteBlobRef\(previousRef\);\s*\n\s*trackEvent/);
    });
});
