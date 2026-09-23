import React, { useEffect, useRef, useState } from 'react';
import { CaretDown, Check, PencilSimple, Plus } from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import TokenImg from '../os/TokenImg';
import UserPersonaEditor, { type UserPersonaEditTarget } from './UserPersonaEditor';

/**
 * 頁首的身份切換：頭像＋名字，點開下拉選「目前身份」（真實身份或某張身份卡）、新增或編輯身份卡。
 * 用在個人檔案和 Chat 的四個分頁（消息／聯繫人／動態／主頁）的 header，聊天內頁不用。
 *
 * 這裡切的是**全域預設身份**：已經在「分角色與群聊身份」裡單獨指定過身份的私聊／群聊不跟著換，
 * 下拉選單底部會寫明有幾個，免得用戶以為切了全部。
 */
const IdentitySwitcher: React.FC<{ subtitle?: string }> = ({ subtitle }) => {
    const { userProfile, userProfileBase, setActivePersonaId } = useOS();
    const [open, setOpen] = useState(false);
    const [editing, setEditing] = useState<UserPersonaEditTarget | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);

    // 點外面關掉。不用 fixed 全螢幕遮罩：頁首帶 backdrop-blur，會讓 fixed 子元素只蓋住頁首本身。
    useEffect(() => {
        if (!open) return;
        const onDown = (e: PointerEvent) => {
            if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('pointerdown', onDown, true);
        return () => document.removeEventListener('pointerdown', onDown, true);
    }, [open]);

    const personas = userProfileBase.personas || [];
    const activeId = userProfileBase.activePersonaId;
    const pinnedChats = Object.keys(userProfileBase.perCharPersonaIds || {}).length;
    const pinnedGroups = Object.keys(userProfileBase.perGroupPersonaIds || {}).length;

    const choose = (id: string | undefined) => {
        setActivePersonaId(id);
        setOpen(false);
    };

    const edit = (target: UserPersonaEditTarget) => {
        setOpen(false);
        setEditing(target);
    };

    const rows: { id: string | undefined; name: string; avatar: string; tag: string; editTarget: UserPersonaEditTarget }[] = [
        { id: undefined, name: userProfileBase.name || '真實身份', avatar: userProfileBase.avatar, tag: '真實身份', editTarget: 'real' },
        ...personas.map(p => ({ id: p.id as string | undefined, name: p.name, avatar: p.avatar, tag: '身份卡', editTarget: p.id })),
    ];

    return (
        <div ref={rootRef} className="relative min-w-0">
            <button
                onClick={() => setOpen(v => !v)}
                className="flex items-center gap-2.5 min-w-0 active:opacity-70 transition-opacity"
                aria-haspopup="listbox"
                aria-expanded={open}
            >
                <TokenImg value={userProfile.avatar} className="w-9 h-9 rounded-full object-cover bg-slate-100 shrink-0" alt="" />
                <div className="text-left min-w-0">
                    <div className="flex items-center gap-1">
                        <span className="text-sm font-bold text-slate-800 leading-tight truncate">{userProfile.name || '未設置身份'}</span>
                        <CaretDown size={12} weight="bold" className={`text-slate-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
                    </div>
                    <div className="flex items-center gap-1 text-[10px] text-slate-400">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                        {subtitle ?? '在線'}
                    </div>
                </div>
            </button>

            {open && (
                <>
                    <div className="absolute left-0 top-12 z-40 w-64 bg-white rounded-2xl shadow-xl border border-slate-100 overflow-hidden animate-fade-in" role="listbox">
                        <div className="px-4 pt-3 pb-1.5 text-[10px] font-bold text-slate-400 tracking-widest">切換預設身份</div>
                        <div className="max-h-72 overflow-y-auto">
                            {rows.map(row => {
                                const active = row.id === activeId || (!row.id && !activeId);
                                return (
                                    <div
                                        key={row.id ?? '__real__'}
                                        role="option"
                                        aria-selected={active}
                                        onClick={() => choose(row.id)}
                                        className={`flex items-center gap-2.5 px-4 py-2.5 cursor-pointer transition-colors ${active ? 'bg-primary/5' : 'hover:bg-slate-50'}`}
                                    >
                                        <TokenImg value={row.avatar} className="w-8 h-8 rounded-full object-cover bg-slate-100 shrink-0" alt="" />
                                        <div className="min-w-0 flex-1">
                                            <div className="text-xs font-bold text-slate-700 truncate">{row.name}</div>
                                            <div className="text-[9px] text-slate-400">{row.tag}</div>
                                        </div>
                                        {active && <Check size={14} weight="bold" className="text-primary shrink-0" />}
                                        <button
                                            onClick={e => { e.stopPropagation(); edit(row.editTarget); }}
                                            className="shrink-0 w-7 h-7 rounded-full text-slate-400 hover:bg-slate-100 flex items-center justify-center active:scale-90 transition-transform"
                                            aria-label={`編輯${row.name}`}
                                        >
                                            <PencilSimple size={13} />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                        <button
                            onClick={() => edit('new')}
                            className="w-full flex items-center gap-2 px-4 py-3 border-t border-slate-100 text-xs font-bold text-primary hover:bg-slate-50"
                        >
                            <Plus size={14} weight="bold" />
                            新增身份
                        </button>
                        {(pinnedChats > 0 || pinnedGroups > 0) && (
                            <p className="px-4 py-2.5 border-t border-slate-100 bg-slate-50 text-[10px] leading-relaxed text-slate-400">
                                這裡換的是預設身份。已單獨指定身份的
                                {pinnedChats > 0 && ` ${pinnedChats} 個私聊`}
                                {pinnedChats > 0 && pinnedGroups > 0 && '、'}
                                {pinnedGroups > 0 && ` ${pinnedGroups} 個群聊`}
                                不會跟著換，要改去個人檔案的「分角色與群聊身份」。
                            </p>
                        )}
                    </div>
                </>
            )}

            {editing !== null && <UserPersonaEditor target={editing} onClose={() => setEditing(null)} />}
        </div>
    );
};

export default IdentitySwitcher;
