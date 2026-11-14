/**
 * 全局世界書（docs/worldbook-management.md「全局啟用」）：世界書 App 開了「全局啟用」的那幾組，
 * 所有角色的私聊、群聊、見面、通話、小劇場都讀得到，跟角色自己掛的合在一起（同一條不重複）。
 *
 * 組提示詞的地方大多是只拿得到角色的純函式，所以全局那份放在這裡登記（OSContext 在世界書庫變動時更新），
 * 讀的時候一律用 withGlobalWorldbooks(char.mountedWorldbooks)。角色卡上的 mountedWorldbooks 不會被寫進全局條目。
 */
import type { MountedWorldbook, Worldbook } from '../types';
import { toMountedWorldbook } from './worldbook';

let globalEntries: MountedWorldbook[] = [];

/** 世界書庫變了就叫一次（OSContext） */
export function setGlobalWorldbooks(books: Worldbook[]): void {
    globalEntries = books.filter(b => b.global).map(toMountedWorldbook);
}

export const globalWorldbookEntries = (): MountedWorldbook[] => globalEntries;

/** 角色自己掛的＋全局的（自己掛的在前；同一條 id 只留一份） */
export function withGlobalWorldbooks(mounted: MountedWorldbook[] | undefined): MountedWorldbook[] {
    const own = mounted || [];
    if (!globalEntries.length) return own;
    const ids = new Set(own.map(b => b.id));
    const extra = globalEntries.filter(e => !ids.has(e.id));
    return extra.length ? [...own, ...extra] : own;
}

/** 哪幾組是全局啟用（組裡每一條都開著才算整組開；空組不算） */
export function globalCategories(books: Pick<Worldbook, 'category' | 'global'>[]): Set<string> {
    const all = new Map<string, boolean>();
    for (const b of books) {
        const cat = b.category || '';
        all.set(cat, (all.get(cat) ?? true) && !!b.global);
    }
    return new Set([...all].filter(([, on]) => on).map(([cat]) => cat));
}
