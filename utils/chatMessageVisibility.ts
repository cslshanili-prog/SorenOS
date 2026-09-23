import type { Message } from '../types';

/** 私聊界面的範圍；見面/通話記錄仍保留在庫裡，供各自界面和上下文使用。 */
export const isVisibleChatMessage = (message: Message, hideSystemLogs = false): boolean => (
    !message.groupId
    && message.metadata?.source !== 'date'
    && message.metadata?.source !== 'call'
    && message.metadata?.source !== 'story_theater_memory'
    && !message.metadata?.proactiveHint
    && !(hideSystemLogs && message.role === 'system' && message.type !== 'score_card')
);

/** 點擊後進入私聊的桌面消息卡，與聊天頁共用來源過濾，不展示系統日誌。 */
export const isChatPreviewMessage = (message: Message): boolean => (
    message.role !== 'system' && isVisibleChatMessage(message)
);
