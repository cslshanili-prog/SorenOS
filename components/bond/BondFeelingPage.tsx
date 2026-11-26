/**
 * 親近與信任（plans/bond-batch4.md 1.8、4.1）：角色對你的兩條量表、未修復的傷、事件帳。
 * 你看得到「為什麼掉了」；判錯了可以改或刪（之後的照帳本重算）、也可以補記一件。
 * 給角色的提示詞只給層和規範，不給數字。
 */
import React, { useEffect, useState } from 'react';
import { Heart, PencilSimple, Plus, Sparkle, Trash } from '@phosphor-icons/react';
import type { APIConfig, BondFeeling, BondFeelingEvent } from '../../types';
import { BondHeader, SectionLabel } from './bondUi';
import type { ResolvedSpace } from './space';
import { DB } from '../../utils/db';
import { CAUSE_LABEL, NEGATIVE_CATEGORIES, POSITIVE_CATEGORIES, tierName, type FeelingSize } from '../../utils/bond/feeling';
import { addFeelingManually, deleteFeelingEvent, editFeelingEvent, startFeeling, stopFeeling } from '../../utils/bond/feelingStore';
import { estimateFeelingStart } from './feelingRun';
import { onBondRegistryChange } from '../../utils/bond/registry';
import { bondOrBlank } from '../../utils/bond/store';

type Toast = (m: string, t?: 'success' | 'error' | 'info') => void;

const CATEGORY_LABEL: Record<string, string> = { ...POSITIVE_CATEGORIES, ...NEGATIVE_CATEGORIES };
const SOURCE_LABEL: Record<BondFeelingEvent['source'], string> = { eval: '聊天時', summary: '每日總結', neglect: '很久沒聯絡', manual: '你補記的' };
const sign = (n: number) => (n > 0 ? `＋${n}` : n < 0 ? `−${-n}` : '±0');

/** 兩條細線（首頁也用） */
export const FeelingBars: React.FC<{ feeling: BondFeeling; route?: ResolvedSpace['bond']['route']; showNumbers?: boolean }> = ({ feeling, route, showNumbers }) => (
    <div className="space-y-2">
        {(['closeness', 'trust'] as const).map(k => (
            <div key={k} className="flex items-center gap-3">
                <span className="w-8 shrink-0 text-[11px] text-[var(--bond-muted)]">{k === 'closeness' ? '親近' : '信任'}</span>
                <span className="relative flex-1 h-[3px] rounded-full bg-[var(--bond-line)] overflow-hidden">
                    <span className="absolute inset-y-0 left-0 bg-[var(--bond-accent)]" style={{ width: `${feeling[k]}%` }} />
                </span>
                <span className="w-16 shrink-0 text-right text-[11.5px] text-[var(--bond-ink-2)]">{tierName(feeling.tier[k], route)}{showNumbers ? ` ${feeling[k]}` : ''}</span>
            </div>
        ))}
    </div>
);

const NumberField: React.FC<{ label: string; value: number; onChange: (n: number) => void; min?: number; max?: number }> = ({ label, value, onChange, min = 0, max = 100 }) => (
    <label className="flex items-center gap-2 text-[12.5px]">
        <span className="w-10 text-[var(--bond-ink-2)]">{label}</span>
        <input type="number" className="bond-input text-center" style={{ width: 80, flex: 'none' }} min={min} max={max} value={value}
            onChange={e => onChange(Math.max(min, Math.min(max, Math.round(Number(e.target.value) || 0))))} />
    </label>
);

export const BondFeelingPage: React.FC<{ space: ResolvedSpace; apiConfig: APIConfig; onBack: () => void; addToast: Toast }> = ({ space, apiConfig, onBack, addToast }) => {
    const name = space.rightName;
    const [bond, setBond] = useState(() => bondOrBlank(space.id));
    const [log, setLog] = useState<BondFeelingEvent[]>([]);
    const [busy, setBusy] = useState(false);
    const [startDraft, setStartDraft] = useState<{ closeness: number; trust: number; why?: string } | null>(null);
    const [editing, setEditing] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);
    const feeling = bond.feeling;

    const reload = () => { setBond(bondOrBlank(space.id)); void DB.getBondFeelingLog(space.id).then(setLog).catch(() => {}); };
    useEffect(() => { reload(); return onBondRegistryChange(reload); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [space.id]);

    const estimate = async () => {
        setBusy(true);
        try { setStartDraft(await estimateFeelingStart(space, apiConfig)); }
        catch (e: any) { addToast(e?.message || '這次沒估出來', 'error'); }
        finally { setBusy(false); }
    };
    const begin = async () => {
        if (!startDraft) return;
        await startFeeling(space.id, startDraft, startDraft.why !== undefined ? 'estimate' : 'manual');
        setStartDraft(null);
        addToast(feeling ? '起點改好了，帳本照新的起點重算' : '開始記了', 'success');
    };

    const events = log.filter(e => !e.deletedAt).sort((a, b) => b.at - a.at);
    const open = feeling?.openHurts.filter(h => !h.repairedAt) || [];

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="親近與信任" onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-5 space-y-7">
                <p className="text-[12px] leading-relaxed text-[var(--bond-ink-2)]">
                    {name}對你的兩種感受：親近（想靠近你的程度）、信任（相信你的程度）。只照真的發生的事動——閒聊、問候不算；傷人的事、失約、欺騙會讓它掉，道歉要有具體的補救才回得來，而且最多回到七成。等級只會往上，這兩條會掉。
                </p>

                {!feeling || startDraft ? (
                    <section>
                        <SectionLabel>{feeling ? '改 起 點' : '從 哪 裡 開 始'}</SectionLabel>
                        {!startDraft ? (
                            <div className="flex flex-wrap gap-2">
                                <button type="button" className="bond-btn bond-btn-primary" disabled={busy} onClick={estimate}><Sparkle size={14} />{busy ? '讀你們的總結中…' : `讓 ${name} 估一個起點`}</button>
                                <button type="button" className="bond-btn" onClick={() => setStartDraft({ closeness: 30, trust: 30 })}>自己填</button>
                            </div>
                        ) : (
                            <div className="rounded-xl border bond-hair bg-[var(--bond-card)] px-4 py-4 space-y-3">
                                {startDraft.why && <p className="bond-serif text-[13.5px] leading-relaxed">「{startDraft.why}」</p>}
                                <div className="flex flex-wrap gap-4">
                                    <NumberField label="親近" value={startDraft.closeness} onChange={n => setStartDraft(d => ({ ...d!, closeness: n }))} />
                                    <NumberField label="信任" value={startDraft.trust} onChange={n => setStartDraft(d => ({ ...d!, trust: n }))} />
                                </div>
                                <p className="text-[11px] text-[var(--bond-muted)]">0 陌生、30 熟悉、50 友好、70 很親近、90 以上深度綁定。</p>
                                <div className="flex gap-2">
                                    <button type="button" className="bond-btn" onClick={() => setStartDraft(null)}>先不要</button>
                                    <button type="button" className="bond-btn bond-btn-primary flex-1" onClick={begin}><Heart size={14} />{feeling ? '用這個起點重算' : '開始記'}</button>
                                </div>
                            </div>
                        )}
                    </section>
                ) : (
                    <>
                        <section>
                            <SectionLabel right={<button type="button" className="text-[11.5px] text-[var(--bond-accent)]" onClick={() => setStartDraft({ closeness: feeling.start.closeness, trust: feeling.start.trust })}>改起點</button>}>現 在</SectionLabel>
                            <FeelingBars feeling={feeling} route={space.bond.route} showNumbers />
                            <p className="mt-2 text-[11px] text-[var(--bond-muted)]">起點 親近 {feeling.start.closeness}、信任 {feeling.start.trust}（{feeling.start.how === 'estimate' ? `${name}估的` : '你填的'}）。升層要多過下一層一點、而且沒有沒修好的事；降層也有一點緩衝，重大的事會直接掉。</p>
                        </section>

                        {open.length > 0 && (
                            <section>
                                <SectionLabel>還 沒 修 復 的 事</SectionLabel>
                                <div className="space-y-2">
                                    {open.map(h => (
                                        <div key={h.id} className="rounded-xl border bond-hair bg-[var(--bond-card)] px-4 py-3">
                                            <div className="bond-serif text-[14px]">{h.what}</div>
                                            <div className="mt-0.5 text-[11px] text-[var(--bond-muted)]">{new Date(h.at).toLocaleDateString()} · {h.severity === 'major' ? '很重大' : '不小'} · 親近 {sign(h.lost.closeness)}、信任 {sign(h.lost.trust)}</div>
                                            <p className="mt-1.5 text-[11.5px] text-[var(--bond-ink-2)]">修好之前{name}不會若無其事，告白、求婚這類事件也先不開放演。真心道歉而且有具體補救，才會慢慢回來。</p>
                                            <button type="button" className="mt-2 text-[11.5px] text-[var(--bond-accent)]" onClick={async () => {
                                                await addFeelingManually(space.id, { what: `為「${h.what}」好好道歉並補救`, category: 'repair', valence: 1, size: 'mid', target: 'both', cause: 'positive', repair: true });
                                                addToast('記下了補救', 'success');
                                            }}>你們已經好好談過、也補救了（記一筆）</button>
                                        </div>
                                    ))}
                                </div>
                            </section>
                        )}

                        <section>
                            <SectionLabel right={<button type="button" className="text-[11.5px] text-[var(--bond-accent)] inline-flex items-center gap-1" onClick={() => setAdding(!adding)}><Plus size={12} />補記一件</button>}>發 生 過 的 事</SectionLabel>
                            {adding && <AddEvent onDone={() => setAdding(false)} onAdd={async input => {
                                const saved = await addFeelingManually(space.id, input);
                                addToast(saved.length ? '記下了' : '這件不會動到（閒聊或今天同類的已經算過了）', saved.length ? 'success' : 'info');
                                setAdding(false);
                            }} />}
                            {events.length === 0 ? (
                                <p className="py-6 text-center text-[12px] text-[var(--bond-muted)]">還沒有。{space.char.emotionConfig?.enabled ? '聊天時會順便判（跟著情緒評估）。' : '每天的總結寫好時會判一次；開了情緒評估的話每輪都會判。'}</p>
                            ) : (
                                <div className="divide-y bond-hair border-y">
                                    {events.map(e => editing === e.id ? (
                                        <EditEvent key={e.id} event={e} onCancel={() => setEditing(null)} onSave={async patch => {
                                            await editFeelingEvent(space.id, e.id, patch);
                                            setEditing(null);
                                            addToast('改好了，之後的照新的重算', 'success');
                                        }} />
                                    ) : (
                                        <div key={e.id} className="py-3">
                                            <div className="flex items-start gap-3">
                                                <span className="min-w-0 flex-1">
                                                    <span className="bond-serif block text-[13.5px] leading-relaxed">{e.what}</span>
                                                    <span className="block mt-0.5 text-[10.5px] text-[var(--bond-muted)]">
                                                        {new Date(e.at).toLocaleDateString()} · {SOURCE_LABEL[e.source]} · {CATEGORY_LABEL[e.category] || e.category}{e.cause !== 'positive' ? `（${CAUSE_LABEL[e.cause]}）` : ''}{e.hurt ? ' · 記成沒修好的事' : ''}{e.repairs ? ' · 修好了一件' : ''}{e.editedAt ? ' · 你改過' : ''}
                                                    </span>
                                                </span>
                                                <span className={`shrink-0 text-[12px] tabular-nums ${e.delta.closeness + e.delta.trust < 0 ? 'text-[var(--bond-accent)]' : 'text-[var(--bond-ink-2)]'}`}>
                                                    親近 {sign(e.delta.closeness)}<br />信任 {sign(e.delta.trust)}
                                                </span>
                                            </div>
                                            <div className="mt-1.5 flex gap-4">
                                                <button type="button" className="text-[11px] text-[var(--bond-accent)] inline-flex items-center gap-1" onClick={() => setEditing(e.id)}><PencilSimple size={11} />判錯了，改</button>
                                                <button type="button" className="text-[11px] text-[var(--bond-muted)] inline-flex items-center gap-1" onClick={async () => { await deleteFeelingEvent(space.id, e.id); addToast('刪掉了，照帳本重算', 'success'); }}><Trash size={11} />刪掉</button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </section>

                        <section>
                            <StopRow onStop={async () => { await stopFeeling(space.id); addToast('不記了（帳本留著）', 'success'); }} />
                        </section>
                    </>
                )}
            </div>
        </div>
    );
};

const StopRow: React.FC<{ onStop: () => void }> = ({ onStop }) => {
    const [ask, setAsk] = useState(false);
    return !ask ? (
        <button type="button" className="text-[11.5px] text-[var(--bond-muted)] underline underline-offset-4" onClick={() => setAsk(true)}>不記親近與信任了</button>
    ) : (
        <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
            <span>不記了？提示詞裡就不會再有這兩條。</span>
            <button type="button" className="bond-btn" onClick={() => setAsk(false)}>先不要</button>
            <button type="button" className="bond-btn bond-btn-primary" onClick={onStop}>不記了</button>
        </div>
    );
};

const EditEvent: React.FC<{ event: BondFeelingEvent; onCancel: () => void; onSave: (patch: Pick<BondFeelingEvent, 'what' | 'delta'>) => void }> = ({ event, onCancel, onSave }) => {
    const [what, setWhat] = useState(event.what);
    const [dc, setDc] = useState(event.delta.closeness);
    const [dt, setDt] = useState(event.delta.trust);
    return (
        <div className="py-3 space-y-2">
            <input className="bond-input" value={what} onChange={e => setWhat(e.target.value)} />
            <div className="flex flex-wrap gap-4">
                <NumberField label="親近" value={dc} min={-25} max={25} onChange={setDc} />
                <NumberField label="信任" value={dt} min={-25} max={25} onChange={setDt} />
            </div>
            <div className="flex gap-2">
                <button type="button" className="bond-btn" onClick={onCancel}>取消</button>
                <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={!what.trim()} onClick={() => onSave({ what: what.trim(), delta: { closeness: dc, trust: dt } })}>存</button>
            </div>
        </div>
    );
};

const AddEvent: React.FC<{ onAdd: (input: Parameters<typeof addFeelingManually>[1]) => void; onDone: () => void }> = ({ onAdd, onDone }) => {
    const [what, setWhat] = useState('');
    const [category, setCategory] = useState('supported');
    const [size, setSize] = useState<FeelingSize>('small');
    const [cause, setCause] = useState<BondFeelingEvent['cause']>('careless');
    const negative = category in NEGATIVE_CATEGORIES;
    return (
        <div className="mb-4 rounded-xl border bond-hair bg-[var(--bond-card)] px-4 py-3 space-y-3">
            <input className="bond-input" value={what} placeholder="發生了什麼" onChange={e => setWhat(e.target.value)} />
            <div className="flex flex-wrap gap-1.5">
                {Object.entries({ ...POSITIVE_CATEGORIES, ...NEGATIVE_CATEGORIES }).filter(([k]) => !['apology'].includes(k)).map(([k, label]) => (
                    <button key={k} type="button" className="bond-chip" aria-pressed={category === k} onClick={() => setCategory(k)}>{label}</button>
                ))}
            </div>
            <div className="flex flex-wrap gap-1.5">
                {(['tiny', 'small', 'mid', 'large'] as const).map(s => <button key={s} type="button" className="bond-chip" aria-pressed={size === s} onClick={() => setSize(s)}>{{ tiny: '微小', small: '小', mid: '重要', large: '很重大' }[s]}</button>)}
            </div>
            {negative && (
                <div className="flex flex-wrap gap-1.5">
                    {(['malice', 'careless', 'unavoidable', 'repaired', 'repeated'] as const).map(c => <button key={c} type="button" className="bond-chip" aria-pressed={cause === c} onClick={() => setCause(c)}>{CAUSE_LABEL[c]}</button>)}
                </div>
            )}
            <div className="flex gap-2">
                <button type="button" className="bond-btn" onClick={onDone}>取消</button>
                <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={!what.trim()}
                    onClick={() => onAdd({ what: what.trim(), category, valence: negative ? -1 : 1, size, target: 'both', cause: negative ? cause : 'positive', repair: category === 'repair' })}>記下來</button>
            </div>
        </div>
    );
};
