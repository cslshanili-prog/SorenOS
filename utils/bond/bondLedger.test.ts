import { describe, expect, it } from 'vitest';
import type { BondLedgerRow, Message } from '../../types';
import { levelInfo, levelThreshold } from './level';
import { addDays, countsOnDay, isoWeekKey, periodKeyOf, periodLastDay, previousPeriodKey } from './period';
import { checkDay, dayFacts } from './taskCheck';
import { achievedList, currentDayRun, factDaysOf, isCounted, ledgerKeyOf, ledgerRowId, longestDayRun, planAchievementRows, planBackfillTemplateRows, planDayRows, streakOf, totalPoints } from './ledger';
import { agreePromise, newPromise } from './pact';

const B = 'c1::p1';
const T = 1_800_000_000_000;
let nextId = 1;
const msg = (role: 'user' | 'assistant', content: string, extra: Partial<Message> = {}): Message => ({ id: nextId++, charId: 'c1', role, type: 'text', content, timestamp: T, ...extra });
const many = (role: 'user' | 'assistant', n: number) => Array.from({ length: n }, (_, i) => msg(role, `第 ${i} 句`));
const row = (key: string, periodKey: string, points = 10, extra: Partial<BondLedgerRow> = {}): BondLedgerRow => ({ id: ledgerRowId(B, key, periodKey), bondId: B, key, periodKey, at: T, points, how: 'auto', label: key, ...extra });

describe('等級門檻（定案表）', () => {
    it('前十級照表，之後級距每級多 200', () => {
        expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(levelThreshold)).toEqual([0, 60, 280, 600, 1200, 1800, 2600, 3600, 4800, 6200]);
        expect(levelThreshold(11)).toBe(7800);
        expect(levelThreshold(12)).toBe(9600);
    });
    it('照分數算等級與進度；聊幾句＋晚安一天 20 分，三天到 Lv.2', () => {
        expect(levelInfo(0)).toMatchObject({ level: 1, next: 60, need: 60 });
        expect(levelInfo(59).level).toBe(1);
        expect(levelInfo(60)).toMatchObject({ level: 2, floor: 60, next: 280 });
        expect(levelInfo(20 * 3).level).toBe(2);
        expect(levelInfo(20 * 14).level).toBe(3);
        expect(levelInfo(7800).level).toBe(11);
    });
});

describe('期', () => {
    it('每週照 ISO 週，跨年也對', () => {
        expect(isoWeekKey('2026-11-26')).toBe('2026-W48');
        expect(isoWeekKey('2027-01-01')).toBe('2026-W53');
        expect(periodLastDay({ kind: 'weekly' }, '2026-W48')).toBe('2026-11-29');
        expect(previousPeriodKey({ kind: 'weekly' }, '2027-W01')).toBe('2026-W53');
    });
    it('每月、每年、每幾天、一次', () => {
        expect(periodKeyOf({ kind: 'monthly' }, '2026-11-26')).toBe('2026-11');
        expect(periodLastDay({ kind: 'monthly' }, '2026-02')).toBe('2026-02-28');
        expect(previousPeriodKey({ kind: 'monthly' }, '2026-01')).toBe('2025-12');
        expect(periodKeyOf({ kind: 'everyNDays', n: 3 }, '2026-11-26', '2026-11-20')).toBe('2026-11-26');
        expect(periodKeyOf({ kind: 'everyNDays', n: 3 }, '2026-11-25', '2026-11-20')).toBe('2026-11-23');
        expect(periodKeyOf({ kind: 'once' }, '2026-11-26')).toBe('once');
    });
    it('指定星期幾、每年那天才算數', () => {
        expect(countsOnDay({ kind: 'weekly', days: [4] }, '2026-11-26')).toBe(true); // 週四
        expect(countsOnDay({ kind: 'weekly', days: [1] }, '2026-11-26')).toBe(false);
        expect(countsOnDay({ kind: 'yearly', date: '11-26' }, '2026-11-26')).toBe(true);
        expect(countsOnDay({ kind: 'yearly', date: '11-27' }, '2026-11-26')).toBe(false);
    });
});

describe('一天的事實', () => {
    it('聊幾句：你 3 則、TA 1 則；深聊：你 20、TA 10；不算通話、見面、羈絆通知', () => {
        expect(dayFacts([...many('user', 2), ...many('assistant', 5)]).hits.chat).toBeUndefined();
        const f = dayFacts([...many('user', 3), msg('assistant', '嗯'), msg('assistant', '日記放好了', { metadata: { source: 'bond-output' } })]);
        expect(f.hits.chat).toHaveLength(4);
        expect(f.charCount).toBe(1);
        expect(dayFacts([...many('user', 19), ...many('assistant', 10)]).hits.deepChat).toBeUndefined();
        expect(dayFacts([...many('user', 20), ...many('assistant', 10)]).hits.deepChat).toBeTruthy();
        const callOnly = dayFacts([...Array.from({ length: 5 }, () => msg('user', '喂', { metadata: { source: 'call' } })), msg('assistant', '嗯', { metadata: { source: 'call' } })]);
        expect(callOnly.hits.chat).toBeUndefined();
        expect(callOnly.hits.call).toBeTruthy();
    });
    it('晚安要雙方都說；照片、見面、一起聽歌、禮物', () => {
        expect(dayFacts([msg('user', '晚安')]).hits.goodnight).toBeUndefined();
        expect(dayFacts([msg('user', '我先睡了'), msg('assistant', 'Good night~')]).hits.goodnight).toBeTruthy();
        expect(dayFacts([msg('assistant', 'x', { type: 'image' })]).hits.photo).toBeTruthy();
        expect(dayFacts([msg('assistant', 'x', { metadata: { source: 'date' } })]).hits.date).toBeTruthy();
        expect(dayFacts([msg('assistant', 'x', { type: 'music_card', metadata: { intent: 'add' } })]).hits.music).toBeUndefined();
        expect(dayFacts([msg('assistant', 'x', { type: 'music_card', metadata: { intent: 'join_and_add' } })]).hits.music).toBeTruthy();
        const g = dayFacts([msg('assistant', 'x', { type: 'mall_order', metadata: { mode: 'gift', status: 'sent' } })]);
        expect(g.hits.giftIn).toBeTruthy();
        expect(g.hits.giftOut).toBeUndefined();
    });
    it('關鍵字：雙方都要說，或一方說就算', () => {
        const ms = [msg('user', '今天有去跑步喔'), msg('assistant', '好棒')];
        const f = dayFacts(ms);
        expect(checkDay({ kind: 'keyword', words: ['跑步'], both: true }, f, ms).done).toBe(false);
        expect(checkDay({ kind: 'keyword', words: ['跑步'], both: false }, f, ms).done).toBe(true);
        expect(checkDay({ kind: 'manual' }, f, ms).done).toBe(false);
    });
});

describe('記帳：不重複、撤銷不自動加回', () => {
    const active = (repeat = { kind: 'daily' } as const, templateId?: string) => {
        const p = newPromise({ bondId: B, author: 'user', text: '每天聊幾句', repeat, check: { kind: 'record', record: 'chat' }, points: 10, participants: ['user', 'c1'], templateId, now: new Date(2026, 10, 20, 9).getTime() });
        return agreePromise(p, 'char', new Date(2026, 10, 20, 10).getTime());
    };
    const ms = [...many('user', 3), msg('assistant', '好')];
    const facts = dayFacts(ms);

    it('一天的事實（0 分）＋做到的約定；模板做的用模板鍵', () => {
        const p = active({ kind: 'daily' }, 'chat');
        const rows = planDayRows({ bondId: B, day: '2026-11-26', facts, messages: ms, promises: [p], existing: new Map(), how: 'auto', now: T });
        expect(rows.map(r => [r.key, r.periodKey, r.points])).toEqual([['fact:chat', '2026-11-26', 0], ['tpl:chat', '2026-11-26', 10]]);
        expect(ledgerKeyOf(p)).toBe('tpl:chat');
    });
    it('約定開始以前的日子不算；已經有（含撤銷的）不重記', () => {
        const p = active();
        expect(planDayRows({ bondId: B, day: '2026-11-19', facts, messages: ms, promises: [p], existing: new Map(), how: 'auto', now: T }).filter(r => r.points)).toEqual([]);
        const revoked = row(p.id, '2026-11-26', 10, { revokedAt: T });
        const again = planDayRows({ bondId: B, day: '2026-11-26', facts, messages: ms, promises: [p], existing: new Map([[revoked.id, revoked]]), how: 'auto', now: T });
        expect(again.some(r => r.key === p.id)).toBe(false);
    });
    it('總分不算撤銷的、AI 判沒做到的', () => {
        const rows = [row('a', '2026-11-25'), row('a', '2026-11-26', 10, { revokedAt: T }), row('b', 'once', 30, { miss: true }), row('c', 'once', 50)];
        expect(rows.filter(isCounted)).toHaveLength(2);
        expect(totalPoints(rows)).toBe(60);
    });
    it('補算只補勾的模板、照預設分數、標補算', () => {
        const f = dayFacts([...many('user', 3), msg('assistant', '晚安'), msg('user', '晚安')]);
        const rows = planBackfillTemplateRows(B, '2026-10-01', f, ['chat', 'goodnight', 'call'], new Map(), 'friendship', T);
        expect(rows.map(r => [r.key, r.points, r.how, r.label])).toEqual([['tpl:chat', 10, 'backfill', '今天聊幾句'], ['tpl:goodnight', 10, 'backfill', '睡前說一聲']]);
    });
});

describe('連續天數', () => {
    const daily = { kind: 'daily' } as const;
    it('今天還沒做不算斷；斷了 current 歸零、best 留著', () => {
        const rows = ['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-24', '2026-11-25'].map(d => row('k', d));
        expect(streakOf(rows, 'k', daily, '2026-11-26')).toEqual({ current: 2, best: 3 });
        expect(streakOf([...rows, row('k', '2026-11-26')], 'k', daily, '2026-11-26')).toEqual({ current: 3, best: 3 });
        expect(streakOf(rows, 'k', daily, '2026-11-28')).toEqual({ current: 0, best: 3 });
    });
    it('每週的照週算', () => {
        const rows = ['2026-W46', '2026-W47'].map(w => row('w', w));
        expect(streakOf(rows, 'w', { kind: 'weekly' }, '2026-11-26')).toEqual({ current: 2, best: 2 });
    });
    it('事實的天數：最長與現在', () => {
        const days = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-10', '2026-11-25', '2026-11-26'];
        expect(longestDayRun(days)).toBe(3);
        expect(currentDayRun(days, '2026-11-26')).toBe(2);
        expect(currentDayRun(days, addDays('2026-11-26', 1))).toBe(2);
    });
});

describe('成就', () => {
    const base = { factDays: {}, trips: [], questionsRevealed: 0, diariesBoth: 0, slipsDelivered: 0, anniversaries: 0, milestones: 0, wishesDone: 0, habits: 0 };
    it('第一次、連續、次數；旅行第一趟 80、之後每趟 40', () => {
        const list = achievedList({
            ...base,
            factDays: { call: ['2026-11-02'], chat: Array.from({ length: 8 }, (_, i) => addDays('2026-11-01', i)) },
            trips: [{ id: 't2', from: '2026-12-01', destination: '京都' }, { id: 't1', from: '2026-10-01', destination: '花蓮' }],
            questionsRevealed: 10, slipsDelivered: 9, wishesDone: 1, habits: 1,
        });
        const got = list.map(a => `${a.key}|${a.periodKey}|${a.points}`);
        expect(got).toEqual([
            'ach:first-call|once|30',
            'ach:first-trip|once|80', 'ach:trip|t2|40',
            'ach:streak|n:3|20', 'ach:streak|n:7|50',
            'ach:questions|n:1|20', 'ach:questions|n:10|50',
            'ach:wishes|n:1|50',
            'ach:first-habit|once|30',
        ]);
        expect(list.find(a => a.key === 'ach:first-trip')!.label).toContain('花蓮');
    });
    it('已經記過的不再記', () => {
        const s = { ...base, factDays: { date: ['2026-11-26'] } };
        const existing = new Map([[ledgerRowId(B, 'ach:first-date', 'once'), row('ach:first-date', 'once', 50)]]);
        expect(planAchievementRows(B, s, existing, 'auto', T)).toEqual([]);
        expect(planAchievementRows(B, s, new Map(), 'backfill', T)).toMatchObject([{ key: 'ach:first-date', points: 50, how: 'backfill', group: '第一次见面' }]);
    });
    it('事實天數從帳本讀（撤銷的不算）', () => {
        const rows = [row('fact:chat', '2026-11-25', 0), row('fact:chat', '2026-11-26', 0, { revokedAt: T }), row('fact:call', '2026-11-26', 0)];
        expect(factDaysOf(rows)).toEqual({ chat: ['2026-11-25'], call: ['2026-11-26'] });
    });
});

import { bondPromptBlock } from './prompt';
import { blankBond } from './model';

describe('提示詞：等級與這期做了沒', () => {
    const bond = blankBond(B, T);
    const promise = agreePromise(newPromise({ bondId: B, author: 'user', text: '每天說晚安', repeat: { kind: 'daily' }, check: { kind: 'record', record: 'goodnight' }, points: 10, participants: ['user', 'c1'], now: new Date(2026, 10, 20, 9).getTime() }), 'char', new Date(2026, 10, 20, 10).getTime());
    const base = (extra: Partial<Parameters<typeof bondPromptBlock>[0]>) => bondPromptBlock({ bond, selfName: 'Sully', otherName: 'Liora', selfId: 'c1', ...extra });
    it('帳本只有 0 分的事實、沒有約定類的卡：一字不差', () => {
        expect(base({ entries: [], ledger: [row('fact:chat', '2026-11-26', 0)], today: '2026-11-26' })).toBe(base({ entries: [] }));
    });
    it('有分數就帶等級；約定帶這期做了沒、連續天數', () => {
        const ledger = ['2026-11-24', '2026-11-25'].map(d => row(promise.id, d, 10));
        const out = base({ entries: [promise], ledger, today: '2026-11-26' });
        expect(out).toContain('你們的羈絆等級是 Lv.1');
        expect(out).toContain('  - 每天：每天說晚安（今天還沒；已經連續 2 天）');
        const done = base({ entries: [promise], ledger: [...ledger, row(promise.id, '2026-11-26', 10)], today: '2026-11-26' });
        expect(done).toContain('（今天已經做到了；已經連續 3 天）');
        expect(base({ entries: [promise], ledger: Array.from({ length: 7 }, (_, i) => row('ach:x', `n:${i}`, 10)) })).toContain('Lv.2');
    });
});
