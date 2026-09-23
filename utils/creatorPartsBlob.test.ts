import { describe, it, expect } from 'vitest';
import { DB } from './db';
import { isBlobRef } from './blobRef';
import { creatorPartToBlobRefs, loadCreatorPartsForRender } from './creatorPartsBlob';
import type { CustomCreatorPart } from '../types';

// 捏人器自定義部件 base64 ⇄ Blob 橋：落庫轉令牌、讀出轉回 base64、存量惰性遷移。

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('creatorPartToBlobRefs（落庫轉令牌）', () => {
    it('base64 的 src / shadowSrc 轉成 blobref 令牌，其它字段不動', async () => {
        const part: CustomCreatorPart = {
            id: 'fronthair_cc_test1', categoryKey: 'fronthair', name: '測試前發',
            src: TINY_PNG, shadowSrc: TINY_PNG, tintable: true, createdAt: 123,
        };
        const stored = await creatorPartToBlobRefs(part);
        expect(isBlobRef(stored.src)).toBe(true);
        expect(isBlobRef(stored.shadowSrc!)).toBe(true);
        expect(stored.id).toBe('fronthair_cc_test1');
        expect(stored.tintable).toBe(true);
        expect(stored.categoryKey).toBe('fronthair');
    });

    it('http / 已是令牌的值原樣保留', async () => {
        const part: CustomCreatorPart = {
            id: 'x', categoryKey: 'skin', name: 's', src: 'https://a.com/b.png', createdAt: 0,
        };
        const stored = await creatorPartToBlobRefs(part);
        expect(stored.src).toBe('https://a.com/b.png');
    });
});

describe('loadCreatorPartsForRender（讀出轉回 base64 + 存量遷移）', () => {
    it('庫裡存令牌 → 讀出解析成 base64；存量 data: 惰性遷移成令牌', async () => {
        // 先塞一個「令牌形態」的部件
        const stored = await creatorPartToBlobRefs({
            id: 'eyes_cc_a', categoryKey: 'eyes', name: '眼', src: TINY_PNG, createdAt: 1,
        });
        await DB.saveCustomCreatorPart(stored);
        // 再塞一個「存量 base64 形態」的舊部件
        await DB.saveCustomCreatorPart({
            id: 'mouth_cc_b', categoryKey: 'mouth', name: '嘴', src: TINY_PNG, createdAt: 2,
        });

        const rendered = await loadCreatorPartsForRender();
        const a = rendered.find(p => p.id === 'eyes_cc_a')!;
        const b = rendered.find(p => p.id === 'mouth_cc_b')!;
        // 讀出的都是可直接 <img> 的 base64
        expect(a.src).toBe(TINY_PNG);
        expect(b.src).toBe(TINY_PNG);

        // 存量舊部件應已在庫裡被遷成令牌
        const raw = await DB.getCustomCreatorParts();
        const rawB = raw.find(p => p.id === 'mouth_cc_b')!;
        expect(isBlobRef(rawB.src)).toBe(true);
    });
});
