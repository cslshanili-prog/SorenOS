import { describe, it, expect } from 'vitest';
import {
    createMallOrder, mallDeliveryPlan, mallOrderProgress, nextProgressChangeAt, progressLine,
    sortMallOrders, mallOrderTitle, orderParties,
} from './mallOrders';

const MIN = 60_000;
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

describe('配送時間', () => {
    it('外賣：8 分鐘接單配送、40 分鐘送達', () => {
        const paid = at(2026, 10, 4, 12, 0);
        const plan = mallDeliveryPlan('food', paid);
        expect(plan.dispatchAt - paid).toBe(8 * MIN);
        expect(plan.deliveredAt - paid).toBe(40 * MIN);
    });

    it('購物：2 小時出貨、隔天 14:00 送達；深夜下單出貨不晚於送達', () => {
        const paid = at(2026, 10, 4, 23, 30);
        const plan = mallDeliveryPlan('shop', paid);
        expect(plan.deliveredAt).toBe(at(2026, 10, 5, 14, 0));
        expect(plan.dispatchAt).toBe(paid + 120 * MIN);
        // 月底跨月
        expect(mallDeliveryPlan('shop', at(2026, 10, 31, 9)).deliveredAt).toBe(at(2026, 11, 1, 14));
    });
});

describe('mallOrderProgress', () => {
    const paid = at(2026, 10, 4, 12, 0);
    const order = { kind: 'food' as const, paidAt: paid };

    it('按時間推進：已下單 → 配送中 → 已送達', () => {
        expect(mallOrderProgress(order, paid + 1 * MIN).stage).toBe('placed');
        expect(mallOrderProgress(order, paid + 8 * MIN).stage).toBe('on-the-way');
        expect(mallOrderProgress(order, paid + 8 * MIN).label).toBe('配送中');
        const done = mallOrderProgress(order, paid + 40 * MIN);
        expect(done.stage).toBe('delivered');
        expect(done.steps.every(s => s.done)).toBe(true);
    });

    it('購物的中間站叫「已出貨」', () => {
        expect(mallOrderProgress({ kind: 'shop', paidAt: paid }, paid + 3 * 60 * MIN).label).toBe('已出貨');
    });

    it('沒付款是等待付款、取消優先', () => {
        expect(mallOrderProgress({ kind: 'food' }).stage).toBe('awaiting-payment');
        expect(mallOrderProgress({ kind: 'food', paidAt: paid, cancelledAt: paid }).stage).toBe('cancelled');
    });

    it('nextProgressChangeAt 指向下一個節點，送達後是 null', () => {
        expect(nextProgressChangeAt(order, paid)).toBe(paid + 8 * MIN);
        expect(nextProgressChangeAt(order, paid + 10 * MIN)).toBe(paid + 40 * MIN);
        expect(nextProgressChangeAt(order, paid + 41 * MIN)).toBeNull();
        expect(nextProgressChangeAt({ kind: 'food' })).toBeNull();
    });

    it('progressLine 的幾種說法', () => {
        expect(progressLine(order, paid + 10 * MIN)).toBe('配送中 · 約 12:40 送達');
        expect(progressLine(order, paid + 50 * MIN)).toBe('已送達 12:40');
        expect(progressLine({ kind: 'food' }, paid, 'Sully')).toBe('等Sully付款');
        expect(progressLine({ kind: 'shop', paidAt: paid }, paid + MIN)).toBe('已下單 · 約 10/5 14:00 送達');
    });
});

describe('訂單', () => {
    it('createMallOrder 自己算合計、空留言不存', () => {
        const o = createMallOrder({
            kind: 'food', buyer: 'user', recipient: 'char', payer: 'user', charId: 'c1', charName: 'Sully',
            items: [{ name: '拿鐵', price: 6.5, qty: 2 }, { name: '餅乾', price: 5.75, qty: 1 }], note: '  ', paidAt: 1,
        });
        expect(o.total).toBe(18.75);
        expect(o.note).toBeUndefined();
        expect(o.id).toMatch(/^mallorder-/);
    });

    it('列表新的在上面，不去重', () => {
        const mk = (createdAt: number) => createMallOrder({ kind: 'food', buyer: 'user', recipient: 'user', payer: 'user', items: [], createdAt });
        expect(sortMallOrders([mk(1), mk(3), mk(2)]).map(o => o.createdAt)).toEqual([3, 2, 1]);
    });

    it('標題與誰給誰', () => {
        const base = { kind: 'food' as const };
        expect(mallOrderTitle({ ...base, buyer: 'user', recipient: 'char', payer: 'user' }, 'Sully')).toBe('你給Sully點了外賣');
        expect(mallOrderTitle({ ...base, buyer: 'user', recipient: 'user', payer: 'user' }, 'Sully')).toBe('你給自己點了外賣');
        expect(mallOrderTitle({ ...base, buyer: 'user', recipient: 'user', payer: 'char' }, 'Sully')).toBe('外賣代付請求');
        expect(mallOrderTitle({ kind: 'shop', buyer: 'char', recipient: 'user', payer: 'char' }, 'Sully')).toBe('Sully送你的禮物');
        const o = createMallOrder({ kind: 'shop', buyer: 'user', recipient: 'user', payer: 'char', charName: 'Sully', items: [] });
        expect(orderParties(o)).toEqual({ from: '你', to: '你', payer: 'Sully' });
    });
});
