import React, { useEffect, useRef, useState } from 'react';
import { CaretDown, Check } from '@phosphor-icons/react';
import type { CharacterProfile } from '../../types';
import { useOS } from '../../context/OSContext';
import { knowsPersona, linePersonaKey } from '../../utils/chatLine';
import { globalPersonaKey, REAL_IDENTITY_PERSONA_ID } from '../../utils/userPersona';
import TokenImg from '../os/TokenImg';

/**
 * 選角色頁上的「現在的我」（關係線，plans/persona-line-batch3.md）：見面、通話這類
 * 先選角色再進去的地方，用它就地換身份，不用回訊息列表切。
 *
 * 換的是全域預設身份（跟訊息列表頁首那顆同一個），選角色清單照舊只列認識現在這張卡的角色。
 * 每張卡旁邊標有幾個角色認識，免得切過去才發現一個人都沒有。只在關係線預覽開著時渲染。
 *
 * 傳 char（神經鏈接這類「已經在某個角色裡」的頁面）：只列這個角色認識的卡，顯示的是這頁正在看的那條線；
 * 角色只認識一張卡時不渲染（沒得切）。
 */
const LinePersonaPicker: React.FC<{
    characters?: CharacterProfile[];
    char?: CharacterProfile;
    label?: string;
    /** 下拉對齊：選角色頁的鈕在中間就置中；靠左擺的（神經鏈接）靠左，免得超出螢幕 */
    align?: 'center' | 'left';
    /** 深色底（通話）用淺色字；淺色底（見面）用深色字 */
    dark?: boolean;
    accent?: string;
    className?: string;
}> = ({ characters = [], char, label = '現在的我', align = 'center', dark, accent = '#8b5cf6', className }) => {
    const { userProfileBase, setActivePersonaId, personaLinesEnabled, activeLineFor } = useOS();
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: PointerEvent) => {
            if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('pointerdown', onDown, true);
        return () => document.removeEventListener('pointerdown', onDown, true);
    }, [open]);

    if (!personaLinesEnabled) return null;

    const current = char ? (linePersonaKey(char, activeLineFor(char)) || globalPersonaKey(userProfileBase)) : globalPersonaKey(userProfileBase);
    const rows = [
        { key: REAL_IDENTITY_PERSONA_ID, name: userProfileBase.name || '真實身份', avatar: userProfileBase.avatar },
        ...(userProfileBase.personas || []).map(p => ({ key: p.id, name: p.name, avatar: p.avatar })),
    ]
        .filter(row => !char || knowsPersona(char, row.key))
        .map(row => ({ ...row, known: characters.filter(c => knowsPersona(c, row.key)).length }));
    if (char && rows.length <= 1) return null;
    const me = rows.find(r => r.key === current) || rows[0];

    const choose = (key: string) => {
        void setActivePersonaId(key === REAL_IDENTITY_PERSONA_ID ? undefined : key);
        setOpen(false);
    };

    const text = dark ? 'text-white/85' : 'text-slate-700';
    const sub = dark ? 'text-white/45' : 'text-slate-400';

    return (
        <div ref={rootRef} className={`relative inline-block ${className || ''}`}>
            <button
                onClick={() => setOpen(v => !v)}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label="切換現在的我"
                className={`flex items-center gap-2 rounded-full pl-1 pr-3 py-1 active:scale-95 transition ${dark ? 'bg-white/[0.08] border border-white/10' : 'bg-white/60 shadow-sm'}`}
            >
                <TokenImg value={me.avatar} className="w-6 h-6 rounded-full object-cover bg-slate-200 shrink-0" alt="" />
                <span className={`text-[11px] ${sub}`}>{label}</span>
                <span className={`text-xs font-bold truncate max-w-[9rem] ${text}`}>{me.name}</span>
                <CaretDown size={11} weight="bold" className={`${sub} shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
            {open && (
                <div role="listbox"
                    className={`absolute ${align === 'left' ? 'left-0' : 'left-1/2 -translate-x-1/2'} top-10 z-40 w-60 rounded-2xl shadow-xl overflow-hidden animate-fade-in ${dark ? 'bg-[#1b1430] border border-white/10' : 'bg-white border border-slate-100'}`}>
                    <div className={`px-4 pt-3 pb-1.5 text-[10px] font-bold tracking-widest ${sub}`}>用哪個身份</div>
                    <div className="max-h-72 overflow-y-auto">
                        {rows.map(row => {
                            const active = row.key === current;
                            return (
                                <div key={row.key} role="option" aria-selected={active} onClick={() => choose(row.key)}
                                    className={`flex items-center gap-2.5 px-4 py-2.5 cursor-pointer transition-colors ${dark ? 'hover:bg-white/[0.05]' : 'hover:bg-slate-50'}`}
                                    style={active ? { background: `${accent}14` } : undefined}>
                                    <TokenImg value={row.avatar} className="w-8 h-8 rounded-full object-cover bg-slate-200 shrink-0" alt="" />
                                    <div className="min-w-0 flex-1">
                                        <div className={`text-xs font-bold truncate ${text}`}>{row.name}</div>
                                        <div className={`text-[9px] ${sub}`}>{char
                                            ? (row.key === char.primaryPersonaKey ? '主線' : '另一條線')
                                            : (row.known > 0 ? `${row.known} 位角色認識` : '還沒有角色認識')}</div>
                                    </div>
                                    {active && <Check size={14} weight="bold" className="shrink-0" style={{ color: accent }} />}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
};

export default LinePersonaPicker;
