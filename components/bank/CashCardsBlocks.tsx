import React, { useState } from 'react';
import Modal from '../os/Modal';
import type { BankCard, RealBalanceState } from '../../types';
import {
    createBankCard, deleteBankCard, transferCardToBalance, transferBalanceToCard,
} from '../../utils/realBalance';
import { formatMoneyDisplay as formatMoney } from '../../utils/finance';
import { ArrowDown, ArrowUp, Trash, CreditCard, Wallet, Bank } from '@phosphor-icons/react';
import { BlockShell } from './FinanceBlockShell';

const CARD_STYLES: Record<BankCard['color'], { bg: string; text: string; sub: string }> = {
    gold: { bg: 'linear-gradient(135deg, #2a2320, #171310)', text: '#f3d98b', sub: 'rgba(243,217,139,0.6)' },
    graphite: { bg: 'linear-gradient(135deg, #3a3d42, #1c1e21)', text: '#e4e6ea', sub: 'rgba(228,230,234,0.55)' },
    silver: { bg: 'linear-gradient(135deg, #9ca3af, #6b7280)', text: '#ffffff', sub: 'rgba(255,255,255,0.7)' },
};
const CARD_LABELS: Record<BankCard['color'], string> = { gold: '黑金', graphite: '石墨', silver: '銀灰' };

interface Props {
    state: RealBalanceState;
    onCommit: (next: RealBalanceState) => void;
    addToast: (message: string, type?: 'info' | 'success' | 'error') => void;
}

/**
 * 總覽裡的「現金」與「銀行」兩塊：現金就是 Real Balance（聊天轉帳、紅包、購物走這裡），
 * 銀行卡沿用原本那套（開卡、互轉、刪卡）。兩塊共用同一個互轉彈窗，所以放在一起。
 */
const CashCardsBlocks: React.FC<Props> = ({ state, onCommit, addToast }) => {
    const [selectedCardId, setSelectedCardId] = useState<string | null>(state.cards[0]?.id ?? null);
    const [showAddCard, setShowAddCard] = useState(false);
    const [newCardName, setNewCardName] = useState('儲蓄卡');
    const [newCardLastFour, setNewCardLastFour] = useState('');
    const [newCardBalance, setNewCardBalance] = useState('');
    const [newCardColor, setNewCardColor] = useState<BankCard['color']>('graphite');
    const [transferModal, setTransferModal] = useState<{ mode: 'in' | 'out'; cardId: string } | null>(null);
    const [transferAmount, setTransferAmount] = useState('');
    const [confirmDeleteCardId, setConfirmDeleteCardId] = useState<string | null>(null);

    const selectedCard = state.cards.find(c => c.id === selectedCardId) || null;
    const cardsTotal = state.cards.reduce((sum, c) => sum + c.balance, 0);

    const handleCreateCard = () => {
        const initial = parseFloat(newCardBalance) || 0;
        const next = createBankCard(state, { name: newCardName, lastFour: newCardLastFour, initialBalance: initial, color: newCardColor });
        onCommit(next);
        setSelectedCardId(next.cards[next.cards.length - 1].id);
        setShowAddCard(false);
        setNewCardName('儲蓄卡'); setNewCardLastFour(''); setNewCardBalance(''); setNewCardColor('graphite');
        addToast('已添加銀行卡', 'success');
    };

    const handleDeleteCard = (cardId: string) => {
        const result = deleteBankCard(state, cardId);
        setConfirmDeleteCardId(null);
        if (!result.ok) { addToast(result.reason, 'error'); return; }
        onCommit(result.state);
        if (selectedCardId === cardId) setSelectedCardId(result.state.cards[0]?.id ?? null);
        addToast('已刪除銀行卡', 'success');
    };

    const openTransferModal = (mode: 'in' | 'out', cardId?: string) => {
        const targetCardId = cardId ?? selectedCardId ?? state.cards[0]?.id;
        if (!targetCardId) { addToast('還沒有銀行卡，先新增一張', 'info'); return; }
        setTransferModal({ mode, cardId: targetCardId });
        setTransferAmount('');
    };

    const commitTransfer = () => {
        if (!transferModal) return;
        const amt = parseFloat(transferAmount);
        if (!amt || amt <= 0) { addToast('請輸入有效金額', 'error'); return; }
        const result = transferModal.mode === 'in'
            ? transferCardToBalance(state, transferModal.cardId, amt)
            : transferBalanceToCard(state, transferModal.cardId, amt);
        if (!result.ok) { addToast(result.reason, 'error'); return; }
        onCommit(result.state);
        setTransferModal(null);
        setTransferAmount('');
        addToast(transferModal.mode === 'in' ? '已轉入現金' : '已存進銀行卡', 'success');
    };

    return (
        <>
            {/* 現金 */}
            <BlockShell icon={<Wallet size={16} weight="fill" />} title="現金" total={state.balance}>
                <div className="px-4 pb-4">
                    <div className="text-[11px] text-slate-400">聊天轉帳、紅包、購物、外賣都從這裡進出</div>
                    {state.balance <= 0 && (
                        <div className="mt-2 text-[11px] leading-relaxed text-amber-700 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">
                            現金是 0，聊天裡轉帳、發紅包、買東西會失敗。先到「流水」按右上角 ＋ 記一筆收入，或從銀行卡轉進來。
                        </div>
                    )}
                    <div className="flex items-center gap-2 mt-3">
                        <button onClick={() => openTransferModal('in')} className="flex-1 py-2 rounded-full bg-sky-50 text-sky-600 text-xs font-bold flex items-center justify-center gap-1 active:scale-95 transition-transform">
                            <ArrowDown size={14} weight="bold" /> 從卡轉入
                        </button>
                        <button onClick={() => openTransferModal('out')} className="flex-1 py-2 rounded-full bg-sky-50 text-sky-600 text-xs font-bold flex items-center justify-center gap-1 active:scale-95 transition-transform">
                            <ArrowUp size={14} weight="bold" /> 存進卡
                        </button>
                    </div>
                </div>
            </BlockShell>

            {/* 銀行 */}
            <BlockShell icon={<Bank size={16} weight="fill" />} title="銀行" total={cardsTotal} onAdd={() => setShowAddCard(true)}>
                {state.cards.length === 0 ? (
                    <div className="px-4 pb-4 text-[11px] text-slate-400">還沒有銀行卡</div>
                ) : (
                    <div className="pb-4 space-y-3">
                        <div className="flex gap-3 overflow-x-auto no-scrollbar px-4 pb-1">
                            {state.cards.map(card => {
                                const style = CARD_STYLES[card.color];
                                const active = card.id === selectedCardId;
                                return (
                                    <button
                                        key={card.id}
                                        onClick={() => setSelectedCardId(card.id)}
                                        className="shrink-0 w-52 rounded-2xl p-4 text-left transition-transform active:scale-[0.98]"
                                        style={{ background: style.bg, outline: active ? '2px solid #38bdf8' : 'none', outlineOffset: 2 }}
                                    >
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-1.5" style={{ color: style.text }}>
                                                <CreditCard size={16} weight="fill" />
                                                <span className="text-[11px] font-bold tracking-wide truncate max-w-[7rem]">{card.name}</span>
                                            </div>
                                            <span className="text-[9px] font-bold" style={{ color: style.sub }}>{CARD_LABELS[card.color]}</span>
                                        </div>
                                        <div className="text-[10px] mt-3 tracking-[0.2em]" style={{ color: style.sub }}>
                                            **** {card.lastFour}
                                        </div>
                                        <div className="text-sm font-bold mt-1" style={{ color: style.text }}>{formatMoney(card.balance)}</div>
                                    </button>
                                );
                            })}
                        </div>
                        {selectedCard && (
                            <div className="flex gap-2 px-4">
                                <button onClick={() => openTransferModal('in', selectedCard.id)} className="flex-1 py-2 rounded-xl bg-emerald-50 text-emerald-600 text-[11px] font-bold flex items-center justify-center gap-1 active:scale-95 transition-transform">
                                    <ArrowDown size={13} weight="bold" /> 轉到現金
                                </button>
                                <button onClick={() => openTransferModal('out', selectedCard.id)} className="flex-1 py-2 rounded-xl bg-slate-100 text-slate-600 text-[11px] font-bold flex items-center justify-center gap-1 active:scale-95 transition-transform">
                                    <ArrowUp size={13} weight="bold" /> 從現金存入
                                </button>
                                <button onClick={() => setConfirmDeleteCardId(selectedCard.id)} className="py-2 px-3 rounded-xl bg-rose-50 text-rose-500 text-[11px] font-bold flex items-center justify-center gap-1 active:scale-95 transition-transform" aria-label="刪除這張卡">
                                    <Trash size={13} weight="bold" />
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </BlockShell>

            {/* 新增銀行卡 */}
            <Modal isOpen={showAddCard} title="新增銀行卡" onClose={() => setShowAddCard(false)}
                footer={<button onClick={handleCreateCard} className="w-full py-3 bg-slate-800 text-white font-bold rounded-2xl active:scale-95 transition-transform">添加銀行卡</button>}>
                <div className="space-y-4">
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 block mb-1">卡片名稱</label>
                        <input value={newCardName} onChange={e => setNewCardName(e.target.value)} placeholder="儲蓄卡"
                            className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 block mb-1">尾號</label>
                            <input value={newCardLastFour} onChange={e => setNewCardLastFour(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="0000" inputMode="numeric"
                                className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm" />
                        </div>
                        <div>
                            <div className="flex items-center justify-between mb-1">
                                <label className="text-[10px] font-bold text-slate-400">初始餘額</label>
                                <span className="text-[9px] text-slate-300">不能為負</span>
                            </div>
                            <input value={newCardBalance} onChange={e => setNewCardBalance(e.target.value)} placeholder="0" inputMode="decimal"
                                className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm" />
                        </div>
                    </div>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 block mb-2">卡面配色</label>
                        <div className="flex gap-2">
                            {(['gold', 'graphite', 'silver'] as const).map(color => (
                                <button key={color} onClick={() => setNewCardColor(color)}
                                    className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-colors ${newCardColor === color ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-500'}`}>
                                    {CARD_LABELS[color]}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            </Modal>

            {/* 現金 ↔ 銀行卡 */}
            <Modal isOpen={!!transferModal} title={transferModal?.mode === 'in' ? '從卡轉到現金' : '從現金存進卡'} onClose={() => setTransferModal(null)}
                footer={<button onClick={commitTransfer} className="w-full py-3 bg-slate-800 text-white font-bold rounded-2xl active:scale-95 transition-transform">確認</button>}>
                {transferModal && (() => {
                    const card = state.cards.find(c => c.id === transferModal.cardId);
                    return (
                        <div className="space-y-4">
                            {state.cards.length > 1 && (
                                <div>
                                    <label className="text-[10px] font-bold text-slate-400 block mb-1">銀行卡</label>
                                    <select value={transferModal.cardId} onChange={e => setTransferModal({ ...transferModal, cardId: e.target.value })}
                                        className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm">
                                        {state.cards.map(c => <option key={c.id} value={c.id}>{c.name} {c.lastFour}</option>)}
                                    </select>
                                </div>
                            )}
                            <div>
                                <label className="text-[10px] font-bold text-slate-400 block mb-1">金額</label>
                                <input value={transferAmount} onChange={e => setTransferAmount(e.target.value)} placeholder="0.00" inputMode="decimal" autoFocus
                                    className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm" />
                            </div>
                            <p className="text-[10px] text-slate-400">
                                {transferModal.mode === 'in'
                                    ? `「${card?.name || '銀行卡'}」目前 ${formatMoney(card?.balance ?? 0)}`
                                    : `現金目前 ${formatMoney(state.balance)}`}
                            </p>
                        </div>
                    );
                })()}
            </Modal>

            {/* 刪除銀行卡確認 */}
            <Modal isOpen={!!confirmDeleteCardId} title="刪除這張銀行卡？" onClose={() => setConfirmDeleteCardId(null)}
                footer={
                    <div className="flex gap-3 w-full">
                        <button onClick={() => setConfirmDeleteCardId(null)} className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform">取消</button>
                        <button onClick={() => confirmDeleteCardId && handleDeleteCard(confirmDeleteCardId)} className="flex-1 py-3 bg-rose-500 text-white font-bold rounded-2xl active:scale-95 transition-transform">刪除</button>
                    </div>
                }>
                <p className="text-xs text-slate-500 leading-relaxed">
                    卡裡沒有餘額才能刪除。刪除後這張卡的流水仍會保留。
                </p>
            </Modal>
        </>
    );
};

export default CashCardsBlocks;
