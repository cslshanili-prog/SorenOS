import React, { useEffect, useState } from 'react';
import type { DateStoryTime, WorldTimeline } from '../../types';
import { nowInTimeZone } from '../../utils/timezone';
import { calendarWallNow, formatEpochYear } from '../../utils/worldCalendar';

/**
 * 「時間模式」那幾格（plans/time-system.md 第 2b 節）：來源 真實／自定義（見面多一檔 關閉）× 流動／靜止 × 起始時間。
 * 見面設定（components/date/DateStoryTimeSettings.tsx）和聊天設定（components/chat/ChatTimeSettings.tsx）共用，
 * 存去哪、起算點怎麼算各自管；這裡只畫欄位、回報改動。
 */

const pad = (n: number) => String(n).padStart(2, '0');
/** 角色那邊此刻的牆上時間，給自定義欄位當起點 */
export const charWallNow = (tz?: string): string => {
    const d = nowInTimeZone(tz, new Date());
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const DEFAULT_TIME_MODE: DateStoryTime = { source: 'real', flow: 'flowing' };

export const Segment = <T extends string>({ value, options, onPick, label }: {
    value: T; options: readonly (readonly [T, string])[]; onPick: (v: T) => void; label: string;
}) => (
    <div role="radiogroup" aria-label={label} className="flex rounded-full bg-slate-100 p-1 text-xs w-fit">
        {options.map(([v, text]) => (
            <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onPick(v)}
                className={`rounded-full px-3 py-1 transition ${value === v ? 'bg-white text-primary font-bold shadow-sm' : 'text-slate-400'}`}>{text}</button>
        ))}
    </div>
);

const TimeModeFields: React.FC<{
    value: DateStoryTime;
    onChange: (next: DateStoryTime) => void;
    /** 角色的時區：自定義的起點照它填 */
    tz?: string;
    /** 給不給「關閉」（見面才有；私聊要角色沒時間概念是角色卡的「時間感知」） */
    allowOff?: boolean;
    /** 自定義欄位失焦存檔時叫一聲（見面那邊要跳 toast） */
    onCustomCommitted?: () => void;
    /** 所在世界的架空曆法（utils/worldCalendar.ts）：自定義的時間照它填、起點也照它 */
    timeline?: WorldTimeline;
}> = ({ value, onChange, tz, allowOff, onCustomCommitted, timeline }) => {
    const [customDraft, setCustomDraft] = useState(value.customStart || '');
    useEffect(() => { setCustomDraft(value.customStart || ''); }, [value.customStart]);
    const off = value.source === 'off';

    const setSource = (source: DateStoryTime['source']) => {
        if (source === value.source) return;
        onChange({ ...value, source, customStart: source === 'custom' ? (value.customStart || (timeline ? calendarWallNow(tz, timeline) : charWallNow(tz))) : value.customStart });
    };
    const commitCustom = () => {
        if (!customDraft || customDraft === value.customStart) return;
        onChange({ ...value, customStart: customDraft });
        onCustomCommitted?.();
    };
    const sourceOptions = allowOff
        ? ([['real', '真實'], ['custom', '自定義'], ['off', '關閉']] as const)
        : ([['real', '真實'], ['custom', '自定義']] as const);

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] text-slate-500 font-bold">時間來源</span>
                <Segment value={value.source} options={sourceOptions} onPick={setSource} label="時間來源" />
            </div>
            {off && <p className="text-[10px] text-slate-400 leading-relaxed">關閉：提示詞不帶時間，記錄也不標時間戳，劇情脫離現實時間線（純架空）。</p>}
            {value.source === 'custom' && (
                <>
                    <input type="datetime-local" value={customDraft} onChange={e => setCustomDraft(e.target.value)} onBlur={commitCustom} aria-label="自定義的時間"
                        className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-1 focus:ring-primary/30" />
                    {timeline && <p className="text-[10px] text-slate-400 leading-relaxed">照這個世界的曆法填（此刻是 {calendarWallNow(tz, timeline).replace('T', ' ')}，年份寫成「{formatEpochYear(timeline, Number(calendarWallNow(tz, timeline).slice(0, 4)))}」）。</p>}
                </>
            )}
            {!off && (
                <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] text-slate-500 font-bold">時間</span>
                    <Segment value={value.flow} options={[['flowing', '流動'], ['frozen', '靜止']] as const} onPick={flow => { if (flow !== value.flow) onChange({ ...value, flow }); }} label="時間流動" />
                </div>
            )}
        </div>
    );
};

export default TimeModeFields;
