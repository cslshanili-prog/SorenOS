import { describe, expect, it } from 'vitest';
import type { GalleryImage, Message } from '../types';
import {
    formatLibraryFileRecord,
    libraryFileExtension,
    libraryFileMessageContent,
    libraryFileMessageMetadata,
    libraryPhotoMessageMetadata,
} from './libraryShare';
import { normalizeMessageContent } from './messageFormat';

const item = (patch: Partial<GalleryImage>): GalleryImage => ({ id: 'lib-1', charId: '', url: 'blobref:b_x', timestamp: 1, ...patch });

describe('從資料庫發給角色', () => {
    it('照片：記 libraryImageId（不再多存一張），有描述才帶 visionDescription', () => {
        expect(libraryPhotoMessageMetadata(item({ description: ' 陽台的咖啡杯 ' }))).toEqual({ libraryImageId: 'lib-1', visionDescription: '陽台的咖啡杯' });
        expect(libraryPhotoMessageMetadata(item({}))).toEqual({ libraryImageId: 'lib-1' });
    });

    it('文件：卡片內容和 metadata，令牌放在 metadata 裡', () => {
        const doc = item({ kind: 'file', file: { name: '企劃書.pdf', mime: 'application/pdf', size: 204800 }, description: '第二版' });
        expect(libraryFileMessageContent(doc)).toBe('[文件：企劃書.pdf]');
        expect(libraryFileMessageMetadata(doc)).toEqual({
            libraryFile: { libraryImageId: 'lib-1', name: '企劃書.pdf', mime: 'application/pdf', size: 204800, ref: 'blobref:b_x', note: '第二版' },
        });
    });

    it('副檔名：檔名優先，沒有就看類型', () => {
        expect(libraryFileExtension({ name: 'notes.docx', mime: '' })).toBe('DOCX');
        expect(libraryFileExtension({ name: '合約', mime: 'application/pdf' })).toBe('PDF');
        expect(libraryFileExtension({ name: '合約', mime: 'text/plain' })).toBe('FILE');
    });

    it('角色看到的那行：檔名、類型、大小、備註，說明打不開內容；總結器同一行', () => {
        const meta = { name: '企劃書.pdf', mime: 'application/pdf', size: 204800, note: '第二版\n改了預算' };
        const line = formatLibraryFileRecord(meta, '小星');
        expect(line).toBe('[小星傳了一份文件給你：《企劃書.pdf》（PDF · 200 KB），備註：第二版 改了預算。你看得到檔名和備註，還打不開內容。]');
        const msg = { id: 1, charId: 'c', role: 'user', type: 'library_file', content: '[文件：企劃書.pdf]', timestamp: 1, metadata: { libraryFile: meta } } as Message;
        expect(normalizeMessageContent(msg, 'Soren', '小星')).toBe(line);
        expect(formatLibraryFileRecord(undefined, '')).toContain('對方傳了一份文件給你：《未命名文件》');
    });
});
