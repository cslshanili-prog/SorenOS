import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type NativeProps = Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'title'>;

/**
 * 多行輸入框＋「⤢ 全螢幕」（plans/library-generate-redesign.md 第 1 節、plans/expandable-textarea-rollout.md）：
 * 點了蓋滿整個螢幕編輯，「完成」回填；全螢幕裡改的是草稿，按取消不回填。
 * 其他 textarea 的屬性（onBlur、disabled、spellCheck、style…）照樣傳給原本那個框。
 */
const ExpandableTextarea: React.FC<NativeProps & {
    value: string;
    onChange: (value: string) => void;
    /** 全螢幕頁的標題 */
    title: string;
    /** 'dark'：深色頁面用（資料庫生圖）；預設淺色 */
    tone?: 'light' | 'dark';
    /** 等寬字（CSS、HTML、正則）：全螢幕裡也等寬、不自動校正 */
    mono?: boolean;
    /** 全螢幕按「完成」回填之後再叫一次（失焦才存的框用這個存） */
    onCommit?: (value: string) => void;
    /** ⤢ 放哪個角：右上（預設）或右下（右上角已經有別的按鈕時） */
    buttonCorner?: 'top' | 'bottom';
    /** 外層那個 div 的 class（版面要撐滿時用） */
    wrapperClassName?: string;
}> = ({ value, onChange, title, rows = 3, maxLength, className, tone = 'light', mono, onCommit, buttonCorner = 'top', wrapperClassName, disabled, readOnly, placeholder, ...rest }) => {
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState(value);
    const ref = useRef<HTMLTextAreaElement>(null);
    const locked = !!(disabled || readOnly);
    useEffect(() => {
        if (!open) return;
        setDraft(value);
        if (!locked) window.setTimeout(() => ref.current?.focus(), 50);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);
    const clip = (v: string) => (maxLength ? v.slice(0, maxLength) : v);
    const dark = tone === 'dark';
    const monoProps = mono ? { spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off' } as const : {};
    const done = () => {
        if (!locked) {
            const next = clip(draft);
            onChange(next);
            onCommit?.(next);
        }
        setOpen(false);
    };

    return (
        <div className={`relative ${wrapperClassName || ''}`}>
            <textarea
                {...monoProps}
                {...rest}
                value={value}
                onChange={e => onChange(clip(e.target.value))}
                placeholder={placeholder}
                rows={rows}
                maxLength={maxLength}
                disabled={disabled}
                readOnly={readOnly}
                aria-label={rest['aria-label'] || title}
                className={`${className || ''} pr-9`}
            />
            <button type="button" onClick={() => setOpen(true)} aria-label={`全螢幕${locked ? '查看' : '編輯'}：${title}`}
                className={`absolute right-1.5 ${buttonCorner === 'bottom' ? 'bottom-2' : 'top-1.5'} flex h-7 w-7 items-center justify-center rounded-lg text-[13px] ${dark ? 'bg-black/30 text-white/70' : 'bg-white/80 text-slate-500 shadow-sm'}`}>
                ⤢
            </button>
            {open && createPortal(
                <div role="dialog" aria-label={title} className={`fixed inset-0 z-[10050] flex flex-col ${dark ? 'bg-[#17161c] text-white' : 'bg-slate-50 text-slate-800'}`}>
                    <div className={`flex items-center gap-2 px-4 border-b ${dark ? 'border-white/10' : 'border-slate-200'}`} style={{ paddingTop: 'calc(0.75rem + var(--safe-top, 0px))', paddingBottom: '0.75rem' }}>
                        {!locked && <button type="button" onClick={() => setOpen(false)} className={`px-2 py-1 text-sm ${dark ? 'text-white/60' : 'text-slate-500'}`}>取消</button>}
                        <div className="min-w-0 flex-1 truncate text-center text-sm font-bold">{title}</div>
                        <button type="button" onClick={done}
                            className={`rounded-full px-3 py-1 text-sm font-bold ${dark ? 'bg-violet-400 text-[#17161c]' : 'bg-slate-800 text-white'}`}>{locked ? '關閉' : '完成'}</button>
                    </div>
                    <textarea ref={ref} value={draft} onChange={e => setDraft(clip(e.target.value))} placeholder={placeholder} readOnly={locked}
                        {...monoProps}
                        className={`flex-1 w-full resize-none px-4 py-3 leading-relaxed outline-none ${mono ? 'font-mono text-[12px]' : 'text-[14px]'} ${dark ? 'bg-transparent text-white placeholder:text-white/30' : 'bg-white text-slate-700'}`}
                        style={{ paddingBottom: 'calc(1rem + var(--safe-bottom, 0px))' }} />
                    <div className={`px-4 pb-3 text-right text-[11px] ${dark ? 'text-white/40' : 'text-slate-400'}`} style={{ paddingBottom: 'calc(0.75rem + var(--safe-bottom, 0px))' }}>
                        {locked ? '唯讀・' : ''}{draft.length}{maxLength ? ` / ${maxLength}` : ''} 字
                    </div>
                </div>,
                document.body,
            )}
        </div>
    );
};

export default ExpandableTextarea;
