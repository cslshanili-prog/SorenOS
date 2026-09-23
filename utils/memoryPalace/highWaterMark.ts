import { DB, openDB } from '../db';

const LOCAL_KEY = (charId: string) => `mp_lastMsgId_${charId}`;
const MIRROR_KEY = (charId: string) => `mp_hwm_v1_${charId}`;

interface HighWaterMarkMirror {
    version: 1;
    charId: string;
    msgId: number;
    updatedAt: number;
}

function normalizeMessageId(value: unknown): number {
    const parsed = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

/** 同步讀取供聊天上下文過濾使用；後台管線會再用 IndexedDB 鏡像校準。 */
export function getLocalMemoryPalaceHighWaterMark(charId: string): number {
    try {
        return normalizeMessageId(localStorage.getItem(LOCAL_KEY(charId)));
    } catch {
        return 0;
    }
}

/**
 * 讀取 localStorage 與 IndexedDB 中較新的水位線。
 *
 * 部分第三方移動瀏覽器會只清理/隔離 localStorage，卻保留 IndexedDB 中的消息。
 * 水位線是單調遞增值，因此取兩者最大值既能修復這種驅逐，也不會覆蓋更新的數據。
 */
export async function getReliableMemoryPalaceHighWaterMark(charId: string): Promise<number> {
    try {
        const db = await openDB();
        // 與 saveMessage 的鏡像自愈共享 assets 事務鎖。不能在 await 前緩存本地舊值，
        // 也不能讀完後再另開事務寫回：中間可能已經落入新消息並清掉失效水位。
        return await new Promise<number>((resolve, reject) => {
            const tx = db.transaction('assets', 'readwrite');
            const assets = tx.objectStore('assets');
            const request = assets.get(MIRROR_KEY(charId));
            let reliableValue = 0;
            request.onsuccess = () => {
                const mirror = request.result?.data as Partial<HighWaterMarkMirror> | number | null;
                const mirroredValue = normalizeMessageId(typeof mirror === 'number' ? mirror : mirror?.msgId);
                const localValue = getLocalMemoryPalaceHighWaterMark(charId);
                reliableValue = Math.max(localValue, mirroredValue);
                if (reliableValue > mirroredValue) {
                    assets.put({ id: MIRROR_KEY(charId), data: {
                        version: 1, charId, msgId: reliableValue, updatedAt: Date.now(),
                    } satisfies HighWaterMarkMirror });
                }
            };
            tx.oncomplete = () => {
                if (reliableValue > getLocalMemoryPalaceHighWaterMark(charId)) {
                    try { localStorage.setItem(LOCAL_KEY(charId), String(reliableValue)); } catch { /* 鏡像仍可用 */ }
                }
                resolve(reliableValue);
            };
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('水位讀取事務中止'));
        });
    } catch {
        // 失敗後讀取當前本地值，不恢復進入函數前的舊快照。
        return getLocalMemoryPalaceHighWaterMark(charId);
    }
}

/** 成功處理消息後同時寫兩份；任意一份倖存即可避免舊消息被整批重複提取。 */
export async function setReliableMemoryPalaceHighWaterMark(charId: string, msgId: number): Promise<void> {
    const normalized = normalizeMessageId(msgId);

    try {
        localStorage.setItem(LOCAL_KEY(charId), String(normalized));
    } catch {
        // 繼續嘗試 IndexedDB。
    }

    try {
        await DB.saveAssetRaw(MIRROR_KEY(charId), {
            version: 1,
            charId,
            msgId: normalized,
            updatedAt: Date.now(),
        } satisfies HighWaterMarkMirror);
    } catch {
        // 與舊行為一致：持久化故障不抹掉已經成功寫入的記憶。
    }
}
