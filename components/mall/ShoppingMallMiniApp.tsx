import React, { useEffect, useMemo, useState } from 'react';
import { ArrowClockwise, CaretLeft, House, MagnifyingGlass, Plus, Receipt, ShoppingCart, User, X } from '@phosphor-icons/react';
import Modal from '../os/Modal';
import { DB } from '../../utils/db';
import type { APIConfig, ApiPreset, MallCategory, MallKind, MallOrder, MallProduct } from '../../types';
import {
    MALL_CATALOG_VERSION, MALL_CATALOG_VERSION_KEY, addToCart, cartCount, cartTotal, createMallCategory,
    createMallProduct, isMallWishlistShared, planMallCatalogUpgrade, setMallWishlistShared, removeFromCart, resolveCartLines, type MallCartLine,
} from '../../utils/shoppingMall';
import { MALL_RESTOCK_STYLE_LABELS, buildMallRestockPrompt, getMallRestockStyle, parseMallRestockBlocks, setMallRestockStyle, type MallRestockStyle } from '../../utils/mallRestock';
import { createMallOrder, sortMallOrders } from '../../utils/mallOrders';
import { getMallApi, resolveMallApi, setMallApi } from '../../utils/mallApi';
import { extractContent, safeResponseJson } from '../../utils/safeApi';
import { shareOrDownloadFile } from '../../utils/shareExport';
import { trackEvent } from '../../utils/analytics';
import type { MallOrderItem } from '../chat/MallOrderCard';
import { Segmented, primaryBtn, secondaryBtn } from './MallParts';
import MallHome, { CAT_ALL, CAT_PICKS } from './MallHome';
import MallCart, { type CartPayer, type CartRecipient } from './MallCart';
import MallOrders from './MallOrders';
import MallMe from './MallMe';
import MallProductSheet, { type ProductDraft, type ProductSheetTarget } from './MallProductSheet';

/** 統計屬性用簡體固定枚舉（見 docs/analytics.md）。 */
const RESTOCK_STYLE_EVENT: Record<MallRestockStyle, '日常' | '混搭' | '精品'> = { daily: '日常', mixed: '混搭', luxury: '精品' };
import MallCategoryManager from './MallCategoryManager';

/**
 * 購物中心（2026-10 改版：全螢幕頁＋訂單配送，見 plans/mall-redesign.md）。
 *
 * mode：
 * - gift：用戶付錢買給角色
 * - self：用戶付錢買給自己
 * - daifu：買給自己、請角色付（角色在回覆裡 DAIFU_ACCEPT／DECLINE）
 * - manual：手動模擬「角色買給我的」，不動錢、不觸發回覆
 */
export interface MallSendOrderInput {
    mallKind: MallKind;
    mode: 'gift' | 'self' | 'daifu' | 'manual';
    items: MallOrderItem[];
    note?: string;
    total: number;
    /** 對應 mall_orders 裡那一筆；卡片和代付結算靠它找回訂單 */
    orderId?: string;
    /** 付款時間＝配送起算點；代付還沒付就沒有 */
    paidAt?: number;
    /** 收件的角色（gift）；桌面入口靠它知道卡片要寫進誰的私聊 */
    recipientCharId?: string;
}

interface ShoppingMallMiniAppProps {
    open: boolean;
    onClose: () => void;
    /**
     * 從私聊「＋」進來時是那個角色：預設買給 TA、可以請 TA 代付、有手動模擬卡，結帳後回聊天。
     * 從桌面進來（2026-10 第三批）不傳：給誰從「自己＋recipients」裡挑，沒有代付，結帳後留在訂單頁。
     */
    charId?: string;
    charName?: string;
    /** 桌面入口能送的角色（已經濾掉拉黑中的） */
    recipients?: { id: string; name: string }[];
    /** 用戶自己的 Real Balance 餘額（結帳從這裡扣） */
    userBalance: number;
    /** 落卡＋扣款；回 false 表示沒成功（例如餘額不夠），這邊就不留訂單 */
    onSendOrder: (order: MallSendOrderInput) => Promise<boolean> | boolean;
    addToast: (message: string, type?: 'info' | 'success' | 'error') => void;
    /** 聊天預設 API，購物中心沒有獨立配置時跟隨這個。 */
    apiConfig: APIConfig;
    apiPresets: ApiPreset[];
}

type Tab = 'home' | 'cart' | 'orders' | 'me';

const ShoppingMallMiniApp: React.FC<ShoppingMallMiniAppProps> = ({ open, onClose, charId, charName, recipients, userBalance, onSendOrder, addToast, apiConfig, apiPresets }) => {
    const standalone = !charId;
    const [kind, setKind] = useState<MallKind>('food');
    const [tab, setTab] = useState<Tab>('home');
    const [categories, setCategories] = useState<MallCategory[]>([]);
    const [products, setProducts] = useState<MallProduct[]>([]);
    const [orders, setOrders] = useState<MallOrder[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [activeCat, setActiveCat] = useState<Record<MallKind, string>>({ food: CAT_ALL, shop: CAT_ALL });
    const [query, setQuery] = useState('');
    const [carts, setCarts] = useState<Record<MallKind, MallCartLine[]>>({ shop: [], food: [] });
    const [recipient, setRecipient] = useState<CartRecipient>(charId || 'user');
    const [payer, setPayer] = useState<CartPayer>('user');
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [restocking, setRestocking] = useState(false);
    const [sheet, setSheet] = useState<ProductSheetTarget | null>(null);
    const [showPlus, setShowPlus] = useState(false);
    const [showCats, setShowCats] = useState(false);
    const [now, setNow] = useState(() => Date.now());

    // 聊天入口換了角色就把收件人重設成那個角色
    useEffect(() => { setRecipient(charId || 'user'); setPayer('user'); }, [charId]);
    const recipientOptions = useMemo(() => charId
        ? [{ value: charId, label: `給 ${charName || 'TA'}` }, { value: 'user', label: '給自己' }]
        : [{ value: 'user', label: '自己' }, ...(recipients || []).map(r => ({ value: r.id, label: r.name }))],
    [charId, charName, recipients]);
    const activeRecipient = recipientOptions.some(o => o.value === recipient) ? recipient : 'user';
    const nameOf = (id: string) => (id === charId ? charName : recipients?.find(r => r.id === id)?.name) || 'TA';

    const [mallApi, setMallApiState] = useState<APIConfig | null>(() => getMallApi());
    const [restockStyle, setRestockStyle] = useState<MallRestockStyle>(() => getMallRestockStyle());
    const [wishlistShared, setWishlistShared] = useState(() => isMallWishlistShared());
    useEffect(() => {
        const sync = () => setMallApiState(getMallApi());
        window.addEventListener('mall-api-changed', sync);
        return () => window.removeEventListener('mall-api-changed', sync);
    }, []);

    // 目錄只在第一次打開時讀＋搬遷；訂單每次打開都重讀（代付在聊天裡結算會改到它）
    useEffect(() => {
        if (!open) return;
        DB.getAllMallOrders().then(setOrders).catch(e => console.warn('[Mall] 讀訂單失敗:', e));
        if (loaded) return;
        (async () => {
            let [cats, prods] = await Promise.all([DB.getAllMallCategories(), DB.getAllMallProducts()]);
            let version = 0;
            try { version = Number(localStorage.getItem(MALL_CATALOG_VERSION_KEY)) || 0; } catch { /* 無痕模式 */ }
            if (version < MALL_CATALOG_VERSION) {
                const plan = planMallCatalogUpgrade(cats, prods);
                await Promise.all([
                    ...plan.deleteProductIds.map(id => DB.deleteMallProduct(id)),
                    ...plan.deleteCategoryIds.map(id => DB.deleteMallCategory(id)),
                    ...plan.addCategories.map(c => DB.saveMallCategory(c)),
                    ...plan.addProducts.map(p => DB.saveMallProduct(p)),
                ]);
                const delP = new Set(plan.deleteProductIds);
                const delC = new Set(plan.deleteCategoryIds);
                cats = [...cats.filter(c => !delC.has(c.id)), ...plan.addCategories];
                prods = [...prods.filter(p => !delP.has(p.id)), ...plan.addProducts];
                try { localStorage.setItem(MALL_CATALOG_VERSION_KEY, String(MALL_CATALOG_VERSION)); } catch { /* 無痕模式 */ }
            }
            setCategories(cats);
            setProducts(prods);
            setLoaded(true);
        })().catch(e => { console.warn('[Mall] 讀目錄失敗:', e); setLoaded(true); });
    }, [open, loaded]);

    // 配送狀態照時間推進：頁面開著時每 15 秒刷新一次「現在」
    useEffect(() => {
        if (!open) return;
        setNow(Date.now());
        const t = window.setInterval(() => setNow(Date.now()), 15_000);
        return () => window.clearInterval(t);
    }, [open]);

    const kindCats = useMemo(() => categories.filter(c => c.kind === kind).sort((a, b) => a.order - b.order), [categories, kind]);
    const kindProducts = useMemo(() => {
        const order = new Map(kindCats.map((c, i) => [c.id, i] as const));
        return products.filter(p => p.kind === kind && order.has(p.categoryId))
            .sort((a, b) => (order.get(a.categoryId)! - order.get(b.categoryId)!) || a.createdAt - b.createdAt);
    }, [products, kind, kindCats]);
    const cart = carts[kind];
    const cartLines = useMemo(() => resolveCartLines(cart, kindProducts), [cart, kindProducts]);
    const total = useMemo(() => cartTotal(cart, kindProducts), [cart, kindProducts]);
    const kindOrders = useMemo(() => sortMallOrders(orders.filter(o => o.kind === kind)), [orders, kind]);
    const cat = kindCats.some(c => c.id === activeCat[kind]) || activeCat[kind] === CAT_PICKS ? activeCat[kind] : CAT_ALL;
    const cartQty = (id: string) => cart.find(l => l.productId === id)?.qty ?? 0;

    const addOne = (p: MallProduct) => setCarts(prev => ({ ...prev, [p.kind]: addToCart(prev[p.kind], p.id) }));
    const decOne = (id: string) => setCarts(prev => ({ ...prev, [kind]: removeFromCart(prev[kind], id) }));
    const incOne = (id: string) => setCarts(prev => ({ ...prev, [kind]: addToCart(prev[kind], id) }));

    // ─── 商品 ───
    const saveProduct = async (existing: MallProduct | null, d: ProductDraft) => {
        const price = parseFloat(d.price);
        const fields = { name: d.name, price, emoji: d.emoji, detail: d.detail, shop: d.shop, summary: d.summary };
        const fresh = createMallProduct(kind, d.categoryId, fields);
        const next: MallProduct = existing
            ? { ...existing, ...fresh, id: existing.id, createdAt: existing.createdAt, favorite: existing.favorite }
            : { ...fresh, ...(d.pinned ? { pinned: true } : {}) };
        await DB.saveMallProduct(next);
        setProducts(prev => existing ? prev.map(p => p.id === next.id ? next : p) : [...prev, next]);
        setSheet(existing ? { mode: 'view', product: next } : null);
        addToast(existing ? '已儲存' : '已新增', 'success');
    };
    const deleteProduct = async (p: MallProduct) => {
        await DB.deleteMallProduct(p.id);
        setProducts(prev => prev.filter(x => x.id !== p.id));
        setCarts(prev => ({ shop: prev.shop.filter(l => l.productId !== p.id), food: prev.food.filter(l => l.productId !== p.id) }));
        setSheet(null);
        addToast('已刪除', 'success');
    };
    const togglePinned = async (p: MallProduct) => {
        const next = { ...p, pinned: !p.pinned || undefined };
        await DB.saveMallProduct(next);
        setProducts(prev => prev.map(x => x.id === p.id ? next : x));
        setSheet(s => (s && s.mode === 'view' && s.product.id === p.id ? { mode: 'view', product: next } : s));
        addToast(next.pinned ? '已放進推薦，角色也看得到' : '已從推薦拿掉', 'success');
    };
    const toggleFavorite = async (p: MallProduct) => {
        const next = { ...p, favorite: !p.favorite };
        await DB.saveMallProduct(next);
        setProducts(prev => prev.map(x => x.id === p.id ? next : x));
        setSheet(s => (s && s.mode === 'view' && s.product.id === p.id ? { mode: 'view', product: next } : s));
    };

    // ─── 分類 ───
    const createCategory = async (name: string) => {
        const c = createMallCategory(kind, name, kindCats.reduce((m, x) => Math.max(m, x.order + 1), 0));
        await DB.saveMallCategory(c);
        setCategories(prev => [...prev, c]);
    };
    const renameCategory = async (c: MallCategory, name: string) => {
        const next = { ...c, name };
        await DB.saveMallCategory(next);
        setCategories(prev => prev.map(x => x.id === c.id ? next : x));
    };
    const moveCategory = async (c: MallCategory, dir: -1 | 1) => {
        const list = [...kindCats];
        const i = list.findIndex(x => x.id === c.id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
        const renumbered = list.map((x, idx) => ({ ...x, order: idx }));
        await Promise.all(renumbered.map(x => DB.saveMallCategory(x)));
        const byId = new Map(renumbered.map(x => [x.id, x] as const));
        setCategories(prev => prev.map(x => byId.get(x.id) ?? x));
    };
    const deleteCategory = async (c: MallCategory) => {
        const inside = products.filter(p => p.categoryId === c.id);
        await Promise.all([...inside.map(p => DB.deleteMallProduct(p.id)), DB.deleteMallCategory(c.id)]);
        const gone = new Set(inside.map(p => p.id));
        setProducts(prev => prev.filter(p => !gone.has(p.id)));
        setCategories(prev => prev.filter(x => x.id !== c.id));
        setCarts(prev => ({ shop: prev.shop.filter(l => !gone.has(l.productId)), food: prev.food.filter(l => !gone.has(l.productId)) }));
        addToast(inside.length ? `已刪除分類和 ${inside.length} 件商品` : '已刪除分類', 'success');
    };

    // ─── ⟳ AI 補貨：選在某個分類就只補那類，否則當前購物／外賣的每個分類都補 ───
    const restock = async () => {
        const api = resolveMallApi(mallApi, apiConfig);
        if (!api?.baseUrl || !api?.apiKey) { addToast('先在 Me → 設定 選好補貨用的 API', 'info'); return; }
        const targets = kindCats.filter(c => cat === CAT_ALL || cat === CAT_PICKS || c.id === cat);
        if (targets.length === 0) { addToast('先新增一個分類', 'info'); return; }
        setRestocking(true);
        const scope = targets.length === 1 && cat !== CAT_ALL && cat !== CAT_PICKS ? '单一分类' : '全部分类';
        let ok = false;
        try {
            const prompt = buildMallRestockPrompt(kind, targets.map(c => ({
                category: c, existingNames: kindProducts.filter(p => p.categoryId === c.id).map(p => p.name),
            })), restockStyle);
            const response = await fetch(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey}` },
                body: JSON.stringify({ model: api.model, messages: [{ role: 'user', content: prompt }], temperature: 0.9 }),
            });
            if (!response.ok) throw new Error(`API Error ${response.status}`);
            const content = extractContent(await safeResponseJson(response));
            const fresh = parseMallRestockBlocks(content, kind, kindCats, products);
            if (fresh.length === 0) { addToast('這次沒解析出商品，再按一次試試', 'error'); return; }
            await Promise.all(fresh.map(p => DB.saveMallProduct(p)));
            setProducts(prev => [...prev, ...fresh]);
            addToast(`補了 ${fresh.length} 件`, 'success');
            ok = true;
        } catch (e) {
            console.warn('[Mall] AI 補貨失敗:', e);
            addToast('補貨失敗，稍後再試', 'error');
        } finally {
            setRestocking(false);
            trackEvent('购物中心AI补货', { 范围: scope, 结果: ok ? '成功' : '失败', 风格: RESTOCK_STYLE_EVENT[restockStyle] });
        }
    };

    // ─── 結帳：先存訂單（代付結算要靠 orderId 找回它），落卡失敗就把訂單刪掉 ───
    const checkout = async () => {
        if (cartLines.length === 0 || busy) return;
        const toChar = activeRecipient !== 'user' ? activeRecipient : null;
        const daifu = !toChar && payer === 'char' && !!charId;
        const orderCharId = toChar ?? charId;
        const items: MallOrderItem[] = cartLines.map(l => ({
            name: l.product.name, price: l.product.price, qty: l.qty, emoji: l.product.emoji, shop: l.product.shop,
        }));
        const paidAt = daifu ? undefined : Date.now();
        const order = createMallOrder({
            kind, items: items.map(({ name, price, qty, emoji, shop }) => ({ name, price, qty, emoji, shop })), note,
            buyer: 'user', recipient: toChar ? 'char' : 'user', payer: daifu ? 'char' : 'user',
            charId: orderCharId, charName: orderCharId ? nameOf(orderCharId) : undefined, paidAt, createdAt: paidAt,
        });
        setBusy(true);
        try {
            await DB.saveMallOrder(order);
            const ok = await onSendOrder({
                mallKind: kind, mode: daifu ? 'daifu' : toChar ? 'gift' : 'self',
                items, note: order.note, total: order.total, orderId: order.id, paidAt, recipientCharId: toChar ?? undefined,
            });
            if (!ok) { await DB.deleteMallOrder(order.id); return; }
            setOrders(prev => [...prev, order]);
            setCarts(prev => ({ ...prev, [kind]: [] }));
            setNote('');
            // 聊天入口回聊天看卡片和角色的反應；桌面入口留在購物中心看訂單
            if (standalone) {
                setTab('orders');
                addToast(toChar ? `已下單，卡片送進和${nameOf(toChar)}的聊天` : '已下單', 'success');
            } else {
                onClose();
            }
        } catch (e) {
            console.warn('[Mall] 結帳失敗:', e);
            addToast('結帳失敗，稍後再試', 'error');
        } finally {
            setBusy(false);
        }
    };

    const manualCard = async (input: { name: string; price: number; note: string }) => {
        if (!charId) return;
        const paidAt = Date.now();
        const items: MallOrderItem[] = [{ name: input.name, price: input.price, qty: 1, emoji: kind === 'food' ? '🍽️' : '🎁' }];
        const order = createMallOrder({
            kind, items, note: input.note, buyer: 'char', recipient: 'user', payer: 'char', charId, charName, paidAt, createdAt: paidAt,
        });
        await DB.saveMallOrder(order);
        const ok = await onSendOrder({ mallKind: kind, mode: 'manual', items, note: order.note, total: order.total, orderId: order.id, paidAt });
        if (!ok) { await DB.deleteMallOrder(order.id); return; }
        setOrders(prev => [...prev, order]);
        onClose();
    };

    const deleteOrder = async (o: MallOrder) => {
        await DB.deleteMallOrder(o.id);
        setOrders(prev => prev.filter(x => x.id !== o.id));
        addToast('已刪除訂單紀錄', 'success');
    };

    // ─── 資料導入導出（只管購物中心自己的東西，不進全局備份）───
    const exportData = async () => {
        try {
            await shareOrDownloadFile({
                content: JSON.stringify({ exportedAt: Date.now(), version: 2, categories, products, orders }, null, 2),
                fileName: `購物中心-${new Date().toISOString().slice(0, 10)}.json`,
                mimeType: 'application/json',
                shareTitle: '購物中心資料',
            });
            addToast('已導出', 'success');
        } catch (e) {
            console.warn('[Mall] 導出失敗:', e);
            addToast('導出失敗', 'error');
        }
    };
    const importData = async (file: File) => {
        try {
            const parsed = JSON.parse(await file.text());
            const isKind = (k: unknown) => k === 'shop' || k === 'food';
            const catIds = new Set(categories.map(c => c.id));
            const prodIds = new Set(products.map(p => p.id));
            const orderIds = new Set(orders.map(o => o.id));
            const cats: MallCategory[] = (Array.isArray(parsed?.categories) ? parsed.categories : [])
                .filter((c: any) => c?.id && isKind(c?.kind) && c?.name && !catIds.has(c.id));
            const prods: MallProduct[] = (Array.isArray(parsed?.products) ? parsed.products : [])
                .filter((p: any) => p?.id && isKind(p?.kind) && p?.categoryId && p?.name && !prodIds.has(p.id));
            const ords: MallOrder[] = (Array.isArray(parsed?.orders) ? parsed.orders : [])
                .filter((o: any) => o?.id && isKind(o?.kind) && Array.isArray(o?.items) && !orderIds.has(o.id));
            if (cats.length + prods.length + ords.length === 0) { addToast('沒有可導入的新內容', 'info'); return; }
            await Promise.all([...cats.map(c => DB.saveMallCategory(c)), ...prods.map(p => DB.saveMallProduct(p)), ...ords.map(o => DB.saveMallOrder(o))]);
            setCategories(prev => [...prev, ...cats]);
            setProducts(prev => [...prev, ...prods]);
            setOrders(prev => [...prev, ...ords]);
            addToast(`已導入 ${cats.length} 個分類、${prods.length} 件商品、${ords.length} 筆訂單`, 'success');
        } catch (e) {
            console.warn('[Mall] 導入失敗:', e);
            addToast('檔案格式不對，導入失敗', 'error');
        }
    };

    if (!open) return null;

    const switchKind = (k: MallKind) => { setKind(k); setQuery(''); };
    const totalInCarts = cartCount(cart);

    return (
        <div className="fixed inset-0 z-[100] flex flex-col bg-slate-50 animate-fade-in" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="shrink-0 bg-white border-b border-slate-100" style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="flex items-center gap-2 px-3 py-2.5">
                    <button onClick={onClose} className="p-1.5 rounded-full active:bg-slate-100" aria-label={standalone ? '返回' : '返回聊天'}>
                        <CaretLeft size={22} className="text-slate-800" />
                    </button>
                    <div className="text-[16px] font-black text-slate-900 flex-1 min-w-0 truncate">購物中心</div>
                    <div className="w-[118px] shrink-0">
                        <Segmented size="sm" value={kind} onChange={switchKind} options={[{ value: 'shop', label: '購物' }, { value: 'food', label: '外賣' }]} />
                    </div>
                    {tab === 'home' && (
                        <button onClick={restock} disabled={restocking} className="w-9 h-9 rounded-full flex items-center justify-center text-slate-700 active:bg-slate-100 disabled:opacity-60" aria-label="AI 補貨">
                            <ArrowClockwise size={19} weight="bold" className={restocking ? 'animate-spin' : ''} />
                        </button>
                    )}
                </div>
                {tab === 'home' && (
                    <>
                        <div className="px-4 pb-2">
                            <div className="flex items-center gap-2 bg-slate-100 rounded-full px-3.5 py-2">
                                <MagnifyingGlass size={15} className="text-slate-400 shrink-0" />
                                <input value={query} onChange={e => setQuery(e.target.value)} placeholder={`搜尋${kind === 'food' ? '外賣' : '商品'}、品牌`}
                                    className="flex-1 min-w-0 bg-transparent text-[13px] text-slate-800 placeholder:text-slate-400 focus:outline-none" />
                                {query && <button onClick={() => setQuery('')} className="text-slate-400" aria-label="清除"><X size={14} weight="bold" /></button>}
                            </div>
                        </div>
                        <div className="flex items-center gap-1.5 px-4 pb-2.5 overflow-x-auto no-scrollbar">
                            {[{ id: CAT_ALL, name: '全部' }, { id: CAT_PICKS, name: '推薦' }, ...kindCats].map(c => (
                                <button key={c.id} onClick={() => { setActiveCat(prev => ({ ...prev, [kind]: c.id })); setQuery(''); }}
                                    className={`shrink-0 px-3.5 py-1.5 rounded-full text-[12px] font-bold transition-colors ${cat === c.id && !query ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-500'}`}>
                                    {c.name}
                                </button>
                            ))}
                            <button onClick={() => setShowPlus(true)} className="shrink-0 w-8 h-8 rounded-full border border-dashed border-slate-300 text-slate-500 flex items-center justify-center" aria-label="新增商品或管理分類">
                                <Plus size={13} weight="bold" />
                            </button>
                        </div>
                    </>
                )}
            </div>

            {/* 內容 */}
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain no-scrollbar px-4">
                {!loaded ? (
                    <div className="text-center text-xs text-slate-400 py-14">載入中…</div>
                ) : tab === 'home' ? (
                    <MallHome kind={kind} categories={kindCats} products={kindProducts} activeCat={cat} query={query}
                        cartQty={cartQty} onOpen={p => setSheet({ mode: 'view', product: p })} onAdd={addOne} />
                ) : tab === 'cart' ? (
                    <MallCart kind={kind} lines={cartLines} total={total} balance={userBalance}
                        recipientOptions={recipientOptions} recipient={activeRecipient}
                        recipientName={activeRecipient !== 'user' ? nameOf(activeRecipient) : undefined}
                        daifuName={charId ? charName || 'TA' : undefined} standalone={standalone}
                        payer={payer} note={note} busy={busy}
                        onRecipient={setRecipient} onPayer={setPayer} onNote={setNote}
                        onInc={incOne} onDec={decOne} onCheckout={checkout} onBrowse={() => setTab('home')} />
                ) : tab === 'orders' ? (
                    <MallOrders orders={kindOrders} now={now} onDelete={deleteOrder} />
                ) : (
                    <MallMe kind={kind} manualCharName={charId ? charName || 'TA' : undefined} balance={userBalance}
                        favorites={kindProducts.filter(p => p.favorite)} cartQty={cartQty}
                        onOpen={p => setSheet({ mode: 'view', product: p })} onAdd={addOne}
                        mallApi={mallApi} chatApi={apiConfig} apiPresets={apiPresets}
                        onPickApi={(config, label) => { setMallApi(config); setMallApiState(config); addToast(`補貨改用「${label}」`, 'success'); }}
                        wishlistShared={wishlistShared}
                        onToggleWishlistShared={() => {
                            const next = !wishlistShared;
                            setMallWishlistShared(next);
                            setWishlistShared(next);
                            addToast(next ? '角色看得到你的收藏了' : '收藏只有你自己看得到', 'success');
                        }}
                        restockStyle={restockStyle}
                        onPickStyle={style => { setMallRestockStyle(style); setRestockStyle(style); addToast(`補貨風格改成「${MALL_RESTOCK_STYLE_LABELS[style]}」`, 'success'); }}
                        onExport={exportData} onImport={importData} onManualCard={manualCard} />
                )}
                <div className="h-4" />
            </div>

            {/* Tab bar */}
            <div className="shrink-0 bg-white border-t border-slate-100 flex" style={{ paddingBottom: 'var(--safe-bottom)' }}>
                {([
                    { id: 'home', label: 'Home', Icon: House },
                    { id: 'cart', label: 'Cart', Icon: ShoppingCart },
                    { id: 'orders', label: 'Orders', Icon: Receipt },
                    { id: 'me', label: 'Me', Icon: User },
                ] as const).map(({ id, label, Icon }) => (
                    <button key={id} onClick={() => setTab(id)} className={`flex-1 flex flex-col items-center gap-0.5 pt-2 pb-1.5 ${tab === id ? 'text-slate-900' : 'text-slate-400'}`}>
                        <span className="relative">
                            <Icon size={22} weight={tab === id ? 'fill' : 'regular'} />
                            {id === 'cart' && totalInCarts > 0 && (
                                <span className="absolute -top-1.5 -right-2.5 min-w-[16px] h-4 px-1 rounded-full bg-slate-900 text-white text-[9px] font-bold flex items-center justify-center tabular-nums border border-white">{totalInCarts}</span>
                            )}
                        </span>
                        <span className="text-[10px] font-bold tracking-wide">{label}</span>
                    </button>
                ))}
            </div>

            <MallProductSheet target={sheet} kind={kind} categories={kindCats}
                inCart={sheet?.mode === 'view' ? cartQty(sheet.product.id) : 0}
                onClose={() => setSheet(null)}
                onAddToCart={p => { addOne(p); addToast(`已加入：${p.name}`, 'success'); }}
                onToggleFavorite={toggleFavorite} onTogglePinned={togglePinned} onSave={saveProduct} onDelete={deleteProduct} />

            <Modal isOpen={showPlus} title={kind === 'food' ? '外賣' : '購物'} onClose={() => setShowPlus(false)}>
                <div className="space-y-2.5">
                    <button className={primaryBtn} onClick={() => { setShowPlus(false); setSheet({ mode: 'create', categoryId: cat !== CAT_ALL && cat !== CAT_PICKS ? cat : undefined }); }}>
                        新增{kind === 'food' ? '品項' : '商品'}
                    </button>
                    <button className={secondaryBtn} onClick={() => { setShowPlus(false); setShowCats(true); }}>管理分類</button>
                </div>
            </Modal>

            <MallCategoryManager open={showCats} kind={kind} categories={kindCats}
                productCount={id => products.filter(p => p.categoryId === id).length}
                onClose={() => setShowCats(false)} onRename={renameCategory} onMove={moveCategory}
                onDelete={deleteCategory} onCreate={createCategory} />
        </div>
    );
};

export default ShoppingMallMiniApp;
