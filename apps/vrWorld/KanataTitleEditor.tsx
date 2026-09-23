import { sarNpcContentEnabled } from '../../utils/vrWorld/sarNpcPreference';
import React, { useEffect, useRef, useState } from 'react';
import { PencilSimple } from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import { KANATA_TITLE_LIMIT, kanataTitleRevision, normalizeKanataTitle } from '../../utils/vrWorld/kanataTitle';

export function KanataTitleEditor({ ownerId, unlocked = true, earnedTitles = [] }: { ownerId: string; unlocked?:boolean; earnedTitles?:string[] }) {
    const { userProfile, characters, updateCharacter, updateUserProfile } = useOS();
    const profile = ownerId === 'user' ? userProfile : characters.find(char => char.id === ownerId);
    const title = normalizeKanataTitle(profile?.vrState?.title);
    const [editing, setEditing] = useState(false), [draft, setDraft] = useState(''), [saving, setSaving] = useState(false), [error, setError] = useState('');
    const root = useRef<HTMLDivElement>(null), wasEditing = useRef(false);
    useEffect(() => { if (wasEditing.current && !editing) root.current?.querySelector('button')?.focus(); wasEditing.current = editing; }, [editing]);
    const length = Array.from(draft.trim()).length;
    const save = async (event: React.FormEvent) => {
        event.preventDefault(); if (!sarNpcContentEnabled() || saving || length > KANATA_TITLE_LIMIT) return;
        setSaving(true); setError('');
        const change = { title: normalizeKanataTitle(draft), titleRevision: kanataTitleRevision() };
        try {
            if (ownerId === 'user') await updateUserProfile(current => ({ vrState: { ...(current.vrState || { enabled: false }), ...change } }));
            else await updateCharacter(ownerId, current => ({ vrState: { ...(current.vrState || { enabled: false, intervalMinutes: 120 }), ...change } }));
            setEditing(false);
        } catch { setError('稱號沒有保存成功，請重試。'); }
        finally { setSaving(false); }
    };
    if (!sarNpcContentEnabled()) return null;
    if (!unlocked) return <div className="sar-title-editor"><p>彼方稱號 · 與艾文的二星回憶後開放</p></div>;
    return <div ref={root} className="sar-title-editor">
        {!editing ? <button type="button" aria-label="修改彼方稱號" onClick={() => { setDraft(title); setError(''); setEditing(true); }}><span>彼方稱號<strong>{title || '還沒有稱號'}</strong></span><PencilSimple size={16}/></button>
            : <form onSubmit={save} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setEditing(false); } }}>
                <label htmlFor="kanata-title">彼方稱號<small>{length} / {KANATA_TITLE_LIMIT}</small></label>
                <input id="kanata-title" aria-label="彼方稱號" autoFocus value={draft} onChange={event => setDraft(event.target.value)} placeholder="寫一個喜歡的稱號" aria-invalid={length > KANATA_TITLE_LIMIT} disabled={saving}/>
                {earnedTitles.length > 0 && <label>獲得的稱號<select aria-label="選擇已獲得稱號" value="" onChange={event=>setDraft(event.target.value)}><option value="">選一個稱號</option>{earnedTitles.map(t=><option key={t} value={t}>{t}</option>)}</select></label>}
                <p>{ownerId === 'user' ? '留空保存即可清除。' : '角色也可以在活動中改自己的稱號。留空保存即可清除。'}</p>
                {error && <p role="alert">{error}</p>}
                <div><button type="button" disabled={saving} onClick={() => setEditing(false)}>取消</button><button type="submit" disabled={saving || length > KANATA_TITLE_LIMIT}>{saving ? '保存中…' : '保存稱號'}</button></div>
            </form>}
    </div>;
}
