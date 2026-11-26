/**
 * 設置頁的整合備份（context/OSContext.tsx 的 exportSystemImpl）自己列一份要打包的表，
 * 跟 DB.exportFullData 是兩份清單。2026-11-26 發現行事曆、旅行、見面故事、見面預設、
 * 角色小紅書主頁、購物中心都漏在設置頁那份外面：還原程式認得，但備份裡根本沒有。
 * DB.exportFullData 只有測試在用，所以 roundtrip 測試一直是綠的。
 *
 * 這裡直接讀原始碼對三件事：
 * - 資料庫裡每一張表，要嘛在 allStores 裡，要嘛列在下面「刻意不帶」；
 * - allStores 裡有欄位對照的表，switch 也要有那一格；
 * - 對照出來的欄位名，importFullData 讀得到（`data.<欄位>`），不然打包了也還原不回來。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const dbSrc = readFileSync(resolve(root, 'utils/db.ts'), 'utf8');
const osSrc = readFileSync(resolve(root, 'context/OSContext.tsx'), 'utf8');

/** 刻意不進備份的表，每一張都要寫為什麼 */
const INTENTIONALLY_EXCLUDED: Record<string, string> = {
    blob_assets: '圖片二進位另走 blobs/*（utils/blobRef.ts），不當一般表打包',
    api_call_log: '本機的 API 調用記錄，只是診斷用',
    assistant_sessions: 'Sore 的對話只在這台裝置（plans/ai-assistant.md）',
};

const sliceBetween = (src: string, start: string, end: string): string => {
    const i = src.indexOf(start);
    expect(i, `找不到 ${start}`).toBeGreaterThanOrEqual(0);
    const j = src.indexOf(end, i + start.length);
    expect(j, `找不到 ${start} 的結尾`).toBeGreaterThan(i);
    return src.slice(i + start.length, j);
};

const dbStores = (): Set<string> => {
    const names = new Set<string>();
    for (const m of dbSrc.matchAll(/^const STORE_\w+ = '([a-z0-9_]+)'/gm)) names.add(m[1]);
    for (const m of dbSrc.matchAll(/createStore\('([a-z0-9_]+)'/g)) names.add(m[1]);
    return names;
};

const allStores = (): Set<string> =>
    new Set([...sliceBetween(osSrc, 'const allStores = [', '];').matchAll(/'([a-z0-9_]+)'/g)].map(m => m[1]));

const fieldByStore = (): Record<string, string> => {
    const body = sliceBetween(osSrc, 'const textOnlyFieldByStore: Record<string, string> = {', '};');
    const out: Record<string, string> = {};
    for (const m of body.matchAll(/^\s*([a-z0-9_]+):\s*'([A-Za-z0-9]+)'/gm)) out[m[1]] = m[2];
    return out;
};

describe('整合備份涵蓋所有資料表', () => {
    it('資料庫的每張表都在匯出清單裡，或列在刻意不帶', () => {
        const listed = allStores();
        const missing = [...dbStores()].filter(s => !listed.has(s) && !(s in INTENTIONALLY_EXCLUDED)).sort();
        expect(missing).toEqual([]);
    });

    it('刻意不帶的表真的不在匯出清單裡', () => {
        const listed = allStores();
        expect(Object.keys(INTENTIONALLY_EXCLUDED).filter(s => listed.has(s))).toEqual([]);
    });

    it('有欄位對照的表，switch 也有那一格，而且欄位名一樣', () => {
        const map = fieldByStore();
        const listed = allStores();
        const wrong: string[] = [];
        for (const [store, field] of Object.entries(map)) {
            if (!listed.has(store)) { wrong.push(`${store}：有對照但不在 allStores`); continue; }
            const re = new RegExp(`case '${store}':[^\\n]*backupData\\.${field}\\b`);
            if (!re.test(osSrc)) wrong.push(`${store} → ${field}：switch 沒有這格或欄位名不一樣`);
        }
        expect(wrong).toEqual([]);
    });

    it('對照出來的欄位，importFullData 都會讀', () => {
        const at = dbSrc.indexOf('importFullData: async');
        expect(at).toBeGreaterThan(0);
        const importBody = dbSrc.slice(at);
        const unread = Object.values(fieldByStore()).filter(f => !new RegExp(`data\\.${f}\\b`).test(importBody));
        expect(unread).toEqual([]);
    });

    it('這次補上的表都在', () => {
        const listed = allStores();
        for (const s of ['calendar_events', 'trips', 'date_stories', 'meeting_presets', 'date_summary_presets', 'xhs_owned_posts', 'mall_categories', 'mall_products', 'mall_orders', 'bonds']) {
            expect(listed.has(s), s).toBe(true);
        }
    });
});
