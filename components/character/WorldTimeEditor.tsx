import React, { useEffect, useState } from 'react';
import type { CharacterGroup, WorldTimeline } from '../../types';
import { COMMON_TIMEZONES } from '../../utils/timezone';
import { DEFAULT_EPOCH_LABEL, formatCalendarText, worldCalendar } from '../../utils/worldCalendar';

/**
 * 世界的曆法與時區（plans/time-system.md 第 2a、2c 節），放在神經鏈接的世界管理頁每個世界卡片裡。
 * - 現實曆法：選這個世界活在哪個時區（覆蓋成員各自的自定義時區）；沒設＝各看各的
 * - 架空曆法：年份寫法（{年} 換成數字）＋對應點（現實的某天＝時間線裡的某天）＋要不要寫星期；時區不看
 * 存在 CharacterGroup.timezone / CharacterGroup.timeline（utils/worldCalendar.ts 讀）。
 */
const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const WorldTimeEditor: React.FC<{
    world: CharacterGroup;
    onChange: (patch: Partial<Pick<CharacterGroup, 'timezone' | 'timeline'>>) => void;
}> = ({ world, onChange }) => {
    const fictional = !!world.timeline;
    const tl: WorldTimeline = world.timeline || { epochLabel: DEFAULT_EPOCH_LABEL, anchorReal: today(), anchorWorld: '' };
    const [epoch, setEpoch] = useState(tl.epochLabel);
    const [anchorReal, setAnchorReal] = useState(tl.anchorReal);
    const [anchorWorld, setAnchorWorld] = useState(tl.anchorWorld);
    useEffect(() => { setEpoch(tl.epochLabel); setAnchorReal(tl.anchorReal); setAnchorWorld(tl.anchorWorld); }, [world.id, world.timeline?.epochLabel, world.timeline?.anchorReal, world.timeline?.anchorWorld]);

    const commit = (patch: Partial<WorldTimeline>) => onChange({ timeline: { ...tl, epochLabel: epoch, anchorReal, anchorWorld, ...patch } });
    const live = worldCalendar({ timeline: { ...tl, epochLabel: epoch, anchorReal, anchorWorld } });
    const preview = live ? formatCalendarText(Date.now(), undefined, live, { time: true }) : '';

    return (
        <div className="space-y-2" data-world-time>
            <div className="flex items-center gap-2">
                <span className="text-[11px] font-bold text-slate-400 shrink-0 w-8">曆法</span>
                <div role="radiogroup" aria-label={`${world.name}的曆法`} className="flex rounded-full bg-slate-100 p-1 text-[12px]">
                    {([['real', '現實'], ['fictional', '架空']] as const).map(([v, text]) => (
                        <button key={v} type="button" role="radio" aria-checked={fictional === (v === 'fictional')}
                            onClick={() => {
                                if (v === 'real' && fictional) onChange({ timeline: undefined });
                                if (v === 'fictional' && !fictional) onChange({ timeline: { epochLabel: DEFAULT_EPOCH_LABEL, anchorReal: today(), anchorWorld: '' } });
                            }}
                            className={`rounded-full px-3 py-1 transition ${fictional === (v === 'fictional') ? 'bg-white text-primary font-bold shadow-sm' : 'text-slate-400'}`}>{text}</button>
                    ))}
                </div>
            </div>
            {!fictional ? (
                <div className="flex items-center gap-2">
                    <span className="text-[11px] font-bold text-slate-400 shrink-0 w-8">時區</span>
                    <select aria-label={`${world.name}的時區`} value={world.timezone || ''} onChange={e => onChange({ timezone: e.target.value || undefined })}
                        className="flex-1 min-w-0 bg-slate-50 border border-slate-200/60 rounded-xl px-2.5 py-1.5 text-[12px] text-slate-600">
                        <option value="">各看各的（角色自己的設定）</option>
                        {COMMON_TIMEZONES.map(tz => <option key={tz.id} value={tz.id}>{tz.label}</option>)}
                    </select>
                </div>
            ) : (
                <div className="rounded-2xl bg-slate-50 border border-slate-100 p-3 space-y-2">
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 block mb-1">年份怎麼寫（{'{年}'} 換成數字）</label>
                        <input value={epoch} onChange={e => setEpoch(e.target.value)} onBlur={() => commit({ epochLabel: epoch.trim() || DEFAULT_EPOCH_LABEL })} aria-label="年份寫法"
                            placeholder={DEFAULT_EPOCH_LABEL} className="w-full bg-white border border-slate-200/60 rounded-xl px-2.5 py-1.5 text-[12px] text-slate-700 outline-none" />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 block mb-1">現實的這一天</label>
                            <input type="date" value={anchorReal} onChange={e => setAnchorReal(e.target.value)} onBlur={() => commit({ anchorReal })} aria-label="現實的這一天"
                                className="w-full bg-white border border-slate-200/60 rounded-xl px-2.5 py-1.5 text-[12px] text-slate-700 outline-none" />
                        </div>
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 block mb-1">是時間線裡的</label>
                            <input type="date" value={anchorWorld} onChange={e => setAnchorWorld(e.target.value)} onBlur={() => commit({ anchorWorld })} aria-label="時間線裡的這一天"
                                className="w-full bg-white border border-slate-200/60 rounded-xl px-2.5 py-1.5 text-[12px] text-slate-700 outline-none" />
                        </div>
                    </div>
                    <label className="flex items-center justify-between gap-3 text-[11px] text-slate-500">
                        <span>日期後面寫星期</span>
                        <button type="button" role="switch" aria-checked={!!tl.showWeekday} onClick={() => commit({ showWeekday: !tl.showWeekday })}
                            className={`w-10 h-6 rounded-full transition-colors relative shrink-0 ${tl.showWeekday ? 'bg-primary' : 'bg-slate-200'}`}>
                            <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow-md transition-transform ${tl.showWeekday ? 'translate-x-[18px]' : 'translate-x-0.5'}`}></div>
                        </button>
                    </label>
                    <p className="text-[10px] text-slate-400 leading-relaxed">
                        {live ? `現在是 ${preview}。` : '填好對應點才生效：現實的某一天等於時間線裡的某一天，之後照公曆往下算，只換年份寫法。'}
                        這個世界的人日期一律照這套寫，不看時區、沒有節假日。
                    </p>
                </div>
            )}
        </div>
    );
};

export default WorldTimeEditor;
