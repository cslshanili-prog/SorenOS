import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CaretLeft, DotsThree, Plus, UploadSimple } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import type { StoryTheaterPreset } from '../types';
import { DB } from '../utils/db';
import { copyBuiltinMeetingPreset, deleteMeetingPresetRecord, duplicateMeetingPresetRecord, importStPresetFile, MEETING_PRESET_UPDATED_EVENT, saveMeetingPresetDoc, saveNewMeetingPresetDoc } from '../utils/meetingPreset/store';
import { duplicatePresetDoc } from '../utils/meetingPreset/edit';
import { buildBuiltinChatPresetDoc } from '../utils/chatPresetSession';
import { buildBuiltinCallPresetDoc } from '../utils/callPresetSession';
import { buildStPreset, stPresetFileName } from '../utils/meetingPreset/stExport';
import type { MeetingPresetRecord } from '../utils/meetingPreset/types';
import { BUILTIN_NIGHT_SCREENING_PRESET, createBlankStoryPreset, downloadStoryPreset, duplicateStoryPreset, parseStoryTheaterPreset, withBuiltInStoryPresets } from '../utils/storyTheater';
import { BUILTIN_PRESET, PRESET_SCENE_LABEL, scenesOfPreset, type PresetScene } from '../utils/presetBinding';
import { shareOrDownloadFile } from '../utils/shareExport';
import { readShareFile } from '../utils/pngShare';
import { trackEvent } from '../utils/analytics';
import MeetingPresetManager from '../components/date/MeetingPresetManager';
import StoryPresetMaker from '../components/date/story/StoryPresetMaker';
import { StoryTheaterThemeProvider } from '../components/date/story/StoryTheaterTheme';

/**
 * 預設 App（plans/preset-library.md 第 1 批）：所有預設集中在這裡。
 * - 通用預設（meeting_presets，ST 格式、能匯入 ST）：現在用在見面，線上場景第 2、3 批接上。
 * - 劇情專用預設（story_theater_presets）：劇情劇場的引擎靠條目 id 跑分區、快捷選項，格式和編輯器照舊。
 * - 場景預設：每個場景用哪份（UserProfile.presetSceneDefaults）；角色、劇情自己選的蓋過它。
 */
type Filter = 'all' | 'chat' | 'call' | 'date' | 'story';
/** 通用預設現在能用的場景（勾適用場景、設場景預設） */
const GENERAL_SCENES: PresetScene[] = ['chat', 'call', 'date'];
type Row =
    | { kind: 'general'; record: MeetingPresetRecord }
    | { kind: 'story'; preset: StoryTheaterPreset };

const FUTURE_SCENES: PresetScene[] = ['group'];
// 埋點屬性是固定枚舉（docs/analytics.md），用簡體
const SCENE_EVENT_LABEL: Record<PresetScene, string> = { chat: '私聊', group: '群聊', call: '电话', date: '见面', story: '剧情' };

const PresetApp: React.FC = () => {
    const { closeApp, addToast, userProfileBase, updateUserProfile, characters, updateCharacter } = useOS();
    const [general, setGeneral] = useState<MeetingPresetRecord[]>([]);
    const [stories, setStories] = useState<StoryTheaterPreset[]>([]);
    const [filter, setFilter] = useState<Filter>('all');
    const [menu, setMenu] = useState<Row | null>(null);
    const [newMenu, setNewMenu] = useState(false);
    const [managingId, setManagingId] = useState<string | null>(null);
    const [editingStory, setEditingStory] = useState<StoryTheaterPreset | null>(null);
    const [busy, setBusy] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);

    const reload = useCallback(async () => {
        const [g, s] = await Promise.all([DB.getMeetingPresets().catch(() => []), DB.getStoryTheaterPresets().catch(() => [])]);
        setGeneral([...g].sort((a, b) => b.updatedAt - a.updatedAt));
        setStories(s.filter(p => !p.builtIn).sort((a, b) => b.updatedAt - a.updatedAt));
    }, []);
    useEffect(() => {
        void reload();
        window.addEventListener(MEETING_PRESET_UPDATED_EVENT, reload);
        return () => window.removeEventListener(MEETING_PRESET_UPDATED_EVENT, reload);
    }, [reload]);

    const storyAll = useMemo(() => withBuiltInStoryPresets(stories), [stories]);
    const defaults = userProfileBase.presetSceneDefaults || {};
    const setSceneDefault = (scene: PresetScene, id: string | undefined) => {
        updateUserProfile(prev => ({ presetSceneDefaults: { ...(prev.presetSceneDefaults || {}), [scene]: id || undefined } }));
        trackEvent('设定场景预设', { 场景: SCENE_EVENT_LABEL[scene], 选择: !id ? '未设' : id === BUILTIN_PRESET || id === BUILTIN_NIGHT_SCREENING_PRESET.id ? '内建' : '自订' });
    };

    // ─── 匯入 ───
    const importFile = async (file: File) => {
        setBusy(true);
        try {
            const isPng = /\.png$/i.test(file.name) || file.type === 'image/png';
            const source = isPng ? await readShareFile(file, 'story') : file;
            const text = await source.text();
            let json: any = null;
            try { json = JSON.parse(text); } catch { /* 交給下面報錯 */ }
            if (json?.schema === 'sullyos.story-preset') {
                const imported = parseStoryTheaterPreset(text, source.name);
                await DB.saveStoryTheaterPreset(imported);
                trackEvent('导入预设', { 种类: '剧情专用' });
                addToast(`已匯入劇情預設「${imported.name}」`, 'success');
            } else {
                const record = await importStPresetFile(text, source.name);
                // ST 預設不分場景，私聊、見面都能選；不要的在「⋯ → 適用場景」取消
                await saveMeetingPresetDoc(record, { ...record.doc, scenes: ['chat', 'call', 'date'] });
                trackEvent('导入预设', { 种类: '通用' });
                addToast(`已匯入「${record.name}」（通用預設，私聊、電話、見面都能選）`, 'success');
            }
            await reload();
        } catch (e: any) {
            addToast(e?.message || '匯入失敗：這裡收 SillyTavern 預設（.json）和劇情預設', 'error');
        } finally {
            setBusy(false);
            if (fileRef.current) fileRef.current.value = '';
        }
    };

    // ─── 每列的動作 ───
    const exportRow = async (row: Row) => {
        try {
            if (row.kind === 'general') {
                const result = await shareOrDownloadFile({ content: JSON.stringify(buildStPreset(row.record.doc), null, 2), fileName: stPresetFileName(row.record.doc), mimeType: 'application/json', shareTitle: row.record.name });
                if (result === 'downloaded') addToast('已匯出', 'success');
            } else {
                await downloadStoryPreset(row.preset);
            }
        } catch (e: any) { addToast(e?.message || '匯出失敗', 'error'); }
    };
    const duplicateRow = async (row: Row) => {
        if (row.kind === 'general') {
            const copy = await duplicateMeetingPresetRecord(row.record);
            addToast(`已複製成「${copy.name}」`, 'success');
        } else {
            const copy = duplicateStoryPreset(row.preset);
            await DB.saveStoryTheaterPreset(copy);
            addToast(`已複製成「${copy.name}」`, 'success');
        }
        await reload();
    };
    const deleteRow = async (row: Row) => {
        const name = row.kind === 'general' ? row.record.name : row.preset.name;
        if (!window.confirm(`刪除預設「${name}」？用它的角色、劇情會改回場景預設或內建。`)) return;
        if (row.kind === 'general') {
            const id = row.record.id;
            await deleteMeetingPresetRecord(id);
            for (const c of characters.filter(c => c.dateMeetingPresetId === id || c.chatPresetId === id || c.callPresetId === id)) {
                updateCharacter(c.id, {
                    ...(c.dateMeetingPresetId === id ? { dateMeetingPresetId: undefined } : {}),
                    ...(c.chatPresetId === id ? { chatPresetId: undefined } : {}),
                    ...(c.callPresetId === id ? { callPresetId: undefined } : {}),
                });
            }
            for (const scene of GENERAL_SCENES) if (defaults[scene] === id) setSceneDefault(scene, undefined);
        } else {
            await DB.deleteStoryTheaterPreset(row.preset.id);
            if (defaults.story === row.preset.id) setSceneDefault('story', undefined);
        }
        addToast('已刪除', 'success');
        await reload();
    };
    const createFrom = async (what: 'chat-builtin' | 'call-builtin' | 'date-builtin' | 'story-builtin' | 'story-blank') => {
        setNewMenu(false);
        if (what === 'chat-builtin' || what === 'call-builtin') {
            const copy = await saveNewMeetingPresetDoc(duplicatePresetDoc(what === 'chat-builtin' ? buildBuiltinChatPresetDoc() : buildBuiltinCallPresetDoc()));
            addToast(`已從${what === 'chat-builtin' ? '私聊' : '電話'}內建複製成「${copy.name}」`, 'success');
            await reload();
            setManagingId(copy.id);
        } else if (what === 'date-builtin') {
            const copy = await copyBuiltinMeetingPreset();
            addToast(`已從見面內建規則複製成「${copy.name}」`, 'success');
            await reload();
            setManagingId(copy.id);
        } else {
            const preset = what === 'story-builtin' ? duplicateStoryPreset(BUILTIN_NIGHT_SCREENING_PRESET) : createBlankStoryPreset();
            await DB.saveStoryTheaterPreset(preset);
            await reload();
            setEditingStory(preset);
        }
        trackEvent('新建预设', { 来源: what === 'chat-builtin' ? '私聊内建' : what === 'call-builtin' ? '电话内建' : what === 'date-builtin' ? '见面内建' : what === 'story-builtin' ? '剧情内建' : '空白剧情' });
    };

    const toggleScene = async (record: MeetingPresetRecord, scene: PresetScene) => {
        const current = scenesOfPreset(record);
        const next = current.includes(scene) ? current.filter(s => s !== scene) : [...current, scene];
        if (!next.length) { addToast('至少留一個場景', 'info'); return; }
        await saveMeetingPresetDoc(record, { ...record.doc, scenes: GENERAL_SCENES.filter(s => next.includes(s)) });
        // 不用在這個場景了：也不再當這個場景的預設
        if (!next.includes(scene) && defaults[scene] === record.id) setSceneDefault(scene, undefined);
        await reload();
    };

    const rows: Row[] = useMemo(() => [
        ...(filter !== 'story' ? general.filter(r => filter === 'all' || scenesOfPreset(r).includes(filter)).map(record => ({ kind: 'general' as const, record })) : []),
        ...(filter === 'all' || filter === 'story' ? stories.map(preset => ({ kind: 'story' as const, preset })) : []),
    ], [general, stories, filter]);

    // 劇情預設的編輯器：整頁換過去（跟劇情劇場裡一樣）
    if (editingStory) {
        return (
            <StoryTheaterThemeProvider><StoryPresetMaker
                key={editingStory.id}
                preset={editingStory}
                onBack={() => { setEditingStory(null); void reload(); }}
                onSave={async next => { if (next.builtIn) return; await DB.saveStoryTheaterPreset(next); setEditingStory(next); addToast('劇情預設已保存', 'success'); }}
                onOpenCopy={async copy => { await DB.saveStoryTheaterPreset(copy); setEditingStory(copy); addToast('已複製成可編輯的一份', 'success'); }}
                onDelete={async preset => { await deleteRow({ kind: 'story', preset }); setEditingStory(null); }}
            /></StoryTheaterThemeProvider>
        );
    }

    const chip = (on: boolean) => `shrink-0 rounded-full px-3 py-1.5 text-[12px] font-bold transition ${on ? 'bg-slate-800 text-white' : 'bg-white text-slate-500 border border-slate-200'}`;
    const sel = 'min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-700';
    /** 這一列是哪些場景的場景預設 */
    const defaultScenes = (row: Row): PresetScene[] => row.kind === 'general'
        ? GENERAL_SCENES.filter(scene => defaults[scene] === row.record.id)
        : defaults.story === row.preset.id ? ['story'] : [];

    return (
        <div className="h-full w-full flex flex-col bg-slate-50 text-slate-800">
            <div className="shrink-0 bg-white/90 backdrop-blur border-b border-slate-100" style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="relative flex items-center justify-between px-3 py-3">
                    <button type="button" onClick={closeApp} aria-label="返回" className="p-1.5 rounded-full hover:bg-black/5"><CaretLeft size={22} weight="bold" className="text-slate-600" /></button>
                    <h1 className="absolute left-1/2 -translate-x-1/2 text-base font-bold">預設</h1>
                    <div className="flex items-center gap-1">
                        <button type="button" onClick={() => fileRef.current?.click()} disabled={busy} aria-label="匯入預設" className="p-2 rounded-full hover:bg-black/5 disabled:opacity-40"><UploadSimple size={20} className="text-slate-600" /></button>
                        <button type="button" onClick={() => setNewMenu(true)} aria-label="新建預設" className="p-2 rounded-full hover:bg-black/5"><Plus size={20} weight="bold" className="text-slate-600" /></button>
                    </div>
                </div>
            </div>
            <input ref={fileRef} type="file" accept=".json,.png,application/json,image/png" className="hidden" aria-label="選預設檔案"
                onChange={e => { const f = e.target.files?.[0]; if (f) void importFile(f); }} />

            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-4 space-y-4" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 2rem)' }}>
                {/* 場景預設 */}
                <div className="rounded-2xl bg-white p-4 shadow-sm space-y-3" data-scene-defaults>
                    <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">每個場景預設用哪份</div>
                    <p className="text-[11px] leading-relaxed text-slate-400">角色在聊天設定、見面設定，劇情在編輯頁自己選了的，照它自己的；沒選的就用這裡。</p>
                    <label className="flex items-center gap-3">
                        <span className="w-12 shrink-0 text-[13px] font-bold text-slate-600">私聊</span>
                        <select aria-label="私聊的場景預設" className={sel} value={defaults.chat || ''} onChange={e => setSceneDefault('chat', e.target.value)}>
                            <option value="">內建</option>
                            {general.filter(r => scenesOfPreset(r).includes('chat')).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                        </select>
                    </label>
                    <label className="flex items-center gap-3">
                        <span className="w-12 shrink-0 text-[13px] font-bold text-slate-600">電話</span>
                        <select aria-label="電話的場景預設" className={sel} value={defaults.call || ''} onChange={e => setSceneDefault('call', e.target.value)}>
                            <option value="">內建</option>
                            {general.filter(r => scenesOfPreset(r).includes('call')).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                        </select>
                    </label>
                    <label className="flex items-center gap-3">
                        <span className="w-12 shrink-0 text-[13px] font-bold text-slate-600">見面</span>
                        <select aria-label="見面的場景預設" className={sel} value={defaults.date || ''} onChange={e => setSceneDefault('date', e.target.value)}>
                            <option value="">內建規則</option>
                            {general.filter(r => scenesOfPreset(r).includes('date')).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                        </select>
                    </label>
                    <label className="flex items-center gap-3">
                        <span className="w-12 shrink-0 text-[13px] font-bold text-slate-600">劇情</span>
                        <select aria-label="劇情的場景預設" className={sel} value={defaults.story || ''} onChange={e => setSceneDefault('story', e.target.value)}>
                            <option value="">（新劇情用第一份）</option>
                            {storyAll.map(p => <option key={p.id} value={p.id}>{p.name}{p.builtIn ? '（內建）' : ''}</option>)}
                        </select>
                    </label>
                    {FUTURE_SCENES.map(scene => (
                        <div key={scene} className="flex items-center gap-3 opacity-50">
                            <span className="w-12 shrink-0 text-[13px] font-bold text-slate-500">{PRESET_SCENE_LABEL[scene]}</span>
                            <span className="text-[12px] text-slate-400">內建（自訂預設之後開放）</span>
                        </div>
                    ))}
                </div>

                {/* 篩選 */}
                <div className="flex gap-2 overflow-x-auto no-scrollbar">
                    {([['all', '全部'], ['chat', '私聊'], ['call', '電話'], ['date', '見面'], ['story', '劇情']] as const).map(([k, label]) => (
                        <button key={k} type="button" onClick={() => setFilter(k)} className={chip(filter === k)}>{label}</button>
                    ))}
                </div>

                {/* 清單 */}
                <div className="space-y-2">
                    {(filter === 'all' || filter === 'chat') && (
                        <div className="flex items-center gap-3 rounded-2xl border border-dashed border-slate-200 bg-white/60 px-4 py-3">
                            <div className="min-w-0 flex-1">
                                <div className="text-[13px] font-bold text-slate-600">私聊 · 內建</div>
                                <div className="text-[11px] text-slate-400">現在私聊送的那套，表情包、轉帳這些功能都是條目；想改就複製一份</div>
                            </div>
                            <button type="button" onClick={() => void createFrom('chat-builtin')} className="shrink-0 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600">複製一份</button>
                        </div>
                    )}
                    {(filter === 'all' || filter === 'call') && (
                        <div className="flex items-center gap-3 rounded-2xl border border-dashed border-slate-200 bg-white/60 px-4 py-3">
                            <div className="min-w-0 flex-1">
                                <div className="text-[13px] font-bold text-slate-600">電話 · 內建</div>
                                <div className="text-[11px] text-slate-400">現在講電話送的那套，語音演出、視訊表演都是條目；想改就複製一份</div>
                            </div>
                            <button type="button" onClick={() => void createFrom('call-builtin')} className="shrink-0 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600">複製一份</button>
                        </div>
                    )}
                    {(filter === 'all' || filter === 'date') && (
                        <div className="flex items-center gap-3 rounded-2xl border border-dashed border-slate-200 bg-white/60 px-4 py-3">
                            <div className="min-w-0 flex-1">
                                <div className="text-[13px] font-bold text-slate-600">見面 · 內建規則</div>
                                <div className="text-[11px] text-slate-400">寫在程式裡的那套；想改就複製一份</div>
                            </div>
                            <button type="button" onClick={() => void createFrom('date-builtin')} className="shrink-0 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600">複製一份</button>
                        </div>
                    )}
                    {(filter === 'all' || filter === 'story') && (
                        <div className="flex items-center gap-3 rounded-2xl border border-dashed border-slate-200 bg-white/60 px-4 py-3">
                            <div className="min-w-0 flex-1">
                                <div className="text-[13px] font-bold text-slate-600">劇情 · {BUILTIN_NIGHT_SCREENING_PRESET.name}（內建）</div>
                                <div className="text-[11px] text-slate-400">劇情劇場內建的那套</div>
                            </div>
                            <button type="button" onClick={() => setEditingStory(BUILTIN_NIGHT_SCREENING_PRESET)} className="shrink-0 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600">看看</button>
                        </div>
                    )}
                    {rows.length === 0 && <div className="py-10 text-center text-xs text-slate-400">還沒有自己的預設。右上角可以匯入 SillyTavern 預設，或從內建複製一份。</div>}
                    {rows.map(row => {
                        const name = row.kind === 'general' ? row.record.name : row.preset.name;
                        const sub = row.kind === 'general'
                            ? `開 ${row.record.doc.prompts.filter(p => p.enabled).length} / ${row.record.doc.prompts.length} 條 · 正則 ${row.record.doc.regexScripts.length}`
                            : `開 ${row.preset.document.prompts.filter(p => p.enabled).length} / ${row.preset.document.prompts.length} 條`;
                        const key = row.kind === 'general' ? row.record.id : row.preset.id;
                        return (
                            <div key={key} className="flex items-center gap-2 rounded-2xl bg-white px-4 py-3 shadow-sm" data-preset-row={row.kind}>
                                <button type="button" onClick={() => (row.kind === 'general' ? setManagingId(row.record.id) : setEditingStory(row.preset))} className="min-w-0 flex-1 text-left">
                                    <div className="flex items-center gap-1.5 min-w-0">
                                        <span className="truncate text-[14px] font-bold text-slate-700">{name}</span>
                                        {defaultScenes(row).length > 0 && <span className="shrink-0 rounded-full bg-emerald-50 border border-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-600">{defaultScenes(row).map(s => PRESET_SCENE_LABEL[s]).join('、')}預設</span>}
                                    </div>
                                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                                        {row.kind === 'general'
                                            ? scenesOfPreset(row.record).map(s => <span key={s} className="rounded-full bg-indigo-50 px-1.5 py-0.5 text-[10px] font-bold text-indigo-500">{PRESET_SCENE_LABEL[s]}</span>)
                                            : <span className="rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-bold text-rose-500">劇情專用</span>}
                                        <span>{sub}</span>
                                    </div>
                                </button>
                                <button type="button" onClick={() => setMenu(row)} aria-label={`${name} 的更多操作`} className="shrink-0 p-1.5 text-slate-400"><DotsThree size={22} weight="bold" /></button>
                            </div>
                        );
                    })}
                </div>
                <p className="px-1 text-[10px] leading-relaxed text-slate-400">
                    通用預設是 SillyTavern 的對話補全格式，可以匯入、匯出 ST，現在用在私聊、電話和見面，之後群聊也會用這種。電話要短句，長篇的 ST 預設套到電話常常太囉嗦，電話可以另外選一份。私聊用匯入的預設時，文風照預設的，表情包、轉帳這些 Soren 功能照常補上；主動消息、即時對話這種在雲端生成的也照同一份。劇情專用的是劇情劇場自己的格式（分區、快捷選項靠它跑），只能用在劇情。匯入的預設、正則不轉繁體。
                </p>
            </div>

            {/* 新建 */}
            {newMenu && (
                <div className="fixed inset-0 z-[300] flex items-end justify-center bg-black/40" onClick={() => setNewMenu(false)}>
                    <div className="w-full max-w-md rounded-t-3xl bg-white p-3 pb-[calc(var(--safe-bottom,0px)+12px)]" onClick={e => e.stopPropagation()}>
                        {([['chat-builtin', '從私聊內建複製（通用）'], ['call-builtin', '從電話內建複製（通用）'], ['date-builtin', '從見面內建規則複製（通用）'], ['story-builtin', `從劇情內建「${BUILTIN_NIGHT_SCREENING_PRESET.name}」複製`], ['story-blank', '空白劇情預設']] as const).map(([k, label]) => (
                            <button key={k} type="button" onClick={() => void createFrom(k)} className="w-full rounded-xl px-4 py-3 text-left text-sm text-slate-700 active:bg-slate-50">{label}</button>
                        ))}
                        <button type="button" onClick={() => { setNewMenu(false); fileRef.current?.click(); }} className="w-full rounded-xl px-4 py-3 text-left text-sm text-slate-700 active:bg-slate-50">匯入檔案（SillyTavern 預設／劇情預設）</button>
                        <button type="button" onClick={() => setNewMenu(false)} className="w-full rounded-xl px-4 py-3 text-sm text-slate-400">取消</button>
                    </div>
                </div>
            )}

            {/* 每列的更多操作 */}
            {menu && (
                <div className="fixed inset-0 z-[300] flex items-end justify-center bg-black/40" onClick={() => setMenu(null)}>
                    <div className="w-full max-w-md rounded-t-3xl bg-white p-3 pb-[calc(var(--safe-bottom,0px)+12px)]" onClick={e => e.stopPropagation()}>
                        <div className="truncate px-4 py-2 text-xs text-slate-400">{menu.kind === 'general' ? menu.record.name : menu.preset.name}</div>
                        {menu.kind === 'general' && (
                            <div className="flex items-center gap-2 px-4 py-2" data-scene-toggles>
                                <span className="text-[12px] text-slate-500">適用場景</span>
                                {GENERAL_SCENES.map(scene => {
                                    const on = scenesOfPreset(menu.record).includes(scene);
                                    return (
                                        <button key={scene} type="button" aria-pressed={on} onClick={() => { const record = menu.record; setMenu(null); void toggleScene(record, scene); }}
                                            className={`rounded-full px-3 py-1 text-[12px] font-bold ${on ? 'bg-indigo-500 text-white' : 'bg-slate-100 text-slate-400'}`}>{PRESET_SCENE_LABEL[scene]}</button>
                                    );
                                })}
                            </div>
                        )}
                        {([
                            ['管理', () => (menu.kind === 'general' ? setManagingId(menu.record.id) : setEditingStory(menu.preset)), 'text-slate-700'],
                            ...(menu.kind === 'general' ? scenesOfPreset(menu.record).filter(s => GENERAL_SCENES.includes(s)) : (['story'] as PresetScene[])).map(scene => {
                                const id = menu.kind === 'general' ? menu.record.id : menu.preset.id;
                                const on = defaults[scene] === id;
                                return [on ? `取消${PRESET_SCENE_LABEL[scene]}的場景預設` : `設成${PRESET_SCENE_LABEL[scene]}的場景預設`, () => setSceneDefault(scene, on ? undefined : id), 'text-slate-700'] as const;
                            }),
                            ['複製一份', () => duplicateRow(menu), 'text-slate-700'],
                            [menu.kind === 'general' ? '匯出（SillyTavern .json）' : '匯出', () => exportRow(menu), 'text-slate-700'],
                            ['刪除', () => deleteRow(menu), 'text-red-500'],
                        ] as const).map(([label, action, cls]) => (
                            <button key={label} type="button" onClick={() => { setMenu(null); void action(); }} className={`w-full rounded-xl px-4 py-3 text-left text-sm active:bg-slate-50 ${cls}`}>{label}</button>
                        ))}
                        <button type="button" onClick={() => setMenu(null)} className="w-full rounded-xl px-4 py-3 text-sm text-slate-400">取消</button>
                    </div>
                </div>
            )}

            {managingId && <MeetingPresetManager presetId={managingId} onClose={() => { setManagingId(null); void reload(); }} />}
        </div>
    );
};

export default PresetApp;
