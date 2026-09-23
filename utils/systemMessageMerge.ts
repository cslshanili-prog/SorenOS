/**
 * 把請求裡的多條 role:system 合併成開頭一條（dev-debug 排障用）。
 *
 * SullyOS 的聊天請求默認是三段式：[穩定 system, ...歷史, 易變 system]（外加雙語 /
 * MCP 提醒條也可能是 system）。正規 OpenAI→Claude 兼容層會正確歸併多條 system，
 * 但社區逆向的適配層可能在處理歷史之後的 system 時重複拼接前文，導致 prompt_tokens
 * 異常膨脹。這個純函數配合 devDebug 的 mergeSystemMessages 開關做 A/B 對照：
 * 合併後計費驟降 → 中轉適配層問題坐實；不變 → 是計量（tokenizer）口徑問題。
 *
 * 語義代價（所以只做臨時開關、默認關）：易變尾段本該貼著生成點注入以獲得 recency
 * 注意力，合併進頭部會削弱這一設計，且改變穩定前綴 → 前綴緩存整體失效。
 */

export interface ChatMessageLike {
    role: string;
    content: any;
}

/**
 * 所有 system 的內容按出現順序用空行拼接，放到開頭一條；非 system 消息保持相對順序。
 * 只有 0/1 條 system 時原樣返回（不做無謂的數組重建）。
 */
export function mergeSystemMessages<T extends ChatMessageLike>(messages: T[]): T[] {
    const systems = messages.filter(m => m.role === 'system');
    if (systems.length <= 1) return messages;
    const merged = systems
        .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
        .filter(part => part && part.trim())
        .join('\n\n');
    const rest = messages.filter(m => m.role !== 'system');
    return [{ ...systems[0], content: merged }, ...rest];
}
