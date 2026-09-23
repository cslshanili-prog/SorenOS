import React from 'react';
import { CharacterProfile, CharacterGroup } from '../../types';

/**
 * 角色分組的公共工具 + 選角入口的分組篩選膠囊條。
 *
 * 背景：角色一多，「神經鏈接 / 打電話 / 見面 / 查手機 / 轉發」這些選角列表就會太長。
 * 各入口的列表 UI 千差萬別（豎列 / grid / 橫滑分頁），所以這裡不做統一的"角色選擇器"，
 * 而是提供最小公共件：一條按分組篩選的膠囊條 + 純函數篩選邏輯，各入口把篩選結果
 * 餵給自己原有的列表/分頁渲染即可。沒建過分組的用戶，膠囊條整體不渲染，各入口零變化。
 */

/** 「全部」虛擬分組 id */
export const GROUP_FILTER_ALL = 'all';
/** 「未分組」虛擬分組 id（groupId 為空、或指向已刪分組的角色都算） */
export const GROUP_FILTER_UNGROUPED = '__ungrouped__';

/** 分組顯示順序：order 優先，缺省按創建時間先後 */
export const sortCharacterGroups = (groups: CharacterGroup[]): CharacterGroup[] =>
    [...groups].sort((a, b) => (a.order ?? a.createdAt ?? 0) - (b.order ?? b.createdAt ?? 0));

/** 按分組篩選角色。groupId 傳 GROUP_FILTER_ALL / GROUP_FILTER_UNGROUPED / 具體分組 id */
export const filterCharactersByGroup = (
    characters: CharacterProfile[],
    groups: CharacterGroup[],
    groupId: string,
): CharacterProfile[] => {
    if (groupId === GROUP_FILTER_ALL) return characters;
    if (groupId === GROUP_FILTER_UNGROUPED) {
        const known = new Set(groups.map(g => g.id));
        return characters.filter(c => !c.groupId || !known.has(c.groupId));
    }
    return characters.filter(c => c.groupId === groupId);
};

interface FilterBarProps {
    /** 該入口的完整候選列表（未篩選），用於計算各組數量與是否顯示「未分組」 */
    characters: CharacterProfile[];
    groups: CharacterGroup[];
    value: string;
    onChange: (groupId: string) => void;
    /** 深色底的 App（打電話 / 見面 / 查手機）傳 true，膠囊換白字配色 */
    dark?: boolean;
    className?: string;
}

/**
 * 分組篩選膠囊條：全部 / 各分組 / 未分組，橫向可滾動。
 * groups 為空時返回 null——沒用分組的用戶看不到任何變化。
 */
export const CharacterGroupFilterBar: React.FC<FilterBarProps> = ({ characters, groups, value, onChange, dark, className }) => {
    if (groups.length === 0) return null;

    const known = new Set(groups.map(g => g.id));
    const ungroupedCount = characters.filter(c => !c.groupId || !known.has(c.groupId)).length;
    const chips: { id: string; label: string; count: number }[] = [
        { id: GROUP_FILTER_ALL, label: '全部', count: characters.length },
        ...sortCharacterGroups(groups).map(g => ({
            id: g.id,
            label: g.name,
            count: characters.filter(c => c.groupId === g.id).length,
        })),
    ];
    if (ungroupedCount > 0) chips.push({ id: GROUP_FILTER_UNGROUPED, label: '未分組', count: ungroupedCount });

    const base = 'shrink-0 px-3 py-1.5 rounded-full text-xs font-medium border transition-all active:scale-95 flex items-center gap-1';
    const idle = dark
        ? 'bg-white/[0.06] text-white/60 border-white/15'
        : 'bg-white/70 text-slate-500 border-slate-200';
    const active = dark
        ? 'bg-white/90 text-slate-900 border-white'
        : 'bg-slate-700 text-white border-slate-700';

    return (
        <div className={`flex gap-1.5 overflow-x-auto no-scrollbar ${className || ''}`}>
            {chips.map(chip => (
                <button
                    key={chip.id}
                    onClick={() => onChange(chip.id)}
                    className={`${base} ${value === chip.id ? active : idle}`}
                >
                    <span>{chip.label}</span>
                    <span className={value === chip.id ? 'opacity-70' : 'opacity-50'}>{chip.count}</span>
                </button>
            ))}
        </div>
    );
};
