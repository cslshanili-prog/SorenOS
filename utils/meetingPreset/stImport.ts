/**
 * SillyTavern Chat Completion 預設 → 見面自訂預設。
 *
 * 只讀送出要用到的部分：prompts / prompt_order / 生成參數 / assistant_prefill / 預設內嵌的正則。
 * 酒館助手（tavern_helper）的腳本和其它擴充資料不收：Soren 不跑第三方腳本。
 * 文字一律原樣保留，不轉繁體——正則靠原文的簡體標籤匹配。
 */

import type {
    MeetingPresetDoc,
    MeetingPresetGroup,
    MeetingPresetPrompt,
    MeetingPromptRole,
    MeetingRegexScript,
    MeetingStSlot,
} from './types';

const ST_MARKERS: Record<string, MeetingStSlot> = {
    worldInfoBefore: 'worldInfoBefore',
    worldInfoAfter: 'worldInfoAfter',
    charDescription: 'charDescription',
    charPersonality: 'charPersonality',
    scenario: 'scenario',
    personaDescription: 'personaDescription',
    dialogueExamples: 'dialogueExamples',
    chatHistory: 'chatHistory',
};

/** ST 用 100001 存全域的條目順序，100000 是舊版的預設角色 */
const GLOBAL_ORDER_IDS = [100001, 100000];

const MAX_PRESET_BYTES = 8 * 1024 * 1024;

const num = (value: unknown): number | undefined => {
    const n = Number(value);
    return value === null || value === undefined || value === '' || !Number.isFinite(n) ? undefined : n;
};

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const asRole = (value: unknown): MeetingPromptRole =>
    value === 'user' || value === 'assistant' ? value : 'system';

const pickOrder = (data: any): Array<{ identifier: string; enabled: boolean }> | null => {
    const orders: any[] = Array.isArray(data.prompt_order) ? data.prompt_order : [];
    const chosen = GLOBAL_ORDER_IDS.map(id => orders.find(o => Number(o?.character_id) === id)).find(Boolean)
        || orders.find(o => Array.isArray(o?.order) && o.order.length > 0);
    if (!chosen || !Array.isArray(chosen.order)) return null;
    return chosen.order
        .filter((item: any) => typeof item?.identifier === 'string')
        .map((item: any) => ({ identifier: item.identifier, enabled: item.enabled !== false }));
};

const toPrompt = (raw: any, enabled: boolean): MeetingPresetPrompt => {
    const id = str(raw.identifier);
    const slot = ST_MARKERS[id];
    const prompt: MeetingPresetPrompt = {
        id,
        name: str(raw.name) || id,
        enabled,
        role: asRole(raw.role),
        content: slot ? '' : str(raw.content),
    };
    if (slot) prompt.slot = slot;
    // 佔位沒有「插進聊天記錄」這回事；其餘 injection_position = 1 的才是
    else if (Number(raw.injection_position) === 1) {
        prompt.inChat = {
            depth: Math.max(0, Math.floor(num(raw.injection_depth) ?? 4)),
            order: num(raw.injection_order) ?? 100,
        };
    }
    return prompt;
};

const toRegex = (raw: any, index: number): MeetingRegexScript | null => {
    if (!raw || typeof raw.findRegex !== 'string' || !raw.findRegex) return null;
    return {
        id: str(raw.id) || `regex-${index}`,
        scriptName: str(raw.scriptName) || `正則 ${index + 1}`,
        findRegex: raw.findRegex,
        replaceString: str(raw.replaceString),
        trimStrings: Array.isArray(raw.trimStrings) ? raw.trimStrings.filter((s: unknown) => typeof s === 'string') : [],
        placement: Array.isArray(raw.placement) ? raw.placement.map(Number).filter(Number.isFinite) : [],
        disabled: raw.disabled === true,
        markdownOnly: raw.markdownOnly === true,
        promptOnly: raw.promptOnly === true,
        runOnEdit: raw.runOnEdit !== false,
        substituteRegex: num(raw.substituteRegex) ?? 0,
        minDepth: num(raw.minDepth) ?? null,
        maxDepth: num(raw.maxDepth) ?? null,
    };
};

/** 「預設助手」之類的擴充存的分組（extensions.baibaiToolkit.presetPromptGroups）；沒有就不分組 */
const readGroups = (data: any, promptIds: Set<string>): MeetingPresetGroup[] => {
    const raw = data?.extensions?.baibaiToolkit?.presetPromptGroups;
    if (!raw || !Array.isArray(raw.groups) || !raw.prompts || typeof raw.prompts !== 'object') return [];
    const members = new Map<string, string[]>();
    for (const [promptId, value] of Object.entries<any>(raw.prompts)) {
        const groupId = typeof value?.groupId === 'string' ? value.groupId : '';
        if (!groupId || !promptIds.has(promptId)) continue;
        members.set(groupId, [...(members.get(groupId) || []), promptId]);
    }
    return [...raw.groups]
        .filter((g: any) => typeof g?.id === 'string' && typeof g?.name === 'string')
        .sort((a: any, b: any) => (num(a.order) ?? 0) - (num(b.order) ?? 0))
        .map((g: any) => ({ id: g.id, name: g.name, promptIds: members.get(g.id) || [] }))
        .filter(g => g.promptIds.length > 0);
};

/** 掃出 `{{getglobalvar::名字}}` 用到的名字，好讓用戶在設定裡填 */
export const collectGlobalVarNames = (prompts: MeetingPresetPrompt[]): string[] => {
    const names = new Set<string>();
    for (const prompt of prompts) {
        for (const match of prompt.content.matchAll(/\{\{\s*getglobalvar::([^}:]+?)\s*\}\}/gi)) names.add(match[1].trim());
    }
    return [...names];
};

export const isStChatCompletionPreset = (data: unknown): boolean =>
    !!data && typeof data === 'object' && Array.isArray((data as any).prompts);

export const parseStPreset = (rawText: string, fileName = ''): MeetingPresetDoc => {
    if (rawText.length > MAX_PRESET_BYTES) throw new Error('預設檔超過 8 MB，裝不下');
    let data: any;
    try { data = JSON.parse(rawText); } catch { throw new Error('不是有效的 JSON 檔'); }
    if (!isStChatCompletionPreset(data)) {
        throw new Error('看起來不是 SillyTavern 的對話補全（Chat Completion）預設：缺少 prompts');
    }

    const byId = new Map<string, any>();
    for (const raw of data.prompts) {
        if (raw && typeof raw.identifier === 'string') byId.set(raw.identifier, raw);
    }

    const order = pickOrder(data);
    const prompts: MeetingPresetPrompt[] = order
        ? order.flatMap(({ identifier, enabled }) => {
            const raw = byId.get(identifier) || (ST_MARKERS[identifier] ? { identifier, name: identifier, marker: true } : null);
            return raw ? [toPrompt(raw, enabled)] : [];
        })
        // 沒有 prompt_order 的舊檔：照 prompts 的順序，開關看條目自己的 enabled
        : data.prompts.filter((raw: any) => raw && typeof raw.identifier === 'string').map((raw: any) => toPrompt(raw, raw.enabled !== false));

    if (!prompts.some(prompt => prompt.slot === 'chatHistory')) {
        prompts.push({ id: 'chatHistory', name: '聊天記錄', enabled: true, role: 'system', content: '', slot: 'chatHistory' });
    }

    const regexScripts = (Array.isArray(data?.extensions?.regex_scripts) ? data.extensions.regex_scripts : [])
        .map(toRegex)
        .filter((script: MeetingRegexScript | null): script is MeetingRegexScript => !!script);

    const globalVars: Record<string, string> = {};
    for (const name of collectGlobalVarNames(prompts)) globalVars[name] = '';

    const baseName = fileName.replace(/\.json$/i, '').trim();
    return {
        schema: 'soren.meeting-preset',
        version: 1,
        name: baseName || str(data.name) || '匯入的預設',
        generation: {
            temperature: num(data.temperature),
            topP: num(data.top_p),
            topK: num(data.top_k) || undefined,
            frequencyPenalty: num(data.frequency_penalty),
            presencePenalty: num(data.presence_penalty),
            maxTokens: num(data.openai_max_tokens),
        },
        prompts,
        regexScripts,
        groups: readGroups(data, new Set(prompts.map(prompt => prompt.id))),
        assistantPrefill: str(data.assistant_prefill) || undefined,
        worldInfoFormat: str(data.wi_format) || undefined,
        scenarioFormat: str(data.scenario_format) || undefined,
        personalityFormat: str(data.personality_format) || undefined,
        globalVars,
    };
};
