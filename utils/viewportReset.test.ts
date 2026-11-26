// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nudgedViewportContent, resetViewportZoom } from './viewportReset';

// 匯出回來畫面放大偏移（plans/todo.md 第 2 項）
describe('viewport 重設', () => {
    afterEach(() => { document.head.innerHTML = ''; vi.useRealTimers(); });

    it('只換 initial-scale 的寫法，其他設定原封不動', () => {
        const base = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=0, viewport-fit=contain';
        const nudged = nudgedViewportContent(base);
        expect(nudged).not.toBe(base);
        expect(nudged).toContain('initial-scale=1.0');
        expect(nudged.replace('initial-scale=1.0', 'initial-scale=1')).toBe(base);
        expect(nudgedViewportContent(nudged)).toBe(base);
        expect(nudgedViewportContent('width=device-width')).toBe('width=device-width, initial-scale=1');
    });

    it('改一下再改回原文', async () => {
        const meta = document.createElement('meta');
        meta.name = 'viewport';
        meta.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
        document.head.appendChild(meta);
        resetViewportZoom();
        expect(meta.content).toContain('initial-scale=1.0');
        await new Promise(r => requestAnimationFrame(() => r(null)));
        expect(meta.content).toBe('width=device-width, initial-scale=1, viewport-fit=cover');
    });

    it('中間有人改過（例如 iOS 頂端那套改 viewport-fit）就不蓋回去', async () => {
        const meta = document.createElement('meta');
        meta.name = 'viewport';
        meta.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
        document.head.appendChild(meta);
        resetViewportZoom();
        meta.content = 'width=device-width, initial-scale=1, viewport-fit=contain';
        await new Promise(r => requestAnimationFrame(() => r(null)));
        expect(meta.content).toBe('width=device-width, initial-scale=1, viewport-fit=contain');
    });
});
