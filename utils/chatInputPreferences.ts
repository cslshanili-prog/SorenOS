/** 當前設備上的私聊與群聊共用的輸入習慣。 */
export interface ChatInputPreferences {
    sendButtonGenerates: boolean;
    enterToSend: boolean;
    autoReply: boolean;
    emojiSuggestions: boolean;
}

export const CHAT_INPUT_PREFERENCES_KEY = 'sully-chat-input-preferences-v1';

export const DEFAULT_CHAT_INPUT_PREFERENCES: ChatInputPreferences = {
    sendButtonGenerates: false,
    enterToSend: true,
    autoReply: false,
    emojiSuggestions: false,
};

/** 導入與讀取共用：只接收已知布爾字段；新增功能對舊存檔默認關閉。 */
export const normalizeChatInputPreferences = (value: unknown): ChatInputPreferences => {
    const saved = value && typeof value === 'object' ? value as Partial<ChatInputPreferences> : {};
    return {
        sendButtonGenerates: saved.sendButtonGenerates === true,
        enterToSend: saved.enterToSend !== false,
        autoReply: saved.autoReply === true,
        emojiSuggestions: saved.emojiSuggestions === true,
    };
};

export const loadChatInputPreferences = (): ChatInputPreferences => {
    try {
        const saved = JSON.parse(localStorage.getItem(CHAT_INPUT_PREFERENCES_KEY) || 'null');
        return normalizeChatInputPreferences(saved);
    } catch {
        return { ...DEFAULT_CHAT_INPUT_PREFERENCES };
    }
};

export const saveChatInputPreferences = (preferences: ChatInputPreferences): void => {
    try {
        localStorage.setItem(CHAT_INPUT_PREFERENCES_KEY, JSON.stringify(normalizeChatInputPreferences(preferences)));
    } catch {
        // 存儲不可用的 WebView 中仍允許在當前會話使用。
    }
};
