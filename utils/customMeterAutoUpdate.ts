/**
 * 「心聲 / 好感度」自動更新節奏的純判定邏輯——不碰網絡/DB，方便單測。
 * 實際調 API 重新生成的編排邏輯在 utils/customMeterGenerator.ts（checkCustomMeterAutoUpdate）。
 */
import { CharacterCustomMeter } from '../types';

/** 這條 entry 的「hours」節奏是否到期該自動更新了；沒設 autoUpdate 或不是 hours 模式一律 false。 */
export function isCustomMeterHoursDue(entry: CharacterCustomMeter, now: number = Date.now()): boolean {
  if (entry.autoUpdate?.mode !== 'hours') return false;
  const interval = entry.autoUpdate.interval;
  if (!interval || interval <= 0) return false;
  if (!entry.updatedAt) return true; // 從沒生成過，直接判定到期，觸發第一次
  return now - entry.updatedAt >= interval * 3600_000;
}

/**
 * 「turns」節奏：給一組 entries 推進一輪（本地聊天每發一次請求調一次）。
 * 非 turns 模式的條目原樣透傳；turns 模式的條目計數 +1，達到 autoUpdate.interval 時
 * 計數清零並進入返回的 due 數組（同時也已經在 entries 裡體現為清零後的狀態）。
 * 不改動 content/value——那部分留給調用方按 due 列表去跑生成。
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
