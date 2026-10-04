import React, { useEffect, useState } from 'react';
import { formatMoney } from '../../utils/realBalance';
import { mallOrderTitle, nextProgressChangeAt, progressLine } from '../../utils/mallOrders';
import type { Message } from '../../types';

export interface MallOrderItem {
    name: string;
    price: number;
    qty: number;
    emoji?: string;
    detail?: string;
    /** 店鋪／品牌（2026-10 起） */
    shop?: string;
}

/** apps/Chat.tsx 落庫時寫進 metadata 的形狀；跟 utils/shoppingMall.ts 的 MallProduct 是兩回事——
 *  這裡存的是「下單那一刻」的快照（名稱/單價/emoji），後面商品庫怎麼改都不會影響歷史卡片。 */
export interface MallOrderMeta {
    mallKind: 'shop' | 'food';
    /**
     * gift：買給對方（用戶發的是用戶付、角色發的是角色付），發送即結清；
     * self：用戶買給自己、自己付；daifu：用戶買給自己、請角色付，待角色選擇支付或拒絕；
     * manual：「TA 買給我的」手動模擬卡，純擺設不動餘額
     */
    mode: 'gift' | 'self' | 'daifu' | 'manual';
    items: MallOrderItem[];
    note?: string;
    total: number;
    status: 'sent' | 'pending' | 'accepted' | 'declined';
    declineReason?: string;
    /** 舊卡片的「發小票」會顯式傳；新卡片不傳，照 mode／方向自動生成 */
    title?: string;
    /**
     * 禮物/外賣是「發送即結清」，沒有 accept 步驟，但完全沒反饋不好——角色收到禮物後的
     * 下一輪回復會順手標一個 acknowledged（見 utils/chatParser.ts 的 GIFT ACK 邏輯），
     * 卡片上多顯示一句"TA已收下"，純展示用，不影響任何結算。
     */
    acknowledged?: boolean;
    /** mall_orders 裡對應的訂單（2026-10 起）；舊卡片沒有 */
    orderId?: string;
    /** 付款時間＝配送起算點；代付在角色付了之後才有。舊卡片沒有，退回訊息時間 */
    paidAt?: number;
}

const KIND_ICON: Record<MallOrderMeta['mallKind'], string> = { shop: '🛍️', food: '🥡' };

const titleFor = (meta: MallOrderMeta, isUser: boolean, charName: string): string => {
    if (meta.title) return meta.title;
    if (meta.mode === 'daifu') return mallOrderTitle({ kind: meta.mallKind, buyer: 'user', recipient: 'user', payer: 'char' }, charName);
    if (meta.mode === 'self') return mallOrderTitle({ kind: meta.mallKind, buyer: 'user', recipient: 'user', payer: 'user' }, charName);
    // gift／manual：用戶發的是買給角色，角色發的（含手動模擬）是買給用戶
    return isUser
        ? mallOrderTitle({ kind: meta.mallKind, buyer: 'user', recipient: 'char', payer: 'user' }, charName)
        : mallOrderTitle({ kind: meta.mallKind, buyer: 'char', recipient: 'user', payer: 'char' }, charName);
};

/** 配送狀態要跟著時間變：排一個剛好在下一個節點觸發的計時器，送達後就不再排。 */
function useProgressTick(target: { kind: 'shop' | 'food'; paidAt?: number; cancelledAt?: number }): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const next = nextProgressChangeAt(target, now);
        if (next == null) return;
        const t = window.setTimeout(() => setNow(Date.now()), Math.max(1000, next - Date.now() + 500));
        return () => window.clearTimeout(t);
    }, [target.kind, target.paidAt, target.cancelledAt, now]); // eslint-disable-line react-hooks/exhaustive-deps
    return now;
}

const MallOrderCard: React.FC<{
    m: Message;
    isUser: boolean;
    charName: string;
    commonLayout: (content: React.ReactNode) => JSX.Element;
}> = ({ m, isUser, charName, commonLayout }) => {
    const meta = (m.metadata || {}) as Partial<MallOrderMeta>;
    const items = Array.isArray(meta.items) ? meta.items : [];
    const kind = meta.mallKind === 'food' ? 'food' : 'shop';
    const status = meta.status || 'sent';
    const mode = meta.mode || 'gift';
    const title = titleFor({ ...meta, mallKind: kind, mode } as MallOrderMeta, isUser, charName);
    const deliveryTarget = {
        kind,
        paidAt: status === 'pending' || status === 'declined' ? undefined : (meta.paidAt ?? m.timestamp),
        cancelledAt: status === 'declined' ? (m.timestamp || 1) : undefined,
    } as const;
    const now = useProgressTick(deliveryTarget);
    const line = progressLine(deliveryTarget, now, charName);
    const total = meta.total ?? items.reduce((s, i) => s + i.price * i.qty, 0);

    return commonLayout(
        <div className="w-72 rounded-2xl overflow-hidden border border-slate-200 shadow-sm bg-white">
            <div className="px-4 pt-3.5 pb-3 bg-slate-900 text-white">
                <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-sm">{KIND_ICON[kind]}</span>
                    <span className="text-[10px] font-bold tracking-[0.2em] text-white/50">{kind === 'food' ? 'DELIVERY' : 'SHOPPING'}</span>
                    {mode === 'manual' && <span className="ml-auto text-[10px] text-white/40">模擬</span>}
                </div>
                <div className="text-[14px] font-bold leading-snug">{title}</div>
                <div className={`text-[11px] mt-1 ${status === 'pending' ? 'text-amber-300' : 'text-white/60'}`}>{line}</div>
            </div>

            <div className="px-4 py-2.5 space-y-2.5">
                {items.map((item, idx) => (
                    <div key={idx} className="flex items-center gap-2.5">
                        <div className="w-9 h-9 rounded-xl bg-slate-100 flex items-center justify-center text-base shrink-0">
                            {item.emoji || (kind === 'food' ? '🍽️' : '🎁')}
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="text-[12px] font-bold text-slate-800 truncate">{item.name}</div>
                            <div className="text-[10px] text-slate-400 truncate">{item.shop ? `${item.shop} · ` : ''}×{item.qty} · {formatMoney(item.price)}</div>
                        </div>
                        <div className="text-[12px] font-bold text-slate-700 shrink-0 tabular-nums">{formatMoney(item.price * item.qty)}</div>
                    </div>
                ))}
                {meta.note && (
                    <div className="text-[11px] text-slate-600 bg-slate-50 rounded-lg px-2.5 py-1.5">留言：{meta.note}</div>
                )}
                {status === 'declined' && meta.declineReason && (
                    <div className="text-[11px] text-slate-500 bg-slate-50 rounded-lg px-2.5 py-1.5">{charName}：{meta.declineReason}</div>
                )}
            </div>

            <div className="px-4 py-2.5 border-t border-slate-100 flex items-center justify-between">
                <span className="text-[11px] text-slate-400">
                    {status === 'accepted' ? `${charName}已付款` : status === 'declined' ? `${charName}拒絕付款` : '合計'}
                </span>
                <span className="text-[15px] font-black text-slate-900 tabular-nums">{formatMoney(total)}</span>
            </div>

            {status === 'pending' && (
                <div className="px-4 pb-3 text-[10px] text-amber-600 text-center">
                    等{isUser ? charName : '你'}在回覆裡選擇付款或拒絕
                </div>
            )}
            {status === 'sent' && mode === 'gift' && isUser && meta.acknowledged && (
                <div className="px-4 pb-3 text-[10px] text-slate-500 text-center">{charName}已收下</div>
            )}
        </div>
    );
};

export default MallOrderCard;
