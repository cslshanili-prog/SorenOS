/**
 * 從資料庫挑一張照片或一份文件，發進私聊（plans/asset-library-design.md「從資料庫發給角色」）。
 *
 * - 照片：發成一條普通的用戶圖片訊息（type 'image'），跟你從相冊傳的一樣，角色看得到圖。
 *   內容沿用資料庫那張的 blobref 令牌（同一份 Blob，不另存），metadata 記 libraryImageId，
 *   所以不會再往資料庫多存一張（Chat.tsx 的 sendText 看到它就跳過「存進資料庫」）。
 *   有描述的順手放進 visionDescription：開了「看圖改用文字描述」的人省一次看圖請求。
 * - 文件：發成一張文件卡片（type 'library_file'）。角色現在只看得到檔名、類型、大小和備註，
 *   還打不開內容（讀文件內容之後再做）；點卡片照資料庫那樣打開／下載。
 *   令牌放在 metadata 裡：圖片清理（utils/blobGc.ts）整行掃，資料庫那筆刪了這張卡片照樣打得開。
 */

import type { GalleryImage } from '../types';
import { formatLibraryFileSize } from './library';

export interface LibraryFileMessageMeta {
    libraryImageId: string;
    name: string;
    mime: string;
    size: number;
    /** 文件本體的 blobref 令牌 */
    ref: string;
    /** 資料庫裡寫的備註（描述） */
    note?: string;
}

export const libraryPhotoMessageMetadata = (photo: GalleryImage) => ({
    libraryImageId: photo.id,
    ...((photo.description || '').trim() ? { visionDescription: photo.description!.trim() } : {}),
});

export const libraryFileMessageMetadata = (item: GalleryImage): { libraryFile: LibraryFileMessageMeta } => ({
    libraryFile: {
        libraryImageId: item.id,
        name: item.file?.name || '未命名文件',
        mime: item.file?.mime || 'application/octet-stream',
        size: item.file?.size || 0,
        ref: item.url,
        ...((item.description || '').trim() ? { note: item.description!.trim() } : {}),
    },
});

export const libraryFileMessageContent = (item: GalleryImage) => `[文件：${item.file?.name || '未命名文件'}]`;

/** 副檔名（顯示在卡片上的那個小標） */
export const libraryFileExtension = (meta: Pick<LibraryFileMessageMeta, 'name' | 'mime'>): string => {
    const fromName = /\.([0-9a-z]{1,8})$/i.exec(meta.name || '')?.[1];
    if (fromName) return fromName.toUpperCase();
    if (/pdf/i.test(meta.mime)) return 'PDF';
    return 'FILE';
};

/**
 * 給角色看的那一行（私聊歷史、總結器都用這個，全鏈路一副面孔）。
 * 說清楚它打不開內容，免得角色裝作讀過。
 */
export const formatLibraryFileRecord = (meta: Partial<LibraryFileMessageMeta> | undefined, userName: string): string => {
    const name = meta?.name || '未命名文件';
    const detail = [libraryFileExtension({ name, mime: meta?.mime || '' }), meta?.size ? formatLibraryFileSize(meta.size) : ''].filter(Boolean).join(' · ');
    const note = (meta?.note || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return `[${userName || '對方'}傳了一份文件給你：《${name}》（${detail}）${note ? `，備註：${note}` : ''}。你看得到檔名和備註，還打不開內容。]`;
};
