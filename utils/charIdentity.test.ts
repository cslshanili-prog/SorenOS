import { describe, expect, it } from 'vitest';
import {
    ALIAS_MAX_COUNT, ALIAS_MAX_LENGTH, charAliases, charIdentityLines, charNameLine, charOneLiner, charRoleTitle,
    charSearchFields, charSubtitle, formatAliasInput, nameKey, normalizeAliases, parseAliasInput,
} from './charIdentity';

describe('別名那一格', () => {
    it('逗號、頓號、分號、換行都能分，全形半形都收', () => {
        expect(parseAliasInput('Vivian, 陸姐、薇寧；小V;阿寧\n寧寧，V')).toEqual(['Vivian', '陸姐', '薇寧', '小V', '阿寧', '寧寧', 'V']);
    });
    it('空的、跟名字一樣的、重複的丟掉（全半形、大小寫、空白、引號不算差別）', () => {
        expect(parseAliasInput(' , 陸薇寧, 陸 薇寧,「Vivian」, vivian, ＶＩＶＩＡＮ, 陸姐 ', '陸薇寧')).toEqual(['Vivian', '陸姐']);
    });
    it('最多 8 個、每個 20 字', () => {
        const many = Array.from({ length: 12 }, (_, i) => `名${i}`).join(',');
        expect(parseAliasInput(many)).toHaveLength(ALIAS_MAX_COUNT);
        expect(parseAliasInput('很'.repeat(40))[0]).toHaveLength(ALIAS_MAX_LENGTH);
    });
    it('存檔裡不是字串的東西不會炸', () => {
        expect(normalizeAliases([null, 3, '陸姐', undefined] as unknown[], '陸薇寧')).toEqual(['陸姐']);
        expect(charAliases(null)).toEqual([]);
        expect(charAliases({ name: 'A' })).toEqual([]);
    });
    it('轉回那一格的字', () => {
        expect(formatAliasInput(['Vivian', '陸姐'])).toBe('Vivian、陸姐');
        expect(formatAliasInput(undefined)).toBe('');
        expect(parseAliasInput(formatAliasInput(['Vivian', '陸姐']))).toEqual(['Vivian', '陸姐']);
    });
    it('nameKey', () => {
        expect(nameKey(' 「Ｖivian」 ')).toBe('vivian');
        expect(nameKey('陸 薇寧')).toBe(nameKey('陸薇寧'));
    });
});

describe('沒填別名和身份：吐出來的字跟拆欄位之前一樣', () => {
    const old = { name: '陸薇寧', description: '  嘴甜心硬的前輩 ' };
    it('名字原樣、一行介紹是簡介原文（連空白都不動）', () => {
        expect(charNameLine(old)).toBe('陸薇寧');
        expect(charOneLiner(old)).toBe('  嘴甜心硬的前輩 ');
        expect(charOneLiner({})).toBe('');
        expect(charOneLiner(null)).toBe('');
        expect(charOneLiner({ description: undefined })).toBe('');
    });
    it('小字就是簡介', () => {
        expect(charSubtitle(old)).toBe('嘴甜心硬的前輩');
        expect(charSubtitle({})).toBe('');
    });
});

describe('填了之後', () => {
    const full = { name: '陸薇寧', aliases: ['Vivian', '陸姐'], roleTitle: ' Cos 圈的前輩 ', description: '嘴甜心硬' };
    it('名字帶別名', () => {
        expect(charNameLine(full)).toBe('陸薇寧（又叫 Vivian、陸姐）');
    });
    it('小字「身份 · 簡介」，只有一樣就那一樣', () => {
        expect(charSubtitle(full)).toBe('Cos 圈的前輩 · 嘴甜心硬');
        expect(charSubtitle({ roleTitle: '攝影師' })).toBe('攝影師');
    });
    it('一行介紹「身份；簡介」，只有身份就只有身份', () => {
        expect(charOneLiner(full)).toBe('Cos 圈的前輩；嘴甜心硬');
        expect(charOneLiner({ roleTitle: '攝影師', description: '  ' })).toBe('攝影師');
    });
    it('身份太長截掉、換行壓成空白', () => {
        expect(charRoleTitle({ roleTitle: '段家\n長子' })).toBe('段家 長子');
        expect(charRoleTitle({ roleTitle: '長'.repeat(80) })).toHaveLength(40);
    });
    it('搜尋欄位', () => {
        expect(charSearchFields(full)).toEqual(['Vivian', '陸姐', 'Cos 圈的前輩', '嘴甜心硬']);
        expect(charSearchFields(null)).toEqual([]);
    });
});

describe('私聊身份段那幾行', () => {
    it('都沒填：一行都不出（以前會出「用戶備註/愛稱: 無」）', () => {
        expect(charIdentityLines({ name: 'A', description: '' })).toEqual([]);
    });
    it('只有簡介：標成簡介，後面跟一句相容的話', () => {
        const lines = charIdentityLines({ name: 'A', description: '快樂小狗' });
        expect(lines[0]).toBe('- 簡介: 快樂小狗');
        expect(lines[1]).toContain('以核心設定為準');
        expect(lines.join('\n')).not.toContain('用戶備註');
    });
    it('三樣都有：別名、身份、簡介依序', () => {
        const lines = charIdentityLines({ name: '陸薇寧', aliases: ['Vivian', '陸薇寧'], roleTitle: '攝影師', description: '嘴甜心硬' });
        expect(lines.slice(0, 3)).toEqual(['- 別名: Vivian', '- 身份: 攝影師', '- 簡介: 嘴甜心硬']);
    });
    it('只有別名和身份：不出簡介那句相容的話', () => {
        expect(charIdentityLines({ name: 'A', aliases: ['B'], roleTitle: '醫生', description: '' })).toEqual(['- 別名: B', '- 身份: 醫生']);
    });
});
