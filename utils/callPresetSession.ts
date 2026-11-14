/**
 * 電話（語音／視訊）的自訂預設（plans/preset-library.md 第 3a 批）：角色或「電話」場景選了一份通用預設時，
 * 把電話提示詞的各段（utils/callPrompt.ts 的 buildCallPromptParts）和角色塊各段放進預設的佔位，
 * 交給 assembleMeetingPreset 照 ST 的規則拼。沒選預設＝內建，CallApp 照舊送那一串，一字不差。
 *
 * 規則跟私聊一樣（utils/chatPresetSession.ts）：資料和 Soren 功能預設沒放就補、放了關掉就不補；
 * 文風（電話裡怎麼說話、表達底線）不補；相鄰 system 併成一則。
 * ST 的長篇預設套到電話上常常太囉嗦，預設 App 和聊天設定的說明裡有提醒。
 */

import type { CharacterProfile, UserProfile } from '../types';
import { ANTI_FILLER_BLOCK, type CoreContextSections } from './context';
import { CALL_STYLE_TALK, type CallPromptSegments } from './callPrompt';
import { assembleMeetingPreset, type PresetMessage } from './meetingPreset/assemble';
import type { CallSorenSlot, MeetingPresetDoc, MeetingPresetGroup, MeetingPresetPrompt, MeetingPresetSlot, MeetingPromptRole, MeetingSorenSlot } from './meetingPreset/types';
import { DB } from './db';
import { resolveCallPresetId } from './presetBinding';
import { resolveCharTimeZone } from './timezone';

export const CALL_BUILTIN_PRESET_NAME = '電話 · 內建';

/** 預設沒放就補（照這個順序，補在聊天記錄前面） */
export const CALL_AUTO_BEFORE: MeetingSorenSlot[] = [
    'soren', 'memory', 'emotion', 'time', 'callScene', 'callVoice', 'callVideo', 'callModes', 'callFormat',
];

export const CALL_SLOT_LABELS: Record<CallSorenSlot, string> = {
    callScene: 'Soren 功能 · 電話場景（你是誰、電話那頭是誰）',
    callFormat: 'Soren 功能 · 電話格式（來源標記、只說出口的話）',
    callVoice: 'Soren 功能 · 語音演出與語種翻譯',
    callVideo: 'Soren 功能 · 視訊（模型表演、鏡頭）',
    callModes: 'Soren 功能 · 思考鏈',
};

/** 關掉的時候要講清楚後果（預設編輯頁顯示） */
export const CALL_FEATURE_OFF_WARNING: Record<CallSorenSlot, string> = {
    callScene: '關掉後角色不知道自己在講電話，可能寫成文字訊息或小說。',
    callFormat: '關掉後角色可能把 [通話] 這類標記、旁白也說出來。',
    callVoice: '關掉後語音會變得平板，語種翻譯（<語音> 標籤）也不會照格式寫。',
    callVideo: '關掉後視訊裡的模型不會跟著台詞做表情動作，也看不到你的鏡頭。',
    callModes: '關掉後思考鏈不會生效。',
};

const join = (...parts: string[]) => parts.filter(part => part && part.trim()).map(part => part.trim()).join('\n\n');

const slot = (id: MeetingPresetSlot, name: string): MeetingPresetPrompt =>
    ({ id, name, enabled: true, role: 'system', content: '', slot: id });
const text = (id: string, name: string, content: string): MeetingPresetPrompt =>
    ({ id, name, enabled: true, role: 'system', content: content.trim() });

/** 電話內建寫成一份預設：給用戶複製出來自己調。內建本身還是走 CallApp 原本那條路 */
export const buildBuiltinCallPresetDoc = (): MeetingPresetDoc => {
    const context = [
        slot('worldInfoBefore', '世界書（角色設定前）'),
        slot('charDescription', '角色描述'),
        slot('charPersonality', '角色設定'),
        slot('worldInfoAfter', '世界書（角色設定後）'),
        slot('dialogueExamples', '對話示例'),
        slot('personaDescription', '用戶描述'),
        slot('soren', '其它（印象、你身邊的人、固定台詞）'),
        slot('memory', '記憶'),
        slot('emotion', '情緒'),
        slot('time', '時間'),
    ];
    const rules = [
        slot('callScene', CALL_SLOT_LABELS.callScene),
        text('call_style_talk', '文風 · 電話裡怎麼說話（不像寫作文、感受對方、長度）', CALL_STYLE_TALK),
        text('call_style_anti_filler', '文風 · 表達底線', ANTI_FILLER_BLOCK),
        slot('callVoice', CALL_SLOT_LABELS.callVoice),
        slot('callFormat', CALL_SLOT_LABELS.callFormat),
        slot('callVideo', CALL_SLOT_LABELS.callVideo),
        slot('callModes', CALL_SLOT_LABELS.callModes),
    ];
    const tail = [slot('chatHistory', '通話記錄')];
    const ids = (list: MeetingPresetPrompt[]) => list.map(p => p.id);
    const groups: MeetingPresetGroup[] = [
        { id: 'call_g_context', name: '角色與記憶（Soren 填）', promptIds: ids(context) },
        { id: 'call_g_rules', name: '電話規則與 Soren 功能', promptIds: ids(rules) },
        { id: 'call_g_tail', name: '通話記錄', promptIds: ids(tail) },
    ];
    return {
        schema: 'soren.meeting-preset',
        version: 1,
        name: CALL_BUILTIN_PRESET_NAME,
        generation: {},
        prompts: [...context, ...rules, ...tail],
        regexScripts: [],
        groups,
        globalVars: {},
        scenes: ['call'],
    };
};

/** 電話各段 → 預設的佔位內容 */
export const buildCallPresetSlots = (input: {
    core: CoreContextSections;
    segments: CallPromptSegments;
    /** 視訊：模型表演說明、鏡頭情緒、快照說明（語音通話是空的） */
    video: string;
    /** 思考鏈 */
    modes: string;
    /** 這輪踩中的固定台詞 */
    fixedLine: string;
}): Partial<Record<MeetingPresetSlot, string>> => {
    const { core: c, segments: s } = input;
    return {
        worldInfoBefore: c.worldbookBeforeCharacter,
        charDescription: c.identity,
        charPersonality: c.selfInsights,
        worldInfoAfter: join(c.worldview, c.worldbookAfterCharacter, c.worldbookAuthorsNoteTop, c.worldbookAuthorsNoteBottom),
        dialogueExamples: join(c.worldbookBeforeExamples, c.dialogueExamples, c.signatureLines, c.worldbookAfterExamples),
        personaDescription: c.userProfile,
        soren: join(c.impression, c.relations, c.triggeredLines, input.fixedLine),
        memory: join(c.roomPlates, c.memoryBank, c.memoryPalace),
        emotion: c.emotionBuff,
        time: join(c.timeAwareness, s.time),
        callScene: s.scene,
        callFormat: s.format,
        callVoice: join(s.voiceActing, s.voiceLang),
        callVideo: input.video,
        callModes: input.modes,
    };
};

const flatten = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.filter((part: any) => part?.type === 'text').map((part: any) => part.text).join('\n');
    return '';
};

/** 照預設拼出這一輪電話要送的 messages */
export const assembleCallPreset = (input: {
    doc: MeetingPresetDoc;
    slots: Partial<Record<MeetingPresetSlot, string>>;
    /** 通話記錄（已插好世界書深度條目；視訊快照那則是帶圖的多段內容） */
    history: Array<{ role: string; content: unknown }>;
    char: CharacterProfile;
    userName: string;
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
    return assembleMeetingPreset({
        doc: input.doc,
        slots: input.slots,
        history,
        autoSlots: { beforeHistory: CALL_AUTO_BEFORE },
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
            timeZone: resolveCharTimeZone(input.char),
        },
    }).messages;
};

/** 這個角色電話用哪份自訂預設；null＝內建。沒選、場景也沒設就不碰 DB */
export const loadCallPresetDoc = async (
    char: Pick<CharacterProfile, 'callPresetId'>,
    userProfile: Pick<UserProfile, 'presetSceneDefaults'> | null | undefined,
): Promise<MeetingPresetDoc | null> => {
    const id = resolveCallPresetId(char, { presetSceneDefaults: userProfile?.presetSceneDefaults });
    if (!id) return null;
    const record = await DB.getMeetingPreset(id).catch(() => undefined);
    return record?.doc ?? null;
};
