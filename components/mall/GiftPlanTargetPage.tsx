/**
 * 購物中心「打算送 TA」選對象（全螢幕，plans/bond-batch5.md 2.3）：哪個角色 × 哪張身份卡（一條線一段關係）。
 * 只列能收禮的角色（拉黑中的不列）；只有一張卡的角色只寫名字。
 */
import React, { useMemo, useState } from 'react';
import { CaretLeft, MagnifyingGlass } from '@phosphor-icons/react';
import type { CharacterProfile, MallProduct, UserProfile } from '../../types';
import { listPersonaSpaces } from '../../utils/bond/spaces';
import { allRegisteredBonds } from '../../utils/bond/registry';
import { personaNameForKey } from '../../utils/userPersona';
import { EmojiTile } from './MallParts';

export interface GiftPlanTarget { bondId: string; charId: string; personaKey: string; charName: string }

const GiftPlanTargetPage: React.FC<{
    product: MallProduct;
    characters: CharacterProfile[];
    /** 能收禮的角色 id（購物中心的 recipients） */
    allowed: string[];
    userProfileBase: UserProfile;
    onBack: () => void;
    onPick: (t: GiftPlanTarget) => void;
}> = ({ product, characters, allowed, userProfileBase, onBack, onPick }) => {
    const [q, setQ] = useState('');
    const rows = useMemo(() => {
        const ok = new Set(allowed);
        const spaces = listPersonaSpaces(characters.filter(c => ok.has(c.id)), allRegisteredBonds());
        const count = new Map<string, number>();
        for (const s of spaces) count.set(s.charId, (count.get(s.charId) || 0) + 1);
        return spaces.map(s => {
            const c = characters.find(x => x.id === s.charId)!;
            return { ...s, char: c, persona: count.get(s.charId)! > 1 ? personaNameForKey(userProfileBase, s.personaKey) : '' };
        });
    }, [characters, allowed, userProfileBase]);
    const shown = rows.filter(r => !q.trim() || r.char.name.includes(q.trim()) || r.persona.includes(q.trim()));

    return (
        <div className="fixed inset-0 z-[120] flex flex-col bg-white animate-fade-in" onClick={e => e.stopPropagation()} style={{ paddingBottom: 'var(--safe-bottom)' }}>
            <div className="shrink-0 border-b border-slate-100" style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="flex items-center gap-2 px-3 py-2.5">
                    <button onClick={onBack} className="p-1.5 rounded-full active:bg-slate-100" aria-label="返回"><CaretLeft size={22} className="text-slate-800" /></button>
                    <div className="flex-1 min-w-0 truncate text-[16px] font-black text-slate-900">打算送給誰</div>
                </div>
                <div className="px-4 pb-3 flex items-center gap-3">
                    <EmojiTile emoji={product.emoji} size="sm" />
                    <div className="min-w-0">
                        <div className="text-[14px] font-bold text-slate-900 truncate">{product.name}</div>
                        <div className="text-[11.5px] text-slate-400">記進你們的羈絆，只有你看得到；買了會自己連上</div>
                    </div>
                </div>
                {rows.length > 6 && (
                    <div className="px-4 pb-3">
                        <div className="flex items-center gap-2 rounded-xl bg-slate-100 px-3 py-2">
                            <MagnifyingGlass size={15} className="text-slate-400" />
                            <input value={q} onChange={e => setQ(e.target.value)} placeholder="找角色" className="flex-1 bg-transparent text-[13.5px] outline-none" />
                        </div>
                    </div>
                )}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar">
                {shown.length === 0 ? (
                    <p className="py-16 text-center text-[13px] text-slate-400">{rows.length ? '沒有符合的角色' : '還沒有可以送的角色'}</p>
                ) : shown.map(r => (
                    <button key={r.id} onClick={() => onPick({ bondId: r.id, charId: r.charId, personaKey: r.personaKey, charName: r.char.name })}
                        className="w-full flex items-center gap-3 px-4 py-3 border-b border-slate-50 text-left active:bg-slate-50">
                        {r.char.avatar ? <img src={r.char.avatar} alt="" className="w-10 h-10 rounded-full object-cover shrink-0" /> : <div className="w-10 h-10 rounded-full bg-slate-200 shrink-0" />}
                        <div className="min-w-0">
                            <div className="text-[14.5px] font-bold text-slate-900 truncate">{r.char.name}</div>
                            {r.persona && <div className="text-[11.5px] text-slate-400 truncate">和「{r.persona}」的那段</div>}
                        </div>
                    </button>
                ))}
            </div>
        </div>
    );
};

export default GiftPlanTargetPage;
