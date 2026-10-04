import type { MallKind, MallOrder } from '../types';
import { makeMallId } from './shoppingMall';

/**
 * 購物中心訂單與配送（見 plans/mall-redesign.md）。配送狀態全照付款時間算，不存、不跑後台：
 * - 外賣：付款即「已下單」→ 8 分鐘商家接單、開始配送 → 40 分鐘送達。
 * - 購物：付款即「已下單」→ 2 小時出貨 → 隔天 14:00 送達（照用戶設備時區）。
 * 代付請求在角色付錢之前沒有 paidAt，顯示「等 TA 付款」；被拒就是取消。
 */

const MIN = 60_000;
export const FOOD_ACCEPT_MIN = 8;
export const FOOD_DELIVER_MIN = 40;
export const SHOP_SHIP_MIN = 120;
export const SHOP_DELIVER_HOUR = 14;

export interface MallDeliveryPlan {
    placedAt: number;
    /** 外賣：商家接單、騎手出發；購物：出貨 */
    dispatchAt: number;
    deliveredAt: number;
}

export function mallDeliveryPlan(kind: MallKind, paidAt: number): MallDeliveryPlan {
    if (kind === 'food') {
        return { placedAt: paidAt, dispatchAt: paidAt + FOOD_ACCEPT_MIN * MIN, deliveredAt: paidAt + FOOD_DELIVER_MIN * MIN };
    }
    const d = new Date(paidAt);
    const delivered = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, SHOP_DELIVER_HOUR, 0, 0, 0).getTime();
    return { placedAt: paidAt, dispatchAt: Math.min(paidAt + SHOP_SHIP_MIN * MIN, delivered), deliveredAt: delivered };
}

export type MallOrderStage = 'awaiting-payment' | 'cancelled' | 'placed' | 'on-the-way' | 'delivered';

export interface MallOrderStep {
    key: 'placed' | 'on-the-way' | 'delivered';
    label: string;
    at: number;
    done: boolean;
}

export interface MallOrderProgress {
    stage: MallOrderStage;
    /** 狀態短標籤：已下單／配送中／已出貨／已送達／等 TA 付款／已取消 */
    label: string;
    /** 三個節點；還沒付款或取消時是空的 */
    steps: MallOrderStep[];
    /** 預計／實際送達時間 */
    deliveredAt?: number;
}

export const STEP_LABELS: Record<MallKind, Record<MallOrderStep['key'], string>> = {
    food: { placed: '已下單', 'on-the-way': '配送中', delivered: '已送達' },
    shop: { placed: '已下單', 'on-the-way': '已出貨', delivered: '已送達' },
};

export function mallOrderProgress(
    order: { kind: MallKind; paidAt?: number; cancelledAt?: number },
    now: number = Date.now(),
): MallOrderProgress {
    if (order.cancelledAt) return { stage: 'cancelled', label: '已取消', steps: [] };
    if (!order.paidAt) return { stage: 'awaiting-payment', label: '等待付款', steps: [] };
    const plan = mallDeliveryPlan(order.kind, order.paidAt);
    const labels = STEP_LABELS[order.kind];
    const steps: MallOrderStep[] = [
        { key: 'placed', label: labels.placed, at: plan.placedAt, done: true },
        { key: 'on-the-way', label: labels['on-the-way'], at: plan.dispatchAt, done: now >= plan.dispatchAt },
        { key: 'delivered', label: labels.delivered, at: plan.deliveredAt, done: now >= plan.deliveredAt },
    ];
    const stage: MallOrderStage = now >= plan.deliveredAt ? 'delivered' : now >= plan.dispatchAt ? 'on-the-way' : 'placed';
    const label = stage === 'delivered' ? labels.delivered : stage === 'on-the-way' ? labels['on-the-way'] : labels.placed;
    return { stage, label, steps, deliveredAt: plan.deliveredAt };
}

/** 下一次狀態會變的時間（卡片／訂單頁用來排一個剛好的計時器），已經不會再變就是 null。 */
export function nextProgressChangeAt(order: { kind: MallKind; paidAt?: number; cancelledAt?: number }, now: number = Date.now()): number | null {
    if (order.cancelledAt || !order.paidAt) return null;
    const plan = mallDeliveryPlan(order.kind, order.paidAt);
    if (now < plan.dispatchAt) return plan.dispatchAt;
    if (now < plan.deliveredAt) return plan.deliveredAt;
    return null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 「14:20」；不是今天的加日期「10/5 14:00」。 */
export function formatOrderTime(ts: number, now: number = Date.now()): string {
    const d = new Date(ts);
    const n = new Date(now);
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
    return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** 卡片底下那一行：「配送中 · 約 14:20 送達」「已送達 14:20」「等 TA 付款」 */
export function progressLine(order: { kind: MallKind; paidAt?: number; cancelledAt?: number }, now: number = Date.now(), payerName = 'TA'): string {
    const p = mallOrderProgress(order, now);
    if (p.stage === 'cancelled') return '已取消';
    if (p.stage === 'awaiting-payment') return `等${payerName}付款`;
    if (p.stage === 'delivered') return `已送達 ${formatOrderTime(p.deliveredAt!, now)}`;
    return `${p.label} · 約 ${formatOrderTime(p.deliveredAt!, now)} 送達`;
}

export interface NewMallOrderInput {
    kind: MallKind;
    items: MallOrder['items'];
    note?: string;
    buyer: MallOrder['buyer'];
    recipient: MallOrder['recipient'];
    payer: MallOrder['payer'];
    charId?: string;
    charName?: string;
    /** 當下就付了（代付請求不傳） */
    paidAt?: number;
    createdAt?: number;
}

export function createMallOrder(input: NewMallOrderInput): MallOrder {
    const total = Math.round(input.items.reduce((s, i) => s + i.price * i.qty, 0) * 100) / 100;
    const createdAt = input.createdAt ?? Date.now();
    return {
        id: makeMallId('mallorder'),
        kind: input.kind,
        items: input.items.map(i => ({ ...i })),
        total,
        note: input.note?.trim() || undefined,
        buyer: input.buyer,
        recipient: input.recipient,
        payer: input.payer,
        charId: input.charId,
        charName: input.charName,
        createdAt,
        paidAt: input.paidAt,
    };
}

/** 訂單列表：全部列出，新的在上面（不按店去重，2026-10-04 定案）。 */
export function sortMallOrders(orders: MallOrder[]): MallOrder[] {
    return [...orders].sort((a, b) => b.createdAt - a.createdAt);
}

/** 「你 → Sully」這種一行：誰買給誰、誰付。 */
export function orderParties(order: MallOrder, userName = '你'): { from: string; to: string; payer: string } {
    const charName = order.charName || 'TA';
    return {
        from: order.buyer === 'user' ? userName : charName,
        to: order.recipient === 'user' ? userName : charName,
        payer: order.payer === 'user' ? userName : charName,
    };
}

/** 訂單／卡片的標題。 */
export function mallOrderTitle(
    o: { kind: MallKind; buyer: MallOrder['buyer']; recipient: MallOrder['recipient']; payer: MallOrder['payer'] },
    charName: string,
): string {
    const food = o.kind === 'food';
    if (o.buyer === 'user' && o.recipient === 'user' && o.payer === 'char') return `${food ? '外賣' : '購物'}代付請求`;
    if (o.buyer === 'user' && o.recipient === 'user') return food ? '你給自己點了外賣' : '你給自己買了東西';
    if (o.buyer === 'user') return food ? `你給${charName}點了外賣` : `你送給${charName}的禮物`;
    return food ? `${charName}給你點了外賣` : `${charName}送你的禮物`;
}

/**
 * 桌面入口「給誰」能挑的角色：拉黑中的（不管誰拉黑誰）不列——卡片送不進那個聊天。
 * 名字用角色卡上的 name，順序照角色列表。
 */
export function mallRecipientsFrom(characters: { id: string; name: string; chatBlock?: unknown }[]): { id: string; name: string }[] {
    return characters.filter(c => !c.chatBlock && c.name?.trim()).map(c => ({ id: c.id, name: c.name.trim() }));
}

/** 用戶付錢時記進銀行流水的那行字（聊天入口、桌面入口共用）。 */
export function mallSpendLabel(kind: MallKind, charName?: string): string {
    if (charName) return kind === 'food' ? `為${charName}點了外賣` : `送給${charName}的禮物`;
    return kind === 'food' ? '給自己點外賣' : '購物';
}
