import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { CaretLeft, ChatsCircle } from '@phosphor-icons/react';
import type { CharacterProfile, Message } from '../../types';
import { useOS } from '../../context/OSContext';
import TokenImg from '../os/TokenImg';
import { sortByCast } from '../../utils/castRole';
import { pairLineId, pairSpeakerOf, parsePairLineId } from '../../utils/pairLine';
import { archivePairIfNeeded, commitPairToPhones, loadPairMessages, nextOpener, runPairRound } from '../../utils/pairChatRun';
import { personaKeyForChar, resolveUserProfileForChar } from '../../utils/userPersona';
import { trackEvent } from '../../utils/analytics';

/**
 * 角色私聊（plans/persona-line-batch6.md 第 2 節）：兩個角色之間的那條線。你只能看、按「讓他們聊一輪」、
 * 或冒充其中一個人說一句；它們不知道你看得到。不傳 pairId 就先挑兩個人。
 */
const PairChatPage: React.FC<{ pairId?: string; onClose: () => void }> = ({ pairId: initialPairId, onClose }) => {
    const { characters, apiConfig, userProfileBase, updateCharacter, addToast } = useOS();
    const [pairId, setPairId] = useState<string | null>(initialPairId || null);
    const [picked, setPicked] = useState<string[]>([]);
    const [msgs, setMsgs] = useState<Message[]>([]);
    const [busy, setBusy] = useState(false);
    const [asId, setAsId] = useState<string>('');
    const [draft, setDraft] = useState('');

    const ids = pairId ? parsePairLineId(pairId) : null;
    const left = ids ? characters.find(c => c.id === ids[0]) : undefined;
    const right = ids ? characters.find(c => c.id === ids[1]) : undefined;
    const charOf = (id: string) => characters.find(c => c.id === id);

    const reload = useCallback(async () => {
        if (!ids) return;
        setMsgs(await loadPairMessages(ids[0], ids[1]));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pairId]);
    useEffect(() => { void reload(); }, [reload]);

    const run = async (asText?: string) => {
        if (!left || !right || busy) return;
        if (!apiConfig.apiKey) { addToast('請先配置 API', 'error'); return; }
        // 冒充 X 說話：A＝另一個人（回話的那個），B＝X；不然誰最後說話就換另一個先開口
        const [aId, bId] = asText ? [asId === left.id ? right.id : left.id, asId] : nextOpener(msgs, left.id, right.id);
        const a = charOf(aId) as CharacterProfile;
        const b = charOf(bId) as CharacterProfile;
        setBusy(true);
        try {
            const round = await runPairRound({
                a, b, api: apiConfig as any,
                userA: resolveUserProfileForChar(userProfileBase, a), userB: resolveUserProfileForChar(userProfileBase, b),
                samePersona: personaKeyForChar(userProfileBase, a) === personaKeyForChar(userProfileBase, b),
                asB: asText,
            });
            if (!round.added) { addToast('他們沒說話，再試一次', 'error'); return; }
            commitPairToPhones({ a, b, round, updateCharacter });
            void archivePairIfNeeded({ a, b, aFull: round.aFull, api: apiConfig as any, updateCharacter })
                .then(mark => { if (mark) addToast(`更早的 ${mark} 條已經整理成兩邊的話題記憶`, 'info'); });
            trackEvent('让他们聊一轮', { 方式: asText ? '冒充' : '聊一轮' });
            if (asText) setDraft('');
            await reload();
        } catch (e: any) {
            console.error(e);
            addToast(e?.message || '沒聊成，再試一次', 'error');
        } finally {
            setBusy(false);
        }
    };

    const candidates = useMemo(() => sortByCast(characters), [characters]);

    const header = (
        <div className="flex items-center gap-2 px-3 bg-white border-b border-slate-100 shrink-0" style={{ paddingTop: 'calc(0.6rem + var(--safe-top))', paddingBottom: '0.6rem' }}>
            <button onClick={onClose} aria-label="返回" className="w-9 h-9 rounded-full flex items-center justify-center text-slate-600 hover:bg-slate-100">
                <CaretLeft size={20} weight="bold" />
            </button>
            {left && right ? (
                <div className="min-w-0 flex-1 flex items-center gap-2">
                    <div className="relative w-10 h-8 shrink-0">
                        <TokenImg value={left.avatar} className="absolute left-0 top-0 w-7 h-7 rounded-full object-cover bg-slate-100 border-2 border-white" alt="" />
                        <TokenImg value={right.avatar} className="absolute right-0 bottom-0 w-7 h-7 rounded-full object-cover bg-slate-100 border-2 border-white" alt="" />
                    </div>
                    <div className="min-w-0">
                        <div className="text-sm font-bold text-slate-800 truncate">{left.name} × {right.name}</div>
                        <div className="text-[10px] text-slate-400">角色私聊 · 他們不知道你看得到</div>
                    </div>
                </div>
            ) : <div className="text-sm font-bold text-slate-800">讓兩個角色聊聊</div>}
        </div>
    );

    if (!pairId || !left || !right) {
        return createPortal(
            <div className="fixed inset-0 z-[110] flex flex-col bg-slate-50 animate-fade-in">
                {header}
                <div className="flex-1 overflow-y-auto px-5 py-5">
                    <p className="text-[11px] text-slate-400 mb-3">挑兩個人（{picked.length}/2）</p>
                    <div className="grid grid-cols-4 gap-3">
                        {candidates.map(c => {
                            const on = picked.includes(c.id);
                            return (
                                <button key={c.id} aria-pressed={on}
                                    onClick={() => setPicked(prev => (on ? prev.filter(x => x !== c.id) : prev.length < 2 ? [...prev, c.id] : [prev[1], c.id]))}
                                    className={`flex flex-col items-center gap-1 py-2 rounded-2xl border ${on ? 'border-violet-400 bg-violet-50' : 'border-transparent'}`}>
                                    <TokenImg value={c.avatar} className="w-12 h-12 rounded-full object-cover bg-slate-100" alt="" />
                                    <span className="text-[11px] font-bold text-slate-600 truncate max-w-full px-1">{c.name}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>
                <div className="px-5 pt-2 shrink-0" style={{ paddingBottom: 'calc(1rem + var(--safe-bottom))' }}>
                    <button disabled={picked.length !== 2}
                        onClick={() => { const id = pairLineId(picked[0], picked[1]); setPairId(id); setAsId(''); }}
                        className="w-full py-3 rounded-2xl bg-violet-500 text-white text-sm font-bold disabled:opacity-50">打開他們的私聊</button>
                </div>
            </div>,
            document.body,
        );
    }

    return createPortal(
        <div className="fixed inset-0 z-[110] flex flex-col bg-slate-50 animate-fade-in">
            {header}
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2">
                {msgs.length === 0 && <div className="py-16 text-center text-xs text-slate-400">他們還沒私下聊過，按下面讓他們聊一輪</div>}
                {msgs.map(m => {
                    const speaker = pairSpeakerOf(m);
                    const isLeft = speaker !== right.id;
                    const who = charOf(speaker || '') || (isLeft ? left : right);
                    return (
                        <div key={m.id} className={`flex items-end gap-2 ${isLeft ? '' : 'flex-row-reverse'}`}>
                            <TokenImg value={who.avatar} className="w-8 h-8 rounded-full object-cover bg-slate-100 shrink-0" alt={who.name} />
                            <div className={`max-w-[72%] ${isLeft ? '' : 'text-right'}`}>
                                <div className="text-[10px] text-slate-400 mb-0.5">{who.name}{m.metadata?.impersonated ? ' · 你代說的' : ''}</div>
                                <div className={`inline-block text-left px-3 py-2 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${isLeft ? 'bg-white text-slate-700 rounded-bl-md' : 'bg-violet-500 text-white rounded-br-md'}`}>{m.content}</div>
                            </div>
                        </div>
                    );
                })}
            </div>
            <div className="shrink-0 bg-white border-t border-slate-100 px-4 pt-3 space-y-2" style={{ paddingBottom: 'calc(0.8rem + var(--safe-bottom))' }}>
                <button onClick={() => run()} disabled={busy}
                    className="w-full py-2.5 rounded-2xl bg-violet-500 text-white text-sm font-bold flex items-center justify-center gap-2 disabled:opacity-60">
                    <ChatsCircle size={18} weight="fill" />{busy ? '他們在聊…' : '讓他們聊一輪'}
                </button>
                <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold text-slate-400 shrink-0">以</span>
                    {[left, right].map(c => (
                        <button key={c.id} onClick={() => setAsId(asId === c.id ? '' : c.id)} aria-pressed={asId === c.id}
                            className={`shrink-0 px-2.5 py-1 rounded-full text-[11px] font-bold border ${asId === c.id ? 'bg-violet-500 border-violet-500 text-white' : 'bg-white border-slate-200 text-slate-500'}`}>{c.name}</button>
                    ))}
                    <span className="text-[10px] font-bold text-slate-400 shrink-0">身份說</span>
                </div>
                {asId && (
                    <div className="flex gap-2">
                        <input value={draft} onChange={e => setDraft(e.target.value.slice(0, 300))}
                            onKeyDown={e => { if (e.key === 'Enter' && draft.trim()) void run(draft.trim()); }}
                            placeholder={`以「${charOf(asId)?.name}」的身份說一句，另一個人會回`}
                            className="flex-1 min-w-0 bg-slate-100 rounded-2xl px-4 py-2.5 text-sm outline-none" />
                        <button onClick={() => draft.trim() && run(draft.trim())} disabled={busy || !draft.trim()}
                            className="px-4 rounded-2xl bg-slate-800 text-white text-xs font-bold disabled:opacity-50">送出</button>
                    </div>
                )}
                {asId && <p className="text-[9px] text-slate-400 leading-tight">你代說的會記成「{charOf(asId)?.name}」說的，TA 之後也會記得自己說過。</p>}
            </div>
        </div>,
        document.body,
    );
};

export default PairChatPage;
