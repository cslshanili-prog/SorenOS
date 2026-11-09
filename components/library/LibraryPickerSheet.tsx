import React, { useEffect, useMemo, useState } from 'react';
import { FilePdf, FileText, X } from '@phosphor-icons/react';
import type { GalleryImage } from '../../types';
import { DB } from '../../utils/db';
import { formatLibraryFileSize, isLibraryFile } from '../../utils/library';
import TokenImg from '../os/TokenImg';

/**
 * 私聊「＋」→「資料庫」：從資料庫挑一張照片或一份文件發給角色（utils/libraryShare.ts）。
 * 你發的不受「誰能用」限制——那是「角色手邊有什麼」，你自己的東西想發什麼都行。
 * 點一下選中，下面出現預覽和「發給 TA」。
 */
const LibraryPickerSheet: React.FC<{
    charName: string;
    onPick: (item: GalleryImage) => void;
    onClose: () => void;
}> = ({ charName, onPick, onClose }) => {
    const [items, setItems] = useState<GalleryImage[] | null>(null);
    const [tab, setTab] = useState<'photos' | 'files'>('photos');
    const [selected, setSelected] = useState<GalleryImage | null>(null);

    useEffect(() => {
        let alive = true;
        DB.getGalleryImages()
            .then(all => { if (alive) setItems(all.filter(item => !!item.url).sort((a, b) => b.timestamp - a.timestamp)); })
            .catch(() => { if (alive) setItems([]); });
        return () => { alive = false; };
    }, []);

    const photos = useMemo(() => (items || []).filter(item => !isLibraryFile(item)), [items]);
    const files = useMemo(() => (items || []).filter(isLibraryFile), [items]);

    return (
        <div className="fixed inset-0 z-[220] flex flex-col bg-slate-50" role="dialog" aria-label="從資料庫發送">
            <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 pb-2" style={{ paddingTop: 'max(0.75rem, var(--safe-top))' }}>
                <button type="button" onClick={onClose} aria-label="關閉" className="grid h-9 w-9 place-items-center rounded-full text-slate-500 active:bg-slate-100"><X size={20} /></button>
                <h2 className="flex-1 text-[15px] font-bold text-slate-800">從資料庫發給{charName}</h2>
            </div>
            <div role="tablist" aria-label="照片或文件" className="shrink-0 bg-white px-3 py-2">
                <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1">
                    {([['photos', '照片', photos.length], ['files', '文件', files.length]] as const).map(([value, label, count]) => (
                        <button key={value} role="tab" aria-selected={tab === value} onClick={() => { setTab(value); setSelected(null); }}
                            className={`rounded-lg py-1.5 text-[12px] font-bold transition ${tab === value ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-400'}`}>
                            {label}{count ? <span className="ml-1 font-mono text-[10px] opacity-60">{count}</span> : null}
                        </button>
                    ))}
                </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
                {items === null ? (
                    <p className="py-20 text-center text-sm text-slate-400">讀取中…</p>
                ) : tab === 'photos' ? (
                    photos.length === 0 ? <p className="py-20 text-center text-sm text-slate-400">資料庫裡還沒有照片</p> : (
                        <div className="grid grid-cols-3 gap-1 p-1.5">
                            {photos.map(photo => (
                                <button key={photo.id} type="button" onClick={() => setSelected(photo)} aria-pressed={selected?.id === photo.id}
                                    className={`relative aspect-square overflow-hidden rounded-sm bg-slate-100 ${selected?.id === photo.id ? 'ring-[3px] ring-primary ring-inset' : ''}`}>
                                    <TokenImg value={photo.url} className="h-full w-full object-cover" loading="lazy" />
                                    {selected?.id === photo.id && <span className="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-primary text-[11px] font-bold text-white">✓</span>}
                                </button>
                            ))}
                        </div>
                    )
                ) : (
                    files.length === 0 ? (
                        <p className="px-8 py-20 text-center text-sm leading-relaxed text-slate-400">資料庫裡還沒有文件。在協同工作的文件櫃長按一份文件，選「歸檔到資料庫」就會放進來。</p>
                    ) : (
                        <div className="bg-white">
                            {files.map(item => (
                                <button key={item.id} type="button" onClick={() => setSelected(item)} aria-pressed={selected?.id === item.id}
                                    className={`flex w-full items-center gap-3 border-b border-slate-100 px-4 py-3 text-left ${selected?.id === item.id ? 'bg-primary/5' : 'active:bg-slate-50'}`}>
                                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-indigo-50 text-indigo-500">
                                        {/pdf/i.test(item.file?.mime || '') ? <FilePdf size={20} weight="duotone" /> : <FileText size={20} weight="duotone" />}
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-[13px] font-semibold text-slate-700">{item.file?.name || '未命名文件'}</span>
                                        <span className="mt-0.5 block truncate text-[10px] text-slate-400">{[formatLibraryFileSize(item.file?.size || 0), item.description].filter(Boolean).join(' · ')}</span>
                                    </span>
                                    {selected?.id === item.id && <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-bold text-white">✓</span>}
                                </button>
                            ))}
                        </div>
                    )
                )}
            </div>

            {selected && (
                <div className="shrink-0 border-t border-slate-200 bg-white px-4 pt-3" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 0.75rem)' }}>
                    <p className="line-clamp-2 text-[11px] leading-relaxed text-slate-500">
                        {isLibraryFile(selected)
                            ? `${charName}看得到檔名和備註，還打不開內容。`
                            : selected.description ? `描述：${selected.description}` : '這張還沒有描述，照樣能發，角色看得到圖。'}
                    </p>
                    <button type="button" onClick={() => onPick(selected)}
                        className="mt-2 w-full rounded-xl bg-primary py-3 text-sm font-bold text-white active:scale-[0.98]">
                        發給{charName}
                    </button>
                </div>
            )}
        </div>
    );
};

export default LibraryPickerSheet;
