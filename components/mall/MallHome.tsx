import React, { useMemo } from 'react';
import type { MallCategory, MallKind, MallProduct } from '../../types';
import { localDateKey, pickDailyRecommendations, searchMallProducts } from '../../utils/shoppingMall';
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
    const picks = useMemo(() => pickDailyRecommendations(products, localDateKey(), 10), [products]);

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
                <SectionTitle>今日推薦 · 每天換一批</SectionTitle>
                {picks.length === 0 ? <Empty text="還沒有商品，按右上角 ⟳ 讓 AI 補貨" /> : picks.map(row)}
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
