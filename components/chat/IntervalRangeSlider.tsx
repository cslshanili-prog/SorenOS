import React from 'react';
import { PROACTIVE_INTERVAL_STOPS } from '../../utils/proactiveTiming';

/**
 * 主動消息「發送間隔」的雙頭拉桿（2026-10-10，取代上游那兩排固定格子）。
 * 左頭最短、右頭最長，疊在一起就是固定間隔。數值是 PROACTIVE_INTERVAL_STOPS 的序號，
 * 刻度前密後疏，見 utils/proactiveTiming.ts。
 *
 * 兩個原生 range 疊在同一條軌道上：軌道本身不吃點擊（pointer-events: none），只有圓頭吃，
 * 鍵盤、讀屏都照原生的走。兩頭疊在一起時，把「拉得動的那一頭」放上面。
 */

const THUMB = 26;
/** 拉桿可點區域的高度（px）；webkit 的圓頭要手動垂直置中 */
const TRACK_H = 36;
const LAST = PROACTIVE_INTERVAL_STOPS.length - 1;
const TICKS: Array<{ minutes: number; label: string }> = [
    { minutes: 15, label: '15分' },
    { minutes: 60, label: '1時' },
    { minutes: 180, label: '3時' },
    { minutes: 480, label: '8時' },
    { minutes: 1440, label: '24時' },
];

const pct = (idx: number) => (idx / LAST) * 100;
/** 原生 range 的圓頭中心從 THUMB/2 走到 100% - THUMB/2，軌道和刻度要對齊它。 */
const at = (idx: number) => `calc(${THUMB / 2}px + ${pct(idx) / 100} * (100% - ${THUMB}px))`;

const STYLE = `
.soren-interval-range input[type=range]{-webkit-appearance:none;appearance:none;position:absolute;inset:0;width:100%;height:100%;margin:0;background:transparent;pointer-events:none;outline:none}
.soren-interval-range input[type=range]::-webkit-slider-runnable-track{background:transparent;height:100%}
.soren-interval-range input[type=range]::-moz-range-track{background:transparent}
.soren-interval-range input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;pointer-events:auto;width:${THUMB}px;height:${THUMB}px;margin-top:${(TRACK_H - THUMB) / 2}px;border-radius:9999px;background:#fff;border:3px solid #8b5cf6;box-shadow:0 2px 8px rgba(91,33,182,.25);cursor:grab}
.soren-interval-range input[type=range]::-moz-range-thumb{pointer-events:auto;width:${THUMB - 6}px;height:${THUMB - 6}px;border-radius:9999px;background:#fff;border:3px solid #8b5cf6;box-shadow:0 2px 8px rgba(91,33,182,.25);cursor:grab}
.soren-interval-range input[type=range]:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 4px rgba(139,92,246,.3)}
`;

const IntervalRangeSlider: React.FC<{
    minIdx: number;
    maxIdx: number;
    onChange: (minIdx: number, maxIdx: number) => void;
}> = ({ minIdx, maxIdx, onChange }) => {
    // 兩頭疊在一起：靠右時讓左頭在上面（只能往左拉），靠左時讓右頭在上面（只能往右拉）
    const minOnTop = minIdx === maxIdx ? minIdx > LAST / 2 : false;
    return (
        <div className="soren-interval-range select-none">
            <style>{STYLE}</style>
            <div className="relative" style={{ height: TRACK_H }}>
                <div className="absolute top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-slate-200" style={{ left: THUMB / 2, right: THUMB / 2 }} />
                <div
                    className="absolute top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-violet-500"
                    style={{ left: at(minIdx), width: `calc(${(pct(maxIdx) - pct(minIdx)) / 100} * (100% - ${THUMB}px))` }}
                />
                <input
                    type="range" min={0} max={LAST} step={1} value={minIdx}
                    aria-label="最短間隔"
                    onChange={e => onChange(Math.min(Number(e.target.value), maxIdx), maxIdx)}
                    style={{ zIndex: minOnTop ? 3 : 2 }}
                />
                <input
                    type="range" min={0} max={LAST} step={1} value={maxIdx}
                    aria-label="最長間隔"
                    onChange={e => onChange(minIdx, Math.max(Number(e.target.value), minIdx))}
                    style={{ zIndex: minOnTop ? 2 : 3 }}
                />
            </div>
            <div className="relative h-4 mt-1">
                {TICKS.map(t => {
                    const idx = PROACTIVE_INTERVAL_STOPS.indexOf(t.minutes);
                    return (
                        <span key={t.minutes} className="absolute -translate-x-1/2 whitespace-nowrap text-[10px] text-slate-400" style={{ left: at(idx) }}>
                            {t.label}
                        </span>
                    );
                })}
            </div>
        </div>
    );
};

export default React.memo(IntervalRangeSlider);
