import React, { useState } from 'react';
import type { RealBalanceState } from '../../types';
import { CaretLeft, Plus } from '@phosphor-icons/react';
import FinanceOverview from './FinanceOverview';
import CashFlowTab from './CashFlowTab';
import { trackEvent } from '../../utils/analytics';

interface RealBalancePanelProps {
    state: RealBalanceState;
    /** 每次本地狀態變化都會調用一次，調用方負責落庫（updateUserProfile / updateCharacter）。 */
    onCommit: (next: RealBalanceState) => void;
    onBack: () => void;
    addToast: (message: string, type?: 'info' | 'success' | 'error') => void;
}

type Tab = 'overview' | 'flow';

/**
 * 餘額管理頁——頂部「總覽｜流水」兩個 Tab。設計見 plans/finance-wallet-design.md。
 * 用戶頁面（個人檔案「主頁」）和查手機（角色自己的錢包）共用同一個組件；兩邊的差異只在數據來源
 * （userProfile.realBalance / char.phoneState.realBalance）和落庫方式，由調用方通過 state/onCommit 傳入，
 * 組件本身不關心「這是誰的錢」。
 */
const RealBalancePanel: React.FC<RealBalancePanelProps> = ({ state, onCommit, onBack, addToast }) => {
    const [tab, setTab] = useState<Tab>('overview');
    const [addFlowOpen, setAddFlowOpen] = useState(false);

    return (
        <div className="px-4 pt-4 pb-10 space-y-3">
            <div className="flex items-center gap-2 -ml-1">
                <button onClick={onBack} className="p-1.5 rounded-full hover:bg-black/5 active:scale-90 transition-transform" aria-label="返回">
                    <CaretLeft size={20} className="text-slate-600" />
                </button>
                <h1 className="text-lg font-bold text-slate-800 flex-1">餘額管理</h1>
                {tab === 'flow' && (
                    <button onClick={() => setAddFlowOpen(true)} className="w-8 h-8 rounded-full bg-slate-800 text-white flex items-center justify-center active:scale-90 transition-transform" aria-label="記一筆">
                        <Plus size={16} weight="bold" />
                    </button>
                )}
            </div>

            <div className="grid grid-cols-2 p-1 bg-slate-200/60 rounded-2xl">
                {([['overview', '總覽'], ['flow', '流水']] as const).map(([key, label]) => (
                    <button key={key} onClick={() => { if (tab !== key) trackEvent('切换余额管理分页', { 分页: key === 'overview' ? '总览' : '流水' }); setTab(key); }}
                        className={`py-2 rounded-xl text-xs font-bold transition-colors ${tab === key ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500'}`}>
                        {label}
                    </button>
                ))}
            </div>

            {tab === 'overview'
                ? <FinanceOverview state={state} onCommit={onCommit} addToast={addToast} />
                : <CashFlowTab state={state} onCommit={onCommit} addToast={addToast} addOpen={addFlowOpen} setAddOpen={setAddFlowOpen} />}
        </div>
    );
};

export default RealBalancePanel;
