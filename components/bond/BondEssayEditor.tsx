/**
 * 編修一篇隨筆（plans/bond-batch2.md 5.2）：第一次改的時候原文留在 originalText，隨筆頁可以看「原本的版本」。
 */
import React, { useState } from 'react';
import { BondHeader, SectionLabel } from './bondUi';
import { bondEntryById } from '../../utils/bond/entryRegistry';
import { saveBondEntry } from '../../utils/bond/entries';
import { reviseEssay } from '../../utils/bond/essay';

export const BondEssayEditor: React.FC<{
    essayId: string;
    authorName: string;
    onBack: () => void;
    addToast: (m: string, t?: 'success' | 'error' | 'info') => void;
}> = ({ essayId, authorName, onBack, addToast }) => {
    const existing = bondEntryById(essayId);
    const [title, setTitle] = useState(existing?.title || '');
    const [text, setText] = useState(existing?.text || '');
    const [saving, setSaving] = useState(false);
    if (!existing) {
        return (
            <div className="absolute inset-0 flex flex-col bond-root">
                <BondHeader title="編輯隨筆" onBack={onBack} />
                <div className="flex-1 grid place-items-center text-[13px] text-[var(--bond-muted)]">這篇已經不在了。</div>
            </div>
        );
    }
    const save = async () => {
        setSaving(true);
        try {
            const next = reviseEssay(existing, { title: title.trim() || undefined, text: text.trim() });
            if (next !== existing) await saveBondEntry(next);
            addToast('改好了', 'success');
            onBack();
        } catch (e: any) {
            addToast(`沒存成功：${e?.message || e}`, 'error');
        } finally {
            setSaving(false);
        }
    };
    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="編輯隨筆" onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-5 space-y-6">
                <p className="text-[12px] leading-relaxed text-[var(--bond-ink-2)]">
                    這是{authorName}寫的。{existing.originalText ? '原本的版本已經留著，' : '第一次改的時候會把原本的版本留著，'}隨筆頁上隨時可以對照。
                </p>
                <section>
                    <SectionLabel>標 題</SectionLabel>
                    <input className="bond-input bond-serif" value={title} maxLength={30} placeholder="可以不填" onChange={e => setTitle(e.target.value)} />
                </section>
                <section>
                    <SectionLabel>正 文</SectionLabel>
                    <textarea className="bond-input bond-serif min-h-[260px] leading-relaxed" value={text} onChange={e => setText(e.target.value)} />
                </section>
            </div>
            <div className="shrink-0 px-5 pt-3 border-t bond-hair flex gap-2" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 12px)' }}>
                <button type="button" className="bond-btn flex-1" onClick={onBack}>取消</button>
                <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={!text.trim() || saving} onClick={save}>{saving ? '存檔中…' : '存起來'}</button>
            </div>
        </div>
    );
};
