/**
 * 世界底下的分組（plans/chat-switcher.md）：在「世界管理」裡加、改名、刪。
 * 刪掉的分組，裡面的角色回到沒分組（OSContext.setCharacterGroupSections 會清）。
 */
import React, { useState } from 'react';
import type { CharacterGroup } from '../../types';
import { useOS } from '../../context/OSContext';
import { newSectionId } from '../../utils/worldSections';

export const WorldSectionsEditor: React.FC<{ world: CharacterGroup }> = ({ world }) => {
    const { setCharacterGroupSections, characters, addToast } = useOS();
    const [draft, setDraft] = useState('');
    const sections = world.sections || [];
    const countOf = (id: string) => characters.filter(c => c.groupId === world.id && c.worldSectionId === id).length;

    const add = () => {
        const name = draft.trim();
        if (!name) return;
        if (sections.some(s => s.name === name)) { addToast(`「${name}」已經有了`, 'info'); return; }
        void setCharacterGroupSections(world.id, [...sections, { id: newSectionId(), name }]);
        setDraft('');
    };

    return (
        <div className="space-y-1.5" data-world-sections={world.name}>
            <span className="text-[11px] font-bold text-slate-400">分組</span>
            {sections.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                    {sections.map(s => (
                        <span key={s.id} className="flex items-center gap-1 rounded-full bg-slate-50 border border-slate-200/70 pl-3 pr-1 py-1">
                            <input
                                defaultValue={s.name}
                                aria-label={`分組「${s.name}」的名字`}
                                onBlur={e => {
                                    const v = e.target.value.trim();
                                    if (v && v !== s.name) void setCharacterGroupSections(world.id, sections.map(x => x.id === s.id ? { ...x, name: v } : x));
                                    else e.target.value = s.name;
                                }}
                                onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                                size={Math.max(2, s.name.length + 1)}
                                className="bg-transparent text-[13px] text-slate-700 outline-none"
                            />
                            <span className="text-[11px] text-slate-400 tabular-nums">{countOf(s.id)}</span>
                            <button
                                type="button"
                                aria-label={`刪掉分組「${s.name}」`}
                                onClick={() => {
                                    void setCharacterGroupSections(world.id, sections.filter(x => x.id !== s.id));
                                    addToast(`分組「${s.name}」刪掉了，裡面的角色回到沒分組`, 'info');
                                }}
                                className="px-1 text-slate-300 hover:text-red-400"
                            >
                                ×
                            </button>
                        </span>
                    ))}
                </div>
            )}
            <div className="flex gap-1.5">
                <input
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') add(); }}
                    placeholder="新分組，例如「林家」"
                    aria-label={`${world.name}的新分組`}
                    className="flex-1 min-w-0 bg-slate-50 border border-slate-200/60 rounded-xl px-2.5 py-1.5 text-[12px] text-slate-600 outline-none"
                />
                <button type="button" onClick={add} className="shrink-0 rounded-xl bg-violet-50 px-3 py-1.5 text-[12px] font-bold text-violet-600">加</button>
            </div>
        </div>
    );
};

export default WorldSectionsEditor;
