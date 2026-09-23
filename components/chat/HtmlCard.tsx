import React, { useEffect, useRef, useState } from 'react';
import { CaretDown, Check, CopySimple } from '@phosphor-icons/react';

/**
 * HTML 卡片渲染（私聊 MessageItem 與群聊 GroupMessageItem 共用）。
 * 沙盒 iframe：禁用腳本 / 表單提交 / 彈窗，避免任意 HTML 越權訪問父頁面。
 * srcDoc 用一個全寬中心化的 wrapper, 讓 270px 的卡片在 iframe 里居中、背景透明。
 * body>* 強制清掉最外層元素的 box-shadow/filter: 模型經常給卡片外層加柔和陰影,
 * 但 iframe 只比卡片寬一點 + 外層 overflow-hidden, 陰影會被裁成一圈"若隱若現的
 * 假邊框"貼在卡片周圍 —— 聊天裡卡片約定是直接貼在聊天背景上、無背景無邊框,
 * 這裡在渲染端兜底 (對已落庫的舊卡片同樣生效), 提示詞端同步不再教模型加外層陰影。
 */
const HtmlCard: React.FC<{ html: string }> = ({ html }) => {
    const [sourceExpanded, setSourceExpanded] = useState(false);
    const [copyState, setCopyState] = useState<'idle' | 'ok' | 'error'>('idle');
    const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const srcDoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;padding:0;background:transparent;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#334155;}body{display:flex;justify-content:center;padding:0;}*{box-sizing:border-box;}img{max-width:100%;}body>*{box-shadow:none!important;filter:none!important;}</style></head><body>${html}</body></html>`;

    useEffect(() => () => {
        if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    }, []);

    const copyHtmlSource = async (event: React.MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        let copied = false;
        try {
            if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
            // Copy the exact source stored on the message, not the renderer's
            // srcDoc wrapper, so users can archive or edit the original card.
            await navigator.clipboard.writeText(html);
            copied = true;
        } catch {
            // iOS PWA / non-secure contexts can reject Clipboard API. Keep a
            // user-gesture fallback without touching interactions in the iframe.
            let textarea: HTMLTextAreaElement | null = null;
            try {
                textarea = document.createElement('textarea');
                textarea.value = html;
                textarea.setAttribute('readonly', '');
                textarea.style.position = 'fixed';
                textarea.style.left = '-9999px';
                textarea.style.opacity = '0';
                textarea.style.pointerEvents = 'none';
                document.body.appendChild(textarea);
                textarea.select();
                textarea.setSelectionRange(0, textarea.value.length);
                copied = document.execCommand('copy');
            } catch {
                copied = false;
            } finally {
                textarea?.remove();
            }
        }

        setCopyState(copied ? 'ok' : 'error');
        if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
        feedbackTimerRef.current = setTimeout(() => setCopyState('idle'), 1600);
    };

    return (
        <div className="w-[280px] max-w-full rounded-[18px] overflow-hidden bg-transparent">
            <iframe
                title="html-card"
                srcDoc={srcDoc}
                // allow-same-origin: 讓父頁面能讀 contentDocument 自動調高度
                // 故意不給 allow-scripts / allow-forms / allow-popups —
                // AI 輸出裡的 <script> 不會執行, 表單 / 彈窗 / 頂層跳轉 也都被攔。
                sandbox="allow-same-origin"
                referrerPolicy="no-referrer"
                className="block w-full min-h-[120px] border-0 bg-transparent"
                style={{ height: 200 }}
                onLoad={(e) => {
                    try {
                        const f = e.currentTarget as HTMLIFrameElement & { __htmlCardRO?: ResizeObserver };
                        const doc = f.contentDocument;
                        if (!doc || !doc.body) return;
                        // 量內容真實高度並把 iframe 調成等高，避免內部滾動。
                        // 上限放寬到 2400，足夠長卡片完整展開；真正超長的才會兜底滾動。
                        const fit = () => {
                            try {
                                const root = doc.documentElement;
                                const body = doc.body;
                                const natural = Math.max(
                                    body.scrollHeight, body.offsetHeight,
                                    root ? root.scrollHeight : 0,
                                );
                                const h = Math.min(2400, Math.max(60, natural + 4));
                                f.style.height = h + 'px';
                            } catch { /* 同源讀不到時靜默 */ }
                        };
                        fit();
                        // 交互卡片（:checked 展開 / 摺疊）、動畫、字體晚到都會改變高度，
                        // 用 ResizeObserver 持續跟隨，讓高度始終自適應而不是只量一次。
                        f.__htmlCardRO?.disconnect();
                        if (typeof ResizeObserver !== 'undefined') {
                            const ro = new ResizeObserver(() => fit());
                            ro.observe(doc.body);
                            if (doc.documentElement) ro.observe(doc.documentElement);
                            f.__htmlCardRO = ro;
                        }
                    } catch { /* 同源也讀不到時靜默 */ }
                }}
            />
            {/* The source action deliberately lives outside the iframe. Card
                labels, checkboxes, text selection and other embedded gestures
                therefore keep their native long-press behavior. */}
            <div
                className="sully-html-source-bar flex h-8 select-none items-center justify-between overflow-hidden border-t border-slate-300/20 bg-white/25 px-2 text-[10px] text-slate-400 transition-all duration-200 ease-out"
                style={sourceExpanded ? undefined : {
                    height: 20,
                    justifyContent: 'center',
                    borderTopColor: 'transparent',
                    backgroundColor: 'transparent',
                    paddingLeft: 0,
                    paddingRight: 0,
                }}
                onPointerDown={event => event.stopPropagation()}
                onPointerUp={event => event.stopPropagation()}
                onContextMenu={event => event.stopPropagation()}
            >
                <button
                    type="button"
                    onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setSourceExpanded(expanded => !expanded);
                    }}
                    aria-expanded={sourceExpanded}
                    aria-label={sourceExpanded ? '收起 HTML 源碼操作' : '展開 HTML 源碼操作'}
                    title={sourceExpanded ? '收起源碼操作' : '展開源碼操作'}
                    className="sully-html-source-toggle inline-flex h-5 items-center gap-1 rounded-full font-medium text-slate-400/80 transition-all duration-200 hover:bg-slate-500/[0.04] hover:text-slate-400 focus:outline-none focus-visible:bg-slate-500/10 focus-visible:text-slate-500"
                    style={sourceExpanded ? undefined : {
                        gap: 2,
                        paddingLeft: 8,
                        paddingRight: 8,
                        color: 'rgba(148, 163, 184, 0.35)',
                    }}
                >
                    <span
                        className="rounded border border-slate-300/50 px-1 py-px font-mono text-[7px] tracking-[0.14em] text-slate-400/80 transition-all duration-200"
                        style={sourceExpanded ? undefined : { borderWidth: 0, paddingLeft: 0, paddingRight: 0, color: 'inherit' }}
                    >HTML</span>
                    <span
                        className="ml-0.5 max-w-16 overflow-hidden whitespace-nowrap tracking-[0.08em] opacity-100 transition-all duration-200"
                        style={sourceExpanded ? undefined : { marginLeft: 0, maxWidth: 0, opacity: 0 }}
                    >完整源碼</span>
                    <CaretDown
                        size={8}
                        weight="bold"
                        className="shrink-0 transition-transform duration-200"
                        style={{ transform: sourceExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
                    />
                </button>
                <button
                    type="button"
                    onClick={copyHtmlSource}
                    aria-label="複製完整 HTML 源碼"
                    title="複製完整 HTML 源碼"
                    aria-hidden={!sourceExpanded}
                    tabIndex={sourceExpanded ? 0 : -1}
                    className={`sully-html-copy-button inline-flex h-6 max-w-24 items-center gap-1 overflow-hidden whitespace-nowrap rounded-full px-2 font-medium opacity-100 transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300/70 focus-visible:ring-offset-1 active:scale-95 ${
                        copyState === 'ok'
                            ? 'bg-emerald-500/10 text-emerald-600'
                            : copyState === 'error'
                                ? 'bg-rose-500/10 text-rose-500'
                                : 'bg-slate-500/[0.06] text-slate-500/80 hover:bg-slate-500/10 hover:text-slate-600'
                    }`}
                    style={sourceExpanded ? undefined : {
                        maxWidth: 0,
                        paddingLeft: 0,
                        paddingRight: 0,
                        opacity: 0,
                        pointerEvents: 'none',
                    }}
                >
                    {copyState === 'ok' ? <Check size={11} weight="bold" /> : <CopySimple size={11} />}
                    {copyState === 'ok' ? '已複製' : copyState === 'error' ? '複製失敗' : '複製源碼'}
                </button>
            </div>
        </div>
    );
};

export default HtmlCard;
