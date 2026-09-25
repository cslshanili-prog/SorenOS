import { describe, expect, it } from 'vitest';
import { pickRefreshPosters } from './momentsGenerate';

describe('重整時挑誰發文', () => {
    const chars = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id }));

    it('挑 1～3 位、不重複', () => {
        for (const r of [0, 0.34, 0.67, 0.99]) {
            let i = 0;
            const seq = [r, 0.1, 0.5, 0.9, 0.3];
            const picked = pickRefreshPosters(chars, () => seq[i++ % seq.length]);
            expect(picked.length).toBeGreaterThanOrEqual(1);
            expect(picked.length).toBeLessThanOrEqual(3);
            expect(new Set(picked.map(p => p.id)).size).toBe(picked.length);
        }
    });

    it('只有一位或沒有角色時照單全收', () => {
        expect(pickRefreshPosters([{ id: 'a' }])).toEqual([{ id: 'a' }]);
        expect(pickRefreshPosters([])).toEqual([]);
    });
});
