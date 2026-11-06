/**
 * 見面自訂預設 → 送給模型的 messages，照 ST Chat Completion 的拼法：
 *
 * - 條目照預設的順序一則一則送，角色照條目自己的 role；內容空的（含巨集展開後只剩空白的）不送。
 * - 資料佔位換成 Soren 填的內容；聊天記錄放在 chatHistory 佔位的位置，佔位關掉就整段不送（同 ST）。
 * - 「插進聊天記錄」的條目（ST injection_position = 1）照 ST populationInjectionPrompts 的排法：
 *   深度 d 的放在倒數第 d 則之前；同深度按 order 由小到大，同 order 依 assistant、user、system，
 *   同角色的併成一則。
 * - 聊天記錄每則先跑「只改送出」的正則，depth 從最後一則往回數。
 * - 巨集跑兩遍：第一遍收集 `{{setvar}}`，第二遍從第一遍的結果起跑。ST 的變數存在聊天裡、
 *   跨輪保留，所以前面的條目讀得到後面條目上一輪設的值；兩遍模擬的就是這個穩定狀態。
 * - Soren 自己的佔位預設沒放的，補在聊天記錄前面。
 */

import type { MeetingPresetDoc, MeetingPresetPrompt, MeetingPresetSlot, MeetingPromptRole, MeetingSorenSlot } from './types';
import { expandMacros, type MacroEnv } from './macros';
import { applyRegexScripts, REGEX_PLACEMENT } from './regex';

export interface PresetMessage {
    role: MeetingPromptRole;
    content: string;
}

export interface AssembleInput {
    doc: MeetingPresetDoc;
    slots: Partial<Record<MeetingPresetSlot, string>>;
    /** 照時間排；最後一則通常是本輪用戶輸入。system 是已經插好的（例如世界書的指定深度條目），不跑正則、不算深度 */
    history: Array<{ role: MeetingPromptRole; content: string }>;
    env: Omit<MacroEnv, 'vars' | 'globalVars'>;
    /** 蓋過預設裡存的 globalVars（例如 Soren 的回應字數設定） */
    globalVars?: Record<string, string>;
}

export interface AssembleResult {
    messages: PresetMessage[];
    vars: Record<string, string>;
}

const SOREN_SLOT_ORDER: MeetingSorenSlot[] = ['soren', 'memory', 'emotion', 'time', 'length', 'voice'];

const formatSlot = (doc: MeetingPresetDoc, slot: MeetingPresetSlot, content: string, env: MacroEnv): string => {
    if (!content.trim()) return '';
    if ((slot === 'worldInfoBefore' || slot === 'worldInfoAfter') && doc.worldInfoFormat?.includes('{0}')) {
        return doc.worldInfoFormat.replace('{0}', content);
    }
    if (slot === 'scenario' && doc.scenarioFormat) return expandMacros(doc.scenarioFormat, { ...env, scenario: content });
    if (slot === 'charPersonality' && doc.personalityFormat) return expandMacros(doc.personalityFormat, { ...env, charPersonality: content });
    return expandMacros(content, env);
};

const injectIntoHistory = (history: PresetMessage[], injections: MeetingPresetPrompt[], rendered: Map<string, string>): PresetMessage[] => {
    if (!injections.length) return history;
    const byDepth = new Map<number, MeetingPresetPrompt[]>();
    for (const prompt of injections) {
        const depth = Math.min(prompt.inChat!.depth, history.length);
        byDepth.set(depth, [...(byDepth.get(depth) || []), prompt]);
    }
    const result = [...history];
    // 深的先插：插進去的不影響淺的位置
    for (const depth of [...byDepth.keys()].sort((a, b) => b - a)) {
        const prompts = byDepth.get(depth)!;
        const orders = [...new Set(prompts.map(p => p.inChat!.order))].sort((a, b) => a - b);
        const block: PresetMessage[] = [];
        for (const order of orders) {
            for (const role of ['assistant', 'user', 'system'] as MeetingPromptRole[]) {
                const content = prompts
                    .filter(p => p.inChat!.order === order && p.role === role)
                    .map(p => (rendered.get(p.id) || '').trim())
                    .filter(Boolean)
                    .join('\n');
                if (content) block.push({ role, content });
            }
        }
        result.splice(history.length - depth + (result.length - history.length), 0, ...block);
    }
    return result;
};

export const assembleMeetingPreset = (input: AssembleInput): AssembleResult => {
    const { doc } = input;
    const enabled = doc.prompts.filter(prompt => prompt.enabled);
    const globals = { ...doc.globalVars, ...(input.globalVars || {}) };

    const render = (seed: Record<string, string>) => {
        const env: MacroEnv = { ...input.env, vars: { ...seed }, globalVars: { ...globals } };
        const contents = new Map<string, string>();
        for (const prompt of enabled) {
            if (!prompt.slot) contents.set(prompt.id, expandMacros(prompt.content, env));
        }
        return { contents, env };
    };
    const { contents, env } = render(render({}).env.vars);

    const chatCount = input.history.filter(message => message.role !== 'system').length;
    let seen = 0;
    const history: PresetMessage[] = input.history
        .map(message => {
            if (message.role === 'system') return { ...message };
            seen++;
            return {
                role: message.role,
                content: applyRegexScripts(message.content, doc.regexScripts, {
                    placement: message.role === 'user' ? REGEX_PLACEMENT.userInput : REGEX_PLACEMENT.aiOutput,
                    stage: 'prompt',
                    depth: chatCount - seen,
                    env,
                }),
            };
        })
        .filter(message => message.content.trim());

    const placed = new Set(enabled.map(prompt => prompt.slot).filter(Boolean));
    const sorenExtras: PresetMessage[] = SOREN_SLOT_ORDER
        .filter(slot => !placed.has(slot) && input.slots[slot]?.trim())
        .map(slot => ({ role: 'system', content: input.slots[slot]!.trim() }));

    const before: PresetMessage[] = [];
    const after: PresetMessage[] = [];
    let sawHistory = false;
    const injections: MeetingPresetPrompt[] = [];
    for (const prompt of enabled) {
        const target = sawHistory ? after : before;
        if (prompt.slot === 'chatHistory') { sawHistory = true; continue; }
        if (prompt.slot) {
            const raw = input.slots[prompt.slot] || '';
            const text = (prompt.slot === 'worldInfoBefore' || prompt.slot === 'worldInfoAfter')
                ? formatSlot(doc, prompt.slot, applyRegexScripts(raw, doc.regexScripts, { placement: REGEX_PLACEMENT.worldInfo, stage: 'prompt', env }), env)
                : formatSlot(doc, prompt.slot, raw, env);
            if (text.trim()) target.push({ role: prompt.role, content: text });
            continue;
        }
        if (prompt.inChat) { injections.push(prompt); continue; }
        const text = contents.get(prompt.id) || '';
        if (text.trim()) target.push({ role: prompt.role, content: text });
    }

    const messages = sawHistory
        ? [...before, ...sorenExtras, ...injectIntoHistory(history, injections, contents), ...after]
        : [...before, ...sorenExtras, ...after];

    const prefill = doc.assistantPrefill ? expandMacros(doc.assistantPrefill, env).trim() : '';
    if (prefill) messages.push({ role: 'assistant', content: prefill });

    return { messages, vars: env.vars };
};
