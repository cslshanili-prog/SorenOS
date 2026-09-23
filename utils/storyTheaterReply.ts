import type { CharacterProfile, Message } from '../types';
import { openDB } from './db';
import { loadCharacterContextMessages } from './chatContextRange';

/** 本劇情原文已有獨立歷史槽位，角色鏡像不得重複注入或帶回待重寫回復。 */
export async function loadStoryActorContext(char: CharacterProfile, theaterId: string, limit: number): Promise<Message[]> {
    if (limit <= 0) return [];
    const messages = await loadCharacterContextMessages(char);
    return messages.filter(message => !(message.metadata?.source === 'story_theater_memory' && message.metadata?.theaterId === theaterId)).slice(-limit);
}

export const STORY_REROLL_INSTRUCTION = '本輪是重新生成：從同一處故事落點重新寫這一輪，換一個合理的切入角度、對白和細節展開；保留已確立的事實和用戶輸入，不把這次操作寫進故事，不把尚未發生的舊版本當作既定經歷。';

/** 成功後一次事務替換正文和鏡像；失敗/併發編輯時保留原文，不先刪後寫。 */
export async function replaceStoryTheaterReply(original: Message, content: string, metadata: Record<string, unknown>): Promise<void> {
    const mirrorIds = Object.values((original.metadata?.theaterMirrorIds || {}) as Record<string, number>).map(Number).filter(id => Number.isFinite(id) && id > 0);
    const ids = [...new Set([original.id, ...mirrorIds])];
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction('messages', 'readwrite');
        const store = transaction.objectStore('messages');
        let failure: Error | undefined;
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(failure || transaction.error || new Error('重寫保存失敗，原回覆已保留'));
        for (const id of ids) {
            const request = store.get(id);
            request.onsuccess = () => {
                const current = request.result as Message | undefined;
                if (!current || current.content !== original.content) {
                    failure = new Error('這條回覆已被修改或刪除，請刷新後重試');
                    transaction.abort();
                    return;
                }
                store.put({ ...current, content, ...(id === original.id ? { metadata: { ...current.metadata, ...metadata } } : {}) });
            };
        }
    });
}
