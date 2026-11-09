
import React, { useEffect, useState } from 'react';
import { CharacterProfile, CharacterBuff } from '../../types';
import { isScheduleFeatureOn } from '../../utils/scheduleGenerator';
import { useOS } from '../../context/OSContext';
import { buffRemaining, buffStrengthDots, liveBuffs } from '../../utils/emotionDecay';

interface EmotionStatusPanelProps {
    char: CharacterProfile;
    onClearBuffs: () => void;
    /** 見面裡用：不看日程開關，有情緒就顯示 */
    alwaysShow?: boolean;
    /** 改動寫去哪：見面「線下情緒獨立」時寫進故事；沒給就寫角色 */
    onUpdate?: (patch: Partial<Pick<CharacterProfile, 'activeBuffs' | 'buffInjection' | 'buffInjectionAt'>>) => void;
}

const HOUR = 3_600_000;
const agoText = (ms: number) => ms < HOUR ? '剛剛' : ms < 48 * HOUR ? `${Math.round(ms / HOUR)} 小時前` : `${Math.round(ms / (24 * HOUR))} 天前`;

/**
 * 「當前情緒狀態」：私聊設定和見面共用。情緒會褪色（utils/emotionDecay.ts），強度條是此刻還剩多少；
 * 每條可刪、當下情緒總結可改、可整個重置。
 */
const EmotionStatusPanel: React.FC<EmotionStatusPanelProps> = ({ char, onClearBuffs, alwaysShow, onUpdate }) => {
    const { updateCharacter, addToast } = useOS();
    const apply = onUpdate ?? ((patch: Partial<CharacterProfile>) => updateCharacter(char.id, patch));
    // 每分鐘重算一次強度條
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);
    const stored: CharacterBuff[] = char.activeBuffs || [];
    const buffs = liveBuffs(stored, now);
    const faded = stored.length - buffs.length;
    const scheduleOn = isScheduleFeatureOn(char);

    const [summaryDraft, setSummaryDraft] = useState(char.buffInjection || '');
    useEffect(() => { setSummaryDraft(char.buffInjection || ''); }, [char.id, char.buffInjection]);
    const saveSummary = () => {
        const next = summaryDraft.trim();
        if (next === (char.buffInjection || '').trim()) return;
        apply({ buffInjection: next, buffInjectionAt: Date.now() });
        addToast(next ? '當下情緒總結已修改' : '當下情緒總結已清空', 'success');
    };
    const removeBuff = (id: string) => {
        const next = stored.filter(buff => buff.id !== id);
        apply(next.length ? { activeBuffs: next } : { activeBuffs: [], buffInjection: '' });
    };

    if (buffs.length === 0 && !scheduleOn && !alwaysShow && !char.buffInjection) return null;

    return (
        <div data-emotion-panel>
            <div className="flex items-center justify-between mb-2">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1">當前情緒狀態</label>
                {(stored.length > 0 || char.buffInjection) && (
                    <button onClick={() => { if (window.confirm('重置情緒狀態？所有情緒和當下情緒總結都會清掉。')) onClearBuffs(); }} className="text-xs text-slate-400 hover:text-red-400 transition-colors">重置情緒狀態</button>
                )}
            </div>
            {buffs.length > 0 ? (
                <ul className="space-y-2">
                    {buffs.map(buff => {
                        const color = buff.color || '#db2777';
                        return (
                            <li key={buff.id} className="rounded-xl border border-slate-100 bg-white px-3 py-2">
                                <div className="flex items-center gap-2 text-xs">
                                    {buff.emoji && <span>{buff.emoji}</span>}
                                    <span className="font-bold truncate" style={{ color }}>{buff.label}</span>
                                    <span className="text-[10px] tracking-tighter opacity-70" style={{ color }}>{buffStrengthDots(buff, now)}</span>
                                    {buff.since && <span className="text-[10px] text-slate-300 ml-auto shrink-0">{agoText(now - buff.since)}</span>}
                                    <button onClick={() => removeBuff(buff.id)} aria-label={`刪除 ${buff.label}`} className={`${buff.since ? '' : 'ml-auto'} shrink-0 px-1 text-slate-300 hover:text-red-400`}>×</button>
                                </div>
                                <div className="mt-1.5 h-1 rounded-full bg-slate-100 overflow-hidden" title="此刻還剩多少">
                                    <div className="h-full rounded-full" style={{ width: `${Math.round(buffRemaining(buff, now) * 100)}%`, backgroundColor: color }} />
                                </div>
                                {buff.description && <p className="mt-1 text-[11px] text-slate-400 leading-relaxed">{buff.description}</p>}
                            </li>
                        );
                    })}
                </ul>
            ) : (
                <div className="text-xs text-slate-400 text-center py-2">
                    {stored.length ? '情緒都淡掉了，現在很平靜' : '暫無情緒狀態 — 發幾條消息後會自動生成'}
                </div>
            )}
            {faded > 0 && buffs.length > 0 && <p className="text-[10px] text-slate-300 mt-1.5">另有 {faded} 條已經淡掉，下次情緒評估時清掉。</p>}
            <p className="text-[10px] text-slate-300 mt-1.5 leading-relaxed">情緒會隨時間褪色：淺的幾小時、中等的一天、深的三四天。最多記 12 條，提示詞只帶最強的 6 條。</p>

            {(char.buffInjection || stored.length > 0) && (
                <div className="mt-3">
                    <label className="text-[10px] font-bold text-slate-400 pl-1">當下情緒總結</label>
                    <textarea value={summaryDraft} onChange={e => setSummaryDraft(e.target.value)} onBlur={saveSummary} rows={4}
                        className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600 leading-relaxed focus:outline-none focus:ring-1 focus:ring-primary/30 resize-y" />
                    <p className="text-[10px] text-slate-300 mt-0.5">情緒評估寫的，會帶進提示詞；可以直接改，點別處就保存。下一次評估有變化時會重寫。</p>
                </div>
            )}
        </div>
    );
};

export default React.memo(EmotionStatusPanel);
