/**
 * amsgToolPack — 滿血 v2 服務端工具循環的雲端狀態數據形狀（前端 / amsg worker 共用）
 *
 * fire_pack 解決「到點拿什麼 prompt」，這裡解決「到點跑工具要什麼數據」：
 *   - tool_pack（每角色，namespace `amsg:char:<id>`）：recall 要讀的月度總結、
 *     XHS 角色開關、日記查詢要用的角色名。
 *   - tool_config（全局，namespace `amsg:global`）：搜索 / Notion / 飛書憑據、
 *     XHS MCP 配置、代理 worker 地址——即 agenticTools 各工具從 realtimeConfig
 *     裡讀的那個子集，多一分都不上雲。
 *
 * 兩份都由前端在 amsgStateSync 沖刷時與 fire_pack 同批 putClientState（tool_pack
 * 上傳前過 packStateValue，夠大會壓成 gz1: 前綴）；worker 在 onBeforeFire 先解壓再
 * 解析，任何一份解不出來都按雲端狀態異常拋 AMSG2_FIRE_STATE_MISSING 硬失敗，不降級。
 *
 * 環境無關葉子模塊：不 import 任何帶瀏覽器依賴的東西（會進 worker bundle）。
 */

import type { CharacterProfile, RealtimeConfig } from '../types';
import type { AgenticToolMemory, AgenticToolRealtimeConfig } from './agenticTools';
import type { McpFireServer } from './mcpFireCore';
import { getProxyWorkerUrl } from './proxyWorker';

export const AMSG_TOOL_PACK_KEY = 'tool_pack';
export const AMSG_GLOBAL_NAMESPACE = 'amsg:global';
export const AMSG_TOOL_CONFIG_KEY = 'tool_config';

/** recall / 日記 / XHS 門控要用的角色側數據（CharacterProfile 的極小子集）。 */
export interface AmsgToolPack {
  v: 1;
  charName: string;
  xhsEnabled: boolean;
  activeMemoryMonths: string[];
  memories: AgenticToolMemory[];
  /**
   * 角色的「時間感知」開關。關掉的角色不該知道今天幾號，所以到點注入的實時世界裡
   * 也不給今日節日——這個字段不上雲的話，前台守著的開關一到主動消息就失效。
   */
  timeAwarenessEnabled: boolean;
}

/**
 * 工具憑據與配置（RealtimeConfig 的工具子集 + 代理地址）。
 *
 * 憑據字段表直接繼承 AgenticToolRealtimeConfig——那邊是工具真正會讀的字段，這邊是把它們
 * 上雲的載體，本來就該一模一樣。抄成兩份的話，agenticTools 多讀一個字段而這邊忘了加，
 * worker 到點就靜默拿 undefined（編譯期一聲不吭），正是窄接口想消滅的那類失配。
 */
export interface AmsgToolConfig extends AgenticToolRealtimeConfig {
  v: 1;
  /** 搜索 / Notion / 飛書都經它轉發；worker 端用 setProxyWorkerUrlOverride 注入。 */
  proxyWorkerUrl: string;
  /**
   * 實時天氣：worker 到點自己去拉一次填進提示詞（不是工具，是常駐注入，跟前台一樣）。
   * key 留空走免費的 Open-Meteo，所以只要開關加城市就夠。
   */
  weatherEnabled: boolean;
  weatherCity?: string;
  weatherApiKey?: string;
  /** 熱榜要拉哪幾個平台（繼承來的 newsEnabled 管開關）。留空 worker 用內置默認。 */
  newsPlatforms?: string[];
  /** 上雲這份比工具側多一個 cookie（lite 模式的登錄態），並且兩個開關字段是必填。 */
  xhsMcpConfig?: {
    enabled: boolean;
    serverUrl: string;
    cookie?: string;
    platform?: 'xhs' | 'rednote';
    loggedInUserId?: string;
    loggedInNickname?: string;
    userXsecToken?: string;
  };
  /**
   * 用戶自配的通用 MCP 服務器（enabled 且已發現工具、worker 夠得著的那部分，
   * 見 mcpClient.collectMcpFireServers）。代理字段不上雲——worker 直連沒有 CORS。
   */
  mcpServers?: McpFireServer[];
  /** 前台「原生 tools」開關：false = 中轉拒 tools，worker 退到正文協議。缺省按 true。 */
  mcpUseNativeTools?: boolean;
}

/**
 * CF worker 直連打不通的地址（本機 / 私網 / 鏈路本地）。這類服務器不上雲、也不在
 * 打包給主動消息的提示詞裡出現——上了只會教角色用一個必失敗的工具，然後它把一次
 * 根本沒發生的搜索說成「我剛搜了下，沒啥好東西」。
 *
 * 這是體驗護欄、不是安全邊界：只看字面地址，域名解析到內網之類攔不住。
 * 住在這個葉子裡是因為瀏覽器側（MCP 服務器清單、小紅書配置）和打包鏈路都要用同一份判斷。
 */
export const isWorkerReachableUrl = (url: string): boolean => {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    const h = u.hostname.toLowerCase();
    // 本機與「沒有地址」的佔位地址
    if (h === 'localhost' || h === '0.0.0.0' || h === '[::]' || h === '[::1]') return false;
    // 只在局域網裡能解析的域名後綴（my-nas.local、foo.localhost）
    if (/\.(local|localhost)$/.test(h)) return false;
    // IPv4 迴環 / 私網 / 鏈路本地
    if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h)) return false;
    // IPv6 唯一本地地址 fc00::/7（首段以 fc / fd 開頭，hostname 帶方括號）
    if (/^\[f[cd]/.test(h)) return false;
    return true;
  } catch { return false; }
};

export const buildToolPack = (char: CharacterProfile): AmsgToolPack => ({
  v: 1,
  charName: char.name,
  xhsEnabled: !!char.xhsEnabled,
  activeMemoryMonths: char.activeMemoryMonths || [],
  // id 等工具用不到的字段不上雲；runRecall 只讀 date / mood / summary。
  memories: (char.memories || []).map((mem) => ({
    date: mem.date,
    summary: mem.summary,
    ...(mem.mood ? { mood: mem.mood } : {}),
  })),
  // 前台的判定是「沒顯式關就算開」，這邊照抄同一句，別讓同一個開關兩處讀出不同結果。
  timeAwarenessEnabled: char.timeAwarenessEnabled !== false,
});

/**
 * mcp 參數由瀏覽器側調用方現讀現傳（本模塊是環境無關葉子，不能自己碰 localStorage）。
 * 不傳就一個 mcp 字段都不寫——老 worker 解析這份配置時零影響。
 */
export const buildToolConfig = (
  realtimeConfig: RealtimeConfig | undefined,
  mcp?: { servers: McpFireServer[]; useNativeTools: boolean },
): AmsgToolConfig => {
  const rc = realtimeConfig;
  const xhs = rc?.xhsMcpConfig;
  return {
    v: 1,
    proxyWorkerUrl: getProxyWorkerUrl(),
    weatherEnabled: !!rc?.weatherEnabled,
    ...(rc?.weatherCity ? { weatherCity: rc.weatherCity } : {}),
    ...(rc?.weatherApiKey ? { weatherApiKey: rc.weatherApiKey } : {}),
    newsEnabled: !!rc?.newsEnabled,
    ...(rc?.newsApiKey ? { newsApiKey: rc.newsApiKey } : {}),
    ...(rc?.newsPlatforms?.length ? { newsPlatforms: rc.newsPlatforms } : {}),
    notionEnabled: !!rc?.notionEnabled,
    ...(rc?.notionApiKey ? { notionApiKey: rc.notionApiKey } : {}),
    ...(rc?.notionDatabaseId ? { notionDatabaseId: rc.notionDatabaseId } : {}),
    ...(rc?.notionNotesDatabaseId ? { notionNotesDatabaseId: rc.notionNotesDatabaseId } : {}),
    feishuEnabled: !!rc?.feishuEnabled,
    ...(rc?.feishuAppId ? { feishuAppId: rc.feishuAppId } : {}),
    ...(rc?.feishuAppSecret ? { feishuAppSecret: rc.feishuAppSecret } : {}),
    ...(rc?.feishuBaseId ? { feishuBaseId: rc.feishuBaseId } : {}),
    ...(rc?.feishuTableId ? { feishuTableId: rc.feishuTableId } : {}),
    // 小紅書服務器多半就跑在用戶自己電腦上（localhost:xxxx）。worker 從 CF 那頭連不上，
    // 這份配置上了雲也只是讓角色去撞一次必失敗的調用，所以夠不著的乾脆不帶。
    ...(xhs?.serverUrl && isWorkerReachableUrl(xhs.serverUrl)
      ? {
          xhsMcpConfig: {
            enabled: !!xhs.enabled,
            serverUrl: xhs.serverUrl,
            ...(xhs.cookie ? { cookie: xhs.cookie } : {}),
            ...(xhs.platform ? { platform: xhs.platform } : {}),
            ...(xhs.loggedInUserId ? { loggedInUserId: xhs.loggedInUserId } : {}),
            ...(xhs.loggedInNickname ? { loggedInNickname: xhs.loggedInNickname } : {}),
            ...(xhs.userXsecToken ? { userXsecToken: xhs.userXsecToken } : {}),
          },
        }
      : {}),
    ...(mcp?.servers.length ? { mcpServers: mcp.servers, mcpUseNativeTools: mcp.useNativeTools } : {}),
  };
};

/** 雲端 tool_pack 字符串 → 結構；形狀不對返回 null（fire 鏈按無工具數據繼續）。 */
export const parseToolPack = (value: string): AmsgToolPack | null => {
  try {
    const parsed = JSON.parse(value);
    if (
      !parsed || typeof parsed !== 'object' ||
      parsed.v !== 1 ||
      typeof parsed.charName !== 'string' ||
      typeof parsed.timeAwarenessEnabled !== 'boolean' ||
      !Array.isArray(parsed.activeMemoryMonths) ||
      !Array.isArray(parsed.memories)
    ) {
      return null;
    }
    return parsed as AmsgToolPack;
  } catch {
    return null;
  }
};

/** 雲端 tool_config 字符串 → 結構；形狀不對返回 null。 */
export const parseToolConfig = (value: string): AmsgToolConfig | null => {
  try {
    const parsed = JSON.parse(value);
    if (
      !parsed || typeof parsed !== 'object' ||
      parsed.v !== 1 ||
      typeof parsed.proxyWorkerUrl !== 'string'
    ) {
      return null;
    }
    // MCP 清單是列表，壞條目單獨丟掉就行——整份判 null 會連搜索/Notion 憑據一起賠進去。
    const cleaned = Array.isArray(parsed.mcpServers)
      ? parsed.mcpServers.filter((s: any) =>
          s && typeof s === 'object' &&
          typeof s.id === 'string' && typeof s.name === 'string' &&
          typeof s.url === 'string' && Array.isArray(s.tools))
      : undefined;
    // 丟東西要留痕：不然「角色怎麼不調這個工具了」只能靠猜。
    if (cleaned && cleaned.length !== parsed.mcpServers.length) {
      console.warn('[amsg:tool_config] MCP 清單有條目形狀不對，已丟棄',
        parsed.mcpServers.length - cleaned.length);
    }
    if (cleaned?.length) {
      parsed.mcpServers = cleaned;
    } else {
      // 兩個字段同進同退（與 buildToolConfig 一致）：沒有服務器時留個開關沒有意義。
      delete parsed.mcpServers;
      delete parsed.mcpUseNativeTools;
    }
    return parsed as AmsgToolConfig;
  } catch {
    return null;
  }
};
