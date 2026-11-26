/**
 * 從資料庫挑照片給片刻（plans/bond-batch2.md 3.2）：全螢幕、可以挑好幾張（最多 6 張），只列照片不列文件。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Check } from '@phosphor-icons/react';
import type { GalleryImage } from '../../types';
import { BondHeader } from './bondUi';
import { DB } from '../../utils/db';
import { isLibraryFile } from '../../utils/library';
import TokenImg from '../os/TokenImg';

export const BOND_PHOTO_LIMIT = 6;

export const BondPhotoPicker: React.FC<{
    initial: string[];
    onDone: (galleryIds: string[]) => void;
    onBack: () => void;
}> = ({ initial, onDone, onBack }) => {
    const [items, setItems] = useState<GalleryImage[] | null>(null);
    const [chosen, setChosen] = useState<string[]>(initial);
    useEffect(() => {
        let alive = true;
        DB.getGalleryImages()
            .then(all => { if (alive) setItems(all.filter(i => !!i.url && !isLibraryFile(i)).sort((a, b) => b.timestamp - a.timestamp)); })
            .catch(() => { if (alive) setItems([]); });
        return () => { alive = false; };
    }, []);
    const toggle = (id: string) => setChosen(prev => (prev.includes(id) ? prev.filter(x => x !== id) : prev.length >= BOND_PHOTO_LIMIT ? prev : [...prev, id]));
    const photos = useMemo(() => items || [], [items]);
    return (
        <div className="absolute inset-0 z-10 flex flex-col bond-root">
            <BondHeader title="從資料庫挑照片" onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar">
                {items === null ? (
                    <p className="py-20 text-center text-[13px] text-[var(--bond-muted)]">讀取中…</p>
                ) : photos.length === 0 ? (
                    <p className="py-20 text-center text-[13px] text-[var(--bond-muted)]">資料庫裡還沒有照片。</p>
                ) : (
                    <div className="grid grid-cols-3 gap-1 p-1.5">
                        {photos.map(p => {
                            const on = chosen.includes(p.id);
                            return (
                                <button key={p.id} type="button" onClick={() => toggle(p.id)} aria-pressed={on}
                                    className={`relative aspect-square overflow-hidden bg-[var(--bond-paper-2)] ${on ? 'ring-[3px] ring-inset ring-[var(--bond-accent)]' : ''}`}>
                                    <TokenImg value={p.url} className="h-full w-full object-cover" loading="lazy" alt="" />
                                    {on && <span className="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-[var(--bond-accent)] text-[#fbf7f0]"><Check size={11} weight="bold" /></span>}
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>
            <div className="shrink-0 px-5 pt-3 border-t bond-hair flex gap-2" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 12px)' }}>
                <span className="self-center text-[11.5px] text-[var(--bond-muted)]">{chosen.length}/{BOND_PHOTO_LIMIT}</span>
                <button type="button" className="bond-btn bond-btn-primary flex-1" onClick={() => onDone(chosen)}>好了</button>
            </div>
        </div>
    );
};

/** 片刻上的照片（資料庫的 id → 圖）；照片被刪了就不顯示 */
export const BondPhotoStrip: React.FC<{ galleryIds: string[]; size?: 'sm' | 'lg' }> = ({ galleryIds, size = 'lg' }) => {
    const [urls, setUrls] = useState<Array<{ id: string; url: string }>>([]);
    useEffect(() => {
        let alive = true;
        if (!galleryIds.length) { setUrls([]); return; }
        DB.getGalleryImages()
            .then(all => {
                if (!alive) return;
                const byId = new Map(all.map(i => [i.id, i.url]));
                setUrls(galleryIds.map(id => ({ id, url: byId.get(id) || '' })).filter(x => x.url));
            })
            .catch(() => { if (alive) setUrls([]); });
        return () => { alive = false; };
    }, [galleryIds.join('|')]);
    if (!urls.length) return null;
    return (
        <div className={`grid gap-1.5 ${size === 'lg' ? (urls.length === 1 ? 'grid-cols-1' : 'grid-cols-2') : 'grid-cols-4'}`}>
            {urls.map(u => (
                <TokenImg key={u.id} value={u.url} alt="" className={`w-full object-cover bg-[var(--bond-paper-2)] ${size === 'lg' ? (urls.length === 1 ? 'max-h-72 rounded-lg' : 'aspect-square rounded-lg') : 'aspect-square rounded'}`} />
            ))}
        </div>
    );
};
