import React, { useRef, useState } from 'react';
import { ArrowLeft, FloppyDisk, Plus, Trash, UserCircle } from '@phosphor-icons/react';
import type { CharacterProfile, StoryTheaterMask, StoryTheaterMaskSelection, UserProfile } from '../../../types';
import { createStoryTheaterMaskDraft } from '../../../utils/storyTheater';
import TokenImg from '../../os/TokenImg';

interface Props {
    user: UserProfile;
    characters: CharacterProfile[];
    masks: StoryTheaterMask[];
    selected: StoryTheaterMaskSelection;
    onSelect: (selection: StoryTheaterMaskSelection) => void;
    onSave: (mask: StoryTheaterMask) => Promise<void> | void;
    onDelete: (mask: StoryTheaterMask) => Promise<void> | void;
    onBack: () => void;
    locked?: boolean;
}

const StoryMaskBox: React.FC<Props> = ({ user, characters, masks, selected, onSelect, onSave, onDelete, onBack, locked = false }) => {
    const [draft, setDraft] = useState<StoryTheaterMask | null>(null);
    const [saving, setSaving] = useState(false);
    const imageInput = useRef<HTMLInputElement>(null);
    const patch = (updates: Partial<StoryTheaterMask>) => setDraft(current => current ? { ...current, ...updates, updatedAt: Date.now() } : current);

    const save = async () => {
        if (!draft?.name.trim()) return;
        setSaving(true);
        try {
            const next = { ...draft, name: draft.name.trim(), description: draft.description.trim(), updatedAt: Date.now() };
            await onSave(next);
            onSelect({ type: 'custom', id: next.id });
            setDraft(next);
        } finally { setSaving(false); }
    };

    return <div className='h-full w-full flex flex-col bg-stone-100 text-slate-800'>
        <header className='story-safe-header shrink-0 border-b border-slate-200'>
            <div className='h-16 px-4 flex items-center gap-3'>
                <button onClick={onBack} className='w-9 h-9 rounded-full grid place-items-center'><ArrowLeft size={20} /></button>
                <div><div className='text-[9px] tracking-[.24em] uppercase font-bold text-violet-500'>Mask box</div><h1 className='font-semibold'>面具箱</h1></div>
                {!locked && <button onClick={() => setDraft(createStoryTheaterMaskDraft())} className='ml-auto h-9 px-3 rounded-full bg-slate-900 text-white text-xs font-bold flex items-center gap-1'><Plus size={14} />原創人物</button>}
            </div>
        </header>

        <main className='story-page-scroll flex-1 overflow-y-auto px-5 py-6 pb-24'>
            <div className='max-w-2xl mx-auto'>
                <section>
                    <div className='text-[9px] tracking-[.22em] uppercase font-bold text-violet-500'>Who are you</div>
                    <h2 className='mt-1 text-2xl font-serif font-semibold'>這一條故事裡，你是誰？</h2>
                    <p className='mt-2 text-[11px] leading-5 text-slate-500'>箱中身份只改變本劇情裡由你執筆的人物，不會修改你的檔案或神經鏈接。</p>
                    {locked && <div className='mt-4 py-3 border-y border-amber-200 text-[11px] text-amber-700'>劇情已經開始，當前身份不可更換。</div>}
                </section>

                <section className='mt-7'>
                    <h3 className='text-xs font-bold text-slate-500'>本來的我</h3>
                    <button onClick={() => onSelect({ type: 'user' })} className={`mt-2 w-full py-4 flex items-center gap-3 border-y text-left ${selected.type === 'user' ? 'border-violet-300 text-violet-700' : 'border-slate-200'}`}>
                        {user.avatar ? <TokenImg value={user.avatar} alt='' className='w-12 h-12 rounded-full object-cover' /> : <UserCircle size={48} weight='light' className='text-slate-300' />}
                        <span><strong className='block text-sm'>{user.name || '你'}</strong><span className='block mt-1 text-[10px] text-slate-400 line-clamp-1'>{user.bio || '使用你現在的身份'}</span></span>
                        {selected.type === 'user' && <span className='ml-auto text-[9px] font-bold'>正在佩戴</span>}
                    </button>
                </section>

                <section className='mt-8'>
                    <h3 className='text-xs font-bold text-slate-500'>成為某位角色</h3>
                    <p className='mt-1 text-[10px] text-slate-400'>這位角色由你執筆，不會再自行行動。</p>
                    <div className='mt-3 flex gap-4 overflow-x-auto pb-2'>{characters.map(char => <button key={char.id} onClick={() => onSelect({ type: 'character', id: char.id })} className='w-20 shrink-0 text-center'><span className={`block mx-auto w-14 h-14 rounded-full p-0.5 ${selected.type === 'character' && selected.id === char.id ? 'ring-2 ring-violet-500 ring-offset-2 ring-offset-stone-100' : ''}`}><TokenImg value={char.avatar} alt='' className='w-full h-full rounded-full object-cover' /></span><span className='mt-2 block text-[10px] font-semibold truncate'>{char.name}</span></button>)}</div>
                </section>

                <section className='mt-8 pt-6 border-t border-slate-200'>
                    <div className='flex items-center justify-between'><div><h3 className='text-xs font-bold text-slate-500'>原創人物</h3><p className='mt-1 text-[10px] text-slate-400'>可跨劇情重複使用。</p></div><span className='text-[9px] text-slate-400'>{masks.length} 張</span></div>
                    {masks.length === 0 ? <button onClick={() => setDraft(createStoryTheaterMaskDraft())} className='mt-4 w-full py-8 border-y border-dashed border-slate-300 text-xs text-slate-400'>還沒有原創身份，點這裡新建</button> : <div className='mt-3 divide-y divide-slate-200'>{masks.map(mask => <button key={mask.id} onClick={() => { onSelect({ type: 'custom', id: mask.id }); setDraft({ ...mask }); }} className='w-full py-3 flex items-center gap-3 text-left'>{mask.avatar ? <TokenImg value={mask.avatar} alt='' className='w-11 h-11 rounded-full object-cover' /> : <span className='w-11 h-11 rounded-full bg-violet-100 text-violet-500 grid place-items-center font-serif font-bold'>{mask.name.slice(0, 1)}</span>}<span className='min-w-0 flex-1'><strong className='block text-xs truncate'>{mask.name}</strong><span className='block mt-1 text-[9px] text-slate-400 truncate'>{mask.description || '尚未填寫人物簡介'}</span></span>{selected.type === 'custom' && selected.id === mask.id && <span className='text-[9px] font-bold text-violet-600'>當前使用</span>}</button>)}</div>}
                </section>

                {draft && <section className='mt-8 pt-6 border-t border-slate-200'>
                    <div className='flex items-center justify-between'><div><div className='text-[9px] tracking-[.2em] uppercase font-bold text-violet-500'>Custom mask</div><h2 className='text-lg font-semibold'>{masks.some(mask => mask.id === draft.id) ? '編輯原創人物' : '新建原創人物'}</h2></div>{masks.some(mask => mask.id === draft.id) && <button onClick={async () => { await onDelete(draft); if (selected.type === 'custom' && selected.id === draft.id) onSelect({ type: 'user' }); setDraft(null); }} className='w-9 h-9 rounded-full grid place-items-center text-rose-500'><Trash size={17} /></button>}</div>
                    <div className='mt-4 grid grid-cols-[72px_1fr] gap-4 items-start'>
                        <button onClick={() => imageInput.current?.click()} className='w-[72px] h-[72px] rounded-full overflow-hidden bg-white border border-slate-200 grid place-items-center'>{draft.avatar ? <TokenImg value={draft.avatar} alt='' className='w-full h-full object-cover' /> : <UserCircle size={36} className='text-slate-300' />}</button>
                        <div className='space-y-3'><input value={draft.name} onChange={event => patch({ name: event.target.value })} placeholder='人物名字' className='w-full px-3 py-2.5 rounded-xl bg-white border border-slate-200 text-sm outline-none' /><input value={draft.description} onChange={event => patch({ description: event.target.value })} placeholder='身份、外貌、與其他人的關係' className='w-full px-3 py-2.5 rounded-xl bg-white border border-slate-200 text-xs outline-none' /></div>
                    </div>
                    <input ref={imageInput} type='file' accept='image/*' className='hidden' onChange={event => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (!file) return; const reader = new FileReader(); reader.onload = () => patch({ avatar: String(reader.result || '') }); reader.readAsDataURL(file); }} />
                    <label className='block mt-4'><span className='text-[10px] font-bold text-slate-500'>核心性格與行動邊界</span><textarea value={draft.coreInstruction || ''} onChange={event => patch({ coreInstruction: event.target.value })} className='mt-1 w-full min-h-28 p-3 rounded-xl bg-white border border-slate-200 text-xs leading-6 resize-y outline-none' placeholder='這個人通常怎樣判斷、說話和行動？' /></label>
                    <label className='block mt-4'><span className='text-[10px] font-bold text-slate-500'>所屬世界觀</span><textarea value={draft.worldview || ''} onChange={event => patch({ worldview: event.target.value })} className='mt-1 w-full min-h-24 p-3 rounded-xl bg-white border border-slate-200 text-xs leading-6 resize-y outline-none' placeholder='時代、身份背景、特殊規則……' /></label>
                    <button onClick={save} disabled={saving || !draft.name.trim()} className='mt-5 w-full py-3.5 rounded-2xl bg-slate-900 text-white text-xs font-bold flex items-center justify-center gap-2 disabled:opacity-30'><FloppyDisk size={15} />{saving ? '保存中' : '保存並佩戴'}</button>
                </section>}
            </div>
        </main>
    </div>;
};

export default StoryMaskBox;
