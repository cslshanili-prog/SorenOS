import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowsClockwise, Broom, Check, ClipboardText, DownloadSimple, Power, Trash, Wrench, X } from '@phosphor-icons/react';
import {
    clearDevDebugLog,
    closeDevDebug,
    DEFAULT_DEV_DEBUG_FLAGS,
    DEV_DEBUG_CAPTURE_CATEGORIES,
    formatDevDebugLog,
    isDevDebugAvailable,
    readDevDebugFlags,
    readDevDebugLog,
    subscribeDevDebugAvailability,
    subscribeDevDebugLog,
    subscribeDevDebugFlags,
    writeDevDebugFlags,
} from '../utils/devDebug';
import { BUILD_LABEL } from '../utils/buildInfo';
import { trackEvent } from '../utils/analytics';
import { runBlobGc } from '../utils/blobGc';
import type { DevDebugCaptureCategory, DevDebugFlags, DevDebugFloatingPosition } from '../utils/devDebug';
import { shareOrDownloadFile } from '../utils/shareExport';

const FLOATING_BUTTON_SIZE = 44;
const FLOATING_SAFE_MARGIN = 16;
const FLOATING_BOTTOM_RESERVED = 92;
const PANEL_WIDTH = 342;
const PANEL_ESTIMATED_HEIGHT = 392;
const DRAG_THRESHOLD_PX = 4;

function getViewportSize() {
    if (typeof window === 'undefined') return { width: 390, height: 844 };
    return {
        width: window.visualViewport?.width ?? window.innerWidth,
        height: window.visualViewport?.height ?? window.innerHeight,
    };
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), Math.max(min, max));
}

function clampFloatingPosition(position: DevDebugFloatingPosition): DevDebugFloatingPosition {
    const viewport = getViewportSize();
    return {
        x: clamp(position.x, FLOATING_SAFE_MARGIN, viewport.width - FLOATING_BUTTON_SIZE - FLOATING_SAFE_MARGIN),
        y: clamp(position.y, FLOATING_SAFE_MARGIN, viewport.height - FLOATING_BUTTON_SIZE - FLOATING_BOTTOM_RESERVED),
    };
}

function getDefaultFloatingPosition(): DevDebugFloatingPosition {
    const viewport = getViewportSize();
    return clampFloatingPosition({
        x: FLOATING_SAFE_MARGIN,
        y: viewport.height - FLOATING_BUTTON_SIZE - FLOATING_BOTTOM_RESERVED,
    });
}

function getPanelPosition(position: DevDebugFloatingPosition): DevDebugFloatingPosition {
    const viewport = getViewportSize();
    const panelWidth = Math.min(PANEL_WIDTH, viewport.width - FLOATING_SAFE_MARGIN * 2);
    const panelHeight = Math.min(PANEL_ESTIMATED_HEIGHT, viewport.height - FLOATING_SAFE_MARGIN * 2);
    return {
        x: clamp(position.x, FLOATING_SAFE_MARGIN, viewport.width - panelWidth - FLOATING_SAFE_MARGIN),
        y: clamp(position.y, FLOATING_SAFE_MARGIN, viewport.height - panelHeight - FLOATING_SAFE_MARGIN),
    };
}

const ToggleRow: React.FC<{
    title: string;
    detail?: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
}> = ({ title, detail, checked, onChange }) => (
    <div className="flex items-center justify-between gap-4 py-3">
        <div className="min-w-0">
            <div className="text-[13px] font-bold text-white">{title}</div>
            {detail && <div className="mt-1 text-[11px] leading-relaxed text-white/55">{detail}</div>}
        </div>
        <button
            type="button"
            role="switch"
            aria-label={title}
            aria-checked={checked}
            onClick={() => onChange(!checked)}
            className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors ${
                checked
                    ? 'border-amber-300/60 bg-amber-300/80'
                    : 'border-white/15 bg-white/10'
            }`}
        >
            <span
                className={`absolute left-1 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-white shadow-sm transition-transform ${
                    checked ? 'translate-x-5' : 'translate-x-0'
                }`}
            />
        </button>
    </div>
);

// 類別用緊湊 checkbox「並排」擺（無說明，看不懂就別用），跟總開關那種 switch 區分開。
const CheckboxChip: React.FC<{
    label: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
}> = ({ label, checked, onChange }) => (
    <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="flex items-center gap-2"
    >
        <span
            className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
                checked
                    ? 'border-amber-300/70 bg-amber-300/80 text-black'
                    : 'border-white/25 bg-white/5 text-transparent'
            }`}
        >
            <Check size={12} weight="bold" />
        </span>
        <span className="text-[13px] font-bold text-white">{label}</span>
    </button>
);

// 複製 / 下載 / 未來其它日誌動作共享同一種膠囊按鈕——抽出來免得兩套 className 28 行各自跑偏。
const LogActionButton: React.FC<{
    onClick: () => void;
    disabled: boolean;
    icon: React.ReactNode;
    label: React.ReactNode;
}> = ({ onClick, disabled, icon, label }) => (
    <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={`flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full px-3 text-[11px] font-bold transition-colors ${
            disabled
                ? 'bg-white/5 text-white/25'
                : 'bg-white/10 text-white/75 active:scale-95'
        }`}
    >
        {icon}
        {label}
    </button>
);

const DevDebugPanel: React.FC = () => {
    const [open, setOpen] = useState(false);
    const [available, setAvailable] = useState(() => isDevDebugAvailable());
    const [flags, setFlags] = useState<DevDebugFlags>(() => readDevDebugFlags());
    const [logCount, setLogCount] = useState(() => readDevDebugLog().length);
    const [copied, setCopied] = useState(false);
    // 孤兒圖片 GC 是一次性動作不是行為開關，狀態只在本次會話內有效——不進 DevDebugFlags，不持久化。
    const [blobGcRunning, setBlobGcRunning] = useState(false);
    const [blobGcResult, setBlobGcResult] = useState<
        | { kind: 'done'; deleted: number; kept: number; keptBoundary: number; aborted: boolean }
        | { kind: 'error'; message: string }
        | null
    >(null);
    // 位置不持久化：每次出現都回默認角，拖動只在本次會話內有效（prod 刷新=失效=類似關閉，沒必要存）。
    const [floatingPosition, setFloatingPosition] = useState<DevDebugFloatingPosition>(getDefaultFloatingPosition);
    const dragStateRef = useRef<{
        pointerId: number;
        startX: number;
        startY: number;
        origin: DevDebugFloatingPosition;
        moved: boolean;
    } | null>(null);
    const suppressClickRef = useRef(false);

    useEffect(() => subscribeDevDebugFlags(setFlags), []);
    // 解鎖時（false→true）從 storage 重讀 flags：mount 時 isDevDebugAvailable() 為 false 的話
    // useState 拿到的是 DEFAULT_DEV_DEBUG_FLAGS（canUseDevDebugStorage gate 不放行），
    // 後續 unlock 不刷新就會用戶改一個開關 → writeDevDebugFlags({...DEFAULT, [k]:v}) 覆蓋掉
    // localStorage 裡其他配置。這裡在變可用時再讀一次兜底。
    useEffect(() => subscribeDevDebugAvailability((next) => {
        setAvailable(next);
        if (next) setFlags(readDevDebugFlags());
    }), []);
    // logCount 只在面板展開時才用得到（複製 (N) 按鈕），收起 / 不可用都不訂閱——
    // 避免主動消息鏈路高頻 append 時每條都觸發整個 panel re-render。
    useEffect(() => {
        if (!open) return;
        setLogCount(readDevDebugLog().length); // open 時拉一次最新值
        return subscribeDevDebugLog((entries) => setLogCount(entries.length));
    }, [open]);
    // 視口 resize / scroll 只在面板可見時跟隨——!available 階段不掛監聽器，避免 mobile
    // 地址欄伸縮高頻觸發 setState 把整個 panel re-render（即使它返回 null）。
    useEffect(() => {
        if (!available) return;
        const clampToViewport = () => {
            setFloatingPosition((current) => {
                const next = clampFloatingPosition(current);
                // 同樣的 {x,y} 還要返回原對象，免得 React 因為 Object.is 失敗而每次 commit。
                return (next.x === current.x && next.y === current.y) ? current : next;
            });
        };
        window.addEventListener('resize', clampToViewport);
        window.visualViewport?.addEventListener('resize', clampToViewport);
        window.visualViewport?.addEventListener('scroll', clampToViewport);
        return () => {
            window.removeEventListener('resize', clampToViewport);
            window.visualViewport?.removeEventListener('resize', clampToViewport);
            window.visualViewport?.removeEventListener('scroll', clampToViewport);
        };
    }, [available]);

    const activeCount = useMemo(
        () => (flags.skipPromptBuild ? 1 : 0)
            + (flags.skipEmotionEval ? 1 : 0)
            + (flags.mergeSystemMessages ? 1 : 0)
            // 「在錄」= 總開關開 且 至少勾了一類——否則浮球紅點會騙人「在錄」其實 isCaptureEnabled
            // 任何類別都返 false。
            + (flags.captureEnabled && flags.captureLogs.length > 0 ? 1 : 0)
            // exposeLogDetail 只在錄製實際生效時才計（同上）。
            + (flags.captureEnabled && flags.captureLogs.length > 0 && flags.exposeLogDetail ? 1 : 0),
        [flags],
    );
    // 用 read-write-set 三步：從 localStorage 讀 source of truth → 寫回 → 同步 React state。
    // 不在 setFlags(updater) 裡做副作用——updater 必須是純函數（StrictMode / concurrent
    // 會讓 updater 重跑），副作用塞進去會重複 dispatch / 重複寫盤。這套寫法同時繞開了 React
    // 閉包的 stale-flags 問題（雙標籤頁 storage 事件 + 用戶點擊 race），因為 read 拿的是
    // localStorage 當前值。
    const updateFlag = <K extends keyof DevDebugFlags,>(key: K, value: DevDebugFlags[K]) => {
        const next = { ...readDevDebugFlags(), [key]: value };
        setFlags(writeDevDebugFlags(next));
    };
    const toggleCapture = (category: DevDebugCaptureCategory, checked: boolean) => {
        const current = readDevDebugFlags();
        const next = {
            ...current,
            captureLogs: checked
                ? [...current.captureLogs, category]
                : current.captureLogs.filter((item) => item !== category),
        };
        setFlags(writeDevDebugFlags(next));
        trackEvent('勾选调试日志类别', { 类别: category, 状态: checked ? '勾选' : '取消' });
    };
    const resetFlags = () => {
        // 重置 = 回默認（總開關關 + 清空勾選）+ 清空所有日誌，比「全不勾」更徹底。
        // 注：writeDevDebugFlags 內部檢測到 captureEnabled true→false 也會清日誌，這裡顯式 clear
        // 是為了「即便上次就是 false」時也保證清乾淨（重置語義包含清理日誌）。
        setFlags(writeDevDebugFlags(DEFAULT_DEV_DEBUG_FLAGS));
        clearDevDebugLog();
        trackEvent('重置调试面板', { 范围: '开关与日志' });
    };
    const handleForceClose = () => {
        // 「關閉」= 收起 + 位置回默認（純內存）+ 強制關掉；任意分支生效，裡面的開關另存不動。
        setOpen(false);
        setFloatingPosition(getDefaultFloatingPosition());
        closeDevDebug();
        trackEvent('强制关闭调试面板');
    };
    const handleBlobGc = async () => {
        if (blobGcRunning) return;
        setBlobGcRunning(true);
        setBlobGcResult(null);
        try {
            // 不傳參 = 默認 72h 新鮮豁免（擋「已 put、引用未落盤」的競態），調試面板不提供改小的口子。
            const result = await runBlobGc();
            setBlobGcResult({ kind: 'done', ...result });
        } catch (error) {
            setBlobGcResult({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
        } finally {
            setBlobGcRunning(false);
        }
    };
    const copyLog = async () => {
        const text = formatDevDebugLog();
        if (!text) return;
        await navigator.clipboard.writeText(text);
        setCopied(true);
        trackEvent('导出调试日志', { 方式: '复制' });
        window.setTimeout(() => setCopied(false), 1200);
    };
    const downloadLog = async () => {
        const text = formatDevDebugLog();
        if (!text) return;
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const result = await shareOrDownloadFile({
            content: text,
            fileName: `devdebug-log-${__BUILD_BRANCH__}-${stamp}.json`,
            mimeType: 'application/json;charset=utf-8',
            shareTitle: 'Soren 調試日誌',
        });
        trackEvent('导出调试日志', { 方式: result === 'shared' ? '分享' : '下载' });
    };
    const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
        if (open || (event.pointerType === 'mouse' && event.button !== 0)) return;
        dragStateRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            origin: floatingPosition,
            moved: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
    };
    const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
        const drag = dragStateRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;

        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (!drag.moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
            drag.moved = true;
        }

        if (drag.moved) {
            event.preventDefault();
            setFloatingPosition(clampFloatingPosition({
                x: drag.origin.x + dx,
                y: drag.origin.y + dy,
            }));
        }
    };
    const finishDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
        const drag = dragStateRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;

        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        const next = clampFloatingPosition({
            x: drag.origin.x + dx,
            y: drag.origin.y + dy,
        });
        dragStateRef.current = null;
        suppressClickRef.current = drag.moved;

        if (drag.moved) {
            event.preventDefault();
            setFloatingPosition(next);
            window.setTimeout(() => { suppressClickRef.current = false; }, 0);
        }

        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    };
    const handleFloatingClick = (event: React.MouseEvent<HTMLButtonElement>) => {
        if (suppressClickRef.current) {
            event.preventDefault();
            event.stopPropagation();
            suppressClickRef.current = false;
            return;
        }
        setOpen(true);
        trackEvent('打开调试面板');
    };

    if (!available) return null;

    const panelPosition = getPanelPosition(floatingPosition);
    // 面板最大高度按「實際可視高度」算（visualViewport，避開手機動態工具欄），跟定位口徑一致，超出部分中間滾動。
    const panelMaxHeight = getViewportSize().height - FLOATING_SAFE_MARGIN * 2;

    return (
        <div
            className="fixed select-none"
            style={{
                left: open ? panelPosition.x : floatingPosition.x,
                top: open ? panelPosition.y : floatingPosition.y,
                zIndex: 2147483646,
            }}
        >
            {!open && (
                <button
                    type="button"
                    aria-label="打開調試面板"
                    onClick={handleFloatingClick}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={finishDrag}
                    onPointerCancel={finishDrag}
                    className="relative flex h-11 w-11 cursor-grab touch-none items-center justify-center rounded-full border border-white/15 bg-black/45 text-white shadow-lg backdrop-blur-md active:scale-95 active:cursor-grabbing"
                >
                    <Wrench size={20} weight="bold" />
                    {activeCount > 0 && (
                        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-300 px-1 text-[10px] font-black leading-none text-black">
                            {activeCount}
                        </span>
                    )}
                </button>
            )}

            {open && (
                <section
                    className="flex w-[min(342px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl border border-white/12 bg-zinc-950/90 text-white shadow-2xl backdrop-blur-xl"
                    style={{ maxHeight: panelMaxHeight }}
                    aria-label="開發調試面板"
                >
                    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                        <div className="flex min-w-0 items-center gap-2">
                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-amber-200">
                                <Wrench size={17} weight="bold" />
                            </div>
                            <div className="min-w-0">
                                <div className="text-sm font-black leading-tight">Dev Debug</div>
                                <div className="truncate font-mono text-[10px] text-white/40">
                                    {BUILD_LABEL}
                                </div>
                            </div>
                        </div>
                        <button
                            type="button"
                            aria-label="關閉調試面板"
                            onClick={() => setOpen(false)}
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/70 active:scale-95"
                        >
                            <X size={15} weight="bold" />
                        </button>
                    </div>

                    <div className="flex-1 overflow-y-auto px-4">
                        <ToggleRow
                            title="跳過 Prompt Build"
                            detail="只發送聊天歷史。"
                            checked={flags.skipPromptBuild}
                            onChange={(checked) => updateFlag('skipPromptBuild', checked)}
                        />
                        <div className="h-px bg-white/10" />
                        <ToggleRow
                            title="暫停情緒副評估"
                            detail="主回覆仍照常發送，但不啟動情緒副評估（本地和即時對話都不跑）。"
                            checked={flags.skipEmotionEval}
                            onChange={(checked) => updateFlag('skipEmotionEval', checked)}
                        />
                        <div className="h-px bg-white/10" />
                        <ToggleRow
                            title="合併 system 為一條"
                            detail="排查中轉對多條 system 的計量/兼容問題；開著會讓前綴緩存失效。"
                            checked={flags.mergeSystemMessages}
                            onChange={(checked) => updateFlag('mergeSystemMessages', checked)}
                        />
                        <div className="h-px bg-white/10" />
                        {import.meta.env.DEV && <>
                            <ToggleRow title="SAR 劇情與表情校對" detail="臨時開放名冊回顧，不改變真實星級或獎勵。" checked={flags.sarExpressionReview} onChange={checked => updateFlag('sarExpressionReview', checked)} />
                            <div className="h-px bg-white/10" />
                        </>}
                        {/* 只是入口：打開後由 Amsg2DebugPanel 自己在頁面上掛小窗，本面板不渲染它的內容。 */}
                        <ToggleRow
                            title="amsg2 任務觀察窗"
                            detail="右上角常駐小窗：任務倒計時、cron 實際觸發時刻、通道 trace。"
                            checked={flags.amsg2Panel}
                            onChange={(checked) => updateFlag('amsg2Panel', checked)}
                        />
                        <div className="h-px bg-white/10" />

                        {/* 記錄日誌：總開關；打開後才露出 類型 / 記錄完整 / 複製 / 下載 一整套 —— 關掉時整段收起。
                            true→false 時清空日誌這一步在 writeDevDebugFlags 數據層做，這裡走通用 updateFlag。 */}
                        <ToggleRow
                            title="記錄日誌"
                            checked={flags.captureEnabled}
                            onChange={(checked) => {
                                updateFlag('captureEnabled', checked);
                                trackEvent('切换调试日志录制', { 状态: checked ? '开' : '关' });
                            }}
                        />
                        {flags.captureEnabled && (
                            <>
                                <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pb-3 pl-0.5">
                                    {DEV_DEBUG_CAPTURE_CATEGORIES.map((category) => (
                                        <CheckboxChip
                                            key={category.key}
                                            label={category.title}
                                            checked={flags.captureLogs.includes(category.key)}
                                            onChange={(checked) => toggleCapture(category.key, checked)}
                                        />
                                    ))}
                                </div>
                                <div className="mt-1 mb-3 flex gap-2">
                                    <LogActionButton
                                        onClick={copyLog}
                                        disabled={logCount === 0}
                                        icon={<ClipboardText size={13} weight="bold" />}
                                        label={copied ? '已複製' : logCount > 0 ? `複製 (${logCount})` : '暫無日誌'}
                                    />
                                    <LogActionButton
                                        onClick={downloadLog}
                                        disabled={logCount === 0}
                                        icon={<DownloadSimple size={13} weight="bold" />}
                                        label="下載"
                                    />
                                    {/* 「清空」只清日誌，不動開關 / 勾選；區別於「重置」（連開關一起回默認）和關掉總開關（清完後類型 UI 也收起）。 */}
                                    <LogActionButton
                                        onClick={() => {
                                            clearDevDebugLog();
                                            trackEvent('重置调试面板', { 范围: '仅日志' });
                                        }}
                                        disabled={logCount === 0}
                                        icon={<Trash size={13} weight="bold" />}
                                        label="清空"
                                    />
                                </div>
                                <div className="h-px bg-white/10" />
                                <ToggleRow
                                    title="記錄完整內容"
                                    detail="只對新條目生效"
                                    checked={flags.exposeLogDetail}
                                    onChange={(checked) => updateFlag('exposeLogDetail', checked)}
                                />
                            </>
                        )}
                        <div className="h-px bg-white/10" />

                        {/* 孤兒圖片 GC：手動跑一輪（默認 72h 新鮮豁免）。SDK 寧可留孤兒絕不刪活圖，
                            引用面枚舉出錯時整輪放棄（aborted），一個都不刪。 */}
                        <div className="py-3">
                            <div className="flex">
                                <LogActionButton
                                    onClick={handleBlobGc}
                                    disabled={blobGcRunning}
                                    icon={<Broom size={13} weight="bold" />}
                                    label={blobGcRunning ? '清理中…' : '清理孤兒圖片'}
                                />
                            </div>
                            {blobGcResult && (
                                <div className="mt-2 text-[11px] leading-relaxed text-white/55">
                                    {blobGcResult.kind === 'error' ? (
                                        `清理出錯：${blobGcResult.message}`
                                    ) : (
                                        <>
                                            已清理 {blobGcResult.deleted} · 保留 {blobGcResult.kept} · 邊界豁免 {blobGcResult.keptBoundary}
                                            {blobGcResult.aborted && (
                                                <><br />引用面枚舉或 blob 表掃描出錯，本輪已放棄、未刪除任何東西。</>
                                            )}
                                            {/* keptBoundary 是唯一報警信號：deleted:0 和「真沒垃圾」同形，
                                                它接近保留數 = 某個引用面混進了雜散令牌前綴文本，GC 整輪空轉。 */}
                                            {blobGcResult.keptBoundary > 0 && (
                                                <><br />注意：邊界豁免 &gt; 0，可能有引用面混進了雜散的令牌前綴文本；若它接近保留數，說明 GC 整輪空轉，需要排查。</>
                                            )}
                                        </>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="flex shrink-0 items-center justify-end gap-2 border-t border-white/10 px-4 py-3">
                        <button
                            type="button"
                            onClick={handleForceClose}
                            className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-white/10 px-3 text-[11px] font-bold text-white/70 active:scale-95"
                        >
                            <Power size={13} weight="bold" />
                            關閉
                        </button>
                        <button
                            type="button"
                            onClick={resetFlags}
                            className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-white/10 px-3 text-[11px] font-bold text-white/70 active:scale-95"
                        >
                            <ArrowsClockwise size={13} weight="bold" />
                            重置
                        </button>
                    </div>
                </section>
            )}
        </div>
    );
};

export default DevDebugPanel;
