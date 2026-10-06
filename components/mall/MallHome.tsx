import React, { useMemo, useState } from 'react';
import { ArrowClockwise } from '@phosphor-icons/react';
import type { MallCategory, MallKind, MallProduct } from '../../types';
import { bumpMallPicksRound, buildMallPicks, getMallPicksRound, localDateKey, searchMallProducts } from '../../utils/shoppingMall';
import { ProductRow, SectionTitle } from './MallParts';

/** 分類列的兩個特殊值 */
export const CAT_ALL = 'all';
export const CAT_PICKS = 'picks';

interface Props {
    kind: MallKind;
    categories: MallCategory[];
    products: MallProduct[];
    activeCat: string;
    query: string;
    cartQty: (productId: string) => number;
    onOpen: (p: MallProduct) => void;
    onAdd: (p: MallProduct) => void;
}

/** Home：全部（按分類分段）／推薦（今日輪換）／單一分類；有搜尋字就跨分類搜。 */
const MallHome: React.FC<Props> = ({ kind, categories, products, activeCat, query, cartQty, onOpen, onAdd }) => {
    const row = (p: MallProduct) => <ProductRow key={p.id} product={p} inCart={cartQty(p.id)} onOpen={() => onOpen(p)} onAdd={() => onAdd(p)} />;
    // ↻ 換一批：次數記在 localStorage（聊天組提示詞也讀），這裡只靠 bump 觸發重算
    const [bump, setBump] = useState(0);
    const [spinning, setSpinning] = useState(false);
    const picks = useMemo(() => {
        const day = localDateKey();
        return buildMallPicks(products, day, getMallPicksRound(kind, day));
    }, [products, kind, bump]); // eslint-disable-line react-hooks/exhaustive-deps
    const refreshPicks = () => {
        bumpMallPicksRound(kind);
        setBump(b => b + 1);
        setSpinning(true);
        window.setTimeout(() => setSpinning(false), 450);
    };

    if (query.trim()) {
        const hits = searchMallProducts(products, query);
        return (
            <div>
                <SectionTitle>搜尋結果 {hits.length} 件</SectionTitle>
                {hits.length === 0 ? <Empty text="沒有找到，換個關鍵字試試" /> : hits.map(row)}
            </div>
        );
    }

    if (activeCat === CAT_PICKS) {
        return (
            <div>
                {picks.pinned.length > 0 && (
                    <>
                        <SectionTitle>📌 你放進推薦的 · 不會被換掉</SectionTitle>
                        {picks.pinned.map(row)}
                    </>
                )}
                <SectionTitle right={picks.rotating.length > 0 && (
                    <button onClick={refreshPicks} aria-label="換一批推薦"
                        className="flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold text-slate-500 active:bg-slate-100">
                        <ArrowClockwise size={13} weight="bold" className={spinning ? 'animate-spin' : ''} />換一批
                    </button>
                )}>今日推薦 · 每天換一批</SectionTitle>
                {picks.rotating.length === 0
                    ? <Empty text={picks.pinned.length ? '其他商品都已經放進推薦了' : '還沒有商品，按右上角 ⟳ 讓 AI 補貨'} />
                    : picks.rotating.map(row)}
                {picks.pinned.length === 0 && picks.rotating.length > 0 && (
                    <div className="text-[11px] text-slate-400 text-center py-3">想要的東西刷不到？點商品進詳情按 📌，就會固定放在推薦最上面</div>
                )}
            </div>
        );
    }

    if (activeCat !== CAT_ALL) {
        const list = products.filter(p => p.categoryId === activeCat);
        const cat = categories.find(c => c.id === activeCat);
        return (
            <div>
                <SectionTitle>{cat?.name} · {list.length} 件</SectionTitle>
                {list.length === 0 ? <Empty text="這個分類還沒有商品，按 ⟳ 補貨或從 ＋ 新增" /> : list.map(row)}
            </div>
        );
    }

    if (products.length === 0) {
        return <Empty text={`還沒有${kind === 'food' ? '外賣' : '商品'}，按右上角 ⟳ 讓 AI 補貨，或從分類列的 ＋ 新增`} />;
    }
    return (
        <div>
            {categories.map(c => {
                const list = products.filter(p => p.categoryId === c.id);
                if (list.length === 0) return null;
                return (
                    <div key={c.id}>
                        <SectionTitle>{c.name}</SectionTitle>
                        {list.map(row)}
                    </div>
                );
            })}
        </div>
    );
};

const Empty: React.FC<{ text: string }> = ({ text }) => (
    <div className="text-center text-[12px] text-slate-400 py-14 px-6 leading-relaxed">{text}</div>
);

export default MallHome;
