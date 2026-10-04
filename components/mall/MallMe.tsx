import React, { useRef, useState } from 'react';
import { CaretRight, Database, Heart, PencilSimple, Sparkle } from '@phosphor-icons/react';
import Modal from '../os/Modal';
import type { APIConfig, ApiPreset, MallKind, MallProduct } from '../../types';
import { formatMoney } from '../../utils/realBalance';
import { ProductRow, SectionTitle, inputCls, primaryBtn, secondaryBtn } from './MallParts';

interface Props {
    kind: MallKind;
    charName: string;
    balance: number;
    favorites: MallProduct[];
    cartQty: (productId: string) => number;
    onOpen: (p: MallProduct) => void;
    onAdd: (p: MallProduct) => void;
    /** 購物中心獨立 API；null＝跟隨聊天預設 */
    mallApi: APIConfig | null;
    chatApi: APIConfig;
    apiPresets: ApiPreset[];
    onPickApi: (config: APIConfig | null, label: string) => void;
    onExport: () => void;
    onImport: (file: File) => void;
    onManualCard: (input: { name: string; price: number; note: string }) => void;
}

/** Me：收藏、AI 補貨用的 API、資料導入導出、手動模擬「TA 買給我的」卡片。 */
const MallMe: React.FC<Props> = ({
    kind, charName, balance, favorites, cartQty, onOpen, onAdd,
    mallApi, chatApi, apiPresets, onPickApi, onExport, onImport, onManualCard,
}) => {
    const [showApi, setShowApi] = useState(false);
    const [showData, setShowData] = useState(false);
    const [showManual, setShowManual] = useState(false);
    const [manual, setManual] = useState({ name: '', price: '', note: '' });
    const importRef = useRef<HTMLInputElement>(null);
    const apiLabel = mallApi ? (apiPresets.find(p => p.config.baseUrl === mallApi.baseUrl && p.config.model === mallApi.model)?.name || mallApi.model || '獨立 API') : '跟隨聊天預設';

    return (
        <div className="pb-4">
            <div className="rounded-3xl bg-slate-900 text-white px-5 py-4 mt-3">
                <div className="text-[11px] text-white/50 font-bold tracking-wider">MY BALANCE</div>
                <div className="text-[24px] font-black tabular-nums mt-0.5">{formatMoney(balance)}</div>
                <div className="text-[11px] text-white/50 mt-0.5">結帳從這裡扣，跟「銀行」的現金是同一份</div>
            </div>

            <SectionTitle>收藏 · {kind === 'food' ? '外賣' : '購物'}</SectionTitle>
            {favorites.length === 0 ? (
                <div className="flex items-center gap-2 text-[12px] text-slate-400 py-3"><Heart size={14} /> 在商品詳情點愛心就會收進來</div>
            ) : favorites.map(p => <ProductRow key={p.id} product={p} inCart={cartQty(p.id)} onOpen={() => onOpen(p)} onAdd={() => onAdd(p)} />)}

            <SectionTitle>設定</SectionTitle>
            <div className="rounded-3xl bg-white border border-slate-100 divide-y divide-slate-50">
                <MenuRow icon={<Sparkle size={16} />} title="AI 補貨用哪個 API" sub={apiLabel} onClick={() => setShowApi(true)} />
                <MenuRow icon={<Database size={16} />} title="資料導入導出" sub="分類、商品、訂單" onClick={() => setShowData(true)} />
                <MenuRow icon={<PencilSimple size={16} />} title={`模擬一張「${charName} 買給我的」卡片`} sub="手動填，不扣任何人的錢" onClick={() => setShowManual(true)} />
            </div>
            <div className="text-[11px] text-slate-400 leading-relaxed px-1 pt-3">
                外賣付款後約 8 分鐘開始配送、40 分鐘送達；購物 2 小時出貨、隔天 14:00 送達。純照時間推進。
            </div>

            <Modal isOpen={showApi} title="AI 補貨用哪個 API" onClose={() => setShowApi(false)}>
                <div className="space-y-2">
                    <ApiOption active={!mallApi} title="跟隨聊天預設" sub={chatApi?.model || '未設定'} onClick={() => onPickApi(null, '跟隨聊天預設')} />
                    {apiPresets.length === 0 ? (
                        <p className="px-1 text-[11px] leading-relaxed text-slate-400">「設置」裡還沒有存好的 API 預設。先存預設，這裡就能單獨選。</p>
                    ) : apiPresets.map(preset => (
                        <ApiOption key={preset.id}
                            active={!!mallApi && mallApi.baseUrl === preset.config.baseUrl && mallApi.model === preset.config.model && mallApi.apiKey === preset.config.apiKey}
                            title={preset.name} sub={preset.config.model || '未設定'} onClick={() => onPickApi(preset.config, preset.name)} />
                    ))}
                </div>
            </Modal>

            <Modal isOpen={showData} title="購物中心資料" onClose={() => setShowData(false)}>
                <div className="space-y-3">
                    <button onClick={onExport} className={secondaryBtn}>導出全部分類、商品、訂單</button>
                    <button onClick={() => importRef.current?.click()} className={primaryBtn}>導入 JSON 檔</button>
                    <input ref={importRef} type="file" accept="application/json" className="hidden"
                        onChange={e => { const f = e.target.files?.[0]; if (f) onImport(f); e.target.value = ''; }} />
                    <div className="text-[11px] text-slate-400 leading-relaxed">跟整體設置的導入導出是兩回事，只管購物中心自己的東西。重複導入同一份不會覆蓋已有的（同 id 跳過）。</div>
                </div>
            </Modal>

            <Modal isOpen={showManual} title={`${charName} 買給我的`} onClose={() => setShowManual(false)}
                footer={<button className={primaryBtn} disabled={!manual.name.trim()}
                    onClick={() => { onManualCard({ name: manual.name.trim(), price: parseFloat(manual.price) || 0, note: manual.note.trim() }); setManual({ name: '', price: '', note: '' }); setShowManual(false); }}>
                    彈一張卡片</button>}>
                <div className="space-y-3">
                    <input value={manual.name} onChange={e => setManual(m => ({ ...m, name: e.target.value }))} placeholder="商品名，不在商品庫也行" className={inputCls} autoFocus />
                    <input value={manual.price} onChange={e => setManual(m => ({ ...m, price: e.target.value }))} placeholder="金額（美金）" inputMode="decimal" className={inputCls} />
                    <input value={manual.note} onChange={e => setManual(m => ({ ...m, note: e.target.value }))} placeholder="留言（選填）" className={inputCls} />
                    <div className="text-[11px] text-slate-400 leading-relaxed">純擺設，不扣任何人的錢，{charName}也不會因此回話。會進訂單、照時間配送。現在的{kind === 'food' ? '外賣' : '購物'}模式決定它算哪一種。</div>
                </div>
            </Modal>
        </div>
    );
};

const MenuRow: React.FC<{ icon: React.ReactNode; title: string; sub: string; onClick: () => void }> = ({ icon, title, sub, onClick }) => (
    <button onClick={onClick} className="w-full flex items-center gap-3 px-4 py-3 text-left active:bg-slate-50 first:rounded-t-3xl last:rounded-b-3xl">
        <span className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-slate-600 shrink-0">{icon}</span>
        <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-bold text-slate-800 truncate">{title}</span>
            <span className="block text-[11px] text-slate-400 truncate">{sub}</span>
        </span>
        <CaretRight size={14} className="text-slate-300 shrink-0" />
    </button>
);

const ApiOption: React.FC<{ active: boolean; title: string; sub: string; onClick: () => void }> = ({ active, title, sub, onClick }) => (
    <button onClick={onClick} className={`w-full rounded-2xl border p-3 text-left transition ${active ? 'border-slate-900 bg-slate-50' : 'border-slate-200 bg-white'}`}>
        <div className="text-[12px] font-bold text-slate-800 truncate">{title}</div>
        <div className="text-[10px] text-slate-400 truncate">{sub}</div>
        {active && <div className="text-[10px] font-bold text-slate-900 mt-0.5">✓ 使用中</div>}
    </button>
);

export default MallMe;
