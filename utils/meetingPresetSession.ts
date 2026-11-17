/**
 * 見面的自訂預設模式：把 Soren 的角色上下文拆開，填進預設的佔位，再交給 assembleMeetingPreset
 * 照 ST 的規則拼。內建模式還是走 DatePrompts.buildSessionPayload，兩條路互不影響。
 *
 * 佔位怎麼填（ContextBuilder.buildCoreSections 的各段）：
 * - 世界書·前：世界書「角色設定前」
 * - 角色描述：你的身份（名字、備註、核心指令）
 * - 場景：見面設定的劇情大綱
 * - 回應字數：預設有讀字數的 getglobalvar（名字含「字數」「總」）就蓋過去，沒有才用 Soren 的佔位
 * - 前情提要：這場故事的總結（Soren 自己的佔位，預設沒放就補在聊天記錄前）
 * - 角色設定：內在認知
 * - 世界書·後：世界觀＋世界書「角色設定後」「作者註釋頂部／底部」
 * - 對話示例：世界書「示例前／後」＋對話範例＋招牌台詞
 * - 用戶描述：互動對象
 * - Soren 的記憶／情緒／時間／語音／其它：記憶系統＋記憶宮殿、情緒 buff、時間感知、語氣標籤規則、
 *   私密印象＋拉黑中見面的說明＋SAR 模塊＋這輪踩中的固定台詞
 * 內建模式的格式規則、文風預設、「說出口／旁白」標記、表達底線都不帶——這些交給預設自己決定。
 */

import { buildDateLanguageRule } from './chatLanguage';
import { clockTurnNote, describeClockNote, formatStoryClock, isDateTimeOn, storyClock, type DateClock } from './dateStoryTime';
import type { CharacterProfile, Emoji, Message, UserProfile } from '../types';
import { ContextBuilder } from './context';
import { buildDateHistory, DATE_VOICE_GUIDE, type ApiMessage } from './datePrompts';
import { buildBlockedMeetingNote } from './chatBlock';
import { injectMemoryPalace } from './memoryPalace/pipeline';
import { resolveCharTimeZone } from './timezone';
import { getVoicePromptOverride } from './ttsProvider';
import { buildTriggeredLinesPrompt } from './fixedLines';
import { spokenPartOfDateInput } from './dateUserInput';
import { injectWorldbookDepthEntries, resolveWorldbookDepthEntries, type WorldbookScanMessage } from './worldbook';
import { assembleMeetingPreset } from './meetingPreset/assemble';
import { buildLengthLine, presetLengthGlobals, scenarioText } from './dateExtras';
import type { MeetingPresetDoc, MeetingPresetGeneration, MeetingPresetSlot } from './meetingPreset/types';
import { withGlobalWorldbooks } from './globalWorldbooks';

const join = (...parts: string[]) => parts.filter(part => part && part.trim()).map(part => part.trim()).join('\n\n');

const flattenContent = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.filter((part: any) => part?.type === 'text').map((part: any) => part.text).join('\n');
    return '';
};

export interface MeetingPresetPayload {
    messages: ApiMessage[];
    generation: MeetingPresetGeneration;
}

export const buildMeetingPresetPayload = async (input: {
    preset: MeetingPresetDoc;
    char: CharacterProfile;
    userProfile: UserProfile;
    /** 角色有效上下文窗口，最後一則是本輪的用戶消息（同 buildSessionPayload） */
    allMsgs: Message[];
    emojis: Emoji[];
    /** 本輪給模型看的用戶輸入（「繼續」時是那段指示） */
    userText: string;
    useVisionDescriptions?: boolean;
    model?: string;
    /** 這場故事的前情提要 */
    recap?: string;
    /** 故事時鐘（utils/dateStoryTime.ts）；真實＋流動是 null */
    clock?: DateClock | null;
}): Promise<MeetingPresetPayload> => {
    const { preset, char, userProfile, allMsgs, emojis, userText } = input;
    const userName = userProfile?.name || '';

    const rawClock = input.clock ?? null;
    // 時間關著（來源「關閉」或舊開關）：提示詞不帶時間；關著的時鐘不是故事時鐘
    const timeOn = isDateTimeOn(rawClock) && char.dateTimeAwarenessEnabled !== false;
    const clock = storyClock(rawClock);
    const history = buildDateHistory(allMsgs, char, userProfile, emojis, input.useVisionDescriptions === true, rawClock);
    const scan: WorldbookScanMessage[] = [...history, { role: 'user', content: userText }];

    await injectMemoryPalace(char, allMsgs, undefined, userName);
    const sections = ContextBuilder.buildCoreSections(char, userProfile, true, undefined, undefined, {
        skipTimeAwareness: !timeOn || !!clock,
        conversational: true,
        worldbookMessages: scan,
    });

    const lengthGlobals = presetLengthGlobals(preset.globalVars, char);
    const fixedLines = buildTriggeredLinesPrompt(char, spokenPartOfDateInput(userText), userName || '用戶');
    const slots: Partial<Record<MeetingPresetSlot, string>> = {
        worldInfoBefore: sections.worldbookBeforeCharacter,
        charDescription: sections.identity,
        charPersonality: sections.selfInsights,
        worldInfoAfter: join(sections.worldview, sections.worldbookAfterCharacter, sections.worldbookAuthorsNoteTop, sections.worldbookAuthorsNoteBottom),
        dialogueExamples: join(sections.worldbookBeforeExamples, sections.dialogueExamples, sections.signatureLines, sections.worldbookAfterExamples),
        scenario: scenarioText(char, userName),
        personaDescription: sections.userProfile,
        memory: join(sections.roomPlates, sections.memoryBank, sections.memoryPalace),
        recap: input.recap || '',
        emotion: sections.emotionBuff,
        // 故事時鐘不是現實的話，換成故事裡的時間（照角色時區）
        time: !timeOn ? ''
            : clock
            ? `當前時間（故事裡）：${formatStoryClock(clock, resolveCharTimeZone(char))}。${describeClockNote(clock)}`
            : sections.timeAwareness,
        // 預設自己有讀字數的變數就蓋那個；沒有才由 Soren 另外說一句
        length: lengthGlobals.mapped ? '' : buildLengthLine(char),
        voice: char.dateVoiceEnabled ? (getVoicePromptOverride('dateVoice') ?? DATE_VOICE_GUIDE) : '',
        // 聊天語言（plans/chat-language.md 第 4 批）：台詞用說話語言、括號附譯文；{{char}} 交給巨集展開
        soren: join(sections.impression, sections.relations, buildBlockedMeetingNote(char, userName), ContextBuilder.buildSARModuleContext(char, userProfile, 'date'), fixedLines, buildDateLanguageRule(char.chatLanguage)),
    };

    // 世界書「聊天記錄指定深度」：跟內建模式一樣插進對話
    // 故事時鐘不是現實的話，現在幾點也貼在本輪那句後面：預設裡 time 那格放哪都離生成太遠，
    // 模型常跟著記錄裡的舊時間戳寫日期。真實時間不貼，預設作者自己決定 time 放哪。
    const turnTime = clock && timeOn ? `\n\n(${clockTurnNote(clock, resolveCharTimeZone(char))})` : '';
    const withDepth = injectWorldbookDepthEntries(
        [...history, { role: 'user', content: `${userText}${turnTime}` }],
        resolveWorldbookDepthEntries(withGlobalWorldbooks(char.mountedWorldbooks), scan, char.name, userName),
    );
    const presetHistory = withDepth
        .map(message => ({
            role: (message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user') as 'user' | 'assistant' | 'system',
            content: flattenContent(message.content),
        }))
        .filter(message => message.content.trim());

    const last = (role: string) => [...presetHistory].reverse().find(message => message.role === role)?.content;
    const { messages } = assembleMeetingPreset({
        doc: preset,
        slots,
        history: presetHistory,
        globalVars: lengthGlobals.overrides,
        env: {
            charName: char.name,
            userName,
            charDescription: slots.charDescription,
            charPersonality: slots.charPersonality,
            scenario: slots.scenario,
            persona: slots.personaDescription,
            mesExamples: slots.dialogueExamples,
            lastMessage: presetHistory[presetHistory.length - 1]?.content,
            lastUserMessage: last('user'),
            lastCharMessage: last('assistant'),
            input: userText,
            model: input.model,
            timeZone: resolveCharTimeZone(char),
            ...(clock ? { now: new Date(clock.now) } : {}),
        },
    });

    return { messages, generation: preset.generation };
};
