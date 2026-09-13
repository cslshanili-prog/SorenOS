
import React from 'react';
import { CharacterProfile, CharacterBuff } from '../../types';
import { isScheduleFeatureOn } from '../../utils/scheduleGenerator';

interface EmotionStatusPanelProps {
    char: CharacterProfile;
    onClearBuffs: () => void;
}

const normalizeIntensity = (n: number | undefined | null): 1 | 2 | 3 => {
    const parsed = Number.isFinite(n) ? Math.round(Number(n)) : 2;
    if (parsed <= 1) return 1;
    if (parsed >= 3) return 3;
    return 2;
};

const INTENSITY_DOTS = (n: number | undefined | null) => {
    const safe = normalizeIntensity(n);
    return '●'.repeat(safe) + '○'.repeat(3 - safe);
};

/** 「当前情绪状态」独立展示——从 EmotionSettingsPanel 拆出来，不跟着它的收合区块一起被藏起来。 */
const EmotionStatusPanel: React.FC<EmotionStatusPanelProps> = ({ char, onClearBuffs }) => {
    const buffs: CharacterBuff[] = char.activeBuffs || [];
    const scheduleOn = isScheduleFeatureOn(char);

    if (buffs.length === 0 && !scheduleOn) return null;

    return (
        <div>
            <div className="flex items-center justify-between mb-2">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1">當前情緒狀態</label>
                {buffs.length > 0 && (
                    <button onClick={onClearBuffs} className="text-xs text-slate-400 hover:text-red-400 transition-colors">清除</button>
                )}
            </div>
            {buffs.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                    {buffs.map(buff => (
                        <div
                            key={buff.id}
                            className="flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-bold"
                            style={{
                                backgroundColor: buff.color ? buff.color + '22' : '#fdf2f8',
                                color: buff.color || '#db2777',
                                border: `1px solid ${buff.color ? buff.color + '55' : '#fbcfe8'}`
                            }}
                        >
                            {buff.emoji && <span>{buff.emoji}</span>}
                            <span>{buff.label}</span>
                            <span className="opacity-60">{INTENSITY_DOTS(buff.intensity)}</span>
                        </div>
                    ))}
                </div>
            ) : (
                <div className="text-xs text-slate-400 text-center py-2">
                    暫無情緒狀態 — 發幾條消息後會自動生成
                </div>
            )}
        </div>
    );
};

export default React.memo(EmotionStatusPanel);
