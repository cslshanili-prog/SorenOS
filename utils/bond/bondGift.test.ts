import { describe, expect, it } from 'vitest';
import type { MallOrder } from '../../types';
import {
    buildGiftSummaryPrompt, dropGiftPending, FOLLOWUP_PENDING_MAX, giftsForSummary, parseGiftSummary, withGiftSummaryChecked, type GiftView,
    addFollowup, buildGiftViews, expiredSecretIds, giftBucket, giftOrdersFor, giftStats, giftWrapFor, markGiven,
    matchOrderToPlan, newGift, orderCountsAsGift, withOrderCounts, newSecretPlan, orderGiftDir, overlayForOrder, plansDueSoon, SECRET_EXPIRE_MS,
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

describe('每日總結對禮物後續（第 6 節）', () => {
    const gifts = [{ key: 'o:1', title: '手錶', dir: 'out' as const }, { key: 'e:g2', title: '書籤', dir: 'in' as const }];

    it('提示詞列 G 編號與總結；解析換回那件、同一件只留一句、對不上的丟掉', () => {
        const p = buildGiftSummaryPrompt({ summary: 'Sully 戴著手錶去開會。', date: '2026-11-27', gifts, leftName: 'Liora', rightName: 'Sully' });
        expect(p).toContain('G1 Liora送給Sully：手錶');
        expect(p).toContain('G2 Sully送給Liora：書籤');
        expect(p).toContain('【2026-11-27 的總結】');
        const out = parseGiftSummary('```json\n[{"gift":"G1","text":"Sully 戴著那支錶去開會"},{"gift":"1","text":"重複的"},{"gift":"G7","text":"對不上"},{"gift":"G2","text":""}]\n```', gifts);
        expect(out).toEqual([{ gift: gifts[0], text: 'Sully 戴著那支錶去開會' }]);
        expect(parseGiftSummary('沒有', gifts)).toEqual([]);
    });

    it('只對已經送出的；打算送、還在路上、TA 還沒揭曉的不算', () => {
        const v = (key: string, over: Partial<GiftView>): GiftView => ({ key, dir: 'out', state: 'given', title: key, items: [], at: 0, photos: [], followups: [], ...over });
        expect(giftsForSummary([v('a', {}), v('b', { state: 'planned' }), v('c', { state: 'bought' }), v('d', { secret: true })]).map(x => x.key)).toEqual(['a']);
    });

    it('記下對過的總結；抓到的放待確認、不重複、超過上限丟舊的；按掉就拿掉', () => {
        const base = { id: 'c1::p', updatedAt: 0 } as BondRecord;
        const b1 = withGiftSummaryChecked(base, 'm1', [{ giftKey: 'o:1', giftTitle: '手錶', text: '戴去開會' }], '2026-11-27', 100);
        expect(b1.giftSummaryChecked).toEqual({ m1: 100 });
        expect(b1.giftFollowupPending).toHaveLength(1);
        expect(b1.giftFollowupPending![0]).toMatchObject({ giftKey: 'o:1', memoryId: 'm1', date: '2026-11-27' });
        const b2 = withGiftSummaryChecked(b1, 'm2', [{ giftKey: 'o:1', giftTitle: '手錶', text: '戴去開會' }], undefined, 200);
        expect(b2.giftFollowupPending).toHaveLength(1);
        expect(Object.keys(b2.giftSummaryChecked!)).toEqual(['m2', 'm1']);
        let b = b2;
        for (let i = 0; i < FOLLOWUP_PENDING_MAX + 3; i++) b = withGiftSummaryChecked(b, `x${i}`, [{ giftKey: 'e:g2', giftTitle: '書籤', text: `第 ${i} 次` }], undefined, 300 + i);
        expect(b.giftFollowupPending).toHaveLength(FOLLOWUP_PENDING_MAX);
        expect(b.giftFollowupPending!.at(-1)!.text).toBe(`第 ${FOLLOWUP_PENDING_MAX + 2} 次`);
        const id = b.giftFollowupPending![0].id;
        expect(dropGiftPending(b, id).giftFollowupPending!.some(p => p.id === id)).toBe(false);
        // 沒抓到也記成對過
        expect(withGiftSummaryChecked(base, 'm9', [], undefined, 5)).toMatchObject({ giftSummaryChecked: { m9: 5 }, giftFollowupPending: [] });
    });
});

describe('外賣不算禮物、手動算進／移出', () => {
    const now = 30 * DAY;
    const food = order({ id: 'f', kind: 'food', items: [{ name: '鮮餛飩雞湯', price: 12, qty: 1 }], paidAt: 2 * DAY, createdAt: 2 * DAY });
    const shop = order({ id: 's', paidAt: 3 * DAY, createdAt: 3 * DAY });
    const keys = (entries: Parameters<typeof buildGiftViews>[0]['entries'], forViewer: 'user' | 'char' = 'user') =>
        buildGiftViews({ orders: [food, shop], entries, forViewer, now }).map(v => v.key);

    it('預設：商城的算、外賣不算（你看的、TA 看的都一樣）', () => {
        expect(orderCountsAsGift(food)).toBe(false);
        expect(orderCountsAsGift(shop)).toBe(true);
        expect(keys([])).toEqual(['o:s']);
        expect(keys([], 'char')).toEqual(['o:s']);
    });

    it('外賣按「算禮物」就進圖鑑；商城的按「不算」就出去，疊上去的卡也不另外列', () => {
        const inFood = withOrderCounts('b1', food, undefined, true, now);
        expect(inFood.gift).toMatchObject({ orderId: 'f', counts: true });
        expect(keys([inFood])).toEqual(['o:s', 'o:f']);
        const outShop = withOrderCounts('b1', shop, undefined, false, now);
        expect(keys([inFood, outShop])).toEqual(['o:f']);
        // 已經有卡（補過照片、後續）的照樣改那張，東西都留著
        const withNote = addFollowup(overlayForOrder('b1', shop, now), { by: 'user', text: '擺在桌上' }, now);
        const off = withOrderCounts('b1', shop, withNote, false, now);
        expect(off.id).toBe(withNote.id);
        expect(off.gift!.followups).toHaveLength(1);
        expect(keys([off])).toEqual([]);
        expect(keys([withOrderCounts('b1', shop, off, true, now)])).toEqual(['o:s']);
    });

    it('打算送的、TA 準備的走外賣送出：連回時自動算禮物', () => {
        const plan = newGift({ bondId: 'b1', dir: 'out', state: 'planned', text: '鮮餛飩雞湯', now: DAY });
        const hit = matchOrderToPlan(food, [plan], now)!;
        expect(hit.gift).toMatchObject({ orderId: 'f', counts: true });
        expect(keys([hit])).toContain('o:f');
        // 商城的照舊不寫 counts（照預設算）
        const plan2 = newGift({ bondId: 'b1', dir: 'out', state: 'planned', text: '手沖壺', now: DAY });
        expect(matchOrderToPlan(shop, [plan2], now)!.gift!.counts).toBeUndefined();
    });
});
