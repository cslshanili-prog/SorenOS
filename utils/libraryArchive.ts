/**
 * 資料庫第四批：協同文件櫃的文件「你選了才歸檔」（plans/asset-library-design.md）。
 * 複製一份 Blob 進 blob_assets（跟著主備份走、在圖片清理的引用面裡），協同那邊原樣不動；
 * 圖片歸成照片，其他歸成文件。同一份（認協同的 assetId）只歸一次。
 */

import type { GalleryImage } from '../types';
import { DB } from './db';
import { putImageBlob } from './blobRef';
import { getLocalDateKey } from './localDate';
import { makeLibraryImageId } from './library';

export interface ArchivableCollabFile {
    assetId: string;
    name: string;
    mimeType: string;
    size: number;
    sessionTitle?: string;
}

export const findArchivedCollabFile = (images: GalleryImage[], assetId: string): GalleryImage | null =>
    images.find(image => image.file?.collabAssetId === assetId) || null;

export const archiveCollaborationFile = async (input: {
    charId: string;
    file: ArchivableCollabFile;
    /** 取協同那邊的 Blob；找不到回 null */
    loadBlob: () => Promise<Blob | null>;
    now?: number;
}): Promise<{ status: 'archived' | 'exists'; image: GalleryImage }> => {
    const existing = findArchivedCollabFile(await DB.getGalleryImages(), input.file.assetId);
    if (existing) return { status: 'exists', image: existing };
    const blob = await input.loadBlob();
    if (!blob) throw new Error('文件已經不存在');
    const now = input.now ?? Date.now();
    const isImage = /^image\//i.test(input.file.mimeType || blob.type);
    const image: GalleryImage = {
        id: makeLibraryImageId(),
        charId: input.charId,
        url: await putImageBlob(blob),
        timestamp: now,
        origin: 'collab',
        kind: isImage ? 'image' : 'file',
        access: { mode: 'chars', charIds: input.charId ? [input.charId] : [] },
        savedDate: getLocalDateKey(new Date(now)),
        file: {
            name: input.file.name,
            mime: input.file.mimeType || blob.type || 'application/octet-stream',
            size: input.file.size || blob.size,
            collabAssetId: input.file.assetId,
            ...(input.file.sessionTitle ? { sessionTitle: input.file.sessionTitle } : {}),
        },
    };
    await DB.saveGalleryImage(image);
    return { status: 'archived', image };
};

/** 檔案大小給人看 */
export const formatLibraryFileSize = (size: number): string => {
    if (!Number.isFinite(size) || size <= 0) return '';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
};
