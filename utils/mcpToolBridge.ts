/**
 * 通用 MCP → 聊天工具循環 的橋接層（對標 luckinToolBridge 的角色分工）
 *
 * 職責：
 * 1. 把所有啟用 MCP 服務器的已發現工具聚合成 OpenAI function-calling 格式
 * 2. 生成注入 systemPrompt 的說明塊與尾部提醒
 * 3. 中轉不認 function calling 時的兼容兜底（降級請求體、前置氣泡粗洗）
 * 重名映射和正文假調用解析住在 mcpFireCore（瀏覽器與 amsg worker 共用）。
 * 工具循環本體在 hooks/useChatAI.ts（對標 luckinChat 循環）。
 */

import { getEnabledMcpServers, type McpServerConfig, type McpToolDef } from './mcpClient';
import { buildMcpNameMap, type FakedMcpCall as FakedMcpCallCore, type McpResolvedToolCore } from './mcpFireCore';

// 結果格式化和正文假調用解析都是純邏輯，住在 mcpFireCore 裡給瀏覽器和 amsg
// worker 共用；這裡按原名轉出來，調用方的引用路徑不用動。
export {
    MCP_RESULT_MAX_CHARS,
    formatMcpToolResult,
    stripTextFakedMcpCalls,
    extractTextFakedMcpCalls,
} from './mcpFireCore';

export interface OpenAIMcpTool {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters?: any;
    };
}

/**
 * 前台 MCP 工具循環硬上限。不是固定調用次數：模型正常回復會立即退出；只有仍在調用工具
 * 才繼續，連續原地重複則提前收束。遊戲/論壇類多步任務最多可推進到 12 輪。
 */
export const MCP_CHAT_MAX_TOOL_LOOPS = 12;
export const MCP_CHAT_MAX_STALLED_ROUNDS = 2;

/** 名映射條目，server 收窄成前台的完整配置類型（含 proxyUrl 等瀏覽器側字段） */
export type ResolvedMcpTool = McpResolvedToolCore<McpServerConfig>;

/** 正文假調用條目，server 收窄成前台完整配置（callMcpTool 要 proxyUrl/proxyKey） */
export type FakedMcpCall = FakedMcpCallCore<McpServerConfig>;

/**
 * 聚合啟用服務器的工具，返回 OpenAI 工具數組 + 暴露名→真實工具 的映射。
 * 暴露名（含重名前綴、非法字符替換）統一由 mcpFireCore.buildMcpNameMap 算，
 * 保證前台聊天和 amsg worker 後台 fire 看到的是同一套工具名。
 * charId：只聚合對該角色可見的服務器（通用 + 綁定了該角色的）。
 */
export const buildMcpOpenAITools = (charId?: string): { tools: OpenAIMcpTool[]; resolve: Map<string, ResolvedMcpTool> } => {
    const servers = getEnabledMcpServers(charId);
    const resolve: Map<string, ResolvedMcpTool> = buildMcpNameMap(servers);
    const tools: OpenAIMcpTool[] = [];
    for (const [exposed, { server, tool }] of resolve) {
        tools.push({
            type: 'function',
            function: {
                name: exposed,
                description: buildToolDescription(server, tool, servers.length > 1),
                parameters: tool.inputSchema || { type: 'object', properties: {} },
            },
        });
    }
    return { tools, resolve };
};

const buildToolDescription = (server: McpServerConfig, t: McpToolDef, multi: boolean): string => {
    const desc = (t.description || '').trim();
    // 多服務器時在描述裡帶上來源，幫模型區分同類工具
    return multi ? `[${server.name}] ${desc}` : desc;
};

// ========== 提示詞 ==========

/**
 * MCP 工具模式的 systemPrompt 說明塊。
 * 與瑞幸不同：這裡的工具是用戶自配的、內容未知，所以只講紀律，不講業務流程。
 * charId：只列對該角色可見的服務器，與 buildMcpOpenAITools 的過濾保持一致。
 */
export const buildMcpSystemBlock = (userName: string = '用戶', charId?: string): string => {
    const servers = getEnabledMcpServers(charId);
    if (!servers.length) return '';
    const lines = servers.map(s => {
        const names = (s.tools || []).map(t => t.name).join('、');
        return `- ${s.name}: ${names}`;
    });
    return `

---
[外部工具已接入 —— ${userName} 在設置裡給你連了 MCP 工具服務器]

**核心**: 你還是原來的角色、原來的語氣、原來的記憶。工具只是你順手能用的能力，**每輪都要有角色化的文字**，別乾巴巴報結果。

可用工具來源:
${lines.join('\n')}

**使用紀律**:
- 需要時直接調工具（系統會自動執行並把結果給你），不需要時正常聊天，**別硬找理由調工具**。
- 用戶明確要求完成遊戲、論壇或其他多步任務時，先做必要檢查，隨後立刻調用能推進目標的動作工具；不要反覆讀取同一份說明或狀態。執行動作後可以再次檢查新狀態，並繼續到目標完成或工具明確失敗。
- 工具必須通過系統的 function calling 接口發起，**絕對不要把工具名和參數寫進聊天正文**（比如輸出 \`工具名(參數)\` 這種文字），用戶會看到亂碼一樣的東西。
- 工具結果只挑與對話相關的部分用角色語氣轉述，別整段復讀 JSON。
- 工具失敗就如實說，並根據報錯調整參數重試或換個方式，別編造結果。
- 涉及真實世界副作用的操作（發佈內容、下單、刪除等），若 ${userName} 本輪已經明確要求執行，即視為已經確認；沒有明確要求時才先確認一句再動手。
---
`;
};

/** 尾部小提醒（注入 messages 末尾，防長對話把紀律沖掉） */
export const MCP_TAIL_REMINDER = `[MCP 工具 ON · 永遠用角色語氣回覆別空回; 工具只能走 function calling 接口、嚴禁寫成正文文字; 工具結果別復讀 JSON; 用戶本輪已明確要求的操作視為已確認，否則副作用操作先確認]`;

// ========== 掉格式容錯: 正文裡的"假工具調用"（解析本體見 mcpFireCore） ==========

/**
 * MCP 工具前置氣泡專用粗洗。該氣泡在統一後處理之前落庫，必須自行清掉模型
 * 復刻的歷史外殼和思考標籤；不能把“用戶發送了表情包”反向變成角色消息。
 */
export const sanitizeMcpLeadInText = (raw: string): string => {
    let cleaned = raw || '';
    cleaned = cleaned.replace(/<(think|thinking|thought)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    cleaned = cleaned.replace(/<(?:think|thinking|thought)\b[^>]*>[\s\S]*$/gi, '');
    cleaned = cleaned.replace(/<\/?(?:think|thinking|thought)\b[^>]*>/gi, '');
    cleaned = cleaned.replace(/\[(?:你|User|用[户戶]|System)\s*[发發]送了表情包[:：]\s*.*?\]/gi, '');
    cleaned = cleaned.replace(/\[\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[^\]]*\]/g, '');
    cleaned = cleaned.replace(/\s*\[(?:聊天|通[话話]|[约約][会會])\]\s*/g, '\n');
    return cleaned.replace(/\n{3,}/g, '\n\n').trim();
};

/**
 * 正文假調用已經由客戶端代為執行，下一跳只負責把結果組織成角色回覆。
 * 這裡必須移除 tools；否則部分中轉會在這一跳改走正規 tool_calls，返回空正文，
 * 而正規工具循環階段已經結束，最終表現就是角色一直打字後不落消息。
 * 不支持 FC 的模型仍可繼續輸出正文假調用，並由同一兜底循環處理多步任務。
 */
export const buildMcpTextFallbackBody = (baseReqBody: any, messages: any[]): any => {
    const followBody = { ...baseReqBody, messages };
    delete followBody.tools;
    delete followBody.tool_choice;
    return followBody;
};

/** tools 被中轉拒絕時，把最小 schema 僅作為本輪兼容說明交給正文調用兜底。 */
export const buildMcpRejectedToolsFallbackBody = (baseReqBody: any): any => {
    const followBody = buildMcpTextFallbackBody(baseReqBody, baseReqBody.messages || []);
    const signatures = (baseReqBody.tools || []).map((tool: any) => {
        const fn = tool?.function || {};
        const schema = fn.parameters || {};
        const required = new Set(Array.isArray(schema.required) ? schema.required : []);
        const args = Object.entries(schema.properties || {}).map(([name, def]: [string, any]) =>
            `${name}${required.has(name) ? '*' : ''}:${def?.type || 'any'}`,
        );
        const description = typeof fn.description === 'string' ? fn.description.trim() : '';
        return `- ${fn.name}(${args.join(', ')})${description ? `：${description}` : ''}`;
    }).filter(Boolean);
    followBody.messages = [...followBody.messages, {
        role: 'system',
        content: `[MCP 兼容模式：當前 API 中轉拒絕 function calling 參數。必須根據下方工具的來源、描述和參數選擇真正匹配用戶意圖的工具，禁止因為名字看起來通用就亂選。每一步如果需要工具，只輸出一行 tool_name({"參數":"值"})，系統會代為執行後把結果給你；收到結果後，若任務還沒完成就選擇下一步真正能推進目標的工具，不要反覆讀取同一份說明或狀態。沒有收到系統返回前不要聲稱工具已經成功，也不要自行編造結果。* 表示必填參數。\n${signatures.join('\n')}]`,
    }];
    return followBody;
};

/** 部分 OpenAI 兼容中轉不是忽略 tools，而是直接用 4xx 拒絕整次請求。 */
export const shouldRetryMcpWithoutTools = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error || '');
    return /(?:^|\D)(?:400|401|403|422)(?:\D|$)/.test(message);
};
