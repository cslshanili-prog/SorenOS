/**
 * 本機存儲用量面板
 *
 * 擺在「備份與恢復」板塊頂部，回答兩件事：數據多大、系統會不會隨手把它清掉。
 *
 * 總量和持久化狀態是秒回的，進來就顯示；「都是些什麼佔的」要翻庫，所以摺疊起來、
 * 點開才算，算的時候顯示進度，別讓用戶對著空白等。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    readStorageOverview,
    requestPersistentStorage,
    computeStorageBreakdown,
    formatBytes,
    type StorageOverview,
    type StorageBreakdown,
    type BreakdownProgress,
} from '../../utils/storageStats';
import { optimizeResourceStorage, type OptimizeProgress, type OptimizeResult } from '../../utils/storageOptimize';
import { trackEvent } from '../../utils/analytics';

/**
 * 算好的結果放模塊級緩存：SettingsSection 收起時會把子樹整個卸載，
 * 不緩存的話用戶每收一次再展開就得重算一遍。要最新數字點「重新計算」。
 */
let cachedBreakdown: StorageBreakdown | null = null;

/**
 * 分類合計和 estimate() 總量差多少才值得單獨交代。
 * 絕對值夠大、或者佔了總量一成以上都算 —— 只看絕對值的話，幾百 KB 的小庫永遠不顯示，
 * 用戶會盯著「總共 165 KB，細分只有 9 KB」發懵。
 */
const OTHER_USAGE_MIN_BYTES = 1024 * 1024;
const OTHER_USAGE_MIN_RATIO = 0.1;

/** 合併完成後自動刷新前留的一點時間，讓用戶看清這輪到底做了什麼。 */
const MERGE_RELOAD_DELAY_MS = 2500;

/**
 * 合併過重複圖片就排一次整頁刷新，排過了就不再排。
 *
 * 計時器和標記都放在組件外面，是因為這次刷新是數據一致性動作，不是界面上的順手事：
 * 合併只改了庫裡的引用，內存裡的 theme / customIcons 還捏著合併前的令牌，帶著它導出
 * 備份，同一張圖會被寫成兩份。所以用戶在這 2.5 秒裡收起板塊、退出設置頁、或者再點一次
 * 「一鍵優化」（這些都會把面板卸掉或重置狀態），刷新照樣得來。
 */
let mergeReloadScheduled = false;
function scheduleMergeReload(): void {
    if (mergeReloadScheduled) return;
    mergeReloadScheduled = true;
    setTimeout(() => window.location.reload(), MERGE_RELOAD_DELAY_MS);
}

type PersistAttempt = 'none' | 'granted' | 'denied';

/**
 * 把優化結果講成人話。兩筆帳分開說：轉格式是當場就省下的，合併重複要等下一次
 * 孤兒清理才真的把空間還回來（合併只改引用、不刪圖，見 utils/blobDedupe.ts）。
 */
function describeOptimizeResult(r: OptimizeResult): string {
    const parts: string[] = [];
    if (r.converted > 0) {
        parts.push(`已把 ${r.converted} 張圖片轉為二進制存儲，釋放約 ${formatBytes(Math.max(0, r.bytesBefore - r.bytesAfter))}`);
    }
    if (r.mergedDuplicates > 0) {
        parts.push(`把 ${r.mergedDuplicates} 份重複的圖片併成了一份，約 ${formatBytes(r.reclaimableBytes)} 會在下次清理時釋放`);
    }
    if (r.vectorsCompacted > 0) {
        parts.push(`把 ${r.vectorsCompacted} 條記憶向量壓成了緊湊格式`);
    }
    const reloadNote = r.mergedDuplicates > 0 ? '頁面即將刷新，讓界面和備份都用上合併後的圖片。' : '';
    const vectorNote = r.vectorError ? `記憶向量這一步沒做完：${r.vectorError}。再點一次可以接著壓。` : '';
    if (parts.length === 0) {
        if (r.failed > 0) return `有 ${r.failed} 張圖片轉換失敗（已保留原樣），其餘沒有需要優化的。${vectorNote}`;
        if (vectorNote) return `沒有需要優化的圖片。${vectorNote}`;
        return r.scanUnavailable
            ? '沒有需要優化的圖片。這次沒能檢查重複圖片，換個環境再試試。'
            : '沒有需要優化的，存儲已是最省形態。';
    }
    let text = `${parts.join('；')}。`;
    if (r.failed > 0) text += `另有 ${r.failed} 張轉換失敗，已保留原樣。`;
    if (r.skippedGroups > 0) text += `有 ${r.skippedGroups} 組重複圖片沒有合併——它們被「換一張就會刪掉舊圖」的地方用著，並了會誤刪。`;
    if (r.scanUnavailable) text += '這次沒能檢查重複圖片，換個環境再試試。';
    return text + vectorNote + reloadNote;
}

const StorageUsagePanel: React.FC = () => {
    const [overview, setOverview] = useState<StorageOverview | null>(null);
    const [persisting, setPersisting] = useState(false);
    const [attempt, setAttempt] = useState<PersistAttempt>('none');

    const [expanded, setExpanded] = useState(false);
    const [breakdown, setBreakdown] = useState<StorageBreakdown | null>(cachedBreakdown);
    const [computing, setComputing] = useState(false);
    const [progress, setProgress] = useState<BreakdownProgress | null>(null);
    const [breakdownError, setBreakdownError] = useState(false);

    const [optimizing, setOptimizing] = useState(false);
    const [optimizeProgress, setOptimizeProgress] = useState<OptimizeProgress | null>(null);
    const [optimizeResult, setOptimizeResult] = useState<OptimizeResult | null>(null);
    const [optimizeError, setOptimizeError] = useState<string | null>(null);

    const aliveRef = useRef(true);
    useEffect(() => {
        aliveRef.current = true;
        return () => { aliveRef.current = false; };
    }, []);

    const refreshOverview = useCallback(async () => {
        const next = await readStorageOverview();
        if (aliveRef.current) setOverview(next);
    }, []);

    useEffect(() => { void refreshOverview(); }, [refreshOverview]);

    const runBreakdown = useCallback(async () => {
        setComputing(true);
        setBreakdownError(false);
        setProgress(null);
        try {
            const result = await computeStorageBreakdown(p => {
                if (aliveRef.current) setProgress(p);
            });
            cachedBreakdown = result;
            if (aliveRef.current) setBreakdown(result);
        } catch {
            if (aliveRef.current) setBreakdownError(true);
        } finally {
            if (aliveRef.current) { setComputing(false); setProgress(null); }
        }
    }, []);

    const handleToggle = useCallback(() => {
        const next = !expanded;
        setExpanded(next);
        if (next) trackEvent('查看存储占用明细');
        if (next && !cachedBreakdown && !computing) void runBreakdown();
    }, [expanded, computing, runBreakdown]);

    const handleOptimize = useCallback(async () => {
        if (optimizing) return;
        setOptimizing(true);
        setOptimizeResult(null);
        setOptimizeError(null);
        setOptimizeProgress(null);
        try {
            const result = await optimizeResourceStorage(p => {
                if (aliveRef.current) setOptimizeProgress(p);
            });
            // 排在面板存活判斷之前：引用已經在庫裡合併了，內存裡的舊令牌就得靠刷新換掉，
            // 這件事跟面板還在不在沒關係。
            if (result.mergedDuplicates > 0) scheduleMergeReload();
            if (!aliveRef.current) return;
            setOptimizeResult(result);
            // 用量和細分都變了：總量刷新，細分緩存作廢（下次展開重算）
            cachedBreakdown = null;
            setBreakdown(null);
            await refreshOverview();
        } catch (error) {
            if (aliveRef.current) setOptimizeError(error instanceof Error ? error.message : String(error));
        } finally {
            if (aliveRef.current) { setOptimizing(false); setOptimizeProgress(null); }
        }
    }, [optimizing, refreshOverview]);

    const handlePersist = useCallback(async () => {
        setPersisting(true);
        try {
            const granted = await requestPersistentStorage();
            // 成敗都記一筆：要是這個按鈕的通過率常年是 0，那它就是個擺設，得換做法。
            trackEvent('申请持久化存储许可', { 结果: granted ? '通过' : '没通过' });
            if (!aliveRef.current) return;
            setAttempt(granted ? 'granted' : 'denied');
            await refreshOverview();
        } finally {
            if (aliveRef.current) setPersisting(false);
        }
    }, [refreshOverview]);

    const usage = overview?.usageBytes ?? null;
    const quota = overview?.quotaBytes ?? null;
    const percent = usage != null && quota != null && quota > 0
        ? Math.min(100, (usage / quota) * 100)
        : null;
    const barColor = percent == null ? 'bg-slate-300'
        : percent >= 90 ? 'bg-gradient-to-r from-rose-400 to-red-500'
        : percent >= 70 ? 'bg-gradient-to-r from-amber-400 to-orange-500'
        : 'bg-gradient-to-r from-violet-400 to-purple-500';

    // estimate() 的總量還包含 Cache Storage（離線緩存的 JS / 圖片）這類我們碰不到的東西，
    // 所以分類合計天然會少一截。差得多的時候單獨列一行，省得用戶以為數字對不上。
    const otherUsage = usage != null && breakdown != null ? usage - breakdown.totalBytes : null;
    const showOtherUsage = otherUsage != null && otherUsage > 0 && (
        otherUsage >= OTHER_USAGE_MIN_BYTES || (usage != null && usage > 0 && otherUsage / usage >= OTHER_USAGE_MIN_RATIO)
    );

    const persisted = overview?.persisted ?? null;

    return (
        <div data-testid="storage-usage-panel" className="mb-5 pb-4 border-b border-slate-100">
            {/* ── 總量 ── */}
            <div className="flex items-baseline justify-between gap-2 mb-1.5">
                <span className="text-xs font-bold text-slate-600">本機數據</span>
                <span className="text-sm font-bold text-slate-700 tabular-nums">
                    {overview == null ? '讀取中…' : formatBytes(usage)}
                </span>
            </div>

            {percent != null && (
                <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden mb-1.5">
                    <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${Math.max(1, percent)}%` }} />
                </div>
            )}

            <p className="text-[10px] text-slate-400 mb-3">
                {overview == null
                    ? '正在讀取瀏覽器給出的用量…'
                    : !overview.supported
                        ? '這個瀏覽器不提供存儲用量信息'
                        : quota != null
                            ? `上限 ${formatBytes(quota)}${percent != null ? ` · 已佔 ${percent.toFixed(1)}%` : ''} · 數字由瀏覽器估算`
                            : '瀏覽器沒給出上限 · 數字由瀏覽器估算'}
            </p>

            {/* ── 持久化許可 ── */}
            <div className="rounded-xl bg-slate-50 border border-slate-100 px-3 py-2.5 mb-3">
                <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                            persisted === true ? 'bg-emerald-500' : persisted === false ? 'bg-amber-500' : 'bg-slate-300'
                        }`} />
                        <span className="text-[11px] font-bold text-slate-600">持久化許可</span>
                        <span className={`text-[11px] font-bold ${
                            persisted === true ? 'text-emerald-600' : persisted === false ? 'text-amber-600' : 'text-slate-400'
                        }`}>
                            {persisted === true ? '已獲得' : persisted === false ? '未獲得' : '無法查詢'}
                        </span>
                    </div>
                    {persisted !== true && overview != null && (
                        <button
                            type="button"
                            onClick={handlePersist}
                            disabled={persisting}
                            className="shrink-0 px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-[10px] font-bold text-slate-500 active:scale-95 transition-all disabled:opacity-50"
                        >
                            {persisting ? '申請中…' : '再試一次'}
                        </button>
                    )}
                </div>
                <p className="mt-1.5 text-[10px] text-slate-400 leading-relaxed">
                    {persisted === true
                        ? '系統清理存儲空間時不會動你的數據。'
                        : attempt === 'denied'
                            ? '瀏覽器這次沒批准。把 Soren 裝到主屏、或者允許通知之後再點一次，通過的概率會明顯變高。'
                            : '存儲吃緊時系統可能把你的數據一起清掉。把 Soren 裝到主屏、或者允許通知，能提高申請成功率。'}
                </p>
            </div>

            {/* ── 優化資源存儲（一次性遷移，冪等可重跑） ── */}
            <div className="rounded-xl bg-slate-50 border border-slate-100 px-3 py-2.5 mb-3">
                <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-bold text-slate-600">優化資源存儲</span>
                    <button
                        type="button"
                        onClick={handleOptimize}
                        disabled={optimizing}
                        className="shrink-0 px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-[10px] font-bold text-slate-500 active:scale-95 transition-all disabled:opacity-50"
                    >
                        {optimizing ? '優化中…' : '一鍵優化'}
                    </button>
                </div>
                <p className={`mt-1.5 text-[10px] leading-relaxed ${optimizeError ? 'text-rose-500' : 'text-slate-400'}`}>
                    {optimizing
                        ? (optimizeProgress
                            ? `正在處理：${optimizeProgress.label}（${optimizeProgress.done}/${optimizeProgress.total}）…`
                            : '正在掃描…')
                        : optimizeError
                            ? optimizeError
                            : optimizeResult
                                ? describeOptimizeResult(optimizeResult)
                                : '把老數據裡仍以 base64 存的圖片一次性轉成二進制，把重複存了好幾份的同一張圖併成一份，再把記憶向量壓成緊湊格式。做過一次就乾淨；導入過舊備份後可以再點。'}
                </p>
                {/* 合併動的是庫裡的引用，內存裡的 theme / customIcons 還捏著合併前的令牌。
                    不刷新的話：界面照常顯示，但導出的備份裡 metadata 寫的仍是舊令牌，
                    同一張圖又變成兩份進包——看起來就像「優化根本沒生效」。所以優化一跑完就
                    排好了自動刷新（見 scheduleMergeReload），不指望用戶記得點；
                    這個按鈕只是讓人不想等的時候立刻走。 */}
                {!optimizing && optimizeResult && optimizeResult.mergedDuplicates > 0 && (
                    <button
                        type="button"
                        onClick={() => window.location.reload()}
                        className="mt-2 w-full px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-[10px] font-bold text-slate-500 active:scale-95 transition-all"
                    >
                        立即刷新
                    </button>
                )}
            </div>

            {/* ── 細分（摺疊） ── */}
            <button
                type="button"
                onClick={handleToggle}
                className="w-full flex items-center gap-1.5 text-[11px] font-bold text-slate-500 py-1 active:scale-[0.99] transition-all"
            >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className={`w-3 h-3 text-slate-300 transition-transform ${expanded ? 'rotate-180' : ''}`}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                </svg>
                <span>看看都是些什麼佔的</span>
            </button>

            {expanded && (
                <div className="mt-2">
                    {computing ? (
                        <div className="flex items-center gap-2 px-1 py-3">
                            <span className="w-3 h-3 rounded-full border-2 border-slate-200 border-t-violet-400 animate-spin shrink-0" />
                            <span className="text-[10px] text-slate-400">
                                {progress && progress.total > 0
                                    ? `計算中… 已翻完 ${progress.done}/${progress.total} 張表`
                                    : '計算中…'}
                            </span>
                        </div>
                    ) : breakdownError ? (
                        <div className="px-1 py-3">
                            <p className="text-[10px] text-rose-500 mb-2">讀不出各項佔用（數據庫可能正被其他標籤頁佔用）。</p>
                            <button type="button" onClick={() => void runBreakdown()} className="px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-[10px] font-bold text-slate-500 active:scale-95 transition-all">
                                重試
                            </button>
                        </div>
                    ) : breakdown ? (
                        <>
                            <div className="space-y-1.5 mb-2">
                                {breakdown.categories.map(c => (
                                    <div key={c.key} className="flex items-baseline justify-between gap-2">
                                        <span className="text-[11px] text-slate-500 truncate">{c.label}</span>
                                        <span className="text-[11px] text-slate-600 font-medium tabular-nums shrink-0">
                                            {c.estimated ? '約 ' : ''}{formatBytes(c.bytes)}
                                        </span>
                                    </div>
                                ))}
                                {showOtherUsage && (
                                    <div className="flex items-baseline justify-between gap-2">
                                        <span className="text-[11px] text-slate-400 truncate">網頁緩存等</span>
                                        <span className="text-[11px] text-slate-400 font-medium tabular-nums shrink-0">約 {formatBytes(otherUsage)}</span>
                                    </div>
                                )}
                                {breakdown.categories.length === 0 && !showOtherUsage && (
                                    <p className="text-[10px] text-slate-400">還沒有存下什麼數據。</p>
                                )}
                            </div>

                            <div className="flex items-center justify-between gap-2">
                                <p className="text-[10px] text-slate-300 leading-relaxed">
                                    {[
                                        breakdown.categories.some(c => c.estimated) ? '標「約」的項目是抽樣估算' : '',
                                        // 數據的原始大小比它實際佔的地方大——瀏覽器落盤時會壓一道。
                                        // 不折算的話細分加起來會超過上面的總量，看著像算錯了。
                                        breakdown.calibrated ? '各項已按實際佔用折算，比數據本身的大小小一些' : '',
                                        showOtherUsage ? '「網頁緩存等」是離線緩存這類系統佔用，刪不掉也不用管' : '',
                                        breakdown.failedStores.length > 0 ? `有 ${breakdown.failedStores.length} 張表沒讀出來` : '',
                                    ].filter(Boolean).join('；')}
                                </p>
                                <button type="button" onClick={() => void runBreakdown()} className="shrink-0 px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-[10px] font-bold text-slate-500 active:scale-95 transition-all">
                                    重新計算
                                </button>
                            </div>
                        </>
                    ) : null}
                </div>
            )}
        </div>
    );
};

export default StorageUsagePanel;
