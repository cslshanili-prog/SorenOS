/**
 * 「心声 / 好感度」自动更新节奏的纯判定逻辑——不碰网络/DB，方便单测。
 * 实际调 API 重新生成的编排逻辑在 utils/customMeterGenerator.ts（checkCustomMeterAutoUpdate）。
 */
import { CharacterCustomMeter } from '../types';

/** 这条 entry 的「hours」节奏是否到期该自动更新了；没设 autoUpdate 或不是 hours 模式一律 false。 */
export function isCustomMeterHoursDue(entry: CharacterCustomMeter, now: number = Date.now()): boolean {
  if (entry.autoUpdate?.mode !== 'hours') return false;
  const interval = entry.autoUpdate.interval;
  if (!interval || interval <= 0) return false;
  if (!entry.updatedAt) return true; // 从没生成过，直接判定到期，触发第一次
  return now - entry.updatedAt >= interval * 3600_000;
}

/**
 * 「turns」节奏：给一组 entries 推进一轮（本地聊天每发一次请求调一次）。
 * 非 turns 模式的条目原样透传；turns 模式的条目计数 +1，达到 autoUpdate.interval 时
 * 计数清零并进入返回的 due 数组（同时也已经在 entries 里体现为清零后的状态）。
 * 不改动 content/value——那部分留给调用方按 due 列表去跑生成。
 */
export function tickCustomMeterTurns(
  entries: CharacterCustomMeter[],
): { entries: CharacterCustomMeter[]; due: CharacterCustomMeter[] } {
  const due: CharacterCustomMeter[] = [];
  const next = entries.map(e => {
    if (e.autoUpdate?.mode !== 'turns') return e;
    const interval = e.autoUpdate.interval;
    if (!interval || interval <= 0) return e;
    const count = (e.turnsSinceAutoUpdate || 0) + 1;
    if (count >= interval) {
      const reset = { ...e, turnsSinceAutoUpdate: 0 };
      due.push(reset);
      return reset;
    }
    return { ...e, turnsSinceAutoUpdate: count };
  });
  return { entries: next, due };
}
