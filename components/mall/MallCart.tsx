import React from 'react';
import { Minus, Plus, ShoppingCart } from '@phosphor-icons/react';
import type { MallKind, MallProduct } from '../../types';
import { formatMoney } from '../../utils/realBalance';
import type { MallCartLine } from '../../utils/shoppingMall';
import { EmojiTile, Segmented, inputCls, primaryBtn } from './MallParts';

export type CartRecipient = 'char' | 'user';
export type CartPayer = 'user' | 'char';

interface Props {
    kind: MallKind;
    charName: string;
    lines: (MallCartLine & { product: MallProduct })[];
    total: number;
    balance: number;
    recipient: CartRecipient;
    payer: CartPayer;
    note: string;
    busy: boolean;
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
    kind, charName, lines, total, balance, recipient, payer, note, busy,
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
    const daifu = recipient === 'user' && payer === 'char';
    const short = !daifu && total > balance;
    const notePlaceholder = recipient === 'char'
        ? `想對${charName}說的話（會顯示在卡片上）`
        : daifu ? `跟${charName}說一聲為什麼要TA付 XD` : '備註（會顯示在卡片上）';

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
                <Segmented value={recipient} onChange={onRecipient}
                    options={[{ value: 'char', label: `給 ${charName}` }, { value: 'user', label: '給自己' }]} />
                {recipient === 'user' && (
                    <>
                        <div className="text-[12px] font-bold text-slate-500 px-1 pt-1">誰付錢</div>
                        <Segmented value={payer} onChange={onPayer}
                            options={[{ value: 'user', label: '我付' }, { value: 'char', label: `請 ${charName} 付` }]} />
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
                {daifu ? `請 ${charName} 付 ${formatMoney(total)}` : `結帳 ${formatMoney(total)}`}
            </button>
            <div className="text-[11px] text-slate-400 text-center leading-relaxed pb-2">
                {daifu
                    ? `會在聊天裡發一張代付請求，${charName}付了才開始配送`
                    : `扣你的餘額，聊天裡會彈一張卡片；${kind === 'food' ? '約 40 分鐘送達' : '明天 14:00 送達'}`}
            </div>
        </div>
    );
};

export default MallCart;
