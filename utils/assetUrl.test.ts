import { describe, it, expect } from 'vitest';
import { assetMirrors, assetUrl, assetPathFromUrl, mirrorsForUrl, audioMirrors } from './assetUrl';

describe('assetMirrors', () => {
    it('主源是 jsDelivr，末位兜底是 raw.githubusercontent', () => {
        const m = assetMirrors('img/MOON.png');
        expect(m[0]).toBe('https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/img/MOON.png');
        expect(m[m.length - 1]).toBe('https://raw.githubusercontent.com/qegj567-cloud/SullyOS-assets/main/img/MOON.png');
    });

    it('鏡像跨多個獨立網絡，無重複', () => {
        const m = assetMirrors('bgm/POEM/A01.mp3');
        expect(m.length).toBeGreaterThanOrEqual(4);
        expect(new Set(m).size).toBe(m.length);
        expect(m.every(u => u.endsWith('bgm/POEM/A01.mp3'))).toBe(true);
    });

    it('吃掉路徑前導斜槓，不產生 // ', () => {
        expect(assetMirrors('/img/x.png')[0]).toBe(assetMirrors('img/x.png')[0]);
    });

    it('assetUrl 就是主源', () => {
        expect(assetUrl('img/x.png')).toBe(assetMirrors('img/x.png')[0]);
    });
});

describe('assetPathFromUrl', () => {
    it('反解 jsDelivr @ref 鏈接', () => {
        expect(assetPathFromUrl('https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/img/MOON.png'))
            .toBe('img/MOON.png');
    });
    it('反解 raw.githubusercontent 鏈接', () => {
        expect(assetPathFromUrl('https://raw.githubusercontent.com/qegj567-cloud/SullyOS-assets/main/img/BOOK.png'))
            .toBe('img/BOOK.png');
    });
    it('反解 statically 鏈接', () => {
        expect(assetPathFromUrl('https://cdn.statically.io/gh/qegj567-cloud/SullyOS-assets/main/bgm/letter/1.mp3'))
            .toBe('bgm/letter/1.mp3');
    });
    it('反解帶子目錄的深路徑', () => {
        expect(assetPathFromUrl('https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/img/DREAMS/a%20b.png'))
            .toBe('img/DREAMS/a%20b.png');
    });
    it('認不出的第三方圖床返回 null', () => {
        expect(assetPathFromUrl('https://sharkpan.xyz/f/BZ3VSa/head.png')).toBeNull();
    });
});

describe('mirrorsForUrl', () => {
    it('已知素材 url 展開成完整鏡像鏈', () => {
        const m = mirrorsForUrl('https://raw.githubusercontent.com/qegj567-cloud/SullyOS-assets/main/img/BOOK.png');
        expect(m[0]).toBe('https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/img/BOOK.png');
        expect(m.length).toBeGreaterThanOrEqual(4);
    });
    it('認不出的 url 原樣單條返回（不誤傷第三方圖床）', () => {
        const u = 'https://sharkpan.xyz/f/BZ3VSa/head.png';
        expect(mirrorsForUrl(u)).toEqual([u]);
    });
});

describe('audioMirrors', () => {
    it('prioritizes the byte-range capable GitHub Raw source for repository audio', () => {
        const mirrors = audioMirrors('bgm/qixi/02/02_0_舊鐘房間.mp3');
        expect(mirrors[0]).toBe(
            'https://raw.githubusercontent.com/qegj567-cloud/SullyOS-assets/main/bgm/qixi/02/02_0_舊鐘房間.mp3',
        );
        expect(new Set(mirrors).size).toBe(mirrors.length);
    });

    it('keeps an unrelated third-party audio URL untouched', () => {
        const url = 'https://example.com/music.mp3';
        expect(audioMirrors(url)).toEqual([url]);
    });
});
