import type { CharacterProfile, VRLibraryCategory, VRWorldNovel } from '../../types';

export const VR_LIBRARY_RECORD = 'library-categories-v1';
export type LibraryEdit =
    | { kind: 'create'; id: string; name: string }
    | { kind: 'rename'; id: string; name: string }
    | { kind: 'remove'; id: string }
    | { kind: 'assign'; novelIds: string[]; categoryId?: string };

export function normalizeCategoryName(name: string): string {
    return name.trim().replace(/\s+/g, ' ').slice(0, 24);
}

/** Pure validation/transformation; DB applies these changes in one transaction. */
export function editLibrary(categories: VRLibraryCategory[], novels: VRWorldNovel[], edit: LibraryEdit) {
    let next = categories;
    let changed: VRWorldNovel[] = [];
    if (edit.kind === 'create' || edit.kind === 'rename') {
        const name = normalizeCategoryName(edit.name);
        if (!name) throw Error('請填寫分類名稱');
        if (categories.some(c => c.id !== edit.id && c.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw Error('已經有同名分類了');
        if (edit.kind === 'create') {
            if (categories.some(c => c.id === edit.id)) throw Error('分類已經存在');
            next = [...categories, { id: edit.id, name }];
        } else {
            if (!categories.some(c => c.id === edit.id)) throw Error('分類已被移除，請刷新後重試');
            next = categories.map(c => c.id === edit.id ? { ...c, name } : c);
        }
    } else if (edit.kind === 'remove') {
        next = categories.filter(c => c.id !== edit.id);
        changed = novels.filter(n => n.categoryId === edit.id).map(n => ({ ...n, categoryId: undefined }));
    } else {
        if (edit.categoryId && !categories.some(c => c.id === edit.categoryId)) throw Error('分類已被移除，請重新選擇');
        const ids = new Set(edit.novelIds);
        changed = novels.filter(n => ids.has(n.id)).map(n => ({ ...n, categoryId: edit.categoryId || undefined }));
    }
    return { categories: next, changed };
}

export function novelReadingMode(char: Pick<CharacterProfile, 'vrState'>) {
    return char.vrState?.novelReadingMode ?? ((char.vrState?.preferredNovelIds?.length || 0) > 0 ? 'books' : 'all');
}

export function readableNovels(novels: VRWorldNovel[], char: Pick<CharacterProfile, 'vrState'>): VRWorldNovel[] {
    const ids = new Set(char.vrState?.preferredNovelCategoryIds || []);
    return novels.filter(n => n.segments.length > 0 && (novelReadingMode(char) !== 'categories' || (!!n.categoryId && ids.has(n.categoryId))));
}

export function readingPreferenceLabel(char: Pick<CharacterProfile, 'vrState'>): string {
    const mode = novelReadingMode(char);
    return mode === 'categories' ? `按 ${char.vrState?.preferredNovelCategoryIds?.length || 0} 個分類輪換`
        : mode === 'books' ? `優先 ${char.vrState?.preferredNovelIds?.length || 0} 本` : '自動輪換全部';
}
