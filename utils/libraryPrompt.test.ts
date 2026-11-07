import { describe, expect, it } from 'vitest';
import type { GalleryImage } from '../types';
import {
    SEND_SAVED_PHOTO_RE,
    buildLibraryPhotoBlock,
    libraryPhotoCode,
    pickCharLibraryPhotos,
    resolveLibraryPhotoCode,
} from './libraryPrompt';

const img = (patch: Partial<GalleryImage>): GalleryImage => ({ id: 'i', charId: 'a', url: 'blobref:x', timestamp: 1, ...patch });
const soren = { id: 'a', groupId: 'w1' };

describe('資料庫 · 角色手邊的照片', () => {
    const images = [
        img({ id: 'own-selfie', sender: 'char', description: '早上剛醒的自拍', timestamp: 5 }),
        img({ id: 'no-desc', sender: 'char', timestamp: 9 }),
        img({ id: 'shared', charId: '', origin: 'upload', access: { mode: 'all' }, description: '陽台的咖啡杯', timestamp: 7 }),
        img({ id: 'other-char', charId: 'b', sender: 'char', description: 'Elio 的貓', timestamp: 8 }),
        img({ id: 'world', charId: 'b', sender: 'char', access: { mode: 'worlds', worldIds: ['w1'] }, description: '同一個城市的夜景', timestamp: 6 }),
    ];

    it('只列能用、有描述的，新的在前', () => {
        expect(pickCharLibraryPhotos(images, soren).map(i => i.id)).toEqual(['shared', 'world', 'own-selfie']);
        expect(pickCharLibraryPhotos(images, soren, 1).map(i => i.id)).toEqual(['shared']);
    });

    it('提示詞：每張一個編號，只對自己的照片說來源，描述截到 60 字', () => {
        const long = img({ id: 'long', description: '海'.repeat(80), timestamp: 10 });
        const block = buildLibraryPhotoBlock([long, ...pickCharLibraryPhotos(images, soren)], 'a', '小星');
        expect(block).toContain('### 你手邊的照片');
        expect(block).toContain('想給小星看哪張');
        expect(block).toContain(`- ${libraryPhotoCode('own-selfie')}｜你之前傳過的｜早上剛醒的自拍`);
        expect(block).toContain(`- ${libraryPhotoCode('world')}｜同一個城市的夜景`);
        expect(block).toContain(`${'海'.repeat(60)}…`);
        expect(block).toContain(`${libraryPhotoCode('long')}｜對方傳給你的｜`);
        expect(buildLibraryPhotoBlock([], 'a', '小星')).toBe('');
    });

    it('編號穩定、4 位', () => {
        expect(libraryPhotoCode('img-1')).toBe(libraryPhotoCode('img-1'));
        expect(libraryPhotoCode('img-1')).toMatch(/^[0-9a-z]{4}$/);
        expect(libraryPhotoCode('img-1')).not.toBe(libraryPhotoCode('img-2'));
    });

    it('照編號找回：容忍 # 和大小寫；別人的圖、沒分配給它的找不到', () => {
        const code = libraryPhotoCode('shared');
        expect(resolveLibraryPhotoCode(images, soren, `#${code.toUpperCase()}`)?.id).toBe('shared');
        expect(resolveLibraryPhotoCode(images, soren, libraryPhotoCode('other-char'))).toBeNull();
        expect(resolveLibraryPhotoCode(images, soren, 'zzzz')).toBeNull();
        expect(resolveLibraryPhotoCode(images, soren, '')).toBeNull();
    });

    it('標籤寫法：半形全形冒號、豎線都認', () => {
        const text = '給你看\n[[ACTION:SEND_SAVED_PHOTO|ab12]]\n[[ACTION：SEND_SAVED_PHOTO｜#cd34 ]]';
        expect([...text.matchAll(SEND_SAVED_PHOTO_RE)].map(m => m[1])).toEqual(['ab12', '#cd34']);
    });
});

describe('資料庫 · 文件不當照片', () => {
    it('歸檔的文件就算有描述也不列、也找不回', () => {
        const doc = img({ id: 'doc', kind: 'file', description: '企劃書', access: { mode: 'all' } });
        expect(pickCharLibraryPhotos([doc], soren)).toEqual([]);
        expect(resolveLibraryPhotoCode([doc], soren, libraryPhotoCode('doc'))).toBeNull();
    });
});
