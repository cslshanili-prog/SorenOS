import React from 'react';
import { Plus } from '@phosphor-icons/react';
import type { MallProduct } from '../../types';
import { formatMoney } from '../../utils/realBalance';
import { productBlurb } from '../../utils/shoppingMall';

/** 購物中心共用的小零件。單色簡約：白底、slate 字、黑色當主色（2026-10 改版，拿掉粉橘）。 */

export const EmojiTile: React.FC<{ emoji?: string; size?: 'sm' | 'md' | 'lg' }> = ({ emoji, size = 'md' }) => {
    const cls = size === 'lg' ? 'w-28 h-28 text-6xl rounded-[2rem]' : size === 'sm' ? 'w-9 h-9 text-lg rounded-xl' : 'w-14 h-14 text-[28px] rounded-2xl';
    return <div className={`${cls} shrink-0 bg-slate-100 flex items-center justify-center select-none`}>{emoji || '🛍️'}</div>;
};

export const ProductRow: React.FC<{
    product: MallProduct;
    inCart?: number;
    onOpen: () => void;
    onAdd: () => void;
}> = ({ product, inCart, onOpen, onAdd }) => {
    const blurb = productBlurb(product);
    return (
        <div className="flex items-center gap-3 py-2.5 active:bg-slate-50 rounded-2xl -mx-2 px-2 transition-colors" onClick={onOpen}>
            <EmojiTile emoji={product.emoji} />
            <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-bold text-slate-900 truncate">{product.name}</div>
                <div className="text-[11px] text-slate-400 truncate">{[product.shop, blurb].filter(Boolean).join(' · ')}</div>
                <div className="text-[13px] font-bold text-slate-900 mt-0.5 tabular-nums">{formatMoney(product.price)}</div>
            </div>
            <button
                onClick={e => { e.stopPropagation(); onAdd(); }}
                className="relative w-8 h-8 rounded-full bg-slate-900 text-white flex items-center justify-center shrink-0 active:scale-90 transition-transform"
                aria-label={`把${product.name}加入購物車`}
            >
                <Plus size={14} weight="bold" />
                {!!inCart && (
                    <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-white border border-slate-900 text-slate-900 text-[10px] font-bold flex items-center justify-center tabular-nums">{inCart}</span>
                )}
            </button>
        </div>
    );
};

export function Segmented<T extends string>({ value, options, onChange, size = 'md' }: {
    value: T;
    options: { value: T; label: string }[];
    onChange: (v: T) => void;
    size?: 'sm' | 'md';
}) {
    return (
        <div className="flex bg-slate-100 rounded-full p-0.5">
            {options.map(o => (
                <button key={o.value} type="button" onClick={() => onChange(o.value)}
                    className={`flex-1 rounded-full font-bold transition-colors whitespace-nowrap ${size === 'sm' ? 'px-3 py-1 text-[12px]' : 'px-4 py-2 text-[13px]'} ${value === o.value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400'}`}>
                    {o.label}
                </button>
            ))}
        </div>
    );
}

export const SectionTitle: React.FC<{ children: React.ReactNode; right?: React.ReactNode }> = ({ children, right }) => (
    <div className="flex items-center justify-between pt-4 pb-1">
        <div className="text-[12px] font-bold text-slate-500 tracking-wide">{children}</div>
        {right}
    </div>
);

export const inputCls = 'w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-800 focus:outline-none focus:border-slate-400';
export const primaryBtn = 'w-full py-3 bg-slate-900 text-white font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-40 disabled:active:scale-100';
export const secondaryBtn = 'w-full py-3 bg-slate-100 text-slate-700 font-bold rounded-2xl active:scale-95 transition-transform';
