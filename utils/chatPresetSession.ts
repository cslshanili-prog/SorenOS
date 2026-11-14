/**
 * 私聊的自訂預設（plans/preset-library.md 第 2 批）：角色或「私聊」場景選了一份通用預設時，
 * 把私聊提示詞的各段（ChatPrompts.buildSystemPromptParts 的 segments）放進預設的佔位，交給
 * assembleMeetingPreset 照 ST 的規則拼。沒選預設＝內建，走 chatRequestPayload 原本那條路，一字不差。
 *
 * 佔位怎麼填：
 * - ST 的資料佔位照見面的拆法（utils/meetingPresetSession.ts）：世界書前／後、角色描述、角色設定、
 *   對話示例、用戶描述，來自 ContextBuilder 的各段
 * - Soren 資料：關係與印象（稱呼關係＋私密印象＋你身邊的人）、記憶、日記與彼方、實時狀態
 * - Soren 功能：聊天格式、表情包、引用與環境感知、動作與工具、互動（約見面、打電話、拉黑、小號、私下找人）、
 *   語音、模式（雙語、HTML、思考鏈、MCP 工具）
 * 預設沒放的資料、功能照固定位置補（實時狀態補在聊天記錄後面，其餘在前面）；預設裡有但關掉的＝明確不要，不補。
 * 文風（說話方式、表達底線、關於對方的表達、回到你自己）不補——匯入的預設文風聽它自己的；
 * 內建私聊預設（buildBuiltinChatPresetDoc）把它們列成文字條目，複製出來可以改。
 * 送出前相鄰的 system 併成一則，結構跟內建一樣是「前段＋聊天記錄＋後段」。
 */

import type { CharacterProfile } from '../types';
import { ANTI_FILLER_BLOCK, type CoreContextSections } from './context';
import type { ChatPromptSegments } from './chatPrompts';
import { CHAT_STYLE_ANCHOR, CHAT_STYLE_EXPRESSION, CHAT_STYLE_TALK } from './chatPresetText';
import { assembleMeetingPreset, type PresetMessage } from './meetingPreset/assemble';
import type { ChatSorenSlot, MeetingPresetDoc, MeetingPresetGroup, MeetingPresetPrompt, MeetingPresetSlot, MeetingPromptRole } from './meetingPreset/types';
import { resolveCharTimeZone } from './timezone';

export const CHAT_BUILTIN_PRESET_NAME = '私聊 · 內建';

/** 預設沒放就補、補在聊天記錄前面的（照這個順序） */
export const CHAT_AUTO_BEFORE: ChatSorenSlot[] = [
    'chatRelation', 'chatLife', 'chatInteract', 'chatFormat', 'chatEmoji', 'chatQuote', 'chatActions', 'chatVoice', 'chatModes',
];
/** 預設沒放就補、補在聊天記錄後面的 */
export const CHAT_AUTO_AFTER: ChatSorenSlot[] = ['chatLive'];

/** Soren 功能條目：關掉的時候要講清楚後果（預設編輯頁顯示） */
export const CHAT_FEATURE_OFF_WARNING: Partial<Record<ChatSorenSlot, string>> = {
    chatFormat: '關掉後角色不知道這是手機聊天，可能寫成小說旁白、不照一行一個氣泡。',
    chatEmoji: '關掉後角色不會再用表情包，也看不懂你傳的表情包。',
    chatQuote: '關掉後角色不會引用回覆，也不會照時間差反應。',
    chatActions: '關掉後角色不會轉帳、送禮、代付、記紀念日、發照片、排定時訊息、寫日記、搜尋。',
    chatInteract: '關掉後角色不會約你見面、主動打電話、拉黑你，也不會私下找人、用小號。',
    chatVoice: '關掉後角色不會發語音訊息（語音開著也一樣）。',
    chatModes: '關掉後雙語、HTML 卡片、思考鏈、MCP 工具這些聊天設定裡開的模式都不會生效。',
};

export const CHAT_SLOT_LABELS: Record<ChatSorenSlot, string> = {
    chatRelation: '關係與印象',
    chatLife: '日記與彼方',
    chatLive: '實時狀態（時間、召回、心情、天氣、日程…）',
    chatFormat: 'Soren 功能 · 聊天格式',
    chatEmoji: 'Soren 功能 · 格式要求與表情包',
    chatQuote: 'Soren 功能 · 引用與環境感知',
    chatActions: 'Soren 功能 · 動作與工具',
    chatInteract: 'Soren 功能 · 互動（約見面、打電話、拉黑、小號、私下找人）',
    chatVoice: 'Soren 功能 · 語音',
    chatModes: 'Soren 功能 · 模式（雙語、HTML、思考鏈、MCP）',
};

export const isChatFeatureSlot = (slot: MeetingPresetSlot | undefined): slot is ChatSorenSlot =>
    !!slot && slot in CHAT_FEATURE_OFF_WARNING;

const join = (...parts: string[]) => parts.filter(part => part && part.trim()).map(part => part.trim()).join('\n\n');

const slot = (id: MeetingPresetSlot, name: string): MeetingPresetPrompt =>
    ({ id, name, enabled: true, role: 'system', content: '', slot: id });
const text = (id: string, name: string, content: string): MeetingPresetPrompt =>
    ({ id, name, enabled: true, role: 'system', content: content.trim() });

/**
 * 私聊內建寫成一份預設：給用戶複製出來自己調。條目跟內建送出的順序一樣；
 * 內建本身還是走 chatRequestPayload 原本那條路，這份只是起點。
 */
export const buildBuiltinChatPresetDoc = (): MeetingPresetDoc => {
    const context = [
        slot('worldInfoBefore', '世界書（角色設定前）'),
        slot('charDescription', '角色描述'),
        slot('charPersonality', '角色設定'),
        slot('worldInfoAfter', '世界書（角色設定後）'),
        slot('dialogueExamples', '對話示例'),
        slot('personaDescription', '用戶描述'),
        slot('chatRelation', CHAT_SLOT_LABELS.chatRelation),
        slot('memory', '記憶'),
        slot('chatLife', CHAT_SLOT_LABELS.chatLife),
    ];
    const rules = [
        slot('chatInteract', CHAT_SLOT_LABELS.chatInteract),
        slot('chatFormat', CHAT_SLOT_LABELS.chatFormat),
        text('chat_style_talk', '文風 · 說話方式（沉浸感、行為模式、對話質量）', CHAT_STYLE_TALK),
        text('chat_style_anti_filler', '文風 · 表達底線', ANTI_FILLER_BLOCK),
        slot('chatEmoji', CHAT_SLOT_LABELS.chatEmoji),
        slot('chatQuote', CHAT_SLOT_LABELS.chatQuote),
        slot('chatActions', CHAT_SLOT_LABELS.chatActions),
        slot('chatVoice', CHAT_SLOT_LABELS.chatVoice),
        slot('chatModes', CHAT_SLOT_LABELS.chatModes),
    ];
    const tail = [
        slot('chatHistory', '聊天記錄'),
        slot('chatLive', CHAT_SLOT_LABELS.chatLive),
        text('chat_style_expression', '文風 · 關於對方的表達', CHAT_STYLE_EXPRESSION),
        text('chat_style_anchor', '文風 · 回到你自己（收尾）', CHAT_STYLE_ANCHOR),
    ];
    const ids = (list: MeetingPresetPrompt[]) => list.map(p => p.id);
    const groups: MeetingPresetGroup[] = [
        { id: 'chat_g_context', name: '角色與記憶（Soren 填）', promptIds: ids(context) },
        { id: 'chat_g_rules', name: '聊天規則與 Soren 功能', promptIds: ids(rules) },
        { id: 'chat_g_tail', name: '聊天記錄與收尾', promptIds: ids(tail) },
    ];
    return {
        schema: 'soren.meeting-preset',
        version: 1,
        name: CHAT_BUILTIN_PRESET_NAME,
        generation: {},
        prompts: [...context, ...rules, ...tail],
        regexScripts: [],
        groups,
        globalVars: {},
        scenes: ['chat'],
    };
};

/** 私聊各段 → 預設的佔位內容 */
export const buildChatPresetSlots = (input: {
    segments: ChatPromptSegments;
    core: CoreContextSections;
    /** chatRequestPayload 拼在穩定段後面的模式塊（雙語、HTML、思考鏈、MCP） */
    modes: string;
    /** chatRequestPayload 拼在實時狀態後面的（點單小程序、語境分析、協同文件櫃…） */
    liveExtras: string;
}): Partial<Record<MeetingPresetSlot, string>> => {
    const { segments: s, core: c } = input;
    return {
        worldInfoBefore: c.worldbookBeforeCharacter,
        charDescription: c.identity,
        charPersonality: c.selfInsights,
        worldInfoAfter: join(c.worldview, c.worldbookAfterCharacter, c.worldbookAuthorsNoteTop, c.worldbookAuthorsNoteBottom),
        dialogueExamples: join(c.worldbookBeforeExamples, c.dialogueExamples, c.signatureLines, c.worldbookAfterExamples),
        personaDescription: c.userProfile,
        chatRelation: join(s.relationship, c.impression, c.relations),
        // 私聊的記憶宮殿召回、時間、情緒、固定台詞在實時狀態裡（deferVolatile），角色塊這幾段是空的
        memory: join(c.roomPlates, c.memoryBank),
        chatLife: s.lifeContext,
        chatInteract: s.interact,
        chatFormat: s.format,
        chatEmoji: s.emoji,
        chatQuote: s.quote,
        chatActions: s.actions,
        chatVoice: s.voice,
        chatModes: input.modes,
        chatLive: join(s.live, input.liveExtras),
    };
};

const flatten = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.filter((part: any) => part?.type === 'text').map((part: any) => part.text).join('\n');
    return '';
};

/** 照預設拼出私聊要送的 messages（不含 chatRequestPayload 最後補的 reminder） */
export const assembleChatPreset = (input: {
    doc: MeetingPresetDoc;
    slots: Partial<Record<MeetingPresetSlot, string>>;
    /** buildMessageHistory 出來、插好世界書深度條目的聊天記錄 */
    history: Array<{ role: string; content: unknown }>;
    char: CharacterProfile;
    userName: string;
    model?: string;
}): PresetMessage[] => {
    const history = input.history.map(message => ({
        role: (message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user') as MeetingPromptRole,
        content: (Array.isArray(message.content) ? message.content : String(message.content ?? '')) as string | unknown[],
    }));
    const last = (role: MeetingPromptRole) => {
        const hit = [...history].reverse().find(message => message.role === role);
        return hit ? flatten(hit.content) : undefined;
    };
    const lastUser = last('user');
    const { messages } = assembleMeetingPreset({
        doc: input.doc,
        slots: input.slots,
        history,
        autoSlots: { beforeHistory: CHAT_AUTO_BEFORE, afterHistory: CHAT_AUTO_AFTER },
        squashSystem: true,
        env: {
            charName: input.char.name,
            userName: input.userName,
            charDescription: input.slots.charDescription,
            charPersonality: input.slots.charPersonality,
            persona: input.slots.personaDescription,
            mesExamples: input.slots.dialogueExamples,
            lastMessage: history.length ? flatten(history[history.length - 1].content) : undefined,
            lastUserMessage: lastUser,
            lastCharMessage: last('assistant'),
            input: lastUser,
            model: input.model,
            timeZone: resolveCharTimeZone(input.char),
        },
    });
    return messages;
};
