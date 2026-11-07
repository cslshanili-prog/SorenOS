import React from 'react';
import type { CharacterGroup, CharacterProfile, LibraryAccess } from '../../types';
import TokenImg from '../os/TokenImg';

const MODES: { mode: LibraryAccess['mode']; label: string }[] = [
    { mode: 'all', label: '所有角色共用' },
    { mode: 'worlds', label: '照世界' },
    { mode: 'chars', label: '指定角色' },
];

/** 資料庫：這張圖給誰用（上傳和單張詳情共用） */
const LibraryAccessPicker: React.FC<{
    value: LibraryAccess;
    onChange: (next: LibraryAccess) => void;
    characters: CharacterProfile[];
    worlds: CharacterGroup[];
}> = ({ value, onChange, characters, worlds }) => {
    const switchMode = (mode: LibraryAccess['mode']) => {
        if (mode === value.mode) return;
        if (mode === 'all') onChange({ mode: 'all' });
        else if (mode === 'worlds') onChange({ mode: 'worlds', worldIds: [] });
        else onChange({ mode: 'chars', charIds: [] });
    };
    const toggle = (id: string) => {
        if (value.mode === 'worlds') {
            const has = value.worldIds.includes(id);
            onChange({ mode: 'worlds', worldIds: has ? value.worldIds.filter(x => x !== id) : [...value.worldIds, id] });
        } else if (value.mode === 'chars') {
            const has = value.charIds.includes(id);
            onChange({ mode: 'chars', charIds: has ? value.charIds.filter(x => x !== id) : [...value.charIds, id] });
        }
    };

    return (
        <div className="space-y-2.5">
            <div role="radiogroup" aria-label="誰能用" className="grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1">
                {MODES.map(({ mode, label }) => (
                    <button key={mode} type="button" role="radio" aria-checked={value.mode === mode} onClick={() => switchMode(mode)}
                        className={`rounded-lg py-1.5 text-[12px] font-bold transition ${value.mode === mode ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-400'}`}>
                        {label}
                    </button>
                ))}
            </div>
            {value.mode === 'all' && <p className="text-[11px] leading-relaxed text-slate-400">每個角色都能用，之後新加的角色也算。</p>}
            {value.mode === 'worlds' && (
                worlds.length === 0
                    ? <p className="text-[11px] leading-relaxed text-slate-400">神經鏈接裡還沒有分組。分組就是世界，先去那邊建一個。</p>
                    : (
                        <div className="flex flex-wrap gap-1.5">
                            {worlds.map(world => {
                                const on = value.worldIds.includes(world.id);
                                const count = characters.filter(c => c.groupId === world.id).length;
                                return (
                                    <button key={world.id} type="button" role="checkbox" aria-checked={on} onClick={() => toggle(world.id)}
                                        className={`rounded-full border px-3 py-1 text-[12px] font-bold transition ${on ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-200 bg-white text-slate-500'}`}>
                                        {world.name}<span className="ml-1 font-mono text-[10px] opacity-60">{count}</span>
                                    </button>
                                );
                            })}
                        </div>
                    )
            )}
            {value.mode === 'chars' && (
                characters.length === 0
                    ? <p className="text-[11px] text-slate-400">還沒有角色。</p>
                    : (
                        <div className="grid grid-cols-4 gap-2">
                            {characters.map(char => {
                                const on = value.charIds.includes(char.id);
                                return (
                                    <button key={char.id} type="button" role="checkbox" aria-checked={on} aria-label={char.name} onClick={() => toggle(char.id)}
                                        className="flex min-w-0 flex-col items-center gap-1">
                                        <span className={`relative block h-11 w-11 overflow-hidden rounded-full bg-slate-200 ring-2 transition ${on ? 'ring-slate-800' : 'ring-transparent opacity-50'}`}>
                                            <span className="absolute inset-0 flex items-center justify-center text-sm font-bold text-slate-400">{char.name.charAt(0)}</span>
                                            {char.avatar && <TokenImg value={char.avatar} alt="" className="relative h-full w-full object-cover" onError={event => { event.currentTarget.style.display = 'none'; }} />}
                                            {on && <span className="absolute inset-0 flex items-center justify-center bg-slate-900/30 text-sm font-bold text-white">✓</span>}
                                        </span>
                                        <span className={`w-full truncate text-center text-[10px] ${on ? 'font-bold text-slate-700' : 'text-slate-400'}`}>{char.name}</span>
                                    </button>
                                );
                            })}
                        </div>
                    )
            )}
        </div>
    );
};

export default LibraryAccessPicker;
