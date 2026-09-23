import { describe, expect, it } from 'vitest';
import { acquaintanceDays, buildAcquaintanceLine, buildRelationshipPrompt, extractRelationshipChange } from './chatRelationship';

describe('extractRelationshipChange', () => {
    it('剝掉標籤並取出新關係', () => {
        const r = extractRelationshipChange('我想好了\n[[ACTION:RELATIONSHIP|戀人]]');
        expect(r.relationship).toBe('戀人');
        expect(r.cleanedText).toBe('我想好了');
    });

    it('認中文別名、全形標點、引號，多個取最後一個', () => {
        const r = extractRelationshipChange('a [[ACTION：關係｜「朋友」]] b [[action:set_relationship|曖昧對象]]');
        expect(r.relationship).toBe('曖昧對象');
        expect(r.cleanedText).not.toContain('[[');
    });

    it('空值或過長的不算，但標籤照樣剝掉', () => {
        const r = extractRelationshipChange('嗯[[ACTION:RELATIONSHIP|]]');
        expect(r.relationship).toBeNull();
        expect(r.cleanedText).toBe('嗯');
        expect(extractRelationshipChange(`[[ACTION:RELATIONSHIP|${'很'.repeat(31)}]]`).relationship).toBeNull();
    });

    it('沒有標籤原樣返回', () => {
        expect(extractRelationshipChange('  普通訊息  ')).toEqual({ cleanedText: '  普通訊息  ', relationship: null });
    });
});

describe('buildRelationshipPrompt', () => {
    it('全都沒設時是空的', () => {
        expect(buildRelationshipPrompt({}, 'Lilly')).toBe('');
    });

    it('只帶有設定的欄位', () => {
        const p = buildRelationshipPrompt({ userNickname: '小莉', charViewRelationship: '青梅竹馬' }, 'Lilly');
        expect(p).toContain('你稱呼Lilly為「小莉」');
        expect(p).toContain('你認為你們的關係是：青梅竹馬');
        expect(p).not.toContain('暱稱是');
        expect(p).not.toContain('ACTION:RELATIONSHIP');
    });

    it('開了自主改關係才教動作標籤', () => {
        expect(buildRelationshipPrompt({ allowCharChangeRelationship: true }, 'Lilly')).toContain('[[ACTION:RELATIONSHIP|新的關係]]');
    });
});

describe('acquaintanceDays', () => {
    it('起點當天算第 1 天，跨月跨年正確', () => {
        expect(acquaintanceDays('2026-09-23', '2026-09-23')).toBe(1);
        expect(acquaintanceDays('2026-08-31', '2026-09-01')).toBe(2);
        expect(acquaintanceDays('2025-12-31', '2026-01-01')).toBe(2);
    });

    it('未來日期、壞格式、沒設回 null', () => {
        expect(acquaintanceDays('2026-09-24', '2026-09-23')).toBeNull();
        expect(acquaintanceDays('2026/09/01', '2026-09-23')).toBeNull();
        expect(acquaintanceDays(undefined, '2026-09-23')).toBeNull();
        expect(buildAcquaintanceLine(undefined, '2026-09-23', 'Lilly')).toBe('');
    });

    it('相識行帶天數', () => {
        expect(buildAcquaintanceLine('2026-09-01', '2026-09-23', 'Lilly')).toContain('第 23 天');
    });
});
