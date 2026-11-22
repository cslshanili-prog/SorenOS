import React, { useMemo, useRef, useState } from 'react';
import { ArrowsClockwise, CaretLeft, Sparkle } from '@phosphor-icons/react';
import type { APIConfig, CharacterProfile } from '../../types';
import TokenImg from '../os/TokenImg';
import { ROLE_TITLE_MAX_LENGTH, charAliases, charRoleTitle } from '../../utils/charIdentity';
import {
    IDENTITY_BATCH_CONCURRENCY, batchFillCandidates, defaultBatchPicks, draftFromFill, generateIdentityFill,
    hasIdentityFillSource, needsIdentityFill, patchFromDraft, runLimited, type IdentityBatchDraft,
} from '../../utils/charIdentityFill';

type IdentityPatch = Partial<Pick<CharacterProfile, 'aliases' | 'roleTitle' | 'description'>>;
type RowState =
    | { status: 'waiting' | 'running' }
    | { status: 'done'; draft: IdentityBatchDraft; dropped?: boolean }
    | { status: 'failed'; error: string };

interface Props {
    characters: CharacterProfile[];
    /** 用哪組 API：副 API 有設就用，不然全域（跟角色頁那顆「AI 幫我填」一樣） */
    api: Pick<APIConfig, 'baseUrl' | 'apiKey' | 'model'>;
    onSave: (id: string, patch: IdentityPatch) => void | Promise<void>;
    onClose: () => void;
    addToast: (msg: string, type: 'info' | 'success' | 'error') => void;
}

const FIELD = 'w-full rounded-xl bg-slate-50 px-3 py-2 text-[13px] text-slate-700 outline-none placeholder:text-slate-400 focus:bg-white focus:ring-1 focus:ring-primary/20';
const LABEL = 'mb-1 block text-[11px] font-bold text-slate-500';

/**
 * 批次補別名與身份（plans/character-identity-fields.md 3.6）：角色多的人不用一個個進角色頁按「AI 幫我填」。
 * 三步：勾角色 → 一起讀人設 → 逐個看結果、可以改、可以不要，最後一次存。存之前什麼都不會寫進角色。
 */
const IdentityBatchFillPage: React.FC<Props> = ({ characters, api, onSave, onClose, addToast }) => {
    const pool = useMemo(() => batchFillCandidates(characters), [characters]);
    const [picked, setPicked] = useState<Set<string>>(() => new Set(defaultBatchPicks(characters)));
    const [onlyEmpty, setOnlyEmpty] = useState(true);
    const [phase, setPhase] = useState<'pick' | 'running' | 'review'>('pick');
    const [rows, setRows] = useState<Record<string, RowState>>({});
    const [order, setOrder] = useState<string[]>([]);
    const [saving, setSaving] = useState(false);
    const [confirmLeave, setConfirmLeave] = useState(false);
    const abortRef = useRef<AbortController | null>(null);

    const byId = useMemo(() => new Map(pool.map(c => [c.id, c])), [pool]);
    const emptyCount = pool.filter(needsIdentityFill).length;
    const listed = onlyEmpty ? pool.filter(c => needsIdentityFill(c) || picked.has(c.id)) : pool;
    const pickable = (c: CharacterProfile) => hasIdentityFillSource(c);
    const toggle = (id: string) => setPicked(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
    const setRow = (id: string, state: RowState) => setRows(prev => ({ ...prev, [id]: state }));

    const readOne = async (id: string, signal: AbortSignal) => {
        const char = byId.get(id);
        if (!char) return;
        setRow(id, { status: 'running' });
        try {
            const fill = await generateIdentityFill(char, api, signal);
            setRow(id, { status: 'done', draft: draftFromFill(char, fill) });
        } catch (e: any) {
            // 按了停：沒讀完的那幾個不算失敗，退回等待
            if (signal.aborted) { setRow(id, { status: 'waiting' }); return; }
            setRow(id, { status: 'failed', error: e?.message || '沒讀成功' });
        }
    };

    const start = async () => {
        const ids = pool.filter(c => picked.has(c.id) && pickable(c)).map(c => c.id);
        if (!ids.length) { addToast('先勾幾個角色', 'info'); return; }
        const controller = new AbortController();
        abortRef.current = controller;
        setOrder(ids);
        setRows(Object.fromEntries(ids.map(id => [id, { status: 'waiting' } as RowState])));
        setPhase('running');
        await runLimited(ids, IDENTITY_BATCH_CONCURRENCY, id => readOne(id, controller.signal), controller.signal);
        if (abortRef.current === controller) abortRef.current = null;
        setPhase('review');
    };

    const retry = async (id: string) => {
        const controller = new AbortController();
        await readOne(id, controller.signal);
    };

    const doneIds = order.filter(id => rows[id]?.status === 'done');
    const keepIds = doneIds.filter(id => { const r = rows[id]; return r?.status === 'done' && !r.dropped; });
    const finished = order.filter(id => rows[id]?.status === 'done' || rows[id]?.status === 'failed').length;
    const patchDraft = (id: string, patch: Partial<IdentityBatchDraft>) => setRows(prev => {
        const r = prev[id];
        return r?.status === 'done' ? { ...prev, [id]: { ...r, draft: { ...r.draft, ...patch } } } : prev;
    });

    const saveAll = async () => {
        if (saving) return;
        setSaving(true);
        let written = 0;
        try {
            for (const id of keepIds) {
                const char = byId.get(id);
                const r = rows[id];
                if (!char || r?.status !== 'done') continue;
                const patch = patchFromDraft(char, r.draft);
                if (!patch) continue;
                await onSave(id, patch);
                written++;
            }
            addToast(written ? `存好了，改了 ${written} 個角色` : '沒有要改的', written ? 'success' : 'info');
            onClose();
        } catch (e: any) {
            addToast(e?.message || '存的時候出錯，已經存的那幾個不受影響', 'error');
        } finally {
            setSaving(false);
        }
    };

    const back = () => {
        if (phase === 'running') { abortRef.current?.abort(); return; }
        if (phase === 'review' && doneIds.length) { setConfirmLeave(true); return; }
        onClose();
    };

    return (
        <div className="fixed inset-0 z-[110] flex flex-col bg-slate-50 text-slate-800 animate-fade-in" data-identity-batch data-phase={phase}>
            <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 bg-white px-3" style={{ paddingTop: 'calc(0.6rem + var(--safe-top))', paddingBottom: '0.6rem' }}>
                <button type="button" onClick={back} aria-label="返回" className="flex h-9 w-9 items-center justify-center rounded-full text-slate-600 hover:bg-black/5"><CaretLeft size={22} weight="bold" /></button>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-bold">批次補別名與身份</div>
                    <div className="truncate text-[11px] text-slate-400">
                        {phase === 'pick' ? 'AI 讀人設，幫空著的角色補上；存之前都不會動到角色'
                            : phase === 'running' ? `正在讀人設… ${finished} / ${order.length}`
                                : `看一下結果，可以改、可以不要；按存才寫進去`}
                    </div>
                </div>
                {phase === 'running' && <button type="button" onClick={() => abortRef.current?.abort()} className="rounded-full bg-slate-100 px-3 py-1.5 text-[12px] font-bold text-slate-600">停下</button>}
            </div>

            {phase === 'pick' && (
                <>
                    <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-3">
                        <button type="button" aria-pressed={onlyEmpty} onClick={() => setOnlyEmpty(true)}
                            className={`rounded-full border px-3 py-1 text-[12px] font-bold ${onlyEmpty ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-200 bg-white text-slate-500'}`}>兩格都空的（{emptyCount}）</button>
                        <button type="button" aria-pressed={!onlyEmpty} onClick={() => setOnlyEmpty(false)}
                            className={`rounded-full border px-3 py-1 text-[12px] font-bold ${!onlyEmpty ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-200 bg-white text-slate-500'}`}>全部（{pool.length}）</button>
                        <span className="flex-1" />
                        <button type="button" onClick={() => setPicked(new Set(listed.filter(pickable).map(c => c.id)))} className="text-[12px] font-bold text-primary">全選</button>
                        <button type="button" onClick={() => setPicked(new Set())} className="text-[12px] font-bold text-slate-400">全不選</button>
                    </div>
                    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 pb-4">
                        {listed.length === 0 && <div className="py-12 text-center text-[13px] text-slate-400">每個角色的別名或身份都填過了。要重新讀的話切到「全部」。</div>}
                        {listed.map(c => {
                            const can = pickable(c);
                            const aliases = charAliases(c);
                            const role = charRoleTitle(c);
                            return (
                                <label key={c.id} className={`flex items-center gap-3 rounded-2xl bg-white px-3 py-2.5 shadow-sm ${can ? 'cursor-pointer' : 'opacity-50'}`} data-batch-pick={c.id}>
                                    <input type="checkbox" className="h-4 w-4 shrink-0 accent-slate-800" disabled={!can} checked={can && picked.has(c.id)} onChange={() => toggle(c.id)} aria-label={`補 ${c.name}`} />
                                    <TokenImg value={c.avatar} className="h-10 w-10 shrink-0 rounded-full object-cover" />
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-[14px] font-bold">{c.name}{c.castRole === 'supporting' && <span className="ml-1.5 text-[10px] font-normal text-slate-400">配角</span>}</span>
                                        <span className="block truncate text-[11px] text-slate-400">
                                            {!can ? '沒有人設可以讀' : !aliases.length && !role ? '別名、身份都還沒填' : `別名：${aliases.join('、') || '沒填'}｜身份：${role || '沒填'}`}
                                        </span>
                                    </span>
                                </label>
                            );
                        })}
                    </div>
                    <div className="shrink-0 border-t border-slate-100 bg-white px-4 pt-3" style={{ paddingBottom: 'calc(0.75rem + var(--safe-bottom, 0px))' }}>
                        <button type="button" onClick={() => void start()} disabled={!pool.some(c => picked.has(c.id) && pickable(c))}
                            className="flex w-full items-center justify-center gap-1.5 rounded-2xl bg-slate-800 py-3 text-[14px] font-bold text-white active:scale-[0.99] disabled:opacity-40">
                            <Sparkle size={15} weight="fill" /> 開始讀（{pool.filter(c => picked.has(c.id) && pickable(c)).length} 個）
                        </button>
                    </div>
                </>
            )}

            {phase !== 'pick' && (
                <>
                    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
                        {order.map(id => {
                            const char = byId.get(id);
                            const row = rows[id];
                            if (!char || !row) return null;
                            return (
                                <div key={id} className={`rounded-2xl bg-white p-3 shadow-sm ${row.status === 'done' && row.dropped ? 'opacity-50' : ''}`} data-batch-row={id} data-status={row.status}>
                                    <div className="flex items-center gap-2.5">
                                        <TokenImg value={char.avatar} className="h-9 w-9 shrink-0 rounded-full object-cover" />
                                        <span className="min-w-0 flex-1 truncate text-[14px] font-bold">{char.name}</span>
                                        {(row.status === 'waiting' || row.status === 'running') && <span className={`text-[11px] text-slate-400 ${row.status === 'running' ? 'animate-pulse' : ''}`}>{row.status === 'running' ? '讀人設中…' : phase === 'review' ? '沒讀到' : '排隊中'}</span>}
                                        {row.status === 'waiting' && phase === 'review' && <button type="button" onClick={() => void retry(id)} className="flex items-center gap-1 text-[12px] font-bold text-primary"><ArrowsClockwise size={13} /> 讀這個</button>}
                                        {row.status === 'failed' && <button type="button" onClick={() => void retry(id)} className="flex items-center gap-1 text-[12px] font-bold text-primary"><ArrowsClockwise size={13} /> 重試</button>}
                                        {row.status === 'done' && (
                                            <button type="button" onClick={() => setRows(prev => ({ ...prev, [id]: { ...row, dropped: !row.dropped } }))} className="text-[12px] font-bold text-slate-400">
                                                {row.dropped ? '還是要' : '不要這個'}
                                            </button>
                                        )}
                                    </div>
                                    {row.status === 'failed' && <div className="mt-2 rounded-xl bg-rose-50 px-3 py-1.5 text-[11px] text-rose-600 break-words">{row.error}</div>}
                                    {row.status === 'done' && !row.dropped && (
                                        <div className="mt-2.5 space-y-2">
                                            <label className="block">
                                                <span className={LABEL}>別名</span>
                                                <input value={row.draft.aliasText} onChange={e => patchDraft(id, { aliasText: e.target.value })} aria-label={`${char.name} 的別名`} placeholder="沒有就空著" className={FIELD} />
                                            </label>
                                            <label className="block">
                                                <span className={LABEL}>身份／職位</span>
                                                <input value={row.draft.roleTitle} maxLength={ROLE_TITLE_MAX_LENGTH} onChange={e => patchDraft(id, { roleTitle: e.target.value })} aria-label={`${char.name} 的身份／職位`} placeholder="沒有就空著" className={FIELD} />
                                                {row.draft.suggestRole && (
                                                    <span className="mt-1 flex items-start gap-2 rounded-lg bg-amber-50 px-2.5 py-1 text-[11px] text-amber-800">
                                                        <span className="min-w-0 flex-1 break-words">原本就有字，沒動。AI 建議：{row.draft.suggestRole}</span>
                                                        <button type="button" className="shrink-0 font-bold" onClick={() => patchDraft(id, { roleTitle: row.draft.suggestRole!, suggestRole: undefined })}>換成這個</button>
                                                    </span>
                                                )}
                                            </label>
                                            <label className="block">
                                                <span className={LABEL}>簡介</span>
                                                <input value={row.draft.description} onChange={e => patchDraft(id, { description: e.target.value })} aria-label={`${char.name} 的簡介`} placeholder="一句話介紹" className={FIELD} />
                                                {row.draft.suggestBrief && (
                                                    <span className="mt-1 flex items-start gap-2 rounded-lg bg-amber-50 px-2.5 py-1 text-[11px] text-amber-800">
                                                        <span className="min-w-0 flex-1 break-words">原本就有字，沒動。AI 建議：{row.draft.suggestBrief}</span>
                                                        <button type="button" className="shrink-0 font-bold" onClick={() => patchDraft(id, { description: row.draft.suggestBrief!, suggestBrief: undefined })}>換成這個</button>
                                                    </span>
                                                )}
                                            </label>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                    {phase === 'review' && (
                        <div className="shrink-0 border-t border-slate-100 bg-white px-4 pt-3" style={{ paddingBottom: 'calc(0.75rem + var(--safe-bottom, 0px))' }}>
                            {confirmLeave ? (
                                <div className="flex items-center gap-2">
                                    <span className="min-w-0 flex-1 text-[12px] text-slate-500">還沒存，離開就不留了。</span>
                                    <button type="button" onClick={() => setConfirmLeave(false)} className="rounded-xl bg-slate-100 px-3 py-2 text-[13px] font-bold text-slate-600">留下</button>
                                    <button type="button" onClick={onClose} className="rounded-xl bg-rose-500 px-3 py-2 text-[13px] font-bold text-white">不存，離開</button>
                                </div>
                            ) : (
                                <button type="button" onClick={() => void saveAll()} disabled={saving || !keepIds.length}
                                    className="w-full rounded-2xl bg-slate-800 py-3 text-[14px] font-bold text-white active:scale-[0.99] disabled:opacity-40">
                                    {saving ? '存起來…' : `存起來（${keepIds.length} 個）`}
                                </button>
                            )}
                        </div>
                    )}
                </>
            )}
        </div>
    );
};

export default IdentityBatchFillPage;
