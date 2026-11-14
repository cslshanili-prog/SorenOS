import React, { useEffect, useState } from 'react';
import type { GroupProfile, UserProfile } from '../../types';
import type { MeetingPresetRecord } from '../../utils/meetingPreset/types';
import { DB } from '../../utils/db';
import { BUILTIN_PRESET, scenesOfPreset } from '../../utils/presetBinding';

/**
 * 群設定的「預設」一欄（plans/preset-library.md 第 3b 批）：跟著預設 App 的群聊場景預設／內建／某一份。
 * 選了就存（群設定其它開關也是點了就存）。
 */
const GroupPresetSelect: React.FC<{
    group: GroupProfile;
    profileBase: Pick<UserProfile, 'presetSceneDefaults'>;
    onChange: (presetId: string | undefined) => void;
}> = ({ group, profileBase, onChange }) => {
    const [presets, setPresets] = useState<MeetingPresetRecord[]>([]);
    useEffect(() => {
        let alive = true;
        DB.getMeetingPresets().then(list => { if (alive) setPresets(list); }).catch(() => { if (alive) setPresets([]); });
        return () => { alive = false; };
    }, []);
    const usable = presets.filter(p => scenesOfPreset(p).includes('group') || p.id === group.presetId);
    const sceneId = profileBase.presetSceneDefaults?.group;
    const sceneName = !sceneId || sceneId === BUILTIN_PRESET ? '內建' : (presets.find(p => p.id === sceneId)?.name || '內建');
    return (
        <div className="pt-2 border-t border-slate-100">
            <div className="flex items-center justify-between gap-3 mb-1">
                <div className="flex-1 min-w-0">
                    <div className="text-xs font-bold text-slate-700">預設</div>
                    <p className="text-[9px] text-slate-500 mt-0.5 leading-tight">
                        這個群照哪份預設說話。文風照預設的，成員檔案、群聊記錄照補，輸出格式固定在最後（導演模式一定是 JSON）。長篇的 ST 預設不太適合群聊。
                        {!group.presetId && `（跟著預設 App：目前是「${sceneName}」）`}
                    </p>
                </div>
                <select aria-label="群聊預設" value={group.presetId || ''} onChange={e => onChange(e.target.value || undefined)}
                    className="max-w-[45%] min-w-0 truncate rounded-xl border border-slate-200 bg-slate-50 px-2 py-1.5 text-[12px] text-slate-700">
                    <option value="">跟著預設 App</option>
                    <option value={BUILTIN_PRESET}>內建</option>
                    {usable.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
            </div>
        </div>
    );
};

export default GroupPresetSelect;
