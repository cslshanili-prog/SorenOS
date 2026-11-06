/**
 * SillyTavern 正則腳本（extensions/regex）的套用規則，照 ST 的 getRegexedString / runRegexScript：
 *
 * - store：用戶送出、AI 回覆落庫前。只跑兩個「只…」都沒勾的腳本，改的是存下來的原文。
 * - prompt：組送出內容時，對聊天記錄每一則。只跑勾了「只改送出」（promptOnly）的。
 * - display：畫面顯示時。只跑勾了「只改顯示」（markdownOnly）的。
 *
 * depth 從最後一則往回數，最後一則是 0；腳本的 minDepth / maxDepth 照 ST 的判法。
 * 替換字串裡的 `{{match}}`、`$1`、`$<name>` 照 ST 換，捕獲到的內容先刪掉 trimStrings，
 * 最後再展開一次巨集（`{{char}}`、`{{user}}`…）。
 */

import type { MeetingRegexScript } from './types';
import { expandMacros, type MacroEnv } from './macros';

export type RegexStage = 'store' | 'prompt' | 'display';

/** ST 的 placement 編號 */
export const REGEX_PLACEMENT = { userInput: 1, aiOutput: 2, worldInfo: 5, reasoning: 6 } as const;

const cache = new Map<string, RegExp | null>();

/** ST 的 regexFromString：`/pattern/flags` 或不帶斜線的整串 */
export const parseStRegex = (input: string): RegExp | null => {
    if (cache.has(input)) return cache.get(input)!;
    let result: RegExp | null = null;
    try {
        const m = input.match(/(\/?)(.+)\1([a-z]*)/is);
        if (m) {
            result = m[3] && !/^(?!.*?(.).*?\1)[gmisuydv]+$/.test(m[3])
                ? new RegExp(input)
                : new RegExp(m[2], m[3]);
        }
    } catch {
        result = null;
    }
    cache.set(input, result);
    return result;
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const findPattern = (script: MeetingRegexScript, env?: MacroEnv): string => {
    if (!env || !script.substituteRegex) return script.findRegex;
    const scratch = { ...env, vars: { ...env.vars }, globalVars: { ...env.globalVars } };
    if (Number(script.substituteRegex) === 2) {
        // 「跳脫後替換」：名字裡的特殊符號不能被當成正則語法
        const escaped = script.findRegex
            .replace(/\{\{\s*char\s*\}\}/gi, escapeRegExp(env.charName))
            .replace(/\{\{\s*user\s*\}\}/gi, escapeRegExp(env.userName));
        return expandMacros(escaped, scratch);
    }
    return expandMacros(script.findRegex, scratch);
};

export const runRegexScript = (script: MeetingRegexScript, text: string, env?: MacroEnv): string => {
    if (!text || script.disabled || !script.findRegex) return text;
    const regex = parseStRegex(findPattern(script, env));
    if (!regex) return text;
    return text.replace(regex, (...args: any[]) => {
        const hasGroups = typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null;
        const groups = hasGroups ? args[args.length - 1] : undefined;
        const replaced = script.replaceString
            .replace(/\{\{match\}\}/gi, '$0')
            .replace(/\$(\d+)|\$<([^>]+)>/g, (_m: string, num?: string, name?: string) => {
                const captured = num !== undefined ? args[Number(num)] : groups?.[name as string];
                if (typeof captured !== 'string' || !captured) return '';
                return script.trimStrings.reduce((acc, trim) => (trim ? acc.split(trim).join('') : acc), captured);
            });
        return env ? expandMacros(replaced, { ...env, vars: { ...env.vars }, globalVars: { ...env.globalVars } }) : replaced;
    });
};

const stageAllows = (script: MeetingRegexScript, stage: RegexStage): boolean => {
    if (stage === 'display') return script.markdownOnly;
    if (stage === 'prompt') return script.promptOnly;
    return !script.markdownOnly && !script.promptOnly;
};

const depthAllows = (script: MeetingRegexScript, depth: number | undefined): boolean => {
    if (typeof depth !== 'number') return true;
    if (script.minDepth !== null && script.minDepth >= -1 && depth < script.minDepth) return false;
    if (script.maxDepth !== null && script.maxDepth >= 0 && depth > script.maxDepth) return false;
    return true;
};

export const applyRegexScripts = (
    text: string,
    scripts: MeetingRegexScript[],
    options: { placement: number; stage: RegexStage; depth?: number; isEdit?: boolean; env?: MacroEnv },
): string => {
    let result = text;
    for (const script of scripts) {
        if (script.disabled || !stageAllows(script, options.stage)) continue;
        if (options.isEdit && !script.runOnEdit) continue;
        if (!depthAllows(script, options.depth)) continue;
        if (!script.placement.includes(options.placement)) continue;
        result = runRegexScript(script, result, options.env);
    }
    return result;
};
