import React, { useMemo, useRef, useState } from 'react';
import { ArrowLeft, DownloadSimple, LockSimple, UploadSimple, UserCircle } from '@phosphor-icons/react';
import TokenImg from '../../os/TokenImg';
import type { CharacterProfile, NPCProfile, StoryTheaterEntry, StoryTheaterMask, StoryTheaterPreset, UserProfile } from '../../../types';
import { dedupeTheaterWorldbooks, downloadStoryPreset, estimateStoryTokens, getPresetPromptStats, resolveStoryPresetDocument, resolveStoryTheaterMask } from '../../../utils/storyTheater';

interface Props {
    initial: StoryTheaterEntry;
    characters: CharacterProfile[];
    npcs: NPCProfile[];
    user: UserProfile;
    masks: StoryTheaterMask[];
    maskLocked: boolean;
    presets: StoryTheaterPreset[];
    onCancel: () => void;
    onSave: (entry: StoryTheaterEntry) => Promise<void> | void;
    onImportPreset: (file: File) => Promise<StoryTheaterPreset | null>;
    onEditPreset: (preset: StoryTheaterPreset, draft: StoryTheaterEntry) => void;
    onOpenMaskBox: (draft: StoryTheaterEntry) => void;
}

const localDateTime = (timestamp = Date.now()): string => {
    const date = new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60_000);
    return date.toISOString().slice(0, 16);
};

const Toggle: React.FC<{ value: boolean; onChange: (value: boolean) => void; label?: string }> = ({ value, onChange, label }) => <button type='button' aria-label={label} aria-pressed={value} onClick={() => onChange(!value)} className={`w-11 h-6 shrink-0 rounded-full p-1 transition-colors ${value ? 'bg-violet-600' : 'bg-slate-200'}`}><span className={`block w-4 h-4 rounded-full bg-white transition-transform ${value ? 'translate-x-5' : ''}`} /></button>;

const StoryTheaterEditor: React.FC<Props> = ({ initial, characters, npcs, user, masks, maskLocked, presets, onCancel, onSave, onImportPreset, onEditPreset, onOpenMaskBox }) => {
    const [draft, setDraft] = useState<StoryTheaterEntry>({ ...initial });
    const [saving, setSaving] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);
    const actors = useMemo(() => characters.filter(char => draft.characterIds.includes(char.id)), [characters, draft.characterIds]);
    const resolvedMask = useMemo(() => resolveStoryTheaterMask(draft.mask, user, characters, masks), [characters, draft.mask, masks, user]);
    const memoryParticipants = useMemo(() => {
        const participantIds = new Set(draft.characterIds);
        if (draft.mask?.type === 'character') participantIds.add(draft.mask.id);
        return characters.filter(char => participantIds.has(char.id));
    }, [characters, draft.characterIds, draft.mask]);
    const books = useMemo(() => dedupeTheaterWorldbooks(actors), [actors]);
    const preset = presets.find(item => item.id === draft.presetId) || presets[0] || null;
    const effectivePreset = preset ? { ...preset, document: resolveStoryPresetDocument(preset, draft.presetOverride) } : null;
    const presetStats = getPresetPromptStats(effectivePreset);

    const update = <K extends keyof StoryTheaterEntry>(key: K, value: StoryTheaterEntry[K]) => setDraft(current => ({ ...current, [key]: value, updatedAt: Date.now() }));
    const toggleCharacter = (char: CharacterProfile) => setDraft(current => {
        const adding = !current.characterIds.includes(char.id);
        const characterIds = adding ? [...current.characterIds, char.id] : current.characterIds.filter(id => id !== char.id);
        const remaining = characters.filter(item => characterIds.includes(item.id));
        const validBooks = new Set(dedupeTheaterWorldbooks(remaining).map(book => book.id));
        return {
            ...current,
            characterIds,
            selectedWorldbookIds: adding ? Array.from(new Set([...current.selectedWorldbookIds, ...(char.mountedWorldbooks || []).map(book => book.id)])) : current.selectedWorldbookIds.filter(id => validBooks.has(id)),
            characterMemoryDates: { ...current.characterMemoryDates, ...(adding && !current.characterMemoryDates[char.id] ? { [char.id]: localDateTime() } : {}) },
            characterContextLimits: { ...current.characterContextLimits, ...(adding && !current.characterContextLimits[char.id] ? { [char.id]: 100 } : {}) },
            updatedAt: Date.now(),
        };
    });
    // 客串 NPC：只在「真實時間陪伴」編輯器裡露出入口（見下方渲染的條件），不影響
    // 記憶/好感度/世界書掛載這些圍繞 characterIds 設計的管道，見 buildTheaterNpcContext。
    const toggleNpc = (npc: NPCProfile) => setDraft(current => {
        const ids = current.npcIds || [];
        const npcIds = ids.includes(npc.id) ? ids.filter(id => id !== npc.id) : [...ids, npc.id];
        return { ...current, npcIds, updatedAt: Date.now() };
    });
    const tokenPreview = useMemo(() => {
        const actorText = [resolvedMask.name, resolvedMask.description, resolvedMask.coreInstruction, resolvedMask.worldview, ...actors.map(char => [char.name, char.systemPrompt, char.worldview, draft.carryCharacterMemory ? JSON.stringify(char.memories || []) : ''].join('\n'))].join('\n');
        const bookText = books.filter(book => draft.selectedWorldbookIds.includes(book.id)).map(book => book.content).join('\n');
        const presetText = effectivePreset ? effectivePreset.document.prompts.filter(prompt => prompt.enabled).map(prompt => prompt.content).join('\n') : '';
        const archiveText = draft.archives.map(archive => archive.summary || '').join('\n');
        return { actor: estimateStoryTokens(actorText), book: estimateStoryTokens(bookText), preset: estimateStoryTokens(presetText), archive: estimateStoryTokens(archiveText) };
    }, [actors, books, draft, effectivePreset, resolvedMask]);
    const save = async () => {
        if (!draft.title.trim() || draft.characterIds.length === 0) return;
        setSaving(true);
        const archiveAfter = Math.max(2, Math.min(200, Number(draft.archiveAfter) || 40));
        const archiveKeepRecent = Math.max(1, Math.min(archiveAfter - 1, Number(draft.archiveKeepRecent) || 5));
        try { await onSave({ ...draft, title: draft.title.trim(), premise: draft.premise.trim(), carryCharacterMemory: draft.writesToCharacterMemory || draft.carryCharacterMemory, archiveAfter, archiveKeepRecent, presetId: preset?.id || presets[0]?.id, updatedAt: Date.now() }); }
        finally { setSaving(false); }
    };

    return <div className='h-full w-full flex flex-col bg-stone-100 text-slate-800'>
        <header className='story-safe-header shrink-0 border-b border-slate-200'>
            <div className='h-16 px-4 flex items-center gap-3'>
                <button onClick={onCancel} className='w-9 h-9 rounded-full grid place-items-center'><ArrowLeft size={20} /></button>
                <div><div className='text-[9px] tracking-[.24em] uppercase font-bold text-violet-500'>Story setup</div><div className='font-semibold'>{initial.title ? '調整劇情沙盒' : '新增劇情'}</div></div>
                <button onClick={save} disabled={saving || !draft.title.trim() || draft.characterIds.length === 0} className='ml-auto h-9 px-4 rounded-full bg-slate-900 text-white text-xs font-bold disabled:opacity-30'>{saving ? '保存中' : '保存並進入'}</button>
            </div>
        </header>
        <main className='story-page-scroll flex-1 overflow-y-auto px-5 py-6 pb-28'><div className='max-w-2xl mx-auto space-y-8'>
            <section>
                <div className='text-[9px] tracking-[.22em] uppercase font-bold text-violet-500'>01 / Story</div>
                <label className='block mt-2'><span className='text-[10px] font-bold text-slate-500'>標題 · 必填</span><input value={draft.title} onChange={event => update('title', event.target.value)} placeholder='劇情名稱' className='mt-1 w-full bg-transparent text-3xl font-serif font-semibold outline-none placeholder:text-slate-300' /></label>
                <label className='block mt-5'><span className='text-[10px] font-bold text-slate-500'>劇情介紹 · 可選</span><textarea value={draft.premise} onChange={event => update('premise', event.target.value)} placeholder='不填寫也能直接開場；也可以寫地點、衝突或必須守住的設定……' className='mt-2 w-full min-h-28 p-4 rounded-2xl bg-white border border-slate-200 text-sm leading-7 resize-y outline-none' /></label>
                <div className='mt-5'><div className='text-[10px] font-bold text-slate-500'>誰先落筆</div><div className='mt-2 grid grid-cols-2 p-1 rounded-xl bg-slate-200'><button disabled={maskLocked} onClick={() => update('openingMode', 'user')} className={`py-2.5 rounded-lg text-[11px] font-bold disabled:opacity-60 ${(draft.openingMode || 'user') === 'user' ? 'bg-white shadow-sm text-violet-700' : 'text-slate-500'}`}>我先寫</button><button disabled={maskLocked} onClick={() => update('openingMode', 'assistant')} className={`py-2.5 rounded-lg text-[11px] font-bold disabled:opacity-60 ${draft.openingMode === 'assistant' ? 'bg-white shadow-sm text-violet-700' : 'text-slate-500'}`}>故事先寫</button></div><p className='mt-2 text-[10px] text-slate-400'>{draft.openingMode === 'assistant' ? '進入後可直接讓故事根據標題與介紹寫出第一幕。' : '進入後由你用當前身份寫下第一句話。'}</p></div>
            </section>
            <section className='pt-6 border-t border-slate-200'>
                <div className='text-[9px] tracking-[.22em] uppercase font-bold text-violet-500'>02 / Cast</div><h2 className='mt-1 text-lg font-semibold'>讓誰參與</h2>
                <p className='text-[11px] text-slate-500'>先決定你是誰，再一次選好這段劇情裡的角色。你選擇的身份只由你控制，不會自行行動。</p>
                <button disabled={maskLocked || draft.writesToCharacterMemory} onClick={() => onOpenMaskBox(draft)} className='mt-4 w-full p-4 rounded-2xl bg-slate-900 text-white flex items-center gap-3 text-left disabled:cursor-not-allowed'>
                    {resolvedMask.avatar ? <TokenImg value={resolvedMask.avatar} alt='' className='w-11 h-11 rounded-full object-cover' /> : <span className='w-11 h-11 rounded-full bg-white/10 grid place-items-center'><UserCircle size={24} /></span>}
                    <span className='min-w-0 flex-1'><span className='block text-[9px] uppercase tracking-[.18em] text-violet-200'>你</span><strong className='block mt-1 text-sm truncate'>{resolvedMask.selection.type === 'user' ? '本人' : resolvedMask.name}</strong><span className='block mt-1 text-[9px] text-slate-300 truncate'>{resolvedMask.selection.type === 'user' ? '以真實的自己進入劇場' : resolvedMask.selection.type === 'character' ? '扮演已有角色' : '扮演原創人物'}</span></span>
                    <span className='text-[10px] font-bold text-violet-200'>{draft.writesToCharacterMemory ? <span className='inline-flex items-center gap-1'><LockSimple size={13} />真實身份</span> : maskLocked ? <span className='inline-flex items-center gap-1'><LockSimple size={13} />劇情中鎖定</span> : '面具箱'}</span>
                </button>
                {(maskLocked || draft.writesToCharacterMemory) && <p className='mt-2 text-[10px] leading-5 text-slate-500'>{draft.writesToCharacterMemory ? '真實時間陪伴只能使用真實的你，不能扮演已有角色或原創人物。' : '第一段內容發出後，當前身份會鎖定，避免中途更換導致人物記憶與敘事視角錯位。'}</p>}
                <div className='mt-4 grid grid-cols-2 gap-2.5'>{characters.map(char => { const selected = draft.characterIds.includes(char.id); const isMask = draft.mask?.type === 'character' && draft.mask.id === char.id; return <button key={char.id} disabled={isMask} onClick={() => toggleCharacter(char)} className={`flex items-center gap-3 p-3 rounded-2xl border text-left disabled:opacity-45 ${selected ? 'bg-violet-50 border-violet-300' : 'bg-white border-slate-200'}`}><TokenImg value={char.avatar} alt='' className='w-10 h-10 rounded-full object-cover' /><span className='min-w-0 flex-1'><span className='block text-sm font-semibold truncate'>{char.name}</span>{isMask && <span className='block text-[9px] text-violet-500'>當前由你扮演</span>}</span><span className={`w-4 h-4 rounded-full border-2 ${selected ? 'bg-violet-600 border-violet-600' : 'border-slate-300'}`} /></button>; })}</div>
                <div className='mt-5 pt-5 border-t border-slate-200'>
                    <div className='text-sm font-semibold'>客串 NPC · 可選</div>
                    <p className='mt-1 text-[10px] leading-5 text-slate-500'>神經鏈接「NPC」分頁裡的角色可以客串出場，戲份比主角輕；沒有獨立記憶、不追蹤好感度，只是讓這一場戲裡能自然出現更多人。真實陪伴、虛構劇場都能用。</p>
                    {npcs.length === 0 ? <p className='mt-3 text-[10px] text-slate-400'>還沒有 NPC，可以去神經鏈接「NPC」分頁新建。</p> : <div className='mt-3 grid grid-cols-2 gap-2.5'>{npcs.map(npc => { const selected = (draft.npcIds || []).includes(npc.id); return <button key={npc.id} onClick={() => toggleNpc(npc)} className={`flex items-center gap-3 p-3 rounded-2xl border text-left ${selected ? 'bg-violet-50 border-violet-300' : 'bg-white border-slate-200'}`}><TokenImg value={npc.avatar} alt='' className='w-10 h-10 rounded-full object-cover' /><span className='min-w-0 flex-1'><span className='block text-sm font-semibold truncate'>{npc.name}</span><span className='block text-[9px] text-slate-400'>客串</span></span><span className={`w-4 h-4 rounded-full border-2 ${selected ? 'bg-violet-600 border-violet-600' : 'border-slate-300'}`} /></button>; })}</div>}
                </div>
            </section>
            <section className='pt-6 border-t border-slate-200'>
                <div className='text-[9px] tracking-[.22em] uppercase font-bold text-violet-500'>03 / Memory</div><h2 className='mt-1 text-lg font-semibold'>這段故事是真的嗎</h2>
                <div className='mt-4 grid grid-cols-2 p-1 rounded-xl bg-slate-200'><button disabled={maskLocked} onClick={() => setDraft(current => ({ ...current, mask: { type: 'user' }, writesToCharacterMemory: true, carryCharacterMemory: true, updatedAt: Date.now() }))} className={`py-3 rounded-lg text-[11px] font-bold disabled:opacity-35 ${draft.writesToCharacterMemory ? 'bg-white shadow-sm text-violet-700' : 'text-slate-500'}`}>真實時間陪伴</button><button disabled={maskLocked} onClick={() => setDraft(current => ({ ...current, writesToCharacterMemory: false, carryCharacterMemory: false, updatedAt: Date.now() }))} className={`py-3 rounded-lg text-[11px] font-bold disabled:opacity-35 ${!draft.writesToCharacterMemory ? 'bg-white shadow-sm text-violet-700' : 'text-slate-500'}`}>虛構劇場</button></div>
                {maskLocked && <p className='mt-2 text-[10px] text-slate-400'>故事開始後，真實/虛構模式也會固定；虛構劇場的記憶輸入仍可單獨調整。</p>}
                {draft.writesToCharacterMemory ? <div className='mt-5 p-4 rounded-2xl bg-amber-50 border border-amber-200'>
                    <div className='text-xs font-bold text-amber-800'>記憶輸入與輸出都會開啟</div>
                    <p className='mt-1 text-[10px] leading-5 text-amber-700'>會讀取角色既有記憶；你寫的內容與故事正文也會分別進入每位角色的正常記憶，沿用陪伴模式的水位線和總結時機。</p>
                    <p className='mt-2 pt-2 border-t border-amber-200 text-[10px] leading-5 font-semibold text-amber-800'>內置真實性保護：角色不能捏造和你的共同記憶，也不能給已有記憶添油加醋。</p>
                    <div className='mt-3 space-y-3'>{memoryParticipants.map(char => <label key={char.id} className='flex items-center gap-3'><span className='w-20 text-xs font-semibold truncate'>{char.name}</span><input type='datetime-local' value={draft.characterMemoryDates[char.id] || localDateTime()} onChange={event => update('characterMemoryDates', { ...draft.characterMemoryDates, [char.id]: event.target.value })} className='min-w-0 flex-1 px-3 py-2 rounded-xl bg-white border border-amber-200 text-xs' /></label>)}</div>
                </div> : <div className='mt-5 space-y-5'>
                    <div className='py-3 border-y border-slate-200 flex items-center justify-between'><div><div className='text-sm font-semibold'>記憶輸出</div><p className='mt-1 text-[10px] text-slate-500'>虛構內容絕不會寫進任何角色記憶。</p></div><span className='px-2 py-1 rounded-full bg-slate-200 text-[9px] font-bold text-slate-500'>永久關閉</span></div>
                    <div className='flex items-start justify-between gap-5'><div><div className='text-sm font-semibold'>記憶輸入</div><p className='mt-1 text-[10px] text-slate-500'>默認關閉；打開后角色會帶著既有記憶進入虛構故事。關閉時只讀取名字、核心指令和世界觀。</p></div><Toggle value={draft.carryCharacterMemory} onChange={value => update('carryCharacterMemory', value)} /></div>
                    {draft.carryCharacterMemory && <div className='space-y-2'>{memoryParticipants.map(char => <label key={char.id} className='flex items-center gap-3 text-xs'><span className='flex-1 truncate'>{char.name}{draft.mask?.type === 'character' && draft.mask.id === char.id ? '（當前身份）' : ''} 最近原文</span><input type='number' min={0} max={500} value={draft.characterContextLimits[char.id] ?? 100} onChange={event => update('characterContextLimits', { ...draft.characterContextLimits, [char.id]: Math.max(0, Math.min(500, Number(event.target.value) || 0)) })} className='w-20 px-3 py-2 rounded-xl bg-white border border-slate-200 text-right' /><span className='text-slate-400'>條</span></label>)}</div>}
                    <div><div className='text-sm font-semibold'>歸檔方式</div><div className='mt-2 grid grid-cols-2 p-1 rounded-xl bg-slate-200'><button onClick={() => update('archiveStrategy', 'summary')} className={`py-2 rounded-lg text-[11px] font-bold ${draft.archiveStrategy === 'summary' ? 'bg-white shadow-sm' : 'text-slate-500'}`}>事件盒</button><button onClick={() => update('archiveStrategy', 'vector')} className={`py-2 rounded-lg text-[11px] font-bold ${draft.archiveStrategy === 'vector' ? 'bg-white shadow-sm' : 'text-slate-500'}`}>獨立向量</button></div></div>
                    <div className='grid grid-cols-2 gap-3'>
                        <label><span className='block mb-2 text-[10px] text-slate-500'>累計多少層後歸檔</span><input type='number' min={2} max={200} value={draft.archiveAfter} onChange={event => update('archiveAfter', Number(event.target.value))} className='w-full px-3 py-2.5 rounded-xl bg-white border border-slate-200 text-sm' /></label>
                        <label><span className='block mb-2 text-[10px] text-slate-500'>至少保留最近幾層</span><input type='number' min={1} max={Math.max(1, Number(draft.archiveAfter) - 1)} value={draft.archiveKeepRecent ?? 5} onChange={event => update('archiveKeepRecent', Number(event.target.value))} className='w-full px-3 py-2.5 rounded-xl bg-white border border-slate-200 text-sm' /></label>
                    </div>
                    <p className='text-[10px] leading-5 text-slate-500'>先完成並顯示本輪回復，再歸檔最舊部分；默認保留最近 5 層。以後可以換策略，舊事件盒與舊向量都不會丟。</p>
                </div>}
            </section>
            <section className='pt-6 border-t border-slate-200'>
                <div className='text-[9px] tracking-[.22em] uppercase font-bold text-violet-500'>04 / Lore</div><h2 className='mt-1 text-lg font-semibold'>世界書沙盒</h2><p className='text-[10px] text-slate-500'>從角色掛載項同步並去重；勾選只屬於本劇情。</p>
                <div className='mt-3 divide-y divide-slate-100 border-y border-slate-200'>{books.length === 0 ? <div className='py-6 text-center text-xs text-slate-400'>所選角色沒有掛載世界書</div> : books.map(book => { const selected = draft.selectedWorldbookIds.includes(book.id); return <button key={book.id} onClick={() => update('selectedWorldbookIds', selected ? draft.selectedWorldbookIds.filter(id => id !== book.id) : [...draft.selectedWorldbookIds, book.id])} className='w-full py-3 flex items-center gap-3 text-left'><span className={`w-4 h-4 rounded border text-[10px] text-center text-white ${selected ? 'bg-violet-600 border-violet-600' : 'border-slate-300'}`}>{selected ? '✓' : ''}</span><span className='min-w-0'><span className='block text-xs font-semibold truncate'>{book.title}</span><span className='block text-[9px] text-slate-400'>{book.category || '未分類'}</span></span></button>; })}</div>
            </section>
            <section className='pt-6 border-t border-slate-200'>
                <div className='text-[9px] tracking-[.22em] uppercase font-bold text-violet-500'>05 / Preset</div><h2 className='mt-1 text-lg font-semibold'>裝載劇情預設</h2><p className='text-[10px] text-slate-500'>只接受糯米機原生 sullyos.story-preset；內置預設複製後可編輯。</p>
                <div className='mt-3 flex gap-2'><select value={preset?.id || ''} onChange={event => setDraft(current => ({ ...current, presetId: event.target.value, presetOverride: undefined, updatedAt: Date.now() }))} className='min-w-0 flex-1 px-3 py-3 rounded-xl bg-white border border-slate-200 text-xs'>{presets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button onClick={() => fileInput.current?.click()} className='w-11 rounded-xl bg-white border border-slate-200 grid place-items-center'><UploadSimple size={18} /></button><button disabled={!preset} onClick={() => { if (preset) void downloadStoryPreset(preset); }} className='w-11 rounded-xl bg-white border border-slate-200 grid place-items-center disabled:opacity-30'><DownloadSimple size={18} /></button></div>
                <input ref={fileInput} type='file' accept='.json,.png,application/json,image/png' className='hidden' onChange={async event => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (!file) return; const imported = await onImportPreset(file); if (imported) setDraft(current => ({ ...current, presetId: imported.id, presetOverride: undefined, updatedAt: Date.now() })); }} />
                {preset && <div className='mt-3 flex items-center justify-between'><span className='text-[10px] text-slate-500'>啟用 {presetStats.enabled}/{presetStats.total} 條 · 按當前順序與插入位置發送</span><button onClick={() => onEditPreset(preset, draft)} className='text-[10px] font-bold text-violet-600'>打開製作器</button></div>}
                <div className='mt-5 pt-4 border-t border-slate-200'>
                    <div className='flex items-start justify-between gap-5'>
                        <div><div className='text-sm font-semibold'>不發送高級採樣參數</div><p className='mt-1 text-[10px] leading-5 text-slate-500'>默認關閉。僅當接口不接受這些字段時開啟；開啟後不發送 top_p、frequency_penalty 和 presence_penalty。</p></div>
                        <Toggle label='不發送高級採樣參數' value={draft.omitSamplingParams === true} onChange={value => update('omitSamplingParams', value)} />
                    </div>
                    {draft.omitSamplingParams && <p className='mt-3 border-l-2 border-amber-400 pl-3 text-[10px] leading-5 text-amber-700'>這會忽略當前預設中的三項參數，包括非默認值。正常支持酒館參數的接口請保持關閉。</p>}
                </div>
                <div className='mt-5 pt-4 border-t border-slate-200'>
                    <div className='flex items-start justify-between gap-5'>
                        <div><div className='text-sm font-semibold'>400 兼容模式</div><p className='mt-1 text-[10px] leading-5 text-slate-500'>僅當接口提示“最後一條消息必須是 user”時開啟。</p></div>
                        <Toggle label='400 兼容模式' value={draft.forceUserLastMessage === true} onChange={value => update('forceUserLastMessage', value)} />
                    </div>
                    {draft.forceUserLastMessage && <p className='mt-3 border-l-2 border-amber-400 pl-3 text-[10px] leading-5 text-amber-700'>開啟後會用系統指令代替原生助手預填，可能削弱格式與文風效果。優先建議更換支持該預設的模型。</p>}
                </div>
            </section>
            <section className='pt-6 border-t border-slate-200'>
                <div className='text-[9px] tracking-[.22em] uppercase font-bold text-violet-500'>06 / Budget</div>
                <div className='mt-2 flex items-end justify-between gap-4'><div><h2 className='text-lg font-semibold'>靜態配置預算</h2><p className='mt-1 text-[10px] leading-5 text-slate-500'>這裡只比較角色、世界書、預設與歸檔；劇場內會按續寫實際使用的完整上下文統計歷史、召回和本輪輸入。</p></div><strong className='text-2xl font-serif'>{Object.values(tokenPreview).reduce((sum, value) => sum + value, 0).toLocaleString()}</strong></div>
                <div className='mt-4 grid grid-cols-4 gap-2'>{Object.entries({ '角色': tokenPreview.actor, '世界書': tokenPreview.book, '預設': tokenPreview.preset, '歸檔': tokenPreview.archive }).map(([label, value]) => <div key={label} className='py-3 rounded-xl bg-white border border-slate-200 text-center'><div className='text-[9px] text-slate-400'>{label}</div><div className='mt-1 text-xs font-bold'>{value.toLocaleString()}</div></div>)}</div>
            </section>
            <button onClick={save} disabled={saving || !draft.title.trim() || draft.characterIds.length === 0} className='w-full py-4 rounded-2xl bg-slate-900 text-white text-sm font-bold disabled:opacity-30'>{saving ? '正在保存……' : '保存並進入劇情'}</button>
        </div></main>
    </div>;
};

export default StoryTheaterEditor;
