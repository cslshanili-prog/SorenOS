import React, { useMemo, useState } from 'react';
import { Check, Copy } from '@phosphor-icons/react';
import { copyText, parseSoreText } from '../../utils/assistant/richText';

/** 整支 App 預設不能選字（index.html），Sore 的訊息要能長按選取、複製 */
export const SELECTABLE_TEXT: React.CSSProperties = { userSelect: 'text', WebkitUserSelect: 'text', WebkitTouchCallout: 'default' };

/** 「複製」小鈕：按了變勾勾一下 */
export const CopyButton: React.FC<{ text: string; label: string; className?: string; size?: number; children?: React.ReactNode }> = ({ text, label, className, size = 14, children }) => {
    const [state, setState] = useState<'idle' | 'done' | 'fail'>('idle');
    const run = async () => {
        const ok = await copyText(text);
        setState(ok ? 'done' : 'fail');
        window.setTimeout(() => setState('idle'), 1500);
    };
    return (
        <button type="button" onClick={() => void run()} aria-label={label} className={className}>
            {state === 'done' ? <Check size={size} weight="bold" /> : <Copy size={size} />}
            {children !== undefined && <span>{state === 'done' ? '已複製' : state === 'fail' ? '複製不了，長按選取' : children}</span>}
        </button>
    );
};

/** Sore 回覆的內文：粗體、行內程式碼、程式碼塊（每塊一顆複製鈕）；其他照原樣 */
const SoreMessageText: React.FC<{ text: string }> = ({ text }) => {
    const blocks = useMemo(() => parseSoreText(text), [text]);
    return (
        <div className="space-y-2" style={SELECTABLE_TEXT}>
            {blocks.map((block, i) => (block.type === 'code' ? (
                <div key={i} className="overflow-hidden rounded-xl border border-slate-200 bg-slate-900" data-sore-code>
                    <div className="flex items-center justify-between px-3 py-1.5 text-[11px] text-slate-400" style={{ userSelect: 'none', WebkitUserSelect: 'none' }}>
                        <span className="font-mono">{block.lang || '程式碼'}</span>
                        <CopyButton text={block.code} label="複製這段程式碼" size={13}
                            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-slate-300 hover:bg-white/10 active:scale-95 transition">複製</CopyButton>
                    </div>
                    <pre className="max-h-80 overflow-auto px-3 pb-3 font-mono text-[12px] leading-relaxed text-slate-100" style={SELECTABLE_TEXT}><code>{block.code}</code></pre>
                </div>
            ) : (
                <div key={i} className="whitespace-pre-wrap break-words">
                    {block.spans.map((span, j) => (span.type === 'bold' ? <strong key={j} className="font-bold">{span.text}</strong>
                        : span.type === 'code' ? <code key={j} className={`rounded bg-slate-100 px-1 py-0.5 font-mono text-[12.5px] text-rose-600 ${span.bold ? 'font-bold' : ''}`}>{span.text}</code>
                        : <React.Fragment key={j}>{span.text}</React.Fragment>))}
                </div>
            )))}
        </div>
    );
};

export default SoreMessageText;
