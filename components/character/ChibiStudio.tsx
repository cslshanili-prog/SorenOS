import React, { useMemo, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { CharacterProfile, ChibiStudioSlotId } from '../../types';
import { CreatorIframe, type ChibiResult, LIKE520_RECORD_KEY, isSullyChar, sullyPresets } from '../Like520Event';
import CreatorPartsUploader from './CreatorPartsUploader';
import { useBlobRefUrl, putImageBlob, dataUrlToBlob, resolveRefToDataUrl } from '../../utils/blobRef';
import TokenImg from '../os/TokenImg';
import { VR_DEFAULT_INTERVAL_MIN } from '../../utils/vrWorld/constants';
import { CaretLeft, CaretRight, PencilSimple, ArrowsClockwise, Sparkle, X, FileArrowUp } from '@phosphor-icons/react';

// ============================================================
// QQ捏人工坊（神經鏈接）—— 手辦展示櫃
//
// 一隻角色在三處有 Q 版形象：小小窩房間立繪（sprites.chibi，blobref）、
// 彼方 chibi（vrState.chibi，dataURL）、特別時光 520 大頭貼
// （specialMomentRecords.like520_2026.customData.charChibi，dataURL）。
// 這裡把三處擺進一個展示櫃：每個展台可單獨捏（互不影響），也可以
// 以某一隻為準一鍵同步到三處。捏人器完整 state 存 char.chibiStudio，
// 再編輯時經 CreatorIframe 的 savedState 整套還原（含換色/翻轉）。
// 圖片本體仍寫各 App 自己的消費字段——本組件不新增渲染路徑。
// ============================================================

// 安全區（與彼方 ChibiEditor / index.html :root 單一來源對齊）：
//  · 全屏浮層頂欄統一用 --chrome-top（安全區 + SullyOS 狀態欄；狀態欄隱藏時自動塌回 --safe-top）。
//    不能只用 --safe-top，否則狀態欄顯示時頂欄會懟進時鐘/電量條。
//  · 底部用 --safe-bottom（帶 JS 探測兜底，iOS 全屏 PWA 原生 env(safe-area-inset-bottom)
//    偶發返回 0）+ 一點手勢餘量，別讓控件貼著 home 條。
const STUDIO_TOP = 'var(--chrome-top)';
const STUDIO_BOTTOM = 'calc(2rem + var(--safe-bottom))';
const STUDIO_SHEET_BOTTOM = 'calc(1.25rem + var(--safe-bottom) + 0.75rem)';

interface SlotMeta {
    id: ChibiStudioSlotId;
    label: string;
    en: string;
    desc: string;
    /** 展台銘牌配色 */
    accent: string;
}

const SLOTS: SlotMeta[] = [
    { id: 'room', label: '小小窩', en: 'ROOM', desc: '站在房間裡的立繪', accent: '#f4a3ca' },
    { id: 'vr', label: '彼方', en: 'VR WORLD', desc: '彼方房間裡的小人', accent: '#8f9bf4' },
    { id: 'like520', label: '特別時光', en: '520 EVENT', desc: '520 活動的大頭貼', accent: '#f4b78f' },
];

const StudioStyle: React.FC = () => (
    <style>{`
        @keyframes chibistudio-float { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
        @keyframes chibistudio-shine { 0% { transform: translateX(-160%) skewX(-18deg); } 100% { transform: translateX(260%) skewX(-18deg); } }
        @keyframes chibistudio-twinkle { 0%,100% { opacity: .25; } 50% { opacity: .9; } }
    `}</style>
);

/** 展台背景星光（固定座標，避免重渲染抖動） */
const CASE_SPARKLES: { top: string; left: string; s: number; d: string }[] = [
    { top: '12%', left: '10%', s: 8, d: '0s' }, { top: '20%', left: '84%', s: 6, d: '.8s' },
    { top: '58%', left: '6%', s: 5, d: '1.4s' }, { top: '40%', left: '90%', s: 7, d: '.4s' },
    { top: '74%', left: '80%', s: 5, d: '1.1s' },
];

interface SlotView {
    meta: SlotMeta;
    /** 原始存儲值（room 可能是 blobref 令牌） */
    raw?: string;
    /** 可渲染 url（objectURL / data / http） */
    url?: string;
    /** 再編輯時還原用的完整捏人器 state */
    state?: any;
    updatedAt?: number;
}

const DisplayCase: React.FC<{
    view: SlotView;
    onEdit: () => void;
    onSync: () => void;
}> = ({ view, onEdit, onSync }) => {
    const { meta, url } = view;
    return (
        <div className="relative rounded-2xl overflow-hidden border border-white/10 shadow-[0_10px_30px_rgba(0,0,0,0.45)]"
            style={{ background: 'linear-gradient(180deg, rgba(58,48,96,0.85) 0%, rgba(28,22,52,0.95) 100%)' }}>
            {/* 頂部射燈 */}
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-40 h-36 pointer-events-none"
                style={{ background: `radial-gradient(60% 100% at 50% 0%, ${meta.accent}33 0%, transparent 70%)` }} />
            {/* 玻璃反光斜帶 */}
            <div className="absolute inset-y-0 w-16 pointer-events-none opacity-[0.07]"
                style={{ background: 'linear-gradient(90deg, transparent, #fff, transparent)', animation: 'chibistudio-shine 5.5s ease-in-out infinite' }} />
            {CASE_SPARKLES.map((sp, i) => (
                <span key={i} className="absolute text-white pointer-events-none select-none"
                    style={{ top: sp.top, left: sp.left, fontSize: sp.s, animation: `chibistudio-twinkle 2.6s ease-in-out ${sp.d} infinite` }}>✦</span>
            ))}

            {/* 手辦本體 */}
            <div className="relative h-44 flex items-end justify-center">
                {url ? (
                    <img src={url} alt={meta.label} className="relative z-10 object-contain mb-5 max-w-[70%]"
                        style={{ height: 128, animation: 'chibistudio-float 3.4s ease-in-out infinite', filter: 'drop-shadow(0 6px 10px rgba(0,0,0,.55))' }} />
                ) : (
                    <div className="relative z-10 mb-8 flex flex-col items-center gap-2 text-indigo-200/40">
                        <div className="w-20 h-24 rounded-xl border-2 border-dashed border-indigo-300/25 flex items-center justify-center">
                            <Sparkle size={22} />
                        </div>
                        <span className="text-[10px] tracking-widest">展台空著</span>
                    </div>
                )}
                {/* 底座：圓盤 + 投影 */}
                <div className="absolute bottom-3 left-1/2 -translate-x-1/2 w-[104px] h-[22px] rounded-[50%]"
                    style={{ background: `linear-gradient(180deg, ${meta.accent}55, rgba(255,255,255,0.08))`, boxShadow: `0 2px 10px ${meta.accent}44 inset, 0 4px 14px rgba(0,0,0,.4)` }} />
                <div className="absolute bottom-[10px] left-1/2 -translate-x-1/2 w-24 h-3 rounded-[50%] bg-black/50 blur-[2px]" />
            </div>

            {/* 銘牌 + 操作 */}
            <div className="relative px-4 pb-3.5 pt-1">
                <div className="flex items-baseline gap-2">
                    <span className="font-serif text-[15px] font-bold text-white tracking-wide">{meta.label}</span>
                    <span className="text-[9px] tracking-[3px] font-medium" style={{ color: meta.accent }}>{meta.en}</span>
                    <span className="ml-auto text-[10px] text-indigo-200/50">{view.updatedAt ? new Date(view.updatedAt).toLocaleDateString() : ''}</span>
                </div>
                <p className="text-[10.5px] text-indigo-200/55 mt-0.5 mb-2.5">{meta.desc}</p>
                <div className="flex gap-2">
                    <button onClick={onEdit}
                        className="flex-1 rounded-lg py-2 text-[11.5px] font-bold text-white flex items-center justify-center gap-1.5 active:scale-95 transition-transform"
                        style={{ background: `linear-gradient(135deg, ${meta.accent}cc, ${meta.accent}88)` }}>
                        <PencilSimple size={13} weight="bold" /> {url ? '重新捏' : '捏這隻'}
                    </button>
                    {url && (
                        <button onClick={onSync}
                            className="flex-1 rounded-lg py-2 text-[11.5px] font-medium text-indigo-100 border border-white/20 flex items-center justify-center gap-1.5 active:bg-white/10 transition-colors">
                            <ArrowsClockwise size={13} weight="bold" /> 同步到全部
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};

/**
 * 「手辦」tab 用的迷你展示櫃：三個槽位橫排預覽 + 進入手辦櫃按鈕。
 * 只讀展示，編輯/同步都在全屏工坊裡做。
 */
export const ChibiShelfPanel: React.FC<{ charId: string; onOpen: () => void }> = ({ charId, onOpen }) => {
    const { characters } = useOS();
    const char = characters.find(c => c.id === charId);
    const studio = char?.chibiStudio;
    const recChibi = char?.specialMomentRecords?.[LIKE520_RECORD_KEY]?.customData?.charChibi as { dataUrl?: string } | undefined;
    const roomUrl = useBlobRefUrl(char?.sprites?.['chibi']);
    const vrUrl = useBlobRefUrl(char?.vrState?.chibi?.img);
    const l5Url = useBlobRefUrl(recChibi?.dataUrl || studio?.like520?.img);
    if (!char) return null;
    const urlOf: Record<ChibiStudioSlotId, string | undefined> = { room: roomUrl, vr: vrUrl, like520: l5Url };
    const dressed = SLOTS.filter(s => !!urlOf[s.id]).length;

    return (
        <div className="animate-fade-in space-y-4">
            <StudioStyle />
            {/* 迷你展示櫃（點整櫃也能進） */}
            <div onClick={onOpen}
                className="relative rounded-3xl overflow-hidden border border-white/10 shadow-[0_10px_30px_rgba(40,30,80,0.35)] cursor-pointer active:scale-[0.99] transition-transform"
                style={{ background: 'linear-gradient(180deg, #2b2150 0%, #171130 100%)' }}>
                <div className="absolute inset-y-0 w-14 pointer-events-none opacity-[0.06]"
                    style={{ background: 'linear-gradient(90deg, transparent, #fff, transparent)', animation: 'chibistudio-shine 5.5s ease-in-out infinite' }} />
                {CASE_SPARKLES.map((sp, i) => (
                    <span key={i} className="absolute text-white pointer-events-none select-none"
                        style={{ top: sp.top, left: sp.left, fontSize: sp.s, animation: `chibistudio-twinkle 2.6s ease-in-out ${sp.d} infinite` }}>✦</span>
                ))}
                <div className="relative px-4 pt-4 pb-1 flex items-baseline gap-2">
                    <span className="font-serif text-[15px] font-bold text-white tracking-wide">QQ捏人 · 手辦櫃</span>
                    <span className="text-[9px] tracking-[3px] text-indigo-300/60 font-medium">FIGURE STUDIO</span>
                    <span className="ml-auto text-[10px] text-indigo-200/50">{dressed}/3 已上架</span>
                </div>
                {/* 三格迷你展台 */}
                <div className="relative grid grid-cols-3 gap-2 px-3 pb-4 pt-1">
                    {SLOTS.map(meta => {
                        const url = urlOf[meta.id];
                        return (
                            <div key={meta.id} className="relative rounded-xl overflow-hidden border border-white/10 bg-white/[0.03]">
                                <div className="absolute top-0 left-1/2 -translate-x-1/2 w-20 h-16 pointer-events-none"
                                    style={{ background: `radial-gradient(60% 100% at 50% 0%, ${meta.accent}30 0%, transparent 70%)` }} />
                                <div className="relative h-[88px] flex items-end justify-center">
                                    {url ? (
                                        <img src={url} alt={meta.label} className="relative z-10 object-contain mb-2.5 max-w-[80%]"
                                            style={{ height: 62, animation: 'chibistudio-float 3.4s ease-in-out infinite', filter: 'drop-shadow(0 3px 6px rgba(0,0,0,.5))' }} />
                                    ) : (
                                        <div className="relative z-10 mb-5 w-9 h-11 rounded-lg border border-dashed border-indigo-300/25 flex items-center justify-center text-indigo-200/35">
                                            <Sparkle size={13} />
                                        </div>
                                    )}
                                    <div className="absolute bottom-1.5 left-1/2 -translate-x-1/2 w-12 h-[9px] rounded-[50%]"
                                        style={{ background: `linear-gradient(180deg, ${meta.accent}50, rgba(255,255,255,0.07))` }} />
                                </div>
                                <div className="relative text-center pb-1.5">
                                    <span className="text-[9.5px] font-bold text-indigo-100/85">{meta.label}</span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            <button onClick={onOpen}
                className="w-full rounded-2xl py-3 text-[13px] font-bold text-white flex items-center justify-center gap-2 shadow-[0_6px_18px_rgba(140,120,200,0.30)] active:scale-[0.98] transition-transform"
                style={{ background: 'linear-gradient(135deg, #a78bda, #8f9bf4)' }}>
                🧸 進入手辦櫃
            </button>
            <p className="text-[10.5px] text-slate-400 leading-relaxed px-1">
                小小窩立繪、彼方小人、特別時光 520 大頭貼——三處 Q 版形象在這裡統一打理：可以各捏各的，也可以挑一隻「同步到全部」。
            </p>
        </div>
    );
};

const ChibiStudio: React.FC<{ charId: string; onClose: () => void }> = ({ charId, onClose }) => {
    const { characters, updateCharacter, addToast } = useOS();
    const char = characters.find(c => c.id === charId);

    const [editing, setEditing] = useState<ChibiStudioSlotId | null>(null);
    const [syncConfirm, setSyncConfirm] = useState<ChibiStudioSlotId | null>(null);
    const [syncing, setSyncing] = useState(false);
    const [showUploader, setShowUploader] = useState(false); // 自定義素材工坊（PSD 批量導入）

    const studio = char?.chibiStudio;
    const rec = char?.specialMomentRecords?.[LIKE520_RECORD_KEY];
    const recChibi = rec?.customData?.charChibi as { dataUrl?: string; state?: any } | undefined;

    const rawOf: Record<ChibiStudioSlotId, string | undefined> = {
        room: char?.sprites?.['chibi'],
        vr: char?.vrState?.chibi?.img,
        like520: recChibi?.dataUrl || studio?.like520?.img,
    };
    // hooks 數量固定（三個槽位常量），條件僅在值上
    const roomUrl = useBlobRefUrl(rawOf.room);
    const vrUrl = useBlobRefUrl(rawOf.vr);
    const l5Url = useBlobRefUrl(rawOf.like520);

    const views: SlotView[] = useMemo(() => {
        if (!char) return [];
        const urlOf: Record<ChibiStudioSlotId, string | undefined> = { room: roomUrl, vr: vrUrl, like520: l5Url };
        const stateOf: Record<ChibiStudioSlotId, any> = {
            room: studio?.room?.state,
            vr: studio?.vr?.state ?? char.vrState?.chibi?.state,
            like520: studio?.like520?.state ?? recChibi?.state,
        };
        return SLOTS.map(meta => ({
            meta,
            raw: rawOf[meta.id],
            url: urlOf[meta.id],
            state: stateOf[meta.id],
            updatedAt: studio?.[meta.id]?.updatedAt,
        }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [char, roomUrl, vrUrl, l5Url]);

    if (!char) return null;
    const isSully = isSullyChar(char);

    // ── 單槽寫回：圖片進各 App 自己的消費字段，state 存 chibiStudio ──
    const confirmSlot = async (slot: ChibiStudioSlotId, r: ChibiResult) => {
        const now = Date.now();
        const slotData = { state: r.state, updatedAt: now };
        try {
            if (slot === 'room') {
                // 小小窩立繪走 blobref（與上傳路徑一致，省配額）
                const ref = await putImageBlob(dataUrlToBlob(r.transparentDataUrl));
                updateCharacter(char.id, prev => ({
                    sprites: { ...(prev.sprites || {}), chibi: ref },
                    chibiStudio: { ...(prev.chibiStudio || {}), room: slotData },
                }));
            } else if (slot === 'vr') {
                updateCharacter(char.id, prev => ({
                    vrState: {
                        ...(prev.vrState || { enabled: false, intervalMinutes: VR_DEFAULT_INTERVAL_MIN }),
                        chibi: {
                            img: r.transparentDataUrl,
                            state: r.state,
                            scale: prev.vrState?.chibi?.scale ?? 1,
                            offsetY: prev.vrState?.chibi?.offsetY ?? 0,
                            flip: prev.vrState?.chibi?.flip ?? false,
                        },
                    },
                    chibiStudio: { ...(prev.chibiStudio || {}), vr: slotData },
                }));
            } else {
                updateCharacter(char.id, prev => {
                    const records = prev.specialMomentRecords || {};
                    const existing = records[LIKE520_RECORD_KEY];
                    const updates: Partial<CharacterProfile> = {
                        chibiStudio: { ...(prev.chibiStudio || {}), like520: { ...slotData, img: r.transparentDataUrl } },
                    };
                    // 已通關 520：把回放記錄裡的大頭貼一併換掉；沒通關則等活動開場自動穿上
                    if (existing?.customData) {
                        updates.specialMomentRecords = {
                            ...records,
                            [LIKE520_RECORD_KEY]: {
                                ...existing,
                                customData: { ...existing.customData, charChibi: { dataUrl: r.transparentDataUrl, state: r.state } },
                            },
                        };
                    }
                    return updates;
                });
            }
            addToast(`${SLOTS.find(s => s.id === slot)?.label}的手辦已上架 ✓`, 'success');
        } catch (e: any) {
            addToast(`保存失敗：${e?.message || e}`, 'error');
        }
        setEditing(null);
    };

    // ── 一鍵同步：以某槽為準，三處形象 + state 全部對齊 ──
    const syncFrom = async (source: ChibiStudioSlotId) => {
        const src = views.find(v => v.meta.id === source);
        if (!src?.raw) return;
        setSyncing(true);
        try {
            // room 槽原始值可能是 blobref，先解析回 dataURL 才能餵給彼方/520（它們直接存 dataURL）
            const dataUrl = src.raw.startsWith('data:') ? src.raw : await resolveRefToDataUrl(src.raw);
            if (!dataUrl.startsWith('data:')) throw new Error('這隻手辦的圖片格式不支持同步');
            const roomRef = source === 'room' ? src.raw : await putImageBlob(dataUrlToBlob(dataUrl));
            const state = src.state;
            const now = Date.now();
            updateCharacter(char.id, prev => {
                const records = prev.specialMomentRecords || {};
                const existing = records[LIKE520_RECORD_KEY];
                return {
                    sprites: { ...(prev.sprites || {}), chibi: roomRef },
                    vrState: {
                        ...(prev.vrState || { enabled: false, intervalMinutes: VR_DEFAULT_INTERVAL_MIN }),
                        chibi: {
                            img: dataUrl,
                            state,
                            scale: prev.vrState?.chibi?.scale ?? 1,
                            offsetY: prev.vrState?.chibi?.offsetY ?? 0,
                            flip: prev.vrState?.chibi?.flip ?? false,
                        },
                    },
                    ...(existing?.customData ? {
                        specialMomentRecords: {
                            ...records,
                            [LIKE520_RECORD_KEY]: {
                                ...existing,
                                customData: { ...existing.customData, charChibi: { dataUrl, state } },
                            },
                        },
                    } : {}),
                    chibiStudio: {
                        room: { state, updatedAt: now },
                        vr: { state, updatedAt: now },
                        like520: { state, img: dataUrl, updatedAt: now },
                    },
                };
            });
            addToast('三處形象已對齊 ✓', 'success');
        } catch (e: any) {
            addToast(`同步失敗：${e?.message || e}`, 'error');
        }
        setSyncing(false);
        setSyncConfirm(null);
    };

    // ── 自定義素材工坊（PSD 批量導入）──
    if (showUploader) {
        return <CreatorPartsUploader onClose={() => setShowUploader(false)} />;
    }

    // ── 捏人器全屏頁 ──
    if (editing) {
        const slotMeta = SLOTS.find(s => s.id === editing)!;
        const slotView = views.find(v => v.meta.id === editing);
        return (
            <div className="fixed inset-0 z-[70] flex flex-col bg-black">
                <div className="flex items-center gap-2 px-4 pb-2 shrink-0 text-white"
                    style={{ background: 'linear-gradient(180deg,#241b3f 0%,#120d24 100%)', paddingTop: STUDIO_TOP }}>
                    <button onClick={() => setEditing(null)} className="p-1.5 -ml-1.5 rounded-full active:bg-white/10"><CaretLeft size={20} weight="bold" /></button>
                    <span className="text-[14px] font-bold">捏 {char.name} 的{slotMeta.label}形象</span>
                </div>
                <div className="flex-1 min-h-0">
                    <CreatorIframe
                        mode="char"
                        charName={char.name}
                        isSully={isSully}
                        presets={isSully ? sullyPresets() : undefined}
                        savedState={slotView?.state}
                        draftKey={`studio_${char.id}_${editing}`}
                        title={`${char.name} · ${slotMeta.label}`}
                        subtitle={`FIGURE STUDIO · ${slotMeta.en}`}
                        onConfirm={r => { void confirmSlot(editing, r); }}
                    />
                </div>
            </div>
        );
    }

    // ── 展示櫃主頁 ──
    return (
        <div className="fixed inset-0 z-[60] flex flex-col" style={{ background: 'linear-gradient(180deg, #241b3f 0%, #171130 55%, #120d24 100%)' }}>
            <StudioStyle />
            {/* 頂欄 */}
            <div className="shrink-0 px-5 pb-3" style={{ paddingTop: STUDIO_TOP }}>
                <div className="flex items-center gap-2 pt-2">
                    <button onClick={onClose} className="p-2 -ml-2 rounded-full text-indigo-100 active:bg-white/10"><CaretLeft size={20} weight="bold" /></button>
                    <div>
                        <h2 className="font-serif text-lg font-bold text-white tracking-wide leading-tight">QQ捏人 · 手辦櫃</h2>
                        <p className="text-[10px] tracking-[3px] text-indigo-300/60">FIGURE STUDIO</p>
                    </div>
                    <div className="ml-auto flex items-center gap-2 rounded-full pl-1 pr-3 py-1 border border-white/15 bg-white/5">
                        <TokenImg value={char.avatar} alt={char.name} className="w-6 h-6 rounded-full object-cover border border-white/30" />
                        <span className="text-[11px] text-indigo-100 font-medium max-w-[80px] truncate">{char.name}</span>
                    </div>
                </div>
                <p className="text-[10.5px] text-indigo-300/55 mt-2 pl-1">
                    同一只角色在三個地方的 Q 版形象——可以各捏各的，也可以挑一隻「同步到全部」。
                </p>
                {/* 自定義素材工坊入口：PSD 批量導入自己的部件（正式站用戶也能用） */}
                <button onClick={() => setShowUploader(true)}
                    className="mt-3 w-full flex items-center gap-2 rounded-xl px-3.5 py-2.5 border border-amber-300/25 active:scale-[0.99] transition-transform"
                    style={{ background: 'linear-gradient(135deg, rgba(251,191,36,0.14), rgba(245,158,11,0.06))' }}>
                    <FileArrowUp size={16} weight="bold" className="text-amber-300 shrink-0" />
                    <span className="text-[12px] font-bold text-amber-100 tracking-wide">上傳自定義素材（PSD 批量導入）</span>
                    <CaretRight size={15} weight="bold" className="ml-auto text-amber-200/50" />
                </button>
            </div>

            {/* 展示櫃（三層展台）——底部給 home 條留白（iOS 全屏 PWA 用 --safe-bottom 兜底） */}
            <div className="flex-1 overflow-y-auto no-scrollbar px-4 space-y-4"
                style={{ paddingBottom: STUDIO_BOTTOM }}>
                {views.map(v => (
                    <DisplayCase key={v.meta.id} view={v}
                        onEdit={() => setEditing(v.meta.id)}
                        onSync={() => setSyncConfirm(v.meta.id)} />
                ))}
                {!rec && (
                    <p className="text-[10px] text-indigo-300/45 text-center px-6 leading-relaxed">
                        「特別時光」這隻捏好後不會立刻出現在活動裡——下次進 520 活動時會自動穿上這套造型。
                    </p>
                )}
            </div>

            {/* 同步確認彈層 */}
            {syncConfirm && (() => {
                const meta = SLOTS.find(s => s.id === syncConfirm)!;
                return (
                    <div className="absolute inset-0 z-10 flex items-end justify-center bg-black/60" onClick={() => !syncing && setSyncConfirm(null)}>
                        <div className="w-full max-w-md rounded-t-2xl p-5 border-t border-white/10"
                            style={{ background: 'linear-gradient(180deg,#2b2150 0%,#171130 100%)', paddingBottom: STUDIO_SHEET_BOTTOM }}
                            onClick={e => e.stopPropagation()}>
                            <div className="flex items-center mb-2">
                                <span className="text-[14px] font-bold text-white">以「{meta.label}」這隻為準？</span>
                                <button onClick={() => !syncing && setSyncConfirm(null)} className="ml-auto p-1 text-indigo-300/60"><X size={18} /></button>
                            </div>
                            <p className="text-[11px] text-indigo-200/60 leading-relaxed mb-4">
                                小小窩、彼方、特別時光三處會全部換成這套造型，另外兩處現在的手辦會被替換掉。
                            </p>
                            <button disabled={syncing} onClick={() => { void syncFrom(syncConfirm); }}
                                className="w-full rounded-xl py-2.5 text-[13px] font-bold text-white active:scale-[0.98] transition-transform disabled:opacity-60"
                                style={{ background: `linear-gradient(135deg, ${meta.accent}dd, ${meta.accent}99)` }}>
                                {syncing ? '同步中…' : '確認同步 ✓'}
                            </button>
                        </div>
                    </div>
                );
            })()}
        </div>
    );
};

export default ChibiStudio;
