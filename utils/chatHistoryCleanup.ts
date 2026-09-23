import type { Message } from '../types';
import { openDB } from './db';
import { getMemoryPalaceHighWaterMarkForContext } from './chatContextRange';
import { preserveContentFavoritesBeforeMessageDeletion } from './contentFavorites';

export const CHAT_CLEANUP_CONFIRMATION = '我確定永久刪除我選中的內容';
export type ChatCleanupSelection = { fromId: number; toId: number } | { keepRecent: number };
export interface ChatCleanupPlan {
    charId: string;
    ids: number[];
    fingerprints: number[];
    firstTimestamp: number;
    lastTimestamp: number;
    afterWaterlineCount: number;
}

// 只保存 ID 和記錄指紋，不把整個待刪區間的正文/圖片留在內存裡。
const fingerprint = (message: Message): number => {
    const text = JSON.stringify(message);
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return hash >>> 0;
};
const validId = (id: number): boolean => Number.isSafeInteger(id) && id > 0;

/** 預覽固定當前選區；確認期間新增消息不會被帶入刪除。 */
export async function prepareChatHistoryCleanup(charId: string, selection: ChatCleanupSelection, signal?: AbortSignal): Promise<ChatCleanupPlan> {
    if (!charId) throw new Error('請選擇角色');
    if ('keepRecent' in selection ? !Number.isSafeInteger(selection.keepRecent) || selection.keepRecent < 1 : !validId(selection.fromId) || !validId(selection.toId)) {
        throw new Error('請選擇有效的起止消息，或輸入至少 1 條保留記錄');
    }
    const lower = 'fromId' in selection ? Math.min(selection.fromId, selection.toId) : 1;
    const upper = 'fromId' in selection ? Math.max(selection.fromId, selection.toId) : undefined;
    const keep = 'keepRecent' in selection ? selection.keepRecent : 0;
    const hwm = getMemoryPalaceHighWaterMarkForContext(charId);
    const db = await openDB();
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
    return new Promise((resolve, reject) => {
        const tx = db.transaction('messages', 'readonly');
        const store = tx.objectStore('messages');
        // 先取輕量主鍵，再分批讀取；不在重複 charId 索引上逐條移動游標。
        const request = store.index('charId').getAllKeys(IDBKeyRange.only(charId));
        const plan: ChatCleanupPlan = { charId, ids: [], fingerprints: [], firstTimestamp: 0, lastTimestamp: 0, afterWaterlineCount: 0 };
        let retained = 0;
        const abort = () => { try { tx.abort(); } catch {} };
        signal?.addEventListener('abort', abort, { once: true });
        const cleanup = () => signal?.removeEventListener('abort', abort);
        tx.oncomplete = () => { cleanup(); plan.ids.reverse(); plan.fingerprints.reverse(); resolve(plan); };
        tx.onerror = () => { cleanup(); reject(tx.error); };
        tx.onabort = () => { cleanup(); reject(new DOMException('已取消', 'AbortError')); };
        request.onsuccess = () => {
            const keys = request.result.filter(key => Number(key) >= lower && (upper === undefined || Number(key) <= upper)).reverse();
            let offset = 0;
            const readBatch = () => {
                const batch = keys.slice(offset, offset + 64); offset += batch.length;
                batch.forEach((key, index) => {
                    const read = store.get(key);
                    read.onsuccess = () => {
                        const message = read.result as Message;
                        if (!message.groupId) {
                            if (retained < keep) retained++;
                            else {
                                if (plan.ids.length === 0) plan.lastTimestamp = message.timestamp;
                                plan.firstTimestamp = message.timestamp;
                                plan.ids.push(message.id);
                                plan.fingerprints.push(fingerprint(message));
                                if (message.id > hwm) plan.afterWaterlineCount++;
                            }
                        }
                        if (index === batch.length - 1) readBatch();
                    };
                });
            };
            readBatch();
        };
    });
}

/** 兩次確認後原子刪除；任何選中正文發生變化都回滾，重新預覽再確認。 */
export async function deleteChatHistoryCleanup(plan: ChatCleanupPlan, confirmation: { reviewed: boolean; text: string }): Promise<number> {
    if (!confirmation.reviewed || confirmation.text !== CHAT_CLEANUP_CONFIRMATION) throw new Error('請完成兩次確認並輸入完整確認文字');
    if (!plan.charId || !plan.ids.length || plan.ids.length !== plan.fingerprints.length || plan.ids.some((id, index) => !validId(id) || (index > 0 && id <= plan.ids[index - 1]))) throw new Error('刪除範圍無效，請重新選擇');
    const expected = new Map(plan.ids.map((id, index) => [id, plan.fingerprints[index]]));
    await preserveContentFavoritesBeforeMessageDeletion({ ids: plan.ids });
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(['messages', 'assets'], 'readwrite');
        const store = tx.objectStore('messages');
        const assets = tx.objectStore('assets');
        let deleted = 0;
        let failure: Error | undefined;
        const fail = () => { failure = new Error('選中的記錄已變化，請重新選擇範圍並完成兩次確認'); tx.abort(); };
        tx.oncomplete = () => resolve(deleted);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(failure || tx.error || new Error('清理未完成，選中記錄已保留'));
        const applyDeletion = () => {
            // 只有主鍵完全相鄰才合併刪除；中間的其他角色、群聊或新記錄不會被跨過去。
            let index = 0;
            const deleteBatch = () => {
                let lastRequest: IDBRequest | undefined;
                for (let count = 0; count < 64 && index < plan.ids.length; count++) {
                    const first = plan.ids[index];
                    let last = first;
                    while (++index < plan.ids.length && plan.ids[index] === last + 1) last = plan.ids[index];
                    lastRequest = store.delete(IDBKeyRange.bound(first, last));
                }
                if (lastRequest && index < plan.ids.length) lastRequest.onsuccess = deleteBatch;
            };
            deleteBatch();
            // 只訪問實際存在的語音緩存，避免為十萬條文字記錄創建十萬個空刪除請求。
            const voices = assets.openKeyCursor(IDBKeyRange.bound('voice_msg_', 'voice_msg_\uffff'));
            voices.onsuccess = () => {
                const cursor = voices.result;
                if (!cursor) return;
                const match = /^voice_msg_(\d+)$/.exec(String(cursor.primaryKey));
                if (match && expected.has(Number(match[1]))) assets.delete(cursor.primaryKey);
                cursor.continue();
            };
            deleted = plan.ids.length;
        };
        let offset = 0;
        const validateBatch = () => {
            const batch = plan.ids.slice(offset, offset + 64); offset += batch.length;
            if (!batch.length) { applyDeletion(); return; }
            batch.forEach((id, index) => {
                const read = store.get(id);
                read.onsuccess = () => {
                    if (failure) return;
                    const message = read.result as Message | undefined;
                    if (!message || message.charId !== plan.charId || message.groupId || expected.get(id) !== fingerprint(message)) { fail(); return; }
                    // 清理角色的劇情副本時，只解除中央正文對這個副本的引用。
                    // 中央劇情和其他角色副本保留，避免後續重寫因懸空鏡像 ID 失敗。
                    const centralId = Number(message.metadata?.theaterCentralId);
                    if (message.metadata?.source === 'story_theater_memory' && validId(centralId)) {
                        const centralRequest = store.get(centralId);
                        centralRequest.onsuccess = () => {
                            const central = centralRequest.result as Message | undefined;
                            if (!central || central.charId === plan.charId || central.metadata?.source !== 'story_theater' || central.metadata?.theaterId !== message.metadata?.theaterId) return;
                            const mirrors = central.metadata?.theaterMirrorIds as Record<string, number> | undefined;
                            if (Number(mirrors?.[plan.charId]) !== message.id) return;
                            const nextMirrors = { ...mirrors }; delete nextMirrors[plan.charId];
                            store.put({ ...central, metadata: { ...central.metadata, theaterMirrorIds: nextMirrors } });
                        };
                    }
                    if (index === batch.length - 1) validateBatch();
                };
            });
        };
        validateBatch();
    });
}
