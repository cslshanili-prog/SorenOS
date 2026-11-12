import React, { useEffect, useState } from 'react';
import type { CharacterProfile } from '../../types';
import { useOS } from '../../context/OSContext';
import TokenImg from '../os/TokenImg';
import { dueAltRequests, type AltRequestAction } from '../../utils/altFriend';
import { answerAltRequest } from '../../utils/altFriendActions';
import { personaNameForKey } from '../../utils/userPersona';
import { trackEvent } from '../../utils/analytics';

/**
 * 訊息列表頂端的「新的朋友」（關係線第 7 批 7c）：角色的小號來加你。你不知道是誰，只看得到小號的名字、頭像、簡介和招呼。
 * 通過 → 小號出現在私聊裡；拒絕 → 要不要再來由它決定；封鎖 → 不會再來（本人編輯頁的小號那一區可以解除）。
 */
const AltRequestsBlock: React.FC<{
    activePersonaKey: string;
    onAccepted: (alt: CharacterProfile, personaKey: string) => void;
}> = ({ activePersonaKey, onAccepted }) => {
    const { characters, updateCharacter, userProfileBase, personaLinesEnabled, addToast } = useOS();
    const [now, setNow] = useState(() => Date.now());
    const [busy, setBusy] = useState<string | null>(null);
    useEffect(() => {
        const t = window.setInterval(() => setNow(Date.now()), 30_000);
        return () => window.clearInterval(t);
    }, []);
    if (!personaLinesEnabled) return null;
    const due = dueAltRequests(characters, now);
    if (!due.length) return null;

    const answer = async (alt: CharacterProfile, action: AltRequestAction) => {
        if (busy) return;
        setBusy(alt.id);
        try {
            const personaKey = alt.altFriendRequest!.personaKey;
            const patch = await answerAltRequest(alt, action);
            if (!patch) return;
            updateCharacter(alt.id, patch);
            trackEvent('回复小号好友申请', { 结果: action === 'accept' ? '通过' : action === 'reject' ? '拒绝' : '封锁' });
            if (action === 'accept') onAccepted({ ...alt, ...patch }, personaKey);
            else addToast(action === 'block' ? `封鎖了「${alt.name}」` : `拒絕了「${alt.name}」`, 'info');
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="mb-4">
            <div className="text-[11px] font-bold text-slate-400 mb-1.5 px-1">新的朋友</div>
            <div className="space-y-1.5">
                {due.map(alt => {
                    const req = alt.altFriendRequest!;
                    const toOther = req.personaKey !== activePersonaKey;
                    return (
                        <div key={alt.id} className="bg-white rounded-2xl px-3 py-2.5 shadow-sm">
                            <div className="flex items-center gap-3">
                                <TokenImg value={alt.avatar} className="w-11 h-11 rounded-2xl object-cover bg-slate-100 shrink-0" alt="" />
                                <div className="min-w-0 flex-1">
                                    <div className="text-sm font-bold text-slate-800 truncate">{alt.name}<span className="ml-1.5 text-[10px] font-semibold text-slate-400">想加你好友{toOther ? `（加的是${personaNameForKey(userProfileBase, req.personaKey)}）` : ''}</span></div>
                                    {alt.description && <div className="text-[10px] text-slate-400 truncate">{alt.description}</div>}
                                    <div className="text-xs text-slate-600 mt-0.5 break-words">{req.greeting ? `「${req.greeting}」` : '（沒有附招呼）'}</div>
                                </div>
                            </div>
                            <div className="flex gap-2 mt-2">
                                <button disabled={!!busy} onClick={() => answer(alt, 'block')} className="px-3 py-1.5 rounded-xl bg-slate-100 text-[11px] font-bold text-rose-400 disabled:opacity-50">封鎖</button>
                                <button disabled={!!busy} onClick={() => answer(alt, 'reject')} className="px-3 py-1.5 rounded-xl bg-slate-100 text-[11px] font-bold text-slate-500 disabled:opacity-50">拒絕</button>
                                <button disabled={!!busy} onClick={() => answer(alt, 'accept')} className="flex-1 py-1.5 rounded-xl bg-primary text-white text-[11px] font-bold disabled:opacity-50">通過</button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export default AltRequestsBlock;
