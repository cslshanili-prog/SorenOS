/** 續說只作用於這次請求，不偽造或持久化用戶聊天記錄。 */
export function withChatContinuation<T extends { role: string; content: any }>(messages: T[], userName?: string): Array<T | { role: string; content: string }> {
    const lastSpeaker = [...messages].reverse().find(message => message.role === 'user' || message.role === 'assistant');
    if (lastSpeaker?.role !== 'assistant') return messages;
    const name = userName?.trim() || '對方';
    return [...messages, {
        role: 'user',
        content: `[${name}還想聽你接著說。順著剛才的話自然繼續，只寫你自己的話，說完就等${name}回應。]`,
    }];
}
