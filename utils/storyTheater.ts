import type {
    CharacterProfile,
    Message,
    MountedWorldbook,
    NPCProfile,
    StoryTheaterEntry,
    StoryTheaterMask,
    StoryTheaterMaskSelection,
    StoryTheaterPreset,
    StoryTheaterPresetDocument,
    StoryTheaterPresetPrompt,
    UserProfile,
} from '../types';
import nightScreeningV627 from '../assets/presets/night-screening-v6.14.sully.json';
import {
    formatWorldbookSection,
    resolveWorldbookEntries,
    splitWorldbookSections,
    type WorldbookScanMessage,
} from './worldbook';
import { shareOrDownloadFile } from './shareExport';
import { buildNpcMemoryBlock } from './npcMemory';

export type StoryApiRole = 'system' | 'user' | 'assistant';
export interface StoryApiMessage { role: StoryApiRole; content: string; }

export interface StoryPromptSlots {
    actors: string;
    persona: string;
    scenario: string;
    worldBefore: string;
    worldAfter: string;
    examples?: string;
    history?: string;
}

export interface StoryGenerationSettings {
    temperature?: number;
    top_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    max_tokens: number;
}

/**
 * 默認完整發送酒館預設中的採樣參數。只有用戶為當前劇情顯式開啟兼容開關時，才省略
 * top_p / frequency_penalty / presence_penalty；不能用少數中轉的兼容問題犧牲正常預設效果。
 */
export const prepareStoryGenerationSettings = (
    settings?: Partial<StoryGenerationSettings>,
    omitSamplingParams = false,
): Partial<StoryGenerationSettings> => {
    if (!settings) return {};
    if (!omitSamplingParams) return { ...settings };
    const {
        top_p: _topP,
        frequency_penalty: _frequencyPenalty,
        presence_penalty: _presencePenalty,
        ...compatible
    } = settings;
    return compatible;
};

export interface StoryAffinityInput {
    characterId?: string;
    characterName?: string;
    delta: number;
    reason: string;
    awareness?: 'noticed' | 'unnoticed';
}

export interface ResolvedStoryTheaterMask {
    selection: StoryTheaterMaskSelection;
    name: string;
    avatar?: string;
    description: string;
    coreInstruction?: string;
    worldview?: string;
    characterId?: string;
}

export type StoryDisplayBlockKind = 'story' | 'scene' | 'backstage' | 'worldline' | 'debts' | 'theater' | 'choices' | 'affinity' | 'other';
export interface StoryDisplayBlock {
    kind: StoryDisplayBlockKind;
    title?: string;
    text: string;
    theater?: StoryMiniTheaterDisplay;
}

export interface StoryMiniTheaterDisplayMessage {
    side: 'left' | 'right';
    name: string;
    text: string;
}

export interface StoryMiniTheaterDisplay {
    title: string;
    system?: string;
    messages: StoryMiniTheaterDisplayMessage[];
}

export const REAL_COMPANION_MEMORY_GUARD = [
    '### 真實陪伴 · 共同記憶真實性（不可覆蓋）',
    '- 只能把本上下文、角色已有真實記憶或本條真實陪伴中明確發生過的事件，當作角色與用戶的共同記憶。',
    '- 不得捏造兩人曾經發生過的經歷，不得把推測、夢境、預設示例或虛構劇場內容說成真實記憶。',
    '- 引用共同記憶時不得添油加醋、補寫不存在的細節、篡改因果或誇大情感；不確定時必須明確表現為不確定。',
    '- 可以自然遺忘或記錯角色確實可能記錯的細枝末節，但不得藉此創造對用戶不利或未經用戶確認的共同歷史。',
].join('\n');

export const RELATIONSHIP_TEXTURE_GUIDE = [
    '### 關係溫度 · 高位不等於靜止',
    '- 關係溫度是長期底座，不是每輪必須變化的進度條。尤其達到 95—100 後，沒有真正改變關係的新事實就保持原值與 +0，不為製造新鮮感反覆漲跌。',
    '- 數值穩定時，變化應落在關係質地：默契如何落地、邊界是否被尊重、哪件小事仍然刺手、彼此依賴的方式、剛形成的共同習慣、未說開的分歧或本輪完成的一次修復。',
    '- <relation_note> 每輪只寫一句最能概括此刻質地的關係天氣，避免連續複用“甜蜜、親密、信任加深”等空泛同義句。',
    '- 在 <relation_note> 之後可追加 1—3 條 <relation_fragment>關係碎片</relation_fragment>；每條是一句基於本輪具體事實的短觀察。維度按事實輪換，不寫散亂 Markdown，不復述分數，不預測結局。',
    '- 若本輪確實沒有值得記錄的新紋理，可以不輸出 relation_fragment；不要硬編碎念。',
].join('\n');

const NATIVE_MARKERS: Array<NonNullable<StoryTheaterPresetPrompt['marker']>> = [
    'characters', 'world_before', 'user', 'world_after', 'scenario', 'examples', 'history',
];

const clampNumber = (value: unknown, min: number, max: number, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

const normalizeRole = (role: unknown): StoryApiRole => {
    if (role === 'assistant' || role === 2) return 'assistant';
    if (role === 'user' || role === 1) return 'user';
    return 'system';
};

export const makeStoryTheaterId = (): string => (
    globalThis.crypto?.randomUUID?.() || `story_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
);

export const storyTheaterThreadId = (entryId: string): string => `story-theater:${entryId}`;

const formatStoryExportTime = (timestamp: number): string => {
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return '未知時間';
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

/** 把一條劇情的完整中央線程導出為便於長期保存與檢索的純文字原文。 */
export const formatStoryTheaterExport = (
    entry: Pick<StoryTheaterEntry, 'title' | 'premise' | 'writesToCharacterMemory'>,
    identityName: string,
    actorNames: string[],
    messages: Message[],
    exportedAt: number = Date.now(),
): string => {
    const title = entry.title.trim() || '未命名劇情';
    const userLabel = identityName.trim() || '你';
    const lines = [
        `劇情記錄 · ${title}`,
        `模式：${entry.writesToCharacterMemory ? '真實時間陪伴' : '虛構劇場'}`,
        `你：${userLabel}`,
        `角色：${actorNames.filter(Boolean).join('、') || '暫無'}`,
        `導出時間：${formatStoryExportTime(exportedAt)}`,
    ];
    if (entry.premise.trim()) lines.push(`劇情簡介：${entry.premise.trim()}`);
    lines.push('', '===== 完整原文 =====');

    for (const message of [...messages].sort((a, b) => a.id - b.id)) {
        const speaker = message.role === 'user' ? userLabel : message.role === 'assistant' ? '劇場正文' : '系統';
        lines.push('', `[${formatStoryExportTime(message.timestamp)}] ${speaker}`, message.content?.trim() || '（無內容）');
    }
    return `\uFEFF${lines.join('\n')}`;
};

export const makeStoryTheaterFileName = (title: string, now: number = Date.now()): string => {
    const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名劇情';
    return `${safeTitle}_劇情記錄_${formatStoryExportTime(now).slice(0, 10)}.txt`;
};

export const createStoryTheaterDraft = (now: number = Date.now()): StoryTheaterEntry => ({
    id: makeStoryTheaterId(),
    title: '',
    premise: '',
    openingMode: 'user',
    mask: { type: 'user' },
    characterIds: [],
    npcIds: [],
    writesToCharacterMemory: false,
    characterMemoryDates: {},
    carryCharacterMemory: false,
    characterContextLimits: {},
    archiveAfter: 40,
    archiveKeepRecent: 5,
    archiveStrategy: 'summary',
    archives: [],
    selectedWorldbookIds: [],
    forceUserLastMessage: false,
    omitSamplingParams: false,
    createdAt: now,
    updatedAt: now,
});

/** 老數據/手改 JSON 的溫和補全；不改變已經選擇的沙盒開關。 */
export const normalizeStoryTheater = (entry: StoryTheaterEntry): StoryTheaterEntry => {
    const archiveAfter = Math.round(clampNumber(entry.archiveAfter, 2, 200, 40));
    const archiveKeepRecent = Math.round(clampNumber(entry.archiveKeepRecent, 1, Math.max(1, archiveAfter - 1), Math.min(5, archiveAfter - 1)));
    return {
        ...entry,
        title: String(entry.title || '未命名劇情'),
        premise: String(entry.premise || ''),
        openingMode: entry.openingMode === 'assistant' ? 'assistant' : 'user',
        mask: entry.writesToCharacterMemory ? { type: 'user' } : entry.mask?.type === 'character' && entry.mask.id
            ? { type: 'character', id: entry.mask.id }
            : entry.mask?.type === 'custom' && entry.mask.id
                ? { type: 'custom', id: entry.mask.id }
                : { type: 'user' },
        characterIds: Array.isArray(entry.characterIds) ? entry.characterIds.filter(Boolean) : [],
        npcIds: Array.isArray(entry.npcIds) ? entry.npcIds.filter(Boolean) : [],
        writesToCharacterMemory: entry.writesToCharacterMemory === true,
        characterMemoryDates: entry.characterMemoryDates || {},
        carryCharacterMemory: entry.writesToCharacterMemory ? true : entry.carryCharacterMemory !== false,
        characterContextLimits: entry.characterContextLimits || {},
        archiveAfter,
        archiveKeepRecent,
        archiveStrategy: entry.archiveStrategy === 'vector' ? 'vector' : 'summary',
        archives: Array.isArray(entry.archives) ? entry.archives : [],
        selectedWorldbookIds: Array.isArray(entry.selectedWorldbookIds) ? entry.selectedWorldbookIds.filter(Boolean) : [],
        presetId: /^builtin-night-screening-v\d/i.test(String(entry.presetId || '')) ? 'builtin-night-screening' : entry.presetId,
        presetOverride: entry.presetOverride?.schema === 'sullyos.story-preset' && Array.isArray(entry.presetOverride.prompts) ? entry.presetOverride : undefined,
        forceUserLastMessage: entry.forceUserLastMessage === true,
        omitSamplingParams: entry.omitSamplingParams === true,
        createdAt: Number(entry.createdAt) || Date.now(),
        updatedAt: Number(entry.updatedAt) || Number(entry.createdAt) || Date.now(),
    };
};

/**
 * 達到水位線後只歸檔最舊部分，並至少保留最近若干樓。
 * 如果切點正好落在“你的推進 / 劇場正文”之間，寧可多留一樓，也不拆散這一輪。
 */
export const selectStoryArchiveBatch = (
    rows: Message[],
    archiveAfter: number,
    keepRecent: number,
): Message[] => {
    const threshold = Math.max(2, Math.round(archiveAfter) || 40);
    if (rows.length < threshold) return [];
    const keep = Math.max(1, Math.min(threshold - 1, Math.round(keepRecent) || 5));
    const batch = rows.slice(0, Math.max(0, rows.length - keep));
    if (batch[batch.length - 1]?.role === 'user' && rows[batch.length]?.role === 'assistant') {
        batch.pop();
    }
    return batch;
};

export const createStoryTheaterMaskDraft = (now: number = Date.now()): StoryTheaterMask => ({
    id: makeStoryTheaterId(),
    name: '',
    description: '',
    coreInstruction: '',
    worldview: '',
    createdAt: now,
    updatedAt: now,
});

export const resolveStoryTheaterMask = (
    selection: StoryTheaterMaskSelection | undefined,
    user: UserProfile,
    characters: CharacterProfile[],
    masks: StoryTheaterMask[],
): ResolvedStoryTheaterMask => {
    if (selection?.type === 'character') {
        const char = characters.find(item => item.id === selection.id);
        if (char) return {
            selection,
            name: char.name,
            avatar: char.avatar,
            description: char.description || '',
            coreInstruction: char.systemPrompt || '',
            worldview: char.worldview || '',
            characterId: char.id,
        };
    }
    if (selection?.type === 'custom') {
        const mask = masks.find(item => item.id === selection.id);
        if (mask) return {
            selection,
            name: mask.name,
            avatar: mask.avatar,
            description: mask.description,
            coreInstruction: mask.coreInstruction,
            worldview: mask.worldview,
        };
    }
    return { selection: { type: 'user' }, name: user.name || '你', avatar: user.avatar, description: user.bio || '' };
};

const normalizeDocument = (value: any, fallbackName: string): StoryTheaterPresetDocument => {
    if (!value || value.schema !== 'sullyos.story-preset' || value.version !== 1 || !Array.isArray(value.prompts)) {
        throw new Error('不是受支持的糯米機劇情預設');
    }
    const prompts: StoryTheaterPresetPrompt[] = value.prompts.map((prompt: any, index: number) => ({
        id: String(prompt?.id || `prompt_${index + 1}`),
        name: String(prompt?.name || `提示詞 ${index + 1}`),
        enabled: prompt?.enabled !== false,
        role: normalizeRole(prompt?.role),
        content: String(prompt?.content || ''),
        ...(prompt?.section?.id && ['start', 'end'].includes(prompt.section.edge) ? {
            section: { id: String(prompt.section.id), name: String(prompt.section.name || '自定義分組'), edge: prompt.section.edge },
        } : {}),
        ...(NATIVE_MARKERS.includes(prompt?.marker) ? { marker: prompt.marker } : {}),
    }));
    if (prompts.length === 0) throw new Error('預設中沒有提示詞條目');
    return {
        schema: 'sullyos.story-preset',
        version: 1,
        name: String(value.name || fallbackName || '未命名劇情預設'),
        description: String(value.description || ''),
        generation: {
            temperature: clampNumber(value.generation?.temperature, 0, 2, 0.9),
            topP: clampNumber(value.generation?.topP, 0, 1, 1),
            frequencyPenalty: clampNumber(value.generation?.frequencyPenalty, -2, 2, 0),
            presencePenalty: clampNumber(value.generation?.presencePenalty, -2, 2, 0),
            maxTokens: Math.round(clampNumber(value.generation?.maxTokens, 256, 32000, 8000)),
        },
        prompts,
        assistantPrefill: String(value.assistantPrefill || ''),
    };
};

const NATIVE_MULTI_AFFINITY_PROMPT = [
    '啟用本條時，在每次回覆末尾輸出一個“多角色雙向關係溫度”面板。每位參與角色都擁有彼此隔離的 C→U、U→C 與五維關係混音；禁止把多人壓成單一“當前 C”，也不得共享或平均任何數值。',
    '',
    '【逐角色雙向記帳】',
    '- 從最近一次 <affinity_panel> 按 character_id 讀取每位角色自己的完整記錄；首次出現且沒有舊記錄時，C→U 與 U→C 均從 50 開始，五個維度依據角色卡與已經發生的共同經歷建立。',
    '- C→U 是該角色對用戶側角色的總體關係溫度，只隨已經落地且屬於這兩人的關係事實變化。普通回合約 -3 至 +3，重大事實可至 -8 至 +8；沒有新事實時保持原值並記 +0。',
    '- trust、security、possessive_pull、emotional_pressure、repair_will 都是 0—100 的獨立維度，記錄力量怎樣運作，不直接命令角色採取行為。高佔有與真心同時存在時應形成對向拉扯，不把二者相加成更強的控制。',
    '- 最新用戶消息可能包含 <u_affinity_updates>；只按 character_id 更新匹配角色的 U→C。某角色沒有本輪更新時保持原值，delta 為 +0，原因寫“本輪未填寫”；不得依據正文替用戶自行升降。',
    '- awareness 只決定對應角色是否明確知道用戶→自己的準確數值變化與原因；其他角色不得共享這份透視。C→U 與五維狀態仍由該角色自己的事實、能力、處境與情緒潮線決定。',
    '- U→C 向下時，把 reason 當作執筆人的閱讀體驗燈號：回到角色動機與現場因果中尋找符合人物的修復入口，但不把角色寫成討好數值的攻略對象。',
    '',
    '【正文權限】',
    '- 數值只作為連續性底座，不能覆蓋角色卡、世界事實、執筆權、同意邊界或人物原有目標；95—100 後仍通過關係天氣、維度消長、選擇代價與關係碎片表現變化。',
    '- 未察覺的 U→C 更新只作為低權重敘事背景；已察覺時由對應角色在本輪作出符合性格與現場節拍的反應，但不照念 XML 或系統數字。',
    '',
    '【輸出】',
    '用一個 <affinity_panel> 包住全部參與角色，並嚴格按角色資料順序為每人輸出：',
    '<affinity_person>',
    '<character_id>角色 ID</character_id>',
    '<character_name>角色名</character_name>',
    '<c_to_u_score>50</c_to_u_score>',
    '<c_to_u_delta>+0</c_to_u_delta>',
    '<c_to_u_note>改變該角色 C→U 的本輪事實；沒有則寫“本輪無新事實”</c_to_u_note>',
    '<u_to_c_score>50</u_to_c_score>',
    '<u_to_c_delta>+0</u_to_c_delta>',
    '<u_to_c_note>用戶填寫的原因；沒有則寫“本輪未填寫”</u_to_c_note>',
    '<awareness_state>已察覺或未察覺</awareness_state>',
    '<trust>50</trust>',
    '<security>50</security>',
    '<possessive_pull>50</possessive_pull>',
    '<emotional_pressure>50</emotional_pressure>',
    '<repair_will>50</repair_will>',
    '<state_note>本輪最明顯的內部拉扯、選擇代價或修復動作</state_note>',
    '<relation_note>這一段關係當前的具體質地</relation_note>',
    '<relation_fragment>可選的一條短關係碎片</relation_fragment>',
    '</affinity_person>',
    '按角色繼續排列，最後閉合 </affinity_panel>。每位角色必須恰好一段；不輸出舊版根級 c_score / u_score 單槽字段。',
].join('\n');

/**
 * V6.14 原稿把幕後暗格與鏡頭債拆成兩個開關。糯米機把它們視為同一個
 * “幕後與餘波”模塊：提示詞在同一位置發送，兩個協議塊連續輸出，界面也只
 * 展示一個摺疊區。保留原 id 作為關閉的遷移佔位，舊沙盒覆蓋仍可被運行時提醒兼容。
 */
const replacePromptLine = (content: string, startsWith: string, replacement: string): string => content
    .split('\n')
    .map(line => line.startsWith(startsWith) ? replacement : line)
    .join('\n');

const mergeNightScreeningBackstageAndDebts = (document: StoryTheaterPresetDocument): StoryTheaterPresetDocument => {
    const backstage = document.prompts.find(prompt => prompt.id === 'nmj-v48-backstage');
    const debts = document.prompts.find(prompt => prompt.id === 'nmj-v61-shot-debts');
    if (!backstage || !debts) return document;
    const orderedPrompts = [...document.prompts];
    const startupStartIndex = orderedPrompts.findIndex(prompt => prompt.id === 'nmj-v64-section-startup-start');
    const firstStartupPromptIndex = orderedPrompts.findIndex(prompt => prompt.id === 'nmj-v3-user-shell');
    if (startupStartIndex > firstStartupPromptIndex && firstStartupPromptIndex >= 0) {
        const [sectionStart] = orderedPrompts.splice(startupStartIndex, 1);
        orderedPrompts.splice(firstStartupPromptIndex, 0, sectionStart);
    }
    const debtContent = debts.content.replace(
        /^在正文、(?:幕[后後])?暗格和世界[线線][后後]，/,
        '緊接 </backstage> 後，',
    );
    return {
        ...document,
        prompts: orderedPrompts.map(originalPrompt => {
            const prompt = {
                ...originalPrompt,
                name: originalPrompt.name.replace(/[双雙]向(?:好感|[温溫]度)/g, '多角色雙向關係溫度'),
                content: originalPrompt.content.replace(/[双雙]向(?:好感|[温溫]度)/g, '多角色雙向關係溫度'),
            };
            if (prompt.id === 'nmj-v65-affinity-control') return {
                ...prompt,
                name: '💗多角色雙向關係溫度｜逐人五維｜默認開啟',
                content: NATIVE_MULTI_AFFINITY_PROMPT,
            };
            if (prompt.id === backstage.id) return {
                ...prompt,
                name: '🗝️幕後與餘波｜心境·秘密·真話·鏡頭債｜默認開啟',
                content: `${backstage.content}\n\n# 同一摺疊模塊：鏡頭債\n${debtContent}`,
            };
            if (prompt.id === debts.id) return {
                ...prompt,
                name: '↳ 鏡頭債已併入「幕後與餘波」',
                enabled: false,
                content: '',
            };
            if (prompt.id === 'nsfw' || prompt.id === 'jailbreak') return {
                ...prompt,
                name: `${prompt.name}｜空連接位已停用`,
                enabled: false,
            };
            if (prompt.id === 'nmj-v3-scene-header') return {
                ...prompt,
                content: replacePromptLine(
                    prompt.content,
                    '正文結束後，依次輸出',
                    '正文結束後，依次輸出已啟用的“幕後與餘波”（幕後暗格後緊接鏡頭債）、世界線、小劇場、回覆選項和多角色雙向關係溫度。',
                ),
            };
            if (prompt.id === 'nmj-v616-silent-preflight') return {
                ...prompt,
                name: '🎬開拍前｜靜默排片檢查｜常駐',
                content: replacePromptLine(
                    replacePromptLine(
                        prompt.content,
                        '正文前完成一次排片思考。',
                        '正文前靜默完成一次排片檢查；只把結論落實到成品，不輸出分析、檢查過程或隱藏推理。',
                    ),
                    '6. 關係側表：',
                    '6. 關係側表：按 character_id 逐人續接 C→U、U→C 與五維關係混音；每位角色只讀取自己的事實和用戶對自己的更新。高溫度與高佔有形成選擇拉扯，不放大成控制；U→C 向下時為對應角色尋找符合人物的修復入口；',
                ).replace('導演層理解執筆燈號，角色層只接觸故事內信號；', '生成規則讀取執筆燈號，故事人物只接觸其可知的故事內信號；'),
            };
            if (prompt.id === 'nmj-v3-exit-check') return {
                ...prompt,
                content: replacePromptLine(
                    replacePromptLine(
                        prompt.content,
                        '- 人物行動來自生活線、情緒潮線與關係側表的合力；',
                        '- 人物行動來自生活線、情緒潮線與逐角色關係側表的合力；每位角色按 character_id 獨立續接 C→U、U→C 與五維狀態，角色之間沒有共享數值或察覺狀態。C→U 只隨該角色親歷的關係事實變化，U→C 只讀取用戶對該角色的最新更新；高真心與高佔有形成對向選擇代價，不共同放大控制；U→C 向下時，正文已有符合該角色自身動機的修復入口；',
                    ),
                    '- 正文後的材料已按散場分流',
                    '- 正文後的材料已按散場分流進入唯一且最貼近的片盒：幕後與餘波收人物內層材料及未到帳後果，世界線收鏡頭外實變，小劇場收非正篇折射，多角色雙向關係溫度逐人記帳；各區提供新材料。輸出順序為：場景條 → 正文 → 幕後與餘波（幕後暗格 → 鏡頭債）→ 世界線 → 已啟用的小劇場 → 已啟用的回覆選項 → 已啟用的多角色雙向關係溫度；',
                ),
            };
            if (prompt.id === 'nmj-v64-section-output-start') return {
                ...prompt,
                name: '🧩↓附加輸出｜格式／場景條／幕後與餘波／世界線',
            };
            if (prompt.id === 'nmj-v3-theater-ai') return {
                ...prompt,
                name: '💬小劇場｜角色與你聊天',
                content: [
                    '在 </story_text> 之後追加一段非正篇聊天：讓當前最合適的角色與你以當前身份對話，可以求助、爭辯、投訴或一本正經地問錯問題。寫 4—8 個短氣泡，讓你和角色至少發生一次理解錯位。默認不改變正篇事實。',
                    '',
                    '嚴格使用：',
                    '<mini_theater>',
                    '<mt_title>小劇場標題</mt_title>',
                    '<mt_system>很短的界面提示，可省略</mt_system>',
                    '<mt_ai><name>你的名字</name><text>你的消息</text></mt_ai>',
                    '<mt_user><name>角色名</name><text>角色消息</text></mt_user>',
                    '按需要繼續排列。',
                    '</mini_theater>',
                ].join('\n'),
            };
            if (prompt.id === 'nmj-v3-theater-user-sim') return {
                ...prompt,
                name: '🪞小劇場｜角色與你的倒影私聊',
                content: [
                    '在 </story_text> 之後追加一段非正篇聊天：某個角色與你的虛構倒影交談。這道倒影必須標為“{{user}}的倒影”；它不是實際的你，不代表你的真實思想、決定或未來行為。趣味來自角色如何試探這道倒影，又怎樣被自己的錯誤假設反噬。寫 4—8 個氣泡。',
                    '',
                    '嚴格使用：',
                    '<mini_theater>',
                    '<mt_title>小劇場標題</mt_title>',
                    '<mt_system>倒影只依據角色提供的信息回應</mt_system>',
                    '<mt_ai><name>{{user}}的倒影</name><text>倒影消息</text></mt_ai>',
                    '<mt_user><name>角色名</name><text>角色消息</text></mt_user>',
                    '按需要繼續排列。',
                    '</mini_theater>',
                ].join('\n'),
            };
            if (prompt.id === 'nmj-v3-theater-group') return {
                ...prompt,
                name: '👥小劇場｜你和角色們群聊',
                content: [
                    '在 </story_text> 之後追加一段非正篇群聊。選擇 2—4 個當前合適的角色，再讓你以當前身份加入。寫 5—10 個短氣泡，讓不同打字習慣互相撞壞一次正題。默認不改變正篇事實。',
                    '',
                    '嚴格使用：',
                    '<mini_theater>',
                    '<mt_title>群聊名稱</mt_title>',
                    '<mt_system>群聊提示，可省略</mt_system>',
                    '<mt_ai><name>你的名字或角色名</name><text>消息</text></mt_ai>',
                    '<mt_user><name>角色名或你的名字</name><text>消息</text></mt_user>',
                    '按需要繼續排列。',
                    '</mini_theater>',
                ].join('\n'),
            };
            return prompt;
        }),
    };
};

export const BUILTIN_NIGHT_SCREENING_PRESET: StoryTheaterPreset = {
    id: 'builtin-night-screening',
    name: '糯米雞｜夜班放映室 V6.27',
    format: 'sullyos-story-preset',
    document: mergeNightScreeningBackstageAndDebts(normalizeDocument(nightScreeningV627, '糯米雞｜夜班放映室 V6.27')),
    builtIn: true,
    createdAt: 0,
    updatedAt: 0,
};

export const withBuiltInStoryPresets = (presets: StoryTheaterPreset[]): StoryTheaterPreset[] => [
    BUILTIN_NIGHT_SCREENING_PRESET,
    ...presets.filter(preset => !preset.id.startsWith('builtin-night-screening')),
];

/**
 * 快捷設置歷史上保存的是整份內置文檔。升級內置預設時只繼承同 ID 條目的
 * 開關選擇，正文與新增模塊始終使用最新版；自建預設仍完整保留用戶內容。
 */
export const resolveStoryPresetDocument = (
    preset: StoryTheaterPreset,
    override?: StoryTheaterPresetDocument,
): StoryTheaterPresetDocument => {
    if (!override) return preset.document;
    if (!preset.builtIn) return override;
    const enabledById = new Map(override.prompts.map(prompt => [prompt.id, prompt.enabled]));
    return {
        ...preset.document,
        prompts: preset.document.prompts.map(prompt => enabledById.has(prompt.id)
            ? { ...prompt, enabled: enabledById.get(prompt.id) === true }
            : prompt),
    };
};

export const parseStoryTheaterPreset = (rawText: string, sourceFileName: string, now: number = Date.now()): StoryTheaterPreset => {
    if (rawText.length > 5 * 1024 * 1024) throw new Error('預設超過 5 MB，請先移除內嵌素材或腳本數據');
    let data: Record<string, any>;
    try { data = JSON.parse(rawText); } catch { throw new Error('不是有效的 JSON 預設'); }
    const fileBase = sourceFileName.replace(/\.json$/i, '').trim() || '導入預設';
    if (data.schema !== 'sullyos.story-preset') throw new Error('只接受糯米機劇情預設（schema: sullyos.story-preset）');
    const document = normalizeDocument(data, fileBase);
    return { id: makeStoryTheaterId(), name: document.name, sourceFileName, format: 'sullyos-story-preset', document, createdAt: now, updatedAt: now };
};

export const createBlankStoryPreset = (name = '新劇情預設', now = Date.now()): StoryTheaterPreset => ({
    id: makeStoryTheaterId(), name, format: 'sullyos-story-preset', createdAt: now, updatedAt: now,
    document: {
        schema: 'sullyos.story-preset', version: 1, name,
        generation: { temperature: 0.9, topP: 1, frequencyPenalty: 0, presencePenalty: 0, maxTokens: 8000 },
        prompts: [
            { id: makeStoryTheaterId(), name: '主敘事規則', enabled: true, role: 'system', content: '直接續寫連續的第三人稱故事，讓人物保持獨立動機與知識邊界。' },
            { id: makeStoryTheaterId(), name: '世界書 · 角色設定前', enabled: true, role: 'system', content: '', marker: 'world_before' },
            { id: makeStoryTheaterId(), name: '角色資料', enabled: true, role: 'system', content: '', marker: 'characters' },
            { id: makeStoryTheaterId(), name: '世界書', enabled: true, role: 'system', content: '', marker: 'world_after' },
            { id: makeStoryTheaterId(), name: '劇情設定', enabled: true, role: 'system', content: '', marker: 'scenario' },
            { id: makeStoryTheaterId(), name: '聊天歷史', enabled: true, role: 'system', content: '', marker: 'history' },
        ],
    },
});

export const duplicateStoryPreset = (preset: StoryTheaterPreset, now = Date.now()): StoryTheaterPreset => {
    const name = `${preset.name} · 副本`;
    return { ...preset, id: makeStoryTheaterId(), name, builtIn: false, sourceFileName: undefined, document: { ...preset.document, name, prompts: preset.document.prompts.map(prompt => ({ ...prompt })) }, createdAt: now, updatedAt: now };
};

export const getPresetPromptStats = (preset?: StoryTheaterPreset | null): { total: number; enabled: number; scripts: number } => {
    if (!preset) return { total: 0, enabled: 0, scripts: 0 };
    return { total: preset.document.prompts.length, enabled: preset.document.prompts.filter(prompt => prompt.enabled).length, scripts: 0 };
};

export interface StoryPresetPromptGroup {
    key: string;
    label: string;
    description: string;
    promptIds: string[];
    startIndex: number;
    endIndex: number;
    protected: boolean;
    customSectionId?: string;
}

const STORY_PRESET_GROUP_SPECS = [
    { key: 'startup', label: '頂部啟動框架', description: '破甲、虛構框架、續航與主敘事底座', start: 'nmj-v64-section-startup-start', end: 'nmj-v64-section-startup-end' },
    { key: 'input', label: '輸入處理', description: '長片意識、轉述、回放與即時接戲', start: 'nmj-v64-section-input-start', end: 'nmj-v64-section-input-end' },
    { key: 'sources', label: '角色與世界', description: '角色卡、世界書、你的身份、場景、示例與歷史', start: 'nmj-v64-section-sources-start', end: 'nmj-v64-section-sources-end', protected: true },
    { key: 'story', label: '人物與劇情', description: '人物發動機、證據門、推進、對白與糾偏', start: 'nmj-v64-section-story-start', end: 'nmj-v64-section-story-end' },
    { key: 'tone', label: '文風與張力', description: '文風、場景張力、親密鏡頭與疊加仲裁', start: 'nmj-v64-section-style-start', end: 'nmj-v64-section-arbitration-end' },
    { key: 'camera', label: '鏡頭與關係', description: '人稱、執筆權與多角色 U→C 關係溫度', start: 'nmj-v64-section-camera-start', end: 'nmj-v65-section-affinity-end' },
    { key: 'output', label: '語言與輸出', description: '語言、篇幅、場景條、幕後與餘波、世界線', start: 'nmj-v64-section-language-start', end: 'nmj-v64-section-output-end' },
    { key: 'extras', label: '幕間與選項', description: '小劇場、邊角頻道與回覆方向', start: 'nmj-v64-section-theater-start', end: 'nmj-v64-section-choices-end' },
    { key: 'exit', label: '出口與收尾', description: '出口檢查、核心續寫與定義增強', start: 'nmj-v64-section-exit-start', end: 'enhanceDefinitions' },
] as const;

export const isStoryPresetSectionMarker = (prompt: StoryTheaterPresetPrompt): boolean => Boolean(prompt.section) || /^nmj-v6[45]-section-.+-(start|end)$/.test(prompt.id);

export const isProtectedStoryPrompt = (prompt: StoryTheaterPresetPrompt): boolean => Boolean(
    prompt.marker || prompt.id === 'nmj-v64-section-sources-start' || prompt.id === 'nmj-v64-section-sources-end'
    || ['charDescription', 'charPersonality', 'worldInfoBefore', 'personaDescription', 'worldInfoAfter', 'scenario', 'dialogueExamples', 'chatHistory'].includes(prompt.id)
);

export const getStoryPresetPromptGroups = (document: StoryTheaterPresetDocument): StoryPresetPromptGroup[] => {
    const prompts = document.prompts;
    const claimed = new Set<number>();
    const groups: StoryPresetPromptGroup[] = [];
    for (const spec of STORY_PRESET_GROUP_SPECS) {
        const startIndex = prompts.findIndex(prompt => prompt.id === spec.start);
        const endIndex = prompts.findIndex(prompt => prompt.id === spec.end);
        if (startIndex < 0 || endIndex < startIndex || claimed.has(startIndex) || claimed.has(endIndex)) continue;
        const indexes = Array.from({ length: endIndex - startIndex + 1 }, (_, offset) => startIndex + offset);
        indexes.forEach(index => claimed.add(index));
        groups.push({
            key: spec.key,
            label: spec.label,
            description: spec.description,
            promptIds: indexes.map(index => prompts[index].id),
            startIndex,
            endIndex,
            protected: 'protected' in spec && spec.protected === true,
        });
    }
    for (let startIndex = 0; startIndex < prompts.length; startIndex++) {
        const section = prompts[startIndex].section;
        if (section?.edge !== 'start' || claimed.has(startIndex)) continue;
        const endIndex = prompts.findIndex((prompt, index) => index > startIndex && prompt.section?.id === section.id && prompt.section.edge === 'end');
        if (endIndex < 0 || prompts.slice(startIndex + 1, endIndex).some(prompt => prompt.section) || Array.from({ length: endIndex - startIndex + 1 }, (_, offset) => startIndex + offset).some(index => claimed.has(index))) continue;
        const indexes = Array.from({ length: endIndex - startIndex + 1 }, (_, offset) => startIndex + offset);
        indexes.forEach(index => claimed.add(index));
        groups.push({ key: `section:${section.id}`, label: section.name, description: '自定義分組 · 可添加提示詞、調整順序', promptIds: indexes.map(index => prompts[index].id), startIndex, endIndex, protected: false, customSectionId: section.id });
    }
    let cursor = 0;
    while (cursor < prompts.length) {
        if (claimed.has(cursor)) { cursor += 1; continue; }
        const startIndex = cursor;
        while (cursor + 1 < prompts.length && !claimed.has(cursor + 1)) cursor += 1;
        const endIndex = cursor;
        groups.push({
            key: `custom:${prompts[startIndex]?.id || startIndex}`,
            label: '自定義條目',
            description: '沒有歸入內置區間的自定義提示詞',
            promptIds: prompts.slice(startIndex, endIndex + 1).map(prompt => prompt.id),
            startIndex,
            endIndex,
            protected: false,
        });
        cursor += 1;
    }
    return groups.sort((a, b) => a.startIndex - b.startIndex);
};

export const addStoryPresetGroup = (document: StoryTheaterPresetDocument, name: string): StoryTheaterPresetDocument => {
    const id = makeStoryTheaterId();
    return { ...document, prompts: [...document.prompts, ...(['start', 'end'] as const).map(edge => ({
        id: makeStoryTheaterId(), name: name.trim() || '自定義分組', enabled: false, role: 'system' as const, content: '',
        section: { id, name: name.trim() || '自定義分組', edge },
    }))] };
};

export const renameStoryPresetGroup = (document: StoryTheaterPresetDocument, sectionId: string, name: string): StoryTheaterPresetDocument => ({
    ...document, prompts: document.prompts.map(prompt => prompt.section?.id === sectionId
        ? { ...prompt, section: { ...prompt.section, name } } : prompt),
});

export const ungroupStoryPresetGroup = (document: StoryTheaterPresetDocument, sectionId: string): StoryTheaterPresetDocument => ({
    ...document, prompts: document.prompts.filter(prompt => prompt.section?.id !== sectionId),
});

export const moveStoryPresetPromptToGroup = (document: StoryTheaterPresetDocument, promptId: string, groupKey: string): StoryTheaterPresetDocument => {
    const groups = getStoryPresetPromptGroups(document);
    const source = groups.find(group => group.promptIds.includes(promptId));
    const target = groups.find(group => group.key === groupKey);
    const prompt = document.prompts.find(item => item.id === promptId);
    if (!prompt || !target || target.protected || source?.protected || source?.key === target.key || isProtectedStoryPrompt(prompt) || isStoryPresetSectionMarker(prompt)) return document;
    const next = { ...document, prompts: document.prompts.filter(item => item.id !== promptId) };
    const destination = getStoryPresetPromptGroups(next).find(group => group.key === groupKey);
    if (!destination) return document;
    const last = next.prompts[destination.endIndex];
    next.prompts.splice(isStoryPresetSectionMarker(last) ? destination.endIndex : destination.endIndex + 1, 0, prompt);
    return next;
};

export const applyStoryPresetChoice = (
    document: StoryTheaterPresetDocument,
    optionIds: readonly string[],
    selectedId?: string,
): StoryTheaterPresetDocument => ({
    ...document,
    prompts: document.prompts.map(prompt => optionIds.includes(prompt.id) ? { ...prompt, enabled: prompt.id === selectedId } : prompt),
});

const macroReplace = (text: string, userName: string, characterNames: string[]): string => text
    .replace(/\{\{user\}\}/gi, userName || '你')
    .replace(/\{\{char\}\}/gi, characterNames.join('、') || '角色')
    .replace(/\{\{group\}\}/gi, characterNames.join('、') || '角色');

export const STORY_MINI_THEATER_PROMPT_IDS = [
    'nmj-v3-theater-ai',
    'nmj-v3-theater-user-sim',
    'nmj-v3-theater-group',
    'nmj-v3-theater-random',
    'nmj-v6-side-channel-terminal',
    'nmj-v6-side-channel-evidence',
    'nmj-v6-side-channel-public',
    'nmj-v6-side-channel-wrong-reel',
    'nmj-v3-theater-custom',
] as const;

export const getActiveStoryMiniTheaterPrompt = (document: StoryTheaterPresetDocument): StoryTheaterPresetPrompt | undefined => {
    const ids = new Set<string>(STORY_MINI_THEATER_PROMPT_IDS);
    return document.prompts.find(prompt => prompt.enabled && ids.has(prompt.id));
};

/** 將當前沙盒啟用的小劇場規則重複放到本輪輸入前，避免被較後的輸出協議忽略。 */
export const buildStoryMiniTheaterReminder = (
    document: StoryTheaterPresetDocument,
    userName: string,
    characterNames: string[],
): string => {
    const prompt = getActiveStoryMiniTheaterPrompt(document);
    if (!prompt?.content.trim()) return '';
    return [
        `### 本輪結尾模塊：${prompt.name}`,
        '這一模塊已經由用戶在本劇情的快捷預設中啟用。本輪必須在主正文之後完整執行，不得因其它輸出規則而省略。',
        '格式守門：每個 <mt_ai> / <mt_user> 內都必須同時寫出一組完整的 <name> 與 <text>，閉合所有標籤；不得把“… / ... / 按需要繼續排列”等示例佔位符當成實際消息輸出。',
        macroReplace(prompt.content, userName, characterNames),
        '無論上方條目是完整模板還是簡寫說明，最終都必須使用這個可渲染外殼：',
        '<mini_theater>',
        '<mt_title>本輪實際標題</mt_title>',
        '<mt_system>可省略的短界面提示</mt_system>',
        '<mt_ai><name>左側顯示名</name><text>完整消息</text></mt_ai>',
        '<mt_user><name>右側顯示名</name><text>完整消息</text></mt_user>',
        '</mini_theater>',
    ].join('\n');
};

/** 兼容舊沙盒覆蓋：只要暗格或鏡頭債任一開關仍在，就統一為連續的組合模塊。 */
export const buildStoryBackstageAftermathReminder = (document: StoryTheaterPresetDocument): string => {
    const backstage = document.prompts.find(prompt => prompt.id === 'nmj-v48-backstage');
    const legacyDebts = document.prompts.find(prompt => prompt.id === 'nmj-v61-shot-debts');
    const backstageEnabled = backstage?.enabled === true;
    const debtsEnabled = legacyDebts?.enabled === true || Boolean(backstageEnabled && backstage?.content.includes('<shot_debts>'));
    if (!backstageEnabled && !debtsEnabled) return '';
    return [
        '### 本輪組合模塊：幕後與餘波',
        '幕後暗格與鏡頭債在糯米機中屬於同一個摺疊模塊，不得拆成相隔很遠的兩個結尾區，也不得重複生成。',
        backstageEnabled ? '- 正文結束後輸出一組完整且閉合的 <backstage>；心境、秘密與稀有真話都按已啟用預設執行。' : '',
        debtsEnabled ? '- 緊接 </backstage>（若暗格關閉則緊接正文）輸出一組完整且閉合的 <shot_debts>；之後才輸出世界線、小劇場、選項和關係溫度。' : '',
        '- 兩組原始標籤仍分別保留用於穩定解析，但界面只顯示一個“幕後與餘波”摺疊區。',
    ].filter(Boolean).join('\n');
};

const escapeStoryXml = (value: string): string => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/** 關係備註只隨本輪用戶輸入送入模型，不混進可見正文。 */
export const appendStoryAffinityInput = (content: string, input?: StoryAffinityInput): string => {
    if (!input) return content;
    const delta = Math.max(-100, Math.min(100, Math.round(Number(input.delta) || 0)));
    const reason = String(input.reason || '').trim().slice(0, 200);
    if (delta === 0 && !reason) return content;
    const signed = delta >= 0 ? `+${delta}` : String(delta);
    const awareness = input.awareness === 'noticed' ? 'noticed' : 'unnoticed';
    return `${content}\n\n<u_affinity>\n<delta>${signed}</delta>\n<reason>${escapeStoryXml(reason || '未填寫原因')}</reason>\n<awareness>${awareness}</awareness>\n</u_affinity>`;
};

/** 多人劇場使用帶角色身份的獨立 U→C 更新，禁止把幾位角色共用成一個槽。 */
export const appendStoryAffinityInputs = (content: string, inputs: StoryAffinityInput[]): string => {
    const rows = inputs.map(input => {
        const delta = Math.max(-100, Math.min(100, Math.round(Number(input.delta) || 0)));
        const reason = String(input.reason || '').trim().slice(0, 200);
        if (delta === 0 && !reason) return '';
        const signed = delta >= 0 ? `+${delta}` : String(delta);
        const awareness = input.awareness === 'noticed' ? 'noticed' : 'unnoticed';
        return [
            '<u_affinity>',
            `<character_id>${escapeStoryXml(String(input.characterId || ''))}</character_id>`,
            `<character_name>${escapeStoryXml(String(input.characterName || '當前角色'))}</character_name>`,
            `<delta>${signed}</delta>`,
            `<reason>${escapeStoryXml(reason || '未填寫原因')}</reason>`,
            `<awareness>${awareness}</awareness>`,
            '</u_affinity>',
        ].join('\n');
    }).filter(Boolean);
    if (rows.length === 0) return content;
    return `${content}\n\n<u_affinity_updates>\n${rows.join('\n')}\n</u_affinity_updates>`;
};

interface StoryAffinityScoreState {
    cToU: number;
    uToC: number;
}

const affinityTagValue = (source: string, tag: string): string => (
    new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'i').exec(source)?.[1]?.replace(/<[^>]+>/g, '').trim() || ''
);

const affinityInteger = (value: unknown, fallback: number): number => {
    const parsed = Number(String(value ?? '').replace(/[^+\d.-]/g, ''));
    return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
};

const clampAffinityScore = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));
const clampAffinityDelta = (value: number): number => Math.max(-100, Math.min(100, Math.round(value)));
const affinityIdentityKey = (value: string): string => value.trim().toLocaleLowerCase().normalize('NFKC');

const setAffinityTagValue = (source: string, tag: string, value: string): string => {
    const pattern = new RegExp(`(<${tag}\\b[^>]*>)[\\s\\S]*?(<\\/${tag}\\s*>)`, 'i');
    if (pattern.test(source)) return source.replace(pattern, `$1${value}$2`);
    return `${source.trimEnd()}\n<${tag}>${value}</${tag}>`;
};

const readAffinityScoreStates = (
    content: string,
    actors: Array<{ id: string; name: string }>,
): Map<string, StoryAffinityScoreState> => {
    const states = new Map<string, StoryAffinityScoreState>();
    const personPattern = /<affinity_person\b[^>]*>([\s\S]*?)<\/affinity_person\s*>/gi;
    for (const match of content.matchAll(personPattern)) {
        const body = match[1];
        const state = {
            cToU: clampAffinityScore(affinityInteger(affinityTagValue(body, 'c_to_u_score'), 50)),
            uToC: clampAffinityScore(affinityInteger(affinityTagValue(body, 'u_to_c_score'), 50)),
        };
        const id = affinityIdentityKey(affinityTagValue(body, 'character_id'));
        const name = affinityIdentityKey(affinityTagValue(body, 'character_name'));
        if (id) states.set(`id:${id}`, state);
        if (name) states.set(`name:${name}`, state);
    }
    // 兼容升級前的單角色根級面板；多人時絕不猜這一個舊槽屬於誰。
    if (states.size === 0 && actors.length === 1) {
        const cScore = affinityTagValue(content, 'c_score');
        const uScore = affinityTagValue(content, 'u_score');
        if (cScore || uScore) {
            const state = {
                cToU: clampAffinityScore(affinityInteger(cScore, 50)),
                uToC: clampAffinityScore(affinityInteger(uScore, 50)),
            };
            states.set(`id:${affinityIdentityKey(actors[0].id)}`, state);
            states.set(`name:${affinityIdentityKey(actors[0].name)}`, state);
        }
    }
    return states;
};

/**
 * 模型只決定“本輪變化多少”，絕對值由前端按上一輪 + delta 復算。
 * 這樣 U→C 的用戶輸入與 C→U 的模型變化都不會再依賴 LLM 心算。
 */
export const reconcileStoryAffinityScores = (
    generated: string,
    previousAssistantContent: string,
    inputs: StoryAffinityInput[],
    actors: Array<{ id: string; name: string }>,
): string => {
    const previous = readAffinityScoreStates(previousAssistantContent, actors);
    const actorById = new Map(actors.map(actor => [affinityIdentityKey(actor.id), actor]));
    const actorByName = new Map(actors.map(actor => [affinityIdentityKey(actor.name), actor]));
    const inputById = new Map(inputs.filter(input => input.characterId).map(input => [affinityIdentityKey(input.characterId || ''), input]));
    const inputByName = new Map(inputs.filter(input => input.characterName).map(input => [affinityIdentityKey(input.characterName || ''), input]));
    const personPattern = /(<affinity_person\b[^>]*>)([\s\S]*?)(<\/affinity_person\s*>)/gi;

    return generated.replace(personPattern, (_whole, opening: string, rawBody: string, closing: string) => {
        const rawId = affinityIdentityKey(affinityTagValue(rawBody, 'character_id'));
        const rawName = affinityIdentityKey(affinityTagValue(rawBody, 'character_name'));
        const actor = actorById.get(rawId) || actorByName.get(rawName);
        const id = affinityIdentityKey(actor?.id || rawId);
        const name = affinityIdentityKey(actor?.name || rawName);
        const prior = previous.get(`id:${id}`) || previous.get(`name:${name}`) || { cToU: 50, uToC: 50 };
        const input = inputById.get(id) || inputByName.get(name);
        const cDelta = clampAffinityDelta(affinityInteger(affinityTagValue(rawBody, 'c_to_u_delta'), 0));
        const uDelta = clampAffinityDelta(input?.delta == null ? 0 : affinityInteger(input.delta, 0));
        const cScore = clampAffinityScore(prior.cToU + cDelta);
        const uScore = clampAffinityScore(prior.uToC + uDelta);
        let body = rawBody;
        body = setAffinityTagValue(body, 'c_to_u_score', String(cScore));
        body = setAffinityTagValue(body, 'c_to_u_delta', cDelta >= 0 ? `+${cDelta}` : String(cDelta));
        body = setAffinityTagValue(body, 'u_to_c_score', String(uScore));
        body = setAffinityTagValue(body, 'u_to_c_delta', uDelta >= 0 ? `+${uDelta}` : String(uDelta));
        return `${opening}${body}${closing}`;
    });
};

export const buildStoryMultiAffinityGuide = (characters: Array<{ id: string; name: string }>): string => {
    if (characters.length === 0) return '';
    const cast = characters.map(character => `- ${character.id}：${character.name}`).join('\n');
    return [
        '### 糯米機多人雙向關係溫度（覆蓋舊的單一“當前 C”槽）',
        '本劇場為每一位角色分別記錄 C→U、U→C、五維關係混音、察覺狀態與關係質地。禁止共享數值、串用事實、平均多人狀態或只輸出第一位角色。',
        '當前需要逐一維護的角色：',
        cast,
        '',
        '【更新】',
        '- 從最近一次多人 <affinity_panel> 中按 character_id 讀取各自完整狀態；沒有舊記錄時，該角色的 C→U、U→C 從 50 開始，五維依據角色卡與共同經歷建立。舊歷史只有單人面板時，只能遷移給姓名明確匹配的角色。',
        '- C→U 與 trust、security、possessive_pull、emotional_pressure、repair_will 只讀取對應角色的親歷事實、性格、處境與後果；不得用某個角色的變化影響另一位角色。',
        '- 最新 <u_affinity_updates> 只出現本輪由用戶填寫變化的角色。某角色沒有對應更新時，其 U→C 絕對值保持不變，delta 記 +0，原因寫“本輪未填寫”。',
        '- U→C 新值 = 該角色上一輪 U→C + 對應 delta，並限制在 0—100。不得用某個角色的變化影響另一位角色。',
        '- 你只需正確決定每個 delta；前端會依據上一輪絕對值復算 C→U 與 U→C score，防止心算錯誤。',
        '- 察覺規則只作用於同一條 u_affinity 指向的角色；其他角色不會因為同伴被選擇為“已察覺”而共享透視。',
        '',
        '【輸出】',
        '用一個 <affinity_panel> 包住全部角色，並嚴格按當前角色名單順序為每人輸出一段：',
        '<affinity_person>',
        '<character_id>角色 ID</character_id>',
        '<character_name>角色名</character_name>',
        '<c_to_u_score>50</c_to_u_score>',
        '<c_to_u_delta>+0</c_to_u_delta>',
        '<c_to_u_note>改變角色 C→U 的本輪事實</c_to_u_note>',
        '<u_to_c_score>50</u_to_c_score>',
        '<u_to_c_delta>+0</u_to_c_delta>',
        '<u_to_c_note>用戶填寫的原因；沒有則寫“本輪未填寫”</u_to_c_note>',
        '<awareness_state>已察覺或未察覺</awareness_state>',
        '<trust>50</trust><security>50</security><possessive_pull>50</possessive_pull>',
        '<emotional_pressure>50</emotional_pressure><repair_will>50</repair_will>',
        '<state_note>最明顯的內部拉扯、選擇代價或修復動作</state_note>',
        '<relation_note>這一段雙向關係當前的質地</relation_note>',
        '<relation_fragment>可選的一條具體關係碎片</relation_fragment>',
        '</affinity_person>',
        '按角色繼續排列 affinity_person，最後閉合 </affinity_panel>。不要再輸出舊版根級 c_score / u_score 單槽字段。',
    ].join('\n');
};

/** 用戶對本輪關係變化的知情邊界擁有最終決定權。 */
export const buildStoryAffinityAwarenessReminder = (input: StoryAffinityInput | undefined, primaryCharacterName: string): string => {
    if (!input || (Number(input.delta) === 0 && !String(input.reason || '').trim())) return '';
    if (input.awareness === 'noticed') return [
        '### 本輪 U→C 關係變化 · 角色完全透視（用戶明確指定，覆蓋常規感知檔）',
        `- ${primaryCharacterName || '當前主要角色'}明確知道用戶→自己的關係溫度發生了數值層面的變化；這是直接、確定的透視信息，不是觀察氣氛、猜測態度或只知道“似乎有變化”。`,
        '- 角色完整知道最新 delta 的正負、準確幅度、更新後的 U→C 絕對值，以及 <reason> 表達的原因；不得把它降級成模糊感應。',
        '- 本輪正文必須給出一次符合人物性格、現場節拍與邊界的明確反應；可以克制或隱藏，但行為、判斷或內心必須真實接住這項已知變化。',
        '- 角色擁有數值層面的知識，但默認將其自然翻譯為人物認知，不照念 XML 標籤或系統面板；世界觀本來存在數值界面時才可直接談具體數字。',
        '- 這項用戶選擇只覆蓋本輪的察覺邊界，不授權角色逼問、控制、越界親密或搶走原劇情主線。',
    ].join('\n');
    return [
        '### 本輪 U→C 關係變化 · 角色未察覺（用戶明確指定）',
        `- ${primaryCharacterName || '對應角色'}不能讀取用戶→自己的這條 <u_affinity> 的 delta、reason 或準確方向，也不能憑空表演成已經知道；這條限制不覆蓋用戶對其他角色單獨設置的察覺狀態。`,
        '- 其他角色更不能借此讀取不屬於自己的關係數值；多人之間不得共享這條變化。',
        '- 這次變化只作為模型維持關係連續性與敘事氛圍的低權重背景，不強制製造角色反應。',
        '- 若用戶正文另有真實可見的台詞或動作，角色仍可只依據那些現場證據正常推斷。',
    ].join('\n');
};

export type StoryNarrationMode = 'second' | 'third' | 'custom';

export const resolveStoryNarrationMode = (document: StoryTheaterPresetDocument): StoryNarrationMode => {
    const third = document.prompts.some(prompt => prompt.id === 'nmj-v3-pov-third' && prompt.enabled);
    if (third) return 'third';
    const second = document.prompts.some(prompt => prompt.id === 'nmj-v3-pov-second' && prompt.enabled);
    return second ? 'second' : 'custom';
};

/** 最後貼近用戶輸入發送，消除系統指令裡的“你”與故事用戶側身份之間的歧義。 */
export const buildStoryIdentityGuard = (
    document: StoryTheaterPresetDocument,
    identityName: string,
    characterNames: string[],
): string => {
    const identity = identityName.trim() && identityName.trim() !== '你' ? identityName.trim() : '當前用戶側角色（未命名）';
    const cast = characterNames.filter(Boolean).join('、') || '暫無其他角色';
    const mode = resolveStoryNarrationMode(document);
    const perspectiveRule = mode === 'third'
        ? `- 當前啟用第三人稱有限。<story_text> 的旁白必須用「${identity}」已確立的姓名、稱謂、合適代詞或自然省略主語；旁白中的“你／你的”必須改掉。角色對白裡對「${identity}」說“你”是正常稱呼，不要誤改。`
        : mode === 'second'
            ? `- 當前啟用第二人稱有限。<story_text> 旁白中的“你／你的”固定指「${identity}」，絕不指生成回覆的一方或任一其他角色。`
            : '- 當前預設使用自定義人稱；服從預設明確寫出的敘述規則，但仍遵守下面的身份綁定。';
    return [
        '### 糯米機運行時身份與人稱錨點（覆蓋舊樓層的寫法，不覆蓋角色卡事實）',
        `- 用戶側劇情身份：${identity}。本輪參與角色：${cast}。關係協議中的 U 只指「${identity}」，C 才指名單中的各個角色。`,
        '- 生成回覆的一方不屬於故事人物。系統指令為方便表達而出現的“你”，只是執行語法，不能據此把生成端寫進故事，也不能把故事裡的“你”解釋成生成端自己。',
        '- 用戶最新輸入仍按實際句法辨認說話人與受話人；但在最終輸出的敘事旁白、場景條和關係面板中，未另行點名的“你／你的”只允許指用戶側劇情身份。',
        perspectiveRule,
        '- 歷史助手回覆只是已經發生的舊劇情：繼承事實，不繼承它過去使用的第一、第二或第三人稱。當前啟用的人稱模式是本輪唯一標準。',
    ].join('\n');
};

const slotForMarker = (marker: StoryTheaterPresetPrompt['marker'], slots: StoryPromptSlots): string => {
    switch (marker) {
        case 'characters': return slots.actors;
        case 'world_before': return slots.worldBefore;
        case 'user': return slots.persona;
        case 'world_after': return slots.worldAfter;
        case 'scenario': return slots.scenario;
        case 'examples': return slots.examples || '';
        case 'history': return slots.history || '';
        default: return '';
    }
};

const pushPromptMessage = (messages: StoryApiMessage[], role: StoryApiRole, content: string) => {
    const clean = content.trim();
    if (!clean) return;
    messages.push({ role, content: clean });
};

export const compileStoryPreset = (input: {
    preset?: StoryTheaterPreset | null;
    slots: StoryPromptSlots;
    userName: string;
    characterNames: string[];
}): { messages: StoryApiMessage[]; settings: StoryGenerationSettings; assistantPrefill?: StoryApiMessage } => {
    const { preset, slots, userName, characterNames } = input;
    const document = (preset || BUILTIN_NIGHT_SCREENING_PRESET).document;
    const messages: StoryApiMessage[] = [];

    const worldBeforePrompts = document.prompts.filter(prompt => prompt.marker === 'world_before');
    const enabledWorldBeforePrompt = worldBeforePrompts.find(prompt => prompt.enabled);
    const firstEnabledCharacterIndex = document.prompts.findIndex(prompt => prompt.enabled && prompt.marker === 'characters');
    const shouldBackfillWorldBefore = worldBeforePrompts.length === 0 && Boolean(slots.worldBefore.trim());
    const shouldMoveWorldBeforeAheadOfCharacters = Boolean(
        enabledWorldBeforePrompt
        && firstEnabledCharacterIndex >= 0
        && document.prompts.indexOf(enabledWorldBeforePrompt) > firstEnabledCharacterIndex
        && slots.worldBefore.trim(),
    );

    // 糯米機原生 Prompt Manager 按數組順序送出；同一個 marker 只注入一次，
    // 角色資料始終使用一份完整的沙盒上下文。
    const injectedMarkers = new Set<string>();
    for (let index = 0; index < document.prompts.length; index += 1) {
        const prompt = document.prompts[index];
        if (
            index === firstEnabledCharacterIndex
            && (shouldBackfillWorldBefore || shouldMoveWorldBeforeAheadOfCharacters)
        ) {
            pushPromptMessage(
                messages,
                enabledWorldBeforePrompt?.role || 'system',
                macroReplace(slots.worldBefore, userName, characterNames),
            );
            injectedMarkers.add('world_before');
        }
        if (!prompt.enabled || prompt.section) continue;
        let raw = prompt.content;
        if (prompt.marker) {
            if (injectedMarkers.has(prompt.marker)) continue;
            injectedMarkers.add(prompt.marker);
            raw = slotForMarker(prompt.marker, slots);
        }
        if (!raw.trim()) continue;
        pushPromptMessage(messages, prompt.role, macroReplace(raw, userName, characterNames));
    }

    // 兼容沒有任何原生槽位的舊自定義預設，確保角色設定前世界書不會靜默丟失。
    if (shouldBackfillWorldBefore && firstEnabledCharacterIndex < 0 && !injectedMarkers.has('world_before')) {
        messages.unshift({ role: 'system', content: macroReplace(slots.worldBefore, userName, characterNames).trim() });
    }

    const prefill = String(document.assistantPrefill || '').trim();
    const assistantPrefill = prefill ? { role: 'assistant' as const, content: macroReplace(prefill, userName, characterNames) } : undefined;

    return {
        messages,
        settings: {
            temperature: document.generation.temperature,
            top_p: document.generation.topP,
            frequency_penalty: document.generation.frequencyPenalty,
            presence_penalty: document.generation.presencePenalty,
            max_tokens: document.generation.maxTokens,
        },
        assistantPrefill,
    };
};

/**
 * 部分 OpenAI 兼容模型硬性要求請求最後一條消息必須是 user，不能接受
 * SillyTavern 常用的 assistant prefill。把預填充改寫成緊鄰用戶消息前的
 * system 約束，調用方仍可在返回文本缺失前綴時本地補齊。
 */
export const buildStoryPrefillInstruction = (assistantPrefill?: StoryApiMessage): StoryApiMessage | undefined => {
    const content = assistantPrefill?.content?.trim();
    if (!content) return undefined;
    return {
        role: 'system',
        content: [
            '### 回覆起始文本（兼容模式）',
            '你的最終回覆必須直接以下列文本開頭；不要解釋、轉述或把它放進代碼塊：',
            content,
        ].join('\n'),
    };
};

/**
 * 默認完整保留原生 assistant prefill；只有用戶為當前劇情顯式開啟 400 兼容模式時，
 * 才把預填改成 system 約束並讓最終消息保持 user。這樣個別嚴格接口不會改變所有人的預設效果。
 */
export const appendStoryUserTurn = (
    messages: StoryApiMessage[],
    userContent: string,
    assistantPrefill?: StoryApiMessage,
    forceUserLastMessage = false,
): StoryApiMessage[] => {
    if (forceUserLastMessage) {
        const instruction = buildStoryPrefillInstruction(assistantPrefill);
        return [
            ...messages,
            ...(instruction ? [instruction] : []),
            { role: 'user', content: userContent },
        ];
    }
    return [
        ...messages,
        { role: 'user', content: userContent },
        ...(assistantPrefill ? [assistantPrefill] : []),
    ];
};

export const dedupeTheaterWorldbooks = (characters: CharacterProfile[]): MountedWorldbook[] => {
    const seen = new Set<string>();
    const output: MountedWorldbook[] = [];
    for (const char of characters) {
        for (const book of (char.mountedWorldbooks || [])) {
            const keys = [
                book.id ? `id:${book.id}` : '',
                `body:${book.title.trim().toLocaleLowerCase()}\u0000${book.content.trim()}`,
            ].filter(Boolean);
            if (keys.length === 0 || keys.some(key => seen.has(key))) continue;
            keys.forEach(key => seen.add(key));
            output.push({ ...book });
        }
    }
    return output.sort((a, b) => (a.category || '').localeCompare(b.category || '', 'zh-CN') || a.title.localeCompare(b.title, 'zh-CN'));
};

export const buildStoryWorldbookScanMessages = (
    history: WorldbookScanMessage[],
    currentUserContent: string,
    limit = 20,
): WorldbookScanMessage[] => {
    const safeLimit = Math.max(1, Math.floor(limit));
    const current = currentUserContent.trim();
    if (!current) return history.slice(-safeLimit);
    const historyLimit = safeLimit - 1;
    return [
        ...(historyLimit > 0 ? history.slice(-historyLimit) : []),
        { role: 'user', content: current },
    ];
};

export const buildTheaterWorldbookSlots = (
    books: MountedWorldbook[],
    scanMessages: WorldbookScanMessage[],
    userName: string,
    characterNames: string[] = [],
): { worldBefore: string; worldAfter: string } => {
    const resolved = splitWorldbookSections(resolveWorldbookEntries(books, scanMessages, characterNames.join('、'), userName));
    return {
        worldBefore: formatWorldbookSection(resolved.beforeCharacter, '劇情沙盒世界書 · 角色設定前'),
        worldAfter: [
            formatWorldbookSection(resolved.afterCharacter, '劇情沙盒世界書'),
            formatWorldbookSection(resolved.beforeExamples, '劇情沙盒世界書 · 示例前'),
            formatWorldbookSection(resolved.afterExamples, '劇情沙盒世界書 · 示例後'),
            formatWorldbookSection(resolved.authorsNoteTop, '劇情沙盒世界書 · 作者註釋頂部'),
            formatWorldbookSection(resolved.authorsNoteBottom, '劇情沙盒世界書 · 作者註釋底部'),
            formatWorldbookSection(resolved.atDepth, '劇情沙盒世界書 · 當前場景'),
        ].filter(Boolean).join('\n'),
    };
};

export const buildBareTheaterActorContext = (char: CharacterProfile): string => [
    `### 劇情角色：${char.name}`,
    `- 名字：${char.name}`,
    `- 核心指令：\n${char.systemPrompt || '無額外核心指令'}`,
    char.worldview?.trim() ? `- 世界觀：\n${char.worldview.trim()}` : '',
].filter(Boolean).join('\n');

/**
 * 劇情客串 NPC 的輕量上下文塊——不走 ContextBuilder.buildCoreContext（NPCProfile 沒有
 * systemPrompt/記憶宮殿/世界書這套），只取 NPCProfile 自身的設定字段，跟群聊「NPC 客串」
 * (utils/npcGroupGuestLine.ts) 用的是同一種"輕量素材"思路。沒有獨立記憶輸入輸出、
 * 不追蹤好感度，標題特意跟 buildBareTheaterActorContext 的 `### 劇情角色：` 區分開，
 * 讓模型知道這是戲份更輕的客串，不用當成主角經營完整人物弧光。
 */
export const buildTheaterNpcContext = (
    npc: NPCProfile,
    userName: string,
    sceneCharacters: Pick<CharacterProfile, 'id' | 'name'>[],
): string => {
    const relationshipNote = npc.relationships
        .filter(r => r.targetId === 'user' || sceneCharacters.some(c => c.id === r.targetId))
        .map(r => r.targetId === 'user'
            ? `對「${userName}」：${r.description}`
            : `對「${sceneCharacters.find(c => c.id === r.targetId)?.name || '在場角色'}」：${r.description}`)
        .join('\n');
    return [
        `### 劇情客串角色：${npc.name}（非常駐演員，戲份比主角輕，按需自然出場即可）`,
        `- 名字：${npc.name}`,
        npc.description?.trim() ? `- 設定：\n${npc.description.trim()}` : '',
        npc.worldview?.trim() ? `- 世界觀：\n${npc.worldview.trim()}` : '',
        relationshipNote ? `- 關係：\n${relationshipNote}` : '',
        buildNpcMemoryBlock(npc),
        '- 這是客串角色：不追蹤好感度，按以上設定（和 TA 記得的事）自然參與本場劇情即可。',
    ].filter(Boolean).join('\n');
};

export const buildStoryActorMemoryEnvelope = (
    characterName: string,
    recalled: string,
    originalUserName: string,
    currentIdentityName: string,
): string => {
    const content = recalled.trim();
    if (!content) return '';
    const owner = characterName.trim() || '當前角色';
    const originalUser = originalUserName.trim() || '原本的你';
    const currentIdentity = currentIdentityName.trim() || originalUser;
    const identityReminder = currentIdentity === originalUser
        ? `- 本劇情當前用戶側身份仍是「${originalUser}」；記憶原文裡的“你”繼續指這個身份。`
        : `- 本劇情當前用戶側執筆身份是「${currentIdentity}」，不得因此把舊記憶裡的“你”從「${originalUser}」改綁到當前身份。`;

    return [
        `### ${owner} 的專屬既有記憶`,
        `歸屬規則：以下內容只屬於角色「${owner}」，不得歸給、共享給或改寫成其他角色的親歷記憶。`,
        `- 記憶片段裡的第一人稱“我/我的”，默認指「${owner}」。`,
        `- 記憶片段裡的第二人稱“你/你的”，若片段沒有另行點名，默認指形成記憶時的原互動對象「${originalUser}」。`,
        identityReminder,
        `【${owner}專屬記憶開始】`,
        content,
        `【${owner}專屬記憶結束】`,
    ].join('\n');
};

export const buildStoryArchiveMemoryEnvelope = (recalled: string): string => {
    const content = recalled.trim();
    if (!content) return '';
    return [
        '### 本劇情共享檔案召回',
        '歸屬規則：以下內容是本劇情自己的敘事檔案，只用於承接已經發生的劇情；它不屬於任何一位角色的個人記憶，也不得寫入或冒充角色的神經鏈接記憶。',
        '- 片段中的第一、第二人稱只保留原文敘事視角；應依據片段內明確出現的姓名與事件判斷身份。',
        '- 無法從片段確定指代時，保持模糊，不得擅自把“我/你”歸給當前面具或任一角色。',
        '【本劇情共享檔案開始】',
        content,
        '【本劇情共享檔案結束】',
    ].join('\n');
};

export const buildTheaterPersona = (mask: ResolvedStoryTheaterMask): string => [
    '### 當前用戶側執筆身份',
    `- 名字：${mask.name || '你'}`,
    `- 身份/外在設定：${mask.description || '無'}`,
    mask.coreInstruction?.trim() ? `- 核心性格與行動邊界：\n${mask.coreInstruction.trim()}` : '',
    mask.worldview?.trim() ? `- 所屬世界觀：\n${mask.worldview.trim()}` : '',
    '- 這是用戶側本輪親自執筆的故事身份，不是生成回覆的一方。除非預設明確允許代寫，續寫不得把該身份當作普通角色擅自決定重大選擇。',
].join('\n');

export const storyTheaterMemoryRecipientIds = (entry: StoryTheaterEntry): string[] => {
    const ids = new Set(entry.characterIds);
    if (entry.mask?.type === 'character') ids.add(entry.mask.id);
    return [...ids];
};

const DISPLAY_BLOCK_META: Record<string, { kind: StoryDisplayBlockKind; title?: string }> = {
    scene_header: { kind: 'scene', title: '這一幕' },
    story_text: { kind: 'story' },
    backstage: { kind: 'backstage', title: '幕後層' },
    mind_weather: { kind: 'backstage', title: '內心氣象' },
    worldline: { kind: 'worldline', title: '世界線' },
    world_line: { kind: 'worldline', title: '世界線' },
    shot_debts: { kind: 'debts', title: '尚未償還的鏡頭' },
    mini_theater: { kind: 'theater', title: '幕間劇場' },
    reply_choices: { kind: 'choices', title: '可以這樣推進' },
    affinity_panel: { kind: 'affinity', title: '關係變化' },
};

const DISPLAY_TAG_LABELS: Record<string, string> = {
    time: '時間', place: '地點', situation: '場面', owner: '主體', surface: '表層反應', undertow: '潛流',
    secret: '秘密', hidden: '隱藏事實', true_monologue: '真正的獨白', voice: '心聲', red: '危險信號',
    fracture: '裂紋', surge: '情緒峰值', world_line_title: '世界線', worldline_title: '世界線', world_event: '事件',
    scope: '影響範圍', change: '變化', debt_title: '鏡頭債', debt: '未結事項', origin: '起因', unpaid: '尚未償還',
    trigger: '觸發條件', mt_title: '幕間', mt_system: '旁白', mt_ai: '人物', mt_user: '右側', name: '人物',
    choice: '備選', label: '方向', reply: '推進', relation_note: '關係天氣', u_note: '你的說明', c_note: '變化原因',
    c_score: '關係溫度', u_score: '你的關係溫度', u_affinity: '你的關係備註', u_delta: '你的變化', c_delta: '本輪變化', relation_fragment: '關係碎片',
    character_id: '角色 ID', character_name: '人物',
    c_to_u_score: '角色對你的溫度', c_to_u_delta: '角色本輪變化', c_to_u_note: '角色變化依據',
    u_to_c_score: '你對角色的溫度', u_to_c_delta: '你本輪的變化', u_to_c_note: '你的變化原因', awareness_state: '察覺狀態',
    trust: '信任', security: '安全感', possessive_pull: '佔有拉力', emotional_pressure: '情緒壓強', repair_will: '修復意願', state_note: '關係合力',
};

const HIDDEN_STORY_DISPLAY_TAGS = new Set(['u_score', 'u_delta', 'u_note']);

const decodeStoryCodePoint = (match: string, code: string, radix: number): string => {
    const value = parseInt(code, radix);
    return Number.isFinite(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : match;
};

const decodeStoryEntities = (value: string): string => value
    .replace(/&#(\d+);/g, (match, code) => decodeStoryCodePoint(match, code, 10))
    .replace(/&#x([0-9a-f]+);/gi, (match, code) => decodeStoryCodePoint(match, code, 16))
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, String.fromCharCode(34)).replace(/&#39;/gi, String.fromCharCode(39)).replace(/&amp;/gi, '&');

const cleanStoryMarkupText = (value: string): string => decodeStoryEntities(String(value || ''))
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/?[a-z][^>]*>/gi, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const firstStoryTagValue = (source: string, tag: string): string => {
    const closed = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'i').exec(source)?.[1];
    if (closed !== undefined) return cleanStoryMarkupText(closed);
    const openOnly = new RegExp(`<${tag}\\b[^>]*>([^<\\n]*)`, 'i').exec(source)?.[1];
    return cleanStoryMarkupText(openOnly || '');
};

/**
 * 小劇場單獨按語義解析：把 name/text 合併成一條消息，並容忍缺失閉合標籤、
 * 省略消息外殼或直接退化為純文本，避免把每個 XML 標籤渲染成一張卡。
 */
export const parseStoryMiniTheater = (fragment: string): StoryMiniTheaterDisplay => {
    const source = decodeStoryEntities(String(fragment || '')).replace(/\r\n?/g, '\n');
    const title = firstStoryTagValue(source, 'mt_title') || '幕間頻道';
    const systems = [...source.matchAll(/<mt_system\b[^>]*>([\s\S]*?)(?:<\/mt_system\s*>|(?=<(?:mt_ai|mt_user|mt_title)\b)|$)/gi)]
        .map(match => cleanStoryMarkupText(match[1]))
        .filter(Boolean);
    const messages: StoryMiniTheaterDisplayMessage[] = [];
    const messagePattern = /<(mt_ai|mt_user)\b[^>]*>([\s\S]*?)(?:<\/\1\s*>|(?=<(?:mt_ai|mt_user|mt_system|mt_title)\b)|$)/gi;
    let match: RegExpExecArray | null;
    while ((match = messagePattern.exec(source)) !== null) {
        const side = match[1].toLowerCase() === 'mt_user' ? 'right' : 'left';
        const body = match[2];
        const name = firstStoryTagValue(body, 'name') || (side === 'right' ? '右側' : '左側');
        const taggedText = firstStoryTagValue(body, 'text');
        const fallbackText = cleanStoryMarkupText(body).replace(name, '').trim();
        const text = taggedText || fallbackText;
        if (text) messages.push({ side, name, text });
    }

    if (messages.length === 0) {
        const pairPattern = /<name\b[^>]*>([\s\S]*?)<\/name\s*>\s*<text\b[^>]*>([\s\S]*?)<\/text\s*>/gi;
        for (const pair of source.matchAll(pairPattern)) {
            const name = cleanStoryMarkupText(pair[1]) || '頻道消息';
            const text = cleanStoryMarkupText(pair[2]);
            if (text) messages.push({ side: 'left', name, text });
        }
    }

    if (messages.length === 0) {
        const plain = cleanStoryMarkupText(source)
            .split(/\n+/)
            .map(line => line.trim())
            .filter(line => line && line !== title && !systems.includes(line));
        for (const line of plain) {
            const labeled = /^([^：:]{1,20})[：:]\s*(.+)$/.exec(line);
            messages.push({ side: 'left', name: labeled?.[1]?.trim() || '頻道消息', text: labeled?.[2]?.trim() || line });
        }
    }

    return { title, ...(systems.length > 0 ? { system: systems.join(' · ') } : {}), messages };
};

const formatTaggedStoryFragment = (fragment: string): string => {
    let clean = decodeStoryEntities(String(fragment || '')).replace(/\r\n?/g, '\n');
    const pair = /<([a-z][\w-]*)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
    for (let pass = 0; pass < 8 && pair.test(clean); pass += 1) {
        pair.lastIndex = 0;
        clean = clean.replace(pair, (_whole, rawTag: string, body: string) => {
            const tag = rawTag.toLowerCase();
            const label = DISPLAY_TAG_LABELS[tag];
            const inner = body.trim();
            if (!inner) return '';
            if (HIDDEN_STORY_DISPLAY_TAGS.has(tag)) return '';
            if (tag === 'story_text' || tag === 'text') return inner;
            return label ? `\n${label}：${inner}\n` : `\n${inner}\n`;
        });
    }
    clean = clean
        .replace(/<\/?[a-z][^>]*>/gi, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return clean;
};

/** 將模型的 XML 風格排版協議變成純文本展示塊；原始消息仍原樣參與下一輪上下文。 */
export const parseStoryDisplayBlocks = (content: string): StoryDisplayBlock[] => {
    const source = String(content || '');
    const blocks: StoryDisplayBlock[] = [];
    const topLevel = /<(scene_header|story_text|backstage|mind_weather|worldline|world_line|shot_debts|mini_theater|reply_choices|affinity_panel)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
    let cursor = 0;
    let match: RegExpExecArray | null;
    const push = (kind: StoryDisplayBlockKind, text: string, title?: string) => {
        const clean = formatTaggedStoryFragment(text);
        if (!clean) return;
        const previous = blocks[blocks.length - 1];
        if (kind === 'story' && previous?.kind === 'story') previous.text = `${previous.text}\n\n${clean}`;
        else blocks.push({ kind, text: clean, ...(title ? { title } : {}) });
    };
    const pushTheater = (fragment: string, title?: string) => {
        const theater = parseStoryMiniTheater(fragment);
        const text = [
            theater.title ? `幕間：${theater.title}` : '',
            theater.system ? `旁白：${theater.system}` : '',
            ...theater.messages.map(message => `${message.name}：${message.text}`),
        ].filter(Boolean).join('\n');
        if (text) blocks.push({ kind: 'theater', ...(title ? { title } : {}), text, theater });
    };
    while ((match = topLevel.exec(source)) !== null) {
        if (match.index > cursor) push('story', source.slice(cursor, match.index));
        const meta = DISPLAY_BLOCK_META[match[1].toLowerCase()] || { kind: 'other' as const };
        if (meta.kind === 'theater') {
            pushTheater(match[2], meta.title);
        } else {
            push(meta.kind, match[2], meta.title);
        }
        cursor = match.index + match[0].length;
    }
    if (cursor < source.length) {
        const tail = source.slice(cursor);
        const unclosedTheater = /<mini_theater\b[^>]*>([\s\S]*)$/i.exec(tail);
        if (unclosedTheater) {
            if (unclosedTheater.index > 0) push('story', tail.slice(0, unclosedTheater.index));
            pushTheater(unclosedTheater[1], DISPLAY_BLOCK_META.mini_theater.title);
        } else {
            push('story', tail);
        }
    }
    if (blocks.length === 0) push('story', source);
    return blocks;
};

export const formatActorRecentMessages = (
    char: CharacterProfile,
    messages: Message[],
    originalUserName?: string,
    currentIdentityName?: string,
): string => {
    if (messages.length === 0) return '';
    const originalUser = originalUserName?.trim() || '你';
    const currentIdentity = currentIdentityName?.trim() || originalUser;
    const rows = messages.map(message => {
        const speaker = message.role === 'user' ? `記憶中的你（${originalUser}）` : message.role === 'assistant' ? char.name : '系統';
        const clean = String(message.content || '').replace(/data:[^\s]+/gi, '[媒體]').slice(0, 4000);
        return `- [${new Date(message.timestamp).toLocaleString()}] ${speaker}：${clean}`;
    });
    const identityReminder = currentIdentity === originalUser
        ? ''
        : `\n當前執筆身份是「${currentIdentity}」；不得把下列“記憶中的你”重新解釋成當前身份。`;
    return `### ${char.name} 最近攜帶的專屬原文上下文（${messages.length} 條）\n以下記錄只屬於「${char.name}」與原互動對象「${originalUser}」，不得併入其他角色的經歷。${identityReminder}\n${rows.join('\n')}`;
};

export const buildStoryHistory = (messages: Message[]): StoryApiMessage[] => messages
    .filter(message => !message.metadata?.theaterArchived && message.role !== 'system')
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(message => ({ role: message.role as StoryApiRole, content: String(message.content || '') }));

/** 僅當最後一條劇場消息是尚未得到回覆的用戶推進時，提供中斷續跑輸入。 */
export const getPendingStoryRetryInput = (messages: Message[]): string => {
    const latest = messages[messages.length - 1];
    if (!latest || latest.role !== 'user' || latest.metadata?.theaterArchived) return '';
    return String(latest.content || '').trim();
};

export const estimateStoryTokens = (text: string): number => {
    const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
    const rest = Math.max(0, text.length - cjk);
    return cjk + Math.ceil(rest / 4);
};

const storyApiDetail = (value: unknown): string => {
    if (typeof value === 'string') return value.trim();
    if (!value || typeof value !== 'object') return '';
    const record = value as Record<string, unknown>;
    return storyApiDetail(record.message)
        || storyApiDetail(record.detail)
        || storyApiDetail(record.error)
        || storyApiDetail(record.code);
};

/** 保留上游 4xx 的真正原因，避免調試日誌裡只剩一條沒有信息量的 “API Error 400”。 */
export const describeStoryApiError = (status: number, data: unknown): string => {
    const detail = storyApiDetail((data as Record<string, unknown> | null)?.error)
        || storyApiDetail((data as Record<string, unknown> | null)?.message)
        || storyApiDetail((data as Record<string, unknown> | null)?.detail);
    return `API Error ${status}${detail ? `：${detail.slice(0, 500)}` : ''}`;
};

export const isStoryUserLastCompatibilityError = (message: string): boolean => (
    /(?:last|final)[^\n]{0,80}(?:message|role)[^\n]{0,80}user/i.test(message)
    || /(?:最[后後]|末尾)[^\n]{0,40}(?:消息|角色)[^\n]{0,40}user/i.test(message)
);

/** 200 但正文為空時把 finish_reason 帶出來，區分截斷、內容過濾和代理空包。 */
export const describeEmptyStoryCompletion = (data: unknown): string => {
    const record = data as Record<string, any> | null;
    const choice = record?.choices?.[0];
    const finishReason = String(choice?.finish_reason || choice?.finishReason || '').trim();
    const providerDetail = storyApiDetail(record?.error) || storyApiDetail(record?.message);
    if (providerDetail) return `沒有生成正文：${providerDetail.slice(0, 500)}`;
    if (finishReason === 'length' || finishReason === 'max_tokens') {
        return '沒有生成正文：模型在寫出正文前已用完輸出額度（finish_reason=length）。請提高“最大輸出”，或降低模型思考量後重試';
    }
    if (finishReason === 'content_filter') return '沒有生成正文：上游內容過濾攔截了本次回覆（finish_reason=content_filter）';
    return `沒有生成正文${finishReason ? `（finish_reason=${finishReason}）` : '：上游返回了空內容'}，請重試`;
};

export const memoryTimestampForCharacter = (entry: StoryTheaterEntry, charId: string, realTimestamp: number): number => {
    const anchorText = entry.characterMemoryDates?.[charId];
    const storyAnchor = anchorText ? new Date(anchorText).getTime() : NaN;
    if (!Number.isFinite(storyAnchor)) return realTimestamp;
    return storyAnchor + Math.max(0, realTimestamp - entry.createdAt);
};

export const makeStoryPresetFileName = (name: string): string => {
    const safeName = name.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80) || '劇情預設';
    return `${safeName}.json`;
};

export const downloadStoryPreset = async (preset: StoryTheaterPreset): Promise<'shared' | 'downloaded' | 'cancelled'> => (
    shareOrDownloadFile({
        card: { kind: 'story', title: preset.name || '劇情預設' },
        content: JSON.stringify(preset.document, null, 2),
        fileName: makeStoryPresetFileName(preset.name),
        mimeType: 'application/json',
        shareTitle: `劇情預設：${preset.name || '未命名'}`,
    })
);
