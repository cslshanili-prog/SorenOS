/**
 * 通用 MCP 客戶端 (Model Context Protocol, Streamable HTTP)
 *
 * 與 mcdMcpClient / luckinMcpClient 的「一家一個客戶端」不同，這裡是用戶
 * 自配的任意遠程 MCP 服務器：設置裡填 URL（+ 可選 Bearer Token / 自定義頭），發現工具後
 * 以 OpenAI function-calling 格式注入聊天請求，工具循環見 useChatAI。
 *
 * 網絡路徑（用戶三選一，見 docs/mcp-client.md）：
 * 1. 直連 —— MCP 服務器 CORS 配置正確時（能讀到 Mcp-Session-Id 響應頭）
 * 2. 本地代理 —— node scripts/mcp-proxy.mjs，代理 URL 填 http://localhost:18061
 * 3. 用戶自己的 Cloudflare Worker —— worker/mcp-proxy/，部署到用戶自己的帳號
 * 代理約定統一為 <代理URL>?target=<url-encoded 服務器URL>，可選 X-Proxy-Key 頭。
 * 刻意不走中心 sfworker：MCP 流量（含用戶的 Bearer Token）不該過項目方的服務器。
 *
 * JSON-RPC 收發本體（握手、SSE、tools/call、參數還原）住在環境無關葉子
 * mcpFireCore，瀏覽器和 amsg worker 共用；這裡只補瀏覽器側的配置、代理包裝和會話表。
 */

import {
    callMcpToolCore,
    createMcpSessionState,
    discoverMcpToolsCore,
    normalizeMcpToolArguments,
    MCP_REQUEST_TIMEOUT_MS,
    type McpFireServer,
    type McpSessionState,
    type McpToolResult,
    type McpTransportTarget,
} from './mcpFireCore';
import { isWorkerReachableUrl } from './amsgToolPack';

export { MCP_REQUEST_TIMEOUT_MS, normalizeMcpToolArguments };
export type { McpToolResult };

export interface McpToolDef {
    name: string;
    title?: string;
    description?: string;
    inputSchema?: any;
    outputSchema?: any;
    annotations?: {
        title?: string;
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
    };
}

export interface McpCustomHeader {
    name: string;
    value: string;
}

export interface McpServerConfig {
    id: string;
    name: string;
    url: string;
    /** Bearer Token，可選（Authorization: Bearer <token>） */
    token?: string;
    /** 額外請求頭，可選（例如 X-API-Key / XBY-APIKEY） */
    customHeaders?: McpCustomHeader[];
    /** 代理 URL，可選。空 = 瀏覽器直連 */
    proxyUrl?: string;
    /** 自部署 Worker 的防白嫖密鑰，可選（X-Proxy-Key 頭） */
    proxyKey?: string;
    enabled: boolean;
    /** 「發現工具」後持久化的工具清單（聊天注入直接讀這裡，不用每次握手） */
    tools?: McpToolDef[];
    /** 最近一次真實握手的診斷快照；連接字段變化時會清掉，避免展示假綠燈。 */
    lastConnection?: {
        testedAt: number;
        protocolVersion: string;
        serverName?: string;
        serverVersion?: string;
    };
    /**
     * 綁定聊天：空/缺省 = 通用（所有私聊和群聊可用）；非空 = 只有這些角色/群聊能用。
     * 為兼容已有本地配置沿用 charIds 字段名，數組項也可以是 GroupProfile.id。
     * 老配置沒有該字段，天然落在通用語義上。
     */
    charIds?: string[];
    updatedAt: number;
}

const MCP_SERVERS_KEY = 'aetheros.mcp.servers';
const MCP_USE_NATIVE_TOOLS_KEY = 'aetheros.mcp.useNativeTools';

// ========== 服務器配置 (持久化在 localStorage) ==========

export const loadMcpServers = (): McpServerConfig[] => {
    try {
        const raw = localStorage.getItem(MCP_SERVERS_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
};

export const saveMcpServers = (servers: McpServerConfig[]): void => {
    try { localStorage.setItem(MCP_SERVERS_KEY, JSON.stringify(servers)); } catch { /* ignore */ }
};

/** 當前聊天模型/中轉是否支持 OpenAI function calling；默認支持。 */
export const getMcpUseNativeTools = (): boolean => {
    try { return localStorage.getItem(MCP_USE_NATIVE_TOOLS_KEY) !== '0'; }
    catch { return true; }
};

export const setMcpUseNativeTools = (enabled: boolean): void => {
    try { localStorage.setItem(MCP_USE_NATIVE_TOOLS_KEY, enabled ? '1' : '0'); } catch { /* ignore */ }
};

export const createMcpServer = (name: string, url: string): McpServerConfig => ({
    id: `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    url,
    enabled: false,
    updatedAt: Date.now(),
});

/**
 * 啟用且已發現工具、且對當前聊天可見的服務器。
 * charId 可傳角色 ID 或群聊 ID；缺省時只返回通用服務器，保證沒有聊天上下文
 * 的調用點不會洩漏綁定服務器的工具。
 */
export const getEnabledMcpServers = (charId?: string): McpServerConfig[] =>
    loadMcpServers().filter(s =>
        s.enabled && s.url && (s.tools?.length || 0) > 0 &&
        (!s.charIds?.length || (charId != null && s.charIds.includes(charId))),
    );

/** 有任何一個啟用且已發現工具、對該角色可見的服務器 → 聊天進入 MCP 工具模式 */
export const isMcpChatAvailable = (charId?: string): boolean => getEnabledMcpServers(charId).length > 0;

// CF worker 夠不夠得著的判斷搬去了 utils/amsgToolPack.ts —— 小紅書配置那邊要用同一份。

/**
 * 這個聊天裡有沒有「本地用得上、但 worker 夠不著」的服務器（localhost / 私網 / *.local
 * 這類，判據見 amsgToolPack.isWorkerReachableUrl）。
 *
 * 誰在乎：即時對話那一輪的 prompt 是交給 worker 補 MCP 說明的，前端這份整段不注入
 * （chatRequestPayload 的 timelyByWorker 分支）；而上雲的清單 collectMcpFireServers
 * 恰好把這類地址過濾掉了。兩邊都不說 = 角色這一輪徹底不知道自己有工具，設置頁卻還
 * 顯示「已連接」。所以有這種服務器時那一輪別上雲，留在本地跑（本地連得上 localhost，
 * 工具照常用），見 useChatAI 的 instantChatVeto。
 *
 * 口徑跟 isMcpChatAvailable 同源（都走 getEnabledMcpServers）：本地這一輪真會寫進
 * prompt 的是哪幾台，就拿哪幾台來判，別把別的角色綁定的服務器算進來。
 */
export const hasWorkerUnreachableMcpServer = (charId?: string): boolean =>
    getEnabledMcpServers(charId).some((s) => !isWorkerReachableUrl(s.url));

/**
 * 上雲給 amsg worker 用的服務器子集。注意不走 getEnabledMcpServers：
 * 那個函數缺 charId 時只回通用服務器，而這裡要的是全部 enabled（含綁定角色的），
 * charIds 原樣帶上、由 worker 在 fire 時按角色過濾。
 *
 * 帶上 token/customHeaders：走的是 client_state 端到端加密通道、落在用戶自己的
 * amsg worker（不是項目方服務器，與文件頭「不走中心 sfworker」的原則不衝突），
 * 與 notion/飛書憑據同一信任模型。
 */
export const collectMcpFireServers = (): McpFireServer[] =>
    loadMcpServers()
        .filter((s) => s.enabled && s.url && (s.tools?.length || 0) > 0 && isWorkerReachableUrl(s.url))
        .map((s) => {
            // 無人值守的後台沒有確認彈窗：服務端明確標成 destructive 的工具只留在
            // 前台並自動詢問，不把提示詞當權限系統，也不額外暴露用戶配置項。
            const backgroundTools = (s.tools || []).filter((t) => t.annotations?.destructiveHint !== true);
            return {
                id: s.id, name: s.name, url: s.url,
                ...(s.token ? { token: s.token } : {}),
                ...(s.customHeaders?.length ? { customHeaders: s.customHeaders } : {}),
                ...(s.charIds?.length ? { charIds: s.charIds } : {}),
                tools: backgroundTools.map((t) => ({
                    name: t.name,
                    title: t.title,
                    description: t.description,
                    inputSchema: t.inputSchema,
                    outputSchema: t.outputSchema,
                    annotations: t.annotations,
                })),
            };
        })
        .filter((s) => s.tools.length > 0);

// ── 備份用：隨「設置 → 導出/導入備份」一起帶走（存 localStorage） ──
export function exportMcpLocal(): Record<string, string> | undefined {
    try {
        const out: Record<string, string> = {};
        const servers = localStorage.getItem(MCP_SERVERS_KEY);
        const useNativeTools = localStorage.getItem(MCP_USE_NATIVE_TOOLS_KEY);
        if (servers) out[MCP_SERVERS_KEY] = servers;
        if (useNativeTools) out[MCP_USE_NATIVE_TOOLS_KEY] = useNativeTools;
        return Object.keys(out).length ? out : undefined;
    } catch { return undefined; }
}
export function importMcpLocal(data: Record<string, string> | null | undefined): void {
    if (!data || typeof data !== 'object') return;
    try {
        if (typeof data[MCP_SERVERS_KEY] === 'string') localStorage.setItem(MCP_SERVERS_KEY, data[MCP_SERVERS_KEY]);
        if (typeof data[MCP_USE_NATIVE_TOOLS_KEY] === 'string') localStorage.setItem(MCP_USE_NATIVE_TOOLS_KEY, data[MCP_USE_NATIVE_TOOLS_KEY]);
    } catch { /* ignore */ }
}

// ========== JSON-RPC 會話狀態 (內存, 每服務器一份) ==========

const sessions = new Map<string, McpSessionState>();

const getSession = (serverId: string): McpSessionState => {
    let s = sessions.get(serverId);
    if (!s) {
        s = createMcpSessionState();
        sessions.set(serverId, s);
    }
    return s;
};

export const resetMcpSession = (serverId: string): void => {
    sessions.delete(serverId);
};

/** 實際請求地址：配了代理就包成 <proxy>?target=<url>，沒配就直連 */
export const buildMcpFetchUrl = (server: Pick<McpServerConfig, 'url' | 'proxyUrl'>): string => {
    const proxy = (server.proxyUrl || '').trim().replace(/\/+$/, '');
    if (!proxy) return server.url;
    const sep = proxy.includes('?') ? '&' : '?';
    return `${proxy}${sep}target=${encodeURIComponent(server.url)}`;
};

/**
 * 組裝 MCP 請求頭。自定義頭在 Bearer / session 等託管字段之前寫入，因此用戶
 * 可以在不填 Bearer Token 時自定義 Authorization，但不會意外覆蓋當前 session。
 * 走代理時額外帶一份“需要透傳的頭名”清單，代理據此只放行用戶明確配置的頭。
 */
export const buildMcpRequestHeaders = (
    server: Pick<McpServerConfig, 'token' | 'customHeaders' | 'proxyUrl' | 'proxyKey'>,
    sessionId?: string | null,
    protocolVersion?: string | null,
): Headers => {
    const headers = new Headers({
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
    });
    const customNames: string[] = [];
    for (const item of server.customHeaders || []) {
        const name = String(item?.name || '').trim();
        const value = String(item?.value || '').trim();
        if (!name || !value) continue;
        try {
            headers.set(name, value);
            customNames.push(name);
        } catch {
            // 非法 HTTP 頭名/值留給設置頁繼續編輯，不讓整條 MCP 請求在 fetch 前崩掉。
        }
    }
    if (server.token) headers.set('Authorization', `Bearer ${server.token}`);
    if (server.proxyUrl && server.proxyKey) headers.set('X-Proxy-Key', server.proxyKey);
    if (server.proxyUrl && customNames.length) headers.set('X-MCP-Forward-Headers', customNames.join(','));
    if (sessionId) headers.set('Mcp-Session-Id', sessionId);
    if (protocolVersion) headers.set('MCP-Protocol-Version', protocolVersion);
    return headers;
};

/** 一次請求的目標：代理包裝和請求頭都是瀏覽器側獨有的，在這裡落地後交給 core。 */
const targetFor = (server: McpServerConfig): McpTransportTarget => ({
    url: buildMcpFetchUrl(server),
    headers: (sessionId, protocolVersion) => buildMcpRequestHeaders(server, sessionId, protocolVersion),
    // 直連時 fetch 拋 TypeError 十有八九是 CORS，把排查方向直接告訴用戶
    fetchErrorHint: server.proxyUrl
        ? '請檢查代理 URL 是否可訪問、代理密鑰是否正確。'
        : '很可能是瀏覽器 CORS 限制。請在這個服務器的「代理 URL」裡配置代理（本地 node scripts/mcp-proxy.mjs 或自部署 worker/mcp-proxy）。',
});

// ========== 公開 API ==========

/** 握手 + tools/list。調用方負責把返回的工具清單存回 McpServerConfig.tools */
export type McpConnectionStage = 'initialize' | 'tools';

export const discoverMcpTools = async (
    server: McpServerConfig,
    onStage?: (stage: McpConnectionStage) => void,
): Promise<McpToolDef[]> => {
    resetMcpSession(server.id);
    return discoverMcpToolsCore(targetFor(server), getSession(server.id), MCP_REQUEST_TIMEOUT_MS, { onStage });
};

/**
 * 調用一個工具（會自動補握手；session 失效自動重試一次）。
 * 重試前的會話重置是 core 就地做的，改的就是這張表裡的那個對象，兩邊不會走岔。
 */
export const callMcpTool = async (
    server: McpServerConfig,
    toolName: string,
    args: Record<string, any> = {},
): Promise<McpToolResult> => {
    const tool = (server.tools || []).find(item => item.name === toolName);
    const needsApproval = tool?.annotations?.destructiveHint === true;
    if (needsApproval && typeof window !== 'undefined') {
        let argsPreview = '';
        try { argsPreview = JSON.stringify(args, null, 2).slice(0, 600); }
        catch { argsPreview = String(args).slice(0, 600); }
        const approved = window.confirm(
            `Sully 想通過「${server.name || '未命名服務器'}」調用 ${tool?.title || toolName}。\n\n` +
            `${argsPreview || '這次調用沒有參數。'}\n\n允許這一次嗎？`,
        );
        if (!approved) return { success: false, error: '用戶拒絕了這次 MCP 調用。' };
    }
    return callMcpToolCore(targetFor(server), getSession(server.id), toolName, args, {
        inputSchema: (server.tools || []).find(tool => tool.name === toolName)?.inputSchema,
        serverLabel: server.name,
    });
};

/** 測試連接: 驗證握手 + tools/list 能通，返回工具清單供持久化 */
export const testMcpConnection = async (
    server: McpServerConfig,
    onStage?: (stage: McpConnectionStage) => void,
): Promise<{
    ok: boolean;
    message: string;
    tools?: McpToolDef[];
    connection?: NonNullable<McpServerConfig['lastConnection']>;
}> => {
    try {
        const tools = await discoverMcpTools(server, onStage);
        const session = getSession(server.id);
        const info = session.serverInfo;
        const connection: NonNullable<McpServerConfig['lastConnection']> = {
            testedAt: Date.now(),
            protocolVersion: session.protocolVersion || '未知',
            ...(info?.title || info?.name ? { serverName: info.title || info.name } : {}),
            ...(info?.version ? { serverVersion: info.version } : {}),
        };
        const serverLabel = connection.serverName
            ? `${connection.serverName}${connection.serverVersion ? ` ${connection.serverVersion}` : ''}`
            : '服務器';
        if (!tools.length) return {
            ok: true,
            message: `${serverLabel}已響應 · 協議 ${connection.protocolVersion} · 工具清單為空`,
            tools,
            connection,
        };
        return {
            ok: true,
            message: `${serverLabel}已響應 · 協議 ${connection.protocolVersion} · 發現 ${tools.length} 個工具`,
            tools,
            connection,
        };
    } catch (e: any) {
        return { ok: false, message: e?.message || String(e) };
    }
};
