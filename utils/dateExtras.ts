/**
 * 見面設定裡的劇情大綱、開場白、回應字數：內建模式與自訂預設模式共用的小工具。
 * 見 plans/offline-date-redesign.md 第 1、2、9 項。
 */

import type { CharacterProfile } from '../types';
import { expandMacros } from './meetingPreset/macros';

export type DateGreeting = { id: string; text: string };

/** 開場白裡的 {{char}}／{{user}} 換掉（其餘巨集照 ST 規則，認不得的不動） */
export const expandGreeting = (text: string, charName: string, userName: string): string =>
    expandMacros(text, { charName, userName, vars: {}, globalVars: {} }).trim();

/** 隨機挑一條；有上一條就盡量換一條不一樣的 */
export const pickGreeting = (
    greetings: DateGreeting[],
    previousId?: string,
    rng: () => number = Math.random,
): DateGreeting | undefined => {
    const usable = greetings.filter(g => g.text.trim());
    if (!usable.length) return undefined;
    const pool = usable.length > 1 && previousId ? usable.filter(g => g.id !== previousId) : usable;
    return pool[Math.floor(rng() * pool.length)] ?? pool[0];
};

/** 劇情大綱原文，{{char}}／{{user}} 先換好（ST 也是先展開角色卡欄位再塞進 {{scenario}}） */
export const scenarioText = (char: CharacterProfile, userName = ''): string =>
    expandGreeting(char.dateScenario || '', char.name, userName);

/** 內建模式的劇情大綱段；沒填就不帶 */
export const buildScenarioBlock = (char: CharacterProfile, userName = ''): string => {
    const text = scenarioText(char, userName);
    return text ? `### 當前劇情大綱\n${text}\n（這是用戶定的劇情方向：照著它走，細節自己發揮；不要一口氣把大綱寫完。）\n` : '';
};

const positive = (value: unknown): number | undefined => {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** 「800–1200 字」「至少 800 字」「最多 1200 字」；都沒填回空字串 */
export const describeLength = (range: CharacterProfile['dateResponseLength']): string => {
    const min = positive(range?.min);
    const max = positive(range?.max);
    if (min && max) return min <= max ? `${min}–${max} 字` : `${max}–${min} 字`;
    if (min) return `至少 ${min} 字`;
    if (max) return `最多 ${max} 字`;
    return '';
};

export const buildLengthLine = (char: CharacterProfile): string => {
    const text = describeLength(char.dateResponseLength);
    return text ? `### 回應長度\n這一輪正文大約 ${text}（只算正文，不含台詞外的標記）。\n` : '';
};

/**
 * 自訂預設常用 {{getglobalvar::字数总要求}} 之類的變數讀字數（在 ST 由「預設助手」設）。
 * 名字裡有「字數／字数」又有「總／总」的，就用 Soren 的回應字數蓋過去。
 * 回傳要蓋的值，以及有沒有蓋到（沒蓋到就由 Soren 的「回應字數」佔位另外說）。
 */
export const presetLengthGlobals = (
    globalVars: Record<string, string>,
    char: CharacterProfile,
): { overrides: Record<string, string>; mapped: boolean } => {
    const text = describeLength(char.dateResponseLength);
    if (!text) return { overrides: {}, mapped: false };
    const keys = Object.keys(globalVars).filter(key => /字[數数]/.test(key) && /[總总]/.test(key));
    return { overrides: Object.fromEntries(keys.map(key => [key, text])), mapped: keys.length > 0 };
};
