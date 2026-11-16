/**
 * 全螢幕「這個聊天的氣泡」（plans/chat-switcher.md）：原本塞在頂端半窗裡的氣泡清單搬出來。
 * 綁著裝扮模板時挑氣泡只換氣泡、模板照舊（ownBubblePatch，plans/decoration-app.md「角色自己的氣泡」）。
 */
import React, { useState } from 'react';
import { CaretLeft, MagnifyingGlass, X } from '@phosphor-icons/react';
import type { CharacterProfile, ChatTheme } from '../../types';
import { PRESET_THEMES } from './ChatConstants';

export interface ChatBubblePickerPageProps {
    charName: string;
    activeThemeId: string;
    customThemes: ChatTheme[];
    characters: CharacterProfile[];
    onPick: (id: string) => void;
    onRemove: (id: string) => void;
    onClose: () => void;
    /** 綁著的模板名字；沒綁不給 */
    templateName?: string;
    /** 自己挑過氣泡時才給：回到模板的氣泡 */
    onFollowTemplate?: () => void;
}

const Sample: React.FC<{ theme: ChatTheme }> = ({ theme }) => (
    <span className="flex flex-col gap-1 w-full">
        <span className="self-start max-w-[85%] truncate px-2.5 py-1 text-[11px]" style={{ background: theme.ai?.backgroundColor || '#fff', color: theme.ai?.textColor || '#334155', borderRadius: Math.min(theme.ai?.borderRadius ?? 14, 16) }}>嗨</span>
        <span className="self-end max-w-[85%] truncate px-2.5 py-1 text-[11px]" style={{ background: theme.user?.backgroundColor || '#6366f1', color: theme.user?.textColor || '#fff', borderRadius: Math.min(theme.user?.borderRadius ?? 14, 16) }}>你好呀</span>
    </span>
);

const ChatBubblePickerPage: React.FC<ChatBubblePickerPageProps> = ({ charName, activeThemeId, customThemes, characters, onPick, onRemove, onClose, templateName, onFollowTemplate }) => {
    const [query, setQuery] = useState('');
    const [pendingDelete, setPendingDelete] = useState<string | null>(null);
    const q = query.trim().toLowerCase();
    const presets = q ? [] : Object.values(PRESET_THEMES);
    const customs = customThemes.filter(t => !q || (t.name || '').toLowerCase().includes(q));

    const card = (t: ChatTheme, custom: boolean) => {
        const inUse = characters.filter(c => c.bubbleStyle === t.id).length;
        const selected = activeThemeId === t.id;
        return (
            <div key={t.id} className={`relative rounded-2xl border p-2.5 ${selected ? 'border-violet-400 bg-violet-50' : 'border-slate-100 bg-white'}`} data-bubble-card={t.name}>
                <button type="button" onClick={() => onPick(t.id)} aria-pressed={selected} className="w-full flex flex-col gap-2 text-left">
                    <span className="rounded-xl bg-slate-50 p-2"><Sample theme={t} /></span>
                    <span className="flex items-center gap-1 min-w-0">
                        <span className="truncate text-[12px] font-bold text-slate-700">{t.name}</span>
                        {selected && <span className="shrink-0 text-[11px] text-violet-500">✓</span>}
                    </span>
                    {custom && inUse > 0 && !selected && <span className="text-[10px] text-slate-400">{inUse} 人在用</span>}
                </button>
                {custom && (pendingDelete === t.id ? (
                    <button type="button" onClick={() => { setPendingDelete(null); onRemove(t.id); }} className="absolute top-1.5 right-1.5 rounded-full bg-red-500 px-2 py-0.5 text-[10px] font-bold text-white">確定刪</button>
                ) : (
                    <button type="button" aria-label={`刪除氣泡 ${t.name}`}
                        onClick={() => { setPendingDelete(t.id); setTimeout(() => setPendingDelete(cur => (cur === t.id ? null : cur)), 3000); }}
                        className="absolute top-1.5 right-1.5 rounded-full px-1.5 text-[13px] leading-none text-slate-300 hover:text-red-400">×</button>
                ))}
            </div>
        );
    };

    return (
        <div className="fixed inset-0 z-[110] flex flex-col bg-slate-50 animate-fade-in" data-bubble-picker onClick={e => e.stopPropagation()}>
            <div className="shrink-0 bg-white/90 backdrop-blur-md border-b border-slate-100" style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="relative flex items-center justify-between px-3 py-3">
                    <button type="button" onClick={onClose} aria-label="返回" className="p-1.5 rounded-full hover:bg-black/5"><CaretLeft size={22} weight="bold" className="text-slate-600" /></button>
                    <h1 className="absolute left-1/2 -translate-x-1/2 max-w-[60%] truncate text-base font-bold text-slate-800">{charName}的氣泡</h1>
                    <span className="w-8" />
                </div>
                <div className="px-4 pb-3">
                    <label className="flex items-center gap-2 rounded-2xl bg-slate-100 px-3 py-2">
                        <MagnifyingGlass size={16} className="text-slate-400 shrink-0" />
                        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="找我的氣泡" aria-label="搜尋氣泡"
                            className="min-w-0 flex-1 bg-transparent text-[14px] text-slate-700 outline-none placeholder:text-slate-400" />
                        {query && <button type="button" onClick={() => setQuery('')} aria-label="清掉搜尋" className="text-slate-400"><X size={14} /></button>}
                    </label>
                </div>
            </div>
            <div className="flex-1 overflow-y-auto no-scrollbar px-4 py-4 space-y-4" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 24px)' }}>
                {templateName && (
                    <div className="flex items-center justify-between gap-3 rounded-2xl bg-white border border-slate-100 px-4 py-3" data-bubble-template-note>
                        <span className="text-[12px] text-slate-500 leading-snug">
                            {onFollowTemplate ? `穿自己挑的氣泡，模板「${templateName}」的其他部分照舊。` : `跟著模板「${templateName}」。在這裡換氣泡只換氣泡，模板照舊。`}
                        </span>
                        {onFollowTemplate && <button type="button" onClick={onFollowTemplate} className="shrink-0 rounded-full bg-violet-50 border border-violet-100 px-3 py-1 text-[12px] font-bold text-violet-600">跟著模板</button>}
                    </div>
                )}
                {presets.length > 0 && (
                    <section>
                        <h2 className="mb-2 px-1 text-[12px] font-bold text-slate-400">內建</h2>
                        <div className="grid grid-cols-3 gap-2">{presets.map(t => card(t, false))}</div>
                    </section>
                )}
                <section>
                    <h2 className="mb-2 px-1 text-[12px] font-bold text-slate-400">我的氣泡</h2>
                    {customs.length > 0
                        ? <div className="grid grid-cols-3 gap-2">{customs.map(t => card(t, true))}</div>
                        : <p className="px-1 text-[12px] text-slate-400">{q ? `沒有叫「${query.trim()}」的氣泡` : '還沒有自己做的氣泡'}</p>}
                </section>
                <p className="px-1 text-[11px] text-slate-400">新氣泡去桌面的「裝扮」App 做。</p>
            </div>
        </div>
    );
};

export default ChatBubblePickerPage;
