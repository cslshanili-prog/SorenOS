/**
 * 見面自訂預設（線下故事）的資料結構。欄位意思照 SillyTavern 的 Chat Completion 預設，
 * 匯入時從 ST 檔案換過來（stImport.ts），組裝時照 ST 的規則拼（assemble.ts）。
 * 設計與取捨見 plans/offline-date-redesign.md。
 */

/** ST 的資料佔位（marker），內容由 Soren 填。 */
export type MeetingStSlot =
    | 'worldInfoBefore'
    | 'worldInfoAfter'
    | 'charDescription'
    | 'charPersonality'
    | 'scenario'
    | 'personaDescription'
    | 'dialogueExamples'
    | 'chatHistory';

/** Soren 自己的佔位：預設沒放的，組裝時補在聊天記錄前面。 */
export type MeetingSorenSlot = 'memory' | 'recap' | 'time' | 'emotion' | 'voice' | 'length' | 'soren' | ChatSorenSlot | CallSorenSlot;

/**
 * 私聊的 Soren 佔位（plans/preset-library.md 第 2 批，填法見 utils/chatPresetSession.ts）。
 * - 資料：關係與印象、日記與彼方、實時狀態（預設沒放就補；實時狀態補在聊天記錄後面）
 * - 功能：聊天格式、表情包、引用、動作、互動、語音、模式（預設沒放就補；預設裡有、但關掉的＝明確不要，不補）
 */
export type ChatSorenSlot =
    | 'chatRelation' | 'chatLife' | 'chatLive'
    | 'chatFormat' | 'chatEmoji' | 'chatQuote' | 'chatActions' | 'chatInteract' | 'chatVoice' | 'chatModes';

/**
 * 電話的 Soren 佔位（第 3a 批，填法見 utils/callPresetSession.ts）：
 * 場景（你是誰、電話那頭是誰、此刻在做什麼）、格式（歷史來源標記＋底線）、語音（演出標記＋語種翻譯）、
 * 視訊（模型表演、鏡頭）、模式（思考鏈）。記憶、情緒、時間、其它沿用見面那幾格。
 */
export type CallSorenSlot = 'callScene' | 'callFormat' | 'callVoice' | 'callVideo' | 'callModes';

export type MeetingPresetSlot = MeetingStSlot | MeetingSorenSlot;

export type MeetingPromptRole = 'system' | 'user' | 'assistant';

export interface MeetingPresetPrompt {
    /** ST 的 identifier */
    id: string;
    name: string;
    enabled: boolean;
    role: MeetingPromptRole;
    content: string;
    /** 資料佔位：有的話 content 不用，由 Soren 填 */
    slot?: MeetingPresetSlot;
    /** 有的話插進聊天記錄（ST 的 injection_position = 1）：depth 0 在最後一則之後 */
    inChat?: { depth: number; order: number };
}

/** ST 正則腳本，欄位名照 ST（extensions/regex）。placement：1 用戶輸入、2 AI 輸出、5 世界書、6 思考。 */
export interface MeetingRegexScript {
    id: string;
    scriptName: string;
    findRegex: string;
    replaceString: string;
    trimStrings: string[];
    placement: number[];
    disabled: boolean;
    markdownOnly: boolean;
    promptOnly: boolean;
    runOnEdit: boolean;
    substituteRegex: number;
    minDepth: number | null;
    maxDepth: number | null;
}

export interface MeetingPresetGroup {
    id: string;
    name: string;
    promptIds: string[];
}

export interface MeetingPresetGeneration {
    temperature?: number;
    topP?: number;
    topK?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    maxTokens?: number;
}

export interface MeetingPresetDoc {
    schema: 'soren.meeting-preset';
    version: 1;
    name: string;
    generation: MeetingPresetGeneration;
    /** 照送出順序排好 */
    prompts: MeetingPresetPrompt[];
    regexScripts: MeetingRegexScript[];
    /** 只給介面分組用，不影響送出 */
    groups: MeetingPresetGroup[];
    assistantPrefill?: string;
    /** ST 的 wi_format（`{0}` 換成世界書內容） */
    worldInfoFormat?: string;
    /** ST 的 scenario_format / personality_format（`{{scenario}}`／`{{personality}}` 換成內容） */
    scenarioFormat?: string;
    personalityFormat?: string;
    /** `{{getglobalvar::名字}}` 用到的值，用戶在預設設定裡填 */
    globalVars: Record<string, string>;
    /** 適用場景（預設 App 篩選、選單用；plans/preset-library.md）。沒有＝見面（舊資料都是見面的） */
    scenes?: Array<'chat' | 'group' | 'call' | 'date' | 'story'>;
}

/** meeting_presets 表的一列 */
export interface MeetingPresetRecord {
    id: string;
    name: string;
    sourceFileName?: string;
    doc: MeetingPresetDoc;
    createdAt: number;
    updatedAt: number;
}
