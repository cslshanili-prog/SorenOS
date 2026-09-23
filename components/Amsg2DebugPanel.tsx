import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CornersIn, CornersOut, X } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import {
    buildAmsg2DebugTasks,
    clampPanelPosition,
    formatCountdown,
    DEBUG_PANEL_MARGIN_PX,
    type Amsg2DebugTaskView,
    type Amsg2PanelPosition,
} from '../utils/amsg2DebugView';
import {
    formatFullTraceLog,
    readAllInstantTraces,
    readRecentInstantTraces,
} from '../utils/instantTraceLog';
import { shareOrDownloadBlob } from '../utils/shareExport';
import { summarizeChannelHealth, type SwChannelHealth } from '../utils/swChannelProbe';
import {
    describeExpirePolicy,
    describeRecurrence,
    describeTaskMode,
} from '../utils/amsg2Tasks';
import {
    isDevDebugAvailable,
    readDevDebugFlags,
    subscribeDevDebugAvailability,
    subscribeDevDebugFlags,
    writeDevDebugFlags,
} from '../utils/devDebug';

// 倒計時只顯示到秒，1s 一跳就夠——500ms 的話有一半重繪畫出來的字是一樣的。
const REDRAW_MS = 1_000;
const TRACE_RELOAD_MS = 2_000;
const TRACE_SHOWN = 5;
/** 快到點了：倒計時轉綠的閾值。 */
const IMMINENT_MS = 60_000;

// GitHub Dark 的配色，等寬字 + 深底——這面板是當調試終端看的，跟 app 本身的視覺分開。
// 走內聯 style 不走 Tailwind：這些是精確色值，項目的調色板裡沒有對應色階。
const C = {
    fg: '#e6edf3',
    dim: '#8b949e',
    line: '#21262d',
    border: '#2b3a55',
    bg: 'rgba(10,12,20,.93)',
    green: '#7ee787',
    blue: '#58a6ff',
    orange: '#f0883e',
    red: '#f85149',
    yellow: '#d29922',
} as const;

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const hhmmss = (ms: number): string => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });

type TraceEntry = ReturnType<typeof readRecentInstantTraces>[number];

// 送達相關的事件挑出來上色：作廢 / 吞沒 / 失敗是橙的（消息沒發出去），收到是綠的。
function traceColor(event: string): string {
    // 防穿幫閘的「放行了」和「沒跑」都是正常結局，名字裡帶 expire 但不該刷成告警色——
    // 一屏橙色的話，真正要找的那條（吞掉）反而不顯眼了。這兩條排在下面那行之前。
    if (/expire-decision-pass|expire-gate-skipped/i.test(event)) return C.dim;
    if (/expire|swallow|fail|error|timeout/i.test(event)) return C.orange;
    if (/receiv|deliver|ok|success/i.test(event)) return C.green;
    return C.dim;
}

/** 一條任務的主色：正在發 > 快到點 > 還早；失效的一律沉成灰。 */
function taskColor(view: Amsg2DebugTaskView, nowMs: number): string {
    if (view.state === 'expired' || view.state === 'cancelled') return C.dim;
    if (view.state === 'firing') return C.orange;
    if (view.occurrenceMs != null && view.occurrenceMs - nowMs < IMMINENT_MS) return C.green;
    return C.blue;
}

const TaskRow: React.FC<{ view: Amsg2DebugTaskView; nowMs: number }> = ({ view, nowMs }) => {
    const { task, state, occurrenceMs, cronTickMs } = view;
    const dead = state === 'expired' || state === 'cancelled';
    const color = taskColor(view, nowMs);

    return (
        <div style={{ borderTop: `1px solid ${C.line}`, padding: '5px 0' }}>
            {occurrenceMs == null ? (
                <div style={{ color: C.red }}>觸發時間解析不了：{task.firstSendTime}</div>
            ) : dead ? (
                // 只說「已過點」，不說「未發」：這個面板是純本地派生、不查遠端，發沒發它並不知道。
                // 斷言成「未發」會把排查帶偏——實測就有過任務其實早被 worker 消費掉、面板卻寫著未發。
                // 要分辨發沒發，看設置面板裡那條任務的進度（它會拿遠端底帳對帳）。
                <div style={{ color: C.dim }}>
                    {view.charName} · {state === 'cancelled' ? '已取消' : '已過點'} · 原定 {hhmmss(occurrenceMs)}
                </div>
            ) : (
                <>
                    <div style={{ fontSize: 17, fontWeight: 700, color }}>
                        {formatCountdown(occurrenceMs - nowMs)}
                        {state === 'firing' && <span style={{ fontSize: 11 }}> 觸發窗口內</span>}
                    </div>
                    {/* 「開跑」不是「送達」：cron 到點只負責把任務撈起來開始生成，
                        消息還要等 LLM 出完內容才推出去。 */}
                    <div style={{ color: C.dim }}>
                        {view.charName} · {cronTickMs != null ? hhmmss(cronTickMs) : '—'} 開跑
                        {!view.charEnabled && <span style={{ color: C.red }}> [已關]</span>}
                    </div>
                </>
            )}

            {/* 這條任務到底要幹嘛：文案調 amsg2Tasks 的現成函數，跟角色上下文塊、
                list_active_messages 工具、設置面板說的是同一套詞。 */}
            <div style={{ color: C.dim }}>
                {describeTaskMode(task)}·{describeRecurrence(task.recurrenceType)}·{describeExpirePolicy(task.expirePolicy)}
            </div>

            {task.lastError && <div style={{ color: C.red }}>↳ {task.lastError}</div>}
        </div>
    );
};

const HeaderButton: React.FC<{
    onClick: () => void;
    label: string;
    children: React.ReactNode;
}> = ({ onClick, label, children }) => (
    <button
        type="button"
        aria-label={label}
        onClick={onClick}
        // 標題欄整條是拖動把手，按鈕得把 pointerdown 攔下來，否則點全屏 / 關閉會被當成開始拖。
        onPointerDown={(event) => event.stopPropagation()}
        style={{ color: C.dim, cursor: 'pointer', display: 'flex', alignItems: 'center' }}
    >
        {children}
    </button>
);

const getViewportSize = () => ({
    width: window.visualViewport?.width ?? window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
});

/**
 * amsg2 任務的實時觀察窗。入口在 Dev Debug 面板裡，打開後常駐右上角小窗，
 * 點一下鋪滿全屏看長列表；關掉聊天時它還在，隨時能瞄一眼下一次觸發還有多久。
 *
 * 抓標題欄可以把小窗拖到別處：它默認壓在右上角，正好蓋住聊天頁手動觸發主動消息的
 * 那顆按鈕，而「開著面板等觸發」又恰恰是它最常見的用法。位置只活在本次會話裡，
 * 關掉重開回默認角（同 DevDebugPanel 的浮球）。
 *
 * 任務數據直接取 OSContext 的 characters（面板掛在 Provider 裡面），不輪詢 IndexedDB——
 * getAllCharacters 會把整庫角色連頭像、立繪、世界書一起反序列化出來，而這面板正是「等推送
 * 時開著」的，每兩秒來一遍就是往送達路徑上壓連接。trace 是 localStorage 小字符串，照舊輪詢。
 *
 * 渲染走 portal 到 body：面板本體是 fixed 定位，留在 shell 的 transform 子樹裡會變成相對它
 * 定位、位置飄掉（同 apps/Chat.tsx 的劇場浮層）。
 */
const Amsg2DebugPanel: React.FC = () => {
    const { characters } = useOS();
    const [available, setAvailable] = useState(() => isDevDebugAvailable());
    const [enabled, setEnabled] = useState(() => readDevDebugFlags().amsg2Panel);
    const [fullscreen, setFullscreen] = useState(false);
    const [traces, setTraces] = useState<TraceEntry[]>([]);
    // 緩衝裡一共攢了多少條（列表只顯示得下最近幾條）。導出按鈕報的是這個數，
    // 用戶才知道自己交出去的是全部現場、不是屏幕上這幾行。
    const [traceTotal, setTraceTotal] = useState(0);
    const [traceExport, setTraceExport] = useState<'idle' | 'done' | 'failed'>('idle');
    const [nowMs, setNowMs] = useState(() => Date.now());
    // null = 還沒拖過，用默認的右上角；拖過之後記實際座標。不持久化，關掉重開回默認。
    const [position, setPosition] = useState<Amsg2PanelPosition | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<{ pointerId: number; startX: number; startY: number; origin: Amsg2PanelPosition } | null>(null);

    const [health, setHealth] = useState<SwChannelHealth | null>(null);

    useEffect(() => subscribeDevDebugAvailability(setAvailable), []);
    useEffect(() => subscribeDevDebugFlags((flags) => setEnabled(flags.amsg2Panel)), []);

    const active = available && enabled;

    useEffect(() => {
        if (!active) return;
        const readTraces = () => {
            setTraces(readRecentInstantTraces(TRACE_SHOWN));
            const all = readAllInstantTraces();
            setTraceTotal(all.length);
            // 用全部兩百條算，而不是上面顯示的那幾條：通道斷沒斷要看一段時間的走勢。
            setHealth(summarizeChannelHealth(all));
        };
        readTraces();
        const timer = window.setInterval(readTraces, TRACE_RELOAD_MS);
        return () => window.clearInterval(timer);
    }, [active]);

    useEffect(() => {
        if (!active) return;
        const timer = window.setInterval(() => setNowMs(Date.now()), REDRAW_MS);
        return () => window.clearInterval(timer);
    }, [active]);

    // nowMs 每秒變一次，但任務表只在 characters 變了才需要重算——別把 nowMs 塞進依賴裡
    // 讓整張表每秒重算一遍。狀態分界（到點、過寬限）本來就是分鐘級的事，晚一拍無所謂。
    const views = useMemo(() => buildAmsg2DebugTasks(characters, Date.now()), [characters]);
    const liveCount = useMemo(
        () => views.filter((v) => v.state === 'pending' || v.state === 'firing').length,
        [views],
    );

    // 轉屏 / 手機地址欄伸縮會把拖過的面板推到屏幕外，視口一變就拉回來。
    // 沒拖過（position 為 null）時靠 right:8 自己貼邊，不用管。
    useEffect(() => {
        if (!active) return;
        const pullBack = () => {
            const panel = panelRef.current;
            if (!panel) return;
            // updater 形式讀當前值，不吃閉包裡那份——這個 effect 只在 active 變化時重掛。
            setPosition((current) => (current === null ? null : clampPanelPosition(
                current,
                { width: panel.offsetWidth, height: panel.offsetHeight },
                getViewportSize(),
            )));
        };
        window.addEventListener('resize', pullBack);
        window.visualViewport?.addEventListener('resize', pullBack);
        return () => {
            window.removeEventListener('resize', pullBack);
            window.visualViewport?.removeEventListener('resize', pullBack);
        };
    }, [active]);

    const close = () => {
        setFullscreen(false);
        setPosition(null);
        setEnabled(writeDevDebugFlags({ ...readDevDebugFlags(), amsg2Panel: false }).amsg2Panel);
    };

    /**
     * 把整個 trace 緩衝導出成一個 json 文件。
     *
     * 走 shareOrDownloadBlob（跟導出備份同一條路）而不是自己拼 `<a download>`：這個按鈕
     * 的使用場景就是「用戶在手機上，隔著屏幕把現場發過來」，而原生殼 / iOS PWA 裡裸的
     * blob 下載基本是死的——那條路上先試系統分享面板，實在不行才退回瀏覽器下載。
     * 失敗（分享被拒 / 原生插件掛了）就把按鈕改成「導出失敗」，別假裝成功——
     * 用戶會以為文件已經在手上了。
     */
    const exportTraces = async () => {
        // 頁面側 + SW 側合在一起導：只有頁面那半截的話，「推送到沒到、SW 有沒有喊到
        // 頁面」全看不見，而這類故障的答案恰恰在那一段。
        const text = await formatFullTraceLog();
        if (!text) return;
        try {
            const result = await shareOrDownloadBlob({
                blob: new Blob([text], { type: 'application/json' }),
                fileName: `sullyos_amsg2_trace_${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
                shareTitle: 'Soren amsg2 trace',
            });
            // 用戶自己在分享面板上點了取消：既不算成功也不是錯，按鈕回到原樣就行。
            if (result === 'cancelled') return;
            setTraceExport('done');
        } catch {
            setTraceExport('failed');
        }
        window.setTimeout(() => setTraceExport('idle'), 1500);
    };

    // 全屏時四邊都釘死了，沒有可拖的餘地。
    const draggable = !fullscreen;

    const dragTo = (event: React.PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        const panel = panelRef.current;
        if (!drag || !panel || drag.pointerId !== event.pointerId) return null;
        return clampPanelPosition(
            { x: drag.origin.x + (event.clientX - drag.startX), y: drag.origin.y + (event.clientY - drag.startY) },
            { width: panel.offsetWidth, height: panel.offsetHeight },
            getViewportSize(),
        );
    };

    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        if (!draggable || (event.pointerType === 'mouse' && event.button !== 0)) return;
        const panel = panelRef.current;
        if (!panel) return;
        // 第一次拖：起點從當前實際位置讀（默認態是 right 定位，沒有 x/y 可繼承），
        // 否則會從 (0,0) 起跳、面板瞬移到左上角。
        const rect = panel.getBoundingClientRect();
        dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            origin: position ?? { x: rect.left, y: rect.top },
        };
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
        const next = dragTo(event);
        if (!next) return;
        event.preventDefault();
        setPosition(next);
    };

    const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
        const next = dragTo(event);
        dragRef.current = null;
        if (next) setPosition(next);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    };

    if (!active) return null;

    return createPortal(
        <div
            ref={panelRef}
            style={{
                position: 'fixed',
                // 沒拖過就貼右上角；拖過之後改用左上角座標定位（right 必須讓位，否則寬度被兩端撐死）。
                ...(position && !fullscreen
                    ? { top: position.y, left: position.x }
                    : { top: DEBUG_PANEL_MARGIN_PX, right: DEBUG_PANEL_MARGIN_PX }),
                ...(fullscreen
                    ? { left: DEBUG_PANEL_MARGIN_PX, bottom: DEBUG_PANEL_MARGIN_PX }
                    : { width: 'min(330px, calc(100vw - 16px))', maxHeight: '78vh' }),
                zIndex: 2147483645,
                display: 'flex',
                flexDirection: 'column',
                background: C.bg,
                color: C.fg,
                font: `12px/1.45 ${MONO}`,
                border: `1px solid ${C.border}`,
                borderRadius: 10,
                padding: '10px 12px',
                boxShadow: '0 6px 24px rgba(0,0,0,.45)',
                backdropFilter: 'blur(4px)',
            }}
            role="dialog"
            aria-label="amsg2 調試面板"
        >
            {/* 標題欄固定，內容區自己滾——不然列表一長，切全屏 / 關閉的按鈕就滾沒了。
                這一整條同時是拖動把手：touchAction none 讓手機上按住橫豎拖都歸我們，不被頁面滾動搶走。 */}
            <div
                style={{
                    flexShrink: 0,
                    cursor: draggable ? 'grab' : 'default',
                    touchAction: draggable ? 'none' : undefined,
                }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
            >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <b style={{ color: C.green }}>⏱ amsg2 debug</b>
                    <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        <HeaderButton
                            onClick={() => setFullscreen((v) => !v)}
                            label={fullscreen ? '縮回小窗' : '鋪滿全屏'}
                        >
                            {fullscreen ? <CornersIn size={13} weight="bold" /> : <CornersOut size={13} weight="bold" />}
                        </HeaderButton>
                        <HeaderButton onClick={close} label="關閉 amsg2 調試面板">
                            <X size={13} weight="bold" />
                        </HeaderButton>
                    </span>
                </div>
                <div style={{ color: C.dim, marginBottom: 6 }}>
                    now {hhmmss(nowMs)} · cron 每整分 · 待觸發 {liveCount}/{views.length}
                </div>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
                {views.length === 0 ? (
                    <div style={{ color: C.dim }}>（無 amsg2 任務）</div>
                ) : (
                    views.map((view) => (
                        <TaskRow key={`${view.charId}:${view.task.taskUuid}`} view={view} nowMs={nowMs} />
                    ))
                )}

                <div
                    style={{
                        borderTop: `1px solid ${C.line}`,
                        marginTop: 6,
                        paddingTop: 5,
                        color: C.yellow,
                        display: 'flex',
                        alignItems: 'baseline',
                        justifyContent: 'space-between',
                        gap: 8,
                    }}
                >
                    <span>
                        <b>trace</b>
                        <span style={{ color: C.dim, fontSize: 11 }}> 最近 {TRACE_SHOWN} 條 · 無條件記錄</span>
                    </span>
                    {/* 下面列表只顯示得下幾行，緩衝裡其實攢著兩百條。遠端排障要的是「一小時前
                        那會兒發生了什麼」，全靠這個按鈕把它們交出來。 */}
                    <button
                        type="button"
                        onClick={exportTraces}
                        disabled={traceTotal === 0}
                        style={{
                            color: traceExport === 'failed' ? C.red : C.dim,
                            fontSize: 11,
                            cursor: traceTotal === 0 ? 'default' : 'pointer',
                            whiteSpace: 'nowrap',
                            flexShrink: 0,
                        }}
                    >
                        {traceExport === 'done' ? '已導出'
                            : traceExport === 'failed' ? '導出失敗'
                                : traceTotal === 0 ? '暫無' : `導出全部 (${traceTotal})`}
                    </button>
                </div>
                {/* 實時通道的體檢結論。放在最顯眼處是因為這條腿斷了之後功能表面上還是好的——
                    消息照樣到，只是慢那麼幾秒，用戶多半當成「網絡卡」而不會來報。
                    iOS 上這條几乎必然是斷的：App 不在最前台時 SW 拿到的頁面名單就是空的。 */}
                {health && health.status !== 'idle' && (
                    <div
                        style={{
                            fontSize: 11,
                            marginBottom: 3,
                            color: health.status === 'ok' ? C.dim : C.red,
                        }}
                    >
                        {health.status === 'ok'
                            ? `實時通道正常 · 上次收到 SW 消息 ${hhmmss(new Date(health.lastSwMessageAt!).getTime())}`
                            : '⚠ 沒收到過 SW 實時通知，消息靠本地巡查自己撈（會慢幾秒，不會丟）'}
                        {health.flushByTrigger.length > 0 && (
                            <span style={{ color: C.dim }}>
                                {' · 沖刷來源 '}
                                {health.flushByTrigger.map((item) => `${item.trigger}×${item.count}`).join(' ')}
                            </span>
                        )}
                    </div>
                )}
                {traces.length === 0 ? (
                    <div style={{ color: C.dim, fontSize: 11 }}>（暫無）</div>
                ) : (
                    traces.map((entry, index) => (
                        <div
                            key={`${entry.ts ?? 'no-ts'}-${index}`}
                            style={{ fontSize: 11, color: traceColor(entry.event ?? '') }}
                        >
                            {entry.ts ? hhmmss(new Date(entry.ts).getTime()) : '--:--:--'} {entry.event ?? '?'}
                        </div>
                    ))
                )}
            </div>
        </div>,
        document.body,
    );
};

export default Amsg2DebugPanel;
