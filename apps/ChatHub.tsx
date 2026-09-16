import React, { useState, useEffect, useMemo } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { AppID, BankCard } from '../types';
import TokenImg from '../components/os/TokenImg';
import Modal from '../components/os/Modal';
import { messageLogText } from '../utils/groupChat/format';
import { formatChatListTimestamp } from '../utils/chatListTime';
import { characterLaunch } from '../utils/characterLaunch';
import { chatReturnTarget } from '../utils/chatReturnTarget';
import { trackEvent } from '../utils/analytics';
import {
    ensureRealBalanceState, createBankCard, deleteBankCard, transferCardToBalance, transferBalanceToCard,
} from '../utils/realBalance';
import {
    ChatCircleDots, UsersThree, Camera, UserCircle, Plus, MagnifyingGlass,
    CaretLeft, ArrowDown, ArrowUp, Trash, CreditCard,
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
 * Chat 主页：消息/联系人/动态/主页四栏导航壳，取代原本"神经链接点角色卡直接开聊天"的入口。
 *
 * 范围说明（跟用户对齐过的 v1 切法）：
 * - 消息／联系人两栏是真功能：消息栏聚合私聊+群聊的最近一条消息；联系人栏是角色+NPC 的统一通讯录。
 * - 动态栏直接 openApp(AppID.Social)——现有 SocialApp 1275 行、自成一体（有自己的返回按钮/多级内部
 *   视图），不是为嵌入设计的，硬嵌容易把它的"返回"和这里的 tab 切换绕在一起。所以先用跳转复用，
 *   不做成真正嵌在同一个底部导航里的 tab；以后要嵌再单独做。
 * - 主页栏是入口面板：用户身份卡片点进去是「个人档案」(UserApp，身份卡管理也在那);
 *   Real Balance 已实现（见 utils/realBalance.ts：总余额 + 银行卡 + 共用流水，
 *   卡与 Real Balance 之间可互转）；朋友圈互动／表情包仓储／外观CSS 还没有对应实现，
 *   先给出入口占位 + 提示，不假装已经做好。
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
                    // 刚建好、还没人说过话的群不能因为没有消息就从列表里消失——不然用户关掉
                    // 建群后弹出的那个旧版列表，就再也找不回这个空群了（消息 tab 是目前唯一
                    // 能回到具体某个群的入口）。没消息时用创建时间兜底排序，预览文案提示"还没人说话"。
                    return {
                        kind: 'group', id: g.id, name: g.name, avatar: g.avatar || '',
                        preview: msg ? messageLogText(msg) : '还没有人说话，点击开始',
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

    // --- 联系人 tab ---
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
            // NPC 目前没有独立的一对一聊天入口（见 docs/relationship-system.md 的设计约束），
            // 停在神经链接的 NPC 分页，让用户自己点进去看/改设定。
            characterLaunch.request({ tab: 'npcs' });
            openApp(AppID.Character);
        }
        trackEvent('Chat 主页打开联系人', { kind: item.kind });
    };

    // --- 动态 tab：直接跳现有 SocialApp（原因见文件顶部说明） ---
    const openMoments = () => {
        openApp(AppID.Social);
        trackEvent('Chat 主页打开动态');
    };

    // --- 主页 tab：入口占位，未实现的功能明确提示而不是假装存在 ---
    const notReady = (label: string) => addToast(`${label}规划中，还没做好`, 'info');

    // --- Real Balance 钱包（主页 tab 下的二级页面）---
    const [profileView, setProfileView] = useState<'home' | 'balance'>('home');
    const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
    const [showAddCard, setShowAddCard] = useState(false);
    const [newCardName, setNewCardName] = useState('储蓄卡');
    const [newCardLastFour, setNewCardLastFour] = useState('');
    const [newCardBalance, setNewCardBalance] = useState('');
    const [newCardColor, setNewCardColor] = useState<BankCard['color']>('graphite');
    const [transferModal, setTransferModal] = useState<{ mode: 'in' | 'out'; cardId: string } | null>(null);
    const [transferAmount, setTransferAmount] = useState('');
    const [confirmDeleteCardId, setConfirmDeleteCardId] = useState<string | null>(null);

    // undefined = 还没打开过；只在真的进「主页」栏时才生成种子状态并落库，不趁用户没点开就偷偷建号
    const realBalanceState = useMemo(() => ensureRealBalanceState(userProfile.realBalance), [userProfile.realBalance]);
    useEffect(() => {
        if (tab === 'profile' && !userProfile.realBalance) {
            updateUserProfile({ realBalance: realBalanceState });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tab, userProfile.realBalance]);

    const selectedCard = realBalanceState.cards.find(c => c.id === selectedCardId) || null;
    const recentTx = [...realBalanceState.transactions].sort((a, b) => b.timestamp - a.timestamp);

    const openBalanceView = () => {
        setProfileView('balance');
        setSelectedCardId(prev => prev && realBalanceState.cards.some(c => c.id === prev) ? prev : (realBalanceState.cards[0]?.id ?? null));
        trackEvent('打开 Real Balance 页');
    };
    const closeBalanceView = () => { setProfileView('home'); setShowAddCard(false); setTransferModal(null); };

    const commitRealBalance = (next: typeof realBalanceState) => updateUserProfile({ realBalance: next });

    const handleCreateCard = () => {
        const initial = parseFloat(newCardBalance) || 0;
        const next = createBankCard(realBalanceState, { name: newCardName, lastFour: newCardLastFour, initialBalance: initial, color: newCardColor });
        commitRealBalance(next);
        setSelectedCardId(next.cards[next.cards.length - 1].id);
        setShowAddCard(false);
        setNewCardName('储蓄卡'); setNewCardLastFour(''); setNewCardBalance(''); setNewCardColor('graphite');
        addToast('已添加银行卡', 'success');
        trackEvent('新增银行卡');
    };

    const handleDeleteCard = (cardId: string) => {
        const result = deleteBankCard(realBalanceState, cardId);
        setConfirmDeleteCardId(null);
        if (!result.ok) { addToast(result.reason, 'error'); return; }
        commitRealBalance(result.state);
        if (selectedCardId === cardId) setSelectedCardId(result.state.cards[0]?.id ?? null);
        addToast('已删除银行卡', 'success');
        trackEvent('删除银行卡');
    };

    const openTransferModal = (mode: 'in' | 'out', cardId?: string) => {
        const targetCardId = cardId ?? selectedCardId ?? realBalanceState.cards[0]?.id;
        if (!targetCardId) { addToast('还没有银行卡，先新增一张', 'info'); return; }
        setTransferModal({ mode, cardId: targetCardId });
        setTransferAmount('');
    };

    const commitTransfer = () => {
        if (!transferModal) return;
        const amt = parseFloat(transferAmount);
        if (!amt || amt <= 0) { addToast('请输入有效金额', 'error'); return; }
        const result = transferModal.mode === 'in'
            ? transferCardToBalance(realBalanceState, transferModal.cardId, amt)
            : transferBalanceToCard(realBalanceState, transferModal.cardId, amt);
        if (!result.ok) { addToast(result.reason, 'error'); return; }
        commitRealBalance(result.state);
        setTransferModal(null);
        setTransferAmount('');
        addToast(transferModal.mode === 'in' ? '已转入账户' : '已转出账户', 'success');
        trackEvent(transferModal.mode === 'in' ? '银行卡转入账户' : '银行卡转出账户');
    };

    const CARD_STYLES: Record<BankCard['color'], { bg: string; text: string; sub: string }> = {
        gold: { bg: 'linear-gradient(135deg, #2a2320, #171310)', text: '#f3d98b', sub: 'rgba(243,217,139,0.6)' },
        graphite: { bg: 'linear-gradient(135deg, #3a3d42, #1c1e21)', text: '#e4e6ea', sub: 'rgba(228,230,234,0.55)' },
        silver: { bg: 'linear-gradient(135deg, #9ca3af, #6b7280)', text: '#ffffff', sub: 'rgba(255,255,255,0.7)' },
    };
    const CARD_LABELS: Record<BankCard['color'], string> = { gold: '黑金', graphite: '石墨', silver: '银灰' };

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
                                <div className="text-sm font-bold text-slate-800 leading-tight">{userProfile.name || '未设置身份'}</div>
                                <div className="flex items-center gap-1 text-[10px] text-slate-400">
                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                                    在线
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
                            <div className="py-16 text-center text-xs text-slate-300">加载中…</div>
                        ) : filteredRows.length === 0 ? (
                            <div className="py-16 text-center text-xs text-slate-300">
                                {rows.length === 0 ? '还没有任何聊天记录' : '没有匹配的聊天'}
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
                                            <p className="text-xs text-slate-400 truncate mt-0.5">{row.preview || '暂无内容'}</p>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {tab === 'contacts' && (
                    <div className="px-5 pt-4 pb-4">
                        <h1 className="text-3xl font-black text-slate-800 mb-4">联系人</h1>
                        <div className="relative mb-4">
                            <MagnifyingGlass size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
                            <input
                                value={contactQuery}
                                onChange={e => setContactQuery(e.target.value)}
                                placeholder="搜索联系人…"
                                className="w-full bg-slate-100 rounded-2xl pl-10 pr-4 py-3 text-sm text-slate-700 outline-none placeholder:text-slate-400"
                            />
                        </div>

                        {contactSections.length === 0 ? (
                            <div className="py-16 text-center text-xs text-slate-300">没有匹配的联系人</div>
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
                        <p className="text-sm text-slate-400">动态复用现有的「动态」App，点一下就带你过去。</p>
                        <button onClick={openMoments} className="px-6 py-2.5 rounded-full bg-primary text-white text-xs font-bold shadow-sm active:scale-95 transition-transform">
                            打开动态
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
                                <div className="text-base font-bold text-slate-800 truncate">{userProfile.name || '未设置身份'}</div>
                            </div>
                            <UserCircle size={22} className="text-slate-300 shrink-0" />
                        </button>

                        <button
                            onClick={openBalanceView}
                            className="w-full bg-gradient-to-br from-sky-50 to-blue-50 rounded-[1.75rem] border border-sky-100 p-5 text-left active:scale-[0.99] transition-transform"
                        >
                            <div className="flex items-center justify-between">
                                <div className="text-[10px] font-bold text-sky-400 tracking-widest uppercase">Real Balance</div>
                                <div className="text-[11px] text-sky-500">{realBalanceState.cards.length} 张银行卡</div>
                            </div>
                            <div className="text-2xl font-black text-slate-800 mt-1">¥{realBalanceState.balance.toFixed(2)}</div>
                            <div className="text-[11px] text-sky-500 mt-2 flex items-center justify-between">
                                <span>余额管理 · 银行卡与流水</span>
                                <span className="font-bold">查看 ›</span>
                            </div>
                        </button>

                        <div className="bg-white rounded-[1.75rem] shadow-[0_10px_30px_-12px_rgba(80,70,120,0.18)] border border-slate-100 p-4 grid grid-cols-3 gap-2">
                            {([
                                { label: '朋友圈互动', icon: '📡' },
                                { label: '表情包仓储', icon: '😊' },
                                { label: '外观CSS', icon: '🎨' },
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
                    <div className="px-5 pt-4 pb-8 space-y-4">
                        <div className="flex items-center gap-2 -ml-1">
                            <button onClick={closeBalanceView} className="p-1.5 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                                <CaretLeft size={20} className="text-slate-600" />
                            </button>
                            <h1 className="text-lg font-bold text-slate-800">余额管理</h1>
                        </div>

                        {/* Real Balance 总览 */}
                        <div className="bg-gradient-to-br from-sky-50 to-blue-50 rounded-[1.75rem] border border-sky-100 p-5">
                            <div className="flex items-center justify-between">
                                <div className="text-[10px] font-bold text-sky-400 tracking-widest uppercase">Real Balance</div>
                                <div className="text-[11px] text-sky-500">{realBalanceState.cards.length} 张银行卡</div>
                            </div>
                            <div className="text-2xl font-black text-slate-800 mt-1">¥{realBalanceState.balance.toFixed(2)}</div>
                            <div className="text-[11px] text-sky-500 mt-2">红包、转账与余额支付默认使用这里</div>
                            <div className="flex items-center gap-2 mt-3">
                                <button onClick={() => openTransferModal('in')} className="flex-1 py-2 rounded-full bg-white text-sky-600 text-xs font-bold flex items-center justify-center gap-1 active:scale-95 transition-transform border border-sky-100">
                                    <ArrowDown size={14} weight="bold" /> 转入
                                </button>
                                <button onClick={() => openTransferModal('out')} className="flex-1 py-2 rounded-full bg-white text-sky-600 text-xs font-bold flex items-center justify-center gap-1 active:scale-95 transition-transform border border-sky-100">
                                    <ArrowUp size={14} weight="bold" /> 提现
                                </button>
                            </div>
                            <div className="text-[10px] text-sky-400 mt-2">{recentTx.length} 条流水</div>
                        </div>

                        {/* 银行卡横向列表 */}
                        <div>
                            <div className="flex items-center justify-between mb-2 px-0.5">
                                <span className="text-xs font-bold text-slate-700">银行卡</span>
                                <button onClick={() => setShowAddCard(true)} className="text-xs font-bold text-sky-500 flex items-center gap-1">
                                    <Plus size={14} weight="bold" /> 新增卡
                                </button>
                            </div>
                            {realBalanceState.cards.length === 0 ? (
                                <div className="rounded-2xl border border-dashed border-slate-200 py-8 text-center text-xs text-slate-400">
                                    还没有银行卡 · 点右上角新增
                                </div>
                            ) : (
                                <div className="flex gap-3 overflow-x-auto no-scrollbar pb-1 -mx-1 px-1">
                                    {realBalanceState.cards.map(card => {
                                        const style = CARD_STYLES[card.color];
                                        const active = card.id === selectedCardId;
                                        return (
                                            <button
                                                key={card.id}
                                                onClick={() => setSelectedCardId(card.id)}
                                                className="shrink-0 w-56 rounded-2xl p-4 text-left transition-transform active:scale-[0.98]"
                                                style={{ background: style.bg, outline: active ? '2px solid #38bdf8' : 'none', outlineOffset: 2 }}
                                            >
                                                <div className="flex items-center justify-between">
                                                    <div className="flex items-center gap-1.5" style={{ color: style.text }}>
                                                        <CreditCard size={16} weight="fill" />
                                                        <span className="text-[11px] font-bold tracking-wide">CHAT WALLET</span>
                                                    </div>
                                                    <span className="text-[9px] font-bold" style={{ color: style.sub }}>储蓄</span>
                                                </div>
                                                <div className="text-[10px] mt-3 tracking-[0.2em]" style={{ color: style.sub }}>
                                                    **** **** **** {card.lastFour}
                                                </div>
                                                <div className="flex items-end justify-between mt-3">
                                                    <div>
                                                        <div className="text-[8px] uppercase" style={{ color: style.sub }}>{card.name}</div>
                                                        <div className="text-sm font-bold" style={{ color: style.text }}>¥{card.balance.toFixed(2)}</div>
                                                    </div>
                                                    <span className="text-[9px] font-bold" style={{ color: style.sub }}>{CARD_LABELS[card.color]}</span>
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        {/* 选中卡片详情 */}
                        {selectedCard && (
                            <div className="bg-white rounded-[1.75rem] shadow-[0_10px_30px_-12px_rgba(80,70,120,0.18)] border border-slate-100 p-4 space-y-3">
                                <div>
                                    <div className="text-[10px] text-slate-400">当前银行卡余额</div>
                                    <div className="text-xl font-black text-slate-800 mt-0.5">¥{selectedCard.balance.toFixed(2)}</div>
                                    <div className="text-[10px] text-slate-400 mt-0.5">{selectedCard.name} · **** **** **** {selectedCard.lastFour}</div>
                                </div>
                                <div className="flex gap-2">
                                    <button onClick={() => openTransferModal('in', selectedCard.id)} className="flex-1 py-2 rounded-xl bg-emerald-50 text-emerald-600 text-[11px] font-bold flex items-center justify-center gap-1 active:scale-95 transition-transform">
                                        <ArrowDown size={13} weight="bold" /> 转入账户
                                    </button>
                                    <button onClick={() => openTransferModal('out', selectedCard.id)} className="flex-1 py-2 rounded-xl bg-slate-100 text-slate-600 text-[11px] font-bold flex items-center justify-center gap-1 active:scale-95 transition-transform">
                                        <ArrowUp size={13} weight="bold" /> 转出账户
                                    </button>
                                    <button onClick={() => setConfirmDeleteCardId(selectedCard.id)} className="flex-1 py-2 rounded-xl bg-rose-50 text-rose-500 text-[11px] font-bold flex items-center justify-center gap-1 active:scale-95 transition-transform">
                                        <Trash size={13} weight="bold" /> 删除
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* 流水 */}
                        <div className="bg-white rounded-[1.75rem] shadow-[0_10px_30px_-12px_rgba(80,70,120,0.18)] border border-slate-100 p-4">
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-xs font-bold text-slate-700">流水</span>
                                <span className="text-[10px] text-slate-400">余额、银行卡与购物付款实时同步</span>
                            </div>
                            <div className="space-y-2.5">
                                {recentTx.length === 0 && <div className="text-center text-xs text-slate-400 py-4">还没有流水</div>}
                                {recentTx.map(tx => {
                                    const positive = tx.amount >= 0;
                                    return (
                                        <div key={tx.id} className="flex items-center gap-3">
                                            <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${positive ? 'bg-emerald-50 text-emerald-500' : 'bg-rose-50 text-rose-500'}`}>
                                                {positive ? <ArrowDown size={14} weight="bold" /> : <ArrowUp size={14} weight="bold" />}
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <div className="text-xs font-bold text-slate-700 truncate">{tx.label}</div>
                                                <div className="text-[10px] text-slate-400 truncate">
                                                    {new Date(tx.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                                                    {tx.detail ? ` · ${tx.detail}` : ''}
                                                </div>
                                            </div>
                                            <div className="text-right shrink-0">
                                                <div className={`text-xs font-bold ${positive ? 'text-emerald-500' : 'text-rose-500'}`}>
                                                    {positive ? '+' : ''}¥{tx.amount.toFixed(2)}
                                                </div>
                                                <div className="text-[10px] text-slate-400">余 ¥{tx.balanceAfter.toFixed(2)}</div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Bottom tab bar */}
            <div className="shrink-0 bg-white/90 backdrop-blur-md border-t border-slate-100 flex" style={{ paddingBottom: 'var(--safe-bottom)' }}>
                {([
                    ['messages', '消息', ChatCircleDots],
                    ['contacts', '联系人', UsersThree],
                    ['moments', '动态', Camera],
                    ['profile', '主页', UserCircle],
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

            {/* 新增银行卡 */}
            <Modal isOpen={showAddCard} title="新增银行卡" onClose={() => setShowAddCard(false)}
                footer={<button onClick={handleCreateCard} className="w-full py-3 bg-slate-800 text-white font-bold rounded-2xl active:scale-95 transition-transform">添加银行卡</button>}>
                <div className="space-y-4">
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">卡片名称</label>
                        <input value={newCardName} onChange={e => setNewCardName(e.target.value)} placeholder="储蓄卡"
                            className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">尾号</label>
                            <input value={newCardLastFour} onChange={e => setNewCardLastFour(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="0000" inputMode="numeric"
                                className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm" />
                        </div>
                        <div>
                            <div className="flex items-center justify-between mb-1">
                                <label className="text-[10px] font-bold text-slate-400 uppercase">初始余额</label>
                                <span className="text-[9px] text-slate-300">余额不能为负</span>
                            </div>
                            <input value={newCardBalance} onChange={e => setNewCardBalance(e.target.value)} placeholder="0" inputMode="decimal"
                                className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm" />
                        </div>
                    </div>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase block mb-2">卡面配色</label>
                        <div className="flex gap-2">
                            {(['gold', 'graphite', 'silver'] as const).map(color => (
                                <button key={color} onClick={() => setNewCardColor(color)}
                                    className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-colors ${newCardColor === color ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-500'}`}>
                                    {CARD_LABELS[color]}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            </Modal>

            {/* 转入 Real Balance / 提现到银行卡 */}
            <Modal isOpen={!!transferModal} title={transferModal?.mode === 'in' ? '转入 Real Balance' : '提现到银行卡'} onClose={() => setTransferModal(null)}
                footer={<button onClick={commitTransfer} className="w-full py-3 bg-slate-800 text-white font-bold rounded-2xl active:scale-95 transition-transform">确认{transferModal?.mode === 'in' ? '转入' : '提现'}</button>}>
                {transferModal && (() => {
                    const card = realBalanceState.cards.find(c => c.id === transferModal.cardId);
                    return (
                        <div className="space-y-4">
                            <p className="text-xs text-slate-500">
                                {transferModal.mode === 'in'
                                    ? `从「${card?.name || '银行卡'}」转入 Real Balance`
                                    : `从 Real Balance 转出到「${card?.name || '银行卡'}」`}
                            </p>
                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">金额</label>
                                <input value={transferAmount} onChange={e => setTransferAmount(e.target.value)} placeholder="0.00" inputMode="decimal" autoFocus
                                    className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm" />
                            </div>
                            <p className="text-[10px] text-slate-400">
                                {transferModal.mode === 'in'
                                    ? `这张卡当前余额 ¥${(card?.balance ?? 0).toFixed(2)}`
                                    : `Real Balance 当前余额 ¥${realBalanceState.balance.toFixed(2)}`}
                            </p>
                        </div>
                    );
                })()}
            </Modal>

            {/* 删除银行卡确认 */}
            <Modal isOpen={!!confirmDeleteCardId} title="删除这张银行卡？" onClose={() => setConfirmDeleteCardId(null)}
                footer={
                    <div className="flex gap-3 w-full">
                        <button onClick={() => setConfirmDeleteCardId(null)} className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform">取消</button>
                        <button onClick={() => confirmDeleteCardId && handleDeleteCard(confirmDeleteCardId)} className="flex-1 py-3 bg-rose-500 text-white font-bold rounded-2xl active:scale-95 transition-transform">删除</button>
                    </div>
                }>
                <p className="text-xs text-slate-500 leading-relaxed">
                    卡里没有余额才能删除。删除后这张卡的流水记录仍会保留在下面的共用流水里。
                </p>
            </Modal>
        </div>
    );
};

export default ChatHub;
