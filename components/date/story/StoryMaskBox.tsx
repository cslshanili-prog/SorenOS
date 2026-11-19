import React, { useMemo, useRef, useState } from 'react';
import ExpandableTextarea from '../../common/ExpandableTextarea';
import { ArrowLeft, Check, FloppyDisk, MagnifyingGlass, PencilSimple, Plus, Trash, UserCircle } from '@phosphor-icons/react';
import type { CharacterProfile, StoryTheaterMask, StoryTheaterMaskSelection, UserProfile } from '../../../types';
import { createStoryTheaterMaskDraft } from '../../../utils/storyTheater';
import { joinPresentNames, resolveStoryPresence, selectionKey } from '../../../utils/storyPresence';
import { personaOptions } from '../../../utils/calendarView';
import { profileForPersonaKey } from '../../../utils/userPersona';
import { isAltChar } from '../../../utils/charAlt';
import { sortByCast } from '../../../utils/castRole';
import TokenImg from '../../os/TokenImg';

interface Props {
    /** 沒套身份卡的原始檔案：這裡要列出每一張卡 */
    profileBase: UserProfile;
    characters: CharacterProfile[];
    masks: StoryTheaterMask[];
    /** 在場的你（可以好幾個；空的就是旁觀） */
    selected: StoryTheaterMaskSelection[];
    onToggle: (selection: StoryTheaterMaskSelection) => void;
    /** 全部拿掉：旁觀 */
    onClear: () => void;
    onSave: (mask: StoryTheaterMask) => Promise<void> | void;
    onDelete: (mask: StoryTheaterMask) => Promise<void> | void;
    onBack: () => void;
    /** 寫進角色記憶的劇情：只能選身份卡，不列你演的角色和原創人物 */
    personaOnly?: boolean;
}

/**
 * 面具箱：這條故事裡在場的你（plans/story-multi-persona.md）。
 * 身份卡、你演的角色、原創人物可以混著多選；一個都不選就是旁觀。劇情開始之後也能改。
 */
const StoryMaskBox: React.FC<Props> = ({ profileBase, characters, masks, selected, onToggle, onClear, onSave, onDelete, onBack, personaOnly = false }) => {
    const [draft, setDraft] = useState<StoryTheaterMask | null>(null);
    const [saving, setSaving] = useState(false);
    const [query, setQuery] = useState('');
    const imageInput = useRef<HTMLInputElement>(null);
    const patch = (updates: Partial<StoryTheaterMask>) => setDraft(current => current ? { ...current, ...updates, updatedAt: Date.now() } : current);

    const selectedKeys = useMemo(() => new Set(selected.map(item => selectionKey(item, profileBase))), [profileBase, selected]);
    const has = (selection: StoryTheaterMaskSelection) => selectedKeys.has(selectionKey(selection, profileBase));
    const present = useMemo(() => selected.length === 0 ? [] : resolveStoryPresence({ presence: selected }, profileBase, characters, masks), [characters, masks, profileBase, selected]);
    const personas = useMemo(() => personaOptions(profileBase), [profileBase]);
    const q = query.trim().toLowerCase();
    const hit = (name: string) => !q || name.toLowerCase().includes(q);
    // 小號不單獨列（本人就能演）；主角在前、配角在後
    const playable = useMemo(() => sortByCast(characters.filter(char => !isAltChar(char))), [characters]);

    const save = async () => {
        if (!draft?.name.trim()) return;
        setSaving(true);
        try {
            const next = { ...draft, name: draft.name.trim(), description: draft.description.trim(), updatedAt: Date.now() };
            await onSave(next);
            const target: StoryTheaterMaskSelection = { type: 'custom', id: next.id };
            if (!has(target)) onToggle(target);
            setDraft(next);
        } finally { setSaving(false); }
    };

    const tick = (on: boolean) => <span className={`ml-auto shrink-0 w-6 h-6 rounded-full border grid place-items-center ${on ? 'bg-violet-600 border-violet-600 text-white' : 'border-slate-300 text-transparent'}`}><Check size={13} weight='bold' /></span>;

    return <div className='h-full w-full flex flex-col bg-stone-100 text-slate-800'>
        <header className='story-safe-header shrink-0 border-b border-slate-200'>
            <div className='h-16 px-4 flex items-center gap-3'>
                <button onClick={onBack} aria-label='返回' className='w-9 h-9 rounded-full grid place-items-center'><ArrowLeft size={20} /></button>
                <div><div className='text-[9px] tracking-[.24em] uppercase font-bold text-violet-500'>Mask box</div><h1 className='font-semibold'>面具箱</h1></div>
                {!personaOnly && <button onClick={() => setDraft(createStoryTheaterMaskDraft())} className='ml-auto h-9 px-3 rounded-full bg-slate-900 text-white text-xs font-bold flex items-center gap-1'><Plus size={14} />原創人物</button>}
            </div>
            <div className='px-5 pb-3 flex items-center gap-2' data-testid='story-presence-summary'>
                <div className='min-w-0 flex-1 text-[11px] leading-5'>
                    {present.length === 0
                        ? <span className='text-slate-500'><strong className='text-slate-700'>旁觀</strong>：一個都沒選，你只當作者，角色演自己的戲。</span>
                        : <span className='text-slate-500'><strong className='text-violet-700'>在場 {present.length} 位</strong>：<span className='text-slate-700'>{joinPresentNames(present.map(item => item.name))}</span></span>}
                </div>
                {present.length > 0 && <button onClick={onClear} className='shrink-0 h-8 px-3 rounded-full border border-slate-300 bg-white text-[10px] font-bold text-slate-500'>改成旁觀</button>}
            </div>
        </header>

        <main className='story-page-scroll flex-1 overflow-y-auto px-5 py-6 pb-24'>
            <div className='max-w-2xl mx-auto'>
                <section>
                    <div className='text-[9px] tracking-[.22em] uppercase font-bold text-violet-500'>Who are you</div>
                    <h2 className='mt-1 text-2xl font-serif font-semibold'>這一條故事裡，你是誰？</h2>
                    <p className='mt-2 text-[11px] leading-5 text-slate-500'>{personaOnly ? '真實時間陪伴只能用身份卡：這場戲會寫進角色的記憶，在場的必須是真的你。可以好幾張一起在場，每個角色照自己認識的卡記；開始之後也能回來改，有人先離開就把她拿掉。' : '可以好幾個一起在場：勾幾個就是幾個你，各是各的人。只改變這條劇情裡由你執筆的人物，不會修改你的檔案或神經鏈接。劇情開始之後也能回來改，有人先離開就把他拿掉。'}</p>
                    <label className='mt-4 flex items-center gap-2 h-10 px-3 rounded-xl bg-white border border-slate-200'><MagnifyingGlass size={15} className='text-slate-400' /><input value={query} onChange={event => setQuery(event.target.value)} placeholder={personaOnly ? '搜尋身份卡' : '搜尋身份卡、角色、原創人物'} className='min-w-0 flex-1 bg-transparent text-xs outline-none' /></label>
                </section>

                <section className='mt-7'>
                    <h3 className='text-xs font-bold text-slate-500'>身份卡</h3>
                    <div className='mt-2 divide-y divide-slate-200 border-y border-slate-200'>{personas.filter(item => hit(item.name)).map(item => {
                        const selection: StoryTheaterMaskSelection = { type: 'persona', key: item.key };
                        const on = has(selection);
                        const bio = profileForPersonaKey(profileBase, item.key).bio;
                        return <button key={item.key} onClick={() => onToggle(selection)} aria-pressed={on} data-testid={`story-persona-${item.key}`} className={`w-full py-3.5 flex items-center gap-3 text-left ${on ? 'text-violet-700' : ''}`}>
                            {item.avatar ? <TokenImg value={item.avatar} alt='' className='w-11 h-11 rounded-full object-cover' /> : <UserCircle size={44} weight='light' className='text-slate-300' />}
                            <span className='min-w-0 flex-1'><strong className='flex items-center gap-1.5 text-sm'><span className='truncate'>{item.name || '你'}</span>{item.isMain && <span className='shrink-0 px-1.5 rounded-full bg-slate-200 text-[9px] font-bold text-slate-500'>目前身份</span>}</strong><span className='block mt-1 text-[10px] text-slate-400 line-clamp-1'>{bio || '沒寫簡介'}</span></span>
                            {tick(on)}
                        </button>;
                    })}</div>
                </section>

                {!personaOnly && <>
                <section className='mt-8'>
                    <h3 className='text-xs font-bold text-slate-500'>成為某位角色</h3>
                    <p className='mt-1 text-[10px] text-slate-400'>勾了的角色由你執筆，不會再自行行動，也會從演員名單拿掉；取消就放回演員名單。</p>
                    <div className='mt-3 grid grid-cols-4 gap-x-2 gap-y-4'>{playable.filter(char => hit(char.name)).map(char => {
                        const selection: StoryTheaterMaskSelection = { type: 'character', id: char.id };
                        const on = has(selection);
                        return <button key={char.id} onClick={() => onToggle(selection)} aria-pressed={on} className='min-w-0 text-center'><span className={`block mx-auto w-14 h-14 rounded-full p-0.5 ${on ? 'ring-2 ring-violet-500 ring-offset-2 ring-offset-stone-100' : ''}`}><TokenImg value={char.avatar} alt='' className='w-full h-full rounded-full object-cover' /></span><span className={`mt-2 block text-[10px] font-semibold truncate ${on ? 'text-violet-700' : ''}`}>{char.name}</span></button>;
                    })}</div>
                </section>

                <section className='mt-8 pt-6 border-t border-slate-200'>
                    <div className='flex items-center justify-between'><div><h3 className='text-xs font-bold text-slate-500'>原創人物</h3><p className='mt-1 text-[10px] text-slate-400'>可跨劇情重複使用。點一下加入或拿掉，筆是修改。</p></div><span className='text-[9px] text-slate-400'>{masks.length} 張</span></div>
                    {masks.length === 0 ? <button onClick={() => setDraft(createStoryTheaterMaskDraft())} className='mt-4 w-full py-8 border-y border-dashed border-slate-300 text-xs text-slate-400'>還沒有原創身份，點這裡新建</button> : <div className='mt-3 divide-y divide-slate-200'>{masks.filter(mask => hit(mask.name)).map(mask => {
                        const selection: StoryTheaterMaskSelection = { type: 'custom', id: mask.id };
                        const on = has(selection);
                        return <div key={mask.id} className='flex items-center gap-1'>
                            <button onClick={() => onToggle(selection)} aria-pressed={on} className={`min-w-0 flex-1 py-3 flex items-center gap-3 text-left ${on ? 'text-violet-700' : ''}`}>{mask.avatar ? <TokenImg value={mask.avatar} alt='' className='w-11 h-11 rounded-full object-cover' /> : <span className='w-11 h-11 rounded-full bg-violet-100 text-violet-500 grid place-items-center font-serif font-bold'>{mask.name.slice(0, 1)}</span>}<span className='min-w-0 flex-1'><strong className='block text-xs truncate'>{mask.name}</strong><span className='block mt-1 text-[9px] text-slate-400 truncate'>{mask.description || '尚未填寫人物簡介'}</span></span>{tick(on)}</button>
                            <button onClick={() => setDraft({ ...mask })} aria-label={`修改 ${mask.name}`} className='w-9 h-9 shrink-0 rounded-full grid place-items-center text-slate-400'><PencilSimple size={15} /></button>
                        </div>;
                    })}</div>}
                </section>

                {draft && <section className='mt-8 pt-6 border-t border-slate-200'>
                    <div className='flex items-center justify-between'><div><div className='text-[9px] tracking-[.2em] uppercase font-bold text-violet-500'>Custom mask</div><h2 className='text-lg font-semibold'>{masks.some(mask => mask.id === draft.id) ? '編輯原創人物' : '新建原創人物'}</h2></div>{masks.some(mask => mask.id === draft.id) && <button aria-label='刪除這個原創人物' onClick={async () => { const target: StoryTheaterMaskSelection = { type: 'custom', id: draft.id }; if (has(target)) onToggle(target); await onDelete(draft); setDraft(null); }} className='w-9 h-9 rounded-full grid place-items-center text-rose-500'><Trash size={17} /></button>}</div>
                    <div className='mt-4 grid grid-cols-[72px_1fr] gap-4 items-start'>
                        <button onClick={() => imageInput.current?.click()} className='w-[72px] h-[72px] rounded-full overflow-hidden bg-white border border-slate-200 grid place-items-center'>{draft.avatar ? <TokenImg value={draft.avatar} alt='' className='w-full h-full object-cover' /> : <UserCircle size={36} className='text-slate-300' />}</button>
                        <div className='space-y-3'><input value={draft.name} onChange={event => patch({ name: event.target.value })} placeholder='人物名字' className='w-full px-3 py-2.5 rounded-xl bg-white border border-slate-200 text-sm outline-none' /><input value={draft.description} onChange={event => patch({ description: event.target.value })} placeholder='身份、外貌、與其他人的關係' className='w-full px-3 py-2.5 rounded-xl bg-white border border-slate-200 text-xs outline-none' /></div>
                    </div>
                    <input ref={imageInput} type='file' accept='image/*' className='hidden' onChange={event => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (!file) return; const reader = new FileReader(); reader.onload = () => patch({ avatar: String(reader.result || '') }); reader.readAsDataURL(file); }} />
                    <label className='block mt-4'><span className='text-[10px] font-bold text-slate-500'>核心性格與行動邊界</span><ExpandableTextarea title="核心性格與行動邊界" value={draft.coreInstruction || ''} onChange={v => patch({ coreInstruction: v })} className='mt-1 w-full min-h-28 p-3 rounded-xl bg-white border border-slate-200 text-xs leading-6 resize-y outline-none' placeholder='這個人通常怎樣判斷、說話和行動？' /></label>
                    <label className='block mt-4'><span className='text-[10px] font-bold text-slate-500'>所屬世界觀</span><ExpandableTextarea title="所屬世界觀" value={draft.worldview || ''} onChange={v => patch({ worldview: v })} className='mt-1 w-full min-h-24 p-3 rounded-xl bg-white border border-slate-200 text-xs leading-6 resize-y outline-none' placeholder='時代、身份背景、特殊規則……' /></label>
                    <button onClick={save} disabled={saving || !draft.name.trim()} className='mt-5 w-full py-3.5 rounded-2xl bg-slate-900 text-white text-xs font-bold flex items-center justify-center gap-2 disabled:opacity-30'><FloppyDisk size={15} />{saving ? '保存中' : '保存並加入在場'}</button>
                </section>}
                </>}
            </div>
        </main>
    </div>;
};

export default StoryMaskBox;
