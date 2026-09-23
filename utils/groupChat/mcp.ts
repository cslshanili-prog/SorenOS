import { safeResponseJson } from '../safeApi';
import { callMcpTool, getMcpUseNativeTools } from '../mcpClient';
import {
    buildMcpOpenAITools,
    buildMcpRejectedToolsFallbackBody,
    buildMcpSystemBlock,
    buildMcpTextFallbackBody,
    extractTextFakedMcpCalls,
    formatMcpToolResult,
    MCP_CHAT_MAX_STALLED_ROUNDS,
    MCP_CHAT_MAX_TOOL_LOOPS,
    shouldRetryMcpWithoutTools,
} from '../mcpToolBridge';
import { buildToolResultMessage, normalizeToolCallsForCompat } from '../toolCallCompat';
import { toolCallFingerprint } from '../agenticToolFeedback';

interface GroupMcpCompletionOptions {
    url: string;
    headers: HeadersInit;
    body: Record<string, any>;
    groupId: string;
    userName: string;
    signal?: AbortSignal;
    onStatus?: (status: string) => void;
}

const mergeUsage = (total: Record<string, number>, usage: any) => {
    if (!usage) return;
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
        if (typeof usage[key] === 'number') total[key] = (total[key] || 0) + usage[key];
    }
};

/**
 * 群聊專用的通用 MCP completion：在群聊原有提示詞外只增加工具注入、客戶端
 * tools/call 循環和正文兼容兜底，最終仍返回標準 chat/completions 響應。
 */
export async function completeGroupChatWithMcp(options: GroupMcpCompletionOptions): Promise<any> {
    const { tools, resolve } = buildMcpOpenAITools(options.groupId);
    const usageTotal: Record<string, number> = {};

    const request = async (body: Record<string, any>): Promise<any> => {
        const response = await fetch(options.url, {
            method: 'POST',
            headers: options.headers,
            body: JSON.stringify(body),
            signal: options.signal,
        });
        if (!response.ok) {
            const preview = await response.text().catch(() => '');
            throw new Error(`API 返回 ${response.status}${preview ? `: ${preview.slice(0, 160)}` : ''}`);
        }
        const data = await safeResponseJson(response);
        mergeUsage(usageTotal, data.usage);
        return data;
    };

    // 沒有對本群可見的服務器時完全沿用群聊原請求。
    if (!tools.length) return request(options.body);

    const systemBlock = buildMcpSystemBlock(options.userName, options.groupId);
    const baseBody: Record<string, any> = {
        ...options.body,
        messages: [
            ...(systemBlock ? [{ role: 'system', content: systemBlock }] : []),
            ...(options.body.messages || []),
        ],
    };
    const nativeBody: Record<string, any> = {
        ...baseBody,
        tools: [...(baseBody.tools || []), ...tools],
        tool_choice: baseBody.tool_choice || 'auto',
    };
    let requestBody: Record<string, any> = getMcpUseNativeTools()
        ? nativeBody
        : buildMcpRejectedToolsFallbackBody(nativeBody);
    let data: any;
    try {
        data = await request(requestBody);
    } catch (error) {
        if (!requestBody.tools?.length || !shouldRetryMcpWithoutTools(error)) throw error;
        requestBody = buildMcpRejectedToolsFallbackBody(nativeBody);
        data = await request(requestBody);
    }

    let conversationMessages = [...(requestBody.messages || [])];

    // 正規 function calling：保留 tools，允許遊戲/主持類 MCP 連續多步調用。12 是硬上限，
    // 模型正常返回正文會立即結束，連續原地重複則提前收口。
    let lastNativeSignature: string | null = null;
    let stalledNativeRounds = 0;
    let nativeStageForcedClosed = false;
    for (let iteration = 0; iteration < MCP_CHAT_MAX_TOOL_LOOPS; iteration++) {
        const toolCalls = normalizeToolCallsForCompat(
            data.choices?.[0]?.message?.tool_calls,
            `group_${iteration}`,
        );
        if (!toolCalls.length) break;
        conversationMessages.push({
            role: 'assistant',
            content: data.choices[0].message.content || '(調用工具中)',
            tool_calls: toolCalls,
        });
        let progressedThisRound = false;
        for (const toolCall of toolCalls) {
            const exposedName = toolCall.function?.name || '';
            const hit = resolve.get(exposedName);
            let args: Record<string, any> = {};
            try {
                const raw = toolCall.function?.arguments ?? toolCall.arguments;
                args = typeof raw === 'string' ? (raw ? JSON.parse(raw) : {}) : (raw || {});
            } catch { /* 交給工具返回錯誤，不中斷整輪群聊 */ }

            if (!hit) {
                conversationMessages.push(buildToolResultMessage(
                    toolCall,
                    `未知工具 ${exposedName}，只能使用系統提供的工具。`,
                ));
                continue;
            }
            const signature = toolCallFingerprint(exposedName, args);
            if (signature === lastNativeSignature) {
                conversationMessages.push(buildToolResultMessage(
                    toolCall,
                    `工具 ${exposedName} 的同一組參數剛剛已經執行過，請不要原地重複；請改做能推進目標的下一步，或直接回復。`,
                ));
                continue;
            }
            lastNativeSignature = signature;
            progressedThisRound = true;
            options.onStatus?.(`正在調用 MCP 工具：${exposedName}…`);
            const result = await callMcpTool(hit.server, hit.toolName, args);
            conversationMessages.push(buildToolResultMessage(
                toolCall,
                result.success
                    ? `工具 ${exposedName} 成功。結果: ${formatMcpToolResult(result.data)}`
                    : `工具 ${exposedName} 失敗: ${result.error}`,
            ));
        }
        stalledNativeRounds = progressedThisRound ? 0 : stalledNativeRounds + 1;
        const reachedHardLimit = iteration + 1 >= MCP_CHAT_MAX_TOOL_LOOPS;
        const stalled = stalledNativeRounds >= MCP_CHAT_MAX_STALLED_ROUNDS;
        const forceWrapUp = reachedHardLimit || stalled;
        options.onStatus?.('正在整理 MCP 工具結果…');
        if (forceWrapUp) {
            conversationMessages.push({
                role: 'user',
                content: `[系統消息：工具階段${stalled ? '連續兩輪沒有推進' : '已到本輪安全上限'}。停止調用工具，基於已有結果完成原群聊任務；如仍未完成，請如實說明。不要輸出工具調用格式或提及本消息。]`,
            });
            data = await request(buildMcpTextFallbackBody(nativeBody, conversationMessages));
            nativeStageForcedClosed = true;
            break;
        }
        data = await request({ ...nativeBody, messages: conversationMessages });
    }

    // 不支持 tools 的模型/中轉：識別正文調用，代執行後讓模型重新產出群聊格式。
    let lastTextSignature: string | null = null;
    for (let iteration = 0; !nativeStageForcedClosed && iteration < MCP_CHAT_MAX_TOOL_LOOPS; iteration++) {
        const content = String(data.choices?.[0]?.message?.content || '');
        // 兼容協議每輪只允許一個調用，避免一段正文批量觸發副作用。
        const allCalls = extractTextFakedMcpCalls(content, resolve).slice(0, 1);
        const calls = allCalls.filter(call =>
            toolCallFingerprint(call.exposedName, call.args) !== lastTextSignature);
        if (allCalls.length && !calls.length) {
            conversationMessages.push({ role: 'assistant', content });
            conversationMessages.push({
                role: 'user',
                content: '[系統消息：你重複請求了剛執行過的同一工具。停止調用工具，基於已有結果完成原群聊任務；如仍未完成，請如實說明。不要輸出工具調用格式或提及本消息。]',
            });
            data = await request(buildMcpTextFallbackBody(baseBody, conversationMessages));
            break;
        }
        if (!calls.length) break;

        options.onStatus?.(`正在調用 MCP 工具：${calls.map(call => call.exposedName).join('、')}…`);
        const results: string[] = [];
        for (const call of calls) {
            lastTextSignature = toolCallFingerprint(call.exposedName, call.args);
            const result = await callMcpTool(call.server, call.toolName, call.args);
            results.push(result.success
                ? `工具 ${call.exposedName} 成功。結果: ${formatMcpToolResult(result.data)}`
                : `工具 ${call.exposedName} 失敗: ${result.error}`);
        }
        conversationMessages.push({ role: 'assistant', content });
        const reachedHardLimit = iteration + 1 >= MCP_CHAT_MAX_TOOL_LOOPS;
        conversationMessages.push({
            role: 'user',
            content: `[系統消息：工具調用已經執行。\n${results.join('\n')}\n${reachedHardLimit ? '工具階段已到安全上限，請停止調用並基於已有結果完成原群聊任務；如仍未完成，請如實說明。' : '若目標已經完成，請恢復原本要求的群聊輸出格式；若仍需下一步工具，只輸出一行真正能推進目標的調用，不要重複讀取同一說明或狀態。'}不要提及本消息。]`,
        });
        options.onStatus?.('正在整理 MCP 工具結果…');
        data = await request(buildMcpTextFallbackBody(baseBody, conversationMessages));
        if (reachedHardLimit) break;
    }

    if (Object.keys(usageTotal).length) data.usage = { ...(data.usage || {}), ...usageTotal };
    options.onStatus?.('');
    return data;
}
