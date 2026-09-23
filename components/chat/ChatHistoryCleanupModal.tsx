import React, { useEffect, useRef, useState } from 'react';
import type { CharacterProfile, Message } from '../../types';
import Modal from '../os/Modal';
import { formatRangeTimestamp, loadRangeMessagePage } from '../../utils/memoryPalace/rangeMessagePage';
import { CHAT_CLEANUP_CONFIRMATION, deleteChatHistoryCleanup, prepareChatHistoryCleanup, type ChatCleanupPlan } from '../../utils/chatHistoryCleanup';

interface Props {
    character: Pick<CharacterProfile, 'id' | 'name'>;
    onClose: () => void;
    onDeleted: (plan: ChatCleanupPlan) => void | Promise<void>;
}
type Phase = 'select' | 'review' | 'confirm' | 'deleting' | 'done';
const sourceLabels: Record<string, string> = { date: '見面', call: '通話', story_theater_memory: '劇情陪伴' };
const sourceLabel = (message: Message) => sourceLabels[String(message.metadata?.source)] || '聊天';

/** 獨立清理入口；不調用總結 API，也不更改 AI 可見範圍和記憶水位線。 */
export default function ChatHistoryCleanupModal({ character, onClose, onDeleted }: Props) {
    const [mode, setMode] = useState<'range' | 'keep'>('range');
    const [phase, setPhase] = useState<Phase>('select');
    const [query, setQuery] = useState('');
    const [cursor, setCursor] = useState<{ beforeId?: number; afterId?: number }>({});
    const [rows, setRows] = useState<Message[]>([]);
    const [hasOlder, setHasOlder] = useState(false);
    const [hasNewer, setHasNewer] = useState(false);
    const [loading, setLoading] = useState(false);
    const [start, setStart] = useState<Message | null>(null);
    const [end, setEnd] = useState<Message | null>(null);
    const [keep, setKeep] = useState('200');
    const [plan, setPlan] = useState<ChatCleanupPlan | null>(null);
    const [preparing, setPreparing] = useState(false);
    const [reviewed, setReviewed] = useState(false);
    const [confirmation, setConfirmation] = useState('');
    const [error, setError] = useState('');
    const prepareController = useRef<AbortController | null>(null);
    const deleting = useRef(false);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; prepareController.current?.abort(); };
    }, []);

    useEffect(() => {
        if (phase !== 'select' || mode !== 'range') { setLoading(false); return; }
        const controller = new AbortController();
        setLoading(true);
        const timer = setTimeout(() => {
            void loadRangeMessagePage(character.id, { ...cursor, query, includeEmpty: true, signal: controller.signal })
                .then(page => {
                    if (controller.signal.aborted) return;
                    setRows(page.messages);
                    setHasOlder(cursor.afterId !== undefined || page.hasMore);
                    setHasNewer(cursor.beforeId !== undefined || (cursor.afterId !== undefined && page.hasMore));
                }).catch(reason => {
                    if (controller.signal.aborted) return;
                    setRows([]); setHasOlder(false); setHasNewer(false);
                    setError(`讀取失敗：${reason?.message || reason}`);
                }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
        }, query ? 250 : 0);
        return () => { clearTimeout(timer); controller.abort(); };
    }, [character.id, cursor, query, phase, mode]);

    const close = () => { if (!deleting.current) { prepareController.current?.abort(); onClose(); } };
    const backToSelection = () => {
        setPhase('select'); setPlan(null); setReviewed(false); setConfirmation('');
    };
    const selectEdge = async (edge: 'start' | 'end') => {
        setLoading(true); setError('');
        try {
            const page = await loadRangeMessagePage(character.id, { ...(edge === 'start' ? { afterId: 0 } : {}), limit: 1, includeEmpty: true });
            if (mounted.current) {
                if (!page.messages.length) setError('這個角色還沒有聊天記錄');
                else (edge === 'start' ? setStart : setEnd)(page.messages[0]);
            }
        } catch (reason: any) { if (mounted.current) setError(reason?.message || '讀取失敗'); }
        finally { if (mounted.current) setLoading(false); }
    };
    const preview = async () => {
        if (preparing || deleting.current) return;
        const controller = new AbortController();
        prepareController.current?.abort(); prepareController.current = controller;
        setPreparing(true); setError(''); setReviewed(false); setConfirmation(''); setPlan(null);
        try {
            const selection = mode === 'keep' ? { keepRecent: Number(keep) } : { fromId: start!.id, toId: end!.id };
            const result = await prepareChatHistoryCleanup(character.id, selection, controller.signal);
            if (controller.signal.aborted || !mounted.current) return;
            if (!result.ids.length) { setError('沒有需要清理的記錄；當前記錄會全部保留。'); return; }
            setPlan(result); setPhase('review');
        } catch (reason: any) { if (!controller.signal.aborted && mounted.current) setError(reason?.message || '無法讀取選區'); }
        finally { if (!controller.signal.aborted && mounted.current) setPreparing(false); }
    };
    const remove = async () => {
        if (!plan || !reviewed || confirmation !== CHAT_CLEANUP_CONFIRMATION || deleting.current) return;
        deleting.current = true; setPhase('deleting'); setError('');
        try {
            await deleteChatHistoryCleanup(plan, { reviewed, text: confirmation });
        } catch (reason: any) {
            if (mounted.current) { backToSelection(); setError(reason?.message || '刪除未完成，記錄已保留'); }
            deleting.current = false;
            return;
        }
        // 刪除已落盤；刷新失敗不得把它顯示成“刪除失敗”並誘導重複執行。
        try { await onDeleted(plan); } catch (reason) { console.error('[ChatHistoryCleanup] refresh failed', reason); }
        deleting.current = false;
        if (mounted.current) setPhase('done');
    };

    const summary = plan && <div className='rounded-2xl border border-red-200 bg-red-50 p-4 space-y-2 text-xs text-red-900'>
        <p className='font-bold text-sm'>角色：{character.name} · 永久刪除 {plan.ids.length.toLocaleString()} 條</p>
        <p>起點：{formatRangeTimestamp(plan.firstTimestamp)} · #{plan.ids[0]}</p>
        <p>終點：{formatRangeTimestamp(plan.lastTimestamp)} · #{plan.ids.at(-1)}</p>
        <p>包含起點、終點及中間全部記錄。搜索只用於定位，刪除不限於搜索匹配項。</p>
        {plan.afterWaterlineCount > 0 && <p className='font-bold'>其中 {plan.afterWaterlineCount.toLocaleString()} 條位於記憶水位線之後，可能尚未整理成記憶。</p>}
    </div>;
    const cancelButton = <button type='button' onClick={backToSelection} className='flex-1 rounded-2xl bg-slate-100 p-3 text-sm font-bold text-slate-600'>取消，返回選擇</button>;

    return <>
        <Modal isOpen={phase === 'select'} title='清理指定範圍的聊天記錄' onClose={close} footer={<>
            <button type='button' onClick={close} className='rounded-2xl bg-slate-100 px-4 py-3 text-sm text-slate-600'>取消</button>
            <button type='button' disabled={preparing || loading || (mode === 'range' ? !start || !end : !Number.isSafeInteger(Number(keep)) || Number(keep) < 1)} onClick={() => void preview()} className='flex-1 rounded-2xl bg-red-50 px-3 py-3 text-sm font-bold text-red-700 disabled:opacity-40'>{preparing ? '正在統計選區…' : '預覽清理範圍'}</button>
        </>}>
            <div className='space-y-4 text-xs text-slate-600'>
                <p><b>{character.name}</b> 的聊天、見面、通話及劇情陪伴記錄。清理會永久刪除原文和對應聊天語音緩存；已存入的記憶、收藏及劇情正文保留。</p>
                <div className='flex rounded-xl bg-slate-100 p-1 gap-1'>
                    <button type='button' disabled={preparing} onClick={() => { setMode('range'); setError(''); }} className={`flex-1 rounded-lg p-2 font-bold ${mode === 'range' ? 'bg-white text-slate-800' : ''}`}>指定起止區間</button>
                    <button type='button' disabled={preparing} onClick={() => { setMode('keep'); setError(''); }} className={`flex-1 rounded-lg p-2 font-bold ${mode === 'keep' ? 'bg-white text-slate-800' : ''}`}>保留最近 N 條</button>
                </div>
                {mode === 'keep' ? <label className='block space-y-2'>保留最近多少條記錄
                    <input aria-label='保留最近多少條記錄' type='number' min='1' step='1' value={keep} disabled={preparing} onChange={event => setKeep(event.target.value)} className='block w-full rounded-xl border border-slate-200 bg-white p-3 text-base' />
                    <span className='block text-slate-500'>僅清理更早的記錄。預覽後新產生的消息也會保留。</span>
                </label> : <>
                    <div className='rounded-xl border border-slate-200 p-3 space-y-2'>
                        <p>起點：{start ? `${formatRangeTimestamp(start.timestamp)} · #${start.id}` : '未選擇'}</p>
                        <p>終點：{end ? `${formatRangeTimestamp(end.timestamp)} · #${end.id}` : '未選擇'}</p>
                        <div className='flex flex-wrap gap-3 text-violet-700'>
                            <button type='button' disabled={preparing || loading} onClick={() => void selectEdge('start')}>從最早一條開始</button>
                            <button type='button' disabled={preparing || loading} onClick={() => void selectEdge('end')}>選到最新一條</button>
                            <button type='button' disabled={preparing} onClick={() => { setStart(null); setEnd(null); }}>重選</button>
                        </div>
                    </div>
                    <input aria-label='搜索聊天內容或日期' placeholder='搜索內容或日期，如 生日 / 2026-03' value={query} disabled={preparing} onChange={event => { setQuery(event.target.value); setCursor({}); }} className='w-full rounded-xl border border-slate-200 p-3' />
                    <p className='text-slate-500'>起止之間的全部記錄都會選中，搜索僅用於定位。</p>
                    <div className='flex items-center justify-between gap-2'>
                        <button type='button' disabled={preparing || loading || !hasOlder || !rows.length} onClick={() => setCursor({ beforeId: rows[0].id })} className='rounded-lg border px-3 py-2 disabled:opacity-30'>更早</button>
                        <span>{loading ? '讀取中…' : `本頁 ${rows.length} 條`}</span>
                        <button type='button' disabled={preparing || loading || !hasNewer || !rows.length} onClick={() => setCursor({ afterId: rows.at(-1)!.id })} className='rounded-lg border px-3 py-2 disabled:opacity-30'>更新</button>
                    </div>
                    {!loading && rows.map(message => <div key={message.id} className={`rounded-xl border p-3 space-y-2 ${start && end && message.id >= Math.min(start.id, end.id) && message.id <= Math.max(start.id, end.id) ? 'border-red-200 bg-red-50' : 'border-slate-200'}`}>
                        <div className='text-[10px] text-slate-400'>{message.role === 'user' ? '你' : message.role === 'assistant' ? character.name : '系統'} · {sourceLabel(message)} · {formatRangeTimestamp(message.timestamp)} · #{message.id}</div>
                        <p className='whitespace-pre-wrap break-all leading-relaxed'>{message.content}</p>
                        <div className='flex gap-4 text-violet-700'>
                            <button type='button' disabled={preparing} onClick={() => setStart(message)}>{start?.id === message.id ? '已設為起點' : '設為起點'}</button>
                            <button type='button' disabled={preparing} onClick={() => setEnd(message)}>{end?.id === message.id ? '已設為終點' : '設為終點'}</button>
                        </div>
                    </div>)}
                    {!loading && !rows.length && <p className='text-center py-4'>{query ? '沒有匹配的記錄' : '沒有聊天記錄'}</p>}
                </>}
                {error && <p role='alert' className='rounded-xl bg-red-50 p-3 text-red-700'>{error}</p>}
            </div>
        </Modal>

        <Modal isOpen={phase === 'review'} title='第一次確認：檢查刪除範圍' onClose={backToSelection} footer={<>
            {cancelButton}<button type='button' onClick={() => { setReviewed(true); setConfirmation(''); setPhase('confirm'); }} className='flex-1 rounded-2xl bg-red-100 p-3 text-sm font-bold text-red-700'>繼續第二次確認</button>
        </>}>
            <div className='space-y-4'>{summary}<p className='text-sm font-bold text-red-700'>這是永久刪除，無法撤銷。請先確認已備份需要保留的內容。</p><p className='text-xs text-slate-500'>此步不會刪除任何記錄，下一步還需輸入指定文字。</p></div>
        </Modal>

        <Modal isOpen={phase === 'confirm' || phase === 'deleting'} title='第二次確認：永久刪除' onClose={() => { if (!deleting.current) backToSelection(); }} footer={<>
            {!deleting.current && cancelButton}<button type='button' disabled={phase === 'deleting' || !reviewed || confirmation !== CHAT_CLEANUP_CONFIRMATION} onClick={() => void remove()} className='flex-1 rounded-2xl bg-red-600 p-3 text-sm font-bold text-white disabled:bg-slate-200 disabled:text-slate-400'>{phase === 'deleting' ? '正在永久刪除…' : `永久刪除 ${plan?.ids.length.toLocaleString() || 0} 條`}</button>
        </>}>
            <div className='space-y-4'>{summary}<p className='text-sm font-bold text-red-700'>刪除後無法恢復。請完整輸入以下文字：</p><p className='select-text rounded-xl bg-slate-100 p-3 text-sm font-bold text-slate-800'>{CHAT_CLEANUP_CONFIRMATION}</p><input aria-label='永久刪除確認文字' autoComplete='off' value={confirmation} disabled={phase === 'deleting'} onChange={event => setConfirmation(event.target.value)} placeholder='在這裡輸入確認文字' className='w-full rounded-xl border border-red-200 p-3 text-sm' /></div>
        </Modal>

        <Modal isOpen={phase === 'done'} title='清理完成' onClose={close}><p className='text-sm text-slate-700'>已永久刪除 {plan?.ids.length.toLocaleString()} 條選中記錄，其餘記錄保留。</p></Modal>
    </>;
}
