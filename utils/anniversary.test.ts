import { describe, it, expect } from 'vitest';
import {
    anniversaryCharIds, anniversaryCharNames, nextOccurrenceDate,
    collectAnniversaryReminders, buildAnniversaryInjection,
} from './anniversary';

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

describe('collectAnniversaryReminders（讓 TA 記住這一天）', () => {
    const anni = (over: Partial<{ title: string; date: string; charId: string; charIds: string[]; charRemembers: boolean }> = {}) => ({
        title: '第一次約會', date: '2024-09-23', charId: 'c1', charRemembers: true, ...over,
    });

    it('當天：daysUntil 0，年數按原始年份算', () => {
        expect(collectAnniversaryReminders([anni()], 'c1', '2026-09-23', 3)).toEqual([
            { title: '第一次約會', occurrenceKey: '2026-09-23', daysUntil: 0, years: 2 },
        ]);
    });

    it('沒開 charRemembers 的不算', () => {
        expect(collectAnniversaryReminders([anni({ charRemembers: false })], 'c1', '2026-09-23', 3)).toEqual([]);
    });

    it('不是這個角色的不算；多選關聯對象裡有就算', () => {
        expect(collectAnniversaryReminders([anni()], 'c2', '2026-09-23', 3)).toEqual([]);
        expect(collectAnniversaryReminders([anni({ charIds: ['c1', 'c2'] })], 'c2', '2026-09-23', 3)).toHaveLength(1);
    });

    it('窗口外的不算，窗口內按近到遠排', () => {
        const list = [anni({ title: 'B', date: '2020-09-26' }), anni({ title: 'A', date: '2020-09-24' }), anni({ title: 'far', date: '2020-10-10' })];
        expect(collectAnniversaryReminders(list, 'c1', '2026-09-23', 3).map(r => [r.title, r.daysUntil])).toEqual([['A', 1], ['B', 3]]);
    });

    it('跨年：12/30 看得到 1/1', () => {
        const [r] = collectAnniversaryReminders([anni({ date: '2023-01-01' })], 'c1', '2026-12-30', 3);
        expect(r).toMatchObject({ occurrenceKey: '2027-01-01', daysUntil: 2, years: 4 });
    });

    it('原始日期還沒到：就是那天本身，年數 0', () => {
        const [r] = collectAnniversaryReminders([anni({ date: '2026-09-25' })], 'c1', '2026-09-23', 3);
        expect(r).toMatchObject({ occurrenceKey: '2026-09-25', daysUntil: 2, years: 0 });
    });

    it('2/29 在平年落到 2/28', () => {
        const [r] = collectAnniversaryReminders([anni({ date: '2024-02-29' })], 'c1', '2027-02-28', 3);
        expect(r).toMatchObject({ occurrenceKey: '2027-02-28', daysUntil: 0, years: 3 });
    });

    it('日期格式壞掉的直接跳過，不拋錯', () => {
        expect(collectAnniversaryReminders([anni({ date: '九月' })], 'c1', '2026-09-23', 3)).toEqual([]);
    });
});

describe('buildAnniversaryInjection', () => {
    const list = [
        { title: '第一次約會', date: '2024-09-23', charId: 'c1', charRemembers: true },
        { title: '她的生日', date: '2000-09-25', charId: 'c1', charRemembers: true },
    ];

    it('沒有要提的回空字串', () => {
        expect(buildAnniversaryInjection([], 'c1', '2026-09-23')).toBe('');
    });

    it('聊天：用今天／幾天後的說法，帶年數', () => {
        const text = buildAnniversaryInjection(list, 'c1', '2026-09-23');
        expect(text).toContain('今天（9月23日）是「第一次約會」，到這次是第 2 年');
        expect(text).toContain('2 天後（9月25日）是「她的生日」');
    });

    it('主動消息打包：只給絕對日期，不說「今天」', () => {
        const text = buildAnniversaryInjection(list, 'c1', '2026-09-23', { forFirePack: true });
        expect(text).toContain('9月23日「第一次約會」');
        expect(text).not.toContain('今天（');
    });

    it('主動消息打包的窗口比聊天寬（7 天）', () => {
        const far = [{ title: '一週後', date: '2020-09-29', charId: 'c1', charRemembers: true }];
        expect(buildAnniversaryInjection(far, 'c1', '2026-09-23')).toBe('');
        expect(buildAnniversaryInjection(far, 'c1', '2026-09-23', { forFirePack: true })).toContain('一週後');
    });
});
