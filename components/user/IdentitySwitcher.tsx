import React, { useEffect, useRef, useState } from 'react';
import { CaretDown, Check, PencilSimple, Plus, UsersThree } from '@phosphor-icons/react';
import { REAL_IDENTITY_PERSONA_ID } from '../../utils/userPersona';
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
/**
 * 關係線預覽（plans/persona-line-batch1-2.md）開著時 ChatHub 傳進來：多一個「全部身份」，
 * 每張卡旁邊標它那邊的未讀。不傳就是原本的樣子。
 */
export interface IdentityLineOptions {
    all: boolean;
    onAll: (all: boolean) => void;
    unreadByKey: Record<string, number>;
}

const IdentitySwitcher: React.FC<{ subtitle?: string; lineOptions?: IdentityLineOptions }> = ({ subtitle, lineOptions }) => {
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
    const pinnedWorlds = Object.keys(userProfileBase.perWorldPersonaIds || {}).length;

    const choose = (id: string | undefined) => {
        setActivePersonaId(id);
        lineOptions?.onAll(false);
        setOpen(false);
    };
    const otherUnread = lineOptions
        ? Object.entries(lineOptions.unreadByKey).reduce((sum, [key, n]) => sum + (key === (activeId || REAL_IDENTITY_PERSONA_ID) ? 0 : n), 0)
        : 0;

    const edit = (target: UserPersonaEditTarget) => {
        setOpen(false);
        setEditing(target);
    };

    const rows: { id: string | undefined; name: string; avatar: string; tag: string; editTarget: UserPersonaEditTarget }[] = [
        // 關係線預覽開著：真實身份就是一張普通的卡，不特別標（plans/persona-line-batch1-2.md 2.5）
        { id: undefined, name: userProfileBase.name || '真實身份', avatar: userProfileBase.avatar, tag: lineOptions ? '身份卡' : '真實身份', editTarget: 'real' },
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
                <span className="relative shrink-0">
                    <TokenImg value={userProfile.avatar} className="w-9 h-9 rounded-full object-cover bg-slate-100" alt="" />
                    {otherUnread > 0 && !lineOptions?.all && (
                        <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-rose-500 border-2 border-white" aria-label="別的身份有未讀" />
                    )}
                </span>
                <div className="text-left min-w-0">
                    <div className="flex items-center gap-1">
                        <span className="text-sm font-bold text-slate-800 leading-tight truncate">{userProfile.name || '未設置身份'}</span>
                        <CaretDown size={12} weight="bold" className={`text-slate-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
                    </div>
                    <div className="flex items-center gap-1 text-[10px] text-slate-400">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                        {lineOptions?.all ? '全部身份' : (subtitle ?? '在線')}
                    </div>
                </div>
            </button>

            {open && (
                <>
                    <div className="absolute left-0 top-12 z-40 w-64 bg-white rounded-2xl shadow-xl border border-slate-100 overflow-hidden animate-fade-in" role="listbox">
                        <div className="px-4 pt-3 pb-1.5 text-[10px] font-bold text-slate-400 tracking-widest">{lineOptions ? '現在的我' : '切換預設身份'}</div>
                        <div className="max-h-72 overflow-y-auto">
                            {lineOptions && (
                                <div
                                    role="option"
                                    aria-selected={lineOptions.all}
                                    onClick={() => { lineOptions.onAll(true); setOpen(false); }}
                                    className={`flex items-center gap-2.5 px-4 py-2.5 cursor-pointer transition-colors ${lineOptions.all ? 'bg-primary/5' : 'hover:bg-slate-50'}`}
                                >
                                    <span className="w-8 h-8 rounded-full bg-slate-100 shrink-0 flex items-center justify-center text-slate-400"><UsersThree size={16} /></span>
                                    <div className="min-w-0 flex-1">
                                        <div className="text-xs font-bold text-slate-700 truncate">全部身份</div>
                                        <div className="text-[9px] text-slate-400">每張卡的聊天一起列出來</div>
                                    </div>
                                    {lineOptions.all && <Check size={14} weight="bold" className="text-primary shrink-0" />}
                                </div>
                            )}
                            {rows.map(row => {
                                const active = !lineOptions?.all && (row.id === activeId || (!row.id && !activeId));
                                const unread = lineOptions?.unreadByKey[row.id || REAL_IDENTITY_PERSONA_ID] || 0;
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
                                        {unread > 0 && !active && (
                                            <span className="shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold flex items-center justify-center">{unread > 99 ? '99+' : unread}</span>
                                        )}
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
                        {!lineOptions && (pinnedWorlds > 0 || pinnedChats > 0 || pinnedGroups > 0) && (
                            <p className="px-4 py-2.5 border-t border-slate-100 bg-slate-50 text-[10px] leading-relaxed text-slate-400">
                                這裡換的是預設身份。已單獨指定身份的
                                {[pinnedWorlds > 0 && ` ${pinnedWorlds} 個世界`, pinnedChats > 0 && ` ${pinnedChats} 個私聊`, pinnedGroups > 0 && ` ${pinnedGroups} 個群聊`].filter(Boolean).join('、')}
                                不會跟著換，要改去個人檔案的「分世界、角色與群聊身份」。
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
