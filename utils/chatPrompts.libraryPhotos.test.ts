import { describe, it, expect, beforeAll } from 'vitest';
import { ChatPrompts } from './chatPrompts';
import { DB } from './db';
import { libraryPhotoCode } from './libraryPrompt';

// 「你手邊的照片」只在會處理 SEND_SAVED_PHOTO 的私聊路徑帶（libraryPhotos: true），
// 雲端兩條路（fire_pack、即時對話）也帶（worker 原樣送回標籤），沒開的入口不帶。放易變段，新照片進來不弄髒穩定段快取。
const char = { id: 'char-lib', name: 'Soren', groupId: 'w-lib' } as any;
const userProfile = { name: '小星' } as any;

const build = (promptOptions?: Record<string, unknown>) => ChatPrompts.buildSystemPromptParts(
    char, userProfile, [], [], [], [],
    undefined, undefined, undefined, undefined, undefined, undefined,
    promptOptions as any,
);

describe('私聊提示詞 · 你手邊的照片', () => {
    beforeAll(async () => {
        await DB.saveGalleryImage({ id: 'lib-shared', charId: '', url: 'blobref:b_lib1', timestamp: 2, origin: 'upload', access: { mode: 'all' }, description: '陽台的咖啡杯' });
        await DB.saveGalleryImage({ id: 'lib-nodesc', charId: 'char-lib', url: 'blobref:b_lib2', timestamp: 3, sender: 'char' });
    });

    it('開了才帶，放在易變段', async () => {
        const parts = await build({ libraryPhotos: true });
        expect(parts.volatileState).toContain('### 你手邊的照片');
        expect(parts.volatileState).toContain(`- ${libraryPhotoCode('lib-shared')}｜陽台的咖啡杯`);
        expect(parts.volatileState).toContain('[[ACTION:SEND_SAVED_PHOTO|編號]]');
        expect(parts.volatileState).not.toContain(libraryPhotoCode('lib-nodesc'));
        expect(parts.stable).not.toContain('你手邊的照片');
    });

    it('沒開的入口不帶', async () => {
        const parts = await build(undefined);
        expect(parts.volatileState + parts.stable).not.toContain('SEND_SAVED_PHOTO');
    });

    it('雲端兩條路（fire_pack、即時對話）開了也帶', async () => {
        for (const options of [{ libraryPhotos: true, forFirePack: true }, { libraryPhotos: true, timelyByWorker: true }]) {
            const parts = await build(options);
            expect(parts.volatileState).toContain(`- ${libraryPhotoCode('lib-shared')}｜陽台的咖啡杯`);
        }
    });
});
