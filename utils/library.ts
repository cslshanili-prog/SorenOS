/**
 * 資料庫（原本的相簿）：一張圖從哪來、誰能用。設計見 plans/asset-library-design.md。
 *
 * 資料還是存在相簿那張 gallery 表（GalleryImage），只是多了描述和分配：
 * 那張表已經接好備份、收藏、圖片清理（blobGc 的引用面），另開新表得每條路重接一次。
 */

import type { CharacterGroup, CharacterProfile, GalleryImage, LibraryAccess } from '../types';

export const LIBRARY_DESCRIPTION_MAX = 500;

export type LibrarySource = 'chat_char' | 'chat_user' | 'date_moment' | 'upload' | 'generated';

export const LIBRARY_SOURCE_LABEL: Record<LibrarySource, string> = {
    chat_char: '角色傳的',
    chat_user: '你傳的',
    date_moment: '見面拍的',
    upload: '你上傳的',
    generated: '在這裡生成的',
};

export const LIBRARY_SOURCES: LibrarySource[] = ['chat_char', 'chat_user', 'date_moment', 'upload', 'generated'];

export const librarySourceOf = (image: GalleryImage): LibrarySource => {
    if (image.origin === 'upload') return 'upload';
    if (image.origin === 'generated') return 'generated';
    if (image.origin === 'date_moment') return 'date_moment';
    return image.sender === 'char' ? 'chat_char' : 'chat_user';
};

/** 這張圖現在給誰用（沒寫的舊圖＝原本那個角色） */
export const resolveLibraryAccess = (image: GalleryImage): LibraryAccess => {
    const access = image.access;
    if (access?.mode === 'all') return { mode: 'all' };
    if (access?.mode === 'worlds') return { mode: 'worlds', worldIds: [...new Set(access.worldIds.filter(Boolean))] };
    if (access?.mode === 'chars') return { mode: 'chars', charIds: [...new Set(access.charIds.filter(Boolean))] };
    return { mode: 'chars', charIds: image.charId ? [image.charId] : [] };
};

export const canCharUseLibraryImage = (image: GalleryImage, char: Pick<CharacterProfile, 'id' | 'groupId'>): boolean => {
    const access = resolveLibraryAccess(image);
    if (access.mode === 'all') return true;
    if (access.mode === 'worlds') return !!char.groupId && access.worldIds.includes(char.groupId);
    return access.charIds.includes(char.id);
};

export const isLibraryAccessEmpty = (access: LibraryAccess): boolean =>
    access.mode === 'worlds' ? access.worldIds.length === 0 : access.mode === 'chars' ? access.charIds.length === 0 : false;

/** 一行說明誰能用；刪掉的世界、角色不列 */
export const describeLibraryAccess = (
    access: LibraryAccess,
    chars: Pick<CharacterProfile, 'id' | 'name'>[],
    worlds: Pick<CharacterGroup, 'id' | 'name'>[],
): string => {
    if (access.mode === 'all') return '所有角色共用';
    const names = access.mode === 'worlds'
        ? access.worldIds.map(id => worlds.find(world => world.id === id)?.name).filter(Boolean)
        : access.charIds.map(id => chars.find(char => char.id === id)?.name).filter(Boolean);
    if (!names.length) return '還沒分配給誰';
    const shown = names.length > 3 ? `${names.slice(0, 3).join('、')} 等 ${names.length} 個` : names.join('、');
    return access.mode === 'worlds' ? `世界：${shown}` : shown;
};

export const normalizeLibraryDescription = (text: string): string | undefined => {
    const trimmed = text.trim().slice(0, LIBRARY_DESCRIPTION_MAX);
    return trimmed || undefined;
};

export interface LibraryFilter {
    source: 'all' | LibrarySource;
    /** 只看某個角色能用的 */
    charId?: string;
}

export const filterLibraryImages = (
    images: GalleryImage[],
    filter: LibraryFilter,
    chars: Pick<CharacterProfile, 'id' | 'groupId'>[],
): GalleryImage[] => {
    const char = filter.charId ? chars.find(c => c.id === filter.charId) : undefined;
    return images.filter(image =>
        (filter.source === 'all' || librarySourceOf(image) === filter.source)
        && (!filter.charId || (char ? canCharUseLibraryImage(image, char) : false)),
    );
};

export const makeLibraryImageId = () => `img-${Date.now()}-${Math.random()}`;
