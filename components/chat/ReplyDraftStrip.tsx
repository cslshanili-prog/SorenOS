import React from 'react';
import { ArrowsClockwise, Lightbulb } from '@phosphor-icons/react';

export interface ReplyDraftState {
    loading: boolean;
    drafts: string[];
    error?: string;
}

interface Props {
    state: ReplyDraftState;
    shellClass: string;
    tone: 'light' | 'dark' | 'pixel';
    onPick: (text: string) => void;
    onRefresh: () => void;
    onClose: () => void;
}

/**
 * 「AI 幫我回覆」的草稿條（見 utils/replyDrafts.ts）：掛在輸入欄上方、表情聯想的同一個位置，
 * 不進輸入欄本體，免得動到社區 CSS 的選擇器。點一個草稿就放進輸入框。
 */
const ReplyDraftStrip = React.forwardRef<HTMLDivElement, Props>(({ state, shellClass, tone, onPick, onRefresh, onClose }, ref) => {
    const text = tone === 'dark' ? 'border-white/10 bg-slate-900 text-slate-300' : tone === 'pixel' ? 'border-[#8f674a]/20 text-[#8f674a]' : 'border-slate-100 text-slate-500';
    const card = tone === 'dark' ? 'bg-slate-800 text-slate-100 border-white/10' : tone === 'pixel' ? 'bg-[#fff7ed] text-[#5b4636] border-[#8f674a]/20' : 'bg-white text-slate-700 border-slate-200/70';
    return (
        <div ref={ref} role="region" aria-label="回覆草稿"
            className={`sully-chat-reply-drafts shrink-0 relative z-40 border-b px-4 pb-3 pt-2 ${shellClass} ${text}`}>
            <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1 text-[11px] font-bold"><Lightbulb size={13} weight="fill" /> 靈感提示 · 點一個放進輸入框</span>
                <div className="-mr-2 flex items-center">
                    <button type="button" aria-label="換一批草稿" disabled={state.loading} onMouseDown={e => e.preventDefault()} onClick={onRefresh}
                        className="flex h-8 items-center gap-1 rounded-full px-2 text-[11px] font-bold hover:bg-slate-400/10 disabled:opacity-40">
                        <ArrowsClockwise size={13} weight="bold" className={state.loading ? 'animate-spin' : ''} /> 換一批
                    </button>
                    <button type="button" aria-label="收起回覆草稿" onClick={onClose}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-base hover:bg-slate-400/10">×</button>
                </div>
            </div>
            <div className="mt-1 flex max-h-[40vh] flex-col gap-2 overflow-y-auto overscroll-contain">
                {state.loading && !state.drafts.length && [0, 1, 2].map(i => (
                    <div key={i} className={`h-11 animate-pulse rounded-2xl border ${card} opacity-60`} />
                ))}
                {state.error && !state.loading && (
                    <div className="rounded-2xl px-3 py-2 text-[12px] text-rose-500">{state.error}</div>
                )}
                {state.drafts.map((draft, i) => (
                    <button key={`${i}-${draft}`} type="button" disabled={state.loading}
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => onPick(draft)}
                        className={`rounded-2xl border px-4 py-2.5 text-left text-[14px] leading-relaxed shadow-sm active:scale-[0.98] transition-transform motion-reduce:transition-none ${card} ${state.loading ? 'opacity-50' : ''}`}>
                        {draft}
                    </button>
                ))}
            </div>
        </div>
    );
});
ReplyDraftStrip.displayName = 'ReplyDraftStrip';

export default ReplyDraftStrip;
