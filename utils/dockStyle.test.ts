import { describe, expect, it } from 'vitest';
import { DEFAULT_DOCK_CUSTOM, dockContainerLook, hexToRgba, normalizeDockCustom } from './dockStyle';

describe('Dock 樣式', () => {
    it('沒設、glass：照原本各皮膚的樣子', () => {
        expect(dockContainerLook(undefined, undefined).className).toContain('bg-white/30');
        expect(dockContainerLook('glass', undefined, { paper: true }).style).toMatchObject({ background: 'rgba(224,221,215,0.42)' });
        expect(dockContainerLook('glass', undefined, { acnh: true }).style).toEqual({ background: 'transparent' });
    });

    it('無膠囊：沒有底', () => {
        expect(dockContainerLook('none', undefined)).toEqual({ className: '', style: { background: 'transparent' } });
    });

    it('自訂：底色＋透明度、模糊、圓角、邊框、陰影，有底圖時底色疊在圖上', () => {
        const look = dockContainerLook('custom', { color: '#000000', opacity: 50, blur: 10, radius: 12, borderColor: '#ff0000', borderWidth: 2, shadow: false });
        expect(look.style).toMatchObject({
            background: 'rgba(0, 0, 0, 0.5)', borderRadius: 12, border: '2px solid rgba(255, 0, 0, 0.45)', boxShadow: 'none', backdropFilter: 'blur(10px)',
        });
        const noBlur = dockContainerLook('custom', { ...DEFAULT_DOCK_CUSTOM, blur: 0, borderWidth: 0 });
        expect(noBlur.style?.backdropFilter).toBeUndefined();
        expect(noBlur.style?.border).toBe('none');
        const withImage = dockContainerLook('custom', DEFAULT_DOCK_CUSTOM, { imageUrl: 'blob:abc' });
        expect(String(withImage.style?.background)).toContain('url("blob:abc")');
    });

    it('存壞的值補齊、夾在範圍裡', () => {
        expect(normalizeDockCustom({ color: 'red', opacity: 300, blur: -5, radius: 'x' as any })).toMatchObject({
            color: DEFAULT_DOCK_CUSTOM.color, opacity: 100, blur: 0, radius: DEFAULT_DOCK_CUSTOM.radius,
        });
        expect(normalizeDockCustom(undefined)).toEqual(DEFAULT_DOCK_CUSTOM);
        expect(hexToRgba('#336699', 0.3)).toBe('rgba(51, 102, 153, 0.3)');
    });
});
