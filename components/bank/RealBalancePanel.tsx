import React, { useState } from 'react';
import Modal from '../os/Modal';
import { BankCard, RealBalanceState } from '../../types';
import {
    createBankCard, deleteBankCard, transferCardToBalance, transferBalanceToCard,
} from '../../utils/realBalance';
import {
    CaretLeft, ArrowDown, ArrowUp, Trash, CreditCard, Plus,
} from '@phosphor-icons/react';

const CARD_STYLES: Record<BankCard['color'], { bg: string; text: string; sub: string }> = {
    gold: { bg: 'linear-gradient(135deg, #2a2320, #171310)', text: '#f3d98b', sub: 'rgba(243,217,139,0.6)' },
    graphite: { bg: 'linear-gradient(135deg, #3a3d42, #1c1e21)', text: '#e4e6ea', sub: 'rgba(228,230,234,0.55)' },
    silver: { bg: 'linear-gradient(135deg, #9ca3af, #6b7280)', text: '#ffffff', sub: 'rgba(255,255,255,0.7)' },
};
const CARD_LABELS: Record<BankCard['color'], string> = { gold: '黑金', graphite: '石墨', silver: '银灰' };

interface RealBalancePanelProps {
    state: RealBalanceState;
    /** 每次本地状态变化（开卡/删卡/互转）都会调用一次，调用方负责落库（updateUserProfile / updateCharacter）。 */
    onCommit: (next: RealBalanceState) => void;
    onBack: () => void;
    addToast: (message: string, type?: 'info' | 'success' | 'error') => void;
}

/**
 * 余额管理页——Real Balance 总览 + 银行卡横向列表 + 选中卡详情 + 共用流水。
 * 用户页面（apps/ChatHub.tsx「主页」栏）和查手机（apps/CheckPhone.tsx，角色自己的 Real Balance）
 * 共用同一个组件；两边的差异只在数据来源（userProfile.realBalance / char.phoneState.realBalance）
 * 和落库方式（updateUserProfile / updateCharacter），都由调用方通过 state/onCommit 传入，
 * 组件本身不关心「这是谁的钱」。
 */
const RealBalancePanel: React.FC<RealBalancePanelProps> = ({ state, onCommit, onBack, addToast }) => {
    const [selectedCardId, setSelectedCardId] = useState<string | null>(state.cards[0]?.id ?? null);
    const [showAddCard, setShowAddCard] = useState(false);
    const [newCardName, setNewCardName] = useState('储蓄卡');
    const [newCardLastFour, setNewCardLastFour] = useState('');
    const [newCardBalance, setNewCardBalance] = useState('');
    const [newCardColor, setNewCardColor] = useState<BankCard['color']>('graphite');
    const [transferModal, setTransferModal] = useState<{ mode: 'in' | 'out'; cardId: string } | null>(null);
    const [transferAmount, setTransferAmount] = useState('');
    const [confirmDeleteCardId, setConfirmDeleteCardId] = useState<string | null>(null);

    const selectedCard = state.cards.find(c => c.id === selectedCardId) || null;
    const recentTx = [...state.transactions].sort((a, b) => b.timestamp - a.timestamp);

    const handleCreateCard = () => {
        const initial = parseFloat(newCardBalance) || 0;
        const next = createBankCard(state, { name: newCardName, lastFour: newCardLastFour, initialBalance: initial, color: newCardColor });
        onCommit(next);
        setSelectedCardId(next.cards[next.cards.length - 1].id);
        setShowAddCard(false);
        setNewCardName('储蓄卡'); setNewCardLastFour(''); setNewCardBalance(''); setNewCardColor('graphite');
        addToast('已添加银行卡', 'success');
    };

    const handleDeleteCard = (cardId: string) => {
        const result = deleteBankCard(state, cardId);
        setConfirmDeleteCardId(null);
        if (!result.ok) { addToast(result.reason, 'error'); return; }
        onCommit(result.state);
        if (selectedCardId === cardId) setSelectedCardId(result.state.cards[0]?.id ?? null);
        addToast('已删除银行卡', 'success');
    };

    const openTransferModal = (mode: 'in' | 'out', cardId?: string) => {
        const targetCardId = cardId ?? selectedCardId ?? state.cards[0]?.id;
        if (!targetCardId) { addToast('还没有银行卡，先新增一张', 'info'); return; }
        setTransferModal({ mode, cardId: targetCardId });
        setTransferAmount('');
    };

    const commitTransfer = () => {
        if (!transferModal) return;
        const amt = parseFloat(transferAmount);
        if (!amt || amt <= 0) { addToast('请输入有效金额', 'error'); return; }
        const result = transferModal.mode === 'in'
            ? transferCardToBalance(state, transferModal.cardId, amt)
            : transferBalanceToCard(state, transferModal.cardId, amt);
        if (!result.ok) { addToast(result.reason, 'error'); return; }
        onCommit(result.state);
        setTransferModal(null);
        setTransferAmount('');
        addToast(transferModal.mode === 'in' ? '已转入账户' : '已转出账户', 'success');
    };

    return (
        <div className="px-5 pt-4 pb-8 space-y-4">
            <div className="flex items-center gap-2 -ml-1">
                <button onClick={onBack} className="p-1.5 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                    <CaretLeft size={20} className="text-slate-600" />
                </button>
                <h1 className="text-lg font-bold text-slate-800">余额管理</h1>
            </div>

            {/* Real Balance 总览 */}
            <div className="bg-gradient-to-br from-sky-50 to-blue-50 rounded-[1.75rem] border border-sky-100 p-5">
                <div className="flex items-center justify-between">
                    <div className="text-[10px] font-bold text-sky-400 tracking-widest uppercase">Real Balance</div>
                    <div className="text-[11px] text-sky-500">{state.cards.length} 张银行卡</div>
                </div>
                <div className="text-2xl font-black text-slate-800 mt-1">¥{state.balance.toFixed(2)}</div>
                <div className="text-[11px] text-sky-500 mt-2">红包、转账与余额支付默认使用这里</div>
                <div className="flex items-center gap-2 mt-3">
                    <button onClick={() => openTransferModal('in')} className="flex-1 py-2 rounded-full bg-white text-sky-600 text-xs font-bold flex items-center justify-center gap-1 active:scale-95 transition-transform border border-sky-100">
                        <ArrowDown size={14} weight="bold" /> 转入
                    </button>
                    <button onClick={() => openTransferModal('out')} className="flex-1 py-2 rounded-full bg-white text-sky-600 text-xs font-bold flex items-center justify-center gap-1 active:scale-95 transition-transform border border-sky-100">
                        <ArrowUp size={14} weight="bold" /> 提现
                    </button>
                </div>
                <div className="text-[10px] text-sky-400 mt-2">{recentTx.length} 条流水</div>
            </div>

            {/* 银行卡横向列表 */}
            <div>
                <div className="flex items-center justify-between mb-2 px-0.5">
                    <span className="text-xs font-bold text-slate-700">银行卡</span>
                    <button onClick={() => setShowAddCard(true)} className="text-xs font-bold text-sky-500 flex items-center gap-1">
                        <Plus size={14} weight="bold" /> 新增卡
                    </button>
                </div>
                {state.cards.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-slate-200 py-8 text-center text-xs text-slate-400">
                        还没有银行卡 · 点右上角新增
                    </div>
                ) : (
                    <div className="flex gap-3 overflow-x-auto no-scrollbar pb-1 -mx-1 px-1">
                        {state.cards.map(card => {
                            const style = CARD_STYLES[card.color];
                            const active = card.id === selectedCardId;
                            return (
                                <button
                                    key={card.id}
                                    onClick={() => setSelectedCardId(card.id)}
                                    className="shrink-0 w-56 rounded-2xl p-4 text-left transition-transform active:scale-[0.98]"
                                    style={{ background: style.bg, outline: active ? '2px solid #38bdf8' : 'none', outlineOffset: 2 }}
                                >
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-1.5" style={{ color: style.text }}>
                                            <CreditCard size={16} weight="fill" />
                                            <span className="text-[11px] font-bold tracking-wide">CHAT WALLET</span>
                                        </div>
                                        <span className="text-[9px] font-bold" style={{ color: style.sub }}>储蓄</span>
                                    </div>
                                    <div className="text-[10px] mt-3 tracking-[0.2em]" style={{ color: style.sub }}>
                                        **** **** **** {card.lastFour}
                                    </div>
                                    <div className="flex items-end justify-between mt-3">
                                        <div>
                                            <div className="text-[8px] uppercase" style={{ color: style.sub }}>{card.name}</div>
                                            <div className="text-sm font-bold" style={{ color: style.text }}>¥{card.balance.toFixed(2)}</div>
                                        </div>
                                        <span className="text-[9px] font-bold" style={{ color: style.sub }}>{CARD_LABELS[card.color]}</span>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* 选中卡片详情 */}
            {selectedCard && (
                <div className="bg-white rounded-[1.75rem] shadow-[0_10px_30px_-12px_rgba(80,70,120,0.18)] border border-slate-100 p-4 space-y-3">
                    <div>
                        <div className="text-[10px] text-slate-400">当前银行卡余额</div>
                        <div className="text-xl font-black text-slate-800 mt-0.5">¥{selectedCard.balance.toFixed(2)}</div>
                        <div className="text-[10px] text-slate-400 mt-0.5">{selectedCard.name} · **** **** **** {selectedCard.lastFour}</div>
                    </div>
                    <div className="flex gap-2">
                        <button onClick={() => openTransferModal('in', selectedCard.id)} className="flex-1 py-2 rounded-xl bg-emerald-50 text-emerald-600 text-[11px] font-bold flex items-center justify-center gap-1 active:scale-95 transition-transform">
                            <ArrowDown size={13} weight="bold" /> 转入账户
                        </button>
                        <button onClick={() => openTransferModal('out', selectedCard.id)} className="flex-1 py-2 rounded-xl bg-slate-100 text-slate-600 text-[11px] font-bold flex items-center justify-center gap-1 active:scale-95 transition-transform">
                            <ArrowUp size={13} weight="bold" /> 转出账户
                        </button>
                        <button onClick={() => setConfirmDeleteCardId(selectedCard.id)} className="flex-1 py-2 rounded-xl bg-rose-50 text-rose-500 text-[11px] font-bold flex items-center justify-center gap-1 active:scale-95 transition-transform">
                            <Trash size={13} weight="bold" /> 删除
                        </button>
                    </div>
                </div>
            )}

            {/* 流水 */}
            <div className="bg-white rounded-[1.75rem] shadow-[0_10px_30px_-12px_rgba(80,70,120,0.18)] border border-slate-100 p-4">
                <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-bold text-slate-700">流水</span>
                    <span className="text-[10px] text-slate-400">余额、银行卡与购物付款实时同步</span>
                </div>
                <div className="space-y-2.5">
                    {recentTx.length === 0 && <div className="text-center text-xs text-slate-400 py-4">还没有流水</div>}
                    {recentTx.map(tx => {
                        const positive = tx.amount >= 0;
                        return (
                            <div key={tx.id} className="flex items-center gap-3">
                                <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${positive ? 'bg-emerald-50 text-emerald-500' : 'bg-rose-50 text-rose-500'}`}>
                                    {positive ? <ArrowDown size={14} weight="bold" /> : <ArrowUp size={14} weight="bold" />}
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className="text-xs font-bold text-slate-700 truncate">{tx.label}</div>
                                    <div className="text-[10px] text-slate-400 truncate">
                                        {new Date(tx.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                                        {tx.detail ? ` · ${tx.detail}` : ''}
                                    </div>
                                </div>
                                <div className="text-right shrink-0">
                                    <div className={`text-xs font-bold ${positive ? 'text-emerald-500' : 'text-rose-500'}`}>
                                        {positive ? '+' : ''}¥{tx.amount.toFixed(2)}
                                    </div>
                                    <div className="text-[10px] text-slate-400">余 ¥{tx.balanceAfter.toFixed(2)}</div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* 新增银行卡 */}
            <Modal isOpen={showAddCard} title="新增银行卡" onClose={() => setShowAddCard(false)}
                footer={<button onClick={handleCreateCard} className="w-full py-3 bg-slate-800 text-white font-bold rounded-2xl active:scale-95 transition-transform">添加银行卡</button>}>
                <div className="space-y-4">
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">卡片名称</label>
                        <input value={newCardName} onChange={e => setNewCardName(e.target.value)} placeholder="储蓄卡"
                            className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">尾号</label>
                            <input value={newCardLastFour} onChange={e => setNewCardLastFour(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="0000" inputMode="numeric"
                                className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm" />
                        </div>
                        <div>
                            <div className="flex items-center justify-between mb-1">
                                <label className="text-[10px] font-bold text-slate-400 uppercase">初始余额</label>
                                <span className="text-[9px] text-slate-300">余额不能为负</span>
                            </div>
                            <input value={newCardBalance} onChange={e => setNewCardBalance(e.target.value)} placeholder="0" inputMode="decimal"
                                className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm" />
                        </div>
                    </div>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase block mb-2">卡面配色</label>
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

            {/* 转入 Real Balance / 提现到银行卡 */}
            <Modal isOpen={!!transferModal} title={transferModal?.mode === 'in' ? '转入 Real Balance' : '提现到银行卡'} onClose={() => setTransferModal(null)}
                footer={<button onClick={commitTransfer} className="w-full py-3 bg-slate-800 text-white font-bold rounded-2xl active:scale-95 transition-transform">确认{transferModal?.mode === 'in' ? '转入' : '提现'}</button>}>
                {transferModal && (() => {
                    const card = state.cards.find(c => c.id === transferModal.cardId);
                    return (
                        <div className="space-y-4">
                            <p className="text-xs text-slate-500">
                                {transferModal.mode === 'in'
                                    ? `从「${card?.name || '银行卡'}」转入 Real Balance`
                                    : `从 Real Balance 转出到「${card?.name || '银行卡'}」`}
                            </p>
                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">金额</label>
                                <input value={transferAmount} onChange={e => setTransferAmount(e.target.value)} placeholder="0.00" inputMode="decimal" autoFocus
                                    className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm" />
                            </div>
                            <p className="text-[10px] text-slate-400">
                                {transferModal.mode === 'in'
                                    ? `这张卡当前余额 ¥${(card?.balance ?? 0).toFixed(2)}`
                                    : `Real Balance 当前余额 ¥${state.balance.toFixed(2)}`}
                            </p>
                        </div>
                    );
                })()}
            </Modal>

            {/* 删除银行卡确认 */}
            <Modal isOpen={!!confirmDeleteCardId} title="删除这张银行卡？" onClose={() => setConfirmDeleteCardId(null)}
                footer={
                    <div className="flex gap-3 w-full">
                        <button onClick={() => setConfirmDeleteCardId(null)} className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform">取消</button>
                        <button onClick={() => confirmDeleteCardId && handleDeleteCard(confirmDeleteCardId)} className="flex-1 py-3 bg-rose-500 text-white font-bold rounded-2xl active:scale-95 transition-transform">删除</button>
                    </div>
                }>
                <p className="text-xs text-slate-500 leading-relaxed">
                    卡里没有余额才能删除。删除后这张卡的流水记录仍会保留在下面的共用流水里。
                </p>
            </Modal>
        </div>
    );
};

export default RealBalancePanel;
