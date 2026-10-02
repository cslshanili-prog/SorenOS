import React, { useState } from 'react';
import type { RealBalanceState } from '../../types';
import { ArrowsClockwise, CaretLeft, Plus } from '@phosphor-icons/react';
import Modal from '../os/Modal';
import {
    applyGeneratedFlows, applyGeneratedOverview, buildFlowPrompt, buildOverviewPrompt, hasAiFlows, hasOverviewContent,
    parseFlows, parseOverview, requestFinanceJson, type FinanceApi,
} from '../../utils/financeGenerate';
import FinanceOverview from './FinanceOverview';
import CashFlowTab from './CashFlowTab';
import { trackEvent } from '../../utils/analytics';

interface RealBalancePanelProps {
    state: RealBalanceState;
    /** 每次本地狀態變化都會調用一次，調用方負責落庫（updateUserProfile / updateCharacter）。 */
    onCommit: (next: RealBalanceState) => void;
    onBack: () => void;
    addToast: (message: string, type?: 'info' | 'success' | 'error') => void;
    /**
     * 右上角 ⟳ 的 AI 生成（第三批）。system 是角色設定或用戶身份卡那一段；api 沒配好就提示去設置。
     * 不傳就不顯示 ⟳。
     */
    ai?: { ownerName: string; system: () => string; api: FinanceApi | null | undefined };
}

type Tab = 'overview' | 'flow';

/**
 * 餘額管理頁——頂部「總覽｜流水」兩個 Tab。設計見 plans/finance-wallet-design.md。
 * 用戶頁面（個人檔案「主頁」）和查手機（角色自己的錢包）共用同一個組件；兩邊的差異只在數據來源
 * （userProfile.realBalance / char.phoneState.realBalance）和落庫方式，由調用方通過 state/onCommit 傳入，
 * 組件本身不關心「這是誰的錢」。
 */
const RealBalancePanel: React.FC<RealBalancePanelProps> = ({ state, onCommit, onBack, addToast, ai }) => {
    const [tab, setTab] = useState<Tab>('overview');
    const [addFlowOpen, setAddFlowOpen] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [confirmRegen, setConfirmRegen] = useState<Tab | null>(null);

    const generate = async (target: Tab) => {
        setConfirmRegen(null);
        if (!ai) return;
        if (!ai.api?.baseUrl || !ai.api?.apiKey) { addToast('先在設置裡配置好 API', 'info'); return; }
        setGenerating(true);
        try {
            const system = ai.system();
            if (target === 'overview') {
                const gen = parseOverview(await requestFinanceJson(ai.api, system, buildOverviewPrompt(ai.ownerName)));
                if (!gen) { addToast('這次沒解析出內容，再試一次', 'error'); trackEvent('AI 生成余额管理', { 分页: '总览', 结果: '失败' }); return; }
                onCommit(applyGeneratedOverview(state, gen));
                addToast('已生成財務狀況', 'success');
                trackEvent('AI 生成余额管理', { 分页: '总览', 结果: '成功' });
            } else {
                const flows = parseFlows(await requestFinanceJson(ai.api, system, buildFlowPrompt(state, ai.ownerName)), state);
                if (!flows.length) { addToast('這次沒解析出流水，再試一次', 'error'); trackEvent('AI 生成余额管理', { 分页: '流水', 结果: '失败' }); return; }
                onCommit(applyGeneratedFlows(state, flows));
                addToast(`已生成 ${flows.length} 筆流水`, 'success');
                trackEvent('AI 生成余额管理', { 分页: '流水', 结果: '成功' });
            }
        } catch (e) {
            console.warn('[Finance] AI 生成失敗:', e);
            addToast('生成失敗，稍後再試', 'error');
            trackEvent('AI 生成余额管理', { 分页: target === 'overview' ? '总览' : '流水', 结果: '失败' });
        } finally {
            setGenerating(false);
        }
    };
    const onRegen = () => {
        if (generating) return;
        const needsConfirm = tab === 'overview' ? hasOverviewContent(state) : hasAiFlows(state);
        if (needsConfirm) setConfirmRegen(tab); else void generate(tab);
    };

    return (
        <div className="px-4 pt-4 pb-10 space-y-3">
            <div className="flex items-center gap-2 -ml-1">
                <button onClick={onBack} className="p-1.5 rounded-full hover:bg-black/5 active:scale-90 transition-transform" aria-label="返回">
                    <CaretLeft size={20} className="text-slate-600" />
                </button>
                <h1 className="text-lg font-bold text-slate-800 flex-1">餘額管理</h1>
                {ai && (
                    <button onClick={onRegen} disabled={generating}
                        className="w-8 h-8 rounded-full bg-white border border-slate-200 text-slate-600 flex items-center justify-center active:scale-90 transition-transform disabled:opacity-60"
                        aria-label={tab === 'overview' ? 'AI 生成財務狀況' : 'AI 生成流水'}>
                        <ArrowsClockwise size={16} weight="bold" className={generating ? 'animate-spin' : ''} />
                    </button>
                )}
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

            {generating && (
                <div className="text-center text-[11px] text-slate-400">{tab === 'overview' ? '正在照人設編財務狀況…' : '正在編最近一個月的流水…'}</div>
            )}

            <Modal isOpen={!!confirmRegen} title={confirmRegen === 'overview' ? '整份重來？' : '重新生成流水？'} onClose={() => setConfirmRegen(null)}
                footer={
                    <div className="flex gap-3 w-full">
                        <button onClick={() => setConfirmRegen(null)} className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform">取消</button>
                        <button onClick={() => confirmRegen && generate(confirmRegen)} className="flex-1 py-3 bg-slate-800 text-white font-bold rounded-2xl active:scale-95 transition-transform">重新生成</button>
                    </div>
                }>
                <p className="text-xs text-slate-500 leading-relaxed">
                    {confirmRegen === 'overview'
                        ? 'AI 會照人設重新編一份：現在的現金、銀行卡和各 block 會整份換掉。流水會留著，舊卡的那幾筆會顯示「已刪除的卡」。'
                        : '會換掉上次 AI 生成的那批流水。手動記的、聊天和自動記的都不會動，餘額也不變。'}
                </p>
            </Modal>
        </div>
    );
};

export default RealBalancePanel;
