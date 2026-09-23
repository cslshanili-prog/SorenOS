import { describe, it, expect } from 'vitest';
import { parseLayerName } from './psdCreatorImport';

describe('parseLayerName', () => {
    it('中文別名 + 空格', () => {
        expect(parseLayerName('前發 雲朵劉海')).toEqual({ categoryKey: 'fronthair', name: '雲朵劉海', tintable: null });
        expect(parseLayerName('耳發 長鬢髮')).toEqual({ categoryKey: 'earhair', name: '長鬢髮', tintable: null });
    });

    it('英文 key + 各種分隔符', () => {
        expect(parseLayerName('fronthair-cloud')).toEqual({ categoryKey: 'fronthair', name: 'cloud', tintable: null });
        expect(parseLayerName('後發1_馬尾')).toEqual({ categoryKey: 'back1', name: '馬尾', tintable: null });
        expect(parseLayerName('配飾·蝴蝶結')).toEqual({ categoryKey: 'decor', name: '蝴蝶結', tintable: null });
    });

    it('後發1/後發2 不被"後發"截斷', () => {
        expect(parseLayerName('後發2 雙馬尾').categoryKey).toBe('back2');
    });

    it('劉海是前發的別名', () => {
        expect(parseLayerName('劉海 齊劉海').categoryKey).toBe('fronthair');
    });

    it('#色 / #原色 標記（含全角井號），並從名字裡剝掉', () => {
        expect(parseLayerName('衣服 水手服 #色')).toEqual({ categoryKey: 'outfit', name: '水手服', tintable: true });
        expect(parseLayerName('前發 挑染劉海 ＃原色')).toEqual({ categoryKey: 'fronthair', name: '挑染劉海', tintable: false });
        expect(parseLayerName('outfit sailor #notint').tintable).toBe(false);
        expect(parseLayerName('outfit sailor #tint').tintable).toBe(true);
    });

    it('識別不出類目時整個名字保留、categoryKey 為 null', () => {
        expect(parseLayerName('隨便畫的一層')).toEqual({ categoryKey: null, name: '隨便畫的一層', tintable: null });
    });

    it('只有類目沒有名字時名字回退為原始串', () => {
        expect(parseLayerName('前發')).toEqual({ categoryKey: 'fronthair', name: '前發', tintable: null });
    });

    it('hasCategory=false 時不認類目、整名保留（組內圖層名走這條：類目來自組）', () => {
        expect(parseLayerName('杏眼', false)).toEqual({ categoryKey: null, name: '杏眼', tintable: null });
        // tint 標記仍會被剝出
        expect(parseLayerName('狐狸眼 #色', false)).toEqual({ categoryKey: null, name: '狐狸眼', tintable: true });
    });
});
