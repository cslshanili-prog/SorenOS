import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { UploadSimple } from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import type { CharacterProfile } from '../../types';
import Modal from '../os/Modal';
import { cardToSoren, isPngBytes, parseStCardFile, type SorenFromCard, type StCard } from '../../utils/stCard';
import { putImageBlob } from '../../utils/blobRef';
import { toMountedWorldbook } from '../../utils/worldbook';
import { trackEvent } from '../../utils/analytics';

interface Pending { card: StCard; soren: SorenFromCard; png: boolean; file: File; previewUrl?: string }

/**
 * 神經鏈接「匯入 SillyTavern 角色卡」（plans/chat-import-export.md 第 5 節）：選 PNG／JSON → 預覽 → 建立。
 * PNG 那張圖就是頭像；卡內世界書建成條目、直接掛到這個角色。建完交給 onCreated 打開編輯頁。
 */
export interface StCardImportHandle {
    /** 打開選檔 */
    chooseFile: () => void;
    /** 直接讀這個檔（右上角「導入」收到不是 Soren 角色卡時轉過來）；不是 ST 卡就丟錯 */
    pick: (file: File) => Promise<void>;
}

/** 只放一份（彈窗在這裡），列表上的按鈕用 StCardImportButton 叫它 */
const StCardImport = forwardRef<StCardImportHandle, { onCreated: (char: CharacterProfile) => void; supporting?: boolean }>(({ onCreated, supporting }, ref) => {
    const { addCharacter, updateCharacter, addWorldbook, characters, addToast } = useOS();
    const inputRef = useRef<HTMLInputElement>(null);
    const [pending, setPending] = useState<Pending | null>(null);
    const [busy, setBusy] = useState(false);
    const [showNotes, setShowNotes] = useState(false);

    const close = () => {
        if (pending?.previewUrl) URL.revokeObjectURL(pending.previewUrl);
        setPending(null);
        setShowNotes(false);
    };

    const read = async (file: File) => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const card = parseStCardFile(bytes);
        const png = isPngBytes(bytes);
        setPending({ card, soren: cardToSoren(card), png, file, ...(png ? { previewUrl: URL.createObjectURL(file) } : {}) });
    };
    const pick = async (file: File) => {
        try {
            await read(file);
        } catch (e: any) {
            addToast(e?.message || '讀不出這張角色卡', 'error');
        } finally {
            if (inputRef.current) inputRef.current.value = '';
        }
    };
    useImperativeHandle(ref, () => ({ chooseFile: () => inputRef.current?.click(), pick: read }));

    const create = async () => {
        if (!pending) return;
        setBusy(true);
        try {
            const { soren, png, file } = pending;
            const created = await addCharacter();
            const avatar = png ? await putImageBlob(file) : undefined;
            for (const wb of soren.worldbooks) await addWorldbook(wb);
            const updates: Partial<CharacterProfile> = {
                ...soren.fields,
                ...(avatar ? { avatar } : {}),
                ...(soren.worldbooks.length ? { mountedWorldbooks: soren.worldbooks.map(toMountedWorldbook) } : {}),
                ...(supporting ? { castRole: 'supporting' as const } : {}),
            };
            updateCharacter(created.id, updates);
            trackEvent('导入ST角色卡', { 格式: png ? 'PNG' : 'JSON', 有世界书: soren.worldbooks.length ? '是' : '否' });
            addToast(`已匯入「${soren.fields.name}」${soren.worldbooks.length ? `，掛了 ${soren.worldbooks.length} 條世界書` : ''}`, 'success');
            close();
            onCreated({ ...created, ...updates });
        } catch (e: any) {
            addToast(`匯入失敗：${e?.message || '未知錯誤'}`, 'error');
        } finally {
            setBusy(false);
        }
    };

    const p = pending;
    const f = p?.soren.fields;
    const sameName = !!p && characters.some(c => c.name === p.card.name);
    const rows: [string, string][] = p ? [
        ['人設', f!.systemPrompt ? `${f!.systemPrompt.length} 字（description＋personality${p.card.systemPrompt || p.card.postHistoryInstructions ? '＋卡片附帶的提示' : ''}）` : '沒有'],
        ['見面開場白', f!.dateGreetings?.length ? `${f!.dateGreetings.length} 個` : '沒有'],
        ['見面劇情大綱', f!.dateScenario ? `${f!.dateScenario.length} 字` : '沒有'],
        ['對話範例', f!.dialogueExamples ? `${f!.dialogueExamples.length} 字` : '沒有'],
        ['世界書', p.soren.worldbooks.length ? `${p.soren.worldbooks.length} 條，分類「${p.soren.worldbooks[0].category}」，直接掛上` : '沒有'],
        ['頭像', p.png ? '用這張圖' : 'JSON 卡沒有圖，先用預設的'],
    ] : [];

    return (
        <>
            <input ref={inputRef} type="file" accept=".png,.json,image/png,application/json" className="hidden" aria-label="選角色卡檔案"
                onChange={e => { const file = e.target.files?.[0]; if (file) void pick(file); }} />
            <Modal isOpen={!!p} title="匯入角色卡" onClose={close}
                footer={<button onClick={() => void create()} disabled={busy} className="w-full py-3 bg-primary text-white font-bold rounded-2xl disabled:opacity-50">{busy ? '匯入中…' : '建立這個角色'}</button>}>
                {p && (
                    <div className="space-y-3">
                        <div className="flex items-center gap-3">
                            {p.previewUrl
                                ? <img src={p.previewUrl} alt="" className="h-16 w-16 rounded-2xl object-cover bg-slate-100" />
                                : <div className="h-16 w-16 rounded-2xl bg-slate-100" />}
                            <div className="min-w-0">
                                <div className="text-base font-bold text-slate-800 truncate">{p.card.name}</div>
                                <div className="text-[11px] text-slate-400">SillyTavern {p.card.spec.toUpperCase()} 角色卡{p.card.creator ? ` · ${p.card.creator}` : ''}</div>
                                {p.card.tags.length > 0 && <div className="mt-0.5 text-[11px] text-slate-500 truncate">{p.card.tags.join(' · ')}</div>}
                            </div>
                        </div>
                        <div className="rounded-2xl bg-slate-50 divide-y divide-slate-100">
                            {rows.map(([k, v]) => (
                                <div key={k} className="flex items-start justify-between gap-3 px-3 py-2 text-[12px]">
                                    <span className="shrink-0 text-slate-500">{k}</span><span className="text-right text-slate-700">{v}</span>
                                </div>
                            ))}
                        </div>
                        {sameName && <p className="text-[11px] text-amber-600">已經有叫「{p.card.name}」的角色了，這會另外新建一個，不會蓋掉原本的。</p>}
                        {p.card.creatorNotes.trim() && (
                            <div className="text-[11px]">
                                <button type="button" onClick={() => setShowNotes(v => !v)} className="font-bold text-slate-500">{showNotes ? '收起' : '看看'}作者的話（不會匯進來）</button>
                                {showNotes && <div className="mt-1 max-h-40 overflow-y-auto overscroll-contain whitespace-pre-wrap break-words rounded-xl bg-slate-50 p-3 text-slate-500">{p.card.creatorNotes}</div>}
                            </div>
                        )}
                        <p className="text-[10px] leading-relaxed text-slate-400">卡片裡的正則不會匯進來（正則跟著預設走，到見面的預設匯入）。匯完會打開角色編輯頁，可以再檢查一次。</p>
                    </div>
                )}
            </Modal>
        </>
    );
});

export const StCardImportButton: React.FC<{ onClick: () => void }> = ({ onClick }) => (
    <button type="button" onClick={onClick}
        className="w-full py-2.5 rounded-2xl text-[12px] font-bold text-violet-400 bg-white/40 hover:bg-white/70 transition-colors flex items-center justify-center gap-1.5 shrink-0">
        <UploadSimple size={14} weight="bold" />匯入 SillyTavern 角色卡（PNG／JSON）
    </button>
);

export default StCardImport;
