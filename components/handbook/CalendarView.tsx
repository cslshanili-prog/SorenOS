/**
 * 月曆視圖(通用基類)
 *
 * 所有 Tracker section 都用這個組件:
 * - 7×6 月曆格子,週一/週日開頭按 region 配置(這裡按週日起,符合中文習慣)
 * - 頂部:大號月份名 + 上下月切換 + 今日跳回
 * - 每格:日號 + 由 caller 提供的 renderCell 函數(畫 entry 標記/emoji/色塊等)
 * - 點擊格子 → 調 onCellTap(date) ,由 caller 決定是 sheet 還是別的
 * - 支持 highlightDate(用作"今日"圓圈)
 */

import React from 'react';
import { PAPER_TONES, CUTE_STACK, DISPLAY_STACK, MONO_STACK } from './paper';
import { CaretLeft, CaretRight, ArrowCounterClockwise } from '@phosphor-icons/react';

const WEEK_LABELS = ['日', '一', '二', '三', '四', '五', '六'];
const MONTH_LABELS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function pad2(n: number): string { return String(n).padStart(2, '0'); }
function dateKey(y: number, m: number, d: number): string {
    return `${y}-${pad2(m + 1)}-${pad2(d)}`;
}
function daysInMonth(y: number, m: number): number {
    return new Date(y, m + 1, 0).getDate();
}

interface CalendarViewProps {
    /** 默認顯示的月份（YYYY-MM 任意日的 date 字符串） */
    initialDate?: string;
    /** 高亮的日期(通常 = 今天) */
    highlightDate?: string;
    /** 渲染單元格內容(日號下方);返回 null 不畫 */
    renderCell?: (date: string) => React.ReactNode;
    /** 點擊格子觸發 */
    onCellTap?: (date: string) => void;
    /** 主題色（標記/裝飾用），默認櫻粉 */
    accentColor?: string;
    /** 頂部標題(默認顯示英文月份),可以傳 tracker 名定製 */
    title?: React.ReactNode;
}

const CalendarView: React.FC<CalendarViewProps> = ({
    initialDate, highlightDate,
    renderCell, onCellTap,
    accentColor = PAPER_TONES.accentRose,
    title,
}) => {
    // 狀態:當前顯示的"基準日期"(用於決定哪個月)
    const init = (() => {
        if (initialDate) {
            const [y, m, d] = initialDate.split('-').map(Number);
            return new Date(y, m - 1, d);
        }
        return new Date();
    })();
    const [cursor, setCursor] = React.useState<Date>(init);
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const firstDay = new Date(year, month, 1).getDay();    // 0~6
    const totalDays = daysInMonth(year, month);

    const today = (() => {
        const d = new Date();
        return dateKey(d.getFullYear(), d.getMonth(), d.getDate());
    })();

    // 6 行 × 7 列 = 42 個格子
    const cells: ({ date: string; day: number; thisMonth: boolean })[] = [];
    // 上月尾巴
    if (firstDay > 0) {
        const prevTotal = daysInMonth(year, month - 1);
        for (let i = firstDay - 1; i >= 0; i--) {
            const d = prevTotal - i;
            const [py, pm] = month === 0 ? [year - 1, 11] : [year, month - 1];
            cells.push({ date: dateKey(py, pm, d), day: d, thisMonth: false });
        }
    }
    // 本月
    for (let d = 1; d <= totalDays; d++) {
        cells.push({ date: dateKey(year, month, d), day: d, thisMonth: true });
    }
    // 下月頭
    while (cells.length < 42) {
        const offset = cells.length - firstDay - totalDays + 1;
        const [ny, nm] = month === 11 ? [year + 1, 0] : [year, month + 1];
        cells.push({ date: dateKey(ny, nm, offset), day: offset, thisMonth: false });
    }

    const goPrevMonth = () => {
        setCursor(new Date(year, month - 1, 1));
    };
    const goNextMonth = () => {
        setCursor(new Date(year, month + 1, 1));
    };
    const goToday = () => {
        const t = new Date();
        setCursor(new Date(t.getFullYear(), t.getMonth(), 1));
    };

    return (
        <div className="px-4 pt-2 pb-4">
            {/* 月份標題條 */}
            <div className="flex items-center justify-between mb-3">
                <button
                    onClick={goPrevMonth}
                    className="w-8 h-8 flex items-center justify-center rounded-full active:scale-95 transition"
                    style={{ background: 'rgba(253,246,231,0.7)', color: PAPER_TONES.ink }}
                    aria-label="上一月"
                >
                    <CaretLeft className="w-3.5 h-3.5" weight="bold" />
                </button>
                <div className="text-center">
                    <div
                        style={{
                            ...MONO_STACK,
                            fontSize: 10,
                            letterSpacing: '0.4em',
                            color: PAPER_TONES.inkSoft,
                        }}
                    >
                        {MONTH_LABELS[month].toUpperCase()}
                    </div>
                    <div
                        style={{
                            ...DISPLAY_STACK,
                            fontSize: 28,
                            lineHeight: 1,
                            color: PAPER_TONES.ink,
                            marginTop: 2,
                            letterSpacing: '-0.01em',
                        }}
                    >
                        {year}<span className="mx-1" style={{ color: accentColor }}>·</span>{pad2(month + 1)}
                    </div>
                    {title && (
                        <div className="text-[11px] mt-1" style={{ ...CUTE_STACK, color: PAPER_TONES.inkSoft }}>
                            {title}
                        </div>
                    )}
                </div>
                <div className="flex gap-1">
                    <button
                        onClick={goToday}
                        className="w-8 h-8 flex items-center justify-center rounded-full active:scale-95 transition"
                        style={{ background: 'rgba(253,246,231,0.7)', color: PAPER_TONES.ink }}
                        aria-label="回到今天"
                        title="回到今天"
                    >
                        <ArrowCounterClockwise className="w-3.5 h-3.5" weight="bold" />
                    </button>
                    <button
                        onClick={goNextMonth}
                        className="w-8 h-8 flex items-center justify-center rounded-full active:scale-95 transition"
                        style={{ background: 'rgba(253,246,231,0.7)', color: PAPER_TONES.ink }}
                        aria-label="下一月"
                    >
                        <CaretRight className="w-3.5 h-3.5" weight="bold" />
                    </button>
                </div>
            </div>

            {/* 周標籤條 */}
            <div className="grid grid-cols-7 gap-1 mb-1">
                {WEEK_LABELS.map((w, i) => (
                    <div
                        key={i}
                        className="text-center text-[10px] py-1 tracking-widest"
                        style={{
                            ...CUTE_STACK,
                            color: i === 0 || i === 6 ? accentColor : PAPER_TONES.inkSoft,
                        }}
                    >
                        {w}
                    </div>
                ))}
            </div>

            {/* 月曆格 */}
            <div
                className="grid grid-cols-7 gap-1 rounded-xl p-2"
                style={{
                    background: 'rgba(253,246,231,0.5)',
                    border: `1px solid ${PAPER_TONES.spine}`,
                    boxShadow: 'inset 0 1px 2px rgba(122,90,114,0.06)',
                }}
            >
                {cells.map((cell, idx) => {
                    const isToday = cell.date === today;
                    const isHighlighted = cell.date === highlightDate;
                    const cellContent = renderCell?.(cell.date);
                    return (
                        <button
                            key={idx}
                            onClick={() => onCellTap?.(cell.date)}
                            disabled={!onCellTap}
                            className="relative aspect-square rounded-md flex flex-col items-center justify-start py-1 active:scale-95 transition"
                            style={{
                                background: isHighlighted
                                    ? `${accentColor}33`
                                    : isToday
                                        ? 'rgba(255,255,255,0.6)'
                                        : 'transparent',
                                opacity: cell.thisMonth ? 1 : 0.3,
                                border: isToday ? `1.5px solid ${accentColor}` : '1px solid transparent',
                            }}
                        >
                            <span
                                style={{
                                    ...DISPLAY_STACK,
                                    fontSize: 12,
                                    color: cell.thisMonth ? PAPER_TONES.ink : PAPER_TONES.inkFaint,
                                    lineHeight: 1.1,
                                }}
                            >
                                {cell.day}
                            </span>
                            {/* caller 渲染區(emoji / 色塊 / 數字……) */}
                            <span className="flex-1 flex items-center justify-center pt-0.5 leading-none">
                                {cell.thisMonth ? cellContent : null}
                            </span>
                        </button>
                    );
                })}
            </div>

            {/* 底部小提示 */}
            <div
                className="text-[10px] text-center mt-3 italic"
                style={{ ...CUTE_STACK, color: PAPER_TONES.inkFaint }}
            >
                點哪天 · 寫哪天 ♡
            </div>
        </div>
    );
};

export default CalendarView;
