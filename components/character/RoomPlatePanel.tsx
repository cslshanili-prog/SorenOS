import React, { useEffect, useRef, useState } from 'react';
import {
    User, MoonStars, HeartStraight, BookOpen,
    House, Buildings, UsersThree, Briefcase, Lightning, Heartbeat,
    Repeat, Smiley, Handshake, GraduationCap, Sparkle, Feather, DotsThree,
    PencilSimple, Trash,
} from '@phosphor-icons/react';
import type { PlateEntry, PlateRoom, RoomPlate } from '../../utils/memoryPalace/types';
import { PLATE_ROOMS, PLATE_TITLES, PLATE_ENTRY_CAPS, PLATE_ENTRY_HARD_MAX_CHARS } from '../../utils/memoryPalace/types';
import { ROOM_PLATES_UPDATED_EVENT, RoomPlateDB, mutatePlate } from '../../utils/memoryPalace/db';

/**
 * 房間門牌面板（神經鏈接 · 底色認知）— 淡紫夢境皮膚
 *
 * 展示四塊門牌的常駐條目。門牌由封盒/消化自動蒸餾維護，這裡只提供
 * 審計入口：查看、改寫、刪除——蒸錯的事實一旦常駐會被自信地重複很久，
 * 必須有人工糾錯的口子。
 */

const ROOM_ICON: Record<PlateRoom, React.ReactNode> = {
    user_room: <User size={22} weight="duotone" />,
    self_room: <MoonStars size={22} weight="duotone" />,
    bedroom:   <HeartStraight size={22} weight="duotone" />,
    study:     <BookOpen size={22} weight="duotone" />,
};

const ROOM_HINT: Record<PlateRoom, string> = {
    user_room: '關於TA的穩定事實：家庭、居住、重要他人、雷區',
    self_room: '角色對自己的穩定認知',
    bedroom:   '關係的質地——只有現象，沒有定義',
    study:     '會什麼、在學什麼',
};

/** tag → 條目小圖標（按包含匹配，兜底 Sparkle） */
const TAG_ICONS: Array<{ match: string[]; icon: React.ReactNode }> = [
    { match: ['家庭', '家人'],           icon: <House size={16} weight="duotone" /> },
    { match: ['居住', '住'],             icon: <Buildings size={16} weight="duotone" /> },
    { match: ['重要他人', '朋友', '人際'], icon: <UsersThree size={16} weight="duotone" /> },
    { match: ['工作', '職'],             icon: <Briefcase size={16} weight="duotone" /> },
    { match: ['雷區', '禁忌'],           icon: <Lightning size={16} weight="duotone" /> },
    { match: ['健康', '身體'],           icon: <Heartbeat size={16} weight="duotone" /> },
    { match: ['習慣', '作息'],           icon: <Repeat size={16} weight="duotone" /> },
    { match: ['性格', '情緒'],           icon: <Smiley size={16} weight="duotone" /> },
    { match: ['約定', '默契'],           icon: <Handshake size={16} weight="duotone" /> },
    { match: ['技能', '學習', '知識'],    icon: <GraduationCap size={16} weight="duotone" /> },
];

function tagIcon(tag?: string): React.ReactNode {
    if (tag) {
        for (const t of TAG_ICONS) {
            if (t.match.some(m => tag.includes(m) || m.includes(tag))) return t.icon;
        }
    }
    return <Sparkle size={16} weight="duotone" />;
}

/** 區塊之間的小裝飾分隔 */
const SectionDivider: React.FC = () => (
    <div className="flex items-center justify-center gap-2 py-1 text-violet-200">
        <Sparkle size={10} weight="fill" />
        <Sparkle size={14} weight="fill" className="text-violet-300" />
        <Sparkle size={10} weight="fill" />
    </div>
);

interface RoomPlatePanelProps {
    charId: string;
    userName?: string;
}

const RoomPlatePanel: React.FC<RoomPlatePanelProps> = ({ charId, userName }) => {
    const [plates, setPlates] = useState<Map<PlateRoom, RoomPlate>>(new Map());
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState<{ room: PlateRoom; entryId: string; draft: string } | null>(null);
    const [menuEntryId, setMenuEntryId] = useState<string | null>(null);
    /** 一句一次性提示（改寫落空之類），顯示在頂部說明卡下面。 */
    const [notice, setNotice] = useState<string | null>(null);

    // 改到一半時雲端整理的結果落庫，重讀會把 plates 整個換掉，而 editing 裡記的還是
    // 換掉之前那條。所以正在編輯就先不重讀，等這次編輯收尾了再補上。
    const editingRef = useRef(false);
    const missedUpdateRef = useRef(false);
    const reloadRef = useRef<(() => void) | null>(null);
    /** 門牌改動的落庫隊列（見 editPlate）。補重讀要排在它後面。 */
    const pendingWriteRef = useRef<Promise<void>>(Promise.resolve());

    useEffect(() => {
        editingRef.current = editing !== null;
        if (editing !== null || !missedUpdateRef.current) return;
        missedUpdateRef.current = false;
        // 收起編輯框這一刻，這次改動多半還沒落庫：commitEdit 是先 setEditing(null) 再異步
        // 寫進去的。直接重讀會跟它搶——重讀拿到的是改之前那份，而它的 setPlates 完全可能
        // 排在落庫那次之後，面板於是停在舊文本上（庫裡明明是新的），要等下一次重讀才好。
        void pendingWriteRef.current.then(() => reloadRef.current?.());
    }, [editing]);

    useEffect(() => {
        let cancelled = false;
        missedUpdateRef.current = false;
        const load = async () => {
            try {
                const loaded = await RoomPlateDB.getByCharId(charId);
                if (!cancelled) {
                    setPlates(new Map(loaded.map(p => [p.room, p])));
                }
            } catch (e) {
                console.warn('[RoomPlatePanel] 加載門牌失敗', e);
            } finally {
                if (!cancelled) setLoading(false);
            }
        };
        reloadRef.current = () => { void load(); };
        void load();

        // 雲端整理跑完一兩分鐘後才把結果落庫，那時這個面板多半正開著。不重讀的話
        // 用戶看到的還是提交前那份，得關掉再打開——看上去就像整理壓根沒跑。
        const onUpdated = (event: Event) => {
            if ((event as CustomEvent<{ charId?: string }>).detail?.charId !== charId) return;
            if (editingRef.current) { missedUpdateRef.current = true; return; }
            void load();
        };
        window.addEventListener(ROOM_PLATES_UPDATED_EVENT, onUpdated);
        return () => {
            cancelled = true;
            reloadRef.current = null;
            window.removeEventListener(ROOM_PLATES_UPDATED_EVENT, onUpdated);
        };
    }, [charId]);

    /**
     * 改門牌一律走 mutatePlate：**從庫裡現讀一份再改**，不拿手上這份整塊寫回去，而且
     * 同一塊門牌上的改動排隊走。
     *
     * 這個面板會開著好幾分鐘，期間動這塊門牌的還有另外三條路（雲端整理結果落地、本地
     * 整理落庫、送達保證兜底併入），它們跟面板互相不知道對方存在。拿渲染時那份改完整塊
     * 存回去，就是把中間那次更新原地抹掉；各自在自己那條路里排隊也不夠——隊伍必須是按
     * 門牌的一條，所有路共用，否則「用戶剛敲的字」和「一整輪整理的成果」誰後寫誰贏，
     * 而兩邊日誌都顯示成功。所以隊列在 db 那一層（見 mutatePlate），這裡只接住結果。
     *
     * `change` 要是純的——只回答「這份門牌該改成什麼樣」，回 null 表示不用改。要往界面上
     * 說句話的，在外面等這個 promise 落定之後再說（見 commitEdit）。
     */
    const editPlate = (
        room: PlateRoom,
        change: (plate: RoomPlate) => RoomPlate | null,
    ): Promise<void> => {
        const run = async () => {
            try {
                const saved = await mutatePlate(charId, room, change);
                if (saved) setPlates(prev => new Map(prev).set(saved.room, saved));
            } catch (e) {
                console.warn('[RoomPlatePanel] 門牌改動沒存上', e);
                setNotice('這次改動沒能存進去，再試一次吧。');
            }
        };
        // 面板自己這條隊還留著，但管的是**界面**而不是落庫：收起編輯框那一刻要等這次
        // 改動落定了再重讀（見上面那個 effect），得有個東西可以等。
        const write = pendingWriteRef.current.then(run, run);
        pendingWriteRef.current = write;
        return write;
    };

    const removeEntry = (room: PlateRoom, entryId: string) => {
        setMenuEntryId(null);
        void editPlate(room, plate => (
            plate.entries.some(e => e.id === entryId)
                ? { ...plate, entries: plate.entries.filter(e => e.id !== entryId), updatedAt: Date.now() }
                : null
        ));
    };

    const commitEdit = () => {
        if (!editing) return;
        const { room, entryId } = editing;
        const text = editing.draft.replace(/\s+/g, ' ').trim().slice(0, PLATE_ENTRY_HARD_MAX_CHARS);
        setEditing(null);
        setNotice(null);
        if (!text) return;
        // 編輯期間這條被整理掉了。默默丟掉的話，用戶敲的字就這麼沒了還不知道；也不能當新
        // 條目補回去——整理剛決定它不該在這塊門牌上。說一句，讓人自己判斷。
        // 只在變換裡做個標記、出來之後再提示：變換要保持是純的，setNotice 塞進去的話，
        // 將來給 editPlate 加一次重試就會彈兩遍，而 null 也會同時表示「不用改」和「去報錯」。
        let vanished = false;
        void editPlate(room, plate => {
            const target = plate.entries.find(e => e.id === entryId);
            if (!target) {
                vanished = true;
                return null;
            }
            if (target.text === text) return null;
            return {
                ...plate,
                entries: plate.entries.map(e => e.id === entryId ? { ...e, text, updatedAt: Date.now() } : e),
                updatedAt: Date.now(),
            };
        }).then(() => {
            if (vanished) setNotice('剛改的那條在編輯期間已經被整理掉了，這次改寫沒有落到門牌上。');
        });
    };

    const fmtDate = (ts: number) => new Date(ts).toLocaleDateString();

    if (loading) {
        return (
            <div className="flex items-center justify-center h-40">
                <div className="w-8 h-8 border-4 border-violet-100 border-t-violet-400 rounded-full animate-spin"></div>
            </div>
        );
    }

    const totalEntries = PLATE_ROOMS.reduce((s, r) => s + (plates.get(r)?.entries.length || 0), 0);

    return (
        <div className="space-y-4 animate-fade-in pb-10">
            {/* 頂部說明卡 */}
            <div className="relative overflow-hidden bg-gradient-to-br from-white via-violet-50/70 to-purple-100/50 p-5 rounded-3xl border border-violet-100/80 shadow-[0_10px_35px_-18px_rgba(139,92,246,0.45)]">
                <Feather size={72} weight="duotone" className="absolute -right-3 -bottom-4 text-violet-200/50 rotate-12 pointer-events-none" />
                <div className="text-[10px] text-violet-300 uppercase tracking-[0.25em] font-bold">Resident Knowledge</div>
                <p className="text-xs text-slate-500 mt-2 leading-relaxed relative z-10">
                    門牌是角色從相處中自己蒸餾出的常駐認知——事件盒封存、認知消化時自動整理，每輪對話都在場。
                </p>
                <p className="text-xs text-violet-400/90 mt-1.5 relative z-10">蒸餾的條目可以在這裡改寫或刪除。</p>
            </div>

            {notice && (
                <div className="flex items-start gap-2 bg-amber-50 border border-amber-100 rounded-2xl px-4 py-3">
                    <p className="flex-1 text-xs text-amber-700 leading-relaxed">{notice}</p>
                    <button onClick={() => setNotice(null)} className="shrink-0 text-[11px] font-bold text-amber-500 px-2 py-0.5">知道了</button>
                </div>
            )}

            {totalEntries === 0 && (
                <div className="text-center py-12 bg-gradient-to-b from-white to-violet-50/50 rounded-3xl border border-dashed border-violet-200">
                    <Sparkle size={28} weight="duotone" className="mx-auto text-violet-300 mb-3" />
                    <p className="text-sm text-slate-400">門牌還是空的</p>
                    <p className="text-xs text-slate-300 mt-2 max-w-xs mx-auto leading-relaxed">
                        繼續相處：事件盒被壓縮/封存、或觸發一次認知消化後，角色會自己把沉澱下來的認知寫上門牌。
                    </p>
                </div>
            )}

            {PLATE_ROOMS.map((room, roomIdx) => {
                const plate = plates.get(room);
                const entries = plate?.entries || [];
                if (entries.length === 0 && totalEntries === 0) return null;
                const title = room === 'user_room' && userName ? `關於${userName}` : PLATE_TITLES[room];
                return (
                    <React.Fragment key={room}>
                        {roomIdx > 0 && totalEntries > 0 && <SectionDivider />}
                        <div className="bg-gradient-to-b from-white to-violet-50/40 rounded-3xl p-5 border border-violet-100/80 shadow-[0_8px_30px_-16px_rgba(139,92,246,0.35)]">
                            {/* 區塊頭：圓形徽章 + 標題 + 容量 */}
                            <div className="flex items-center gap-3 mb-1">
                                <div className="shrink-0 w-11 h-11 rounded-full bg-gradient-to-br from-violet-100 to-purple-200/80 border border-white shadow-inner flex items-center justify-center text-violet-500">
                                    {ROOM_ICON[room]}
                                </div>
                                <div className="min-w-0 flex-1">
                                    <h3 className="text-[15px] font-bold text-slate-700 flex items-center gap-1.5">
                                        {title}
                                        <Sparkle size={11} weight="fill" className="text-violet-300" />
                                    </h3>
                                    <p className="text-[10px] text-slate-400 truncate">{ROOM_HINT[room]}</p>
                                </div>
                                <span className="shrink-0 text-[11px] font-bold text-violet-300">{entries.length}/{PLATE_ENTRY_CAPS[room]}</span>
                            </div>

                            {entries.length === 0 ? (
                                <p className="text-xs text-slate-300 italic mt-3 ml-1">暫無條目</p>
                            ) : (
                                <ul className="space-y-2.5 mt-4">
                                    {entries.map((e: PlateEntry) => (
                                        <li key={e.id} className="bg-white/80 rounded-2xl border border-violet-100/70 shadow-sm">
                                            {editing?.room === room && editing.entryId === e.id ? (
                                                /* 編輯態：羽毛筆 + 取消/保存 */
                                                <div className="p-3">
                                                    <textarea
                                                        value={editing.draft}
                                                        onChange={ev => setEditing({ ...editing, draft: ev.target.value })}
                                                        autoFocus
                                                        rows={2}
                                                        className="w-full bg-white border-2 border-violet-200 rounded-xl px-3 py-2 text-sm text-slate-700 resize-none focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:outline-none"
                                                    />
                                                    <div className="flex items-center justify-between mt-2">
                                                        <Feather size={16} weight="duotone" className="text-violet-300 ml-1" />
                                                        <div className="flex gap-2">
                                                            <button onClick={() => setEditing(null)} className="text-xs font-bold text-slate-400 px-4 py-1.5 rounded-xl bg-violet-50 border border-violet-100">取消</button>
                                                            <button onClick={commitEdit} className="text-xs font-bold text-white px-5 py-1.5 rounded-xl bg-gradient-to-r from-violet-500 to-purple-500 shadow-md shadow-violet-200">保存</button>
                                                        </div>
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="flex items-start gap-2.5 p-3">
                                                    {/* 條目圖標（按 tag 匹配） */}
                                                    <div className="shrink-0 w-8 h-8 rounded-full bg-violet-50 border border-violet-100/80 flex items-center justify-center text-violet-400 mt-0.5">
                                                        {tagIcon(e.tag)}
                                                    </div>
                                                    <div className="min-w-0 flex-1">
                                                        <p
                                                            className="text-sm text-slate-700 leading-relaxed cursor-pointer"
                                                            onClick={() => { setMenuEntryId(null); setEditing({ room, entryId: e.id, draft: e.text }); }}
                                                            title="點擊改寫"
                                                        >
                                                            {e.text}
                                                        </p>
                                                        <p className="text-[10px] text-violet-300/90 mt-1">
                                                            {fmtDate(e.firstLearnedAt)} · 得知{e.sourceCount > 1 ? ` · 印證 ${e.sourceCount} 次` : ''}
                                                        </p>
                                                    </div>
                                                    <div className="shrink-0 flex flex-col items-end gap-1.5">
                                                        {e.tag && (
                                                            <span className="text-[10px] text-violet-500 bg-violet-50 border border-violet-100 rounded-full px-2.5 py-0.5 whitespace-nowrap">
                                                                {e.tag}
                                                            </span>
                                                        )}
                                                        <button
                                                            onClick={() => setMenuEntryId(menuEntryId === e.id ? null : e.id)}
                                                            className="text-violet-300 hover:text-violet-500 p-0.5"
                                                            title="更多操作"
                                                        >
                                                            <DotsThree size={18} weight="bold" />
                                                        </button>
                                                    </div>
                                                </div>
                                            )}
                                            {/* … 展開的操作行 */}
                                            {menuEntryId === e.id && !(editing?.entryId === e.id) && (
                                                <div className="flex justify-end gap-2 px-3 pb-3 -mt-1 animate-fade-in">
                                                    <button
                                                        onClick={() => { setMenuEntryId(null); setEditing({ room, entryId: e.id, draft: e.text }); }}
                                                        className="flex items-center gap-1 text-[11px] font-bold text-violet-500 bg-violet-50 border border-violet-100 rounded-xl px-3 py-1.5"
                                                    >
                                                        <PencilSimple size={12} weight="bold" /> 改寫
                                                    </button>
                                                    <button
                                                        onClick={() => removeEntry(room, e.id)}
                                                        className="flex items-center gap-1 text-[11px] font-bold text-rose-400 bg-rose-50 border border-rose-100 rounded-xl px-3 py-1.5"
                                                    >
                                                        <Trash size={12} weight="bold" /> 刪除
                                                    </button>
                                                </div>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    </React.Fragment>
                );
            })}
        </div>
    );
};

export default RoomPlatePanel;
