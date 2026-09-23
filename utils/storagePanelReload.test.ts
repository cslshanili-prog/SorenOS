import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 「一鍵優化」把重複圖片合併之後，整頁刷新是必須發生的一步。
//
// 合併只改庫裡的引用，內存裡的 theme / customIcons / appearancePresets 還捏著合併前的
// 令牌；導出備份取的是內存態（OSContext.tsx 的 cloneForInPlace），不刷新就會把同一張圖
// 的新舊兩個 Blob 都打進包 —— 也就是當初加這個自動刷新要防的那件事。
//
// 所以這次刷新不能掛在面板的生命週期上：SettingsSection 收起來是 {open && children}，
// 整個設置頁也隨 activeApp 切換卸載，2.5 秒裡用戶隨手收一下，帶 cleanup 的定時器就被清了；
// 再點一次「一鍵優化」也會重置狀態，而第二輪冪等必然 merged = 0，永遠不會再排。
//
// 組件測跑不起來（vitest 是 node 環境、沒裝 jsdom），這裡按源碼釘住結構。

const source = readFileSync(
    path.resolve(__dirname, '../components/settings/StorageUsagePanel.tsx'),
    'utf8',
);

/** 從 startIdx 後的第一個左括號開始，按括號配平截出整段調用文本 */
function extractCall(text: string, startIdx: number): string {
    const open = text.indexOf('(', startIdx);
    if (open < 0) return '';
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')') {
            depth--;
            if (depth === 0) return text.slice(startIdx, i + 1);
        }
    }
    return text.slice(startIdx);
}

/** 文件裡所有 useEffect(...) 的完整調用文本 */
function allEffects(): string[] {
    const out: string[] = [];
    for (let from = 0; ; ) {
        const at = source.indexOf('useEffect(', from);
        if (at < 0) return out;
        const call = extractCall(source, at);
        out.push(call);
        from = at + Math.max(call.length, 'useEffect('.length);
    }
}

/** handleOptimize 那個 useCallback 的完整文本 */
function handleOptimizeBody(): string {
    const at = source.indexOf('const handleOptimize = useCallback');
    if (at < 0) return '';
    return extractCall(source, source.indexOf('useCallback', at));
}

/** scheduleMergeReload 函數體 */
function schedulerBody(): string {
    const at = source.indexOf('function scheduleMergeReload');
    if (at < 0) return '';
    const end = source.indexOf('\n}', at);
    return end < 0 ? source.slice(at) : source.slice(at, end);
}

const COMPONENT_AT = source.indexOf('const StorageUsagePanel');

describe('合併去重後的自動刷新', () => {
    it('排刷新的定時器不掛在 useEffect 上，也沒人給它 cleanup', () => {
        const effects = allEffects();
        expect(effects.length).toBeGreaterThan(0);
        for (const effect of effects) {
            expect(effect).not.toContain('window.location.reload');
        }
        // 有 clearTimeout 就說明又有定時器被組件的生命週期管著了
        expect(source).not.toContain('clearTimeout');
    });

    it('刷新在 handleOptimize 裡排，看這輪有沒有真的合併過', () => {
        const body = handleOptimizeBody();
        expect(body).toContain('mergedDuplicates > 0');
        expect(body).toContain('scheduleMergeReload()');
    });

    it('計時器活在組件外面，面板卸載帶不走它', () => {
        const head = source.slice(0, COMPONENT_AT);
        expect(head).toMatch(/setTimeout\(\(\)\s*=>\s*window\.location\.reload\(\),\s*MERGE_RELOAD_DELAY_MS\)/);
        // 組件內部一個定時器都不該有：有就是又被 React 的生命週期接管了
        expect(source.slice(COMPONENT_AT)).not.toContain('setTimeout');
    });

    it('同一輪裡排過一次就不再排', () => {
        const scheduler = schedulerBody();
        expect(scheduler).toMatch(/if\s*\(mergeReloadScheduled\)\s*return/);
        expect(scheduler).toContain('mergeReloadScheduled = true');
        // 標記在模塊級，跟著組件走就白搭了
        expect(source.slice(0, COMPONENT_AT)).toContain('let mergeReloadScheduled = false');
    });

    it('全文只有這一處排刷新', () => {
        const scheduled = source.match(/setTimeout\([^;]*window\.location\.reload/g) || [];
        expect(scheduled).toHaveLength(1);
    });

    it('「立即刷新」按鈕還在，點了立刻走', () => {
        expect(source).toContain('onClick={() => window.location.reload()}');
    });
});
