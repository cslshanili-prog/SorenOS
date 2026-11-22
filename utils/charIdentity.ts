/**
 * 角色的別名、身份、簡介（plans/character-identity-fields.md）。神經鏈接角色頁名字下面那三格，讀取只走這裡：
 * - 別名 aliases：TA 客觀上的其他名字。跟聊天設定的暱稱（chatNickname，某張身份卡怎麼叫 TA）是兩回事
 * - 身份 roleTitle：一行，「攝影師」「段家長子」
 * - 簡介 description：一句話介紹（以前介面上叫「描述」，被當成「用戶備註」和「角色簡介」兩種東西讀）
 *
 * 沒填別名和身份的角色，這裡每個函式吐出來的字都跟拆欄位之前一樣（名字就是名字、介紹就是簡介原文），
 * 所以各處提示詞除了私聊身份段那行標籤以外不會變。零依賴（型別以外不引任何東西），worker 那頭也能用。
 */
import type { CharacterProfile } from '../types';

export const ALIAS_MAX_COUNT = 8;
export const ALIAS_MAX_LENGTH = 20;
export const ROLE_TITLE_MAX_LENGTH = 40;

type Named = Pick<CharacterProfile, 'name'> & Partial<Pick<CharacterProfile, 'aliases'>>;
type Introduced = Partial<Pick<CharacterProfile, 'roleTitle' | 'description'>>;

/** 比名字用：全半形、空白、頭尾引號、大小寫不算差別 */
export const nameKey = (value: string): string =>
    String(value ?? '').normalize('NFKC').replace(/\s+/g, '').replace(/^[「『"“'‘]+|[」』"”'’]+$/g, '').toLowerCase();

const cleanAlias = (raw: string): string =>
    String(raw ?? '').replace(/[\r\n\t]+/g, ' ').trim().replace(/^[「『"“'‘]+|[」』"”'’]+$/g, '').trim().slice(0, ALIAS_MAX_LENGTH).trim();

/** 整理一串別名：去空、去掉跟名字一樣的、去重（照 nameKey），最多 8 個 */
export function normalizeAliases(list: ReadonlyArray<unknown> | null | undefined, name = ''): string[] {
    const seen = new Set<string>([nameKey(name)]);
    const out: string[] = [];
    for (const raw of list || []) {
        if (typeof raw !== 'string') continue;
        const alias = cleanAlias(raw);
        const key = nameKey(alias);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(alias);
        if (out.length >= ALIAS_MAX_COUNT) break;
    }
    return out;
}

/** 介面那一格的字 → 別名：逗號、頓號、分號、換行都當分隔（全形半形都收） */
export const parseAliasInput = (text: string, name = ''): string[] =>
    normalizeAliases(String(text ?? '').split(/[,，、;；\n]+/), name);

/** 別名 → 介面那一格的字 */
export const formatAliasInput = (aliases: ReadonlyArray<string> | null | undefined): string => (aliases || []).filter(Boolean).join('、');

export const charAliases = (c: Named | null | undefined): string[] => (c ? normalizeAliases(c.aliases, c.name) : []);

export const charRoleTitle = (c: Introduced | null | undefined): string => (c?.roleTitle || '').replace(/\s+/g, ' ').trim().slice(0, ROLE_TITLE_MAX_LENGTH);

/** 給 AI 看的名字：有別名寫成「陸薇寧（又叫 Vivian、陸姐）」，沒有就是名字原樣 */
export function charNameLine(c: Named): string {
    const aliases = charAliases(c);
    return aliases.length ? `${c.name}（又叫 ${aliases.join('、')}）` : c.name;
}

/** 清單上名字下面那行小字：「身份 · 簡介」，只有一樣就那一樣，都沒有回空字串（各清單自己的預設字照舊） */
export function charSubtitle(c: Introduced | null | undefined): string {
    const role = charRoleTitle(c);
    const brief = (c?.description || '').trim();
    return role && brief ? `${role} · ${brief}` : role || brief;
}

/**
 * 給 AI 的一行介紹。沒填身份時回簡介原文（一個字都不動，原本各處怎麼截、怎麼給預設字照舊）；
 * 有身份時「身份；簡介」，只有身份就只有身份。
 */
export function charOneLiner(c: Introduced | null | undefined): string {
    const role = charRoleTitle(c);
    const brief = c?.description || '';
    if (!role) return brief;
    return brief.trim() ? `${role}；${brief.trim()}` : role;
}

/**
 * 私聊身份段裡名字底下那幾行（utils/context.ts）：別名、身份、簡介，沒填的那行不出。
 * 簡介後面那句是給舊資料的：以前這格被標成「用戶備註／愛稱」，有人拿來寫「快樂小狗」這種暱稱。
 */
export function charIdentityLines(c: Named & Introduced): string[] {
    const aliases = charAliases(c);
    const role = charRoleTitle(c);
    const brief = (c.description || '').trim();
    return [
        aliases.length ? `- 別名: ${aliases.join('、')}` : '',
        role ? `- 身份: ${role}` : '',
        brief ? `- 簡介: ${brief}` : '',
        brief ? `  (簡介是用戶寫的一句話印象，可能包含比喻；跟核心設定衝突時以核心設定為準，不要照字面扮演)` : '',
    ].filter(Boolean);
}

/** 搜尋用：名字以外還能拿來找這個角色的字（別名、身份、簡介） */
export const charSearchFields = (c: (Named & Introduced) | null | undefined): string[] =>
    (c ? [...charAliases(c), charRoleTitle(c), (c.description || '').trim()].filter(Boolean) : []);
