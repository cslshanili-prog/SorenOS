import { describe, it, expect } from 'vitest';
import { anniversaryCharIds, anniversaryCharNames, nextOccurrenceDate } from './anniversary';

describe('anniversaryCharIds', () => {
    it('有 charIds 时优先用 charIds', () => {
        expect(anniversaryCharIds({ charId: 'c1', charIds: ['c2', 'c3'] })).toEqual(['c2', 'c3']);
    });

    it('charIds 为空数组时兜底成 [charId]（旧数据没写过 charIds 或曾经被清空）', () => {
        expect(anniversaryCharIds({ charId: 'c1', charIds: [] })).toEqual(['c1']);
    });

    it('没有 charIds 字段（旧数据）时兜底成 [charId]', () => {
        expect(anniversaryCharIds({ charId: 'c1' })).toEqual(['c1']);
    });

    it('charId 也是空字符串时返回空数组，不产出脏元素', () => {
        expect(anniversaryCharIds({ charId: '' })).toEqual([]);
    });
});

describe('anniversaryCharNames', () => {
    const chars = [{ id: 'c1', name: '小夏' }, { id: 'c2', name: '阿凯' }];

    it('多个关联对象用顿号连接', () => {
        expect(anniversaryCharNames({ charId: 'c1', charIds: ['c1', 'c2'] }, chars)).toBe('小夏、阿凯');
    });

    it('单选（旧数据）正常显示一个名字', () => {
        expect(anniversaryCharNames({ charId: 'c1' }, chars)).toBe('小夏');
    });

    it('关联对象已被删除、找不到角色时兜底 Unknown', () => {
        expect(anniversaryCharNames({ charId: 'deleted-id' }, chars)).toBe('Unknown');
    });

    it('多个关联对象里有一个被删除，只显示还在的那些', () => {
        expect(anniversaryCharNames({ charId: 'c1', charIds: ['c1', 'deleted-id'] }, chars)).toBe('小夏');
    });
});

describe('nextOccurrenceDate', () => {
    const TODAY = '2026-09-15';

    it('非重复纪念日原样返回锚点日期，不管是过去还是未来', () => {
        expect(nextOccurrenceDate({ date: '2020-04-03', repeatAnnually: false }, TODAY)).toBe('2020-04-03');
        expect(nextOccurrenceDate({ date: '2099-01-01' }, TODAY)).toBe('2099-01-01');
    });

    it('重复纪念日：今年的月日还没到，换算成今年', () => {
        expect(nextOccurrenceDate({ date: '2020-12-25', repeatAnnually: true }, TODAY)).toBe('2026-12-25');
    });

    it('重复纪念日：今年的月日已经过了，换算成明年', () => {
        expect(nextOccurrenceDate({ date: '2020-04-03', repeatAnnually: true }, TODAY)).toBe('2027-04-03');
    });

    it('重复纪念日：今天正好是纪念日当天，算今年（不推到明年）', () => {
        expect(nextOccurrenceDate({ date: '2020-09-15', repeatAnnually: true }, TODAY)).toBe('2026-09-15');
    });
});
