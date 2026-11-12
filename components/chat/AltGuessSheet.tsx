import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import type { CharacterProfile } from '../../types';
import { useOS } from '../../context/OSContext';
import TokenImg from '../os/TokenImg';
import { ALT_GUESS_REASON_MAX } from '../../utils/altReveal';
import { runAltGuess } from '../../utils/altRevealActions';
import { trackEvent } from '../../utils/analytics';

/**
 * 小號私聊「＋ → 我知道你是誰」（關係線第 7 批 7d）：選一個你覺得的人（或自己寫名字）、寫根據，送出去讓它決定認不認。
 * 名單是你認識的角色（不列小號）；猜錯人就是猜錯，它照小號的身份回你。
 */
const AltGuessSheet: React.FC<{
    alt: CharacterProfile;
    userName: string;
    onClose: () => void;
    onDone: () => void;
}> = ({ alt, userName, onClose, onDone }) => {
    const { characters, apiConfig, updateCharacter, addToast } = useOS();
    const owner = characters.find(c => c.id === alt.altOf);
    const sameWorld = (c: CharacterProfile) => (owner?.groupId ? c.groupId === owner.groupId : true);
    const candidates = characters.filter(c => !c.altOf).sort((a, b) => Number(sameWorld(b)) - Number(sameWorld(a)));
    const [picked, setPicked] = useState<string | null>(null);
    const [typed, setTyped] = useState('');
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);
    const guessName = (picked ? characters.find(c => c.id === picked)?.name : typed.trim()) || '';

    const send = async () => {
        if (!owner || !guessName || busy) return;
        setBusy(true);
        try {
            const { admitted, patch } = await runAltGuess({ alt, owner, guessName, reason, userName, apiConfig });
            if (Object.keys(patch).length) updateCharacter(alt.id, patch);
            trackEvent('我知道你是谁', { 结果: admitted ? '认了' : guessName === owner.name ? '没认' : '猜错' });
            if (admitted) trackEvent('小号被认出来', { 方式: '你认出来' });
            onDone();
            onClose();
        } catch (e: any) {
            addToast(e?.message || '沒送出去，再試一次', 'error');
        } finally {
            setBusy(false);
        }
    };

    return createPortal(
        <div className="fixed inset-0 z-[120] flex items-end bg-black/30 animate-fade-in" onClick={onClose}>
            <div className="w-full max-h-[85%] overflow-y-auto bg-slate-50 rounded-t-3xl p-4 space-y-3" style={{ paddingBottom: 'calc(1rem + var(--safe-bottom, 0px))' }} onClick={e => e.stopPropagation()}>
                <div className="text-sm font-bold text-slate-800">我知道你是誰</div>
                <p className="text-[11px] text-slate-400 leading-relaxed">你覺得「{alt.name}」其實是誰？說出你的根據，TA 會看你說得有沒有道理，自己決定認不認。</p>
                <div className="flex flex-wrap gap-1.5">
                    {candidates.map(c => (
                        <button key={c.id} onClick={() => { setPicked(c.id === picked ? null : c.id); setTyped(''); }} aria-pressed={picked === c.id}
                            className={`flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-full text-xs font-semibold ${picked === c.id ? 'bg-rose-500 text-white' : 'bg-white text-slate-600 shadow-sm'}`}>
                            <TokenImg value={c.avatar} className="w-6 h-6 rounded-full object-cover bg-slate-100" alt="" />
                            {c.name}
                        </button>
                    ))}
                </div>
                <input value={typed} onChange={e => { setTyped(e.target.value.slice(0, 20)); setPicked(null); }} placeholder="或自己寫名字" className="w-full bg-white rounded-xl px-3 py-2 text-xs text-slate-700 shadow-sm outline-none" />
                <textarea value={reason} onChange={e => setReason(e.target.value.slice(0, ALT_GUESS_REASON_MAX))} rows={3} placeholder="你的根據（說話習慣、提到的事、時間對得上……）"
                    className="w-full bg-white rounded-xl px-3 py-2 text-xs text-slate-700 shadow-sm outline-none resize-none" />
                <div className="flex gap-2">
                    <button onClick={onClose} disabled={busy} className="px-4 py-2.5 rounded-2xl bg-white text-xs font-bold text-slate-400 shadow-sm">取消</button>
                    <button onClick={send} disabled={busy || !guessName || !owner} className="flex-1 py-2.5 rounded-2xl bg-rose-500 text-white text-xs font-bold disabled:opacity-50">{busy ? 'TA 在想…' : guessName ? `說出來：你是${guessName}吧？` : '先選一個人'}</button>
                </div>
            </div>
        </div>,
        document.body,
    );
};

export default AltGuessSheet;
