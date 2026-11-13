import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * 多行輸入框＋右上角「⤢ 全螢幕」（plans/library-generate-redesign.md 第 1 節）：
 * 點了蓋滿整個螢幕編輯，「完成」回填；全螢幕裡改的是草稿，按取消不回填。
 * 之後 Soren 其他小編輯框都可以換成它：props 跟 textarea 一樣，多一個 title 給全螢幕頁標題。
 */
const ExpandableTextarea: React.FC<{
    value: string;
    onChange: (value: string) => void;
    /** 全螢幕頁的標題 */
    title: string;
    placeholder?: string;
    rows?: number;
    maxLength?: number;
    className?: string;
    /** 'dark'：深色頁面用（資料庫生圖）；預設淺色 */
    tone?: 'light' | 'dark';
    'aria-label'?: string;
}> = ({ value, onChange, title, placeholder, rows = 3, maxLength, className, tone = 'light', ...rest }) => {
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState(value);
    const ref = useRef<HTMLTextAreaElement>(null);
    useEffect(() => {
        if (!open) return;
        setDraft(value);
        window.setTimeout(() => ref.current?.focus(), 50);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);
    const clip = (v: string) => (maxLength ? v.slice(0, maxLength) : v);
    const dark = tone === 'dark';

    return (
        <div className="relative">
            <textarea
                value={value}
                onChange={e => onChange(clip(e.target.value))}
                placeholder={placeholder}
                rows={rows}
                aria-label={rest['aria-label'] || title}
                className={`${className || ''} pr-9`}
            />
            <button type="button" onClick={() => setOpen(true)} aria-label={`全螢幕編輯：${title}`}
                className={`absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-lg text-[13px] ${dark ? 'bg-black/30 text-white/70' : 'bg-white/80 text-slate-500 shadow-sm'}`}>
                ⤢
            </button>
            {open && createPortal(
                <div role="dialog" aria-label={title} className={`fixed inset-0 z-[200] flex flex-col ${dark ? 'bg-[#17161c] text-white' : 'bg-slate-50 text-slate-800'}`}>
                    <div className={`flex items-center gap-2 px-4 border-b ${dark ? 'border-white/10' : 'border-slate-200'}`} style={{ paddingTop: 'calc(0.75rem + var(--safe-top, 0px))', paddingBottom: '0.75rem' }}>
                        <button type="button" onClick={() => setOpen(false)} className={`px-2 py-1 text-sm ${dark ? 'text-white/60' : 'text-slate-500'}`}>取消</button>
                        <div className="min-w-0 flex-1 truncate text-center text-sm font-bold">{title}</div>
                        <button type="button" onClick={() => { onChange(clip(draft)); setOpen(false); }}
                            className={`rounded-full px-3 py-1 text-sm font-bold ${dark ? 'bg-violet-400 text-[#17161c]' : 'bg-slate-800 text-white'}`}>完成</button>
                    </div>
                    <textarea ref={ref} value={draft} onChange={e => setDraft(clip(e.target.value))} placeholder={placeholder}
                        className={`flex-1 w-full resize-none px-4 py-3 text-[14px] leading-relaxed outline-none ${dark ? 'bg-transparent text-white placeholder:text-white/30' : 'bg-white text-slate-700'}`}
                        style={{ paddingBottom: 'calc(1rem + var(--safe-bottom, 0px))' }} />
                    <div className={`px-4 pb-3 text-right text-[11px] ${dark ? 'text-white/40' : 'text-slate-400'}`} style={{ paddingBottom: 'calc(0.75rem + var(--safe-bottom, 0px))' }}>
                        {draft.length}{maxLength ? ` / ${maxLength}` : ''} 字
                    </div>
                </div>,
                document.body,
            )}
        </div>
    );
};

export default ExpandableTextarea;
