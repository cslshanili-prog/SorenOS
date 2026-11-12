import React from 'react';
import { Check } from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import TokenImg from '../os/TokenImg';
import { personaNameForKey, REAL_IDENTITY_PERSONA_ID } from '../../utils/userPersona';
import { altKnowledgeOf } from '../../utils/personaLinks';
import type { AltKnowledge, CharacterProfile, PersonaLink } from '../../types';

/**
 * 聊天設定「認識的你」（plans/persona-line-batch1-2.md 第 4 節）：這個角色認識哪幾張身份卡，每張一條線。
 * 只在關係線預覽開著時出現。勾一張＝開一條新的空線；拿掉＝藏起來不刪，加回來紀錄都還在；
 * 主線（角色原本認識的那張）不能拿掉。改的是角色自己的欄位，當下就存，不跟頁面的「完成」走。
 */
const KnownPersonasSection: React.FC<{ char: CharacterProfile }> = ({ char }) => {
    const { personaLinesEnabled, userProfileBase, characters, updateCharacter } = useOS();
    if (!personaLinesEnabled) return null;
    // 拿原角色卡（頁面拿到的 char 可能是某條線的視圖）
    const raw = characters.find(c => c.id === char.id) || char;
    const primary = raw.primaryPersonaKey || REAL_IDENTITY_PERSONA_ID;
    const known = raw.knownPersonaKeys?.length ? raw.knownPersonaKeys : [primary];
    const cards = [
        { key: REAL_IDENTITY_PERSONA_ID, name: userProfileBase.name || '我', avatar: userProfileBase.avatar },
        ...(userProfileBase.personas || []).map(p => ({ key: p.id, name: p.name, avatar: p.avatar })),
    ];

    const toggle = (key: string) => {
        if (key === primary) return;
        const next = known.includes(key) ? known.filter(k => k !== key) : [...known, key];
        updateCharacter(raw.id, { knownPersonaKeys: next.includes(primary) ? next : [primary, ...next] });
    };

    // 小號（plans/persona-line-batch4.md）：兩張卡他都認識，才有「知不知道是同一個人」
    const altLinks = (userProfileBase.personaLinks || []).filter((l): l is PersonaLink =>
        l.kind === 'alt' && known.includes(l.a) && known.includes(l.b));
    const fmt = (ms: number) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()}`; };
    const statusText = (k: AltKnowledge | undefined) => !k ? '他不知道'
        : k.state === 'known' ? '他一直都知道'
        : k.state === 'discovered' ? `他在 ${fmt(k.at)} ${k.how === 'admitted' ? '起疑、你承認了' : '發現了'}`
        : `他懷疑過，你否認了 ${k.times} 次`;
    // 這裡改的是設定（不是劇情）：只切「知道／不知道」，不落任何卡片
    const setKnows = (link: PersonaLink, knows: boolean) => {
        updateCharacter(raw.id, prev => {
            const next = { ...(prev.altKnowledge || {}) };
            if (knows) next[link.id] = { state: 'known', since: Date.now() };
            else delete next[link.id];
            return { altKnowledge: next };
        });
    };

    return (
        <section>
            <h2 className="px-2 pb-2 text-[11px] font-bold tracking-widest text-slate-400">認識的你</h2>
            <div className="bg-white rounded-[1.75rem] border border-slate-100 shadow-[0_10px_30px_-18px_rgba(80,70,120,0.25)] divide-y divide-slate-100">
                {cards.map(card => {
                    const on = known.includes(card.key);
                    const isPrimary = card.key === primary;
                    return (
                        <button
                            key={card.key}
                            type="button"
                            onClick={() => toggle(card.key)}
                            disabled={isPrimary}
                            aria-pressed={on}
                            className="w-full flex items-center gap-3 px-5 py-3 text-left disabled:cursor-default"
                        >
                            <TokenImg value={card.avatar} className="w-8 h-8 rounded-full object-cover bg-slate-100 shrink-0" alt="" />
                            <span className="flex-1 min-w-0">
                                <span className="block text-[15px] text-slate-700 truncate">{card.name}</span>
                                {isPrimary && <span className="block text-[11px] text-slate-400">原本那條線，不能拿掉</span>}
                            </span>
                            <span className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${on ? 'bg-primary text-white' : 'border border-slate-200'}`}>
                                {on && <Check size={13} weight="bold" />}
                            </span>
                        </button>
                    );
                })}
            </div>
            <p className="px-2 pt-2 text-[11px] leading-relaxed text-slate-400">
                勾一張就多一條線：切到那張卡時，跟 {char.name} 聊的是另一段，記錄和關係各自分開。拿掉只是藏起來，加回來都還在。
            </p>
            {altLinks.length > 0 && (
                <div className="mt-4">
                    <h3 className="px-2 pb-2 text-[11px] font-bold tracking-widest text-slate-400">小號</h3>
                    <div className="bg-white rounded-[1.75rem] border border-slate-100 shadow-[0_10px_30px_-18px_rgba(80,70,120,0.25)] divide-y divide-slate-100">
                        {altLinks.map(link => {
                            const k = altKnowledgeOf(raw, link);
                            const knows = k?.state === 'known' || k?.state === 'discovered';
                            return (
                                <div key={link.id} className="flex items-center gap-3 px-5 py-3">
                                    <span className="flex-1 min-w-0">
                                        <span className="block text-[14px] text-slate-700">「{personaNameForKey(userProfileBase, link.b)}」是「{personaNameForKey(userProfileBase, link.a)}」的小號</span>
                                        <span className="block text-[11px] text-slate-400">{statusText(k)}</span>
                                    </span>
                                    <button type="button" onClick={() => setKnows(link, !knows)} aria-pressed={knows}
                                        className={`shrink-0 px-3 py-1.5 rounded-full text-[11px] font-bold border transition ${knows ? 'bg-primary text-white border-primary' : 'bg-white text-slate-500 border-slate-200'}`}>
                                        {knows ? '知道' : '不知道'}
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                    <p className="px-2 pt-2 text-[11px] leading-relaxed text-slate-400">
                        這裡切的是設定：切成「知道」就當他一直都知道，不會有反應。
                    </p>
                </div>
            )}
        </section>
    );
};

export default KnownPersonasSection;
