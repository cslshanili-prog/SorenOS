import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { CaretLeft } from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import type { CharacterProfile, Emoji, Message } from '../../types';
import { DB } from '../../utils/db';
import { lineArgOf, lineOf } from '../../utils/chatLine';
import { buildSorenChatExport, chatScopeMessages, dayEnd, dayStart, exportFileName, formatChatTxt, localMediaCount } from '../../utils/chatExport';
import { stickerNameFromUrl } from '../../utils/messageFormat';
import { shareOrDownloadFile } from '../../utils/shareExport';
import { trackEvent } from '../../utils/analytics';

/**
 * 私聊「匯出聊天紀錄」（plans/chat-import-export.md 第 6 節）：這條線的私聊，Soren JSON 或 TXT，整段或日期區間。
 * JSON 可以帶這條線的角色記憶，從訊息列表「＋」→「匯入聊天紀錄」原樣匯回來。
 */
const keyOf = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const ChatExportSheet: React.FC<{ char: CharacterProfile; userName: string; emojis: Emoji[]; onClose: () => void }> = ({ char, userName, emojis, onClose }) => {
    const { addToast } = useOS();
    const [all, setAll] = useState<Message[] | null>(null);
    const [format, setFormat] = useState<'json' | 'txt'>('json');
    const [whole, setWhole] = useState(true);
    const [from, setFrom] = useState('');
    const [to, setTo] = useState('');
    const [withMemories, setWithMemories] = useState(true);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let alive = true;
        DB.getMessagesByCharId(lineArgOf(char), true).then(rows => {
            if (!alive) return;
            const scoped = chatScopeMessages(rows);
            setAll(scoped);
            if (scoped.length) { setFrom(keyOf(scoped[0].timestamp)); setTo(keyOf(scoped[scoped.length - 1].timestamp)); }
        }).catch(() => { if (alive) setAll([]); });
        return () => { alive = false; };
    }, [char.id, lineOf(char).personaKey]); // eslint-disable-line react-hooks/exhaustive-deps

    const picked = useMemo(() => {
        if (!all) return [];
        if (whole || !from || !to) return all;
        const a = dayStart(from <= to ? from : to), b = dayEnd(from <= to ? to : from);
        return all.filter(m => m.timestamp >= a && m.timestamp <= b);
    }, [all, whole, from, to]);

    // 這條線的角色記憶（主線：沒標線的，或標的是主線那張卡）
    const lineMemories = useMemo(() => {
        const pk = lineOf(char).personaKey;
        return (char.memories || []).filter(f => (pk ? f.personaKey === pk : !f.personaKey || f.personaKey === char.primaryPersonaKey));
    }, [char]);
    const localMedia = useMemo(() => localMediaCount(picked), [picked]);

    const doExport = async () => {
        if (!picked.length || busy) return;
        setBusy(true);
        try {
            const json = format === 'json';
            const content = json
                ? JSON.stringify(buildSorenChatExport({ char, userName, messages: picked, ...(withMemories ? { memories: lineMemories } : {}) }), null, 1)
                : formatChatTxt({ charName: char.name, userName, messages: picked, stickerName: (url, fb) => stickerNameFromUrl(emojis, url, fb) });
            const result = await shareOrDownloadFile({
                content,
                fileName: exportFileName(char.name, '聊天紀錄', json ? 'json' : 'txt'),
                mimeType: json ? 'application/json' : 'text/plain;charset=utf-8',
                shareTitle: `跟${char.name}的聊天紀錄`,
            });
            trackEvent('导出聊天记录', { 类型: '私聊', 格式: json ? 'Soren JSON' : 'TXT', 范围: whole ? '全部' : '日期区间', 含记忆: json && withMemories && lineMemories.length ? '是' : '否' });
            addToast(result === 'shared' ? '已打開分享面板' : '聊天紀錄已匯出', 'success');
            onClose();
        } catch (e: any) {
            addToast(`匯出失敗：${e?.message || '未知錯誤'}`, 'error');
        } finally {
            setBusy(false);
        }
    };

    const card = 'rounded-2xl bg-white p-4 shadow-sm space-y-3';
    const h = 'text-[11px] font-bold uppercase tracking-wide text-slate-400';
    const seg = (on: boolean) => `flex-1 rounded-xl py-2 text-[12px] font-bold ${on ? 'bg-violet-500 text-white' : 'bg-slate-100 text-slate-500'}`;
    const dateInput = 'min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-2 py-2 text-[13px] text-slate-700';

    const page = (
        <div role="dialog" aria-label="匯出聊天紀錄" className="fixed inset-0 z-[10040] flex flex-col bg-slate-50 text-slate-800" style={{ height: 'var(--app-height, 100%)' }}>
            <div className="shrink-0 bg-white/90 backdrop-blur border-b border-slate-100" style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="relative flex items-center px-3 py-3">
                    <button type="button" onClick={onClose} aria-label="返回" className="p-1.5 rounded-full hover:bg-black/5"><CaretLeft size={22} weight="bold" className="text-slate-600" /></button>
                    <h1 className="absolute left-1/2 -translate-x-1/2 text-base font-bold">匯出聊天紀錄</h1>
                </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-4 space-y-3">
                <div className={card}>
                    <div className={h}>格式</div>
                    <div className="flex gap-2">
                        <button type="button" className={seg(format === 'json')} onClick={() => setFormat('json')}>Soren JSON</button>
                        <button type="button" className={seg(format === 'txt')} onClick={() => setFormat('txt')}>TXT</button>
                    </div>
                    <p className="text-[11px] text-slate-400">{format === 'json'
                        ? '能原樣匯回來（訊息列表「＋」→「匯入聊天紀錄」）：引用、卡片、思考都在。匯回同一條線不會多出一份。'
                        : '給人看的：照日期分段，「名字 時間：內容」，圖片和貼圖換成文字。'}</p>
                    {format === 'json' && (
                        <label className="flex items-center gap-2 text-[12px] text-slate-600">
                            <input type="checkbox" className="accent-violet-500" checked={withMemories} onChange={e => setWithMemories(e.target.checked)} disabled={!lineMemories.length} />
                            一起帶上角色記憶（{lineMemories.length} 條）
                        </label>
                    )}
                </div>

                <div className={card}>
                    <div className={h}>範圍</div>
                    <div className="flex gap-2">
                        <button type="button" className={seg(whole)} onClick={() => setWhole(true)}>整段</button>
                        <button type="button" className={seg(!whole)} onClick={() => setWhole(false)} disabled={!all?.length}>選日期</button>
                    </div>
                    {!whole && (
                        <div className="flex items-center gap-2">
                            <input type="date" aria-label="從" className={dateInput} value={from} onChange={e => setFrom(e.target.value)} />
                            <span className="text-[12px] text-slate-400">到</span>
                            <input type="date" aria-label="到" className={dateInput} value={to} onChange={e => setTo(e.target.value)} />
                        </div>
                    )}
                    <div className="text-[13px]">{all === null ? '讀取中…' : <>共 <b>{picked.length}</b> 則</>}</div>
                    <p className="text-[11px] text-slate-400">只有私聊畫面裡的訊息；見面和通話各自在它們的記錄裡匯出。</p>
                    {format === 'json' && localMedia > 0 && <p className="text-[11px] text-amber-600">其中 {localMedia} 張圖存在這台裝置上，換一台匯進去會看不到；圖床的連結照常。</p>}
                </div>
            </div>
            <div className="shrink-0 border-t border-slate-100 bg-white px-4 pt-3" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 12px)' }}>
                <button type="button" onClick={() => void doExport()} disabled={busy || !picked.length}
                    className="w-full rounded-2xl bg-violet-500 py-3 text-sm font-bold text-white disabled:opacity-50">
                    {busy ? '匯出中…' : '匯出'}
                </button>
            </div>
        </div>
    );
    return typeof document !== 'undefined' ? createPortal(page, document.body) : null;
};

export default ChatExportSheet;
