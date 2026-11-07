import { describe, expect, it } from 'vitest';
import type { GalleryImage } from '../types';
import {
    canCharUseLibraryImage,
    describeLibraryAccess,
    filterLibraryImages,
    librarySourceOf,
    normalizeLibraryDescription,
    resolveLibraryAccess,
} from './library';

const img = (patch: Partial<GalleryImage>): GalleryImage => ({ id: 'i', charId: 'a', url: 'blobref:x', timestamp: 1, ...patch });
const chars = [
    { id: 'a', name: 'Soren', groupId: 'w1' },
    { id: 'b', name: 'Elio', groupId: 'w2' },
    { id: 'c', name: 'Kai' },
];
const worlds = [{ id: 'w1', name: '現代' }, { id: 'w2', name: '奇幻' }];

describe('資料庫 · 來源', () => {
    it('照 origin／sender 分', () => {
        expect(librarySourceOf(img({}))).toBe('chat_user');
        expect(librarySourceOf(img({ sender: 'char' }))).toBe('chat_char');
        expect(librarySourceOf(img({ sender: 'char', origin: 'date_moment' }))).toBe('date_moment');
        expect(librarySourceOf(img({ charId: '', origin: 'upload' }))).toBe('upload');
    });
});

describe('資料庫 · 誰能用', () => {
    it('舊圖沒寫分配＝原本那個角色；上傳的沒來源角色就是沒人', () => {
        expect(resolveLibraryAccess(img({}))).toEqual({ mode: 'chars', charIds: ['a'] });
        expect(resolveLibraryAccess(img({ charId: '' }))).toEqual({ mode: 'chars', charIds: [] });
    });

    it('三種分配', () => {
        const shared = img({ access: { mode: 'all' } });
        expect(chars.every(c => canCharUseLibraryImage(shared, c))).toBe(true);
        const world = img({ access: { mode: 'worlds', worldIds: ['w1'] } });
        expect(chars.map(c => canCharUseLibraryImage(world, c))).toEqual([true, false, false]);
        const picked = img({ access: { mode: 'chars', charIds: ['b', 'c'] } });
        expect(chars.map(c => canCharUseLibraryImage(picked, c))).toEqual([false, true, true]);
    });

    it('說明文字：刪掉的不列、太多就省略', () => {
        expect(describeLibraryAccess({ mode: 'all' }, chars, worlds)).toBe('所有角色共用');
        expect(describeLibraryAccess({ mode: 'worlds', worldIds: ['w2', 'gone'] }, chars, worlds)).toBe('世界：奇幻');
        expect(describeLibraryAccess({ mode: 'chars', charIds: ['gone'] }, chars, worlds)).toBe('還沒分配給誰');
        const many = [...chars, { id: 'd', name: 'D' }];
        expect(describeLibraryAccess({ mode: 'chars', charIds: ['a', 'b', 'c', 'd'] }, many, worlds)).toBe('Soren、Elio、Kai 等 4 個');
    });

    it('篩選：來源＋某角色能用的', () => {
        const list = [
            img({ id: '1' }),
            img({ id: '2', sender: 'char', charId: 'b' }),
            img({ id: '3', charId: '', origin: 'upload', access: { mode: 'all' } }),
        ];
        expect(filterLibraryImages(list, { source: 'all', charId: 'a' }, chars).map(i => i.id)).toEqual(['1', '3']);
        expect(filterLibraryImages(list, { source: 'chat_char' }, chars).map(i => i.id)).toEqual(['2']);
        expect(filterLibraryImages(list, { source: 'all', charId: 'gone' }, chars)).toEqual([]);
    });

    it('描述：去空白、截長、空的不存', () => {
        expect(normalizeLibraryDescription('  ')).toBeUndefined();
        expect(normalizeLibraryDescription(' 海邊 ')).toBe('海邊');
        expect(normalizeLibraryDescription('字'.repeat(600))!.length).toBe(500);
    });
});
