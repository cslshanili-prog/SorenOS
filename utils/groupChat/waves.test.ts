import { describe, it, expect } from 'vitest';
import { planGroupWaves } from './waves';

/** 固定序列的假隨機數，跑完一圈再從頭 */
const seq = (...values: number[]) => {
    let i = 0;
    return () => values[i++ % values.length];
};

describe('planGroupWaves', () => {
    it('沒人就沒有波次；一個人就一波', () => {
        expect(planGroupWaves([])).toEqual([]);
        expect(planGroupWaves(['A'])).toEqual([['A']]);
    });

    it('兩個人：一人一波', () => {
        const waves = planGroupWaves(['A', 'B'], seq(0.9, 0.1));
        expect(waves.map(w => w.length)).toEqual([1, 1]);
        expect(waves.flat().sort()).toEqual(['A', 'B']);
    });

    it('三人以上：第一波 1 或 2 人，其餘全在第二波，誰都不漏、不重複', () => {
        for (const r of [0.1, 0.9]) {
            const waves = planGroupWaves(['A', 'B', 'C', 'D', 'E'], seq(0.3, 0.7, 0.5, 0.2, r));
            expect(waves).toHaveLength(2);
            expect(waves[0].length).toBe(r < 0.5 ? 1 : 2);
            expect(waves.flat().sort()).toEqual(['A', 'B', 'C', 'D', 'E']);
        }
    });

    it('順序會被打亂，不再固定是列表第一個人先開口', () => {
        const firsts = new Set<string>();
        for (let k = 0; k < 40; k++) firsts.add(planGroupWaves(['A', 'B', 'C', 'D'])[0][0]);
        expect(firsts.size).toBeGreaterThan(1);
    });

    it('不改動傳進來的陣列', () => {
        const input = ['A', 'B', 'C'];
        planGroupWaves(input);
        expect(input).toEqual(['A', 'B', 'C']);
    });
});
