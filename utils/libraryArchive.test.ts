import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { GalleryImage } from '../types';

const rows: GalleryImage[] = [];
vi.mock('./db', () => ({
    DB: {
        getGalleryImages: async () => [...rows],
        saveGalleryImage: async (image: GalleryImage) => { rows.push(image); },
    },
}));
vi.mock('./blobRef', () => ({ putImageBlob: async () => 'blobref:b_copy' }));

import { archiveCollaborationFile, formatLibraryFileSize } from './libraryArchive';
import { isLibraryFile } from './library';

describe('資料庫 · 協同文件歸檔', () => {
    beforeEach(() => { rows.length = 0; });

    it('文件歸成文件、圖片歸成照片；預設給那個協同角色', async () => {
        const doc = await archiveCollaborationFile({
            charId: 'c1', now: Date.UTC(2026, 10, 7, 4),
            file: { assetId: 'a1', name: '企劃書.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 2048, sessionTitle: '旅行計畫' },
            loadBlob: async () => new Blob(['x']),
        });
        expect(doc.status).toBe('archived');
        expect(doc.image).toMatchObject({
            charId: 'c1', url: 'blobref:b_copy', origin: 'collab', kind: 'file',
            access: { mode: 'chars', charIds: ['c1'] },
            file: { name: '企劃書.docx', size: 2048, collabAssetId: 'a1', sessionTitle: '旅行計畫' },
        });
        expect(isLibraryFile(doc.image)).toBe(true);
        const pic = await archiveCollaborationFile({ charId: 'c1', file: { assetId: 'a2', name: '圖.png', mimeType: 'image/png', size: 10 }, loadBlob: async () => new Blob(['y']) });
        expect(pic.image.kind).toBe('image');
    });

    it('同一份只歸一次；找不到本體就報錯', async () => {
        const file = { assetId: 'a1', name: 'x.md', mimeType: 'text/markdown', size: 1 };
        const loadBlob = vi.fn(async () => new Blob(['x']));
        await archiveCollaborationFile({ charId: 'c1', file, loadBlob });
        const again = await archiveCollaborationFile({ charId: 'c1', file, loadBlob });
        expect(again.status).toBe('exists');
        expect(loadBlob).toHaveBeenCalledTimes(1);
        expect(rows).toHaveLength(1);
        await expect(archiveCollaborationFile({ charId: 'c1', file: { ...file, assetId: 'gone' }, loadBlob: async () => null })).rejects.toThrow('文件已經不存在');
    });

    it('大小', () => {
        expect(formatLibraryFileSize(500)).toBe('500 B');
        expect(formatLibraryFileSize(2048)).toBe('2.0 KB');
        expect(formatLibraryFileSize(3 * 1024 * 1024)).toBe('3.0 MB');
        expect(formatLibraryFileSize(0)).toBe('');
    });
});
