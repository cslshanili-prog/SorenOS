import { describe, expect, it } from 'vitest';
import { findAliasClashes, findPersonByRef, matchPerson, matchPersonDetail, peopleByAlias, personKey } from './personMatch';

const lu = { id: 'lu', name: '陸薇寧', aliases: ['Vivian', '陸姐'] };
const che = { id: 'che', name: '阿澈', aliases: ['Che', '澈哥'] };
const people = [lu, che];

describe('靠名字認人', () => {
    it('名字：全半形、空白、引號、大小寫、繁簡都不算差別', () => {
        expect(matchPerson('陸薇寧', people)).toBe(lu);
        expect(matchPerson(' 「陸 薇寧」 ', people)).toBe(lu);
        expect(matchPerson('陆薇宁', people)).toBe(lu);
        expect(matchPersonDetail('阿澈', people)?.via).toBe('name');
    });

    it('別名也認', () => {
        expect(matchPerson('vivian', people)).toBe(lu);
        expect(matchPerson('ＶＩＶＩＡＮ', people)).toBe(lu);
        expect(matchPerson('陆姐', people)).toBe(lu);
        expect(matchPerson('澈哥', people)).toBe(che);
        expect(matchPersonDetail('Che', people)?.via).toBe('alias');
    });

    it('沒這個人、空字串：null', () => {
        expect(matchPerson('路人甲', people)).toBeNull();
        expect(matchPerson('', people)).toBeNull();
        expect(matchPerson('   ', people)).toBeNull();
        expect(matchPerson(undefined, people)).toBeNull();
    });

    it('名字贏過別名', () => {
        const a = { name: '小陸' };
        const b = { name: '陸薇寧', aliases: ['小陸'] };
        expect(matchPerson('小陸', [b, a])).toBe(a);
    });

    it('兩個人的別名撞在一起：當沒認出來，開了 fuzzy 也不猜', () => {
        const a = { name: '陸薇寧', aliases: ['小陸'] };
        const b = { name: '陸小陸', aliases: ['小陸'] };
        expect(matchPerson('小陸', [a, b])).toBeNull();
        expect(matchPerson('小陸', [a, b], { fuzzy: true })).toBeNull();
        // 同一個人在名單上出現兩次不算撞名
        expect(matchPerson('小陸', [a, a])).toBe(a);
    });

    it('fuzzy：名字互相包含才算，沒開就不做；別名不做包含', () => {
        expect(matchPerson('學長阿澈', people)).toBeNull();
        expect(matchPerson('學長阿澈', people, { fuzzy: true })).toBe(che);
        expect(matchPerson('薇寧', people, { fuzzy: true })).toBe(lu);
        expect(matchPersonDetail('薇寧', people, { fuzzy: true })?.via).toBe('fuzzy');
        // 「大陸姐」包含別名「陸姐」：不認
        expect(matchPerson('大陸姐', people, { fuzzy: true })).toBeNull();
    });

    it('fuzzy 的最短長度；空名字永遠不算', () => {
        const short = [{ name: '澈' }, { name: '' }];
        expect(matchPerson('阿澈', short, { fuzzy: true })).toBe(short[0]);
        expect(matchPerson('阿澈', short, { fuzzy: true, fuzzyMinLength: 2 })).toBeNull();
        expect(matchPerson('隨便', [{ name: '' }], { fuzzy: true })).toBeNull();
    });

    it('同名兩位：照名單順序拿第一個（跟以前一樣）', () => {
        const a = { id: 1, name: '小林' };
        const b = { id: 2, name: '小林' };
        expect(matchPerson('小林', [a, b])).toBe(a);
    });

    it('小號：本人的別名不會讓小號被認出來', () => {
        const owner = { id: 'c1', name: '阿澈', aliases: ['Che'] };
        const alt = { id: 'x1', name: '夜航', aliases: ['夜貓'], altOf: 'c1' };
        // 名單上只有小號（對方不知道是誰的小號）
        expect(matchPerson('Che', [alt])).toBeNull();
        expect(matchPerson('阿澈', [alt])).toBeNull();
        expect(matchPerson('夜貓', [alt])).toBe(alt);
    });

    it('personKey', () => {
        expect(personKey(' 「陆 薇宁」')).toBe(personKey('陸薇寧'));
        expect(personKey(null)).toBe('');
    });
});

describe('填別名時的撞名提醒', () => {
    const others = [{ name: '小陸' }, { name: '阿澈', aliases: ['Che', '澈哥'] }];
    it('撞到別人的名字、別人的別名都列出來；沒撞的不列', () => {
        expect(findAliasClashes(['小陸', 'che', 'Vivian'], '陸薇寧', others)).toEqual([
            { alias: '小陸', withName: '小陸', kind: 'name' },
            { alias: 'che', withName: '阿澈', kind: 'alias' },
        ]);
    });
    it('沒別名、沒別人：空', () => {
        expect(findAliasClashes([], '陸薇寧', others)).toEqual([]);
        expect(findAliasClashes(['Vivian'], '陸薇寧', [])).toEqual([]);
    });
});

describe('Sore 找角色：id → 名字剛好一位 → 別名剛好一位', () => {
    const pool = [{ id: 'c1', name: '陸薇寧', aliases: ['Vivian'] }, { id: 'c2', name: '小林' }, { id: 'c3', name: '小林' }, { id: 'c4', name: '阿澈', aliases: ['Vivian'] }];
    it('id、唯一的名字照舊', () => {
        expect(findPersonByRef('c2', pool)?.id).toBe('c2');
        expect(findPersonByRef('陸薇寧', pool)?.id).toBe('c1');
    });
    it('同名好幾位：不猜，要對方用 id', () => {
        expect(findPersonByRef('小林', pool)).toBeUndefined();
    });
    it('別名：剛好一位才算', () => {
        expect(findPersonByRef('vivian', [pool[0], pool[1]])?.id).toBe('c1');
        expect(findPersonByRef('Vivian', pool)).toBeUndefined();
        expect(peopleByAlias('Vivian', pool).map(p => p.id)).toEqual(['c1', 'c4']);
        expect(peopleByAlias('陸薇寧', pool)).toEqual([]);
        expect(findPersonByRef('', pool)).toBeUndefined();
    });
});
