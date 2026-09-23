import { describe, it, expect } from 'vitest';
import { roundMoney, sumMoney, formatMoney, formatHours } from './format';

describe('金額收斂到分位', () => {
    it('浮點求和的尾巴被抹掉', () => {
        // 記帳裡真實出現過的一組流水：直接 + 會得到 49.85999999999999
        const raw = [7.9, 12.9, 11.36, 11.9, 5.8].reduce((s, n) => s + n, 0);
        expect(String(raw)).toContain('49.859999');
        expect(sumMoney([7.9, 12.9, 11.36, 11.9, 5.8])).toBe(49.86);
        expect(formatMoney(raw)).toBe('49.86');
    });

    it('經典 0.1 + 0.2', () => {
        expect(sumMoney([0.1, 0.2])).toBe(0.3);
        expect(formatMoney(0.1 + 0.2)).toBe('0.3');
    });

    it('整數不帶小數點，一位小數保持一位', () => {
        expect(formatMoney(100)).toBe('100');
        expect(formatMoney(7.9)).toBe('7.9');
        expect(formatMoney(11.36)).toBe('11.36');
    });

    it('超過兩位小數按四捨五入截到分', () => {
        expect(formatMoney(1.239)).toBe('1.24');
        expect(roundMoney(1.234)).toBe(1.23);
    });

    it('空列表和壞值不炸', () => {
        expect(sumMoney([])).toBe(0);
        expect(formatMoney(NaN)).toBe('0');
        expect(formatMoney(Infinity)).toBe('0');
        expect(sumMoney([1.5, NaN as unknown as number, 2])).toBe(3.5);
    });

    it('負數（退款）同樣收斂', () => {
        expect(sumMoney([49.86, -7.9])).toBe(41.96);
        expect(formatMoney(-0.1 - 0.2)).toBe('-0.3');
    });
});

describe('分鐘轉小時顯示', () => {
    it('整檔不帶小數點', () => {
        expect(formatHours(60)).toBe('1');
        expect(formatHours(120)).toBe('2');
        expect(formatHours(1440)).toBe('24');
    });

    it('除不盡的檔位收到一位小數', () => {
        expect(String(100 / 60)).toContain('1.6666');
        expect(formatHours(100)).toBe('1.7');
        expect(formatHours(90)).toBe('1.5');
    });

    it('壞值不炸', () => {
        expect(formatHours(NaN)).toBe('0');
    });
});
