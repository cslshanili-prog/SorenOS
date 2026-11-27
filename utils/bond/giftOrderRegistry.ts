/**
 * 送禮單（購物中心訂單裡的禮物）的記憶體登記表（plans/bond-batch5.md 1.1）。
 * 禮物圖鑑不另存購物紀錄，提示詞又是同步組的，所以把禮物單放一份在記憶體：
 * OSContext 開機讀一次，`DB.saveMallOrder`／`deleteMallOrder` 每次寫都跟著更新。零依賴。
 */
import type { MallOrder } from '../../types';

let __orders = new Map<string, MallOrder>();
const listeners = new Set<() => void>();
const isGift = (o: MallOrder) => !!o.charId && ((o.buyer === 'user' && o.recipient === 'char') || (o.buyer === 'char' && o.recipient === 'user'));

function emit(): void { for (const fn of listeners) fn(); }

export function setGiftOrderRegistry(orders: MallOrder[]): void {
    __orders = new Map(orders.filter(isGift).map(o => [o.id, o]));
    emit();
}

export function putGiftOrderInRegistry(order: MallOrder): void {
    if (!isGift(order)) { if (__orders.delete(order.id)) emit(); return; }
    __orders = new Map(__orders).set(order.id, order);
    emit();
}

export function dropGiftOrderFromRegistry(id: string): void {
    if (!__orders.has(id)) return;
    const next = new Map(__orders);
    next.delete(id);
    __orders = next;
    emit();
}

/** 某個角色的送禮單（全部線；分線用 utils/bond/gift.ts 的 giftOrdersFor） */
export function giftOrdersOfChar(charId: string): MallOrder[] {
    return [...__orders.values()].filter(o => o.charId === charId);
}

/** 一條線的送禮單（lineKey 照 chatLine 的 lineKey；舊單沒記線的算主線） */
export function giftOrdersOfLine(charId: string, lineKey: string): MallOrder[] {
    return giftOrdersOfChar(charId).filter(o => (o.lineKey || charId) === lineKey);
}

export function onGiftOrderRegistryChange(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}
