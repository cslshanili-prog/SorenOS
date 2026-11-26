/**
 * 羈絆等級（plans/bond-batch4.md 2.1、第 10 節第 1 題）。門檻固定、不讓改；等級不另存，照總分現算。
 * Lv.10 之後每級的級距比上一級多 200（Lv.11 7800、Lv.12 9600…）。
 */

export const LEVEL_THRESHOLDS: readonly number[] = [0, 60, 280, 600, 1200, 1800, 2600, 3600, 4800, 6200];

/** 到某一級要的累積分數（level 從 1 起） */
export function levelThreshold(level: number): number {
    const lv = Math.max(1, Math.floor(level));
    if (lv <= LEVEL_THRESHOLDS.length) return LEVEL_THRESHOLDS[lv - 1];
    let total = LEVEL_THRESHOLDS[LEVEL_THRESHOLDS.length - 1];
    let gap = total - LEVEL_THRESHOLDS[LEVEL_THRESHOLDS.length - 2];
    for (let l = LEVEL_THRESHOLDS.length + 1; l <= lv; l++) {
        gap += 200;
        total += gap;
    }
    return total;
}

export interface LevelInfo {
    level: number;
    points: number;
    /** 這一級的起點、下一級的門檻 */
    floor: number;
    next: number;
    /** 這一級已經走了多少、還差多少；0～1 */
    into: number;
    need: number;
    progress: number;
}

export function levelInfo(points: number): LevelInfo {
    const p = Math.max(0, Math.floor(points || 0));
    let level = 1;
    while (levelThreshold(level + 1) <= p) level++;
    const floor = levelThreshold(level);
    const next = levelThreshold(level + 1);
    return { level, points: p, floor, next, into: p - floor, need: next - p, progress: (p - floor) / (next - floor) };
}
