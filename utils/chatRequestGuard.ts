type ChatRequestMessage = { role: string; content?: unknown };

/** 只驗證本輪可見消息，不擴張用戶範圍，也不偽造用於繞過上游校驗的用戶消息。 */
export function assertChatHasDialogue(messages: readonly ChatRequestMessage[]): void {
    const hasDialogue = messages.some(message => {
        if (message.role !== 'user' && message.role !== 'assistant') return false;
        if (typeof message.content === 'string') return message.content.trim().length > 0;
        if (!Array.isArray(message.content)) return false;
        return message.content.some(part => {
            if (!part || typeof part !== 'object') return false;
            if (part.type === 'text') return typeof part.text === 'string' && !!part.text.trim();
            if (part.type === 'image_url') return typeof part.image_url?.url === 'string' && !!part.image_url.url.trim();
            return false;
        });
    });
    if (!hasDialogue) {
        throw new Error('暫時沒有找到可以回覆的聊天內容，請再發一條消息。已有聊天和記憶均保留。');
    }
}
