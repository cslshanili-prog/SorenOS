import { describe, it, expect, vi, afterEach } from 'vitest';
import { isChunkLoadError, markModuleLoadError, tryAutoReloadForChunkError } from './chunkLoadRecovery';

// 鎖住 "Importing a module script failed." 自愈鏈路:
// iOS Safari standalone PWA 下動態 import 失敗會被緩存進模塊表, 本頁內重試必失敗,
// 只有整頁 reload 能恢復 — AppErrorBoundary 靠這兩個函數識別 + 自動刷新 (帶防循環冷卻)。

describe('isChunkLoadError', () => {
    it('識別各瀏覽器的 chunk 加載失敗指紋', () => {
        // iOS / macOS Safari (用戶報錯原文)
        expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
        // Chrome
        expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x.dev/assets/Chat-Ck2f.js'))).toBe(true);
        // Firefox
        expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true);
        // Vite CSS 依賴預載失敗
        expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/Chat-D3xq.css'))).toBe(true);
        // Safari / WebKit：部署更新後舊 chunk URL 被 SPA fallback 回成 index.html。
        expect(isChunkLoadError(new TypeError("'text/html' is not a valid JavaScript MIME type."))).toBe(true);
        // Chromium 對同一類 HTML-as-module 響應的報錯文案。
        expect(isChunkLoadError(new TypeError('Expected a JavaScript module script but the server responded with a MIME type of "text/html".'))).toBe(true);
        // 字符串形態也接受
        expect(isChunkLoadError('Importing a module script failed.')).toBe(true);
    });

    it('普通運行時錯誤不誤判', () => {
        expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false);
        expect(isChunkLoadError(new Error('Network request failed'))).toBe(false);
        expect(isChunkLoadError(null)).toBe(false);
        expect(isChunkLoadError(undefined)).toBe(false);
        expect(isChunkLoadError(42)).toBe(false);
    });

    it.each(['Unexpected EOF', 'Unexpected end of input', 'Unexpected end of script.'])('只有加載階段的 %s 才走資源恢復', message => {
        const error = Object.freeze(new SyntaxError(message));
        expect(isChunkLoadError(error)).toBe(false);
        markModuleLoadError(error);
        expect(isChunkLoadError(error)).toBe(true);
    });

    it('帶 JSON 提示的解析失敗、組件運行異常不自動刷新', () => {
        for (const error of [
            new SyntaxError('JSON Parse error: Unexpected EOF'),
            new SyntaxError('Unexpected end of JSON input'),
            new TypeError("Cannot read properties of undefined (reading 'map')"),
            new Error('Unexpected EOF'),
        ]) {
            markModuleLoadError(error);
            expect(isChunkLoadError(error)).toBe(false);
        }
        markModuleLoadError(null);
        markModuleLoadError('Unexpected EOF');
        expect(isChunkLoadError('Unexpected EOF')).toBe(false);
        expect(isChunkLoadError(new SyntaxError('Unexpected EOF'))).toBe(false);
    });
});

describe('tryAutoReloadForChunkError', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const stubEnv = () => {
        const store = new Map<string, string>();
        const reload = vi.fn();
        vi.stubGlobal('sessionStorage', {
            getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
            setItem: (k: string, v: string) => { store.set(k, String(v)); },
        });
        vi.stubGlobal('window', { location: { reload } });
        return { reload };
    };

    it('首次觸發: 記錄時間戳並整頁刷新', () => {
        const { reload } = stubEnv();
        expect(tryAutoReloadForChunkError()).toBe(true);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('冷卻期內再觸發: 不再自動刷新 (防循環), 留給手動按鈕', () => {
        const { reload } = stubEnv();
        expect(tryAutoReloadForChunkError()).toBe(true);
        expect(tryAutoReloadForChunkError()).toBe(false);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('sessionStorage 不可用時不自動刷新 (沒法防循環)', () => {
        const reload = vi.fn();
        vi.stubGlobal('window', { location: { reload } });
        // 不 stub sessionStorage → 訪問拋 ReferenceError → 內部 catch → 不自刷
        expect(tryAutoReloadForChunkError()).toBe(false);
        expect(reload).not.toHaveBeenCalled();
    });
});
