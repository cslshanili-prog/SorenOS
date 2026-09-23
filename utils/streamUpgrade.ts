/**
 * 透明流式升級（Transparent Stream Upgrade）
 *
 * 背景：倉庫裡有 40+ 處 LLM 調用點硬編碼 `stream:false`（查手機 / 記憶宮殿 / 日程 /
 * 劇場 / 群聊 / 日記…）。非流式的長生成最容易撞網關/中轉的空閒超時——連接上幾十秒
 * 一個字節都不回，網關掐掉連接，表現為「回覆被截斷 / 半截 JSON」。
 *
 * 做法：在 OSContext 的全局 fetch 攔截器（所有 /chat/completions 的統一出口，與
 * 採樣參數兼容層同一位置）做雙向改寫：
 *   - 請求側：主 API 設置開了 stream 時，把 `stream:false/缺省` 的請求體升級為
 *     `stream:true (+ stream_options.include_usage)`
 *   - 響應側：把 SSE 攢齊拼回標準 chat.completion JSON，再交還調用方
 *
 * 調用方拿到的響應與升級前**字節級等價**（同樣的 choices/usage 結構），但傳輸過程
 * 一直有字節在流，網關不會誤判死連接。已經自己設了 `stream:true` 的調用（聊天主路徑、
 * 見面、情緒評估）不碰——它們各自的解析鏈路（增量預覽 / safeResponseJson）原樣工作。
 *
 * 個別中轉若拒絕 stream/stream_options，錯誤會原樣交給調用方。不能在攔截器裡自動
 * 重發付費生成請求：中轉可能已經把第一份交給上游，靜默重發會造成重複扣費。
 */

import { isSseResponseText, parseSseToCompletion } from './safeApi';

const API_CONFIG_KEY = 'os_api_config';

/** 主 API 設置裡的流式開關（設置 → API → 流式）。讀取失敗一律視為關。 */
export function isGlobalStreamEnabled(): boolean {
    try {
        if (typeof localStorage === 'undefined') return false;
        const raw = localStorage.getItem(API_CONFIG_KEY);
        if (!raw) return false;
        return JSON.parse(raw)?.stream === true;
    } catch {
        return false;
    }
}

/**
 * 把一個 chat/completions 請求體升級為流式。
 * 返回升級後的 body 字符串；不需要升級（已是流式 / 非 JSON / 非對象）返回 null。
 * 注意：調用方負責先判斷全局開關（isGlobalStreamEnabled），本函數保持純粹。
 */
export function upgradeChatBodyToStream(bodyStr: string): string | null {
    let parsed: any;
    try { parsed = JSON.parse(bodyStr); } catch { return null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (parsed.stream === true) return null;  // 調用方自己開了流式：不碰
    parsed.stream = true;
    // include_usage：讓末尾 chunk 帶 usage，token 計費徽標 / API 調用記錄不缺數
    parsed.stream_options = { include_usage: true };
    return JSON.stringify(parsed);
}

/**
 * 把（升級後拿到的）響應歸一化回調用方期待的形態：
 *   - SSE 流 → 攢齊拼裝成標準 chat.completion JSON（Content-Type: application/json）
 *   - 已是 JSON（代理無視 stream）/ 其他文本 → 原文重新包裝（body 已被消費，必須重包）
 * 只在響應 ok 時調用；錯誤響應由調用方原樣透傳給業務層的錯誤處理。
 */
export async function assembleUpgradedResponse(response: Response): Promise<Response> {
    const text = await response.text();
    if (isSseResponseText(text, response.headers.get('content-type'))) {
        const assembled = parseSseToCompletion(text);
        if (assembled) {
            return new Response(JSON.stringify(assembled), {
                status: response.status,
                statusText: response.statusText,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        // 拼不出任何 chunk：按原文透傳，讓調用方的解析器報出帶 preview 的錯誤
    }
    return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: { 'Content-Type': response.headers.get('content-type') || 'application/json' },
    });
}
