import { describe, expect, it } from 'vitest';
import { BUFF_STORE_MAX, buffRemaining, buffStrength, buffStrengthDots, buffsForEvaluation, buildEmotionInjection, liveBuffs, settleBuffs } from './emotionDecay';
import type { CharacterBuff } from '../types';

const H = 3_600_000;
const NOW = 1_800_000_000_000;
const buff = (id: string, intensity: 1 | 2 | 3, hoursAgo?: number, over: Partial<CharacterBuff> = {}): CharacterBuff =>
    ({ id, name: id, label: id, intensity, ...(hoursAgo === undefined ? {} : { since: NOW - hoursAgo * H }), ...over });

describe('褪色', () => {
    it('半衰期：淺 6 小時、中 1 天、深 3.5 天；舊資料沒有時間不褪', () => {
        expect(buffStrength(buff('a', 1, 6), NOW)).toBeCloseTo(0.5);
        expect(buffStrength(buff('b', 2, 24), NOW)).toBeCloseTo(1);
        expect(buffStrength(buff('c', 3, 84), NOW)).toBeCloseTo(1.5);
        expect(buffStrength(buff('d', 2), NOW)).toBe(2);
        expect(buffRemaining(buff('c', 3, 84), NOW)).toBeCloseTo(0.5);
    });

    it('淡掉的不算，剩下的照此刻強度排', () => {
        const list = [buff('shallow-old', 1, 12), buff('mid', 2, 0), buff('deep-old', 3, 84), buff('legacy', 1)];
        expect(liveBuffs(list, NOW).map(b => b.id)).toEqual(['mid', 'deep-old', 'legacy']);
        expect(buffStrengthDots(buff('x', 3, 0), NOW)).toBe('●●●●●');
        expect(buffStrengthDots(buff('x', 1, 0), NOW)).toBe('●●○○○');
    });

    it('評估落庫：同一個情緒強度沒變就接著褪，變了或新的從現在算；淡掉的清掉、最多 12 條', () => {
        const prev = [buff('anx', 2, 10), buff('joy', 1, 2)];
        const next = settleBuffs(prev, [buff('anx', 2), { ...buff('joy', 3), id: 'other', name: 'joy' }, buff('new', 1)], NOW);
        expect(next.find(b => b.id === 'anx')?.since).toBe(NOW - 10 * H);
        expect(next.find(b => b.id === 'other')?.since).toBe(NOW);
        expect(next.find(b => b.id === 'new')?.since).toBe(NOW);
        const many = Array.from({ length: 20 }, (_, i) => buff(`b${i}`, (i % 3 + 1) as 1 | 2 | 3));
        expect(settleBuffs([], many, NOW)).toHaveLength(BUFF_STORE_MAX);
        // 原本存的早就淡掉、評估又照原強度給回來：沿用原時間，所以還是被清掉
        expect(settleBuffs([buff('gone', 1, 48)], [buff('gone', 1)], NOW)).toEqual([]);
    });

    it('給評估模型看的：強度換成此刻的、附持續多久、不帶時間戳', () => {
        const view = buffsForEvaluation([buff('deep', 3, 84), buff('gone', 1, 48)], NOW);
        expect(view).toHaveLength(1);
        expect(view[0]).toMatchObject({ id: 'deep', intensity: 2, 已持續: '4 天' });
        expect('since' in view[0]).toBe(false);
    });
});

describe('提示詞裡的情緒段', () => {
    it('總結後面補此刻還剩什麼；全部淡掉就不帶；舊資料照原樣', () => {
        const text = buildEmotionInjection({ buffInjection: '你很焦慮。', buffInjectionAt: NOW - 5 * H, activeBuffs: [buff('焦慮', 2, 5, { emoji: '😟' }), buff('淡掉的', 1, 30)] }, NOW);
        expect(text.startsWith('你很焦慮。\n（這段情緒總結寫於 5 小時前。此刻還在的情緒：😟 焦慮 ●●●○○；')).toBe(true);
        expect(text).not.toContain('淡掉的 ');
        expect(buildEmotionInjection({ buffInjection: '你很焦慮。', activeBuffs: [buff('a', 1, 40)] }, NOW)).toBe('');
        expect(buildEmotionInjection({ buffInjection: '舊的', activeBuffs: [buff('a', 1)] }, NOW)).toBe('舊的');
        expect(buildEmotionInjection({ buffInjection: '', activeBuffs: [] }, NOW)).toBe('');
        // 只帶最強的 6 條
        const many = Array.from({ length: 9 }, (_, i) => buff(`e${i}`, 2, 0));
        expect((buildEmotionInjection({ buffInjection: 'x', activeBuffs: many }, NOW).match(/e\d/g) || []).length).toBe(6);
        // 不到一小時不寫分鐘數，提示詞才不會每分鐘都變
        expect(buildEmotionInjection({ buffInjection: 'x', buffInjectionAt: NOW - 10 * 60_000, activeBuffs: [buff('a', 2, 0)] }, NOW)).toContain('不到 1 小時前');
    });
});
