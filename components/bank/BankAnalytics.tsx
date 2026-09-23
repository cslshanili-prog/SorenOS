
import React, { useMemo, useState, useEffect } from 'react';
import { BankTransaction, SavingsGoal, APIConfig } from '../../types';
import { safeResponseJson } from '../../utils/safeApi';
import { getLocalDateKey } from '../../utils/localDate';
import { shareOrDownloadFile } from '../../utils/shareExport';
import { formatMoney, roundMoney, sumMoney } from '../../utils/format';

interface Props {
    transactions: BankTransaction[];
    goals: SavingsGoal[];
    currency: string;
    onDeleteTx: (id: string) => void;
    apiConfig?: APIConfig;
    dailyBudget?: number;
}

// Category definitions with icons and colors
const CATEGORIES: Record<string, { icon: string; label: string; color: string; gradient: string }> = {
    food: { icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f354.png', label: '餐飲', color: '#FF7043', gradient: 'from-orange-400 to-red-500' },
    transport: { icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f697.png', label: '交通', color: '#42A5F5', gradient: 'from-blue-400 to-indigo-500' },
    shopping: { icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f6cd.png', label: '購物', color: '#AB47BC', gradient: 'from-purple-400 to-pink-500' },
    entertainment: { icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f3ae.png', label: '娛樂', color: '#66BB6A', gradient: 'from-green-400 to-teal-500' },
    bills: { icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4f1.png', label: '帳單', color: '#FFA726', gradient: 'from-yellow-400 to-orange-500' },
    health: { icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f48a.png', label: '醫療', color: '#EF5350', gradient: 'from-red-400 to-rose-500' },
    education: { icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4da.png', label: '學習', color: '#5C6BC0', gradient: 'from-indigo-400 to-purple-500' },
    other: { icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4e6.png', label: '其他', color: '#78909C', gradient: 'from-gray-400 to-slate-500' }
};

const BankAnalytics: React.FC<Props> = ({ transactions, goals, currency, onDeleteTx, apiConfig, dailyBudget = 100 }) => {
    const [viewMode, setViewMode] = useState<'today' | 'week' | 'month'>('today');
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [categorizedTx, setCategorizedTx] = useState<Record<string, string>>({});
    const [aiSummary, setAiSummary] = useState<string>('');

    // Get date ranges
    const today = getLocalDateKey();
    const currentMonth = today.slice(0, 7);

    // Calculate week start (Monday)
    const getWeekStart = () => {
        const now = new Date();
        const day = now.getDay();
        const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Adjust for Sunday
        const weekStart = new Date(now.setDate(diff));
        return getLocalDateKey(weekStart);
    };
    const weekStart = getWeekStart();

    // Filter transactions by time period
    const filteredTx = useMemo(() => {
        return transactions.filter(tx => {
            if (viewMode === 'today') return tx.dateStr === today;
            if (viewMode === 'week') return tx.dateStr >= weekStart;
            if (viewMode === 'month') return tx.dateStr.startsWith(currentMonth);
            return true;
        });
    }, [transactions, viewMode, today, weekStart, currentMonth]);

    // Calculate totals
    const totalSpent = useMemo(() => sumMoney(filteredTx.map(tx => tx.amount)), [filteredTx]);

    // CSV Export
    const handleExportCSV = async () => {
        if (transactions.length === 0) return;
        const BOM = '\uFEFF';
        const header = '日期,時間,金額,備註,分類\n';
        const rows = transactions
            .sort((a, b) => b.timestamp - a.timestamp)
            .map(tx => {
                const date = tx.dateStr;
                const time = new Date(tx.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const cat = CATEGORIES[categorizedTx[tx.id] || guessCategory(tx.note)]?.label || '其他';
                const note = tx.note.replace(/,/g, '，').replace(/"/g, '""');
                return `${date},${time},${formatMoney(tx.amount)},"${note}",${cat}`;
            })
            .join('\n');
        const csv = BOM + header + rows;
        await shareOrDownloadFile({
            content: csv,
            fileName: `記帳記錄_${new Date().toISOString().split('T')[0]}.csv`,
            mimeType: 'text/csv;charset=utf-8',
            shareTitle: 'Soren 記帳記錄',
        });
    };

    // Group by category
    const categoryData = useMemo(() => {
        const groups: Record<string, { total: number; count: number; items: BankTransaction[] }> = {};

        filteredTx.forEach(tx => {
            const cat = categorizedTx[tx.id] || guessCategory(tx.note);
            if (!groups[cat]) groups[cat] = { total: 0, count: 0, items: [] };
            groups[cat].total += tx.amount;
            groups[cat].count++;
            groups[cat].items.push(tx);
        });

        return Object.entries(groups)
            .map(([key, data]) => ({ category: key, ...data, total: roundMoney(data.total), percentage: totalSpent > 0 ? (data.total / totalSpent) * 100 : 0 }))
            .sort((a, b) => b.total - a.total);
    }, [filteredTx, categorizedTx, totalSpent]);

    // Simple keyword-based category guessing
    function guessCategory(note: string): string {
        const lower = note.toLowerCase();
        if (/[饭飯]|餐|吃|外[卖賣]|食|奶茶|咖啡|早|午|晚|火[锅鍋]|[烧燒]烤|[面麵]|[饮飲]/.test(lower)) return 'food';
        if (/[车車]|地[铁鐵]|公交|打[车車]|油|加油|停[车車]|出租/.test(lower)) return 'transport';
        if (/[买買]|[购購]|淘[宝寶]|京[东東]|拼多多|商[场場]|超市|衣服/.test(lower)) return 'shopping';
        if (/[游遊][戏戲]|[电電]影|[娱娛][乐樂]|ktv|酒吧|玩/.test(lower)) return 'entertainment';
        if (/[话話][费費]|水[电電]|房租|[网網][费費]|[会會][员員]|[订訂][阅閱]/.test(lower)) return 'bills';
        if (/[医醫]|[药藥]|健康|[体體][检檢]|看病/.test(lower)) return 'health';
        if (/[书書]|[课課]|[学學][习習]|培[训訓]|教育/.test(lower)) return 'education';
        return 'other';
    }

    // AI categorization and summary
    const analyzeWithAI = async () => {
        if (!apiConfig?.apiKey || filteredTx.length === 0) return;

        setIsAnalyzing(true);
        try {
            const txList = filteredTx.map(tx => `- ${tx.note}: ${currency}${formatMoney(tx.amount)}`).join('\n');
            const periodLabel = viewMode === 'today' ? '今天' : viewMode === 'week' ? '本週' : '本月';

            const prompt = `作為一個財務分析助手，分析以下消費記錄：

${txList}

任務：
1. 為每筆消費分配類別 (food/transport/shopping/entertainment/bills/health/education/other)
2. 寫一段簡短有趣的總結（2-3句話），用輕鬆的語氣評價${periodLabel}的消費習慣

輸出JSON格式：
{
  "categories": { "消費備註1": "類別", "消費備註2": "類別" },
  "summary": "總結文字"
}`;

            const res = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({ model: apiConfig.model, messages: [{ role: 'user', content: prompt }] })
            });

            if (res.ok) {
                const data = await safeResponseJson(res);
                let jsonStr = data.choices[0].message.content.replace(/```json/g, '').replace(/```/g, '').trim();
                const result = JSON.parse(jsonStr);

                // Map categories to transaction IDs
                const newCategories: Record<string, string> = { ...categorizedTx };
                filteredTx.forEach(tx => {
                    if (result.categories[tx.note]) {
                        newCategories[tx.id] = result.categories[tx.note];
                    }
                });
                setCategorizedTx(newCategories);
                setAiSummary(result.summary || '');
            }
        } catch (e) {
            console.error('AI analysis failed:', e);
        } finally {
            setIsAnalyzing(false);
        }
    };

    // Total savings progress
    const totalSaved = useMemo(() => sumMoney(goals.map(g => g.currentAmount)), [goals]);
    const nextGoal = useMemo(() => goals.find(g => !g.isCompleted) || goals[0], [goals]);

    // Budget status for today
    const budgetRemaining = roundMoney(dailyBudget - (viewMode === 'today' ? totalSpent : 0));
    const budgetStatus = budgetRemaining >= 0 ? 'good' : 'over';

    return (
        <div className="min-h-full pb-24" style={{ background: 'linear-gradient(180deg, #FDF6E3 0%, #FFF8E1 100%)' }}>

            {/* Hero Section - Summary Card */}
            <div className="relative overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-br from-[#6D4C41] via-[#5D4037] to-[#4E342E]"></div>
                <div className="absolute top-0 right-0 w-48 h-48 bg-white/5 rounded-full blur-3xl -mr-20 -mt-20"></div>
                <div className="absolute bottom-0 left-0 w-32 h-32 bg-white/5 rounded-full blur-2xl -ml-10 -mb-10"></div>

                <div className="relative z-10 p-5 pt-3">
                    {/* Period Selector */}
                    <div className="flex bg-white/10 backdrop-blur-sm p-1 rounded-2xl mb-5">
                        {[
                            { key: 'today', label: '今日', icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/2600.png' },
                            { key: 'week', label: '本週', icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4c6.png' },
                            { key: 'month', label: '本月', icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4c5.png' }
                        ].map(p => (
                            <button
                                key={p.key}
                                onClick={() => setViewMode(p.key as any)}
                                className={`flex-1 py-2.5 text-xs font-bold rounded-xl transition-all duration-300 flex items-center justify-center gap-1.5 ${
                                    viewMode === p.key
                                        ? 'bg-white text-[#5D4037] shadow-lg'
                                        : 'text-white/70 hover:text-white'
                                }`}
                            >
                                <img src={p.icon} className="w-4 h-4" alt="" />
                                <span>{p.label}</span>
                            </button>
                        ))}
                    </div>

                    {/* Main Stats */}
                    <div className="text-center mb-4">
                        <div className="text-xs text-white/60 uppercase tracking-widest mb-1">
                            {viewMode === 'today' ? '今日支出' : viewMode === 'week' ? '本週支出' : '本月支出'}
                        </div>
                        <div className="text-5xl font-black text-white font-mono tracking-tight">
                            {currency}{totalSpent.toFixed(0)}
                        </div>
                        <div className="text-sm text-white/50 mt-1">
                            共 {filteredTx.length} 筆
                        </div>
                    </div>

                    {/* Budget Status (Today only) */}
                    {viewMode === 'today' && (
                        <div className={`p-4 rounded-2xl backdrop-blur-md border ${
                            budgetStatus === 'good'
                                ? 'bg-green-500/20 border-green-400/30'
                                : 'bg-red-500/20 border-red-400/30'
                        }`}>
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <img src={budgetStatus === 'good' ? 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4aa.png' : 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f631.png'} className="w-6 h-6" alt="" />
                                    <span className="text-sm text-white font-medium">
                                        {budgetStatus === 'good' ? '預算還剩' : '已超支'}
                                    </span>
                                </div>
                                <span className={`text-2xl font-black font-mono ${budgetStatus === 'good' ? 'text-green-300' : 'text-red-300'}`}>
                                    {budgetStatus === 'good' ? '+' : ''}{currency}{Math.abs(budgetRemaining).toFixed(0)}
                                </span>
                            </div>
                            <div className="mt-2 h-2 bg-black/20 rounded-full overflow-hidden">
                                <div
                                    className={`h-full rounded-full transition-all duration-500 ${
                                        budgetStatus === 'good' ? 'bg-green-400' : 'bg-red-400'
                                    }`}
                                    style={{ width: `${Math.min(100, (totalSpent / dailyBudget) * 100)}%` }}
                                ></div>
                            </div>
                            <div className="text-[10px] text-white/50 mt-1 text-right">
                                預算 {currency}{dailyBudget}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Content Area */}
            <div className="p-5 space-y-5">

                {/* AI Summary Card */}
                {(aiSummary || filteredTx.length > 0) && (
                    <div className="bg-white rounded-3xl p-5 shadow-lg border border-[#E8DCC8] relative overflow-hidden">
                        <div className="absolute top-0 right-0 w-24 h-24 bg-gradient-to-br from-[#FFE0B2]/30 to-transparent rounded-full -mr-8 -mt-8"></div>

                        <div className="flex items-center justify-between mb-3 relative z-10">
                            <div className="flex items-center gap-2">
                                <span className="w-8 h-8 bg-gradient-to-br from-[#FFD54F] to-[#FFB300] rounded-xl flex items-center justify-center text-lg shadow-md"><img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f916.png" className="w-5 h-5" alt="" /></span>
                                <span className="text-sm font-bold text-[#5D4037]">AI 消費分析</span>
                            </div>
                            <button
                                onClick={analyzeWithAI}
                                disabled={isAnalyzing || !apiConfig?.apiKey}
                                className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${
                                    isAnalyzing
                                        ? 'bg-[#EFEBE9] text-[#BCAAA4]'
                                        : 'bg-gradient-to-r from-[#42A5F5] to-[#1E88E5] text-white shadow-md hover:shadow-lg active:scale-95'
                                }`}
                            >
                                {isAnalyzing ? (
                                    <span className="flex items-center gap-1.5">
                                        <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                                        分析中
                                    </span>
                                ) : '生成總結'}
                            </button>
                        </div>

                        {aiSummary ? (
                            <div className="bg-gradient-to-r from-[#FFF8E1] to-[#FFF3E0] p-4 rounded-2xl text-sm text-[#5D4037] leading-relaxed relative z-10">
                                <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4a1.png" className="w-5 h-5 inline mr-2" alt="" />
                                {aiSummary}
                            </div>
                        ) : (
                            <div className="text-center py-4 text-[#BCAAA4] text-xs">
                                點擊"生成總結"讓 AI 分析你的消費習慣
                            </div>
                        )}
                    </div>
                )}

                {/* Category Breakdown */}
                {categoryData.length > 0 && (
                    <div className="bg-white rounded-3xl p-5 shadow-md border border-[#E8DCC8]">
                        <div className="flex items-center gap-2 mb-4">
                            <span className="w-8 h-8 bg-gradient-to-br from-[#AB47BC] to-[#7B1FA2] rounded-xl flex items-center justify-center text-lg shadow-md"><img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4ca.png" className="w-5 h-5" alt="" /></span>
                            <span className="text-sm font-bold text-[#5D4037]">消費分類</span>
                        </div>

                        <div className="space-y-3">
                            {categoryData.map(({ category, total, count, percentage }) => {
                                const cat = CATEGORIES[category] || CATEGORIES.other;
                                return (
                                    <div key={category} className="group">
                                        <div className="flex items-center justify-between mb-1.5">
                                            <div className="flex items-center gap-2">
                                                <img src={cat.icon} className="w-5 h-5" alt="" />
                                                <span className="text-sm font-bold text-[#5D4037]">{cat.label}</span>
                                                <span className="text-[10px] text-[#A1887F] bg-[#FDF6E3] px-2 py-0.5 rounded-full">{count}筆</span>
                                            </div>
                                            <span className="font-mono font-bold text-[#5D4037]">{currency}{total.toFixed(0)}</span>
                                        </div>
                                        <div className="h-3 bg-[#EFEBE9] rounded-full overflow-hidden">
                                            <div
                                                className={`h-full bg-gradient-to-r ${cat.gradient} rounded-full transition-all duration-700 relative`}
                                                style={{ width: `${percentage}%` }}
                                            >
                                                <div className="absolute inset-0 bg-gradient-to-b from-white/30 to-transparent"></div>
                                            </div>
                                        </div>
                                        <div className="text-right text-[10px] text-[#A1887F] mt-0.5">{percentage.toFixed(1)}%</div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                {/* Transaction List */}
                <div className="bg-white rounded-3xl p-5 shadow-md border border-[#E8DCC8]">
                    <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-2">
                            <span className="w-8 h-8 bg-gradient-to-br from-[#66BB6A] to-[#43A047] rounded-xl flex items-center justify-center text-lg shadow-md"><img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4dd.png" className="w-5 h-5" alt="" /></span>
                            <span className="text-sm font-bold text-[#5D4037]">消費明細</span>
                        </div>
                        {transactions.length > 0 && (
                            <button onClick={handleExportCSV} className="flex items-center gap-1 px-3 py-1.5 bg-[#FDF6E3] hover:bg-[#FFF8E1] border border-[#E8DCC8] rounded-xl text-[10px] font-bold text-[#8D6E63] active:scale-95 transition-all">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
                                導出全部CSV
                            </button>
                        )}
                    </div>

                    {filteredTx.length === 0 ? (
                        <div className="text-center py-12">
                            <div className="mb-3 opacity-40"><img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4ed.png" className="w-16 h-16 mx-auto" alt="" /></div>
                            <div className="text-sm text-[#A1887F]">
                                {viewMode === 'today' ? '今天還沒有消費記錄' : viewMode === 'week' ? '本週暫無記錄' : '本月暫無記錄'}
                            </div>
                            <div className="text-xs text-[#BCAAA4] mt-1">點擊右上角開始記帳吧！</div>
                        </div>
                    ) : (
                        <div className="space-y-3 max-h-[400px] overflow-y-auto no-scrollbar">
                            {filteredTx.map(tx => {
                                const cat = CATEGORIES[categorizedTx[tx.id] || guessCategory(tx.note)] || CATEGORIES.other;
                                return (
                                    <div key={tx.id} className="flex items-center justify-between p-3 rounded-2xl bg-[#FDF6E3] hover:bg-[#FFF8E1] transition-colors group relative">
                                        <div className="flex items-center gap-3">
                                            <div className="w-11 h-11 rounded-xl bg-white flex items-center justify-center shadow-inner">
                                                <img src={cat.icon} className="w-6 h-6" alt="" />
                                            </div>
                                            <div>
                                                <div className="font-bold text-[#5D4037] text-sm">{tx.note}</div>
                                                <div className="text-[10px] text-[#A1887F] flex items-center gap-2">
                                                    <span>{new Date(tx.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span>
                                                    <span className="px-1.5 py-0.5 bg-white rounded text-[9px]" style={{ color: cat.color }}>{cat.label}</span>
                                                </div>
                                            </div>
                                        </div>
                                        <div className="font-mono font-bold text-[#E64A19]">-{currency}{formatMoney(tx.amount)}</div>

                                        <button
                                            onClick={() => onDeleteTx(tx.id)}
                                            className="absolute right-1 top-1 w-5 h-5 rounded-full bg-red-50 text-red-400 hover:bg-red-100 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all text-xs"
                                        >
                                            ×
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Savings Progress */}
                {goals.length > 0 && (
                    <div className="bg-gradient-to-br from-[#8D6E63] to-[#5D4037] rounded-3xl p-5 shadow-lg text-white relative overflow-hidden">
                        <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full blur-2xl -mr-10 -mt-10"></div>

                        <div className="flex items-center gap-2 mb-3 relative z-10">
                            <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f3af.png" className="w-5 h-5" alt="" />
                            <span className="text-sm font-bold">儲蓄進度</span>
                        </div>

                        <div className="text-3xl font-black font-mono mb-3 relative z-10">{currency}{totalSaved.toFixed(0)}</div>

                        {nextGoal && (
                            <div className="bg-white/15 backdrop-blur-sm rounded-xl p-3 relative z-10">
                                <div className="flex justify-between text-xs mb-2">
                                    <span className="opacity-80">下一目標: {nextGoal.name}</span>
                                    <span className="font-bold">{currency}{formatMoney(nextGoal.targetAmount - nextGoal.currentAmount)}</span>
                                </div>
                                <div className="h-2 bg-black/20 rounded-full overflow-hidden">
                                    <div
                                        className="h-full bg-gradient-to-r from-[#FFE0B2] to-[#FFAB91] rounded-full"
                                        style={{ width: `${Math.min(100, (nextGoal.currentAmount / nextGoal.targetAmount) * 100)}%` }}
                                    ></div>
                                </div>
                            </div>
                        )}
                    </div>
                )}

            </div>
        </div>
    );
};

export default BankAnalytics;
