import { describe, it, expect, beforeEach } from 'vitest';
import { DB } from './db';
import { MIRRORED_KEYS, healLocalStorageMirror, snapshotLocalStorageMirror } from './lsMirror';

// localStorage 鏡像：模擬"瀏覽器清了 localStorage 但 IndexedDB 倖存"的用戶現場
// （主題回初始 / 盲盒收藏冊清空 / API 配置丟失導致「更新這一天」無反應）。
describe('localStorage IndexedDB 鏡像 (lsMirror)', () => {
    beforeEach(async () => {
        localStorage.clear();
        await DB.saveAssetRaw('ls_mirror_v1', null as any).catch(() => {});
    });

    it('快照 → localStorage 被清 → 回填恢復', async () => {
        localStorage.setItem('os_theme', '{"hue":300}');
        localStorage.setItem('os_api_config', '{"baseUrl":"https://x","apiKey":"sk-1","model":"m"}');
        localStorage.setItem('os_dream_collection', '{"sweet":{"firstAt":1,"count":2}}');
        await snapshotLocalStorageMirror();

        localStorage.clear(); // 模擬瀏覽器驅逐

        const restored = await healLocalStorageMirror();
        expect(restored.sort()).toEqual(['os_api_config', 'os_dream_collection', 'os_theme']);
        expect(localStorage.getItem('os_theme')).toBe('{"hue":300}');
        expect(localStorage.getItem('os_dream_collection')).toBe('{"sweet":{"firstAt":1,"count":2}}');
    });

    it('localStorage 已有值時回填不覆蓋（真值永遠是 localStorage）', async () => {
        localStorage.setItem('os_theme', '{"hue":1}');
        await snapshotLocalStorageMirror();

        localStorage.setItem('os_theme', '{"hue":2}'); // 用戶之後又改了主題
        const restored = await healLocalStorageMirror();
        expect(restored).toEqual([]);
        expect(localStorage.getItem('os_theme')).toBe('{"hue":2}');
    });

    it('removeItem 語義：新快照不再含已刪除的鍵，回填不會復活它', async () => {
        localStorage.setItem('study_api_config', '{"baseUrl":"https://private"}');
        localStorage.setItem('os_theme', '{"hue":9}');
        await snapshotLocalStorageMirror();

        localStorage.removeItem('study_api_config'); // 用戶點了「恢復使用全局 API」
        await snapshotLocalStorageMirror();          // 頁面隱藏/定時快照跟進

        localStorage.clear();
        const restored = await healLocalStorageMirror();
        expect(restored).toEqual(['os_theme']);
        expect(localStorage.getItem('study_api_config')).toBeNull();
    });

    it('localStorage 全空時不寫快照（不拿空覆蓋有效鏡像）', async () => {
        localStorage.setItem('os_theme', '{"hue":7}');
        await snapshotLocalStorageMirror();

        localStorage.clear();
        await snapshotLocalStorageMirror(); // 空的，應當被忽略

        const restored = await healLocalStorageMirror();
        expect(restored).toEqual(['os_theme']);
    });

    it('沒有鏡像時回填靜默返回空數組', async () => {
        const restored = await healLocalStorageMirror();
        expect(restored).toEqual([]);
    });

    it('鏡像鍵名單不含大體積鍵（data URI 類必須走 assets）', () => {
        for (const k of MIRRORED_KEYS) {
            expect(k).not.toMatch(/wallpaper|font|sprite|image|blob/i);
        }
    });
});
