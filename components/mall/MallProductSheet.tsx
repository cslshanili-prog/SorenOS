import React, { useEffect, useState } from 'react';
import { Heart, X } from '@phosphor-icons/react';
import type { MallCategory, MallKind, MallProduct } from '../../types';
import { formatMoney } from '../../utils/realBalance';
import { EmojiTile, inputCls, primaryBtn } from './MallParts';

export type ProductSheetTarget =
    | { mode: 'view'; product: MallProduct }
    | { mode: 'create'; categoryId?: string };

interface Props {
    target: ProductSheetTarget | null;
    kind: MallKind;
    categories: MallCategory[];
    inCart: number;
    onClose: () => void;
    onAddToCart: (product: MallProduct) => void;
    onToggleFavorite: (product: MallProduct) => void;
    onSave: (product: MallProduct | null, draft: ProductDraft) => void;
    onDelete: (product: MallProduct) => void;
}

export interface ProductDraft {
    name: string;
    shop: string;
    price: string;
    emoji: string;
    summary: string;
    detail: string;
    categoryId: string;
}

const draftFrom = (p: MallProduct): ProductDraft => ({
    name: p.name, shop: p.shop ?? '', price: String(p.price), emoji: p.emoji, summary: p.summary ?? '', detail: p.detail ?? '', categoryId: p.categoryId,
});

/** 商品詳情（底部抽屜）：看、收藏、加入購物車；點「編輯」切成表單。新增商品也用同一張表單。 */
const MallProductSheet: React.FC<Props> = ({ target, kind, categories, inCart, onClose, onAddToCart, onToggleFavorite, onSave, onDelete }) => {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState<ProductDraft | null>(null);
    const [confirmDelete, setConfirmDelete] = useState(false);

    useEffect(() => {
        setConfirmDelete(false);
        if (!target) { setEditing(false); setDraft(null); return; }
        if (target.mode === 'create') {
            setEditing(true);
            setDraft({ name: '', shop: '', price: '', emoji: '', summary: '', detail: '', categoryId: target.categoryId || categories[0]?.id || '' });
        } else {
            setEditing(false);
            setDraft(draftFrom(target.product));
        }
    }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

    if (!target || !draft) return null;
    const product = target.mode === 'view' ? target.product : null;
    const category = product ? categories.find(c => c.id === product.categoryId) : null;
    const set = (patch: Partial<ProductDraft>) => setDraft(d => (d ? { ...d, ...patch } : d));
    const canSave = draft.name.trim() && draft.categoryId && Number.isFinite(parseFloat(draft.price)) && parseFloat(draft.price) >= 0;

    return (
        <div className="fixed inset-0 z-[110] flex items-end justify-center" onClick={e => e.stopPropagation()}>
            <div className="absolute inset-0 bg-black/40 animate-fade-in" onClick={onClose} />
            <div className="relative w-full max-w-md max-h-[88%] bg-white rounded-t-[2rem] flex flex-col animate-slide-up" style={{ paddingBottom: 'var(--safe-bottom)' }}>
                <div className="flex items-center justify-between px-5 pt-4 pb-1 shrink-0">
                    <div className="text-[12px] font-bold text-slate-400">
                        {editing ? (product ? '編輯商品' : `新增${kind === 'food' ? '品項' : '商品'}`) : (category?.name || '')}
                    </div>
                    <div className="flex items-center gap-3">
                        {product && !editing && (
                            <button onClick={() => setEditing(true)} className="text-[12px] font-bold text-slate-500">編輯</button>
                        )}
                        <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-slate-500 active:scale-90" aria-label="關閉">
                            <X size={14} weight="bold" />
                        </button>
                    </div>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain no-scrollbar px-5 pb-5">
                    {!editing && product ? (
                        <div>
                            <div className="flex justify-center py-4"><EmojiTile emoji={product.emoji} size="lg" /></div>
                            <div className="text-[18px] font-black text-slate-900 leading-snug">{product.name}</div>
                            {product.shop && <div className="text-[12px] text-slate-400 mt-0.5">{product.shop}</div>}
                            <div className="text-[22px] font-black text-slate-900 mt-2 tabular-nums">{formatMoney(product.price)}</div>
                            {product.summary && <div className="text-[13px] text-slate-600 mt-2">{product.summary}</div>}
                            {product.detail && (
                                <div className="mt-4 rounded-2xl bg-slate-50 px-4 py-3">
                                    <div className="text-[11px] font-bold text-slate-400 mb-1">詳情</div>
                                    <div className="text-[13px] text-slate-700 leading-relaxed whitespace-pre-wrap">{product.detail}</div>
                                </div>
                            )}
                            <div className="flex gap-2 mt-5">
                                <button onClick={() => onToggleFavorite(product)}
                                    className={`w-14 shrink-0 rounded-2xl border flex items-center justify-center active:scale-95 transition-transform ${product.favorite ? 'border-slate-900 text-slate-900' : 'border-slate-200 text-slate-400'}`}
                                    aria-label={product.favorite ? '取消收藏' : '收藏'}>
                                    <Heart size={20} weight={product.favorite ? 'fill' : 'regular'} />
                                </button>
                                <button onClick={() => onAddToCart(product)} className={primaryBtn}>
                                    加入購物車{inCart > 0 ? `（已有 ${inCart}）` : ''}
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-3 pt-2">
                            <div className="flex gap-3">
                                <input value={draft.emoji} onChange={e => set({ emoji: e.target.value })} placeholder="🛍️" aria-label="圖標"
                                    className={`${inputCls} w-16 text-center text-xl`} />
                                <input value={draft.name} onChange={e => set({ name: e.target.value })} placeholder="名稱" className={inputCls} autoFocus={!product} />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <input value={draft.shop} onChange={e => set({ shop: e.target.value })} placeholder="店鋪／品牌（選填）" className={inputCls} />
                                <input value={draft.price} onChange={e => set({ price: e.target.value })} placeholder="價格（美金）" inputMode="decimal" className={inputCls} />
                            </div>
                            <select value={draft.categoryId} onChange={e => set({ categoryId: e.target.value })} className={inputCls}>
                                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                            </select>
                            <input value={draft.summary} onChange={e => set({ summary: e.target.value })} placeholder="一行短說明（列表上顯示，選填）" className={inputCls} />
                            <textarea value={draft.detail} onChange={e => set({ detail: e.target.value })} placeholder="詳情：材質、規格、份量…（選填）" rows={3}
                                className={`${inputCls} resize-none`} />
                            <button disabled={!canSave} onClick={() => onSave(product, draft)} className={primaryBtn}>儲存</button>
                            {product && (
                                confirmDelete ? (
                                    <div className="flex gap-2">
                                        <button onClick={() => setConfirmDelete(false)} className="flex-1 py-3 rounded-2xl bg-slate-100 text-slate-600 font-bold">取消</button>
                                        <button onClick={() => onDelete(product)} className="flex-1 py-3 rounded-2xl bg-rose-500 text-white font-bold">確定刪除</button>
                                    </div>
                                ) : (
                                    <button onClick={() => setConfirmDelete(true)} className="w-full py-2.5 text-[13px] font-bold text-rose-500">刪除這件商品</button>
                                )
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default MallProductSheet;
