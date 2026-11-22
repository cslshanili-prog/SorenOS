/**
 * 靠名字認人（plans/character-identity-fields.md 3.5）。模型寫的、匯入檔案裡的、用戶打的名字 → 名單上的哪一位。
 * 以前七八處各寫各的比對，全都只認名字那一格；現在名字之外也認別名（aliases），規則只在這裡：
 *
 * 1. 名字相同（全半形、空白、頭尾引號、大小寫、繁簡不算差別）。同名的照名單順序拿第一個，跟以前一樣。
 * 2. 別名相同。剛好一位才算；兩位以上的別名撞在一起 → 當沒認出來，不猜。
 * 3. 開了 fuzzy 才做：名字互相包含（「學長阿哲」認得出「阿哲」）。別名不做包含，「小陸」這種太容易誤中。
 *
 * 名字贏過別名：A 叫「小陸」、B 的別名也有「小陸」，寫「小陸」認 A。
 * 範圍由呼叫的地方給（同世界、群成員、關係清單…），這裡不擴大名單，只是讓名單上的人多幾個叫法。
 * 小號：名單上放的是小號那張卡，別名是小號自己的；本人的別名不會讓小號被認出來（altPersonaView 也不帶本人的）。
 */
import { nameKey, normalizeAliases } from './charIdentity';
import { scriptKey } from './scriptKey';

export interface MatchablePerson {
    name?: string | null;
    aliases?: ReadonlyArray<string> | null;
}

export interface MatchOptions {
    /** 名字互相包含也算（別名不做） */
    fuzzy?: boolean;
    /** 互相包含時，名單上那個名字至少要幾個字（預設 1；空名字永遠不算） */
    fuzzyMinLength?: number;
}

export type MatchVia = 'name' | 'alias' | 'fuzzy';

/** 比名字用的 key：nameKey 再加繁簡歸一 */
export const personKey = (value: string | null | undefined): string => scriptKey(nameKey(value || ''));

export function matchPersonDetail<T extends MatchablePerson>(raw: string | null | undefined, people: ReadonlyArray<T>, opts: MatchOptions = {}): { person: T; via: MatchVia } | null {
    const key = personKey(raw);
    if (!key) return null;
    const byName = people.find(p => personKey(p.name) === key);
    if (byName) return { person: byName, via: 'name' };
    const byAlias = [...new Set(people.filter(p => normalizeAliases(p.aliases, p.name || '').some(alias => personKey(alias) === key)))];
    if (byAlias.length === 1) return { person: byAlias[0], via: 'alias' };
    if (byAlias.length > 1) return null;
    if (opts.fuzzy) {
        const min = Math.max(1, opts.fuzzyMinLength ?? 1);
        const hit = people.find(p => {
            const pk = personKey(p.name);
            return pk.length >= min && (pk.includes(key) || key.includes(pk));
        });
        if (hit) return { person: hit, via: 'fuzzy' };
    }
    return null;
}

export const matchPerson = <T extends MatchablePerson>(raw: string | null | undefined, people: ReadonlyArray<T>, opts?: MatchOptions): T | null =>
    matchPersonDetail(raw, people, opts)?.person ?? null;

export interface AliasClash {
    alias: string;
    /** 撞到誰 */
    withName: string;
    /** 撞到對方的名字，還是對方的別名 */
    kind: 'name' | 'alias';
}

/**
 * 角色頁填別名時的提醒：這些別名在名單上（同一個世界的其他人）已經有人用了。
 * 撞到別人的名字：寫這個別名永遠認到對方，等於沒用。撞到別人的別名：兩個都認不出來。照樣可以存，只是提醒。
 */
export function findAliasClashes(aliases: ReadonlyArray<string> | null | undefined, selfName: string, others: ReadonlyArray<MatchablePerson>): AliasClash[] {
    const out: AliasClash[] = [];
    for (const alias of normalizeAliases(aliases, selfName)) {
        const key = personKey(alias);
        const named = others.find(o => personKey(o.name) === key);
        if (named) { out.push({ alias, withName: named.name || '', kind: 'name' }); continue; }
        const aliased = others.find(o => normalizeAliases(o.aliases, o.name || '').some(a => personKey(a) === key));
        if (aliased) out.push({ alias, withName: aliased.name || '', kind: 'alias' });
    }
    return out;
}

/** 別名（不是名字）對得上的人：給「先照 id／名字找，找不到再照別名」的地方用 */
export function peopleByAlias<T extends MatchablePerson>(raw: string | null | undefined, people: ReadonlyArray<T>): T[] {
    const key = personKey(raw);
    if (!key) return [];
    return people.filter(p => personKey(p.name) !== key && normalizeAliases(p.aliases, p.name || '').some(alias => personKey(alias) === key));
}

/**
 * 「角色名或 id」→ 那個人（Sore 的工具用）：id → 名字剛好一位 → 別名剛好一位。
 * 同名好幾位就回 undefined（要對方改用 id），不拿別名去猜。
 */
export function findPersonByRef<T extends MatchablePerson & { id: string }>(ref: string | null | undefined, pool: ReadonlyArray<T>): T | undefined {
    const raw = String(ref ?? '').trim();
    if (!raw) return undefined;
    const byId = pool.find(p => p.id === raw);
    if (byId) return byId;
    const named = pool.filter(p => p.name === raw);
    if (named.length) return named.length === 1 ? named[0] : undefined;
    const aliased = peopleByAlias(raw, pool);
    return aliased.length === 1 ? aliased[0] : undefined;
}
