import { describe, expect, it } from 'vitest';
import type { MallOrder } from '../../types';
import {
    addFollowup, buildGiftViews, expiredSecretIds, giftBucket, giftOrdersFor, giftStats, giftWrapFor, markGiven,
    matchOrderToPlan, newGift, newSecretPlan, orderGiftDir, overlayForOrder, plansDueSoon, SECRET_EXPIRE_MS,
} from './gift';

const DAY = 86400_000;
const order = (over: Partial<MallOrder>): MallOrder => ({
    id: 'o1', kind: 'shop', items: [{ name: '手沖壺', price: 40, qty: 1, emoji: '☕' }], total: 40,
    buyer: 'user', recipient: 'char', payer: 'user', charId: 'c1', createdAt: 1000, paidAt: 1000, ...over,
});

describe('禮物圖鑑：讀購物紀錄', () => {
    it('只有你買給 TA、TA 買給你算禮物；給自己的、代付不算', () => {
        expect(orderGiftDir({ buyer: 'user', recipient: 'char', payer: 'user' })).toBe('out');
        expect(orderGiftDir({ buyer: 'char', recipient: 'user', payer: 'char' })).toBe('in');
        expect(orderGiftDir({ buyer: 'user', recipient: 'user', payer: 'char' })).toBeNull();
        expect(orderGiftDir({ buyer: 'user', recipient: 'user', payer: 'user' })).toBeNull();
    });
    it('照線分：沒記線的算主線', () => {
        const os = [order({ id: 'a' }), order({ id: 'b', lineKey: 'c1::p2' }), order({ id: 'c', charId: 'c2' })];
        expect(giftOrdersFor(os, 'c1', 'c1').map(o => o.id)).toEqual(['a']);
        expect(giftOrdersFor(os, 'c1', 'c1::p2').map(o => o.id)).toEqual(['b']);
    });
    it('狀態照配送進度算：配送中是已買、送達是已送；代付沒付、取消的不列', () => {
        const now = 1000 + 3 * DAY;
        const views = buildGiftViews({
            orders: [order({ id: 'done' }), order({ id: 'new', paidAt: now - 1000, createdAt: now - 1000 }), order({ id: 'x', cancelledAt: 5 })],
            entries: [], forViewer: 'user', now,
        });
        expect(views.map(v => [v.key, v.state])).toEqual([['o:new', 'bought'], ['o:done', 'given']]);
    });
    it('補了東西的卡疊在訂單上，不會多一格', () => {
        const o = order({});
        const e = addFollowup(overlayForOrder('b', o, 5), { by: 'c1', text: '每天早上都用' }, 6);
        const views = buildGiftViews({ orders: [o], entries: [e], forViewer: 'user', now: 1000 + 3 * DAY });
        expect(views).toHaveLength(1);
        expect(views[0].followups.map(f => f.text)).toEqual(['每天早上都用']);
    });
});

describe('手記、打算送、TA 的打算', () => {
    it('打算送只有你看得到；TA 還沒送出的打算只有 TA 看得到', () => {
        const plan = newGift({ bondId: 'b', dir: 'out', state: 'planned', text: '黑膠唱片', now: 1 });
        const secret = newSecretPlan({ bondId: 'b', charId: 'c1', what: '一束乾燥尤加利', entries: [], now: 1 })!;
        const forUser = buildGiftViews({ orders: [], entries: [plan, secret], forViewer: 'user' });
        const forChar = buildGiftViews({ orders: [], entries: [plan, secret], forViewer: 'char' });
        expect(forUser.map(v => v.title)).toEqual(['黑膠唱片']);
        expect(giftBucket(forUser[0])).toBe('planned');
        expect(forChar.map(v => [v.title, v.secret])).toEqual([['一束乾燥尤加利', true]]);
    });
    it('買了打算送的那件：照品名連回訂單，狀態跟著訂單', () => {
        const plan = newGift({ bondId: 'b', dir: 'out', state: 'planned', text: '想送他一個好用的壺', productName: '手沖壺', now: 1 });
        const linked = matchOrderToPlan(order({}), [plan], 2)!;
        expect(linked.gift).toMatchObject({ orderId: 'o1', state: 'bought' });
        const views = buildGiftViews({ orders: [order({})], entries: [linked], forViewer: 'char', now: 1000 + 3 * DAY });
        expect(views).toHaveLength(1);
        expect(views[0].state).toBe('given');
    });
    it('TA 用 GIFT 送出了打算的那件：揭曉、記準備了幾天', () => {
        const secret = newSecretPlan({ bondId: 'b', charId: 'c1', what: '尤加利', entries: [], now: 0 })!;
        const o = order({ id: 'g', buyer: 'char', recipient: 'user', payer: 'char', items: [{ name: '乾燥尤加利花束', price: 30, qty: 1 }], paidAt: 12 * DAY, createdAt: 12 * DAY });
        const revealed = matchOrderToPlan(o, [secret], 12 * DAY)!;
        expect(revealed.gift!.secret!.revealedAt).toBe(12 * DAY);
        const v = buildGiftViews({ orders: [o], entries: [revealed], forViewer: 'user', now: 14 * DAY });
        expect(v[0]).toMatchObject({ dir: 'in', preparedDays: 12 });
    });
    it('TA 的打算：同時最多 3 件、同一件不重複、60 天沒送就作廢', () => {
        const a = newSecretPlan({ bondId: 'b', charId: 'c1', what: '圍巾', entries: [], now: 0 })!;
        expect(newSecretPlan({ bondId: 'b', charId: 'c1', what: '圍巾', entries: [a], now: 1 })).toBeNull();
        const b = newSecretPlan({ bondId: 'b', charId: 'c1', what: '書', entries: [a], now: 1 })!;
        const c = newSecretPlan({ bondId: 'b', charId: 'c1', what: '花', entries: [a, b], now: 1 })!;
        expect(newSecretPlan({ bondId: 'b', charId: 'c1', what: '錶', entries: [a, b, c], now: 2 })).toBeNull();
        expect(expiredSecretIds([a, b, c], SECRET_EXPIRE_MS)).toEqual([a.id]);
    });
    it('打算送的那天前三天提醒', () => {
        const p = newGift({ bondId: 'b', dir: 'out', state: 'planned', text: '蛋糕', plannedFor: '2026-12-01', now: 1 });
        expect(plansDueSoon([p], '2026-11-27')).toHaveLength(0);
        expect(plansDueSoon([p], '2026-11-28')).toHaveLength(1);
    });
    it('統計：送了幾件、收了幾件、第一件', () => {
        const hand = markGiven(newGift({ bondId: 'b', dir: 'out', state: 'planned', text: '手寫卡片', now: 1 }), 500);
        const views = buildGiftViews({ orders: [order({})], entries: [hand], forViewer: 'user', now: 1000 + 3 * DAY });
        const s = giftStats(views);
        expect(s.given).toBe(2);
        expect(s.first?.title).toBe('手寫卡片');
    });
    it('包裝：同一件永遠同一款', () => {
        expect(giftWrapFor('o:abc')).toEqual(giftWrapFor('o:abc'));
    });
});

import { bondPromptBlock } from './prompt';
import { extractGiftPlanTag, buildGiftPlanPrompt } from './giftTags';
import type { BondRecord } from '../../types';

describe('TA 偷偷準備的標籤', () => {
    it('剝掉標籤、收第一個；沒寫東西不算', () => {
        const r = extractGiftPlanTag('好啊，那下次見。\n[[ACTION:BOND_GIFT_PLAN|一條深藍色圍巾|下次見面]]\n[[BOND_GIFT_PLAN|書]]');
        expect(r.cleanedText).toBe('好啊，那下次見。');
        expect(r.plan).toEqual({ what: '一條深藍色圍巾', when: '下次見面' });
        expect(extractGiftPlanTag('嗯[[BOND_GIFT_PLAN|]]').plan).toBeNull();
        expect(extractGiftPlanTag('沒有標籤').cleanedText).toBe('沒有標籤');
    });
    it('沒空間、小號、拉黑中不教', () => {
        expect(buildGiftPlanPrompt({}, undefined, 'Liora')).toBe('');
        expect(buildGiftPlanPrompt({ altOf: 'c0' }, {}, 'Liora')).toBe('');
        expect(buildGiftPlanPrompt({}, {}, 'Liora')).toContain('BOND_GIFT_PLAN');
    });
});

describe('提示詞【你們的珍藏】', () => {
    const bond = { id: 'b', kind: 'persona', charId: 'c1', personaKey: 'p1', stage: 'friend', openedAt: 1, openedBy: 'auto', routeLog: [], days: {} } as unknown as BondRecord;
    const now = 1000 + 3 * DAY;
    it('沒有禮物一字不差；只有你打算送的也一字不差（驚喜）', () => {
        const base = bondPromptBlock({ bond, selfName: 'Sully', otherName: 'Liora', entries: [], selfId: 'c1' });
        const plan = newGift({ bondId: 'b', dir: 'out', state: 'planned', text: '黑膠唱片', now: 1 });
        expect(bondPromptBlock({ bond, selfName: 'Sully', otherName: 'Liora', entries: [plan], selfId: 'c1', giftOrders: [], now })).toBe(base);
        expect(base).toBe('');
    });
    it('送出、收到的照方向寫；後續帶最後一筆；自己偷偷準備的另一段', () => {
        const o = order({});
        const e = addFollowup(overlayForOrder('b', o, 5), { by: 'user', text: '每天早上都用' }, 6);
        const secret = newSecretPlan({ bondId: 'b', charId: 'c1', what: '一束尤加利', when: '她生日', entries: [], now: 2 })!;
        const out = bondPromptBlock({ bond, selfName: 'Sully', otherName: 'Liora', entries: [e, secret], selfId: 'c1', giftOrders: [o], now });
        expect(out).toContain('Liora送你的：手沖壺；後來：每天早上都用');
        expect(out).toContain('你在偷偷準備送Liora的');
        expect(out).toContain('  - 一束尤加利（打算她生日送）');
    });
});
