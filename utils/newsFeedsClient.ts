import { ActiveMsgStore } from './activeMsgStore';
import type { NewsItem } from './realtimeWorldCore';

/**
 * App 這邊拿國際／台灣新聞 RSS：透過用戶自己的主動消息 2.0 Worker（`GET /news-feeds`）代抓，
 * 見 utils/newsFeeds.ts 的說明。
 *
 * 回傳 null 表示「這條路走不通」（沒填 Worker、Worker 還是舊版沒有這個端點、連不上），
 * 調用方據此退回維基百科新聞動態；回傳 [] 表示 Worker 在、只是這次一條都沒抓到。
 */
export async function fetchNewsFeedsViaWorker(keys: string[]): Promise<NewsItem[] | null> {
    if (keys.length === 0) return [];
    let workerUrl = '';
    let serverToken = '';
    try {
        const config = await ActiveMsgStore.getGlobalConfig();
        workerUrl = (config.workerUrl || '').trim().replace(/\/+$/, '');
        serverToken = config.serverToken || '';
    } catch {
        return null;
    }
    if (!workerUrl) return null;
    try {
        const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(15000) : undefined;
        const res = await fetch(`${workerUrl}/news-feeds?keys=${encodeURIComponent(keys.join(','))}`, {
            headers: serverToken ? { 'X-Client-Token': serverToken } : {},
            signal,
        });
        if (!res.ok) {
            console.warn(`[news-feeds] Worker 回 HTTP ${res.status}${res.status === 404 ? '（多半是 Worker 還沒更新）' : ''}`);
            return null;
        }
        const body: any = await res.json().catch(() => null);
        const items: unknown = body?.data?.items;
        if (!Array.isArray(items)) return null;
        return items.filter((it: any): it is NewsItem => it && typeof it.title === 'string' && it.title.trim() !== '');
    } catch (e: any) {
        console.warn('[news-feeds] 連不上 Worker：', e?.message || e);
        return null;
    }
}
