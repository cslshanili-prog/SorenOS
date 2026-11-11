import { describe, expect, it } from 'vitest';
import { dateDrafts, dateInflight, dateSuspend, pickQuickChatTargets, type QuickChatCandidate } from './dateSuspend';

const c = (id: string, lastAt: number | null, unread = 0): QuickChatCandidate => ({ id, name: id, lastAt, unread });

describe('pickQuickChatTargets', () => {
    it('有未讀的排最前面，其餘照最近聊過的排', () => {
        const picked = pickQuickChatTargets([c('a', 100), c('b', 300), c('c', 50, 2), c('d', 200)]);
        expect(picked.map(p => p.id)).toEqual(['c', 'b', 'd', 'a']);
    });

    it('有未讀的之間也照時間排', () => {
        const picked = pickQuickChatTargets([c('a', 100, 1), c('b', 300, 4), c('c', 500)]);
        expect(picked.map(p => p.id)).toEqual(['b', 'a', 'c']);
    });

    it('沒聊過也沒未讀的不列，最多 5 個', () => {
        const many = Array.from({ length: 9 }, (_, i) => c(`p${i}`, i * 10));
        const picked = pickQuickChatTargets([...many, c('never', null)]);
        expect(picked).toHaveLength(5);
        expect(picked.map(p => p.id)).toEqual(['p8', 'p7', 'p6', 'p5', 'p4']);
        expect(pickQuickChatTargets([c('never', null)])).toEqual([]);
    });
});

describe('dateSuspend', () => {
    it('掛起、按角色清、通知訂閱者', () => {
        let calls = 0;
        const off = dateSuspend.subscribe(() => { calls++; });
        dateSuspend.suspend({ charId: 'x', charName: 'X', cameFromChat: false });
        expect(dateSuspend.get()?.charId).toBe('x');
        dateSuspend.clear('other');
        expect(dateSuspend.get()?.charId).toBe('x');
        dateSuspend.clear('x');
        expect(dateSuspend.get()).toBeNull();
        expect(calls).toBe(2);
        off();
    });
});

describe('dateDrafts', () => {
    it('空字串就拿掉', () => {
        dateDrafts.set('x', '打到一半');
        expect(dateDrafts.get('x')).toBe('打到一半');
        dateDrafts.set('x', '');
        expect(dateDrafts.get('x')).toBe('');
    });
});

describe('dateInflight', () => {
    it('跑完（成功或失敗）就拿掉', async () => {
        let resolve!: () => void;
        const run = new Promise<void>(r => { resolve = r; });
        dateInflight.track('x', run);
        expect(dateInflight.get('x')).toBe(run);
        resolve();
        await run;
        await Promise.resolve();
        expect(dateInflight.get('x')).toBeNull();

        const failing = dateInflight.track('y', Promise.reject(new Error('boom')));
        await failing.catch(() => {});
        await Promise.resolve();
        expect(dateInflight.get('y')).toBeNull();
    });

    it('後一輪蓋過前一輪時，前一輪跑完不會把後一輪拿掉', async () => {
        let first!: () => void;
        const a = dateInflight.track('z', new Promise<void>(r => { first = r; }));
        const b = dateInflight.track('z', new Promise<void>(() => {}));
        first();
        await a;
        await Promise.resolve();
        expect(dateInflight.get('z')).toBe(b);
    });
});
