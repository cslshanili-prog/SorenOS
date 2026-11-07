import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GalleryImage } from '../types';

const saveMessage = vi.fn(async (_m: any) => 1);
const getCharacter = vi.fn(async (_id: string): Promise<any> => ({ id: 'char-1', name: 'Soren', groupId: 'w1' }));
const getGalleryImages = vi.fn(async (): Promise<GalleryImage[]> => []);

vi.mock('./db', () => ({
    DB: {
        saveMessage: (...args: any[]) => saveMessage(...(args as [any])),
        getCharacter: (...args: any[]) => getCharacter(...(args as [string])),
        getGalleryImages: () => getGalleryImages(),
    },
}));

import { ChatParser } from './chatParser';
import { libraryPhotoCode } from './libraryPrompt';

const shared: GalleryImage = { id: 'img-shared', charId: '', url: 'blobref:b_shared', timestamp: 2, origin: 'upload', access: { mode: 'all' }, description: '陽台的咖啡杯' };
const others: GalleryImage = { id: 'img-other', charId: 'char-2', url: 'blobref:b_other', timestamp: 3, sender: 'char', description: '別人的貓' };

describe('SEND_SAVED_PHOTO：角色傳資料庫裡的照片', () => {
    beforeEach(() => {
        saveMessage.mockClear();
        getGalleryImages.mockReset();
        getGalleryImages.mockResolvedValue([shared, others]);
    });

    it('編號對得上：原樣落一條圖片訊息（帶描述），標籤從正文剝掉', async () => {
        const left = await ChatParser.settleSavedPhotoCommands(`給你看這個\n[[ACTION:SEND_SAVED_PHOTO|${libraryPhotoCode(shared.id)}]]`, 'char-1');
        expect(left).toBe('給你看這個');
        expect(saveMessage).toHaveBeenCalledTimes(1);
        expect(saveMessage).toHaveBeenCalledWith(expect.objectContaining({
            charId: 'char-1', role: 'assistant', type: 'image', content: 'blobref:b_shared',
            metadata: { savedPhoto: { libraryImageId: 'img-shared' }, visionDescription: '陽台的咖啡杯' },
        }));
    });

    it('沒分配給它的、編號亂寫的：不發；同一張寫兩次只發一次', async () => {
        const code = libraryPhotoCode(shared.id);
        const left = await ChatParser.settleSavedPhotoCommands(
            `[[ACTION:SEND_SAVED_PHOTO|${libraryPhotoCode(others.id)}]][[ACTION:SEND_SAVED_PHOTO|zzzz]][[ACTION:SEND_SAVED_PHOTO|${code}]][[ACTION:SEND_SAVED_PHOTO|${code}]]好`,
            'char-1',
        );
        expect(left).toBe('好');
        expect(saveMessage).toHaveBeenCalledTimes(1);
    });

    it('parseAndExecuteActions 也會處理', async () => {
        await ChatParser.parseAndExecuteActions(`[[ACTION:SEND_SAVED_PHOTO|${libraryPhotoCode(shared.id)}]]嗯`, 'char-1', 'Soren', () => {});
        expect(saveMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'image', content: 'blobref:b_shared' }));
    });

    it('沒有標籤就不讀資料庫', async () => {
        expect(await ChatParser.settleSavedPhotoCommands('普通的話', 'char-1')).toBe('普通的話');
        expect(getGalleryImages).not.toHaveBeenCalled();
    });
});
