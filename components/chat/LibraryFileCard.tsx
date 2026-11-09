import React, { useState } from 'react';
import { useOS } from '../../context/OSContext';
import type { Message } from '../../types';
import { getBlobForRef } from '../../utils/blobRef';
import { formatLibraryFileSize } from '../../utils/library';
import { libraryFileExtension, type LibraryFileMessageMeta } from '../../utils/libraryShare';
import { shareOrDownloadBlob } from '../../utils/shareExport';

/**
 * 從資料庫發進私聊的文件卡片（utils/libraryShare.ts）。點一下照資料庫那樣打開／下載。
 * 版面跟協同文件卡片同一個樣子，底下那行寫「資料庫 · 文件」。
 */
const LibraryFileCard: React.FC<{
    m: Message;
    commonLayout: (content: React.ReactNode) => JSX.Element;
    selectionMode: boolean;
    onToggleSelect: (id: number) => void;
}> = ({ m, commonLayout, selectionMode, onToggleSelect }) => {
    const { addToast } = useOS();
    const [opening, setOpening] = useState(false);
    const meta = (m.metadata?.libraryFile || {}) as Partial<LibraryFileMessageMeta>;
    const name = meta.name || '未命名文件';
    const extension = libraryFileExtension({ name, mime: meta.mime || '' }).slice(0, 8);
    const isPdf = extension === 'PDF';
    const size = formatLibraryFileSize(meta.size || 0);

    const open = async (event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        if (selectionMode) { onToggleSelect(m.id); return; }
        if (opening) return;
        setOpening(true);
        try {
            const blob = meta.ref ? await getBlobForRef(meta.ref) : null;
            if (!blob) throw new Error('文件已經不存在');
            const result = await shareOrDownloadBlob({ blob, fileName: name, shareTitle: name });
            if (result === 'downloaded') addToast('文件已下載', 'success');
        } catch (error: any) {
            addToast(`打不開：${error?.message || '未知錯誤'}`, 'error');
        } finally {
            setOpening(false);
        }
    };

    return commonLayout(
        <button
            type="button"
            onClick={open}
            disabled={opening && !selectionMode}
            className="sully-library-file group w-[min(276px,72vw)] overflow-hidden rounded-[18px] border border-slate-200/90 bg-white text-left shadow-[0_8px_24px_rgba(15,23,42,0.08)] transition-[transform,opacity] duration-150 active:scale-[0.985] disabled:opacity-70"
            aria-label={`打開文件 ${name}`}
        >
            <span className="flex min-w-0 items-center gap-3.5 px-3.5 py-3.5">
                <span className={`relative grid h-12 w-11 shrink-0 place-items-center rounded-[13px] border ${isPdf ? 'bg-rose-50 text-rose-600 border-rose-100' : 'bg-indigo-50 text-indigo-500 border-indigo-100'}`}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6" aria-hidden="true">
                        <path d="M7 3.75h6.75L18.5 8.5v11.75H7z" />
                        <path d="M13.5 3.75V8.5h5" />
                    </svg>
                    <span className={`absolute -bottom-1 rounded-[5px] px-1.5 py-[1px] text-[7px] font-black tracking-[0.08em] text-white ${isPdf ? 'bg-rose-600' : 'bg-indigo-500'}`}>{extension}</span>
                </span>
                <span className="min-w-0 flex-1">
                    <span className="block max-h-[2.7em] overflow-hidden break-words text-[13px] font-semibold leading-[1.35] text-slate-800">{name}</span>
                    <span className="mt-1.5 block text-[10px] font-medium tracking-wide text-slate-400">{[extension, size].filter(Boolean).join(' · ')}</span>
                    {meta.note && <span className="mt-1 block truncate text-[10px] text-slate-400">{meta.note}</span>}
                </span>
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-400 transition-colors group-hover:text-slate-700">
                    {opening ? (
                        <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px] animate-spin" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity=".22" /><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
                    ) : (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]" aria-hidden="true"><path d="M12 3v12" /><path d="m7.5 11 4.5 4.5 4.5-4.5" /><path d="M5 20h14" /></svg>
                    )}
                </span>
            </span>
            <span className="block border-t border-slate-100 px-3.5 py-2 text-[9px] font-semibold tracking-[0.12em] text-slate-400">資料庫 · 文件</span>
        </button>,
    );
};

export default LibraryFileCard;
