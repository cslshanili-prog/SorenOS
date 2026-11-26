/**
 * 收存／編輯一個片刻（plans/bond-batch2.md 3.2）；也用來改一筆記憶的正文（4.2，走神經鏈接同一條路）。
 * 第 2a 批在羈絆裡手動新增；從聊天收存（帶來源、AI 摘要）在 2b 接上同一個資料形狀。
 */
import React, { useState } from 'react';
import type { BondEntry, BondEventDate, CharacterProfile } from '../../types';
import { BondHeader, SectionLabel } from './bondUi';
import { BondDateField } from './BondDateField';
import { BondPhotoPicker, BondPhotoStrip } from './BondPhotoPicker';
import type { ResolvedSpace } from './space';
import { bondEntryById } from '../../utils/bond/entryRegistry';
import { newBondEntryId, saveBondEntry } from '../../utils/bond/entries';
import { editMemorySummary } from '../../utils/memoryArchiveEdit';
import { trackEvent } from '../../utils/analytics';

export const BondMomentEditor: React.FC<{
    space: ResolvedSpace;
    /** 編輯現有的；沒有就是新增 */
    entryId?: string;
    onBack: () => void;
    onSaved: (entry: BondEntry) => void;
    addToast: (m: string, t?: 'success' | 'error' | 'info') => void;
}> = ({ space, entryId, onBack, onSaved, addToast }) => {
    const existing = entryId ? bondEntryById(entryId) : undefined;
    const [title, setTitle] = useState(existing?.title || '');
    const [text, setText] = useState(existing?.text || '');
    const [note, setNote] = useState(existing?.note || '');
    const [date, setDate] = useState<BondEventDate>(existing?.eventDate || { precision: 'day', date: space.todayKey });
    const [photos, setPhotos] = useState<string[]>(() => (existing?.sources || []).flatMap(s => (s.type === 'photo' ? [s.galleryId] : [])));
    const [picking, setPicking] = useState(false);
    const [saving, setSaving] = useState(false);

    const periodMissingLabel = date.precision === 'period' && !date.label.trim();
    const canSave = !!text.trim() && !periodMissingLabel && !saving;

    const save = async () => {
        setSaving(true);
        try {
            const now = Date.now();
            const base: BondEntry = existing || {
                id: newBondEntryId(), bondId: space.id, kind: 'moment', author: 'user', text: '',
                eventDate: date, writtenAt: now, sources: [], links: [], status: 'published', createdBy: 'user', updatedAt: now,
            };
            const saved = await saveBondEntry({
                ...base,
                title: title.trim() || undefined,
                text: text.trim(),
                note: note.trim() || undefined,
                eventDate: date,
                // 照片接在其他來源後面；換照片只動 photo 那幾筆
                sources: [...base.sources.filter(src => src.type !== 'photo'), ...photos.map(galleryId => ({ type: 'photo' as const, galleryId }))],
            });
            if (!existing) trackEvent('收存拾光片刻', { 来源: '手动' });
            addToast(existing ? '改好了' : '收存好了', 'success');
            onSaved(saved);
        } catch (e: any) {
            addToast(`沒存成功：${e?.message || e}`, 'error');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title={existing ? '編輯片刻' : '收存一個片刻'} onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-5 space-y-6">
                <section>
                    <SectionLabel>標 題</SectionLabel>
                    <input className="bond-input bond-serif" value={title} maxLength={40} placeholder="可以不填，例如：海邊那晚" onChange={e => setTitle(e.target.value)} />
                </section>
                <section>
                    <SectionLabel>發 生 了 什 麼</SectionLabel>
                    <textarea className="bond-input bond-serif min-h-[140px] leading-relaxed" value={text} placeholder="寫下那件事；只寫發生了什麼，感想放在下面那格"
                        onChange={e => setText(e.target.value)} />
                </section>
                <section>
                    <SectionLabel>想 留 著 它 ， 因 為</SectionLabel>
                    <input className="bond-input" value={note} maxLength={120} placeholder="可以不填" onChange={e => setNote(e.target.value)} />
                    {space.kind === 'persona' && <div className="mt-1.5 text-[11px] text-[var(--bond-muted)]">{space.rightName} 也看得到這句。</div>}
                </section>
                <section>
                    <SectionLabel>什 麼 時 候</SectionLabel>
                    <BondDateField value={date} onChange={setDate} todayKey={space.todayKey} />
                </section>
                <section>
                    <SectionLabel right={<button type="button" className="text-[11.5px] text-[var(--bond-accent)]" onClick={() => setPicking(true)}>{photos.length ? '換照片' : '從資料庫挑'}</button>}>照 片</SectionLabel>
                    {photos.length ? <BondPhotoStrip galleryIds={photos} size="sm" /> : <div className="text-[12px] text-[var(--bond-muted)]">可以不放。</div>}
                </section>
            </div>
            {picking && <BondPhotoPicker initial={photos} onBack={() => setPicking(false)} onDone={ids => { setPhotos(ids); setPicking(false); }} />}
            <div className="shrink-0 px-5 pt-3 border-t bond-hair flex gap-2" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 12px)' }}>
                <button type="button" className="bond-btn flex-1" onClick={onBack}>取消</button>
                <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={!canSave} onClick={save}>{saving ? '存檔中…' : '存起來'}</button>
            </div>
        </div>
    );
};

/** 改一筆記憶的正文：跟神經鏈接編輯同一條路（宮殿開著改宮殿節點，關著變成獨立傳統記錄） */
export const BondMemoryEditor: React.FC<{
    char: CharacterProfile;
    memoryId: string;
    /** 宮殿最新正文（有關聯時跟檔案文字不一樣） */
    currentText: string;
    embedding: Parameters<typeof editMemorySummary>[0]['embedding'];
    remote: Parameters<typeof editMemorySummary>[0]['remote'];
    updateCharacter: (id: string, updates: Partial<CharacterProfile> | ((prev: CharacterProfile) => Partial<CharacterProfile>)) => void;
    onBack: () => void;
    addToast: (m: string, t?: 'success' | 'error' | 'info') => void;
}> = ({ char, memoryId, currentText, embedding, remote, updateCharacter, onBack, addToast }) => {
    const memory = char.memories?.find(m => m.id === memoryId);
    const [text, setText] = useState(currentText);
    const [saving, setSaving] = useState(false);
    const save = async () => {
        setSaving(true);
        try {
            const apply = await editMemorySummary({ charId: char.id, memory, summary: text.trim(), linkedEnabled: !!char.memoryPalaceEnabled, embedding, remote });
            updateCharacter(char.id, prev => ({ memories: apply(prev.memories || []) }));
            addToast('記憶已更新', 'success');
            onBack();
        } catch (e: any) {
            addToast(e?.message || '沒存成功', 'error');
        } finally {
            setSaving(false);
        }
    };
    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="編輯記憶" onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-5 space-y-3">
                <div className="text-[12px] leading-relaxed text-[var(--bond-ink-2)]">
                    這是神經鏈接裡 {char.name} 的記憶（{memory?.date || '日期不明'}）。這裡改了，神經鏈接那邊也是同一份。
                    {memory?.palaceMemoryId && (char.memoryPalaceEnabled ? '這筆連著記憶宮殿，會一起改。' : '記憶宮殿現在關著，改了之後這筆會變成獨立的記錄。')}
                </div>
                <textarea className="bond-input bond-serif min-h-[220px] leading-relaxed" value={text} onChange={e => setText(e.target.value)} />
            </div>
            <div className="shrink-0 px-5 pt-3 border-t bond-hair flex gap-2" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 12px)' }}>
                <button type="button" className="bond-btn flex-1" onClick={onBack}>取消</button>
                <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={!text.trim() || saving} onClick={save}>{saving ? '存檔中…' : '存起來'}</button>
            </div>
        </div>
    );
};
