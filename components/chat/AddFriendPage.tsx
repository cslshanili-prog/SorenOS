import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { CaretLeft, UserPlus } from '@phosphor-icons/react';
import type { CharacterProfile, FriendRequestRecord } from '../../types';
import { useOS } from '../../context/OSContext';
import TokenImg from '../os/TokenImg';
import { knowsPersona, lineFor } from '../../utils/chatLine';
import { globalPersonaKey, personaAvatarForKey, REAL_IDENTITY_PERSONA_ID } from '../../utils/userPersona';
import { faceForPersona, FRIEND_GREETING_MAX, sendFriendRequest } from '../../utils/friendRequest';
import { DB } from '../../utils/db';
import { trackEvent } from '../../utils/analytics';

/**
 * 加好友（plans/persona-line-batch4.md 第 3 節）：用「現在的我」去加一個還不認識這張卡的角色。
 * 不傳 char 就先列出不認識現在這張卡的角色讓你挑。通過了：這張卡加進他認識的卡、你的招呼和
 * 他的第一句話落在新的那條線上，接著打開聊天。拒絕了：記一筆，可以再送，他看得到你被拒過幾次。
 */
const AddFriendPage: React.FC<{
    char?: CharacterProfile | null;
    onClose: () => void;
    onAccepted: (charId: string) => void;
}> = ({ char: initial, onClose, onAccepted }) => {
    const { characters, userProfileBase, updateCharacter, apiConfig, addToast } = useOS();
    const [pickedId, setPickedId] = useState<string | null>(initial?.id || null);
    const [greeting, setGreeting] = useState('');
    const [sending, setSending] = useState(false);
    const personaKey = globalPersonaKey(userProfileBase);
    const face = faceForPersona(userProfileBase, personaKey, REAL_IDENTITY_PERSONA_ID);
    const char = characters.find(c => c.id === pickedId) || null;
    // 小號（關係線第 7 批）是它來加你，不在這裡列
    const strangers = characters.filter(c => !c.altOf && !knowsPersona(c, personaKey));
    const history: FriendRequestRecord[] = (char?.friendRequests?.[personaKey]) || [];

    const send = async () => {
        if (!char || sending) return;
        setSending(true);
        try {
            const decision = await sendFriendRequest({ char, face, greeting, history, apiConfig });
            const record: FriendRequestRecord = { at: Date.now(), greeting: greeting.trim(), accepted: decision.accepted, ...(decision.reply ? { reply: decision.reply } : {}) };
            updateCharacter(char.id, prev => ({
                friendRequests: { ...(prev.friendRequests || {}), [personaKey]: [...(prev.friendRequests?.[personaKey] || []), record] },
                ...(decision.accepted ? {
                    knownPersonaKeys: (prev.knownPersonaKeys || []).includes(personaKey) ? prev.knownPersonaKeys : [...(prev.knownPersonaKeys || []), personaKey],
                } : {}),
            }));
            trackEvent('送出好友申请', { 结果: decision.accepted ? '通过' : '被拒' });
            if (!decision.accepted) {
                setGreeting('');
                addToast(`${char.name} 沒有通過`, 'info');
                return;
            }
            // 新的那條線：你的招呼 → 成為好友 → 他的第一句話
            const line = lineFor({ id: char.id, primaryPersonaKey: char.primaryPersonaKey }, personaKey);
            const fields = { charId: char.id, ...(line.personaKey ? { personaKey: line.personaKey } : {}) };
            const now = Date.now();
            if (record.greeting) await DB.saveMessage({ ...fields, role: 'user', type: 'text', content: record.greeting, timestamp: now, metadata: { friendRequest: true } });
            await DB.saveMessage({ ...fields, role: 'system', type: 'text', content: `[系統: 你們已經是好友了，可以開始聊天了]`, timestamp: now + 1 });
            if (decision.reply) await DB.saveMessage({ ...fields, role: 'assistant', type: 'text', content: decision.reply, timestamp: now + 2 });
            addToast(`${char.name} 通過了你的好友申請`, 'success');
            onAccepted(char.id);
        } catch (e: any) {
            addToast(e?.message || '沒送出去，再試一次', 'error');
        } finally {
            setSending(false);
        }
    };

    return createPortal(
        <div className="fixed inset-0 z-[110] flex flex-col bg-slate-50 animate-fade-in">
            <div className="flex items-center gap-2 px-3 bg-white border-b border-slate-100 shrink-0" style={{ paddingTop: 'calc(0.6rem + var(--safe-top))', paddingBottom: '0.6rem' }}>
                <button onClick={() => (char && !initial ? setPickedId(null) : onClose())} aria-label="返回" className="w-9 h-9 rounded-full flex items-center justify-center text-slate-600 hover:bg-slate-100">
                    <CaretLeft size={20} weight="bold" />
                </button>
                <div className="text-sm font-bold text-slate-800">加好友</div>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-5" style={{ paddingBottom: 'calc(1.5rem + var(--safe-bottom))' }}>
                <div className="flex items-center gap-2 mb-4 text-[11px] text-slate-400">
                    <TokenImg value={personaAvatarForKey(userProfileBase, personaKey)} className="w-6 h-6 rounded-full object-cover bg-slate-200" alt="" />
                    以「<span className="font-bold text-slate-600">{face.name}</span>」的身份
                </div>

                {!char ? (
                    strangers.length === 0 ? (
                        <div className="py-16 text-center text-xs text-slate-400">每個角色都已經認識「{face.name}」了</div>
                    ) : (
                        <div className="space-y-1">
                            {strangers.map(c => {
                                const tries = (c.friendRequests?.[personaKey] || []).filter(r => !r.accepted).length;
                                return (
                                    <button key={c.id} onClick={() => setPickedId(c.id)}
                                        className="w-full flex items-center gap-3 px-2 py-2.5 rounded-2xl hover:bg-white active:bg-slate-100 transition-colors text-left">
                                        <TokenImg value={c.avatar} className="w-11 h-11 rounded-full object-cover bg-slate-100 shrink-0" alt="" />
                                        <div className="min-w-0 flex-1">
                                            <div className="text-sm font-bold text-slate-800 truncate">{c.name}</div>
                                            <p className="text-[11px] text-slate-400 truncate mt-0.5">{tries ? `被拒過 ${tries} 次` : (c.description || '還不認識你')}</p>
                                        </div>
                                        <UserPlus size={18} className="text-slate-400 shrink-0" />
                                    </button>
                                );
                            })}
                        </div>
                    )
                ) : (
                    <>
                        <div className="flex flex-col items-center text-center mb-5">
                            <TokenImg value={char.avatar} className="w-20 h-20 rounded-full object-cover bg-slate-100 mb-2.5" alt="" />
                            <div className="text-base font-bold text-slate-800">{char.name}</div>
                            {char.description && <p className="text-[11px] text-slate-400 mt-1 line-clamp-2 max-w-xs">{char.description}</p>}
                        </div>

                        {history.length > 0 && (
                            <div className="mb-4 space-y-1.5">
                                {history.map((h, i) => (
                                    <div key={i} className="rounded-xl bg-white border border-slate-100 px-3 py-2 text-[11px] leading-relaxed">
                                        <div className="text-slate-400">{new Date(h.at).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {h.accepted ? '通過了' : '沒有通過'}</div>
                                        {h.greeting && <div className="text-slate-600 mt-0.5">你：{h.greeting}</div>}
                                        {h.reply && <div className="text-slate-600 mt-0.5">{char.name}：{h.reply}</div>}
                                    </div>
                                ))}
                            </div>
                        )}

                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">打個招呼</label>
                        <textarea
                            value={greeting}
                            onChange={e => setGreeting(e.target.value.slice(0, FRIEND_GREETING_MAX))}
                            placeholder={`跟 ${char.name} 說一句（可以留空）`}
                            className="w-full h-24 bg-white border border-slate-200 focus:border-primary/40 rounded-xl px-4 py-2.5 text-sm text-slate-700 leading-relaxed resize-none outline-none placeholder:text-slate-300"
                        />
                        <button onClick={send} disabled={sending}
                            className="w-full mt-3 py-3 rounded-2xl bg-primary text-white text-sm font-bold active:scale-[0.99] transition disabled:opacity-60">
                            {sending ? `等 ${char.name} 決定…` : '送出好友申請'}
                        </button>
                        <p className="mt-2 text-[10px] leading-relaxed text-slate-400 text-center">
                            他看得到你的名字、頭像、簡介和招呼；之前被拒過的，他也記得。
                        </p>
                    </>
                )}
            </div>
        </div>,
        document.body,
    );
};

export default AddFriendPage;
