/**
 * 神經鏈接角色編輯頁（主角、配角都用）：
 * - 「主線是跟誰」：換主線那張身份卡（NPC 搬來的配角常常掛在當時唯一那張卡上）。
 * - 「關係」：TA 跟你、跟其他角色是什麼關係（提示詞「你身邊的人」讀的就是這份，utils/castRelations.ts）。
 * 兩個都改 formData，跟著編輯頁的自動保存走。
 */
import React from 'react';
import type { CharacterProfile, NPCRelationship } from '../../types';
import { useOS } from '../../context/OSContext';
import { DB } from '../../utils/db';
import { switchPrimaryPersona } from '../../utils/chatLine';
import { personaNameForKey, REAL_IDENTITY_PERSONA_ID } from '../../utils/userPersona';

type ChangeFn = (field: keyof CharacterProfile, value: any) => void;

const genId = () => `rel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export const PrimaryPersonaField: React.FC<{ char: CharacterProfile; onChange: ChangeFn }> = ({ char, onChange }) => {
    const { userProfileBase, addToast } = useOS();
    const primary = char.primaryPersonaKey || REAL_IDENTITY_PERSONA_ID;
    const known = char.knownPersonaKeys?.length ? char.knownPersonaKeys : [primary];
    const cards = [
        { key: REAL_IDENTITY_PERSONA_ID, name: userProfileBase.name || '我' },
        ...(userProfileBase.personas || []).map(p => ({ key: p.id, name: p.name })),
    ];

    const pick = async (key: string) => {
        if (key === primary) return;
        // 藏起來的舊線還有紀錄：換過去會跟主線疊在一起，先擋
        const hidden = await DB.getRecentMessagesByCharId({ charId: char.id, personaKey: key } as any, 1).catch(() => []);
        if (hidden.length) {
            addToast(`跟「${personaNameForKey(userProfileBase, key)}」那條線以前聊過，不能換成主線（在聊天設定「認識的你」把它勾回來就好）`, 'info');
            return;
        }
        const next = switchPrimaryPersona(char, key);
        if (!next) return;
        onChange('primaryPersonaKey', next.primaryPersonaKey);
        onChange('knownPersonaKeys', next.knownPersonaKeys);
        addToast(`主線改成「${personaNameForKey(userProfileBase, key)}」了`, 'success');
    };

    return (
        <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">主線是跟誰</label>
            <select
                value={primary}
                onChange={e => void pick(e.target.value)}
                aria-label="主線是跟誰"
                className="w-full bg-white rounded-2xl px-4 py-2.5 text-sm shadow-sm border border-slate-100"
            >
                {cards.map(c => {
                    const otherLine = c.key !== primary && known.includes(c.key);
                    return (
                        <option key={c.key} value={c.key} disabled={otherLine}>
                            {c.name}{c.key === primary ? '（現在的主線）' : otherLine ? '（已經是另一條線）' : ''}
                        </option>
                    );
                })}
            </select>
            <p className="text-[10px] text-slate-400 mt-1.5 leading-relaxed">
                主線是 {char.name} 原本認識的那個你。換成別張卡：主線的聊天記錄、記憶都留著，只是改認那張卡；原本那張就不再認識（之後要再認識可以在聊天設定「認識的你」勾回來，會是新的一條線）。已經是另一條線的卡不能選。
            </p>
        </div>
    );
};

export const CharRelationsField: React.FC<{ char: CharacterProfile; onChange: ChangeFn }> = ({ char, onChange }) => {
    const { characters, userProfileBase } = useOS();
    const rels: NPCRelationship[] = char.relationships || [];
    const primaryName = personaNameForKey(userProfileBase, char.primaryPersonaKey || REAL_IDENTITY_PERSONA_ID);
    const targets = characters.filter(c => c.id !== char.id && !c.altOf);
    const set = (next: NPCRelationship[]) => onChange('relationships', next);

    return (
        <div>
            <div className="flex items-center justify-between mb-1.5 px-1">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">關係</label>
                <button
                    type="button"
                    onClick={() => set([...rels, { id: genId(), targetId: 'user', description: '' }])}
                    className="text-[10px] bg-violet-50 text-violet-600 px-2.5 py-1 rounded-full font-bold"
                >
                    + 新增關係
                </button>
            </div>
            {rels.length === 0 ? (
                <div className="text-center py-4 bg-white rounded-2xl border border-dashed border-slate-200 text-slate-400 text-xs">
                    還沒有設定關係——可以寫 TA 跟你、跟其他角色各自是什麼關係
                </div>
            ) : (
                <div className="space-y-2">
                    {rels.map(rel => (
                        <div key={rel.id} className="bg-white rounded-2xl border border-slate-100 shadow-sm p-3 space-y-2" data-char-relation>
                            <div className="flex items-center gap-2">
                                <select
                                    value={rel.targetId}
                                    onChange={e => set(rels.map(r => r.id === rel.id ? { ...r, targetId: e.target.value } : r))}
                                    aria-label="關係對象"
                                    className="flex-1 bg-slate-50 border border-slate-200/60 rounded-lg px-2.5 py-1.5 text-xs font-bold"
                                >
                                    <option value="user">你（{primaryName}）</option>
                                    {targets.map(c => <option key={c.id} value={c.id}>{c.name}{c.castRole === 'supporting' ? '（配角）' : ''}</option>)}
                                    {rel.targetId !== 'user' && !targets.some(c => c.id === rel.targetId) && <option value={rel.targetId}>（已刪除的角色）</option>}
                                </select>
                                <button
                                    type="button"
                                    onClick={() => set(rels.filter(r => r.id !== rel.id))}
                                    aria-label="刪掉這段關係"
                                    className="shrink-0 px-2 text-slate-300 hover:text-red-400"
                                >
                                    ×
                                </button>
                            </div>
                            <textarea
                                value={rel.description}
                                onChange={e => set(rels.map(r => r.id === rel.id ? { ...r, description: e.target.value } : r))}
                                placeholder="這段關係的描述，如「妹妹，從小玩到大，愛耍賴」"
                                rows={2}
                                className="w-full bg-slate-50 border border-slate-200/60 rounded-lg px-2.5 py-2 text-xs resize-none"
                            />
                        </div>
                    ))}
                </div>
            )}
            <p className="text-[10px] text-slate-400 mt-1.5 leading-relaxed">
                寫在這裡的會變成 {char.name} 的「你身邊的人」；對方那邊也會知道（例如你寫「哥哥」，對方的提示詞會看到「{char.name}跟你：哥哥」）。「你」指的是主線上的那個你（{primaryName}）。
            </p>
        </div>
    );
};
