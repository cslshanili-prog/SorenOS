/**
 * 見面自訂預設 → SillyTavern Chat Completion 預設（stImport.ts 反過來）。
 *
 * 匯出的檔丟回酒館能直接用：條目、順序、開關、插進聊天記錄的深度、生成參數、預填、內嵌正則、
 * 「預設助手」的分組都照 ST 的欄位寫。Soren 自己的佔位（記憶、情緒…）酒館沒有，寫成空白條目，
 * 酒館會略過。
 *
 * 另外把整份 doc 原樣塞在 extensions.soren_meeting_preset，連同 ST 那幾段的指紋：
 * 丟回 Soren 時指紋對得上就整份還原（變數的值、Soren 佔位都在）；在酒館改過、指紋對不上，
 * 就照一般的 ST 檔讀，不拿舊的蓋掉酒館裡的修改。
 */

import type { MeetingPresetDoc, MeetingPresetPrompt } from './types';

export const SOREN_EXTENSION_KEY = 'soren_meeting_preset';

const ST_SLOT_IDS = new Set([
    'worldInfoBefore', 'worldInfoAfter', 'charDescription', 'charPersonality',
    'scenario', 'personaDescription', 'dialogueExamples', 'chatHistory',
]);

const isStSlot = (prompt: MeetingPresetPrompt) => !!prompt.slot && ST_SLOT_IDS.has(prompt.slot);

/** 條目在 ST 裡的 identifier：ST 佔位一定要用 ST 的名字，其餘沿用原本的 id */
const stIdentifier = (prompt: MeetingPresetPrompt) => (isStSlot(prompt) ? prompt.slot! : prompt.id);

const toStPrompt = (prompt: MeetingPresetPrompt) => {
    const identifier = stIdentifier(prompt);
    if (isStSlot(prompt)) return { identifier, name: prompt.name, system_prompt: true, marker: true };
    return {
        identifier,
        name: prompt.slot ? `${prompt.name}（Soren 專用，酒館裡沒作用）` : prompt.name,
        role: prompt.role,
        content: prompt.slot ? '' : prompt.content,
        system_prompt: false,
        marker: false,
        injection_position: prompt.inChat ? 1 : 0,
        injection_depth: prompt.inChat?.depth ?? 4,
        injection_order: prompt.inChat?.order ?? 100,
        forbid_overrides: false,
    };
};

const defined = (entries: Array<[string, unknown]>) =>
    Object.fromEntries(entries.filter(([, value]) => value !== undefined && value !== ''));

/** 指紋只看 ST 也會改的那幾段；用 FNV-1a，夠分辨「有沒有被動過」 */
export const stPresetFingerprint = (data: any): string => {
    const text = JSON.stringify([data?.prompts ?? null, data?.prompt_order ?? null, data?.extensions?.regex_scripts ?? null]);
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
};

export const buildStPreset = (doc: MeetingPresetDoc): Record<string, unknown> => {
    const groupOf = new Map<string, string>();
    doc.groups.forEach(group => group.promptIds.forEach(id => groupOf.set(id, group.id)));
    const promptsById = new Map(doc.prompts.map(prompt => [prompt.id, prompt]));

    const data: Record<string, any> = {
        ...defined([
            ['temperature', doc.generation.temperature],
            ['top_p', doc.generation.topP],
            ['top_k', doc.generation.topK],
            ['frequency_penalty', doc.generation.frequencyPenalty],
            ['presence_penalty', doc.generation.presencePenalty],
            ['openai_max_tokens', doc.generation.maxTokens],
            ['assistant_prefill', doc.assistantPrefill],
            ['wi_format', doc.worldInfoFormat],
            ['scenario_format', doc.scenarioFormat],
            ['personality_format', doc.personalityFormat],
        ]),
        prompts: doc.prompts.map(toStPrompt),
        prompt_order: [{
            character_id: 100001,
            order: doc.prompts.map(prompt => ({ identifier: stIdentifier(prompt), enabled: prompt.enabled })),
        }],
        extensions: {
            regex_scripts: doc.regexScripts.map(script => ({ ...script })),
        },
    };

    if (doc.groups.length) {
        const prompts: Record<string, { groupId: string }> = {};
        for (const [promptId, groupId] of groupOf) {
            const prompt = promptsById.get(promptId);
            if (prompt) prompts[stIdentifier(prompt)] = { groupId };
        }
        data.extensions.baibaiToolkit = {
            presetPromptGroups: { groups: doc.groups.map((group, order) => ({ id: group.id, name: group.name, order })), prompts },
        };
    }

    data.extensions[SOREN_EXTENSION_KEY] = { fingerprint: stPresetFingerprint(data), doc };
    return data;
};

/** 檔名：預設名去掉檔案系統不收的字元 */
export const stPresetFileName = (doc: MeetingPresetDoc): string =>
    `${(doc.name || '見面預設').replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim().slice(0, 60) || '見面預設'}.json`;

/** 匯回 Soren：指紋對得上才用塞在裡面的那份 */
export const readEmbeddedSorenDoc = (data: any): MeetingPresetDoc | null => {
    const embedded = data?.extensions?.[SOREN_EXTENSION_KEY];
    const doc = embedded?.doc;
    if (!doc || doc.schema !== 'soren.meeting-preset' || !Array.isArray(doc.prompts) || !Array.isArray(doc.regexScripts)) return null;
    if (embedded.fingerprint !== stPresetFingerprint(data)) return null;
    return {
        ...doc,
        groups: Array.isArray(doc.groups) ? doc.groups : [],
        globalVars: doc.globalVars && typeof doc.globalVars === 'object' ? doc.globalVars : {},
        generation: doc.generation && typeof doc.generation === 'object' ? doc.generation : {},
    };
};
