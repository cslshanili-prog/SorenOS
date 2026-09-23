import { describe, it, expect } from 'vitest';
import {
    EVENT_BOX_SUMMARY_TARGET_MIN_CHARS,
    EVENT_BOX_SUMMARY_TARGET_MAX_CHARS,
    EVENT_BOX_SUMMARY_HARD_MAX_CHARS,
} from './types';
import { enforceSummaryLengthBudget } from './summaryLengthBudget';

describe('EventBox summary 字數預算', () => {
    it('目標區間下界小於上界', () => {
        expect(EVENT_BOX_SUMMARY_TARGET_MIN_CHARS).toBeLessThan(EVENT_BOX_SUMMARY_TARGET_MAX_CHARS);
    });

    // 迴歸守衛：硬截斷線必須高於目標上界，給「模型數不準字數」留緩衝。
    // 若砍線 ≤ 目標上界，模型瞄著目標上界寫、稍微超一點就會被硬截斷拼上「……」——
    // 這正是整合回憶末尾省略號的根因。砍線和目標上界不能一起往下壓到同一個值。
    it('硬截斷線高於目標上界（留緩衝，避免模型稍超就被砍出「……」）', () => {
        expect(EVENT_BOX_SUMMARY_HARD_MAX_CHARS).toBeGreaterThan(EVENT_BOX_SUMMARY_TARGET_MAX_CHARS);
    });
});

describe('enforceSummaryLengthBudget — 超限二次壓縮兜底', () => {
    const HARD = 900;
    const ELLIPSIS = '……';

    it('未超限：原樣返回，且不觸發二次壓縮', async () => {
        const text = 'a'.repeat(500);
        let called = false;
        const out = await enforceSummaryLengthBudget(text, async () => { called = true; return null; }, HARD);
        expect(out).toBe(text);
        expect(called).toBe(false);
    });

    it('超限 + 二次壓縮達標：採用壓縮結果，不留省略號', async () => {
        const text = 'a'.repeat(1000);
        const out = await enforceSummaryLengthBudget(text, async () => 'b'.repeat(600), HARD);
        expect(out).toBe('b'.repeat(600));
        expect(out.endsWith(ELLIPSIS)).toBe(false);
    });

    it('超限 + 二次壓縮後仍超：取更短者做基底，硬截斷兜底', async () => {
        const text = 'a'.repeat(1000);
        // 二次壓縮壓到 950，仍 > 900 → 用 950 這份做基底截斷
        const out = await enforceSummaryLengthBudget(text, async () => 'b'.repeat(950), HARD);
        expect(out.startsWith('b'.repeat(HARD))).toBe(true);
        expect(out.endsWith(ELLIPSIS)).toBe(true);
        expect(out.length).toBe(HARD + ELLIPSIS.length);
    });

    it('超限 + 二次壓縮失敗(null)：回退硬截斷原文', async () => {
        const text = 'a'.repeat(1000);
        const out = await enforceSummaryLengthBudget(text, async () => null, HARD);
        expect(out).toBe('a'.repeat(HARD) + ELLIPSIS);
    });
});
