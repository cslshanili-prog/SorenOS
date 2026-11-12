import React, { useState, useEffect, useMemo } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { AppID, type ChatLine } from '../types';
import TokenImg from '../components/os/TokenImg';
import IdentitySwitcher from '../components/user/IdentitySwitcher';
import UserProfileHome from '../components/user/UserProfileHome';
import MomentsFeed from '../components/moments/MomentsFeed';
import { messageLogText } from '../utils/groupChat/format';
import { formatChatListTimestamp } from '../utils/chatListTime';
import { characterLaunch } from '../utils/characterLaunch';
import { chatReturnTarget } from '../utils/chatReturnTarget';
import { trackEvent } from '../utils/analytics';
import { knowsPersona, lineArgOf, lineFor, lineKey, lineView } from '../utils/chatLine';
import AddFriendPage from '../components/chat/AddFriendPage';
import PairChatPage from '../components/chat/PairChatPage';
import { pairSpeakerOf, parsePairLineId } from '../utils/pairLine';
import { globalPersonaKey, personaAvatarForKey, personaNameForKey, REAL_IDENTITY_PERSONA_ID } from '../utils/userPersona';
import {
    ChatCircleDots, UsersThree, Camera, UserCircle, Plus, MagnifyingGlass,
} from '@phosphor-icons/react';

type HubTab = 'messages' | 'contacts' | 'moments' | 'profile';

interface ChatRow {
    kind: 'private' | 'group' | 'pair';
    /** 角色私聊（kind 'pair'）：另一個角色的頭像，疊在右下角 */
    avatar2?: string;
    id: string;
    /** 關係線：私聊是哪條線（主線不帶 personaKey）；列表鍵與打開時切身份用 */
    line?: ChatLine;
    /** 這條線上的你是哪張卡（「全部身份」時在頭像角落標出來） */
    personaKey?: string;
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

const ALL_PERSONAS_KEY = 'chathub_all_personas_v1';

const INDEX_LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')];

/**
 * Chat 主頁：消息/聯繫人/動態/主頁四欄導航殼，取代原本"神經鏈接點角色卡直接開聊天"的入口。
 *
 * 範圍說明（跟用戶對齊過的 v1 切法）：
 * - 消息／聯繫人兩欄是真功能：消息欄聚合私聊+群聊的最近一條消息；聯繫人欄是角色+NPC 的統一通訊錄。
 * - 動態欄是單一貼文池的用戶視角（components/moments/MomentsFeed，路線圖第 6 項）。舊的沖浪 App
 *   （SocialApp）不再從這裡進，留在桌面當獨立 App。
 * - 主頁欄就是「個人檔案」本體（components/user/UserProfileHome，跟桌面「檔案」App 共用）：
 *   Real Balance、朋友圈互動、分角色與群聊身份、生活記錄都在裡面。
 * - 頁首的頭像＋名字是 IdentitySwitcher，四個分頁共用，下拉切換預設身份／新增身份卡。
 */
const ChatHub: React.FC = () => {
    const {
        closeApp, openApp, characters, npcs, groups, unreadMessages,
        setActiveCharacterId, openGroupChat,
        userProfileBase, personaLinesEnabled, setActivePersonaId, addToast,
    } = useOS();

    // 關係線（plans/persona-line-batch1-2.md）：預覽開著時，私聊照「現在的我」分空間——只列認識這張卡的角色；
    // 「全部身份」把每個角色的每條線都列出來，頭像角落標是哪張卡。關著時照舊一個角色一行。
    const activePersonaKey = globalPersonaKey(userProfileBase);
    const [allPersonas, setAllPersonasState] = useState(() => {
        try { return localStorage.getItem(ALL_PERSONAS_KEY) === '1'; } catch { return false; }
    });
    const setAllPersonas = (v: boolean) => {
        setAllPersonasState(v);
        try { localStorage.setItem(ALL_PERSONAS_KEY, v ? '1' : '0'); } catch { /* 沒有就算了 */ }
    };
    const showAllLines = personaLinesEnabled && allPersonas;
    /** 未讀按線記（鍵是 lineKey：主線就是 charId），這裡加總成每張卡各有幾則 */
    const unreadByPersona = useMemo(() => {
        const out: Record<string, number> = {};
        if (!personaLinesEnabled) return out;
        for (const c of characters) {
            const keys = c.knownPersonaKeys?.length ? c.knownPersonaKeys : (c.primaryPersonaKey ? [c.primaryPersonaKey] : []);
            for (const key of keys) {
                const n = unreadMessages[lineKey(lineFor(c, key))] || 0;
                if (n > 0) out[key] = (out[key] || 0) + n;
            }
        }
        return out;
    }, [characters, unreadMessages, personaLinesEnabled]);

    const [tab, setTab] = useState<HubTab>('messages');
    const [showAddMenu, setShowAddMenu] = useState(false);
    // 加好友（plans/persona-line-batch4.md 第 3 節）：'list' = 先挑人；角色 id = 直接加他
    const [addFriendFor, setAddFriendFor] = useState<string | null>(null);
    const strangerIds = useMemo(() => new Set(personaLinesEnabled
        ? characters.filter(c => !knowsPersona(c, activePersonaKey)).map(c => c.id)
        : []), [characters, personaLinesEnabled, activePersonaKey]);

    // --- 消息 tab ---
    const [rows, setRows] = useState<ChatRow[] | null>(null);
    const [msgFilter, setMsgFilter] = useState<'all' | 'private' | 'group' | 'pair'>('all');
    // 角色私聊（關係線第 6 批 6c）：'new' = 先挑兩個人；線 id = 打開那條線
    const [pairOpen, setPairOpen] = useState<string | null>(null);
    const [rowsVersion, setRowsVersion] = useState(0);
    const [msgQuery, setMsgQuery] = useState('');

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const [privateRows, pairRows, groupRows] = await Promise.all([
                Promise.all(characters.flatMap(c => {
                    // 關掉預覽：一個角色一行（主線）。開著：現在這張卡的那條線，或「全部身份」時每條線一行。
                    const keys = !personaLinesEnabled ? [undefined]
                        : showAllLines ? (c.knownPersonaKeys?.length ? c.knownPersonaKeys : [c.primaryPersonaKey])
                        : (c.knownPersonaKeys || [c.primaryPersonaKey]).includes(activePersonaKey) ? [activePersonaKey] : [];
                    return keys.map(async (key): Promise<ChatRow | null> => {
                        const line = lineFor(c, key);
                        const view = lineView(c, line);
                        const [msg] = await DB.getRecentMessagesByCharId(lineArgOf(view), 1, true);
                        if (!msg) return null;
                        return {
                            kind: 'private', id: c.id, line, personaKey: key || c.primaryPersonaKey,
                            name: view.chatNickname?.trim() || c.name, avatar: c.avatar,
                            preview: messageLogText(msg), timestamp: msg.timestamp,
                            unread: unreadMessages[lineKey(line)] || 0,
                        };
                    });
                })),
                // 角色私聊：只在預覽開著時列（「角色私聊」那個篩選才看得到）
                personaLinesEnabled ? DB.getPairLineIds().then(ids => Promise.all(ids.map(async (pairId): Promise<ChatRow | null> => {
                    const pair = parsePairLineId(pairId);
                    const a = pair && characters.find(c => c.id === pair[0]);
                    const b = pair && characters.find(c => c.id === pair[1]);
                    if (!a || !b) return null;
                    const [msg] = await DB.getRecentMessagesByCharId(pairId, 1, true);
                    if (!msg) return null;
                    const speaker = characters.find(c => c.id === pairSpeakerOf(msg));
                    return {
                        kind: 'pair', id: pairId, name: `${a.name} × ${b.name}`, avatar: a.avatar, avatar2: b.avatar,
                        preview: `${speaker ? `${speaker.name}：` : ''}${messageLogText(msg)}`, timestamp: msg.timestamp, unread: 0,
                    };
                }))).catch(() => [] as Array<ChatRow | null>) : Promise.resolve([] as Array<ChatRow | null>),
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
            const merged = [...privateRows, ...pairRows, ...groupRows].filter((r): r is ChatRow => !!r);
            merged.sort((a, b) => b.timestamp - a.timestamp);
            setRows(merged);
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [characters, groups, personaLinesEnabled, showAllLines, activePersonaKey, rowsVersion]);

    const filteredRows = useMemo(() => {
        let list = rows || [];
        if (msgFilter === 'private') list = list.filter(r => r.kind === 'private');
        if (msgFilter === 'group') list = list.filter(r => r.kind === 'group');
        // 角色私聊是你在旁邊看的，不混進「全部」
        if (msgFilter === 'pair') list = list.filter(r => r.kind === 'pair');
        else list = list.filter(r => r.kind !== 'pair');
        const q = msgQuery.trim().toLowerCase();
        if (q) list = list.filter(r => r.name.toLowerCase().includes(q));
        return list;
    }, [rows, msgFilter, msgQuery]);

    const openRow = async (row: ChatRow) => {
        if (row.kind === 'pair') { setPairOpen(row.id); trackEvent('Chat 主页打开对话', { kind: 'pair' }); return; }
        if (row.kind === 'private') {
            // 點到別張卡的線：先切成那張卡（你在任何時候都是某一個人）
            if (personaLinesEnabled && row.personaKey && row.personaKey !== activePersonaKey) {
                await setActivePersonaId(row.personaKey === REAL_IDENTITY_PERSONA_ID ? undefined : row.personaKey);
                addToast(`已切換成 ${personaNameForKey(userProfileBase, row.personaKey)}`, 'info');
            }
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
            // 小號（關係線第 7 批）加了你好友才會出現在私聊裡，聯繫人不列
            ...characters.filter(c => !c.altOf).map(c => ({ id: c.id, name: c.name, avatar: c.avatar, kind: 'character' as const, sub: c.description || '' })),
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
        // 他還不認識現在這張卡：先加好友，不直接掉進別張卡的那條線
        if (item.kind === 'character' && strangerIds.has(item.id)) {
            setAddFriendFor(item.id);
            return;
        }
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

    return (
        <div className="h-full w-full bg-slate-50 flex flex-col animate-fade-in">
            {addFriendFor && (
                <AddFriendPage
                    char={addFriendFor === 'list' ? null : characters.find(c => c.id === addFriendFor) || null}
                    onClose={() => setAddFriendFor(null)}
                    onAccepted={(charId) => {
                        setAddFriendFor(null);
                        setActiveCharacterId(charId);
                        chatReturnTarget.set(AppID.ChatHub);
                        openApp(AppID.Chat);
                    }}
                />
            )}
            {pairOpen && (
                <PairChatPage
                    pairId={pairOpen === 'new' ? undefined : pairOpen}
                    onClose={() => { setPairOpen(null); setRowsVersion(v => v + 1); }}
                />
            )}
            {/* Header */}
            <div className="bg-white/80 backdrop-blur-md border-b border-slate-100 shrink-0 sticky top-0 z-10" style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="flex items-center justify-between px-4 py-3">
                    <div className="flex items-center gap-3">
                        <button onClick={closeApp} className="p-1 -ml-1 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-6 h-6 text-slate-600">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                            </svg>
                        </button>
                        <IdentitySwitcher
                            lineOptions={personaLinesEnabled ? { all: allPersonas, onAll: setAllPersonas, unreadByKey: unreadByPersona } : undefined}
                        />
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
                                    {personaLinesEnabled && (
                                        <button onClick={() => { setShowAddMenu(false); setAddFriendFor('list'); }} className="w-full text-left px-4 py-3 text-xs font-semibold text-slate-600 hover:bg-slate-50 border-t border-slate-50">加好友</button>
                                    )}
                                    {personaLinesEnabled && (
                                        <button onClick={() => { setShowAddMenu(false); setPairOpen('new'); }} className="w-full text-left px-4 py-3 text-xs font-semibold text-slate-600 hover:bg-slate-50 border-t border-slate-50">讓兩個角色聊聊</button>
                                    )}
                                </div>
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* Body：主頁分頁（個人檔案）自己管捲動和底部的「我的檔案／生活記錄」Tab */}
            {tab === 'profile' && (
                <div className="flex-1 min-h-0">
                    <UserProfileHome />
                </div>
            )}
            <div className={`flex-1 min-h-0 overflow-y-auto ${tab === 'profile' ? 'hidden' : ''}`}>
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
                            {([['all', '全部'], ['private', '私聊'], ['group', '群聊'], ...(personaLinesEnabled ? [['pair', '角色私聊']] as const : [])] as const).map(([key, label]) => (
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
                                        key={`${row.kind}-${row.id}-${row.line?.personaKey || ''}`}
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
                                            {row.kind === 'pair' && row.avatar2 && (
                                                <TokenImg value={row.avatar2} className="absolute -bottom-1 -right-1 w-7 h-7 rounded-xl object-cover bg-slate-200 border-2 border-white" alt="" />
                                            )}
                                            {showAllLines && row.kind === 'private' && row.personaKey && (
                                                <TokenImg
                                                    value={personaAvatarForKey(userProfileBase, row.personaKey)}
                                                    className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full object-cover bg-slate-200 border-2 border-white"
                                                    alt={personaNameForKey(userProfileBase, row.personaKey)}
                                                />
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
                                                            {item.kind === 'character' && strangerIds.has(item.id) && (
                                                                <span className="shrink-0 px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-400 text-[9px] font-bold">還不認識你</span>
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
                    <MomentsFeed emptyHint="還沒有動態。按右上角 ＋ 發第一條，或按 ↻ 讓角色們發幾篇。" />
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
