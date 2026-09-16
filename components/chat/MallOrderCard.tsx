import React from 'react';
import type { Message } from '../../types';

export interface MallOrderItem {
    name: string;
    price: number;
    qty: number;
    emoji?: string;
    detail?: string;
}

/** apps/Chat.tsx 落库时写进 metadata 的形状；跟 utils/shoppingMall.ts 的 MallProduct 是两回事——
 *  这里存的是「下单那一刻」的快照（名称/单价/emoji），后面商品库怎么改都不会影响历史卡片。 */
export interface MallOrderMeta {
    mallKind: 'shop' | 'food';
    /** gift/为TA点单：发送即结清，不需要对方处理；daifu：待对方（角色）选择支付或拒绝；manual：「TA主动给我买/点外卖」手动模拟卡，纯摆设不动余额 */
    mode: 'gift' | 'daifu' | 'manual';
    items: MallOrderItem[];
    note?: string;
    total: number;
    status: 'sent' | 'pending' | 'accepted' | 'declined';
    declineReason?: string;
    /** 不传则用 buildTitle 按 mode/方向自动生成；「发小票」这种不想被念成"送给TA"的场景会显式传。 */
    title?: string;
}

const KIND_ICON: Record<MallOrderMeta['mallKind'], string> = { shop: '🛍️', food: '🥡' };

const STATUS_STYLE: Record<MallOrderMeta['status'], { label: string; bg: string; text: string }> = {
    sent: { label: '已送出', bg: 'bg-emerald-100', text: 'text-emerald-600' },
    pending: { label: '等待选择', bg: 'bg-amber-100', text: 'text-amber-600' },
    accepted: { label: '已支付', bg: 'bg-emerald-100', text: 'text-emerald-600' },
    declined: { label: '已拒绝支付', bg: 'bg-slate-200', text: 'text-slate-500' },
};

const buildTitle = (meta: MallOrderMeta, isUser: boolean, charName: string): string => {
    const actor = isUser ? '你' : charName;
    const counterparty = isUser ? charName : '你';
    if (meta.mode === 'daifu') return `${meta.mallKind === 'food' ? '外卖' : '购物'}代付请求`;
    if (meta.mallKind === 'food') return `${actor}给${counterparty}点了外卖`;
    return `${actor}送给${counterparty}的购物礼物`;
};

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
    const style = STATUS_STYLE[status] || STATUS_STYLE.sent;
    const title = meta.title || buildTitle({ ...meta, mallKind: kind, mode: meta.mode || 'gift' } as MallOrderMeta, isUser, charName);

    return commonLayout(
        <div className="w-72 rounded-2xl overflow-hidden border border-rose-100 shadow-sm bg-white">
            <div className="px-4 pt-3.5 pb-3 bg-gradient-to-br from-rose-50 to-orange-50">
                <div className="flex items-center gap-2.5 mb-2">
                    <div className="w-8 h-8 rounded-full bg-white flex items-center justify-center text-base shrink-0 shadow-sm">
                        {KIND_ICON[kind]}
                    </div>
                    <div className="flex-1 min-w-0 flex items-center gap-2">
                        <span className="text-[10px] font-bold tracking-widest text-rose-400 uppercase">Nuomi Card</span>
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${style.bg} ${style.text}`}>{style.label}</span>
                    </div>
                </div>
                <div className="text-[13px] font-bold text-slate-800 leading-snug">{title}</div>
            </div>

            <div className="px-4 py-2.5 space-y-2.5">
                {items.map((item, idx) => (
                    <div key={idx} className="flex items-center gap-2.5">
                        <div className="w-9 h-9 rounded-xl bg-rose-50 flex items-center justify-center text-base shrink-0">
                            {item.emoji || (kind === 'food' ? '🍽️' : '🎁')}
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="text-[12px] font-bold text-slate-700 truncate">{item.name}</div>
                            <div className="text-[10px] text-slate-400">数量 {item.qty} · 单价 ¥{item.price.toFixed(2)}</div>
                            {item.detail && <div className="text-[10px] text-slate-400 truncate">{item.detail}</div>}
                        </div>
                        <div className="text-[12px] font-bold text-slate-700 shrink-0">¥{(item.price * item.qty).toFixed(2)}</div>
                    </div>
                ))}
                {meta.note && (
                    <div className="text-[11px] text-slate-500 bg-slate-50 rounded-lg px-2.5 py-1.5">备注：{meta.note}</div>
                )}
                {status === 'declined' && meta.declineReason && (
                    <div className="text-[11px] text-slate-500 bg-slate-50 rounded-lg px-2.5 py-1.5">{charName}：{meta.declineReason}</div>
                )}
            </div>

            <div className="px-4 py-2.5 border-t border-slate-50 flex items-center justify-between">
                <span className="text-[11px] text-slate-400">合计</span>
                <span className="text-[15px] font-bold text-slate-800">¥{(meta.total ?? items.reduce((s, i) => s + i.price * i.qty, 0)).toFixed(2)}</span>
            </div>

            {status === 'pending' && (
                <div className="px-4 pb-3 text-[10px] text-amber-600 text-center">
                    等待{isUser ? charName : '你'}在回复中选择支付或拒绝
                </div>
            )}
        </div>
    );
};

export default MallOrderCard;
