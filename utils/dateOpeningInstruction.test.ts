import { describe, expect, it } from 'vitest';
import { buildDateOpeningInstruction } from './datePrompts';

describe('用預設時的開場指示', () => {
    it('講清楚這是開場、誰怎麼出場，格式交給預設', () => {
        const approach = buildDateOpeningInstruction({ charName: 'Soren', userName: '小星' });
        expect(approach).toContain('開場，不是回覆');
        expect(approach).toContain('小星正要走近Soren所在的地方');
        expect(approach).toContain('照預設要求的格式和結構輸出');
        const invite = buildDateOpeningInstruction({ charName: 'Soren', userName: '小星', openingMode: 'invite', meetup: { place: '河堤', plan: '看夕陽' } });
        expect(invite).toContain('由Soren主動');
        expect(invite).toContain('「河堤」');
    });
});
