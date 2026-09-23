/**
 * realtimeFetchCore — 聯網搜索 / Notion / 飛書 的純 fetch 核心（環境無關葉子模塊）
 *
 * 這裡放的是 agenticTools 數據工具會用到的讀取類請求實現：只依賴 fetch 和
 * proxyWorker 的地址解析，不碰 IndexedDB / DOM / localStorage，所以前端
 * （realtimeContext 的 Manager 委託調用）和 amsg worker（服務端工具循環裡
 * 直接調用）共用同一份，行為、文案單份維護。
 *
 * 往這裡加代碼前先確認：不 import 任何帶瀏覽器依賴的模塊（db / keepAlive 等）。
 * `pnpm build:workers` 會把這份打進 amsg worker bundle，帶進瀏覽器依賴會在
 * 構建期直接暴露。
 */

import { getProxyWorkerUrl } from './proxyWorker';

export interface SearchResult {
    title: string;
    description: string;
    url: string;
}

export interface DiaryPreview {
    id: string;
    title: string;
    date: string;
    url: string;
}

export interface FeishuDiaryPreview {
    recordId: string;
    title: string;
    date: string;
    content: string;
}

// ==================== 聯網搜索（Brave，經代理 worker） ====================

/**
 * 主動搜索 - 讓AI角色能夠主動搜索任意內容
 * Active Search - Let AI characters actively search for anything
 *
 * 這個函數任何情況下都不拋異常，網絡異常也會被 catch 成 `success: false`。
 *
 * 光看 `success` 分不清「請求根本沒跑通」和「搜過了，一條都沒有」——兩者都是 false。
 * 調用方要是把它們當成同一件事，角色就會把一次沒發出去的搜索說成「我剛搜了下，沒什麼」。
 * `reached` 就是用來分這兩種的：它為 true 才表示真的問到了搜索服務並拿回一份讀得懂的結果。
 */
export const performSearch = async (query: string, apiKey: string): Promise<{ success: boolean; results: SearchResult[]; message: string; reached: boolean }> => {
    if (!query || !apiKey) {
        return { success: false, results: [], message: '缺少搜索關鍵詞或API Key', reached: false };
    }

    try {
        // 使用自建的 Cloudflare Worker 代理
        const workerUrl = `${getProxyWorkerUrl()}/search?q=${encodeURIComponent(query)}&count=5`;

        const response = await fetch(workerUrl, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'X-Brave-API-Key': apiKey
            }
        });

        // 先讀取 text，避免非 JSON 響應直接 crash
        const text = await response.text();

        // 非 2xx：沒搜成，reached 保持 false
        if (!response.ok) {
            console.error('Search API error:', response.status, text);
            // 嘗試解析錯誤信息
            try {
                const errJson = JSON.parse(text);
                return { success: false, results: [], message: `搜索失敗: ${errJson.error || response.status}`, reached: false };
            } catch {
                return { success: false, results: [], message: `搜索失敗: ${response.status}`, reached: false };
            }
        }

        // 解析 JSON
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            console.error('Search response not JSON:', text.slice(0, 200));
            // 回了東西但讀不懂，等於不知道搜到了什麼，同樣不能算"搜過了"
            return { success: false, results: [], message: '搜索返回格式錯誤', reached: false };
        }

        // Brave Search API 返回結構
        if (data.web?.results && data.web.results.length > 0) {
            const results: SearchResult[] = data.web.results.slice(0, 5).map((item: any) => ({
                title: item.title,
                description: item.description || '',
                url: item.url
            }));
            return { success: true, results, message: '搜索成功', reached: true };
        }

        // 這一條才是真的"搜過了，沒有相關結果"
        return { success: false, results: [], message: '沒有找到相關結果', reached: true };
    } catch (e: any) {
        console.error('Search failed:', e);
        return { success: false, results: [], message: `搜索出錯: ${e.message}`, reached: false };
    }
};

// ==================== Notion（經代理 worker /notion/*） ====================

/**
 * 按日期查找角色的日記（通過 Worker 代理）
 * 支持一天多篇日記，全部返回
 *
 * 不拋異常。`success: false` 只有一個意思：這次查詢沒跑通（憑據不對 / 代理掛了 / 斷網）。
 * 「那天真的沒寫日記」是 `success: true` + `entries` 為空——調用方別把這兩種混成一件事。
 */
export const notionGetDiaryByDate = async (
    apiKey: string,
    databaseId: string,
    characterName: string,
    date: string  // YYYY-MM-DD
): Promise<{ success: boolean; entries: DiaryPreview[]; message: string }> => {
    try {
        const response = await fetch(`${getProxyWorkerUrl()}/notion/query`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Notion-API-Key': apiKey
            },
            body: JSON.stringify({
                database_id: databaseId,
                filter: {
                    and: [
                        {
                            property: 'Name',
                            title: { starts_with: `[${characterName}]` }
                        },
                        {
                            property: 'Date',
                            date: { equals: date }
                        }
                    ]
                },
                sorts: [{ property: 'Date', direction: 'descending' }],
                page_size: 10
            })
        });

        const text = await response.text();

        if (!response.ok) {
            console.error('Query diary by date failed:', response.status, text);
            return { success: false, entries: [], message: `查詢失敗: ${response.status}` };
        }

        const data = JSON.parse(text);

        if (!data.results || data.results.length === 0) {
            return { success: true, entries: [], message: `沒有找到 ${date} 的日記` };
        }

        const entries: DiaryPreview[] = data.results.map((page: any) => {
            const title = page.properties?.Name?.title?.[0]?.plain_text || '無標題';
            const cleanTitle = title.replace(/^\[.*?\]\s*/, '');
            return {
                id: page.id,
                title: cleanTitle,
                date: page.properties?.Date?.date?.start || '',
                url: page.url
            };
        });

        return { success: true, entries, message: `找到 ${entries.length} 篇日記` };
    } catch (e: any) {
        console.error('Get diary by date failed:', e);
        return { success: false, entries: [], message: `查詢失敗: ${e.message}` };
    }
};

/**
 * 讀取日記頁面的完整內容（通過 Worker 代理）
 * 調用 /notion/blocks/:pageId 端點，將 blocks 轉換為可讀文本
 *
 * 不拋異常。`success: false` = 這一篇沒讀到；頁面真的沒寫字是 `success: true` +
 * content 為「（空白日記）」。
 */
export const notionReadDiaryContent = async (
    apiKey: string,
    pageId: string
): Promise<{ success: boolean; content: string; message: string }> => {
    try {
        const response = await fetch(`${getProxyWorkerUrl()}/notion/blocks/${pageId}`, {
            method: 'GET',
            headers: {
                'X-Notion-API-Key': apiKey
            }
        });

        const text = await response.text();

        if (!response.ok) {
            console.error('Read diary content failed:', response.status, text);
            return { success: false, content: '', message: `讀取失敗: ${response.status}` };
        }

        const data = JSON.parse(text);

        if (!data.results || data.results.length === 0) {
            return { success: true, content: '（空白日記）', message: '日記內容為空' };
        }

        // 將 Notion blocks 轉換為可讀文本
        const content = notionBlocksToText(data.results);
        return { success: true, content, message: '讀取成功' };
    } catch (e: any) {
        console.error('Read diary content failed:', e);
        return { success: false, content: '', message: `讀取失敗: ${e.message}` };
    }
};

/**
 * 讀取用戶筆記頁面的完整內容
 * 複用 notionReadDiaryContent 的邏輯（都是通過 pageId 讀 blocks）
 */
export const notionReadNoteContent = notionReadDiaryContent;

/**
 * 按關鍵詞搜索用戶筆記
 *
 * 不拋異常。`success: false` = 這次搜索沒跑通；「沒有這篇筆記」是 `success: true` + entries 為空。
 */
export const notionSearchUserNotes = async (
    apiKey: string,
    notesDatabaseId: string,
    keyword: string,
    limit: number = 5
): Promise<{ success: boolean; entries: DiaryPreview[]; message: string }> => {
    try {
        const response = await fetch(`${getProxyWorkerUrl()}/notion/query`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Notion-API-Key': apiKey
            },
            body: JSON.stringify({
                database_id: notesDatabaseId,
                filter: {
                    property: 'Name',
                    title: { contains: keyword }
                },
                sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
                page_size: limit
            })
        });

        const text = await response.text();

        if (!response.ok) {
            return { success: false, entries: [], message: `搜索失敗: ${response.status}` };
        }

        const data = JSON.parse(text);

        if (!data.results || data.results.length === 0) {
            return { success: true, entries: [], message: `沒有找到關於"${keyword}"的筆記` };
        }

        const entries: DiaryPreview[] = data.results.map((page: any) => {
            const title = page.properties?.Name?.title?.[0]?.plain_text
                || page.properties?.['名稱']?.title?.[0]?.plain_text
                || page.properties?.Title?.title?.[0]?.plain_text
                || '無標題';
            const date = page.properties?.Date?.date?.start
                || page.properties?.['日期']?.date?.start
                || page.last_edited_time?.split('T')[0]
                || '';
            return {
                id: page.id,
                title,
                date,
                url: page.url || ''
            };
        });

        return { success: true, entries, message: `找到 ${entries.length} 篇筆記` };
    } catch (e: any) {
        console.error('Search user notes failed:', e);
        return { success: false, entries: [], message: `搜索失敗: ${e.message}` };
    }
};

/** 將 Notion blocks 轉換為可讀文本（readDiaryContent / readNoteContent 共用） */
export function notionBlocksToText(blocks: any[]): string {
    const lines: string[] = [];

    for (const block of blocks) {
        const type = block.type;

        if (type === 'divider') {
            lines.push('---');
            continue;
        }

        // 提取 rich_text
        const richText = block[type]?.rich_text;
        if (!richText) continue;

        const text = richText.map((rt: any) => rt.plain_text || rt.text?.content || '').join('');
        if (!text.trim()) continue;

        switch (type) {
            case 'heading_1':
                lines.push(`# ${text}`);
                break;
            case 'heading_2':
                lines.push(`## ${text}`);
                break;
            case 'heading_3':
                lines.push(`### ${text}`);
                break;
            case 'quote':
                lines.push(`> ${text}`);
                break;
            case 'callout':
                const emoji = block.callout?.icon?.emoji || '📌';
                lines.push(`${emoji} ${text}`);
                break;
            case 'bulleted_list_item':
                lines.push(`- ${text}`);
                break;
            case 'numbered_list_item':
                lines.push(`· ${text}`);
                break;
            case 'to_do':
                const checked = block.to_do?.checked ? '✅' : '⬜';
                lines.push(`${checked} ${text}`);
                break;
            case 'toggle':
                lines.push(`▶ ${text}`);
                break;
            case 'code':
                lines.push(`\`\`\`\n${text}\n\`\`\``);
                break;
            default:
                lines.push(text);
        }
    }

    return lines.join('\n');
}

// ==================== 飛書多維表格（經代理 worker /feishu/*） ====================

// 飛書 token 緩存
let feishuTokenCache: { token: string; expiresAt: number } | null = null;

/**
 * 獲取飛書 tenant_access_token（通過 Worker 代理，帶緩存）
 */
export const feishuGetToken = async (appId: string, appSecret: string): Promise<{ success: boolean; token: string; message: string }> => {
    // 檢查緩存是否有效 (提前5分鐘過期)
    if (feishuTokenCache && feishuTokenCache.expiresAt > Date.now() + 5 * 60 * 1000) {
        return { success: true, token: feishuTokenCache.token, message: '使用緩存token' };
    }

    try {
        const response = await fetch(`${getProxyWorkerUrl()}/feishu/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ app_id: appId, app_secret: appSecret })
        });

        const text = await response.text();
        if (!response.ok) {
            try {
                const errJson = JSON.parse(text);
                return { success: false, token: '', message: `獲取token失敗: ${errJson.msg || errJson.error || response.status}` };
            } catch {
                return { success: false, token: '', message: `獲取token失敗: ${response.status}` };
            }
        }

        const data = JSON.parse(text);
        if (data.code !== 0) {
            return { success: false, token: '', message: `飛書錯誤: ${data.msg || '未知錯誤'}` };
        }

        const token = data.tenant_access_token;
        const expire = (data.expire || 7200) * 1000; // 轉為毫秒
        feishuTokenCache = { token, expiresAt: Date.now() + expire };

        return { success: true, token, message: 'Token獲取成功' };
    } catch (e: any) {
        return { success: false, token: '', message: `網絡錯誤: ${e.message}` };
    }
};

/**
 * 按日期查找角色的日記
 *
 * 不拋異常。`success: false` = 這次查詢沒跑通（拿不到 token / 接口報錯 / 斷網）；
 * 「那天真的沒寫」是 `success: true` + entries 為空。
 */
export const feishuGetDiaryByDate = async (
    appId: string,
    appSecret: string,
    baseId: string,
    tableId: string,
    characterName: string,
    date: string  // YYYY-MM-DD
): Promise<{ success: boolean; entries: FeishuDiaryPreview[]; message: string }> => {
    try {
        const tokenResult = await feishuGetToken(appId, appSecret);
        if (!tokenResult.success) {
            return { success: false, entries: [], message: tokenResult.message };
        }

        const dateTimestamp = new Date(date).getTime();
        const nextDayTimestamp = dateTimestamp + 24 * 60 * 60 * 1000;

        const response = await fetch(`${getProxyWorkerUrl()}/feishu/bitable/${baseId}/${tableId}/records/search`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Feishu-Token': tokenResult.token
            },
            body: JSON.stringify({
                filter: {
                    conjunction: 'and',
                    conditions: [
                        { field_name: '角色', operator: 'is', value: [characterName] },
                        { field_name: '日期', operator: 'isGreater', value: [dateTimestamp - 1] },
                        { field_name: '日期', operator: 'isLess', value: [nextDayTimestamp] }
                    ]
                },
                sort: [{ field_name: '日期', desc: true }],
                page_size: 10
            })
        });

        const text = await response.text();
        if (!response.ok) {
            return { success: false, entries: [], message: `查詢失敗: ${response.status}` };
        }

        const data = JSON.parse(text);
        if (data.code !== 0) {
            return { success: false, entries: [], message: `飛書錯誤: ${data.msg || '查詢失敗'}` };
        }

        const items = data.data?.items || [];
        if (items.length === 0) {
            return { success: true, entries: [], message: `沒有找到 ${date} 的日記` };
        }

        const entries: FeishuDiaryPreview[] = items.map((item: any) => {
            const fields = item.fields || {};
            const rawTitle = (Array.isArray(fields['標題']) ? fields['標題']?.[0]?.text : fields['標題']) || '無標題';
            const cleanTitle = String(rawTitle).replace(/^\[.*?\]\s*/, '');

            return {
                recordId: item.record_id,
                title: cleanTitle,
                date: date,
                content: (Array.isArray(fields['內容']) ? fields['內容']?.[0]?.text : fields['內容']) || ''
            };
        });

        return { success: true, entries, message: `找到 ${entries.length} 篇日記` };
    } catch (e: any) {
        return { success: false, entries: [], message: `查詢失敗: ${e.message}` };
    }
};
