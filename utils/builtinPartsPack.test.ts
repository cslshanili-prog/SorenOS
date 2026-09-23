import { describe, it, expect } from 'vitest';
import { planBuiltinPartsPack, safePartSlug, type BuiltinPackItem } from './builtinPartsPack';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PAYLOAD = PNG.split(',')[1];

describe('safePartSlug', () => {
    it('保留字母數字/中文/連字符，其餘折下劃線，空回落 part', () => {
        expect(safePartSlug('劉海 A')).toBe('劉海_A');
        expect(safePartSlug('a/b:c')).toBe('a_b_c');
        expect(safePartSlug('')).toBe('part');
        expect(safePartSlug('   ')).toBe('part');
    });
});

describe('planBuiltinPartsPack', () => {
    it('data: 圖抽成 parts/<id>.png，清單 src 寫相對路徑；含投影', () => {
        const items: BuiltinPackItem[] = [
            { categoryKey: 'fronthair', name: '劉海', src: PNG, shadowSrc: PNG, tintable: true },
        ];
        const { manifest, files, skipped } = planBuiltinPartsPack(items);
        expect(skipped).toBe(0);
        expect(manifest).toHaveLength(1);
        expect(manifest[0].id).toBe('fronthair_劉海');
        expect(manifest[0].src).toBe('parts/fronthair_劉海.png');
        expect(manifest[0].shadowSrc).toBe('parts/fronthair_劉海_shadow.png');
        expect(manifest[0].tintable).toBe(true);
        // 兩個文件：圖 + 投影，base64 只含負載
        expect(files).toHaveLength(2);
        expect(files.find(f => f.path === 'parts/fronthair_劉海.png')!.base64).toBe(PAYLOAD);
        expect(files.find(f => f.path === 'parts/fronthair_劉海_shadow.png')!.base64).toBe(PAYLOAD);
    });

    it('重名自動 _2/_3，id 與文件名唯一', () => {
        const items: BuiltinPackItem[] = [
            { categoryKey: 'eyes', name: '大眼', src: PNG },
            { categoryKey: 'eyes', name: '大眼', src: PNG },
            { categoryKey: 'eyes', name: '大眼', src: PNG },
        ];
        const { manifest, files } = planBuiltinPartsPack(items);
        const ids = manifest.map(m => m.id);
        expect(ids).toEqual(['eyes_大眼', 'eyes_大眼_2', 'eyes_大眼_3']);
        expect(new Set(files.map(f => f.path)).size).toBe(3); // 無覆蓋
    });

    it('http URL 原樣保留、不落文件；缺類目的跳過', () => {
        const items: BuiltinPackItem[] = [
            { categoryKey: 'skin', name: '遠程', src: 'https://a.com/s.png' },
            { categoryKey: null, name: '沒類目', src: PNG },
        ];
        const { manifest, files, skipped } = planBuiltinPartsPack(items);
        expect(skipped).toBe(1);
        expect(manifest).toHaveLength(1);
        expect(manifest[0].src).toBe('https://a.com/s.png');
        expect(files).toHaveLength(0);
    });
});
