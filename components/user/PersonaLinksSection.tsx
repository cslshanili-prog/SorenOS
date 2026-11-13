import React, { useMemo, useState } from 'react';
import { Trash } from '@phosphor-icons/react';
import type { PersonaLink } from '../../types';
import { useOS } from '../../context/OSContext';
import { knowsPersona } from '../../utils/chatLine';
import { personaNameForKey, REAL_IDENTITY_PERSONA_ID } from '../../utils/userPersona';
import { linksOf, otherSide } from '../../utils/personaLinks';

type NewKind = 'sameWorld' | 'altOther' | 'altMe';

/**
 * 身份卡編輯頁的「跟其他身份的關係」（plans/persona-line-batch4.md 第 1 節）。
 * 連結改了就存（不等編輯頁的打勾），兩兩設，一張卡可以有好幾條。
 * 小號那一種，建的時候順便勾「讓哪些角色知道」：只列兩張都認識的角色，勾了就是「一直都知道」。
 */
const PersonaLinksSection: React.FC<{ personaKey: string }> = ({ personaKey }) => {
    const { userProfileBase, updateUserProfile, characters, updateCharacter, addToast } = useOS();
    const links = linksOf(userProfileBase, personaKey);
    const name = (key: string) => personaNameForKey(userProfileBase, key);
    const allKeys = [REAL_IDENTITY_PERSONA_ID, ...(userProfileBase.personas || []).map(p => p.id)];
    const candidates = allKeys.filter(k => k !== personaKey);

    const [adding, setAdding] = useState(false);
    const [other, setOther] = useState('');
    const [kind, setKind] = useState<NewKind>('sameWorld');
    const [mine, setMine] = useState('');
    const [theirs, setTheirs] = useState('');
    const [knowers, setKnowers] = useState<string[]>([]);

    // 兩張都認識的角色（小號對他才有意義）
    const bothKnow = useMemo(() => (other
        ? characters.filter(c => knowsPersona(c, personaKey) && knowsPersona(c, other))
        : []), [characters, personaKey, other]);

    const reset = () => { setAdding(false); setOther(''); setKind('sameWorld'); setMine(''); setTheirs(''); setKnowers([]); };

    const create = () => {
        if (!other) { addToast('先選另一張身份卡', 'error'); return; }
        const isAlt = kind !== 'sameWorld';
        const a = kind === 'altMe' ? other : personaKey;
        const b = kind === 'altMe' ? personaKey : other;
        const exists = (userProfileBase.personaLinks || []).some(l => l.kind === (isAlt ? 'alt' : 'sameWorld')
            && ((l.a === a && l.b === b) || (l.a === b && l.b === a)));
        if (exists) { addToast('這兩張卡已經有這種連結了', 'error'); return; }
        const link: PersonaLink = {
            id: `pl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            kind: isAlt ? 'alt' : 'sameWorld',
            a, b,
            ...(!isAlt && mine.trim() ? { aToB: mine.trim() } : {}),
            ...(!isAlt && theirs.trim() ? { bToA: theirs.trim() } : {}),
            createdAt: Date.now(),
        };
        void updateUserProfile(prev => ({ personaLinks: [...(prev.personaLinks || []), link] }));
        if (isAlt) {
            const now = Date.now();
            for (const id of knowers) {
                updateCharacter(id, prev => ({ altKnowledge: { ...(prev.altKnowledge || {}), [link.id]: { state: 'known', since: now } } }));
            }
        }
        addToast('連結已建好', 'success');
        reset();
    };

    const remove = (link: PersonaLink) => {
        void updateUserProfile(prev => ({ personaLinks: (prev.personaLinks || []).filter(l => l.id !== link.id) }));
        for (const c of characters) {
            if (!c.altKnowledge?.[link.id]) continue;
            updateCharacter(c.id, prev => {
                const { [link.id]: _gone, ...rest } = prev.altKnowledge || {};
                return { altKnowledge: rest };
            });
        }
    };

    const describe = (link: PersonaLink) => {
        const them = name(otherSide(link, personaKey));
        if (link.kind === 'alt') return link.a === personaKey ? `「${them}」是我的小號` : `我是「${them}」的小號`;
        const m = link.a === personaKey ? link.aToB : link.bToA;
        const t = link.a === personaKey ? link.bToA : link.aToB;
        if (!m && !t) return `跟「${them}」互相認識`;
        return `互相認識：${m ? `我是「${them}」的${m}` : ''}${m && t ? '，' : ''}${t ? `「${them}」是我的${t}` : ''}`;
    };
    const knownBy = (link: PersonaLink) => characters.filter(c => {
        const k = c.altKnowledge?.[link.id];
        return k && (k.state === 'known' || k.state === 'discovered');
    }).map(c => c.name);

    const input = 'w-full bg-slate-50 focus:bg-white border border-slate-100 focus:border-primary/30 rounded-xl px-3 py-2 text-xs text-slate-700 outline-none transition-all placeholder:text-slate-300';

    return (
        <div className="mt-5">
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">跟其他身份的關係</label>
            <div className="space-y-2">
                {links.length === 0 && !adding && (
                    <p className="text-[11px] text-slate-400 leading-relaxed">還沒有連結。可以設「互相認識」（例如姊妹、同事）或「小號」——角色只會知道你讓他知道的。</p>
                )}
                {links.map(link => (
                    <div key={link.id} className="flex items-start gap-2 rounded-xl bg-slate-50 border border-slate-100 px-3 py-2.5">
                        <div className="flex-1 min-w-0">
                            <div className="text-xs font-bold text-slate-700">{describe(link)}</div>
                            {link.kind === 'alt' && (
                                <div className="text-[10px] text-slate-400 mt-0.5">
                                    {knownBy(link).length ? `知道的角色：${knownBy(link).join('、')}` : '還沒有角色知道'}
                                    <span className="text-slate-300">（在聊天設定「認識的你」裡單獨改）</span>
                                </div>
                            )}
                        </div>
                        <button onClick={() => remove(link)} aria-label="刪除這條連結" className="w-7 h-7 rounded-full text-slate-400 hover:bg-white flex items-center justify-center shrink-0">
                            <Trash size={14} />
                        </button>
                    </div>
                ))}

                {adding ? (
                    <div className="rounded-xl border border-primary/20 bg-white px-3 py-3 space-y-2.5">
                        <select value={other} onChange={e => { setOther(e.target.value); setKnowers([]); }} className={input}>
                            <option value="">選另一張身份卡</option>
                            {candidates.map(k => <option key={k} value={k}>{name(k)}</option>)}
                        </select>
                        <div className="flex flex-wrap gap-1.5">
                            {([['sameWorld', '互相認識'], ['altOther', '對方是我的小號'], ['altMe', '我是對方的小號']] as [NewKind, string][]).map(([k, label]) => (
                                <button key={k} onClick={() => setKind(k)}
                                    className={`px-3 py-1.5 rounded-full text-[11px] font-bold border transition ${kind === k ? 'bg-primary text-white border-primary' : 'bg-white text-slate-500 border-slate-200'}`}>
                                    {label}
                                </button>
                            ))}
                        </div>
                        {kind === 'sameWorld' ? (
                            <div className="grid grid-cols-2 gap-2">
                                <input value={mine} onChange={e => setMine(e.target.value)} placeholder="我是對方的…（例：姊姊）" className={input} />
                                <input value={theirs} onChange={e => setTheirs(e.target.value)} placeholder="對方是我的…（例：妹妹）" className={input} />
                            </div>
                        ) : (
                            <div>
                                <div className="text-[10px] text-slate-400 mb-1.5">讓哪些角色知道（只列兩張卡都認識的；之後也能在角色那邊改）</div>
                                {!other ? <div className="text-[11px] text-slate-300">先選另一張身份卡</div>
                                    : bothKnow.length === 0 ? <div className="text-[11px] text-slate-300">還沒有角色同時認識這兩張卡</div>
                                    : (
                                        <div className="flex flex-wrap gap-1.5">
                                            {bothKnow.map(c => {
                                                const on = knowers.includes(c.id);
                                                return (
                                                    <button key={c.id} onClick={() => setKnowers(on ? knowers.filter(x => x !== c.id) : [...knowers, c.id])}
                                                        className={`px-3 py-1.5 rounded-full text-[11px] font-bold border transition ${on ? 'bg-primary/10 text-primary border-primary/40' : 'bg-white text-slate-500 border-slate-200'}`}>
                                                        {on ? '✓ ' : ''}{c.name}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}
                            </div>
                        )}
                        <div className="flex gap-2 pt-1">
                            <button onClick={reset} className="flex-1 py-2 rounded-xl text-xs font-bold text-slate-500 bg-slate-100">取消</button>
                            <button onClick={create} className="flex-1 py-2 rounded-xl text-xs font-bold text-white bg-primary">建立</button>
                        </div>
                    </div>
                ) : candidates.length > 0 && (
                    <button onClick={() => setAdding(true)} className="w-full rounded-xl border border-dashed border-slate-200 py-2.5 text-[11px] font-bold text-slate-500 active:scale-[0.99] transition">
                        ＋ 新增連結
                    </button>
                )}
            </div>
        </div>
    );
};

export default PersonaLinksSection;
