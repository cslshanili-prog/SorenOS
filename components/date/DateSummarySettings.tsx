import React, { useEffect, useMemo, useState } from 'react';
import type { CharacterProfile, DateStory, DateSummaryConfig, DateSummaryPreset, Message } from '../../types';
import { useOS } from '../../context/OSContext';
import { DB } from '../../utils/db';
import { resolveCharacterChatApi } from '../../utils/characterApi';
import { resolveUserProfileForChar } from '../../utils/userPersona';
import {
    DATE_SUMMARY_ROUNDS, DEFAULT_DATE_SUMMARY_PROMPT, deleteDateSummary, isDateSummaryRunning,
    resolveDateSummaryConfig, runDateSummary, storyMessages, updateDateSummary,
} from '../../utils/dateSummary';
import { resolveDatePalaceConfig, sendDateSummaryToPalace } from '../../utils/dateSummaryPalace';
import { DATE_STORY_UPDATED_EVENT } from '../../utils/dateStory';
import { formatDateHistoryTime } from '../../utils/dateHistory';

// 見面設定的「對話總結」：設定跟著角色走，總結紀錄跟著進行中的故事走。

interface Props {
    char: CharacterProfile;
    story: DateStory | null;
    Section: React.FC<{ title: string; defaultOpen?: boolean; children: React.ReactNode }>;
}

const KIND_LABEL = { auto: '自動', all: '立即總結', range: '選範圍' } as const;
const PALACE_OPTIONS: { value: NonNullable<DateSummaryConfig['palaceMode']>; label: string; hint: string }[] = [
    { value: 'final', label: '只有完結時送', hint: '分段總結只當前情提要；完結時那份大總結才送' },
    { value: 'each', label: '每次總結都送', hint: '見面原文本來就會進宮殿，這樣同一段會記兩次' },
    { value: 'manual', label: '手動', hint: '在下面的紀錄裡自己按' },
];

const makePresetId = () => `dsp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

const DateSummarySettings: React.FC<Props> = ({ char, story, Section }) => {
    const { updateCharacter, addToast, apiConfig, memoryPalaceConfig, userProfileBase } = useOS();
    const config = resolveDateSummaryConfig(char);
    const patchConfig = (patch: Partial<DateSummaryConfig>) =>
        updateCharacter(char.id, { dateSummaryConfig: { ...(char.dateSummaryConfig || {}), ...patch } });

    const [promptDraft, setPromptDraft] = useState(char.dateSummaryConfig?.prompt || '');
    const [roundsDraft, setRoundsDraft] = useState(String(config.rounds));
    useEffect(() => {
        setPromptDraft(char.dateSummaryConfig?.prompt || '');
        setRoundsDraft(String(resolveDateSummaryConfig(char).rounds));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [char.id]);
    const savePrompt = () => {
        const next = promptDraft.trim();
        if (next === (char.dateSummaryConfig?.prompt || '')) return;
        patchConfig({ prompt: next || undefined });
        addToast(next ? '總結要求已保存' : '已改回內建的總結要求', 'success');
    };
    const saveRounds = () => {
        const n = Math.round(Number(roundsDraft));
        if (!Number.isFinite(n)) { setRoundsDraft(String(config.rounds)); return; }
        const clamped = Math.min(DATE_SUMMARY_ROUNDS.max, Math.max(DATE_SUMMARY_ROUNDS.min, n));
        setRoundsDraft(String(clamped));
        if (clamped !== config.rounds) patchConfig({ rounds: clamped });
    };

    // 總結要求預設（所有角色共用）
    const [presets, setPresets] = useState<DateSummaryPreset[]>([]);
    useEffect(() => { DB.getDateSummaryPresets().then(setPresets).catch(() => setPresets([])); }, []);
    const savePreset = async () => {
        const prompt = promptDraft.trim();
        if (!prompt) { addToast('先寫好總結要求再存', 'info'); return; }
        const name = window.prompt('這份總結要求叫什麼？', '')?.trim();
        if (!name) return;
        const preset: DateSummaryPreset = { id: makePresetId(), name, prompt, createdAt: Date.now() };
        await DB.saveDateSummaryPreset(preset);
        setPresets(list => [...list, preset]);
        if (prompt !== (char.dateSummaryConfig?.prompt || '')) patchConfig({ prompt });
        addToast(`已存成「${name}」`, 'success');
    };
    const applyPreset = (preset: DateSummaryPreset) => { setPromptDraft(preset.prompt); patchConfig({ prompt: preset.prompt }); addToast(`已套用「${preset.name}」`, 'success'); };
    const removePreset = async (preset: DateSummaryPreset) => {
        if (!window.confirm(`刪除總結預設「${preset.name}」？`)) return;
        await DB.deleteDateSummaryPreset(preset.id);
        setPresets(list => list.filter(item => item.id !== preset.id));
    };

    // 這場故事的訊息（編號、選範圍用）
    const [messages, setMessages] = useState<Message[]>([]);
    useEffect(() => {
        if (!story) { setMessages([]); return; }
        let cancelled = false;
        const load = () => {
            DB.getRecentMessagesByCharIdAndSource(char.id, 'date', 2000)
                .then(list => { if (!cancelled) setMessages(list); })
                .catch(() => {});
        };
        load();
        window.addEventListener(DATE_STORY_UPDATED_EVENT, load);
        return () => { cancelled = true; window.removeEventListener(DATE_STORY_UPDATED_EVENT, load); };
    }, [char.id, story?.id]);
    const ordered = useMemo(() => (story ? storyMessages(messages, story) : []), [messages, story]);
    const indexOf = (id: number) => ordered.findIndex(message => message.id === id) + 1;
    const pendingCount = story ? ordered.filter(message => message.id > (story.summarizedThroughId ?? 0)).length : 0;

    const [busy, setBusy] = useState<'' | 'all' | 'range' | string>('');
    const [rangeFrom, setRangeFrom] = useState('');
    const [rangeTo, setRangeTo] = useState('');
    const userName = resolveUserProfileForChar(userProfileBase, char).name;
    const runSummary = async (kind: 'all' | 'range') => {
        if (!story || busy || isDateSummaryRunning(story.id)) return;
        let range: { fromMessageId: number; toMessageId: number } | undefined;
        if (kind === 'range') {
            const from = Math.round(Number(rangeFrom));
            const to = Math.round(Number(rangeTo));
            if (!(from >= 1 && to >= from && to <= ordered.length)) { addToast(`範圍要在 1 到 ${ordered.length} 之間`, 'error'); return; }
            range = { fromMessageId: ordered[from - 1].id, toMessageId: ordered[to - 1].id };
        }
        setBusy(kind);
        try {
            const done = await runDateSummary({ char, story, userName, api: resolveCharacterChatApi(char, apiConfig), messages, kind, range });
            if (!done) { addToast(kind === 'all' ? '沒有還沒總結的劇情' : '這個範圍沒有內容', 'info'); return; }
            addToast('總結好了', 'success');
            if (config.palaceMode === 'each') await sendToPalace(done.story, done.summary.id, true);
        } catch (e: any) {
            addToast(e?.message || '總結失敗', 'error');
        } finally {
            setBusy('');
        }
    };

    const palace = resolveDatePalaceConfig(char, memoryPalaceConfig, apiConfig);
    const sendToPalace = async (target: DateStory, summaryId: string, quiet = false) => {
        if (!palace) { addToast('這個角色沒開記憶宮殿，或還沒設 Embedding', 'info'); return; }
        const summary = (await DB.getDateStory(target.id))?.summaries?.find(item => item.id === summaryId);
        if (!summary) return;
        setBusy(summaryId);
        try {
            const last = messages.find(message => message.id === summary.toMessageId);
            const result = await sendDateSummaryToPalace({ char, story: target, summary, happenedAt: last?.timestamp ?? summary.createdAt, config: palace });
            if (result === 'busy') addToast('記憶宮殿正在整理別的，等一下再送', 'info');
            else if (result === 'error') addToast('送進記憶宮殿失敗', 'error');
            else if (!quiet || result === 'duplicate') addToast(result === 'stored' ? '已送進記憶宮殿' : '宮殿裡已經有很像的記憶，這段不重複存', 'success');
        } finally {
            setBusy('');
        }
    };

    const [editing, setEditing] = useState<Record<string, string>>({});
    const saveEdit = async (summaryId: string) => {
        if (!story) return;
        const text = editing[summaryId]?.trim();
        const current = story.summaries?.find(item => item.id === summaryId)?.text;
        setEditing(map => { const next = { ...map }; delete next[summaryId]; return next; });
        if (!text || text === current) return;
        await updateDateSummary(story.id, summaryId, { text });
        addToast('總結已修改', 'success');
    };
    const removeSummary = async (summaryId: string) => {
        if (!story || !window.confirm('刪除這段總結？（已經送進記憶宮殿的不會跟著刪）')) return;
        await deleteDateSummary(story.id, summaryId);
    };

    return (
        <Section title="對話總結 (Summary)">
            <p className="text-[11px] text-slate-400 mt-1 mb-3 leading-relaxed">把劇情一段段整理成總結，見面時當「前情提要」帶給角色，故事再長也接得上。見面原文照舊會進記憶宮殿。</p>

            <div className="divide-y divide-slate-100">
                <div className="flex items-center justify-between gap-3 pb-3">
                    <span className="text-[11px] text-slate-500 font-bold">自動總結</span>
                    <button type="button" role="switch" aria-checked={config.auto} aria-label="自動總結" onClick={() => patchConfig({ auto: !config.auto })}
                        className={`w-11 h-6 shrink-0 rounded-full transition-colors relative ${config.auto ? 'bg-primary' : 'bg-slate-200'}`}>
                        <div className={`absolute left-0 top-0.5 w-5 h-5 bg-white rounded-full shadow-md transition-transform ${config.auto ? 'translate-x-5' : 'translate-x-0.5'}`} />
                    </button>
                </div>
                {config.auto && (
                    <div className="py-3 space-y-2">
                        <div role="radiogroup" aria-label="什麼時候總結" className="flex rounded-full bg-slate-100 p-1 text-xs w-fit">
                            {([['rounds', '每幾輪'], ['daily', '每天']] as const).map(([value, label]) => (
                                <button key={value} role="radio" aria-checked={config.trigger === value} onClick={() => patchConfig({ trigger: value })}
                                    className={`rounded-full px-3 py-1 transition ${config.trigger === value ? 'bg-white text-primary font-bold shadow-sm' : 'text-slate-400'}`}>{label}</button>
                            ))}
                        </div>
                        {config.trigger === 'rounds' ? (
                            <label className="flex items-center gap-2 text-xs text-slate-500">
                                角色每回
                                <input type="number" inputMode="numeric" min={DATE_SUMMARY_ROUNDS.min} max={DATE_SUMMARY_ROUNDS.max} value={roundsDraft} aria-label="幾輪總結一次"
                                    onChange={e => setRoundsDraft(e.target.value)} onBlur={saveRounds}
                                    className="w-16 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-center text-slate-700" />
                                輪總結一次
                            </label>
                        ) : (
                            <label className="flex items-center gap-2 text-xs text-slate-500">
                                每天
                                <input type="time" value={config.dailyTime} aria-label="每天幾點總結" onChange={e => e.target.value && patchConfig({ dailyTime: e.target.value })}
                                    className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-slate-700" />
                                之後總結當天的新劇情
                            </label>
                        )}
                        <p className="text-[10px] text-slate-300 leading-relaxed">只在見面 App 開著時會跑；到點時沒開著，下次進見面會補。</p>
                    </div>
                )}

                <div className="py-3">
                    <span className="text-[11px] text-slate-500 font-bold">送進記憶宮殿</span>
                    <div className="mt-2 space-y-1.5">
                        {PALACE_OPTIONS.map(option => (
                            <button key={option.value} role="radio" aria-checked={config.palaceMode === option.value} onClick={() => patchConfig({ palaceMode: option.value })}
                                className={`w-full text-left px-3 py-2 rounded-xl border transition ${config.palaceMode === option.value ? 'border-primary bg-primary/5' : 'border-slate-100 bg-slate-50'}`}>
                                <div className={`text-xs font-bold ${config.palaceMode === option.value ? 'text-primary' : 'text-slate-600'}`}>{option.label}</div>
                                <div className="text-[10px] text-slate-400 mt-0.5">{option.hint}</div>
                            </button>
                        ))}
                    </div>
                    {!palace && <p className="text-[10px] text-amber-500 mt-2">這個角色沒開記憶宮殿或還沒設 Embedding，總結只會當前情提要。</p>}
                </div>

                <div className="py-3">
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-[11px] text-slate-500 font-bold">總結要求</span>
                        <button onClick={() => void savePreset()} className="text-[11px] text-primary font-bold">另存為預設</button>
                    </div>
                    {presets.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mb-2">
                            {presets.map(preset => (
                                <span key={preset.id} className={`inline-flex items-center gap-1 rounded-full border pl-2.5 pr-1 py-0.5 text-[11px] ${preset.prompt === (char.dateSummaryConfig?.prompt || '') ? 'border-primary text-primary bg-primary/5' : 'border-slate-200 text-slate-500 bg-white'}`}>
                                    <button onClick={() => applyPreset(preset)}>{preset.name}</button>
                                    <button onClick={() => void removePreset(preset)} aria-label={`刪除 ${preset.name}`} className="px-1 text-slate-300 hover:text-red-400">×</button>
                                </span>
                            ))}
                        </div>
                    )}
                    <textarea value={promptDraft} onChange={e => setPromptDraft(e.target.value)} onBlur={savePrompt} rows={4} placeholder={DEFAULT_DATE_SUMMARY_PROMPT}
                        className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs text-slate-700 leading-relaxed focus:outline-none focus:ring-1 focus:ring-primary/30 resize-y" />
                    <p className="text-[10px] text-slate-300 mt-1">文風、人稱、長度都可以寫。空著就用灰字那份。</p>
                </div>

                {story ? (
                    <div className="pt-3 space-y-3">
                        <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] text-slate-500 font-bold">這場故事 · {ordered.length} 則{pendingCount ? `，${pendingCount} 則還沒總結` : ''}</span>
                            <button onClick={() => void runSummary('all')} disabled={!!busy || !pendingCount}
                                className="px-3 py-1.5 rounded-lg bg-primary text-white text-xs font-bold disabled:opacity-40 active:scale-95">{busy === 'all' ? '總結中…' : '立即總結'}</button>
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-slate-500">
                            第
                            <input type="number" inputMode="numeric" min={1} value={rangeFrom} onChange={e => setRangeFrom(e.target.value)} aria-label="從第幾則"
                                className="w-14 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-center text-slate-700" />
                            到
                            <input type="number" inputMode="numeric" min={1} value={rangeTo} onChange={e => setRangeTo(e.target.value)} aria-label="到第幾則"
                                className="w-14 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-center text-slate-700" />
                            則
                            <button onClick={() => void runSummary('range')} disabled={!!busy || !ordered.length}
                                className="ml-auto px-3 py-1.5 rounded-lg border border-primary/40 text-primary text-xs font-bold disabled:opacity-40 active:scale-95">{busy === 'range' ? '總結中…' : '總結這段'}</button>
                        </div>

                        {(story.summaries || []).length === 0 ? (
                            <p className="text-[11px] text-slate-300 text-center py-3">這場還沒有總結</p>
                        ) : (
                            <ol className="space-y-2">
                                {(story.summaries || []).map(summary => {
                                    const from = indexOf(summary.fromMessageId);
                                    const to = indexOf(summary.toMessageId);
                                    const draft = editing[summary.id];
                                    return (
                                        <li key={summary.id} className="rounded-xl border border-slate-100 bg-slate-50 p-3" data-date-summary>
                                            <div className="flex items-center justify-between gap-2 text-[10px] text-slate-400 mb-1.5">
                                                <span>{from && to ? `第 ${from}–${to} 則` : `${summary.messageCount} 則`} · {KIND_LABEL[summary.kind]} · {formatDateHistoryTime(summary.createdAt, true)}</span>
                                                <button onClick={() => void removeSummary(summary.id)} className="text-slate-300 hover:text-red-400">刪除</button>
                                            </div>
                                            <textarea value={draft ?? summary.text} rows={Math.min(8, Math.max(3, Math.ceil(summary.text.length / 28)))}
                                                onChange={e => setEditing(map => ({ ...map, [summary.id]: e.target.value }))} onBlur={() => void saveEdit(summary.id)}
                                                className="w-full bg-transparent text-xs text-slate-700 leading-relaxed resize-y focus:outline-none" />
                                            <div className="flex justify-end mt-1">
                                                {summary.palaceAt
                                                    ? <span className="text-[10px] text-emerald-500 font-bold">✓ 已在記憶宮殿</span>
                                                    : <button onClick={() => void sendToPalace(story, summary.id)} disabled={!palace || !!busy}
                                                        className="text-[11px] text-primary font-bold disabled:opacity-40">{busy === summary.id ? '送出中…' : '送進記憶宮殿'}</button>}
                                            </div>
                                        </li>
                                    );
                                })}
                            </ol>
                        )}
                    </div>
                ) : (
                    <p className="pt-3 text-[11px] text-slate-300">開始一場故事後，總結紀錄會出現在這裡。</p>
                )}
            </div>
        </Section>
    );
};

export default DateSummarySettings;
