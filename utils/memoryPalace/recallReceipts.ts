/**
 * Memory Palace — 召回回執 (Recall Receipts)
 *
 * 記錄"路徑①召回"每次實際注入到主聊天 prompt 的 memoryId 列表。
 * 用途：路徑②extraction 處理 buffer 時，用回執反查"這段對話期間角色被
 * 餵過哪些記憶"，作為高優先級 relatedMemories 餵給 extraction LLM，
 * 讓它能穩定識別"用戶糾正的是哪條舊記憶"。
 *
 * 為什麼需要這玩意：
 *   糾正語句和被糾正的記憶之間常常隔幾十條消息（buffer 滿 100 才處理），
 *   單純靠"對最近消息做向量召回"經常漏 — 但召回時我們 100% 知道 prompt
 *   裡塞了哪些記憶，把這個事實記下來就不必猜。
 *
 * 存儲：localStorage，按 char 分鍵，環形保留最近 RECEIPT_MAX 條。
 * 體積：~600B/條 × 100 ≈ 60KB/角色，可接受。
 */

const RECEIPT_MAX = 100;
const STORAGE_KEY_PREFIX = 'os_mp_recall_receipts_';

export interface RecallReceipt {
    /** 召回發生的時間戳（ms） */
    ts: number;
    /** 當次注入到 prompt 的所有 memoryId（含事件盒展開的 summary + 活節點） */
    ids: string[];
}

function storageKey(charId: string): string {
    return `${STORAGE_KEY_PREFIX}${charId}`;
}

function readAll(charId: string): RecallReceipt[] {
    try {
        const raw = localStorage.getItem(storageKey(charId));
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (r): r is RecallReceipt =>
                r && typeof r.ts === 'number' && Array.isArray(r.ids)
        );
    } catch {
        return [];
    }
}

/**
 * 讀取某個時間點之後最近一次真實注入回執。
 *
 * “記憶鏈接”用它鎖定當前回復實際經過的那一批記憶。若當前輪沒有回執，
 * 必須返回 null，而不是退回更早的一輪，避免用戶誤改無關記憶。
 */
export function getLatestRecallReceipt(
    charId: string,
    sinceTs: number = 0,
): RecallReceipt | null {
    const list = readAll(charId);
    for (let i = list.length - 1; i >= 0; i--) {
        const receipt = list[i];
        if (receipt.ts >= sinceTs) {
            return { ts: receipt.ts, ids: [...receipt.ids] };
        }
    }
    return null;
}

function writeAll(charId: string, receipts: RecallReceipt[]): void {
    try {
        localStorage.setItem(storageKey(charId), JSON.stringify(receipts));
    } catch (e) {
        // localStorage 寫滿或無權限：無聲降級，回執只是輔助手段
        console.warn(`[RecallReceipts] write failed for ${charId}:`, e);
    }
}

/**
 * 記錄一次召回回執。
 * 空數組直接跳過，避免回執表裡塞滿"召回到 0 條"的噪聲。
 */
export function recordRecallReceipt(charId: string, ids: string[]): void {
    if (!charId || ids.length === 0) return;
    const list = readAll(charId);
    list.push({ ts: Date.now(), ids: [...new Set(ids)] });
    // 環形截斷，保留最近 RECEIPT_MAX 條
    const trimmed = list.length > RECEIPT_MAX ? list.slice(-RECEIPT_MAX) : list;
    writeAll(charId, trimmed);
}

/**
 * 取一段時間窗口內被注入過的 memoryId，按"最後一次注入時間"倒序去重。
 *
 * 用法：extraction 處理 buffer 前，傳入 buffer 首末消息的時間戳，拿到
 * 這段對話裡角色實際看到過的所有記憶 id。
 *
 * @param fromTs 含端
 * @param toTs   含端；可比當前時間稍晚一點（消息時間戳和 receipt 時間戳
 *               不一定嚴格對齊，建議調用方加 ~10 分鐘容差）
 * @param limit  返回上限（默認 50）
 */
export function getReceiptIdsInRange(
    charId: string,
    fromTs: number,
    toTs: number,
    limit: number = 50,
): string[] {
    const list = readAll(charId);
    // 按 ts 倒序遍歷，保證同一 id 取的是"最後一次出現的位次"
    const seen = new Set<string>();
    const result: string[] = [];
    for (let i = list.length - 1; i >= 0; i--) {
        const r = list[i];
        if (r.ts < fromTs || r.ts > toTs) continue;
        for (const id of r.ids) {
            if (seen.has(id)) continue;
            seen.add(id);
            result.push(id);
            if (result.length >= limit) return result;
        }
    }
    return result;
}

/** 測試/調試用：清空某角色的回執表 */
export function clearReceipts(charId: string): void {
    try {
        localStorage.removeItem(storageKey(charId));
    } catch {}
}
