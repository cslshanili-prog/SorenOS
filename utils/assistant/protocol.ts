/**
 * AI 助手 Sore 的工具文字協議（plans/ai-assistant.md 第 4 節）。
 *
 * 模型在回覆裡寫：<tool name="工具名">{"參數": "值"}</tool>，可以一次好幾個。
 * 系統執行完把結果用 <tool_result name="工具名" ok="true">…</tool_result> 當 user 回給它。
 *
 * 不用 API 原生的工具呼叫：很多人用中轉，原生工具支援參差不齊。
 * 解析容錯：標籤沒閉合（寫到一半斷掉）、JSON 有尾逗號或全形引號、參數空白都收；
 * 實在讀不出參數就當空物件，由工具自己回「缺什麼」讓模型重來。
 */

export interface ToolCall {
    name: string;
    args: Record<string, unknown>;
}

export interface ParsedReply {
    /** 給人看的字：拿掉工具標籤、收掉多餘空行 */
    visible: string;
    calls: ToolCall[];
}

const TOOL_RE = /<tool\s+name\s*=\s*["“”']([^"“”']+)["“”']\s*>([\s\S]*?)(?:<\/tool>|$)/gi;

/** 寬鬆讀 JSON：全形引號、尾逗號、前後多餘的字（例如被包在 ``` 裡） */
export const looseJson = (raw: string): Record<string, unknown> => {
    let text = raw.trim();
    if (!text) return {};
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const start = text.indexOf('{');
    if (start === -1) return {};
    const end = text.lastIndexOf('}');
    // 寫到一半斷掉（沒有收尾的 }）：補一個試試
    text = end > start ? text.slice(start, end + 1) : `${text.slice(start)}}`;
    const attempts = [
        text,
        text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"),
        text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,\s*([}\]])/g, '$1'),
    ];
    for (const attempt of attempts) {
        try {
            const value = JSON.parse(attempt);
            return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
        } catch { /* 換下一種 */ }
    }
    return {};
};

export const parseAssistantReply = (text: string): ParsedReply => {
    const calls: ToolCall[] = [];
    const visible = (text || '').replace(TOOL_RE, (_, name: string, body: string) => {
        calls.push({ name: name.trim(), args: looseJson(body) });
        return '';
    }).replace(/<tool_result[\s\S]*?<\/tool_result>/gi, '').replace(/\n{3,}/g, '\n\n').trim();
    return { visible, calls };
};

const escapeAttr = (value: string) => value.replace(/"/g, '＂');

/** 工具結果回給模型的那一則 */
export const formatToolResult = (name: string, ok: boolean, content: string): string =>
    `<tool_result name="${escapeAttr(name)}" ok="${ok ? 'true' : 'false'}">\n${content}\n</tool_result>`;
