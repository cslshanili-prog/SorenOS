import React, { useMemo, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, Copy, DownloadSimple, FloppyDisk, LockSimple, Plus, Trash } from '@phosphor-icons/react';
import type { StoryTheaterPreset, StoryTheaterPresetDocument, StoryTheaterPresetPrompt } from '../../../types';
import {
    applyStoryPresetChoice,
    addStoryPresetGroup,
    renameStoryPresetGroup,
    ungroupStoryPresetGroup,
    moveStoryPresetPromptToGroup,
    downloadStoryPreset,
    duplicateStoryPreset,
    getStoryPresetPromptGroups,
    isProtectedStoryPrompt,
    isStoryPresetSectionMarker,
    makeStoryTheaterId,
} from '../../../utils/storyTheater';

interface Props {
    preset: StoryTheaterPreset;
    onBack: () => void;
    onSave: (preset: StoryTheaterPreset) => Promise<void> | void;
    onOpenCopy: (preset: StoryTheaterPreset) => Promise<void> | void;
    onDelete?: (preset: StoryTheaterPreset) => Promise<void> | void;
}

export interface StoryPresetSimpleChoice {
    label: string;
    hint: string;
    ids: readonly string[];
    options: Array<{ id?: string; label: string }>;
}

export const STORY_PRESET_SIMPLE_CHOICES: StoryPresetSimpleChoice[] = [
    {
        label: '文風', hint: '決定這場故事讀起來是什麼質感',
        ids: ['nmj-v3-style-custom', 'nmj-v3-style-soda', 'nmj-v3-style-corridor', 'nmj-v3-style-comedy', 'nmj-v3-style-darkcomedy', 'nmj-v3-style-syrup', 'nmj-v3-style-dullknife', 'nmj-v3-style-drama'],
        options: [{ label: '默認質感' }, { id: 'nmj-v3-style-soda', label: '汽水日常' }, { id: 'nmj-v3-style-corridor', label: '潮雨走廊' }, { id: 'nmj-v3-style-comedy', label: '荒誕喜劇' }, { id: 'nmj-v3-style-darkcomedy', label: '黑喜劇' }, { id: 'nmj-v3-style-syrup', label: '直球甜寵' }, { id: 'nmj-v3-style-dullknife', label: '鈍刀虐心' }, { id: 'nmj-v3-style-drama', label: '冷峻正劇' }],
    },
    {
        label: '人稱', hint: '決定鏡頭如何稱呼你當前執筆的身份',
        ids: ['nmj-v3-pov-second', 'nmj-v3-pov-third'],
        options: [{ id: 'nmj-v3-pov-second', label: '第二人稱' }, { id: 'nmj-v3-pov-third', label: '第三人稱' }],
    },
    {
        label: '輸入轉述', hint: '你給出的構想要先拍出來，還是視作已經發生',
        ids: ['nmj-v62-retelling-replay', 'nmj-v62-retelling-direct'],
        options: [{ id: 'nmj-v62-retelling-replay', label: '回放擴寫' }, { id: 'nmj-v62-retelling-direct', label: '直接接戲' }],
    },
    {
        label: '你的執筆權', hint: '故事可以替你當前執筆的身份寫到什麼程度',
        ids: ['nmj-v63-user-agency-locked', 'nmj-v63-user-agency-assist', 'nmj-v63-user-agency-auto'],
        options: [{ id: 'nmj-v63-user-agency-locked', label: '完全不代寫' }, { id: 'nmj-v63-user-agency-assist', label: '有限協演' }, { id: 'nmj-v63-user-agency-auto', label: '全自動演繹' }],
    },
    {
        label: '場景張力', hint: '只調整當前故事的情緒壓力',
        ids: ['nmj-v64-tension-lowfever-1', 'nmj-v64-tension-lowfever-2', 'nmj-v64-tension-lowfever-3'],
        options: [{ label: '自然' }, { id: 'nmj-v64-tension-lowfever-1', label: '低燒 I' }, { id: 'nmj-v64-tension-lowfever-2', label: '低燒 II' }, { id: 'nmj-v64-tension-lowfever-3', label: '低燒 III' }],
    },
    {
        label: '小劇場', hint: '正文結束後追加一段獨立的邊角頻道',
        ids: ['nmj-v3-theater-ai', 'nmj-v3-theater-user-sim', 'nmj-v3-theater-group', 'nmj-v3-theater-random', 'nmj-v6-side-channel-terminal', 'nmj-v6-side-channel-evidence', 'nmj-v6-side-channel-public', 'nmj-v6-side-channel-wrong-reel', 'nmj-v3-theater-custom'],
        options: [{ label: '關閉' }, { id: 'nmj-v3-theater-ai', label: '角色與你' }, { id: 'nmj-v3-theater-user-sim', label: '你的倒影' }, { id: 'nmj-v3-theater-group', label: '你和角色們' }, { id: 'nmj-v3-theater-random', label: '隨機換台' }, { id: 'nmj-v6-side-channel-terminal', label: '終端殘響' }, { id: 'nmj-v6-side-channel-evidence', label: '失物與物證' }, { id: 'nmj-v6-side-channel-public', label: '公共頻段' }, { id: 'nmj-v6-side-channel-wrong-reel', label: '錯卷放映' }],
    },
    {
        label: '語言', hint: '正文使用哪一種中文',
        ids: ['nmj-v3-language-cn', 'nmj-v3-language-tw'],
        options: [{ id: 'nmj-v3-language-cn', label: '簡體中文' }, { id: 'nmj-v3-language-tw', label: '繁體中文' }],
    },
    {
        label: '篇幅', hint: '每次續寫的大致長度',
        ids: ['nmj-v3-length-short', 'nmj-v3-length-medium', 'nmj-v3-length-long'],
        options: [{ id: 'nmj-v3-length-short', label: '短' }, { id: 'nmj-v3-length-medium', label: '中' }, { id: 'nmj-v3-length-long', label: '長' }],
    },
];

const STORY_ROLE_LABELS: Record<StoryTheaterPresetPrompt['role'], string> = {
    system: '規則',
    user: '你',
    assistant: '正文',
};

const STORY_GENERATION_FIELDS = [
    ['temperature', '溫度', 'Temperature', 0, 2, 0.05, '越低越穩定，越高越自由。Claude 只接受 0–1；預設高於 1 時，Claude 請求會自動按 1 發送。'],
    ['topP', '候選範圍', 'Top P', 0, 1, 0.01, '另一種隨機度控制。通常保持預設值即可，不建議和溫度一起大幅調整。'],
    ['frequencyPenalty', '重複懲罰', 'Frequency penalty', -2, 2, 0.05, '正值會減少重複措辭，負值會允許更多復現。部分 Claude 中轉會忽略這項。'],
    ['presencePenalty', '話題懲罰', 'Presence penalty', -2, 2, 0.05, '正值更願意引入新內容，負值更願意圍繞已有內容繼續。部分 Claude 中轉會忽略這項。'],
    ['maxTokens', '最大輸出', 'Max tokens', 256, 32000, 256, '只限制本輪最多能生成多少，不代表每次一定寫滿；篇幅仍主要由上面的“篇幅”選項決定。'],
] as const;

const StoryPresetMaker: React.FC<Props> = ({ preset, onBack, onSave, onOpenCopy, onDelete }) => {
    const [draft, setDraft] = useState<StoryTheaterPreset>(() => ({
        ...preset,
        document: { ...preset.document, generation: { ...preset.document.generation }, prompts: preset.document.prompts.map(item => ({ ...item })) },
    }));
    const [mode, setMode] = useState<'simple' | 'pro'>('simple');
    const [activeGroupKey, setActiveGroupKey] = useState<string | null>(null);
    const [selectedId, setSelectedId] = useState('');
    const [saving, setSaving] = useState(false);
    const [newGroupName, setNewGroupName] = useState('');
    const readOnly = preset.builtIn === true;
    const groups = useMemo(() => getStoryPresetPromptGroups(draft.document), [draft.document]);
    const activeGroup = groups.find(group => group.key === activeGroupKey) || null;
    const activePrompts = useMemo(() => {
        if (!activeGroup) return [];
        const ids = new Set(activeGroup.promptIds);
        return draft.document.prompts.filter(prompt => ids.has(prompt.id) && !isStoryPresetSectionMarker(prompt));
    }, [activeGroup, draft.document.prompts]);
    const selected = activePrompts.find(prompt => prompt.id === selectedId) || null;

    const replaceDocument = (document: StoryTheaterPresetDocument) => setDraft(current => ({ ...current, name: document.name, document, updatedAt: Date.now() }));
    const patchDocument = (patch: Partial<StoryTheaterPresetDocument>) => replaceDocument({ ...draft.document, ...patch });
    const patchPrompt = (id: string, patch: Partial<StoryTheaterPresetPrompt>) => patchDocument({
        prompts: draft.document.prompts.map(prompt => prompt.id === id ? { ...prompt, ...patch } : prompt),
    });
    const selectSimpleChoice = (choice: StoryPresetSimpleChoice, id?: string) => {
        if (readOnly) return;
        replaceDocument(applyStoryPresetChoice(draft.document, choice.ids, id));
    };
    const moveGroup = (key: string, direction: -1 | 1) => {
        if (readOnly) return;
        const ordered = [...groups];
        const index = ordered.findIndex(group => group.key === key);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= ordered.length) return;
        [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
        const byId = new Map(draft.document.prompts.map(prompt => [prompt.id, prompt]));
        patchDocument({ prompts: ordered.flatMap(group => group.promptIds.map(id => byId.get(id)).filter((prompt): prompt is StoryTheaterPresetPrompt => Boolean(prompt))) });
    };
    const movePrompt = (id: string, direction: -1 | 1) => {
        const index = activePrompts.findIndex(prompt => prompt.id === id);
        const target = index + direction;
        if (readOnly || index < 0 || target < 0 || target >= activePrompts.length) return;
        const prompts = [...draft.document.prompts];
        const fromIndex = prompts.findIndex(prompt => prompt.id === id);
        const toIndex = prompts.findIndex(prompt => prompt.id === activePrompts[target].id);
        [prompts[fromIndex], prompts[toIndex]] = [prompts[toIndex], prompts[fromIndex]];
        patchDocument({ prompts });
    };
    const addPrompt = () => {
        if (!activeGroup || activeGroup.protected || readOnly) return;
        const next: StoryTheaterPresetPrompt = { id: makeStoryTheaterId(), name: '新提示詞', enabled: true, role: 'system', content: '' };
        const prompts = [...draft.document.prompts];
        const last = prompts[activeGroup.endIndex];
        const insertAt = last && isStoryPresetSectionMarker(last) ? activeGroup.endIndex : activeGroup.endIndex + 1;
        prompts.splice(insertAt, 0, next);
        patchDocument({ prompts });
        setSelectedId(next.id);
    };
    const addGroup = () => {
        if (readOnly || !newGroupName.trim()) return;
        const document = addStoryPresetGroup(draft.document, newGroupName);
        replaceDocument(document);
        const added = getStoryPresetPromptGroups(document).at(-1);
        setActiveGroupKey(added?.key || null);
        setSelectedId('');
        setNewGroupName('');
    };
    const removePrompt = (id: string) => {
        const prompt = draft.document.prompts.find(item => item.id === id);
        if (!prompt || readOnly || isProtectedStoryPrompt(prompt)) return;
        patchDocument({ prompts: draft.document.prompts.filter(item => item.id !== id) });
        if (selectedId === id) setSelectedId('');
    };
    const save = async () => {
        if (readOnly) { await onOpenCopy(duplicateStoryPreset(draft)); return; }
        setSaving(true);
        try { await onSave({ ...draft, name: draft.document.name.trim() || '未命名劇情預設', updatedAt: Date.now() }); }
        finally { setSaving(false); }
    };

    const renderGenerationFields = () => <>
        <div className='mt-5 divide-y divide-slate-200 border-y border-slate-200'>
            {STORY_GENERATION_FIELDS.map(([key, label, technicalLabel, min, max, step, help]) => <label key={key} className='block py-4'>
                <span className='flex items-center gap-4'><span className='min-w-0 flex-1'><strong className='block text-xs text-slate-700'>{label}</strong><span className='mt-0.5 block text-[8px] uppercase tracking-wide text-slate-400'>{technicalLabel}</span></span><input disabled={readOnly} type='number' min={min} max={max} step={step} value={draft.document.generation[key]} onChange={event => patchDocument({ generation: { ...draft.document.generation, [key]: Number(event.target.value) } })} className='w-24 shrink-0 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-right text-sm font-semibold outline-none disabled:opacity-50' /></span>
                <span className='mt-2 block text-[9px] leading-4 text-slate-400'>{help}</span>
            </label>)}
        </div>
        {draft.document.generation.temperature > 1 && <p className='mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[10px] leading-5 text-amber-800'>當前溫度高於 1：OpenAI 類模型會保留這個值；使用 Claude 時會自動按 1.0 發送，避免第三方中轉直接返回 400。</p>}
    </>;

    const renderGeneration = () => <section>
        <button onClick={() => setActiveGroupKey(null)} className='mb-5 text-[10px] font-bold text-violet-600'>← 返回大分類</button>
        <div className='text-[9px] uppercase tracking-[.22em] font-bold text-violet-500'>Professional</div><h2 className='mt-1 text-2xl font-serif font-semibold'>續寫參數</h2>
        <p className='mt-2 text-[10px] leading-5 text-slate-500'>這些值會跟著預設保存。一般保持原值；接口報參數錯誤時再按提示調整。</p>
        {renderGenerationFields()}
        <label className='block mt-4'><span className='text-[10px] text-slate-500'>正文起筆</span><textarea disabled={readOnly} value={draft.document.assistantPrefill || ''} onChange={event => patchDocument({ assistantPrefill: event.target.value })} className='mt-1 w-full min-h-24 p-3 rounded-xl bg-white border border-slate-200 font-mono text-[11px] disabled:opacity-50' /></label>
    </section>;

    const renderGroupDetails = () => {
        if (!activeGroup) return null;
        return <section>
            <button onClick={() => { setActiveGroupKey(null); setSelectedId(''); }} className='mb-5 text-[10px] font-bold text-violet-600'>← 返回大分類</button>
            <div className='flex items-start justify-between gap-4'><div><div className='text-[9px] uppercase tracking-[.22em] font-bold text-violet-500'>Professional</div><h2 className='mt-1 text-2xl font-serif font-semibold'>{activeGroup.label}</h2><p className='mt-2 text-[10px] leading-5 text-slate-500'>{activeGroup.description}</p></div>{activeGroup.protected && <span className='shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-100 text-[9px] font-bold text-amber-700'><LockSimple size={12} />受保護</span>}</div>
            {activeGroup.protected && <div className='mt-5 p-4 rounded-2xl bg-amber-50 border border-amber-200 text-[11px] leading-6 text-amber-800'>這裡是糯米機連接角色、你的身份、世界書與歷史的骨架。可以上下調整發送順序，但不能修改內容、開關、消息位置或類型，也不能刪除。</div>}
            {activeGroup.customSectionId && !readOnly && <div className='mt-5 space-y-3'>
                <label className='block text-xs text-slate-500'>分組名稱<input aria-label='分組名稱' value={activeGroup.label} onChange={event => replaceDocument(renameStoryPresetGroup(draft.document, activeGroup.customSectionId!, event.target.value))} onBlur={event => replaceDocument(renameStoryPresetGroup(draft.document, activeGroup.customSectionId!, event.target.value.trim() || '自定義分組'))} className='mt-2 w-full p-3 rounded-xl bg-white border border-slate-200 text-slate-800' /></label>
                <button onClick={() => { replaceDocument(ungroupStoryPresetGroup(draft.document, activeGroup.customSectionId!)); setActiveGroupKey(null); setSelectedId(''); }} className='text-xs text-slate-500 underline'>取消分組，保留所有條目</button>
            </div>}
            <div className='mt-5 border-y border-slate-200 divide-y divide-slate-200'>
                {activePrompts.map((prompt, index) => { const locked = activeGroup.protected || isProtectedStoryPrompt(prompt); return <div key={prompt.id} className={`flex items-center gap-2 py-3 ${selectedId === prompt.id ? 'text-violet-700' : ''}`}>
                    <button disabled={readOnly || locked} onClick={() => patchPrompt(prompt.id, { enabled: !prompt.enabled })} className={`w-9 shrink-0 text-[9px] font-bold disabled:opacity-50 ${prompt.enabled ? 'text-emerald-600' : 'text-slate-300'}`}>{prompt.enabled ? 'ON' : 'OFF'}</button>
                    <button onClick={() => setSelectedId(prompt.id)} className='min-w-0 flex-1 text-left'><span className='block text-xs font-semibold truncate'>{index + 1}. {prompt.name}</span><span className='block mt-1 text-[9px] text-slate-400'>{locked ? '系統連接位 · 內容鎖定' : STORY_ROLE_LABELS[prompt.role]}</span></button>
                    {!readOnly && <span className='flex shrink-0'><button disabled={index === 0} onClick={() => movePrompt(prompt.id, -1)} className='p-1.5 text-slate-400 disabled:opacity-20'><ArrowUp size={14} /></button><button disabled={index === activePrompts.length - 1} onClick={() => movePrompt(prompt.id, 1)} className='p-1.5 text-slate-400 disabled:opacity-20'><ArrowDown size={14} /></button>{!locked && <button onClick={() => removePrompt(prompt.id)} className='p-1.5 text-rose-400'><Trash size={14} /></button>}</span>}
                </div>; })}
            </div>
            {!activeGroup.protected && !readOnly && <button onClick={addPrompt} className='mt-4 h-10 px-4 rounded-xl bg-white border border-slate-200 text-xs font-bold flex items-center gap-1'><Plus size={14} />在本區新增提示詞</button>}
            {selected && <div className='mt-7 pt-6 border-t border-slate-200'>
                {activeGroup.protected || isProtectedStoryPrompt(selected) ? <div className='py-8 text-center'><LockSimple size={28} className='mx-auto text-amber-400' /><div className='mt-2 text-xs font-bold'>系統連接內容已鎖定</div><p className='mt-1 text-[10px] text-slate-400'>你仍可以在上方調整它與其他連接位的順序。</p></div> : <>
                    <div className='grid grid-cols-2 gap-3'><label><span className='text-[10px] text-slate-500'>名稱</span><input disabled={readOnly} value={selected.name} onChange={event => patchPrompt(selected.id, { name: event.target.value })} className='mt-1 w-full px-3 py-2.5 rounded-xl bg-white border border-slate-200 text-xs' /></label><label><span className='text-[10px] text-slate-500'>消息位置</span><select disabled={readOnly} value={selected.role} onChange={event => patchPrompt(selected.id, { role: event.target.value as StoryTheaterPresetPrompt['role'] })} className='mt-1 w-full px-3 py-2.5 rounded-xl bg-white border border-slate-200 text-xs'><option value='system'>規則</option><option value='user'>你</option><option value='assistant'>正文</option></select></label></div>
                    <textarea disabled={readOnly} value={selected.content} onChange={event => patchPrompt(selected.id, { content: event.target.value })} className='mt-3 w-full min-h-64 p-4 rounded-2xl bg-white border border-slate-200 font-mono text-[11px] leading-6 resize-y' placeholder='支持 {{user}} / {{char}} / {{group}}' />
                    {!readOnly && <label className='mt-3 block text-xs text-slate-500'>移動到分組<select aria-label='移動到分組' value='' onChange={event => { const target = event.target.value; if (!target) return; replaceDocument(moveStoryPresetPromptToGroup(draft.document, selected.id, target)); setActiveGroupKey(target); }} className='mt-2 w-full p-3 rounded-xl bg-white border border-slate-200'><option value=''>選擇目標分組</option>{groups.filter(group => !group.protected && group.key !== activeGroup.key).map(group => <option key={group.key} value={group.key}>{group.label}</option>)}</select></label>}
                </>}
            </div>}
        </section>;
    };

    return <div className='h-full w-full flex flex-col bg-stone-100 text-slate-800'>
        <header className='story-safe-header shrink-0 border-b border-slate-200'>
            <div className='h-16 px-4 flex items-center gap-3'>
                <button onClick={onBack} className='w-9 h-9 rounded-full grid place-items-center'><ArrowLeft size={20} /></button>
                <div className='min-w-0 flex-1'><div className='text-[9px] uppercase tracking-[.24em] font-bold text-violet-500'>Preset maker</div><div className='font-semibold truncate'>預設製作器</div></div>
                {readOnly && <span className='hidden sm:inline-flex text-[9px] px-2 py-1 rounded-full bg-amber-100 text-amber-700 font-bold'>內置只讀</span>}
                <button onClick={() => { void downloadStoryPreset(draft); }} className='w-9 h-9 shrink-0 rounded-full bg-white border border-slate-200 grid place-items-center' title='導出糯米機原生預設'><DownloadSimple size={16} /></button>
                <button onClick={save} className='h-9 px-3 rounded-full bg-slate-900 text-white text-xs font-bold flex items-center gap-1.5'>{readOnly ? <Copy size={14} /> : <FloppyDisk size={14} />}{readOnly ? '複製調整' : saving ? '保存中' : '保存'}</button>
            </div>
            <div className='mx-5 mb-4 grid grid-cols-2 p-1 rounded-xl bg-slate-200'>
                <button onClick={() => { setMode('simple'); setActiveGroupKey(null); }} className={`py-2 rounded-lg text-xs font-bold ${mode === 'simple' ? 'bg-white shadow-sm text-violet-700' : 'text-slate-500'}`}>默認版</button>
                <button onClick={() => setMode('pro')} className={`py-2 rounded-lg text-xs font-bold ${mode === 'pro' ? 'bg-white shadow-sm text-violet-700' : 'text-slate-500'}`}>專業版</button>
            </div>
        </header>

        <main className='story-page-scroll flex-1 overflow-y-auto px-5 py-6 pb-24'>
            <div className='max-w-2xl mx-auto'>
                {mode === 'simple' ? <>
                    <section className='pb-5 border-b border-slate-200'><div className='text-[9px] uppercase tracking-[.22em] font-bold text-violet-500'>Easy controls</div><h1 className='mt-1 text-3xl font-serif font-semibold'>只調看得懂的部分</h1><p className='mt-3 text-[11px] leading-6 text-slate-500'>角色、世界書、歷史注入和底層發送結構由糯米機照管。這裡的選擇不會修改角色檔案。</p>{readOnly && <p className='mt-3 text-[10px] text-amber-700'>這是內置原版。點右上角“複製調整”後即可保存你的選擇。</p>}</section>
                    <div className='divide-y divide-slate-200'>{STORY_PRESET_SIMPLE_CHOICES.filter(choice => choice.ids.some(id => draft.document.prompts.some(prompt => prompt.id === id))).map(choice => {
                        const active = choice.ids.find(id => draft.document.prompts.find(prompt => prompt.id === id)?.enabled);
                        return <section key={choice.label} className='py-6'><h2 className='text-sm font-bold'>{choice.label}</h2><p className='mt-1 text-[10px] text-slate-400'>{choice.hint}</p><div className='mt-3 flex flex-wrap gap-2'>{choice.options.map(option => { const selectedOption = option.id ? active === option.id : !active; return <button key={option.id || 'default'} disabled={readOnly} onClick={() => selectSimpleChoice(choice, option.id)} className={`px-3 py-2 rounded-full border text-[11px] font-semibold disabled:opacity-60 ${selectedOption ? 'bg-slate-900 border-slate-900 text-white' : 'bg-white border-slate-200 text-slate-600'}`}>{option.label}</button>; })}</div></section>;
                    })}</div>
                    <section className='py-6 border-t border-slate-200'><h2 className='text-sm font-bold'>續寫參數</h2><p className='mt-1 text-[10px] leading-5 text-slate-400'>跟著這份預設保存；看不懂時保持原值即可。</p>{renderGenerationFields()}</section>
                    {!readOnly && <section className='pt-5 border-t border-slate-200'><label><span className='text-[10px] font-bold text-slate-500'>預設名稱</span><input value={draft.document.name} onChange={event => patchDocument({ name: event.target.value })} className='mt-2 w-full px-3 py-3 rounded-xl bg-white border border-slate-200 text-sm' /></label></section>}
                </> : activeGroupKey === '__generation__' ? renderGeneration() : activeGroup ? renderGroupDetails() : <>
                    <section className='pb-5 border-b border-slate-200'><div className='text-[9px] uppercase tracking-[.22em] font-bold text-violet-500'>Professional</div><h1 className='mt-1 text-3xl font-serif font-semibold'>先選大區，再看細節</h1><p className='mt-3 text-[11px] leading-6 text-slate-500'>手機上一次只展開一個區。上下箭頭移動整區；進入大區後才會顯示內部條目。</p></section>
                    {!readOnly && <div className='flex gap-2 py-4'><input aria-label='新分組名稱' value={newGroupName} onChange={event => setNewGroupName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') addGroup(); }} placeholder='新分組名稱' className='min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs' /><button disabled={!newGroupName.trim()} onClick={addGroup} className='shrink-0 flex items-center gap-1 rounded-xl bg-slate-900 px-3 py-2 text-xs font-bold text-white disabled:opacity-40'><Plus size={14} />新增分組</button></div>}
                    <div className='divide-y divide-slate-200'>{groups.map((group, index) => {
                        const groupPrompts = draft.document.prompts.filter(prompt => group.promptIds.includes(prompt.id) && !isStoryPresetSectionMarker(prompt));
                        const enabled = groupPrompts.filter(prompt => prompt.enabled).length;
                        return <div key={group.key} className='py-4 flex items-center gap-3'><button onClick={() => { setActiveGroupKey(group.key); setSelectedId(''); }} className='min-w-0 flex-1 text-left'><span className='flex items-center gap-2'><strong className='text-sm'>{group.label}</strong>{group.protected && <LockSimple size={13} className='text-amber-500' />}</span><span className='block mt-1 text-[10px] text-slate-400 truncate'>{group.description}</span><span className='block mt-1 text-[9px] text-violet-500'>{enabled}/{groupPrompts.length} 條啟用</span></button>{!readOnly && <span className='flex shrink-0'><button disabled={index === 0} onClick={() => moveGroup(group.key, -1)} className='p-2 text-slate-400 disabled:opacity-20'><ArrowUp size={15} /></button><button disabled={index === groups.length - 1} onClick={() => moveGroup(group.key, 1)} className='p-2 text-slate-400 disabled:opacity-20'><ArrowDown size={15} /></button></span>}</div>;
                    })}<button onClick={() => setActiveGroupKey('__generation__')} className='w-full py-5 text-left'><strong className='text-sm'>續寫參數</strong><span className='block mt-1 text-[10px] text-slate-400'>Temperature、Top P、懲罰項與最大輸出</span></button></div>
                    {!readOnly && <section className='pt-6 border-t border-slate-200 grid gap-3 sm:grid-cols-2'><label><span className='text-[10px] font-bold text-slate-500'>預設名稱</span><input value={draft.document.name} onChange={event => patchDocument({ name: event.target.value })} className='mt-1 w-full px-3 py-2.5 rounded-xl bg-white border border-slate-200 text-sm' /></label><label><span className='text-[10px] font-bold text-slate-500'>說明</span><input value={draft.document.description || ''} onChange={event => patchDocument({ description: event.target.value })} className='mt-1 w-full px-3 py-2.5 rounded-xl bg-white border border-slate-200 text-sm' /></label></section>}
                    {!readOnly && onDelete && <button onClick={() => onDelete(draft)} className='mt-8 w-full py-3 text-xs font-bold text-rose-500'>刪除這個預設</button>}
                </>}
            </div>
        </main>
    </div>;
};

export default StoryPresetMaker;
