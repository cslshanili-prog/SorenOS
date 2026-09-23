import React, { useState, useEffect, useMemo } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { AppID } from '../types';
import TokenImg from '../components/os/TokenImg';
import RealBalancePanel from '../components/bank/RealBalancePanel';
import { messageLogText } from '../utils/groupChat/format';
import { formatChatListTimestamp } from '../utils/chatListTime';
import { characterLaunch } from '../utils/characterLaunch';
import { chatReturnTarget } from '../utils/chatReturnTarget';
import { trackEvent } from '../utils/analytics';
import { ensureRealBalanceState } from '../utils/realBalance';
import {
    ChatCircleDots, UsersThree, Camera, UserCircle, Plus, MagnifyingGlass,
} from '@phosphor-icons/react';

type HubTab = 'messages' | 'contacts' | 'moments' | 'profile';

interface ChatRow {
    kind: 'private' | 'group';
    id: string;
    name: string;
    avatar: string;
    preview: string;
    timestamp: number;
    unread: number;
}

interface ContactRow {
    id: string;
    name: string;
    avatar: string;
    kind: 'character' | 'npc';
    sub: string;
}

const INDEX_LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')];

/**
 * Chat 主頁：消息/聯繫人/動態/主頁四欄導航殼，取代原本"神經鏈接點角色卡直接開聊天"的入口。
 *
 * 範圍說明（跟用戶對齊過的 v1 切法）：
 * - 消息／聯繫人兩欄是真功能：消息欄聚合私聊+群聊的最近一條消息；聯繫人欄是角色+NPC 的統一通訊錄。
 * - 動態欄直接 openApp(AppID.Social)——現有 SocialApp 1275 行、自成一體（有自己的返回按鈕/多級內部
 *   視圖），不是為嵌入設計的，硬嵌容易把它的"返回"和這裡的 tab 切換繞在一起。所以先用跳轉複用，
 *   不做成真正嵌在同一個底部導航裡的 tab；以後要嵌再單獨做。
 * - 主頁欄是入口面板：用戶身份卡片點進去是「個人檔案」(UserApp，身份卡管理也在那);
 *   Real Balance 已實現（見 utils/realBalance.ts：總餘額 + 銀行卡 + 共用流水，
 *   卡與 Real Balance 之間可互轉）；朋友圈互動／表情包倉儲／外觀CSS 還沒有對應實現，
 *   先給出入口占位 + 提示，不假裝已經做好。
 */
const ChatHub: React.FC = () => {
    const {
        closeApp, openApp, characters, npcs, groups, userProfile, updateUserProfile, unreadMessages,
        setActiveCharacterId, openGroupChat, addToast,
    } = useOS();

    const [tab, setTab] = useState<HubTab>('messages');
    const [showAddMenu, setShowAddMenu] = useState(false);

    // --- 消息 tab ---
    const [rows, setRows] = useState<ChatRow[] | null>(null);
    const [msgFilter, setMsgFilter] = useState<'all' | 'private' | 'group'>('all');
    const [msgQuery, setMsgQuery] = useState('');

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const [privateRows, groupRows] = await Promise.all([
                Promise.all(characters.map(async (c): Promise<ChatRow | null> => {
                    const [msg] = await DB.getRecentMessagesByCharId(c.id, 1, true);
                    if (!msg) return null;
                    return {
                        kind: 'private', id: c.id, name: c.name, avatar: c.avatar,
                        preview: messageLogText(msg), timestamp: msg.timestamp,
                        unread: unreadMessages[c.id] || 0,
                    };
                })),
                Promise.all(groups.map(async (g): Promise<ChatRow | null> => {
                    const { messages } = await DB.getRecentGroupMessagesWithCount(g.id, 1);
                    const msg = messages[0];
                    // 剛建好、還沒人說過話的群不能因為沒有消息就從列表裡消失——不然用戶關掉
                    // 建群后彈出的那個舊版列表，就再也找不回這個空群了（消息 tab 是目前唯一
                    // 能回到具體某個群的入口）。沒消息時用創建時間兜底排序，預覽文案提示"還沒人說話"。
                    return {
                        kind: 'group', id: g.id, name: g.name, avatar: g.avatar || '',
                        preview: msg ? messageLogText(msg) : '還沒有人說話，點擊開始',
                        timestamp: msg ? msg.timestamp : g.createdAt, unread: 0,
                    };
                })),
            ]);
            if (cancelled) return;
            const merged = [...privateRows, ...groupRows].filter((r): r is ChatRow => !!r);
            merged.sort((a, b) => b.timestamp - a.timestamp);
            setRows(merged);
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [characters, groups]);

    const filteredRows = useMemo(() => {
        let list = rows || [];
        if (msgFilter === 'private') list = list.filter(r => r.kind === 'private');
        if (msgFilter === 'group') list = list.filter(r => r.kind === 'group');
        const q = msgQuery.trim().toLowerCase();
        if (q) list = list.filter(r => r.name.toLowerCase().includes(q));
        return list;
    }, [rows, msgFilter, msgQuery]);

    const openRow = (row: ChatRow) => {
        if (row.kind === 'private') {
            setActiveCharacterId(row.id);
            chatReturnTarget.set(AppID.ChatHub);
            openApp(AppID.Chat);
        } else {
            chatReturnTarget.set(AppID.ChatHub);
            openGroupChat(row.id);
        }
        trackEvent('Chat 主页打开对话', { kind: row.kind });
    };

    // --- 聯繫人 tab ---
    const [contactQuery, setContactQuery] = useState('');

    const contactSections = useMemo(() => {
        const q = contactQuery.trim().toLowerCase();
        const items: ContactRow[] = [
            ...characters.map(c => ({ id: c.id, name: c.name, avatar: c.avatar, kind: 'character' as const, sub: c.description || '' })),
            ...npcs.map(n => ({ id: n.id, name: n.name, avatar: n.avatar, kind: 'npc' as const, sub: n.description || '' })),
        ].filter(it => !q || it.name.toLowerCase().includes(q));
        items.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));

        const grouped = new Map<string, ContactRow[]>();
        for (const it of items) {
            const first = it.name.trim()[0] || '';
            const letter = /[a-zA-Z]/.test(first) ? first.toUpperCase() : '#';
            if (!grouped.has(letter)) grouped.set(letter, []);
            grouped.get(letter)!.push(it);
        }
        return INDEX_LETTERS
            .filter(l => grouped.has(l))
            .map(letter => ({ letter, items: grouped.get(letter)! }));
    }, [characters, npcs, contactQuery]);

    const openContact = (item: ContactRow) => {
        if (item.kind === 'character') {
            setActiveCharacterId(item.id);
            chatReturnTarget.set(AppID.ChatHub);
            openApp(AppID.Chat);
        } else {
            // NPC 目前沒有獨立的一對一聊天入口（見 docs/relationship-system.md 的設計約束），
            // 停在神經鏈接的 NPC 分頁，讓用戶自己點進去看/改設定。
            characterLaunch.request({ tab: 'npcs' });
            openApp(AppID.Character);
        }
        trackEvent('Chat 主页打开联系人', { kind: item.kind });
    };

    // --- 動態 tab：直接跳現有 SocialApp（原因見文件頂部說明） ---
    const openMoments = () => {
        openApp(AppID.Social);
        trackEvent('Chat 主页打开动态');
    };

    // --- 主頁 tab：入口占位，未實現的功能明確提示而不是假裝存在 ---
    const notReady = (label: string) => addToast(`${label}規劃中，還沒做好`, 'info');

    // --- Real Balance 錢包（主頁 tab 下的二級頁面，餘額管理頁用共用組件 RealBalancePanel）---
    const [profileView, setProfileView] = useState<'home' | 'balance'>('home');

    // undefined = 還沒打開過；只在真的進「主頁」欄時才生成種子狀態並落庫，不趁用戶沒點開就偷偷建號
    const realBalanceState = useMemo(() => ensureRealBalanceState(userProfile.realBalance), [userProfile.realBalance]);
    useEffect(() => {
        if (tab === 'profile' && !userProfile.realBalance) {
            updateUserProfile({ realBalance: realBalanceState });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tab, userProfile.realBalance]);

    const openBalanceView = () => {
        setProfileView('balance');
        trackEvent('打开 Real Balance 页');
    };

    return (
        <div className="h-full w-full bg-slate-50 flex flex-col animate-fade-in">
            {/* Header */}
            <div className="bg-white/80 backdrop-blur-md border-b border-slate-100 shrink-0 sticky top-0 z-10" style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="flex items-center justify-between px-4 py-3">
                    <div className="flex items-center gap-3">
                        <button onClick={closeApp} className="p-1 -ml-1 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-6 h-6 text-slate-600">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                            </svg>
                        </button>
                        <button onClick={() => { chatReturnTarget.set(AppID.ChatHub); openApp(AppID.User); }} className="flex items-center gap-2.5 active:opacity-70 transition-opacity">
                            <TokenImg value={userProfile.avatar} className="w-9 h-9 rounded-full object-cover bg-slate-100" alt="" />
                            <div className="text-left">
                                <div className="text-sm font-bold text-slate-800 leading-tight">{userProfile.name || '未設置身份'}</div>
                                <div className="flex items-center gap-1 text-[10px] text-slate-400">
                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                                    在線
                                </div>
                            </div>
                        </button>
                    </div>
                    <div className="relative">
                        <button onClick={() => setShowAddMenu(v => !v)} className="p-1.5 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                            <Plus size={22} weight="bold" className="text-slate-600" />
                        </button>
                        {showAddMenu && (
                            <>
                                <div className="fixed inset-0 z-10" onClick={() => setShowAddMenu(false)} />
                                <div className="absolute right-0 top-10 z-20 w-36 bg-white rounded-2xl shadow-xl border border-slate-100 overflow-hidden animate-fade-in">
                                    <button onClick={() => { setShowAddMenu(false); openApp(AppID.Character); }} className="w-full text-left px-4 py-3 text-xs font-semibold text-slate-600 hover:bg-slate-50">新增角色</button>
                                    <button onClick={() => { setShowAddMenu(false); openApp(AppID.GroupChat); }} className="w-full text-left px-4 py-3 text-xs font-semibold text-slate-600 hover:bg-slate-50 border-t border-slate-50">新建群聊</button>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* Body */}
            <div className="flex-1 min-h-0 overflow-y-auto">
                {tab === 'messages' && (
                    <div className="px-5 pt-4 pb-4">
                        <h1 className="text-3xl font-black text-slate-800 mb-4">消息</h1>
                        <div className="relative mb-3">
                            <MagnifyingGlass size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
                            <input
                                value={msgQuery}
                                onChange={e => setMsgQuery(e.target.value)}
                                placeholder="搜索聊天…"
                                className="w-full bg-slate-100 rounded-2xl pl-10 pr-4 py-3 text-sm text-slate-700 outline-none placeholder:text-slate-400"
                            />
                        </div>
                        <div className="flex gap-2 mb-4">
                            {([['all', '全部'], ['private', '私聊'], ['group', '群聊']] as const).map(([key, label]) => (
                                <button
                                    key={key}
                                    onClick={() => setMsgFilter(key)}
                                    className={`px-4 py-1.5 rounded-full text-xs font-bold transition-colors ${msgFilter === key ? 'bg-primary text-white shadow-sm' : 'bg-slate-100 text-slate-400'}`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>

                        {rows === null ? (
                            <div className="py-16 text-center text-xs text-slate-300">加載中…</div>
                        ) : filteredRows.length === 0 ? (
                            <div className="py-16 text-center text-xs text-slate-300">
                                {rows.length === 0 ? '還沒有任何聊天記錄' : '沒有匹配的聊天'}
                            </div>
                        ) : (
                            <div className="space-y-1">
                                {filteredRows.map(row => (
                                    <button
                                        key={`${row.kind}-${row.id}`}
                                        onClick={() => openRow(row)}
                                        className="w-full flex items-center gap-3 px-2 py-2.5 rounded-2xl hover:bg-white active:bg-slate-100 transition-colors text-left"
                                    >
                                        <div className="relative shrink-0">
                                            <TokenImg value={row.avatar} className="w-[52px] h-[52px] rounded-2xl object-cover bg-slate-100" alt="" />
                                            {row.unread > 0 && (
                                                <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold flex items-center justify-center">
                                                    {row.unread > 99 ? '99+' : row.unread}
                                                </span>
                                            )}
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center justify-between gap-2">
                                                <span className="text-[15px] font-bold text-slate-800 truncate">{row.name}</span>
                                                <span className="text-[10px] text-slate-400 shrink-0">{formatChatListTimestamp(row.timestamp)}</span>
                                            </div>
                                            <p className="text-xs text-slate-400 truncate mt-0.5">{row.preview || '暫無內容'}</p>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {tab === 'contacts' && (
                    <div className="px-5 pt-4 pb-4">
                        <h1 className="text-3xl font-black text-slate-800 mb-4">聯繫人</h1>
                        <div className="relative mb-4">
                            <MagnifyingGlass size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
                            <input
                                value={contactQuery}
                                onChange={e => setContactQuery(e.target.value)}
                                placeholder="搜索聯繫人…"
                                className="w-full bg-slate-100 rounded-2xl pl-10 pr-4 py-3 text-sm text-slate-700 outline-none placeholder:text-slate-400"
                            />
                        </div>

                        {contactSections.length === 0 ? (
                            <div className="py-16 text-center text-xs text-slate-300">沒有匹配的聯繫人</div>
                        ) : (
                            <div className="space-y-4">
                                {contactSections.map(section => (
                                    <div key={section.letter}>
                                        <div className="px-2 pb-1 text-[11px] font-bold text-slate-400">{section.letter}</div>
                                        <div className="space-y-1">
                                            {section.items.map(item => (
                                                <button
                                                    key={item.id}
                                                    onClick={() => openContact(item)}
                                                    className="w-full flex items-center gap-3 px-2 py-2.5 rounded-2xl hover:bg-white active:bg-slate-100 transition-colors text-left"
                                                >
                                                    <TokenImg value={item.avatar} className="w-11 h-11 rounded-full object-cover bg-slate-100 shrink-0" alt="" />
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-center gap-1.5">
                                                            <span className="text-sm font-bold text-slate-800 truncate">{item.name}</span>
                                                            {item.kind === 'npc' && (
                                                                <span className="shrink-0 px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-500 text-[9px] font-bold">NPC</span>
                                                            )}
                                                        </div>
                                                        {item.sub && <p className="text-[11px] text-slate-400 truncate mt-0.5">{item.sub}</p>}
                                                    </div>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {tab === 'moments' && (
                    <div className="flex flex-col items-center justify-center h-full px-8 text-center gap-3">
                        <Camera size={40} className="text-slate-300" />
                        <p className="text-sm text-slate-400">動態複用現有的「動態」App，點一下就帶你過去。</p>
                        <button onClick={openMoments} className="px-6 py-2.5 rounded-full bg-primary text-white text-xs font-bold shadow-sm active:scale-95 transition-transform">
                            打開動態
                        </button>
                    </div>
                )}

                {tab === 'profile' && profileView === 'home' && (
                    <div className="px-5 pt-4 pb-8 space-y-4">
                        <button
                            onClick={() => { chatReturnTarget.set(AppID.ChatHub); openApp(AppID.User); }}
                            className="w-full bg-white rounded-[1.75rem] shadow-[0_10px_30px_-12px_rgba(80,70,120,0.18)] border border-slate-100 p-5 flex items-center gap-4 text-left active:scale-[0.99] transition-transform"
                        >
                            <TokenImg value={userProfile.avatar} className="w-16 h-16 rounded-full object-cover bg-slate-100 shrink-0" alt="" />
                            <div className="min-w-0 flex-1">
                                <div className="text-base font-bold text-slate-800 truncate">{userProfile.name || '未設置身份'}</div>
                            </div>
                            <UserCircle size={22} className="text-slate-300 shrink-0" />
                        </button>

                        <button
                            onClick={openBalanceView}
                            className="w-full bg-gradient-to-br from-sky-50 to-blue-50 rounded-[1.75rem] border border-sky-100 p-5 text-left active:scale-[0.99] transition-transform"
                        >
                            <div className="flex items-center justify-between">
                                <div className="text-[10px] font-bold text-sky-400 tracking-widest uppercase">Real Balance</div>
                                <div className="text-[11px] text-sky-500">{realBalanceState.cards.length} 張銀行卡</div>
                            </div>
                            <div className="text-2xl font-black text-slate-800 mt-1">¥{realBalanceState.balance.toFixed(2)}</div>
                            <div className="text-[11px] text-sky-500 mt-2 flex items-center justify-between">
                                <span>餘額管理 · 銀行卡與流水</span>
                                <span className="font-bold">查看 ›</span>
                            </div>
                        </button>

                        <div className="bg-white rounded-[1.75rem] shadow-[0_10px_30px_-12px_rgba(80,70,120,0.18)] border border-slate-100 p-4 grid grid-cols-3 gap-2">
                            {([
                                { label: '朋友圈互動', icon: '📡' },
                                { label: '表情包倉儲', icon: '😊' },
                                { label: '外觀CSS', icon: '🎨' },
                            ]).map(item => (
                                <button
                                    key={item.label}
                                    onClick={() => notReady(item.label)}
                                    className="flex flex-col items-center gap-1.5 py-3 rounded-2xl hover:bg-slate-50 active:scale-95 transition-all"
                                >
                                    <span className="text-2xl">{item.icon}</span>
                                    <span className="text-[10px] font-bold text-slate-500">{item.label}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {tab === 'profile' && profileView === 'balance' && (
                    <RealBalancePanel
                        state={realBalanceState}
                        onCommit={next => updateUserProfile({ realBalance: next })}
                        onBack={() => setProfileView('home')}
                        addToast={addToast}
                    />
                )}
            </div>

            {/* Bottom tab bar */}
            <div className="shrink-0 bg-white/90 backdrop-blur-md border-t border-slate-100 flex" style={{ paddingBottom: 'var(--safe-bottom)' }}>
                {([
                    ['messages', '消息', ChatCircleDots],
                    ['contacts', '聯繫人', UsersThree],
                    ['moments', '動態', Camera],
                    ['profile', '主頁', UserCircle],
                ] as const).map(([key, label, Icon]) => (
                    <button
                        key={key}
                        onClick={() => { setTab(key); trackEvent('切换 Chat 主页标签', { tab: key }); }}
                        className={`flex-1 flex flex-col items-center gap-1 py-2.5 transition-colors ${tab === key ? 'text-primary' : 'text-slate-400'}`}
                    >
                        <Icon size={22} weight={tab === key ? 'fill' : 'regular'} />
                        <span className="text-[10px] font-bold">{label}</span>
                    </button>
                ))}
            </div>

        </div>
    );
};

export default ChatHub;
