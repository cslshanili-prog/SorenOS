import React, { useEffect, useState, useCallback, useMemo } from 'react';
import Modal from '../os/Modal';
import { DB } from '../../utils/db';
import {
    API_REQUEST_CAPTURE_EVENT,
    formatApiRequestCaptureTxt,
    getApiRequestCaptureSectionContent,
    getApiRequestCaptureSectionSource,
    isApiRequestCaptureArmed,
    isSameCoreModel,
    isFixedPromptBlockLabel,
    setApiRequestCaptureArmed,
    summarizeApiRequestCaptureDuplicates,
} from '../../utils/apiCallLog';
import type {
    ApiCallLogEntry,
    ApiRequestCapture,
    ApiRequestCaptureSection,
    ApiRequestCaptureSectionKind,
    PromptBlockStat,
} from '../../utils/apiCallLog';
import { trackEvent } from '../../utils/analytics';
import { shareOrDownloadFile } from '../../utils/shareExport';

interface ApiCallLogModalProps {
    isOpen: boolean;
    onClose: () => void;
}

/** 把時間戳格式化成「今天 14:03:21 / 昨天 09:12 / 06-04 22:08」這種好掃的形態。 */
function formatTime(ts: number): { day: string; time: string } {
    const d = new Date(ts);
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const sameDay = (a: Date, b: Date) =>
        a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    let day: string;
    if (sameDay(d, now)) day = '今天';
    else if (sameDay(d, yesterday)) day = '昨天';
    else day = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return { day, time };
}

const ApiCallLogModal: React.FC<ApiCallLogModalProps> = ({ isOpen, onClose }) => {
    const [entries, setEntries] = useState<ApiCallLogEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [showHelp, setShowHelp] = useState(false);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [capture, setCapture] = useState<ApiRequestCapture | null>(null);
    const [captureArmed, setCaptureArmedState] = useState(() => isApiRequestCaptureArmed());

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const [data, savedCapture] = await Promise.all([
                DB.getApiCallLog(),
                DB.getApiRequestCapture(),
            ]);
            // DB 裡已按新→舊 unshift，這裡再兜底排一次序
            data.sort((a: ApiCallLogEntry, b: ApiCallLogEntry) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
            setEntries(data);
            setCapture(savedCapture);
            setCaptureArmedState(isApiRequestCaptureArmed());
            // 這一批記錄裡只要有一條「實際後端」跟請求的模型對不上，就記一次。
            // 只記「出現過」這件事，模型名一個字都不帶出去。
            if (data.some((e: ApiCallLogEntry) =>
                !!e.backendModel && e.backendModel !== e.model && !isSameCoreModel(e.model, e.backendModel)
            )) {
                trackEvent('记录里出现模型不符警告');
            }
        } catch {
            setEntries([]);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (isOpen) load();
    }, [isOpen, load]);

    useEffect(() => {
        const handleCaptureChange = async (event: Event) => {
            setCaptureArmedState(isApiRequestCaptureArmed());
            if ((event as CustomEvent)?.detail?.status === 'saved') {
                setCapture(await DB.getApiRequestCapture());
            }
        };
        window.addEventListener(API_REQUEST_CAPTURE_EVENT, handleCaptureChange);
        return () => window.removeEventListener(API_REQUEST_CAPTURE_EVENT, handleCaptureChange);
    }, []);

    const handleClear = useCallback(async () => {
        if (!window.confirm('確定清空所有 API 調用記錄嗎？此操作不可撤銷。')) return;
        await DB.clearApiCallLog();
        setEntries([]);
        trackEvent('清空 API 调用记录');
    }, []);

    const handleCaptureToggle = useCallback(() => {
        setApiRequestCaptureArmed(!captureArmed);
        setCaptureArmedState(isApiRequestCaptureArmed());
    }, [captureArmed]);

    const handleCaptureClear = useCallback(async () => {
        if (!window.confirm('確定清除這一次的完整發送內容嗎？')) return;
        await DB.clearApiRequestCapture();
        setCapture(null);
    }, []);

    return (
        <Modal
            isOpen={isOpen}
            title="API 調用記錄"
            onClose={onClose}
            footer={
                <div className="flex gap-2 w-full">
                    <button
                        onClick={onClose}
                        className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl active:scale-95 transition-transform"
                    >
                        關閉
                    </button>
                    <button
                        onClick={handleClear}
                        disabled={entries.length === 0}
                        className="px-5 py-3 bg-rose-50 text-rose-500 font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-40"
                    >
                        清空
                    </button>
                </div>
            }
        >
            <div className="flex items-start justify-between gap-2 mb-3 px-1">
                <p className="text-[11px] text-slate-400 leading-relaxed">
                    只保留最近 <span className="font-semibold text-slate-500">5 天</span>的調用，超期自動丟棄。記錄在你本地瀏覽器，不上傳。
                </p>
                <button
                    onClick={() => { if (!showHelp) trackEvent('打开实际后端字段说明'); setShowHelp(v => !v); }}
                    className={`shrink-0 w-5 h-5 rounded-full text-[11px] font-bold leading-none flex items-center justify-center transition-colors ${
                        showHelp ? 'bg-primary text-white' : 'bg-slate-200 text-slate-500'
                    }`}
                    aria-label="字段說明"
                >
                    ?
                </button>
            </div>

            {showHelp && (
                <div className="mb-3 rounded-2xl bg-amber-50/70 border border-amber-200/60 px-4 py-3 text-[11px] text-slate-600 leading-relaxed space-y-2">
                    <p className="font-bold text-amber-700">「實際後端」是什麼——僅供參考，不是測謊儀</p>
                    <p>
                        它是<span className="font-semibold">對面在回覆裡自己報的模型名字</span>。注意：這個名字是對面自己填的，可以是真的，也可以是假的。
                    </p>
                    <p className="font-semibold">三種情況：</p>
                    <p>
                        <span className="font-semibold text-amber-600">🟡 琥珀色 + ⚠️</span>：報的名字和你要的對不上。
                        <span className="font-semibold">有可能</span>被換了便宜模型，但也可能只是站子標籤沒寫整齊——別只憑這一行去定罪。
                    </p>
                    <p>
                        <span className="font-semibold">⚪ 灰色</span>：名字基本一致，只是格式不同（比如少了 [渠道]、(按次)、gcli- 這類標籤前綴）。正常。
                    </p>
                    <p>
                        <span className="font-semibold">🫥 沒有這一行</span>：最常見的情況。要麼對面把你請求的名字<span className="font-semibold">原樣抄了回來</span>（等於什麼都沒說），要麼乾脆沒報。
                        <span className="font-semibold">不代表有問題，也不代表沒問題——就是從這條線索看不出來。</span>
                    </p>
                    <p>
                        想判斷有沒有被偷偷換模型，要幾個信號<span className="font-semibold">一起看</span>：token 數是否突然對不上（比如平時 4 萬這次 1.5 萬）、速度是否突變、角色是否突然變笨/掉格式。只有一個信號異常時，先觀望，多攢幾輪再說。
                    </p>
                    <div className="pt-2 border-t border-amber-200/60 space-y-2">
                        <p className="font-bold text-sky-700">帶「☁️ 雲端」的那些是什麼</p>
                        <p>
                            開了<span className="font-semibold">即時對話</span>之後，聊天不再由這個頁面發出去，而是交給你自己那台 Worker 在雲端發——發完就能關頁面，回覆照樣回得來。這類調用一樣記在這裡，只是有幾處看不到：
                        </p>
                        <p>
                            <span className="font-semibold">「生成中」</span>：雲端已經收下，回覆還沒回來。收到回覆才會變成成功。
                        </p>
                        <p>
                            <span className="font-semibold">沒有耗時、沒有實際後端</span>：請求在雲端發出，本地既量不到時間，也看不到對面自報的模型名。
                        </p>
                        <p>
                            <span className="font-semibold text-amber-600">「只算末輪」</span>：角色查了東西再接著說的那種，一輪裡會調好幾次模型，而云端只報得回最後一次的 token。這條記錄上的數字<span className="font-semibold">比實際用量小</span>，別拿它去跟帳單對齊。
                        </p>
                        <p>
                            <span className="font-semibold">「已頂替」</span>：這條還沒等到回覆你就又發了一句，雲端把兩句合成一次回。這一輪不再單獨等回覆了。
                        </p>
                    </div>
                </div>
            )}

            <OneShotCapturePanel
                capture={capture}
                armed={captureArmed}
                onToggle={handleCaptureToggle}
                onClear={handleCaptureClear}
            />

            {entries.length > 0 && (() => {
                const totalTok = entries.reduce((s, e) => s + (e.totalTokens ?? 0), 0);
                const promptTok = entries.reduce((s, e) => s + (e.promptTokens ?? 0), 0);
                const compTok = entries.reduce((s, e) => s + (e.completionTokens ?? 0), 0);
                const fmt = (n: number) => n.toLocaleString('en-US');
                return (
                    <div className="mb-3 rounded-2xl bg-primary/5 border border-primary/15 px-4 py-3 flex items-center justify-around text-center">
                        <div>
                            <div className="text-[10px] text-slate-400">調用次數</div>
                            <div className="text-sm font-bold text-slate-600">{entries.length}</div>
                        </div>
                        <div className="w-px h-7 bg-slate-200" />
                        <div>
                            <div className="text-[10px] text-slate-400">總 Token</div>
                            <div className="text-sm font-bold text-primary">{fmt(totalTok)}</div>
                        </div>
                        <div className="w-px h-7 bg-slate-200" />
                        <div>
                            <div className="text-[10px] text-slate-400">輸入 / 輸出</div>
                            <div className="text-[11px] font-semibold text-slate-500">{fmt(promptTok)} / {fmt(compTok)}</div>
                        </div>
                    </div>
                );
            })()}

            {loading ? (
                <div className="py-10 text-center text-sm text-slate-400">加載中…</div>
            ) : entries.length === 0 ? (
                <div className="py-10 text-center text-sm text-slate-400">
                    暫無調用記錄。<br />
                    <span className="text-[11px]">和角色聊幾句、讓它刷下小紅書，這裡就會有數據了。</span>
                </div>
            ) : (
                <div className="space-y-2">
                    {entries.map((e) => {
                        const { day, time } = formatTime(e.timestamp);
                        const hasBreakdown = !!e.promptBreakdown?.length;
                        const expanded = expandedId === e.id;
                        return (
                            <div
                                key={e.id}
                                onClick={hasBreakdown ? () => { if (!expanded) trackEvent('展开单条输入构成'); setExpandedId(expanded ? null : e.id); } : undefined}
                                className={`rounded-2xl border p-3 ${
                                    e.ok ? 'bg-white/70 border-slate-200/60' : 'bg-rose-50/60 border-rose-200/60'
                                } ${hasBreakdown ? 'cursor-pointer active:scale-[0.99] transition-transform' : ''}`}
                            >
                                <div className="flex items-center justify-between gap-2 mb-1.5">
                                    <div className="flex items-center gap-1.5 min-w-0">
                                        <span className="text-[11px] font-bold text-slate-400 shrink-0">{day}</span>
                                        <span className="text-[11px] font-mono text-slate-500 shrink-0">{time}</span>
                                    </div>
                                    <div className="flex items-center gap-1.5 shrink-0">
                                        {/* 這條不是瀏覽器自己發的，是雲端那台 Worker 發的。不標出來的話，
                                            同一條記錄裡「沒有耗時、沒有實際後端、Token 偏小」全都沒法解釋 */}
                                        {e.route && (
                                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-sky-100 text-sky-600">
                                                ☁️ 雲端
                                            </span>
                                        )}
                                        <span
                                            className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                                                e.superseded ? 'bg-slate-100 text-slate-500'
                                                    : e.pending ? 'bg-amber-100 text-amber-600'
                                                        : e.ok ? 'bg-emerald-100 text-emerald-600' : 'bg-rose-100 text-rose-600'
                                            }`}
                                        >
                                            {e.superseded ? '已頂替'
                                                : e.pending ? '生成中'
                                                    : e.ok ? '成功' : `失敗${e.status ? ` ${e.status}` : ''}`}
                                        </span>
                                    </div>
                                </div>
                                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                                    <Field label="API" value={e.presetName} accent />
                                    <Field label="App" value={e.appName} />
                                    <Field label="角色" value={e.charName} />
                                    <Field label="用途" value={e.purpose} />
                                    <div className="col-span-2">
                                        {/* 模型/實際後端兩行不截斷（break-all 換行）：截斷會把「為什麼黃了」的
                                            關鍵差異（後綴 -c、渠道標籤）藏進省略號裡，用戶看著兩行一樣卻標黃一頭霧水 */}
                                        <Field label="模型" value={e.model} mono wrap />
                                    </div>
                                    {/* 後端自報身份（response.model）：字符串不同就展示；琥珀判定見
                                        isSameCoreModel——渠道標籤/前綴（[渠道]、(按次)、gcli-、models/）算同名
                                        （灰色），尾巴長出變體（X-c / X-lite）才是真被換了後端（琥珀）。 */}
                                    {e.backendModel && e.backendModel !== e.model && (() => {
                                        const swapped = !isSameCoreModel(e.model, e.backendModel);
                                        return (
                                            <div className="col-span-2 flex items-baseline gap-1.5 min-w-0">
                                                <span className={`text-[10px] shrink-0 ${swapped ? 'text-amber-500' : 'text-slate-400'}`}>實際後端</span>
                                                <span className={`break-all font-mono ${swapped ? 'font-semibold text-amber-600' : 'text-slate-500'}`}>
                                                    {e.backendModel}{swapped ? ' ⚠️' : ''}
                                                </span>
                                            </div>
                                        );
                                    })()}
                                    {e.durationMs != null && (
                                        <Field label="耗時" value={e.durationMs >= 1000 ? `${(e.durationMs / 1000).toFixed(1)}s` : `${e.durationMs}ms`} />
                                    )}
                                    {(e.totalTokens != null || e.promptTokens != null || e.completionTokens != null) && (
                                        <div className="col-span-2 flex items-baseline gap-1.5 min-w-0">
                                            <span className="text-[10px] text-slate-400 shrink-0">Token</span>
                                            <span className="text-slate-600 truncate">
                                                {(e.totalTokens ?? 0).toLocaleString('en-US')}
                                                <span className="text-slate-400">
                                                    {' '}（入 {(e.promptTokens ?? 0).toLocaleString('en-US')} · 出 {(e.completionTokens ?? 0).toLocaleString('en-US')}）
                                                </span>
                                                {/* 雲端這一輪調了不止一次模型時，回傳的用量只有最後那次。
                                                    不註明的話這個數拿去對帳永遠對不上，還會以為是被多扣了 */}
                                                {e.tokensPartial && <span className="text-amber-500"> · 只算末輪</span>}
                                            </span>
                                        </div>
                                    )}
                                </div>
                                {hasBreakdown && (
                                    <div className="mt-1.5 text-[10px] text-slate-300 select-none">
                                        {expanded ? '▲ 收起輸入構成' : '▼ 點擊查看輸入構成（哪塊佔了多少）'}
                                    </div>
                                )}
                                {expanded && e.promptBreakdown && (
                                    <>
                                        {/* 只有聊天那條路會被雲端二次加料（當前時間、天氣熱搜這些當下才知道的東西）。
                                            後台活兒（門牌整理）交上去的就是最終提示詞，別讓用戶以為還有看不見的部分 */}
                                        {e.route === 'cloud-instant-chat' && (
                                            <p className="mt-2 text-[10px] text-slate-400 leading-relaxed">
                                                這裡統計的是本地拼好、交給雲端的那份。雲端真正發出前還會補上當前時間、天氣熱搜這些當下才知道的內容，所以實際輸入會比下面略大一點。
                                            </p>
                                        )}
                                        <PromptBreakdownView blocks={e.promptBreakdown} promptTokens={e.promptTokens} />
                                    </>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </Modal>
    );
};

const CAPTURE_KIND_LABEL: Record<ApiRequestCaptureSectionKind, string> = {
    request: '參數',
    tools: '工具',
    system: '系統提示詞',
    memory: '記憶召回',
    worldbook: '世界書',
    group: '群聊背景',
    history: '對話歷史',
    context: '角色上下文',
    user: '用戶消息',
    assistant: '角色歷史',
    tool: '工具結果',
};

const CAPTURE_KIND_STYLE: Record<ApiRequestCaptureSectionKind, string> = {
    request: 'bg-slate-100 text-slate-500',
    tools: 'bg-sky-50 text-sky-600',
    system: 'bg-violet-50 text-violet-600',
    memory: 'bg-amber-50 text-amber-700',
    worldbook: 'bg-emerald-50 text-emerald-700',
    group: 'bg-fuchsia-50 text-fuchsia-700',
    history: 'bg-orange-50 text-orange-700',
    context: 'bg-indigo-50 text-indigo-600',
    user: 'bg-blue-50 text-blue-600',
    assistant: 'bg-rose-50 text-rose-600',
    tool: 'bg-cyan-50 text-cyan-700',
};

async function copyCaptureText(value: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
}

async function downloadCaptureTxt(capture: ApiRequestCapture, content: string): Promise<void> {
    const d = new Date(capture.capturedAt);
    const pad = (value: number) => String(value).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    await shareOrDownloadFile({
        content: `\uFEFF${content}`,
        fileName: `SullyOS-LLM本次發送統計-${stamp}.txt`,
        mimeType: 'text/plain;charset=utf-8',
        shareTitle: 'Soren LLM 本次發送統計',
    });
}

const OneShotCapturePanel: React.FC<{
    capture: ApiRequestCapture | null;
    armed: boolean;
    onToggle: () => void;
    onClear: () => void;
}> = ({ capture, armed, onToggle, onClear }) => {
    const [expandedSectionId, setExpandedSectionId] = useState<string | null>(null);
    const [showFixedSections, setShowFixedSections] = useState(false);
    const [copyNotice, setCopyNotice] = useState('');

    useEffect(() => {
        setExpandedSectionId(null);
        setShowFixedSections(false);
        setCopyNotice('');
    }, [capture?.id]);

    const copy = useCallback(async (value: string, notice: string) => {
        try {
            await copyCaptureText(value);
            setCopyNotice(notice);
            window.setTimeout(() => setCopyNotice(''), 1600);
        } catch {
            setCopyNotice('複製失敗，請展開後手動複製');
        }
    }, []);

    const capturedTime = capture ? formatTime(capture.capturedAt) : null;
    const fmt = (n: number) => n.toLocaleString('en-US');
    const rawId = '__raw_request__';
    const txtReport = useMemo(() => capture ? formatApiRequestCaptureTxt(capture) : '', [capture]);
    const promptTokenValue = !capture
        ? '—'
        : capture.promptTokens != null
            ? fmt(capture.promptTokens)
            : capture.usageStatus === 'pending'
                ? '等待響應…'
                : capture.usageStatus === 'failed'
                    ? '請求失敗'
                    : capture.usageStatus == null
                        ? '舊記錄未採集'
                        : '接口未返回';
    const fixedSections = useMemo(
        () => capture?.sections.filter(section => section.kind === 'system') || [],
        [capture],
    );
    const detailSections = useMemo(
        () => capture?.sections.filter(section => section.kind !== 'system') || [],
        [capture],
    );
    const duplicateSummary = useMemo(
        () => capture ? summarizeApiRequestCaptureDuplicates(capture) : null,
        [capture],
    );
    const sourceStats = useMemo(() => {
        if (!capture) return [];
        const grouped = new Map<ApiRequestCaptureSectionKind, { chars: number; count: number; source: string }>();
        capture.sections
            .filter(section => section.kind !== 'system' && section.kind !== 'request' && section.kind !== 'tools')
            .forEach(section => {
            const current = grouped.get(section.kind) || {
                chars: 0,
                count: 0,
                source: getApiRequestCaptureSectionSource(section),
            };
            current.chars += section.chars;
            current.count++;
            grouped.set(section.kind, current);
            });
        const total = [...grouped.values()].reduce((sum, item) => sum + item.chars, 0) || 1;
        return [...grouped.entries()]
            .map(([kind, item]) => ({ ...item, kind, pct: item.chars / total * 100 }))
            .sort((a, b) => b.chars - a.chars);
    }, [capture]);

    const exportTxt = useCallback(async () => {
        if (!capture || !txtReport) return;
        await downloadCaptureTxt(capture, txtReport);
        setCopyNotice('TXT 已導出');
        window.setTimeout(() => setCopyNotice(''), 1600);
    }, [capture, txtReport]);

    const renderSection = (section: ApiRequestCaptureSection) => {
        const expanded = expandedSectionId === section.id;
        return (
            <div key={section.id} className="overflow-hidden rounded-xl border border-slate-200/70 bg-white/80">
                <button
                    type="button"
                    onClick={() => setExpandedSectionId(expanded ? null : section.id)}
                    className="flex w-full items-start gap-2 px-3 py-2.5 text-left"
                >
                    <span className={`mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-[9px] font-semibold ${CAPTURE_KIND_STYLE[section.kind]}`}>
                        {CAPTURE_KIND_LABEL[section.kind]}
                    </span>
                    <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                            <span className="min-w-0 flex-1 truncate text-[10px] font-semibold text-slate-600" title={section.label}>{section.label}</span>
                            <span className="shrink-0 font-mono text-[9px] text-slate-400">{fmt(section.chars)} 字符</span>
                        </span>
                        <span className="mt-0.5 block break-words text-[9px] leading-relaxed text-slate-400">
                            來自：{getApiRequestCaptureSectionSource(section)}
                        </span>
                        <span className="mt-0.5 block truncate font-mono text-[8px] text-slate-300" title={section.path || ''}>
                            {section.path || (section.messageIndex != null ? `messages[${section.messageIndex}]` : '請求體')}
                        </span>
                    </span>
                    <span className="mt-0.5 shrink-0 text-[9px] text-slate-300">{expanded ? '▲' : '▼'}</span>
                </button>
                {expanded && (
                    <CaptureSectionContent
                        content={getApiRequestCaptureSectionContent(capture!, section)}
                        mono={section.kind === 'request' || section.kind === 'tools' || section.kind === 'tool'}
                        onCopy={value => copy(value, '本區已複製')}
                    />
                )}
            </div>
        );
    };

    return (
        <section className="mb-4 border-y border-slate-200/70 py-4" aria-labelledby="one-shot-capture-title">
            <div className="flex items-start justify-between gap-4 px-1">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <h3 id="one-shot-capture-title" className="text-sm font-bold text-slate-700">本次發送統計</h3>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[9px] font-semibold text-slate-400">一次後自動關閉</span>
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                        開啟後，完整記錄下一次發給 LLM 的內容，用來查是哪段記憶、提示詞或歷史撐大了上下文。
                    </p>
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={armed}
                    aria-label="本次發送統計"
                    onClick={onToggle}
                    className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors ${armed ? 'bg-primary' : 'bg-slate-200'}`}
                >
                    <span className={`absolute left-0 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${armed ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
            </div>

            <div className={`mt-3 rounded-2xl border px-4 py-3 ${
                armed ? 'border-primary/25 bg-primary/5' : capture ? 'border-emerald-200/70 bg-emerald-50/40' : 'border-slate-200/60 bg-slate-50/60'
            }`}>
                <div className="flex items-center gap-2 text-[11px] font-semibold">
                    <span className={`h-2 w-2 rounded-full ${armed ? 'animate-pulse bg-primary' : capture ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                    <span className={armed ? 'text-primary' : capture ? 'text-emerald-700' : 'text-slate-500'}>
                        {armed ? '等待下一次 LLM 調用…' : capture ? '已抓取，開關已自動關閉' : '尚未開啟抓取'}
                    </span>
                </div>
                {armed && capture && (
                    <p className="mt-1 pl-4 text-[10px] text-slate-400">下面是上一次結果；下一次調用會覆蓋它。</p>
                )}

                {capture && (
                    <div className="mt-3">
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[10px]">
                            <Field label="時間" value={`${capturedTime?.day} ${capturedTime?.time}`} />
                            <Field label="App" value={capture.meta.appName} />
                            <Field label="用途" value={capture.meta.purpose} />
                            <Field label="角色" value={capture.meta.charName} />
                            <div className="col-span-2"><Field label="模型" value={capture.model} mono wrap /></div>
                        </div>
                        <div className="mt-3 border-y border-emerald-100/80 py-3">
                            <div className="flex items-end justify-between gap-4">
                                <div>
                                    <div className="text-[9px] font-semibold text-slate-400">本次輸入 Token</div>
                                    <div className="mt-0.5 text-xl font-bold tracking-tight text-slate-700">{promptTokenValue}</div>
                                </div>
                                <div className="pb-0.5 text-right text-[9px] leading-relaxed text-slate-400">
                                    <div>模型響應自報</div>
                                    <div>不是字符換算</div>
                                </div>
                            </div>
                            <div className="mt-2 border-t border-emerald-100/70 pt-2 text-[9px] leading-relaxed text-slate-400">
                                輔助計數：請求 JSON {fmt(capture.totalChars)} 字符（非 Token） · {capture.messageCount} 條消息 · {capture.sections.length} 個分區
                            </div>
                        </div>

                        {duplicateSummary && (
                            <div className={`mt-3 border-l-2 py-1.5 pl-3 ${
                                duplicateSummary.groups === 0 ? 'border-emerald-400' : 'border-amber-400'
                            }`}>
                                <div className={`text-[10px] font-bold ${
                                    duplicateSummary.groups === 0 ? 'text-emerald-700' : 'text-amber-700'
                                }`}>
                                    {duplicateSummary.groups === 0
                                        ? '✓ 客戶端發出前未發現完全重複的大段內容'
                                        : `! 客戶端請求內發現 ${duplicateSummary.groups} 組重複大段`}
                                </div>
                                <p className="mt-0.5 text-[9px] leading-relaxed text-slate-500">
                                    {duplicateSummary.groups === 0
                                        ? '若服務商後台仍顯示同一提示詞出現兩份，重複發生在請求離開客戶端之後。'
                                        : `重複內容額外佔用 ${fmt(duplicateSummary.extraChars)} 字符；請在下方逐段核對來源。`}
                                </p>
                            </div>
                        )}

                        <p className="mt-2 text-[10px] leading-relaxed text-amber-700/80">
                            內容僅保存在本機，可能含聊天和記憶隱私。發給別人排查前請先檢查。
                            {capture.binaryPlaceholders > 0 && ` ${capture.binaryPlaceholders} 個圖片/音頻二進制只保留了類型和原始長度。`}
                        </p>

                        <div className="mt-3 grid grid-cols-2 gap-2">
                            <button
                                type="button"
                                onClick={() => copy(txtReport, '完整 TXT 報告已複製')}
                                className="rounded-xl bg-primary px-3 py-2.5 text-[10px] font-bold text-white active:scale-[0.98] transition-transform"
                            >
                                複製完整報告
                            </button>
                            <button
                                type="button"
                                onClick={exportTxt}
                                className="rounded-xl border border-primary/20 bg-white px-3 py-2.5 text-[10px] font-bold text-primary active:scale-[0.98] transition-transform"
                            >
                                導出 TXT
                            </button>
                        </div>

                        {sourceStats.length > 0 && (
                            <div className="mt-4 border-t border-slate-200/70 pt-3">
                                <div className="flex items-baseline justify-between gap-2">
                                    <h4 className="text-[11px] font-bold text-slate-600">可變化內容組成</h4>
                                    <span className="text-[9px] text-slate-400">僅比較動態內容 · 非 Token</span>
                                </div>
                                <p className="mt-1 text-[9px] leading-relaxed text-slate-400">
                                    這裡關注會隨聊天變化的歷史、記憶和場景；固定基礎指令已單獨收起，不參與佔比。
                                </p>
                                <div className="mt-2.5 space-y-2.5">
                                    {sourceStats.map(item => (
                                        <div key={item.kind}>
                                            <div className="flex items-baseline gap-2">
                                                <span className="min-w-0 flex-1 truncate text-[10px] font-semibold text-slate-600" title={item.source}>
                                                    {CAPTURE_KIND_LABEL[item.kind]}
                                                </span>
                                                <span className="shrink-0 font-mono text-[9px] text-slate-400">
                                                    {fmt(item.chars)} 字符 · {item.pct < 1 ? '<1' : Math.round(item.pct)}%
                                                </span>
                                            </div>
                                            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
                                                <div
                                                    className="h-full rounded-full bg-primary/55"
                                                    style={{ width: `${Math.max(item.pct, 1.5)}%` }}
                                                />
                                            </div>
                                            <p className="mt-0.5 break-words text-[9px] leading-relaxed text-slate-400">
                                                來自：{item.source} · {item.count} 個分區
                                            </p>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {fixedSections.length > 0 && (
                            <div className="mt-4 border-t border-slate-200/70 pt-3">
                                <button
                                    type="button"
                                    onClick={() => setShowFixedSections(value => !value)}
                                    className="flex w-full items-start gap-3 text-left"
                                >
                                    <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-violet-300" />
                                    <span className="min-w-0 flex-1">
                                        <span className="flex items-center gap-2">
                                            <span className="text-[11px] font-bold text-slate-600">基礎固定指令</span>
                                            <span className="rounded-full bg-violet-50 px-1.5 py-0.5 text-[8px] font-semibold text-violet-500">穩定基線</span>
                                        </span>
                                        <span className="mt-0.5 block text-[9px] leading-relaxed text-slate-400">
                                            應用和預設正常工作所需，通常不會隨聊天輪數持續增長；已合併顯示，不作為首要膨脹項。
                                        </span>
                                    </span>
                                    <span className="shrink-0 pt-0.5 text-[9px] font-semibold text-violet-500">
                                        {showFixedSections ? '收起' : '查看明細'}
                                    </span>
                                </button>
                                {showFixedSections && (
                                    <div className="mt-2 space-y-1.5 border-l border-violet-100 pl-3">
                                        {fixedSections.map(renderSection)}
                                    </div>
                                )}
                            </div>
                        )}

                        <div className="mt-4 border-t border-slate-200/70 pt-3">
                            <div className="mb-2">
                                <h4 className="text-[11px] font-bold text-slate-600">動態內容與請求配置</h4>
                                <p className="mt-0.5 text-[9px] text-slate-400">按實際發送順序列出；每段都標明來源和原始請求位置。</p>
                            </div>
                            <div className="space-y-1.5">
                            {detailSections.map(renderSection)}

                            <div className="overflow-hidden rounded-xl border border-slate-200/70 bg-white/80">
                                <button
                                    type="button"
                                    onClick={() => setExpandedSectionId(expandedSectionId === rawId ? null : rawId)}
                                    className="flex w-full items-center gap-2 px-3 py-2 text-left"
                                >
                                    <span className="shrink-0 rounded-md bg-slate-800 px-1.5 py-0.5 text-[9px] font-semibold text-white">原始</span>
                                    <span className="min-w-0 flex-1 truncate text-[10px] text-slate-600">完整請求 JSON（核對所有字段）</span>
                                    <span className="shrink-0 text-[9px] text-slate-300">{expandedSectionId === rawId ? '▲' : '▼'}</span>
                                </button>
                                {expandedSectionId === rawId && (
                                    <CaptureSectionContent
                                        content={JSON.stringify(capture.payload, null, 2)}
                                        mono
                                        onCopy={value => copy(value, '完整請求已複製')}
                                    />
                                )}
                            </div>
                            </div>
                        </div>

                        <div className="mt-3 flex items-center justify-between gap-3">
                            <span className="text-[10px] font-semibold text-primary">{copyNotice}</span>
                            <button type="button" onClick={onClear} className="ml-auto text-[10px] font-semibold text-rose-500">清除本次詳情</button>
                        </div>
                    </div>
                )}
            </div>
        </section>
    );
};

const CaptureSectionContent: React.FC<{ content: string; mono?: boolean; onCopy: (value: string) => void }> = ({ content, mono, onCopy }) => (
    <div className="border-t border-slate-100 bg-slate-50/70 p-2.5">
        <div className="mb-2 flex justify-end">
            <button type="button" onClick={() => onCopy(content)} className="rounded-lg bg-white px-2 py-1 text-[9px] font-semibold text-primary shadow-sm">
                複製本區
            </button>
        </div>
        <pre
            tabIndex={0}
            className={`max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-slate-200/70 bg-white p-3 text-[10px] leading-5 text-slate-700 select-text ${mono ? 'font-mono' : 'font-sans'}`}
        >
            {content || '（空內容）'}
        </pre>
    </div>
);

/**
 * 輸入構成面板：按字數降序列出每塊（system 的 ### 段落 / 聚合的聊天歷史），
 * 附佔比條 + 按字符佔比折算的 token 估算（分詞器差異下只是量級參考，不是精確值）。
 */
const PromptBreakdownView: React.FC<{ blocks: PromptBlockStat[]; promptTokens?: number }> = ({ blocks, promptTokens }) => {
    const totalChars = blocks.reduce((sum, b) => sum + b.chars, 0) || 1;
    // 寫死的固定骨架塊（行為規範/表達底線/鋼印等）合併成一行——它們不隨用戶數據
    // 變化、也沒有可優化空間，散成一堆小行只會淹沒真正有信息量的數據塊。
    const fixed = blocks.filter(b => isFixedPromptBlockLabel(b.label));
    const merged: PromptBlockStat[] = fixed.length >= 2
        ? [
            ...blocks.filter(b => !isFixedPromptBlockLabel(b.label)),
            { label: `固定提示詞（規則/格式，共 ${fixed.length} 塊）`, chars: fixed.reduce((s, b) => s + b.chars, 0) },
        ]
        : blocks;
    const rows = [...merged].sort((a, b) => b.chars - a.chars);
    const fmt = (n: number) => n.toLocaleString('en-US');
    return (
        <div className="mt-2 pt-2 border-t border-slate-100 space-y-1.5" onClick={(ev) => ev.stopPropagation()}>
            <div className="flex items-baseline justify-between">
                <span className="text-[10px] font-bold text-slate-400">輸入構成 · 共 {fmt(totalChars)} 字符</span>
                {promptTokens != null && (
                    <span className="text-[9px] text-slate-300">token 列為按字符佔比折算的估算</span>
                )}
            </div>
            {rows.map((b, i) => {
                const pct = (b.chars / totalChars) * 100;
                const estTok = promptTokens != null ? Math.round(promptTokens * b.chars / totalChars) : null;
                return (
                    <div key={i} className="min-w-0">
                        <div className="flex items-baseline justify-between gap-2 min-w-0">
                            <span className="text-[10px] text-slate-500 truncate" title={b.label}>{b.label}</span>
                            <span className="text-[10px] font-mono text-slate-400 shrink-0">
                                {fmt(b.chars)} 字{estTok != null ? ` · ~${fmt(estTok)} tok` : ''} · {pct < 1 ? '<1' : Math.round(pct)}%
                            </span>
                        </div>
                        <div className="h-1 rounded-full bg-slate-100 overflow-hidden">
                            <div className="h-full rounded-full bg-primary/50" style={{ width: `${Math.max(pct, 1.5)}%` }} />
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

const Field: React.FC<{ label: string; value?: string; accent?: boolean; mono?: boolean; wrap?: boolean }> = ({
    label,
    value,
    accent,
    mono,
    wrap,
}) => (
    <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="text-[10px] text-slate-400 shrink-0">{label}</span>
        <span
            className={`${wrap ? 'break-all' : 'truncate'} ${mono ? 'font-mono' : ''} ${
                accent ? 'font-semibold text-primary' : 'text-slate-600'
            }`}
            title={value || ''}
        >
            {value && value.trim() ? value : '—'}
        </span>
    </div>
);

export default ApiCallLogModal;
