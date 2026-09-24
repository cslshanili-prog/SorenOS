import type { ImageGenApiConfig, Message } from '../types';
import { DB } from './db';
import { generateImage, buildCharacterImagePrompt, resolveCharacterReferenceImage } from './imageGeneration';
import { migrateDataUrlToRef } from './blobRef';
import { getLocalDateKey } from './localDate';

/**
 * 路線圖第 7 項（生圖補生成）的本機這一段：角色要發照片時先落一張「照片生成中」的佔位卡
 * （type 'photo_pending'，metadata.pendingPhoto），再去生成；成了就把這一則換成真的圖片。
 * 生成途中切走（頁面被凍結、請求被掐）或失敗時佔位卡留著，回到 App 時自動再試。
 *
 * - chatParser 的 SEND_PHOTO 走這裡（createPendingPhoto + fulfillPendingPhoto）；
 * - OSContext 在啟動、切回前台時跑 retryPendingPhotos；
 * - 卡片上試了太多次還不行，停止自動重試，卡片上留「重試」讓用戶自己按。
 *
 * 雲端（主動消息 2.0）回覆裡的發照片要等自己的 Worker 把標籤交回來，才能接到這裡。
 */

export interface PendingPhotoMeta {
    description: string;
    attempts: number;
    /** 自動重試放棄了（試太多次），等用戶在卡片上按重試 */
    gaveUp?: boolean;
    lastError?: string;
}

export const PENDING_PHOTO_MAX_AUTO_ATTEMPTS = 4;
export const PENDING_PHOTO_CHANGED_EVENT = 'pending-photo-changed';

// ── 待補清單（localStorage：messageId → charId）──────────────────────────────

const INDEX_KEY = 'soren_pending_photos';

export function readPendingPhotoIndex(): Record<string, string> {
    try {
        const parsed = JSON.parse(localStorage.getItem(INDEX_KEY) || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function writeIndex(index: Record<string, string>): void {
    try {
        if (Object.keys(index).length === 0) localStorage.removeItem(INDEX_KEY);
        else localStorage.setItem(INDEX_KEY, JSON.stringify(index));
    } catch { /* 存不進去就只剩這次開著時的生成 */ }
}

export function trackPendingPhoto(messageId: number, charId: string): void {
    writeIndex({ ...readPendingPhotoIndex(), [String(messageId)]: charId });
}

export function untrackPendingPhoto(messageId: number): void {
    const index = readPendingPhotoIndex();
    if (!(String(messageId) in index)) return;
    delete index[String(messageId)];
    writeIndex(index);
}

/** 失敗一次之後的新狀態：累計次數，到上限就停止自動重試。 */
export function nextPendingPhotoMeta(prev: PendingPhotoMeta, error: string): PendingPhotoMeta {
    const attempts = (prev.attempts || 0) + 1;
    return { ...prev, attempts, lastError: error.slice(0, 200), ...(attempts >= PENDING_PHOTO_MAX_AUTO_ATTEMPTS ? { gaveUp: true } : {}) };
}

export const canGenerateCharPhoto = (config: ImageGenApiConfig | undefined): config is ImageGenApiConfig =>
    !!(config?.charImageGenEnabled && config?.charImageSendEnabled && config?.baseUrl && config?.model);

const announce = (charId: string) => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(PENDING_PHOTO_CHANGED_EVENT, { detail: { charId } }));
    // 開著的聊天頁重讀（OSContext 聽到會推 lastMsgTimestamp，不彈 toast）
    window.dispatchEvent(new CustomEvent('active-msg-progress'));
};

// ── 生成 ────────────────────────────────────────────────────────────────

type Persist = (msg: Omit<Message, 'id' | 'timestamp'> & { timestamp?: number }) => Promise<number>;

/** 落一張佔位卡並記進待補清單，回傳訊息 id。 */
export async function createPendingPhoto(
    persist: Persist,
    charId: string,
    description: string,
    extraMeta?: Record<string, unknown>,
): Promise<number> {
    const pendingPhoto: PendingPhotoMeta = { description, attempts: 0 };
    const id = await persist({
        charId, role: 'assistant', type: 'photo_pending', content: '[照片]',
        metadata: { ...(extraMeta || {}), pendingPhoto },
    } as Parameters<Persist>[0]);
    trackPendingPhoto(id, charId);
    // 聊天頁要等整輪後處理跑完才重讀，不先推一下的話，照片生成期間佔位卡根本不會出現
    announce(charId);
    return id;
}

const inFlight = new Set<number>();

/**
 * 生成這張佔位卡的照片。成了回傳 true（佔位卡換成圖片、存進相冊）；失敗累計次數、留著等下次。
 * 同一張卡同時只跑一次。
 */
export async function fulfillPendingPhoto(messageId: number, config: ImageGenApiConfig | undefined): Promise<boolean> {
    if (inFlight.has(messageId)) return false;
    inFlight.add(messageId);
    try {
        const message = await DB.getMessageById(messageId);
        const meta = message?.metadata?.pendingPhoto as PendingPhotoMeta | undefined;
        if (!message || message.type !== 'photo_pending' || !meta?.description) {
            untrackPendingPhoto(messageId);
            return false;
        }
        if (!canGenerateCharPhoto(config)) return false;
        try {
            const chars = await DB.getAllCharacters();
            const charProfile = chars.find(c => c.id === message.charId);
            const prompt = charProfile ? buildCharacterImagePrompt(charProfile, meta.description) : meta.description;
            const referenceBlob = charProfile ? await resolveCharacterReferenceImage(charProfile, { description: meta.description }) : null;
            const { dataUrl } = await generateImage(config, prompt, referenceBlob || undefined);
            const storedContent = await migrateDataUrlToRef(dataUrl);
            const { pendingPhoto: _done, ...rest } = message.metadata || {};
            await DB.replaceMessageFields(messageId, {
                type: 'image', content: storedContent,
                metadata: { ...rest, aiGenerated: true, imagePrompt: meta.description },
            });
            untrackPendingPhoto(messageId);
            // 相冊是消息的附帶記錄：寫不進去不影響已經換好的聊天訊息
            try {
                await DB.saveGalleryImage({
                    id: `img-${Date.now()}-${Math.random()}`,
                    charId: message.charId, url: storedContent, timestamp: Date.now(),
                    sourceMessageId: messageId, sender: 'char',
                    savedDate: getLocalDateKey(new Date()),
                });
            } catch (galleryError) {
                console.warn('[PendingPhoto] 角色發的圖存相冊失敗:', galleryError);
            }
            announce(message.charId);
            return true;
        } catch (error) {
            const next = nextPendingPhotoMeta(meta, error instanceof Error ? error.message : String(error));
            await DB.updateMessageMetadata(messageId, prev => ({ ...(prev || {}), pendingPhoto: next })).catch(() => {});
            if (next.gaveUp) untrackPendingPhoto(messageId);
            console.warn('[PendingPhoto] 照片生成失敗，留著等下次補', { messageId, attempts: next.attempts, error });
            announce(message.charId);
            return false;
        }
    } finally {
        inFlight.delete(messageId);
    }
}

/** 用戶在放棄了的卡片上按「重試」：重新開放自動重試，再試一次。 */
export async function retryPendingPhotoNow(messageId: number, charId: string, config: ImageGenApiConfig | undefined): Promise<boolean> {
    await DB.updateMessageMetadata(messageId, prev => ({
        ...(prev || {}),
        pendingPhoto: { ...(prev?.pendingPhoto || {}), attempts: 0, gaveUp: false },
    })).catch(() => {});
    trackPendingPhoto(messageId, charId);
    announce(charId);
    return fulfillPendingPhoto(messageId, config);
}

let sweeping = false;

/** 把待補清單裡的逐張補上（一張一張來，生圖要花錢，不併發）。 */
export async function retryPendingPhotos(config: ImageGenApiConfig | undefined): Promise<void> {
    if (sweeping || !canGenerateCharPhoto(config)) return;
    const ids = Object.keys(readPendingPhotoIndex()).map(Number).filter(Number.isFinite);
    if (ids.length === 0) return;
    sweeping = true;
    try {
        for (const id of ids) {
            if (typeof document !== 'undefined' && document.visibilityState !== 'visible') break;
            await fulfillPendingPhoto(id, config);
        }
    } finally {
        sweeping = false;
    }
}
