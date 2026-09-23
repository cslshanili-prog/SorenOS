import { DB } from './db';
import { NotionManager, FeishuManager } from './realtimeContext';
import type { RealtimeConfig } from '../types';

// 待寫日記隊列 (寫 Notion / 飛書).
//
// 為什麼需要: 寫日記是客戶端發起的網絡 fetch (NotionManager.createDiaryPage /
// FeishuManager.createDiaryRecord). 雲端回覆 (主動消息 / 即時對話) 路徑下, 如果用戶在角色回覆到達時把 app
// 切後台 / 瀏覽器凍結了, 這個 fetch 會被節流/打斷而失敗, 而 inbox 是"先 ack 後處理"原子消費,
// 失敗的寫入就永久丟了 (用戶現象: 角色說"寫好了"但 Notion 裡沒有). 文字 chunk 因為先落庫所以
// 照常顯示, 造成假象.
//
// 解法 (用戶提的"回前台再補打"思路 + 預寫日誌): 在真正發請求**之前**先把內容持久化到本地隊列
// (localStorage 同步寫, 即使隨後被凍結/殺進程也已落盤), 然後嘗試寫; 成功就刪除該條, 失敗就留著.
// 回到前台 (visibilitychange→visible) / app 啟動時 drainPendingDiaries() 排空重試 —— 那時
// 頁面可見, fetch 可靠. 這樣文字流照常跑, 唯獨脆弱的網絡副作用走"保證最終一致"的補償路徑.

const STORAGE_KEY = 'os_pending_diary_writes';

export interface PendingDiary {
    id: string;
    kind: 'notion' | 'feishu';
    charId: string;
    charName: string;
    title: string;
    content: string;
    mood?: string;
    createdAt: number;
}

function read(): PendingDiary[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function write(list: PendingDiary[]): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch (e) {
        console.warn('[pendingDiary] persist failed', e);
    }
}

/** 預寫: 真正發請求前先落盤. 返回 id, 寫成功後用 removePendingDiary(id) 刪掉. */
export function enqueuePendingDiary(entry: Omit<PendingDiary, 'id' | 'createdAt'>): string {
    const id = `${entry.charId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const list = read();
    list.push({ ...entry, id, createdAt: Date.now() });
    write(list);
    return id;
}

export function removePendingDiary(id: string): void {
    write(read().filter((e) => e.id !== id));
}

export function hasPendingDiaries(): boolean {
    return read().length > 0;
}

/**
 * 排空待寫日記: 對每條嘗試寫入對應後端.
 *  - 成功 → 落一條"角色寫了日記"系統消息 + 刪除該條 + 調 onSaved 刷新 UI.
 *  - API 明確拒絕 (success=false, 多為配置/權限問題, 重試也沒用) → 刪除該條, 不再重試.
 *  - 拋異常 (網絡被凍結/打斷等可恢復錯誤) → 留在隊列, 下次回前台再試.
 *  - 對應後端沒配置 → 跳過 (留著, 等配置好).
 * 僅在前台 (visibilitychange→visible) / app 啟動時調用.
 */
export async function drainPendingDiaries(
    realtimeConfig: RealtimeConfig | undefined,
    onSaved?: (charId: string) => void,
): Promise<void> {
    const list = read();
    if (list.length === 0) return;

    for (const entry of list) {
        try {
            if (entry.kind === 'notion') {
                if (!realtimeConfig?.notionEnabled || !realtimeConfig?.notionApiKey || !realtimeConfig?.notionDatabaseId) {
                    continue; // 沒配置, 留著
                }
                const r = await NotionManager.createDiaryPage(
                    realtimeConfig.notionApiKey,
                    realtimeConfig.notionDatabaseId,
                    { title: entry.title, content: entry.content, mood: entry.mood || undefined, characterName: entry.charName },
                );
                if (r.success) {
                    await DB.saveMessage({ charId: entry.charId, role: 'system', type: 'text', content: `📔 ${entry.charName}寫了一篇日記「${entry.title}」` } as any);
                    removePendingDiary(entry.id);
                    onSaved?.(entry.charId);
                } else {
                    console.error('[pendingDiary] notion 拒絕, 丟棄:', r.message);
                    removePendingDiary(entry.id);
                }
            } else {
                if (!realtimeConfig?.feishuEnabled || !realtimeConfig?.feishuAppId || !realtimeConfig?.feishuAppSecret || !realtimeConfig?.feishuBaseId || !realtimeConfig?.feishuTableId) {
                    continue;
                }
                const r = await FeishuManager.createDiaryRecord(
                    realtimeConfig.feishuAppId,
                    realtimeConfig.feishuAppSecret,
                    realtimeConfig.feishuBaseId,
                    realtimeConfig.feishuTableId,
                    { title: entry.title, content: entry.content, mood: entry.mood || undefined, characterName: entry.charName },
                );
                if (r.success) {
                    await DB.saveMessage({ charId: entry.charId, role: 'system', type: 'text', content: `📒 ${entry.charName}寫了一篇日記「${entry.title}」(飛書)` } as any);
                    removePendingDiary(entry.id);
                    onSaved?.(entry.charId);
                } else {
                    console.error('[pendingDiary] 飛書拒絕, 丟棄:', r.message);
                    removePendingDiary(entry.id);
                }
            }
        } catch (e) {
            // 網絡可恢復錯誤: 留在隊列, 回前台再試.
            console.warn('[pendingDiary] 寫入異常, 留待重試:', entry.id, e);
        }
    }
}
