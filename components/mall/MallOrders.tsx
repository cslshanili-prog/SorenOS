import React, { useState } from 'react';
import { CaretLeft, CaretRight, Receipt } from '@phosphor-icons/react';
import type { MallOrder } from '../../types';
import { formatMoney } from '../../utils/realBalance';
import { formatOrderTime, mallOrderProgress, mallOrderTitle, orderParties, progressLine } from '../../utils/mallOrders';
import { EmojiTile } from './MallParts';

interface Props {
    orders: MallOrder[];
    now: number;
    onDelete: (order: MallOrder) => void;
}

const STAGE_PILL: Record<string, string> = {
    'awaiting-payment': 'bg-amber-50 text-amber-600',
    cancelled: 'bg-slate-100 text-slate-400',
    placed: 'bg-slate-900 text-white',
    'on-the-way': 'bg-slate-900 text-white',
    delivered: 'bg-slate-100 text-slate-500',
};

const itemsLine = (o: MallOrder) => o.items.map(i => `${i.name}${i.qty > 1 ? ` ×${i.qty}` : ''}`).join('、');
const fullTime = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** Orders：全部訂單、新的在上面；點進去看配送進度（純時間推進，見 utils/mallOrders.ts）。 */
const MallOrders: React.FC<Props> = ({ orders, now, onDelete }) => {
    const [openId, setOpenId] = useState<string | null>(null);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const open = orders.find(o => o.id === openId) || null;

    if (open) {
        const p = mallOrderProgress(open, now);
        const parties = orderParties(open);
        return (
            <div className="pt-2 pb-4 space-y-3">
                <button onClick={() => { setOpenId(null); setConfirmDelete(false); }} className="flex items-center gap-1 text-[12px] font-bold text-slate-500 py-1">
                    <CaretLeft size={14} weight="bold" /> 全部訂單
                </button>
                <div className="rounded-3xl bg-slate-900 text-white px-5 py-4">
                    <div className="text-[11px] text-white/50 font-bold tracking-wider">{open.kind === 'food' ? 'DELIVERY' : 'SHIPPING'}</div>
                    <div className="text-[22px] font-black mt-1">{p.label}</div>
                    <div className="text-[12px] text-white/70 mt-0.5">{progressLine(open, now, open.charName || 'TA')}</div>
                </div>

                {p.steps.length > 0 && (
                    <div className="rounded-3xl bg-white border border-slate-100 px-5 py-4">
                        {p.steps.map((s, i) => (
                            <div key={s.key} className="flex gap-3">
                                <div className="flex flex-col items-center">
                                    <div className={`w-3 h-3 rounded-full mt-1 ${s.done ? 'bg-slate-900' : 'bg-white border-2 border-slate-200'}`} />
                                    {i < p.steps.length - 1 && <div className={`w-0.5 flex-1 min-h-[28px] ${p.steps[i + 1].done ? 'bg-slate-900' : 'bg-slate-200'}`} />}
                                </div>
                                <div className="flex-1 flex justify-between pb-4">
                                    <span className={`text-[13px] font-bold ${s.done ? 'text-slate-900' : 'text-slate-400'}`}>{s.label}</span>
                                    <span className={`text-[12px] tabular-nums ${s.done ? 'text-slate-600' : 'text-slate-400'}`}>{s.done ? '' : '預計 '}{formatOrderTime(s.at, now)}</span>
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                <div className="rounded-3xl bg-white border border-slate-100 px-5 py-3 text-[13px] divide-y divide-slate-50">
                    <Row k="配送給" v={parties.to} />
                    <Row k="付款" v={open.cancelledAt ? `${parties.payer}（已拒絕）` : open.paidAt ? parties.payer : `${parties.payer}（還沒付）`} />
                    <Row k="下單" v={fullTime(open.createdAt)} />
                    <Row k="訂單編號" v={open.id.replace(/[^a-z0-9]/gi, '').slice(-8).toUpperCase()} />
                </div>

                <div className="rounded-3xl bg-white border border-slate-100 px-5 py-2">
                    {open.items.map((it, idx) => (
                        <div key={idx} className="flex items-center gap-3 py-2">
                            <EmojiTile emoji={it.emoji} size="sm" />
                            <div className="min-w-0 flex-1">
                                <div className="text-[13px] font-bold text-slate-800 truncate">{it.name}</div>
                                <div className="text-[11px] text-slate-400">{it.shop ? `${it.shop} · ` : ''}×{it.qty}</div>
                            </div>
                            <div className="text-[13px] font-bold text-slate-800 tabular-nums">{formatMoney(it.price * it.qty)}</div>
                        </div>
                    ))}
                    {open.note && <div className="text-[12px] text-slate-500 bg-slate-50 rounded-xl px-3 py-2 my-1.5">留言：{open.note}</div>}
                    <div className="flex justify-between py-2.5 border-t border-slate-50 mt-1">
                        <span className="text-[12px] text-slate-400">合計</span>
                        <span className="text-[15px] font-black text-slate-900 tabular-nums">{formatMoney(open.total)}</span>
                    </div>
                </div>

                {confirmDelete ? (
                    <div className="flex gap-2">
                        <button onClick={() => setConfirmDelete(false)} className="flex-1 py-3 rounded-2xl bg-slate-100 text-slate-600 font-bold text-[13px]">取消</button>
                        <button onClick={() => { onDelete(open); setOpenId(null); setConfirmDelete(false); }} className="flex-1 py-3 rounded-2xl bg-rose-500 text-white font-bold text-[13px]">刪除紀錄</button>
                    </div>
                ) : (
                    <button onClick={() => setConfirmDelete(true)} className="w-full py-2 text-[12px] text-slate-400">
                        刪除這筆訂單紀錄（聊天裡的卡片和錢都不會動）
                    </button>
                )}
            </div>
        );
    }

    if (orders.length === 0) {
        return (
            <div className="flex flex-col items-center text-center py-16 gap-3">
                <div className="w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center text-slate-400"><Receipt size={28} /></div>
                <div className="text-[13px] text-slate-400">還沒有訂單</div>
            </div>
        );
    }

    return (
        <div className="pt-3 space-y-2">
            {orders.map(o => {
                const p = mallOrderProgress(o, now);
                return (
                    <button key={o.id} onClick={() => setOpenId(o.id)}
                        className="w-full text-left rounded-3xl bg-white border border-slate-100 px-4 py-3 flex items-center gap-3 active:bg-slate-50 transition-colors">
                        <EmojiTile emoji={o.items[0]?.emoji} size="sm" />
                        <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                                <span className="text-[13px] font-bold text-slate-900 truncate">{mallOrderTitle(o, o.charName || 'TA')}</span>
                                <span className={`shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full ${STAGE_PILL[p.stage]}`}>{p.label}</span>
                            </div>
                            <div className="text-[11px] text-slate-400 truncate">{itemsLine(o)}</div>
                            <div className="text-[11px] text-slate-400 tabular-nums">{formatOrderTime(o.createdAt, now)} · {formatMoney(o.total)}</div>
                        </div>
                        <CaretRight size={14} className="text-slate-300 shrink-0" />
                    </button>
                );
            })}
        </div>
    );
};

const Row: React.FC<{ k: string; v: string }> = ({ k, v }) => (
    <div className="flex justify-between py-2">
        <span className="text-slate-400">{k}</span>
        <span className="text-slate-800 font-bold">{v}</span>
    </div>
);

export default MallOrders;
