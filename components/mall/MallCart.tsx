import React from 'react';
import { Minus, Plus, ShoppingCart } from '@phosphor-icons/react';
import type { MallKind, MallProduct } from '../../types';
import { formatMoney } from '../../utils/realBalance';
import type { MallCartLine } from '../../utils/shoppingMall';
import { FOOD_DELIVER_MIN, SHOP_DELIVER_HOUR } from '../../utils/mallOrders';
import { EmojiTile, Segmented, inputCls, primaryBtn } from './MallParts';

export type CartPayer = 'user' | 'char';
/** 收件人：'user'＝自己，其他是角色 id */
export type CartRecipient = string;

interface Props {
    kind: MallKind;
    lines: (MallCartLine & { product: MallProduct })[];
    total: number;
    balance: number;
    /** 「給誰」的選項：聊天入口是「給 TA／給自己」，桌面入口是「自己＋每個角色」 */
    recipientOptions: { value: CartRecipient; label: string }[];
    recipient: CartRecipient;
    /** 收件人是角色時的名字（文案用） */
    recipientName?: string;
    /** 能請誰代付（只有聊天入口有：要有人在對話裡回你） */
    daifuName?: string;
    payer: CartPayer;
    note: string;
    busy: boolean;
    /** 桌面入口：結帳後留在購物中心，卡片寫進那個角色的私聊 */
    standalone: boolean;
    onRecipient: (r: CartRecipient) => void;
    onPayer: (p: CartPayer) => void;
    onNote: (v: string) => void;
    onInc: (productId: string) => void;
    onDec: (productId: string) => void;
    onCheckout: () => void;
    onBrowse: () => void;
}

/** Cart：購物、外賣各一車（跟頂部切換走）；給誰、誰付、留言、結帳。 */
const MallCart: React.FC<Props> = ({
    kind, lines, total, balance, recipientOptions, recipient, recipientName, daifuName, payer, note, busy, standalone,
    onRecipient, onPayer, onNote, onInc, onDec, onCheckout, onBrowse,
}) => {
    if (lines.length === 0) {
        return (
            <div className="flex flex-col items-center text-center py-16 gap-3">
                <div className="w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center text-slate-400"><ShoppingCart size={28} /></div>
                <div className="text-[13px] text-slate-400">{kind === 'food' ? '外賣籃' : '購物車'}還是空的</div>
                <button onClick={onBrowse} className="px-5 py-2 rounded-full bg-slate-900 text-white text-[12px] font-bold active:scale-95 transition-transform">去逛逛</button>
            </div>
        );
    }
    const toSelf = recipient === 'user';
    const daifu = toSelf && payer === 'char' && !!daifuName;
    const short = !daifu && total > balance;
    const notePlaceholder = !toSelf
        ? `想對${recipientName || 'TA'}說的話（會顯示在卡片上）`
        : daifu ? `跟${daifuName}說一聲為什麼要TA付 XD` : '備註（選填）';
    const arrival = kind === 'food' ? `約 ${FOOD_DELIVER_MIN} 分鐘送達` : `明天 ${SHOP_DELIVER_HOUR}:00 送達`;
    const footnote = daifu
        ? `會在聊天裡發一張代付請求，${daifuName}付了才開始配送`
        : !toSelf
            ? (standalone
                ? `扣你的餘額，卡片會出現在和${recipientName}的聊天裡，下次聊天TA就看到了；${arrival}`
                : `扣你的餘額，聊天裡會彈一張卡片；${arrival}`)
            : (standalone ? `扣你的餘額，只記一筆訂單；${arrival}` : `扣你的餘額，聊天裡會彈一張卡片；${arrival}`);

    return (
        <div className="space-y-4 pt-3">
            <div className="rounded-3xl bg-white border border-slate-100 px-4 py-1 divide-y divide-slate-50">
                {lines.map(l => (
                    <div key={l.productId} className="flex items-center gap-3 py-2.5">
                        <EmojiTile emoji={l.product.emoji} size="sm" />
                        <div className="min-w-0 flex-1">
                            <div className="text-[13px] font-bold text-slate-800 truncate">{l.product.name}</div>
                            <div className="text-[11px] text-slate-400 tabular-nums">{formatMoney(l.product.price)}{l.product.shop ? ` · ${l.product.shop}` : ''}</div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                            <button onClick={() => onDec(l.productId)} className="w-6 h-6 rounded-full bg-slate-100 flex items-center justify-center active:scale-90" aria-label="減一"><Minus size={11} weight="bold" /></button>
                            <span className="w-5 text-center text-[12px] font-bold tabular-nums">{l.qty}</span>
                            <button onClick={() => onInc(l.productId)} className="w-6 h-6 rounded-full bg-slate-100 flex items-center justify-center active:scale-90" aria-label="加一"><Plus size={11} weight="bold" /></button>
                        </div>
                    </div>
                ))}
            </div>

            <div className="space-y-2">
                <div className="text-[12px] font-bold text-slate-500 px-1">給誰</div>
                {recipientOptions.length <= 2 ? (
                    <Segmented value={recipient} onChange={onRecipient} options={recipientOptions} />
                ) : (
                    <div className="flex gap-1.5 overflow-x-auto no-scrollbar -mx-4 px-4">
                        {recipientOptions.map(o => (
                            <button key={o.value} onClick={() => onRecipient(o.value)}
                                className={`shrink-0 px-4 py-2 rounded-full text-[13px] font-bold transition-colors ${recipient === o.value ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200 text-slate-500'}`}>
                                {o.label}
                            </button>
                        ))}
                    </div>
                )}
                {toSelf && daifuName && (
                    <>
                        <div className="text-[12px] font-bold text-slate-500 px-1 pt-1">誰付錢</div>
                        <Segmented value={payer} onChange={onPayer}
                            options={[{ value: 'user', label: '我付' }, { value: 'char', label: `請 ${daifuName} 付` }]} />
                    </>
                )}
            </div>

            <textarea value={note} onChange={e => onNote(e.target.value)} placeholder={notePlaceholder} rows={2}
                className={`${inputCls} resize-none`} />

            <div className="rounded-3xl bg-white border border-slate-100 px-4 py-3 space-y-1.5 text-[13px]">
                <div className="flex justify-between"><span className="text-slate-400">合計</span><span className="font-black text-slate-900 tabular-nums">{formatMoney(total)}</span></div>
                {!daifu && (
                    <div className="flex justify-between">
                        <span className="text-slate-400">我的餘額</span>
                        <span className={`tabular-nums ${short ? 'text-rose-500 font-bold' : 'text-slate-600'}`}>{formatMoney(balance)}</span>
                    </div>
                )}
                {short && <div className="text-[11px] text-rose-500">餘額不夠，去「銀行」加點錢或少買一點</div>}
            </div>

            <button disabled={busy || short} onClick={onCheckout} className={primaryBtn}>
                {daifu ? `請 ${daifuName} 付 ${formatMoney(total)}` : `結帳 ${formatMoney(total)}`}
            </button>
            <div className="text-[11px] text-slate-400 text-center leading-relaxed pb-2">{footnote}</div>
        </div>
    );
};

export default MallCart;
