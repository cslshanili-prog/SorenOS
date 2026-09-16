import React, { useEffect, useMemo, useState } from 'react';
import { DB } from '../../utils/db';
import Modal from '../os/Modal';
import type { MallCategory, MallProduct, MallKind, APIConfig, ApiPreset } from '../../types';
import {
    buildDefaultCategories, buildSeedProducts, createMallCategory, createMallProduct,
    resolveCartLines, cartTotal, addToCart, removeFromCart, MallCartLine,
    buildMallRestockPrompt, parseMallRestockItems,
} from '../../utils/shoppingMall';
import { getMallApi, setMallApi, resolveMallApi } from '../../utils/mallApi';
import { safeResponseJson, extractContent, extractJson } from '../../utils/safeApi';
import { shareOrDownloadFile } from '../../utils/shareExport';
import type { MallOrderItem } from '../chat/MallOrderCard';
import {
    CaretLeft, Plus, Minus, Trash, ShoppingCart, PaperPlaneTilt, Gift, PencilSimple,
} from '@phosphor-icons/react';

export interface MallSendOrderInput {
    mallKind: MallKind;
    mode: 'gift' | 'daifu' | 'manual';
    items: MallOrderItem[];
    note?: string;
    total: number;
    title?: string;
}

interface ShoppingMallMiniAppProps {
    open: boolean;
    onClose: () => void;
    charName: string;
    onSendOrder: (order: MallSendOrderInput) => void;
    addToast: (message: string, type?: 'info' | 'success' | 'error') => void;
    /** 聊天默认 API，购物中心没有独立配置时跟随这个。 */
    apiConfig: APIConfig;
    apiPresets: ApiPreset[];
}

const ShoppingMallMiniApp: React.FC<ShoppingMallMiniAppProps> = ({ open, onClose, charName, onSendOrder, addToast, apiConfig, apiPresets }) => {
    const [tab, setTab] = useState<MallKind>('shop');
    const [categories, setCategories] = useState<MallCategory[]>([]);
    const [products, setProducts] = useState<MallProduct[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [activeCategoryId, setActiveCategoryId] = useState<string>('all');
    const [carts, setCarts] = useState<Record<MallKind, MallCartLine[]>>({ shop: [], food: [] });
    const [note, setNote] = useState('');

    const [showAddCategory, setShowAddCategory] = useState(false);
    const [newCategoryName, setNewCategoryName] = useState('');

    const [showManage, setShowManage] = useState(false);

    const [showAddProduct, setShowAddProduct] = useState(false);
    const [newProductName, setNewProductName] = useState('');
    const [newProductPrice, setNewProductPrice] = useState('');
    const [newProductEmoji, setNewProductEmoji] = useState('');
    const [newProductDetail, setNewProductDetail] = useState('');

    const [showManualCard, setShowManualCard] = useState(false);
    const [manualName, setManualName] = useState('');
    const [manualPrice, setManualPrice] = useState('');
    const [manualNote, setManualNote] = useState('');

    // 独立 API（AI 补货用，null = 跟随聊天默认），跟 utils/checkPhoneApi.ts 同一个路数。
    const [mallApiConfig, setMallApiConfigState] = useState<APIConfig | null>(() => getMallApi());
    useEffect(() => {
        const sync = () => setMallApiConfigState(getMallApi());
        window.addEventListener('mall-api-changed', sync);
        return () => window.removeEventListener('mall-api-changed', sync);
    }, []);
    const effectiveApiConfig = resolveMallApi(mallApiConfig, apiConfig);
    const [showApiModal, setShowApiModal] = useState(false);
    const [restocking, setRestocking] = useState(false);

    // 本地导入导出（数据）
    const [showDataModal, setShowDataModal] = useState(false);
    const importInputRef = React.useRef<HTMLInputElement>(null);

    // 首次打开才拉取；某个 kind 还没有分类时现场生成默认分类 + 种子商品并落库，
    // 不在每次打开都重复播种（categories 非空就说明种过了）。
    useEffect(() => {
        if (!open || loaded) return;
        (async () => {
            let [cats, prods] = await Promise.all([DB.getAllMallCategories(), DB.getAllMallProducts()]);
            const missingKinds: MallKind[] = (['shop', 'food'] as MallKind[]).filter(k => !cats.some(c => c.kind === k));
            if (missingKinds.length > 0) {
                const newCats: MallCategory[] = [];
                const newProds: MallProduct[] = [];
                for (const k of missingKinds) {
                    const seededCats = buildDefaultCategories(k);
                    const seededProds = buildSeedProducts(k, seededCats);
                    newCats.push(...seededCats);
                    newProds.push(...seededProds);
                }
                await Promise.all([
                    ...newCats.map(c => DB.saveMallCategory(c)),
                    ...newProds.map(p => DB.saveMallProduct(p)),
                ]);
                cats = [...cats, ...newCats];
                prods = [...prods, ...newProds];
            }
            setCategories(cats);
            setProducts(prods);
            setLoaded(true);
        })();
    }, [open, loaded]);

    const tabCategories = useMemo(
        () => categories.filter(c => c.kind === tab).sort((a, b) => a.order - b.order),
        [categories, tab],
    );
    const tabProducts = useMemo(() => products.filter(p => p.kind === tab), [products, tab]);
    const visibleProducts = useMemo(
        () => activeCategoryId === 'all' ? tabProducts : tabProducts.filter(p => p.categoryId === activeCategoryId),
        [tabProducts, activeCategoryId],
    );
    const cart = carts[tab];
    const cartLines = useMemo(() => resolveCartLines(cart, tabProducts), [cart, tabProducts]);
    const total = useMemo(() => cartTotal(cart, tabProducts), [cart, tabProducts]);

    const switchTab = (next: MallKind) => { setTab(next); setActiveCategoryId('all'); };

    const handleAddToCart = (productId: string) => setCarts(prev => ({ ...prev, [tab]: addToCart(prev[tab], productId) }));
    const handleRemoveFromCart = (productId: string) => setCarts(prev => ({ ...prev, [tab]: removeFromCart(prev[tab], productId) }));

    const handleCreateCategory = async () => {
        const order = tabCategories.length;
        const cat = createMallCategory(tab, newCategoryName, order);
        await DB.saveMallCategory(cat);
        setCategories(prev => [...prev, cat]);
        setActiveCategoryId(cat.id);
        setNewCategoryName('');
        setShowAddCategory(false);
        addToast('已新增分类', 'success');
    };

    const handleDeleteCategory = async (id: string) => {
        const hasProducts = products.some(p => p.categoryId === id);
        if (hasProducts) { addToast('分类里还有商品，先清空或移走再删除', 'error'); return; }
        await DB.deleteMallCategory(id);
        setCategories(prev => prev.filter(c => c.id !== id));
        if (activeCategoryId === id) setActiveCategoryId('all');
        addToast('已删除分类', 'success');
    };

    const handleCreateProduct = async () => {
        const categoryId = activeCategoryId !== 'all' ? activeCategoryId : tabCategories[0]?.id;
        if (!categoryId) { addToast('先新增一个分类', 'info'); return; }
        const price = parseFloat(newProductPrice) || 0;
        const product = createMallProduct(tab, categoryId, { name: newProductName, price, emoji: newProductEmoji, detail: newProductDetail });
        await DB.saveMallProduct(product);
        setProducts(prev => [...prev, product]);
        setNewProductName(''); setNewProductPrice(''); setNewProductEmoji(''); setNewProductDetail('');
        setShowAddProduct(false);
        addToast('已添加商品', 'success');
    };

    const handleDeleteProduct = async (id: string) => {
        await DB.deleteMallProduct(id);
        setProducts(prev => prev.filter(p => p.id !== id));
        setCarts(prev => ({ shop: prev.shop.filter(l => l.productId !== id), food: prev.food.filter(l => l.productId !== id) }));
        addToast('已删除商品', 'success');
    };

    // AI 补货：照 apps/CheckPhone.tsx handleGenerate 的骨架——prompt（带防重复提示）→
    // 裸 fetch chat/completions → extractContent/extractJson 容错解析 → 逐条落库。
    // 按当前选中的分类生成；选的是"全部"就用当前 tab 的第一个分类。
    const handleAiRestock = async () => {
        if (!effectiveApiConfig?.baseUrl || !effectiveApiConfig?.apiKey) {
            addToast('先在"API"里配置好补货用的 API', 'info');
            return;
        }
        const categoryId = activeCategoryId !== 'all' ? activeCategoryId : tabCategories[0]?.id;
        const category = tabCategories.find(c => c.id === categoryId);
        if (!category) { addToast('先新增一个分类', 'info'); return; }

        setRestocking(true);
        try {
            const existingInCategory = tabProducts.filter(p => p.categoryId === category.id);
            const prompt = buildMallRestockPrompt(tab, category.name, existingInCategory);
            const response = await fetch(`${effectiveApiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${effectiveApiConfig.apiKey}` },
                body: JSON.stringify({
                    model: effectiveApiConfig.model,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.9,
                }),
            });
            if (!response.ok) throw new Error(`API Error ${response.status}`);
            const data = await safeResponseJson(response);
            const content = extractContent(data);
            const json = extractJson(content) || [];
            const newProducts = parseMallRestockItems(tab, category.id, json);
            if (newProducts.length === 0) { addToast('这次没解析出商品，换个分类再试试', 'error'); return; }
            await Promise.all(newProducts.map(p => DB.saveMallProduct(p)));
            setProducts(prev => [...prev, ...newProducts]);
            addToast(`补了 ${newProducts.length} 件商品`, 'success');
        } catch (e) {
            console.warn('[Mall] AI 补货失败:', e);
            addToast('补货失败，稍后再试', 'error');
        } finally {
            setRestocking(false);
        }
    };

    // 本地导入导出：跟世界书 apps/WorldbookApp.tsx 的按分类导出同一个路数，独立于全局设置的
    // 导入导出——只导出/导入购物中心自己的分类+商品，不影响别的东西。落盘统一走
    // shareOrDownloadFile（原生分享 / Web 分享 / 浏览器下载三级兜底），不直接碰 anchor.download。
    const handleExportCatalog = async () => {
        const payload = {
            exportedAt: Date.now(),
            categories: categories.map(({ id, kind, name, order }) => ({ id, kind, name, order })),
            products: products.map(({ id, kind, categoryId, name, price, emoji, detail }) => ({ id, kind, categoryId, name, price, emoji, detail })),
        };
        try {
            await shareOrDownloadFile({
                content: JSON.stringify(payload, null, 2),
                fileName: `购物中心-${new Date().toISOString().slice(0, 10)}.json`,
                mimeType: 'application/json',
                shareTitle: '购物中心数据',
            });
            addToast('已导出', 'success');
        } catch (e) {
            console.warn('[Mall] 导出失败:', e);
            addToast('导出失败', 'error');
        }
    };

    const handleImportFile = async (file: File) => {
        try {
            const text = await file.text();
            const parsed = JSON.parse(text);
            const importedCategories: MallCategory[] = Array.isArray(parsed?.categories) ? parsed.categories : [];
            const importedProducts: MallProduct[] = Array.isArray(parsed?.products) ? parsed.products : [];
            if (importedCategories.length === 0 && importedProducts.length === 0) {
                addToast('这个文件里没有可导入的内容', 'error');
                return;
            }
            // id 冲突（比如重复导入同一份）就跳过已存在的，不覆盖本地已有数据。
            const existingCatIds = new Set(categories.map(c => c.id));
            const existingProdIds = new Set(products.map(p => p.id));
            const catsToAdd = importedCategories.filter(c => c?.id && c?.kind && c?.name && !existingCatIds.has(c.id));
            const prodsToAdd = importedProducts.filter(p => p?.id && p?.kind && p?.categoryId && p?.name && !existingProdIds.has(p.id));
            await Promise.all([
                ...catsToAdd.map(c => DB.saveMallCategory(c)),
                ...prodsToAdd.map(p => DB.saveMallProduct(p)),
            ]);
            setCategories(prev => [...prev, ...catsToAdd]);
            setProducts(prev => [...prev, ...prodsToAdd]);
            addToast(`已导入 ${catsToAdd.length} 个分类、${prodsToAdd.length} 件商品`, 'success');
        } catch (e) {
            console.warn('[Mall] 导入失败:', e);
            addToast('文件格式不对，导入失败', 'error');
        }
    };

    const cartAsOrderItems = (): MallOrderItem[] => cartLines.map(l => ({
        name: l.product.name, price: l.product.price, qty: l.qty, emoji: l.product.emoji, detail: l.product.detail,
    }));

    const clearCartAndNote = () => { setCarts(prev => ({ ...prev, [tab]: [] })); setNote(''); };

    const handleSendGift = () => {
        if (cartLines.length === 0) { addToast('购物车还是空的', 'info'); return; }
        onSendOrder({ mallKind: tab, mode: 'gift', items: cartAsOrderItems(), note: note.trim() || undefined, total });
        clearCartAndNote();
        onClose();
    };

    const handleSendReceipt = () => {
        if (cartLines.length === 0) { addToast('购物车还是空的', 'info'); return; }
        onSendOrder({
            mallKind: tab, mode: 'gift', items: cartAsOrderItems(), note: note.trim() || undefined, total,
            title: tab === 'food' ? '你的外卖小票' : '你的购物小票',
        });
        clearCartAndNote();
        onClose();
    };

    const handleSendDaifuRequest = () => {
        if (cartLines.length === 0) { addToast('外卖篮还是空的', 'info'); return; }
        onSendOrder({ mallKind: tab, mode: 'daifu', items: cartAsOrderItems(), note: note.trim() || undefined, total });
        clearCartAndNote();
        onClose();
    };

    const handleSendManual = () => {
        const price = parseFloat(manualPrice) || 0;
        if (!manualName.trim()) { addToast('先填商品名', 'info'); return; }
        onSendOrder({
            mallKind: tab, mode: 'manual', total: price,
            items: [{ name: manualName.trim(), price, qty: 1, emoji: tab === 'food' ? '🍽️' : '🎁' }],
            note: manualNote.trim() || undefined,
        });
        setManualName(''); setManualPrice(''); setManualNote('');
        setShowManualCard(false);
        onClose();
    };

    if (!open) return null;

    return (
        <div className="fixed inset-0 z-[60] bg-black/40 flex items-end justify-center" style={{ paddingBottom: 'var(--safe-bottom)' }} onClick={onClose}>
            <div className="w-full max-w-md h-[88vh] bg-slate-50 rounded-t-[1.75rem] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div className="shrink-0 bg-white border-b border-slate-100">
                    <div className="flex items-center justify-between px-4 pt-3 pb-2">
                        <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-xl bg-rose-100 flex items-center justify-center text-sm">🛍️</div>
                            <span className="text-[15px] font-bold text-slate-800">购物中心</span>
                            <button onClick={onClose} className="text-[11px] text-slate-400 px-1.5 py-0.5 rounded-full border border-slate-200">关</button>
                        </div>
                        <div className="flex bg-slate-100 rounded-full p-0.5">
                            {(['shop', 'food'] as MallKind[]).map(k => (
                                <button key={k} onClick={() => switchTab(k)}
                                    className={`px-3 py-1 rounded-full text-[12px] font-bold transition-colors ${tab === k ? 'bg-white text-rose-500 shadow-sm' : 'text-slate-400'}`}>
                                    {k === 'shop' ? '购物' : '外卖'}
                                </button>
                            ))}
                        </div>
                        <button onClick={onClose} className="w-7 h-7 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-50">✕</button>
                    </div>

                    {/* 分类行 */}
                    <div className="flex items-center gap-1.5 px-4 pb-2 overflow-x-auto no-scrollbar">
                        <button onClick={() => setActiveCategoryId('all')}
                            className={`shrink-0 px-3 py-1.5 rounded-full text-[11px] font-bold ${activeCategoryId === 'all' ? 'bg-rose-500 text-white' : 'bg-slate-100 text-slate-500'}`}>
                            全部
                        </button>
                        {tabCategories.map(c => (
                            <button key={c.id} onClick={() => setActiveCategoryId(c.id)}
                                className={`shrink-0 px-3 py-1.5 rounded-full text-[11px] font-bold ${activeCategoryId === c.id ? 'bg-rose-500 text-white' : 'bg-slate-100 text-slate-500'}`}>
                                {c.name}
                            </button>
                        ))}
                        <button onClick={() => setShowAddCategory(true)} className="shrink-0 px-3 py-1.5 rounded-full text-[11px] font-bold bg-slate-50 text-slate-400 border border-dashed border-slate-200">
                            +分类
                        </button>
                    </div>

                    {/* 工具栏 */}
                    <div className="flex items-center gap-4 px-4 pb-2.5 text-[11px] text-slate-400">
                        <button onClick={() => setShowApiModal(true)}>API</button>
                        <button onClick={() => setShowDataModal(true)}>数据</button>
                        <button onClick={handleAiRestock} disabled={restocking} className="text-rose-400 font-bold disabled:opacity-50">
                            {restocking ? '补货中…' : '✦ AI补货'}
                        </button>
                        <button onClick={() => setShowManage(true)}>管理</button>
                        <button onClick={() => setShowAddProduct(true)} className="ml-auto text-rose-500 font-bold flex items-center gap-1">
                            <Plus size={12} weight="bold" /> 加商品
                        </button>
                    </div>
                </div>

                {/* 商品网格 */}
                <div className="flex-1 overflow-y-auto no-scrollbar px-4 py-3">
                    {!loaded ? (
                        <div className="text-center text-xs text-slate-400 py-10">加载中…</div>
                    ) : visibleProducts.length === 0 ? (
                        <div className="text-center text-xs text-slate-400 py-10">这个分类还没有商品</div>
                    ) : (
                        <div className="grid grid-cols-3 gap-2.5">
                            {visibleProducts.map(p => {
                                const category = categories.find(c => c.id === p.categoryId);
                                return (
                                    <div key={p.id} className="rounded-2xl border border-rose-100 bg-gradient-to-br from-rose-50 to-orange-50 overflow-hidden flex flex-col">
                                        <div className="aspect-square flex items-center justify-center text-3xl bg-white/60">{p.emoji}</div>
                                        <div className="px-2 py-1.5 flex-1 flex flex-col gap-0.5">
                                            <div className="text-[11px] font-bold text-slate-700 truncate">{p.name}</div>
                                            <div className="text-[9px] text-slate-400 truncate">{category?.name || ''}</div>
                                            <div className="text-[11px] font-bold text-rose-500">¥{p.price.toFixed(2)}</div>
                                        </div>
                                        <div className="flex items-center gap-1 px-2 pb-2">
                                            <button onClick={() => handleAddToCart(p.id)} className="flex-1 py-1.5 rounded-full bg-slate-900 text-white text-[10px] font-bold active:scale-95 transition-transform">
                                                + 加入
                                            </button>
                                            <button onClick={() => handleDeleteProduct(p.id)} className="w-6 h-6 rounded-full flex items-center justify-center text-rose-300 active:scale-90">
                                                <Trash size={13} />
                                            </button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* 购物车 / 外卖篮 */}
                <div className="shrink-0 bg-white border-t border-slate-100 px-4 pt-3 pb-3 space-y-2.5 max-h-[42%] overflow-y-auto no-scrollbar">
                    <div className="flex items-center gap-1.5 text-[12px] font-bold text-slate-700">
                        <ShoppingCart size={14} weight="bold" /> {tab === 'food' ? '外卖篮' : '购物车'}
                    </div>
                    {cartLines.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-slate-200 py-4 text-center text-[11px] text-slate-400">还没有选择</div>
                    ) : (
                        <div className="space-y-1.5">
                            {cartLines.map(l => (
                                <div key={l.productId} className="flex items-center gap-2">
                                    <span className="text-base shrink-0">{l.product.emoji}</span>
                                    <span className="flex-1 min-w-0 text-[11px] text-slate-600 truncate">{l.product.name}</span>
                                    <button onClick={() => handleRemoveFromCart(l.productId)} className="w-5 h-5 rounded-full bg-slate-100 flex items-center justify-center active:scale-90"><Minus size={10} weight="bold" /></button>
                                    <span className="w-4 text-center text-[11px] font-bold">{l.qty}</span>
                                    <button onClick={() => handleAddToCart(l.productId)} className="w-5 h-5 rounded-full bg-slate-100 flex items-center justify-center active:scale-90"><Plus size={10} weight="bold" /></button>
                                    <span className="w-14 text-right text-[11px] font-bold text-slate-700">¥{(l.product.price * l.qty).toFixed(2)}</span>
                                </div>
                            ))}
                        </div>
                    )}
                    <div className="flex items-center justify-between text-[12px]">
                        <span className="text-slate-400">合计</span>
                        <span className="font-bold text-slate-800">¥{total.toFixed(2)}</span>
                    </div>
                    <textarea
                        value={note} onChange={e => setNote(e.target.value)}
                        placeholder="包装、原因、想说的话…（会显示在卡片里）"
                        rows={1}
                        className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-[11px] resize-none"
                    />
                    <div className="flex items-center gap-2">
                        <button onClick={handleSendReceipt} className="flex-1 py-2.5 rounded-full bg-slate-100 text-slate-600 text-[12px] font-bold active:scale-95 transition-transform">
                            发小票卡片
                        </button>
                        <button onClick={handleSendGift} className="flex-[1.4] py-2.5 rounded-full bg-gradient-to-r from-rose-500 to-orange-400 text-white text-[12px] font-bold flex items-center justify-center gap-1 active:scale-95 transition-transform">
                            <Gift size={14} weight="bold" /> {tab === 'food' ? '为TA点单' : '送给TA'}
                        </button>
                    </div>
                    {tab === 'food' && (
                        <button onClick={handleSendDaifuRequest} className="w-full py-2.5 rounded-full bg-amber-50 text-amber-600 border border-amber-200 text-[12px] font-bold flex items-center justify-center gap-1 active:scale-95 transition-transform">
                            <PaperPlaneTilt size={14} weight="bold" /> 发起代付请求
                        </button>
                    )}

                    <div className="pt-1.5 border-t border-slate-50">
                        <div className="text-[10px] text-slate-400 mb-1.5">{charName} 主动给我{tab === 'food' ? '点外卖' : '买东西'}（手动模拟，不在商品库也行）</div>
                        <button onClick={() => setShowManualCard(true)} className="w-full py-2 rounded-xl bg-slate-900 text-white text-[11px] font-bold flex items-center justify-center gap-1.5 active:scale-95 transition-transform">
                            <PencilSimple size={12} weight="bold" /> 弹一张{charName}买给我的卡片
                        </button>
                    </div>
                </div>
            </div>

            {/* 新增分类 */}
            <Modal isOpen={showAddCategory} title="新增分类" onClose={() => setShowAddCategory(false)}
                footer={<button onClick={handleCreateCategory} className="w-full py-3 bg-slate-800 text-white font-bold rounded-2xl active:scale-95 transition-transform">添加分类</button>}>
                <input value={newCategoryName} onChange={e => setNewCategoryName(e.target.value)} placeholder="分类名称"
                    className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm" autoFocus />
            </Modal>

            {/* 新增商品 */}
            <Modal isOpen={showAddProduct} title={`新增${tab === 'food' ? '外卖' : '商品'}`} onClose={() => setShowAddProduct(false)}
                footer={<button onClick={handleCreateProduct} className="w-full py-3 bg-slate-800 text-white font-bold rounded-2xl active:scale-95 transition-transform">添加</button>}>
                <div className="space-y-3">
                    <input value={newProductName} onChange={e => setNewProductName(e.target.value)} placeholder="商品名称"
                        className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm" autoFocus />
                    <div className="grid grid-cols-2 gap-3">
                        <input value={newProductPrice} onChange={e => setNewProductPrice(e.target.value)} placeholder="价格" inputMode="decimal"
                            className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm" />
                        <input value={newProductEmoji} onChange={e => setNewProductEmoji(e.target.value)} placeholder="图标 emoji"
                            className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm" />
                    </div>
                    <textarea value={newProductDetail} onChange={e => setNewProductDetail(e.target.value)} placeholder="详情页说明（选填）" rows={2}
                        className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm resize-none" />
                    <div className="text-[10px] text-slate-400">会加进当前选中的分类{activeCategoryId === 'all' ? `（当前是"全部"，默认加进第一个分类）` : ''}</div>
                </div>
            </Modal>

            {/* 分类管理 */}
            <Modal isOpen={showManage} title="管理分类" onClose={() => setShowManage(false)}>
                <div className="space-y-2">
                    {tabCategories.length === 0 && <div className="text-center text-xs text-slate-400 py-4">还没有分类</div>}
                    {tabCategories.map(c => (
                        <div key={c.id} className="flex items-center justify-between px-3 py-2 bg-slate-50 rounded-xl">
                            <span className="text-sm text-slate-700">{c.name}</span>
                            <button onClick={() => handleDeleteCategory(c.id)} className="text-rose-400 active:scale-90"><Trash size={15} /></button>
                        </div>
                    ))}
                </div>
            </Modal>

            {/* TA 主动给我买/点外卖：手动模拟卡 */}
            <Modal isOpen={showManualCard} title={`${charName}主动给我买的`} onClose={() => setShowManualCard(false)}
                footer={<button onClick={handleSendManual} className="w-full py-3 bg-slate-800 text-white font-bold rounded-2xl active:scale-95 transition-transform">弹购买卡片</button>}>
                <div className="space-y-3">
                    <input value={manualName} onChange={e => setManualName(e.target.value)} placeholder="商品名，可不在商品库"
                        className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm" autoFocus />
                    <input value={manualPrice} onChange={e => setManualPrice(e.target.value)} placeholder="金额" inputMode="decimal"
                        className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm" />
                    <input value={manualNote} onChange={e => setManualNote(e.target.value)} placeholder="备注"
                        className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm" />
                    <div className="text-[10px] text-slate-400">纯摆设卡片，不会动 Real Balance——如果想要真的花{charName}的钱，用「发起代付请求」那条走 AI 流程。</div>
                </div>
            </Modal>

            {/* AI 补货用的 API：独立配置，不填就跟随聊天默认 */}
            <Modal isOpen={showApiModal} title="AI 补货用哪个 API" onClose={() => setShowApiModal(false)}>
                <div className="space-y-2">
                    <button onClick={() => { setMallApi(null); setMallApiConfigState(null); addToast('已改为跟随聊天默认', 'success'); }}
                        className={`w-full rounded-2xl border p-3 text-left transition ${!mallApiConfig ? 'border-rose-300 bg-rose-50' : 'border-slate-200 bg-white'}`}>
                        <div className="text-[12px] font-bold text-slate-800">跟随聊天默认</div>
                        <div className="text-[10px] text-slate-400 truncate">{apiConfig?.model || '未配置'}</div>
                        {!mallApiConfig && <div className="text-[10px] font-bold text-rose-500 mt-0.5">✓ 使用中</div>}
                    </button>
                    {apiPresets.length === 0 ? (
                        <p className="px-1 text-[10.5px] leading-relaxed text-slate-400">"设置"里还没有保存的 API 预设。先保存预设，这里就能单独选择。</p>
                    ) : apiPresets.map(preset => {
                        const active = mallApiConfig?.baseUrl === preset.config.baseUrl && mallApiConfig?.model === preset.config.model && mallApiConfig?.apiKey === preset.config.apiKey;
                        return (
                            <button key={preset.id} onClick={() => { setMallApi(preset.config); setMallApiConfigState(preset.config); addToast(`已切换到「${preset.name}」`, 'success'); }}
                                className={`w-full rounded-2xl border p-3 text-left transition ${active ? 'border-rose-300 bg-rose-50' : 'border-slate-200 bg-white'}`}>
                                <div className="text-[12px] font-bold text-slate-800 truncate">{preset.name}</div>
                                <div className="text-[10px] text-slate-400 truncate">{preset.config.model || '未配置'}</div>
                                {active && <div className="text-[10px] font-bold text-rose-500 mt-0.5">✓ 使用中</div>}
                            </button>
                        );
                    })}
                </div>
            </Modal>

            {/* 本地导入导出：只管购物中心自己的分类+商品，独立于全局设置的导入导出 */}
            <Modal isOpen={showDataModal} title="购物中心数据" onClose={() => setShowDataModal(false)}>
                <div className="space-y-3">
                    <button onClick={handleExportCatalog} className="w-full py-3 bg-slate-100 text-slate-700 font-bold rounded-2xl active:scale-95 transition-transform">
                        导出全部分类+商品
                    </button>
                    <button onClick={() => importInputRef.current?.click()} className="w-full py-3 bg-slate-800 text-white font-bold rounded-2xl active:scale-95 transition-transform">
                        导入 JSON 文件
                    </button>
                    <input ref={importInputRef} type="file" accept="application/json" className="hidden"
                        onChange={e => { const f = e.target.files?.[0]; if (f) handleImportFile(f); e.target.value = ''; }} />
                    <div className="text-[10px] text-slate-400 leading-relaxed">跟账号的整体设置导入导出是两回事——这里只导出/导入购物中心自己的分类和商品，不影响其它任何东西。重复导入同一份不会覆盖已有数据（按 id 跳过已存在的）。</div>
                </div>
            </Modal>
        </div>
    );
};

export default ShoppingMallMiniApp;
