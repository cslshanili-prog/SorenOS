import { describe, expect, it } from 'vitest';
import { bondHasContent, isBondOpen, pickHomeSpace, planOpenMigration, withOpenState } from './openState';
import { blankBond } from './model';
import { listKnownPersonaSpaces, listPairSpaces, listPersonaSpaces } from './spaces';
import { canInviteBond } from './invite';
import { canProposePact } from './pactTags';
import { setBondRegistry } from './registry';

const none = { entries: 0, diaries: 0 };

describe('空間開了才有', () => {
    it('有內容才算：路線、此刻的我們、天數、卡片、日記、你建的、邀請答應的', () => {
        const b = blankBond('c1::p1', 1);
        expect(bondHasContent(b, none)).toBe(false);
        expect(bondHasContent({ ...b, route: 'romance', stage: 'lovers' }, none)).toBe(true);
        expect(bondHasContent({ ...b, ourNow: { char: { text: '最近', at: 1 } } }, none)).toBe(true);
        expect(bondHasContent({ ...b, days: { primary: 'met', extra: [{ id: 'x', kind: 'together', date: '2026-01-01' }] } } as any, none)).toBe(true);
        expect(bondHasContent(b, { entries: 1, diaries: 0 })).toBe(true);
        expect(bondHasContent(b, { entries: 0, diaries: 2 })).toBe(true);
        expect(bondHasContent({ ...b, openedBy: 'char' }, none)).toBe(true);
        // 背景寫進來的（問過要不要承認）不算
        expect(bondHasContent({ ...b, syncAsked: { k: 1 } }, none)).toBe(false);
    });

    it('搬遷：有內容的記成開著；已經有開關狀態的不動；表裡沒紀錄但有卡的補一筆', () => {
        const empty = blankBond('c1::p1', 1);
        const rich = { ...blankBond('c2::p1', 1), route: 'friendship' as const };
        const closed = withOpenState(blankBond('c3::p1', 1), 'closed', 'user', 2);
        const plan = planOpenMigration({
            bonds: [empty, rich, closed], orphanIds: ['c4::p1', 'c1::p1'],
            counts: id => (id === 'c4::p1' ? { entries: 2, diaries: 0 } : none), blank: id => blankBond(id, 1), now: 9,
        });
        expect(plan.map(b => [b.id, b.openState])).toEqual([
            ['c2::p1', { state: 'open', at: 9, via: 'migrate' }],
            ['c4::p1', { state: 'open', at: 9, via: 'migrate' }],
        ]);
    });

    it('清單只列開著的；可以開的另外列', () => {
        const chars = [{ id: 'c1', knownPersonaKeys: ['p1'] }, { id: 'c2', knownPersonaKeys: ['p1'] }, { id: 'alt', altOf: 'c1', knownPersonaKeys: ['p1'] }] as any;
        const bonds = [
            withOpenState(blankBond('c1::p1', 1), 'open', 'user', 2),
            withOpenState(blankBond('c2::p1', 1), 'closed', 'user', 2),
            withOpenState(blankBond('pair~c1~c2', 1), 'open', 'user', 2),
            blankBond('pair~c1~alt', 1),
        ];
        expect(listPersonaSpaces(chars, bonds).map(s => s.id)).toEqual(['c1::p1']);
        expect(listKnownPersonaSpaces(chars, bonds).map(s => s.id)).toEqual(['c1::p1', 'c2::p1']);
        expect(listPairSpaces(bonds, chars).map(s => s.id)).toEqual(['pair~c1~c2']);
    });

    it('進 App 開哪個：上次停留的（還開著）＞最近動過的', () => {
        const a = { id: 'a', updatedAt: 5, openState: { state: 'open' as const, at: 1, via: 'user' as const } };
        const b = { id: 'b', updatedAt: 9, openState: { state: 'open' as const, at: 1, via: 'user' as const } };
        expect(pickHomeSpace([a, b], 'a')).toBe('a');
        expect(pickHomeSpace([a, b], 'gone')).toBe('b');
        expect(pickHomeSpace([], 'a')).toBeNull();
    });

    it('角色邀請：沒開、沒收起、沒說先不要才教；提議約定與準備禮物要空間開著', () => {
        const char = { id: 'c1', primaryPersonaKey: 'p1' } as any;
        setBondRegistry([]);
        expect(canInviteBond(char)).toBe(true);
        setBondRegistry([{ ...blankBond('c1::p1', 1), syncAsked: { k: 1 } }]);
        expect(canInviteBond(char)).toBe(true);
        setBondRegistry([withOpenState(blankBond('c1::p1', 1), 'closed', 'user')]);
        expect(canInviteBond(char)).toBe(false);
        setBondRegistry([{ ...blankBond('c1::p1', 1), inviteDeclinedAt: 3 }]);
        expect(canInviteBond(char)).toBe(false);
        setBondRegistry([]);
        expect(canProposePact({}, blankBond('c1::p1', 1))).toBe(false);
        expect(canProposePact({}, withOpenState(blankBond('c1::p1', 1), 'open', 'user'))).toBe(true);
        expect(isBondOpen(undefined)).toBe(false);
    });
});

describe('羈絆的淺色／深色', async () => {
    const { resolveBondTheme } = await import('./theme');
    it('自己選的優先；跟著手機看系統，系統主題開深色也算', () => {
        expect(resolveBondTheme('dark', false)).toBe('dark');
        expect(resolveBondTheme('light', true, true)).toBe('light');
        expect(resolveBondTheme('system', true)).toBe('dark');
        expect(resolveBondTheme('system', false, true)).toBe('dark');
        expect(resolveBondTheme('system', false)).toBe('light');
    });
});
