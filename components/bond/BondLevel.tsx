/**
 * 羈絆等級（plans/bond-batch4.md 2.1、4.1）：頁邊註記的樣子。等級只是一起經歷的累積，不換身份。
 */
import React from 'react';
import { levelInfo } from '../../utils/bond/level';

/** 首頁天數旁邊那個小字 */
export const LevelMark: React.FC<{ points: number; onClick?: () => void }> = ({ points, onClick }) => {
    const info = levelInfo(points);
    return (
        <button type="button" onClick={onClick} className="inline-flex items-center gap-2 align-middle text-[var(--bond-ink-2)]" aria-label={`羈絆等級 ${info.level}`}>
            <span className="bond-serif text-[15px] tracking-wide">Lv.{info.level}</span>
            <span className="relative inline-block h-[3px] w-14 bg-[var(--bond-line)] overflow-hidden rounded-full">
                <span className="absolute inset-y-0 left-0 bg-[var(--bond-accent)]" style={{ width: `${Math.round(info.progress * 100)}%` }} />
            </span>
        </button>
    );
};

/** 里程碑頁最上面那塊：等級、進度、總分，下面接入口 */
export const LevelPanel: React.FC<{ points: number; children?: React.ReactNode }> = ({ points, children }) => {
    const info = levelInfo(points);
    return (
        <div className="bond-block bg-[var(--bond-block-sand)] px-5 py-5">
            <div className="flex items-baseline justify-between">
                <div className="bond-serif text-[26px] tracking-wider">Lv.{info.level}</div>
                <div className="text-[11.5px] text-[var(--bond-muted)]">累積 {info.points} 分 · 再 {info.need} 分到 Lv.{info.level + 1}</div>
            </div>
            <div className="mt-3 h-[7px] w-full rounded-full bg-[var(--bond-track)] overflow-hidden">
                <div className="h-full rounded-full bg-[var(--bond-accent)]" style={{ width: `${Math.round(info.progress * 100)}%` }} />
            </div>
            <div className="mt-2 text-[10.5px] text-[var(--bond-muted)]">一起經歷過的事累積起來的；等級只解鎖事件的機會，不會改變你們是什麼關係。</div>
            {children && <div className="mt-3 flex flex-wrap gap-2">{children}</div>}
        </div>
    );
};
