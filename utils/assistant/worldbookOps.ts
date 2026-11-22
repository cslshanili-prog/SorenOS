/**
 * Sore 改世界書（plans/ai-assistant.md 第 12 節，第 4 批）。純邏輯：列出、讀、把一串操作算成提案；真的寫由畫面做。
 *
 * - 以「組」（category）為單位：一張卡片只動一組。
 * - 能加條目、改條目（內容、觸發、位置…）、停用／啟用、整組改名、整組全局開關、掛給／取消掛給角色。
 * - **不能刪條目**（Liora 定的）：要刪去世界書 App。還原時刪掉 Sore 自己加的那幾條不算（那是撤銷）。
 * - 欄位照 SillyTavern（docs/worldbook-management.md），新條目的預設值跟世界書 App 新增時一樣。
 * - 「讀取角色」只給人設、世界觀、掛了哪些世界書；不給聊天記錄和記憶（Liora 定的）。
 */
import { findPersonByRef } from '../personMatch';
import { charAliases, charRoleTitle } from '../charIdentity';
import type {
    AssistantWorldbookProposal, CharacterProfile, MountedWorldbook, Worldbook, WorldbookDepthRole, WorldbookPosition,
} from '../../types';
import { splitWorldbookKeywords, toMountedWorldbook, WORLDBOOK_POSITION_LABELS } from '../worldbook';
import { globalCategories } from '../globalWorldbooks';

export interface WorldbookData {
    worldbooks: Worldbook[];
    characters: Pick<CharacterProfile, 'id' | 'name' | 'altOf' | 'description' | 'systemPrompt' | 'worldview' | 'mountedWorldbooks'>[];
}

const DEFAULT_GROUP = '未分類設定 (General)';
const groupOf = (book: Pick<Worldbook, 'category'>) => book.category?.trim() || DEFAULT_GROUP;
const visibleChars = (data: WorldbookData) => data.characters.filter(c => !c.altOf);

/** 這組的條目掛在哪些角色身上（照 id） */
const mountedBy = (ids: Set<string>, data: WorldbookData) =>
    visibleChars(data).filter(c => (c.mountedWorldbooks || []).some(m => ids.has(m.id)));

const triggerText = (b: Pick<Worldbook, 'constant' | 'key' | 'keysecondary'>) =>
    b.constant ? '常駐' : `關鍵詞：${(b.key || []).join('、') || '（沒有）'}${b.keysecondary?.length ? `；輔助：${b.keysecondary.join('、')}` : ''}`;

const positionText = (b: Pick<Worldbook, 'position' | 'depth'>) => {
    const pos = (b.position ?? 1) as WorldbookPosition;
    return `${WORLDBOOK_POSITION_LABELS[pos]}${pos === 4 ? `（深度 ${b.depth ?? 4}）` : ''}`;
};

export const describeWorldbookList = (data: WorldbookData): string => {
    const groups = new Map<string, Worldbook[]>();
    data.worldbooks.forEach(b => groups.set(groupOf(b), [...(groups.get(groupOf(b)) || []), b]));
    const global = globalCategories(data.worldbooks);
    if (!groups.size) return '世界書是空的。';
    return [...groups.entries()].map(([name, books]) => {
        const users = mountedBy(new Set(books.map(b => b.id)), data).map(c => c.name);
        const off = books.filter(b => b.disable).length;
        return `- 「${name}」${books.length} 條${off ? `（${off} 條停用）` : ''}｜${global.has(name) ? '全局啟用（所有角色都讀得到）' : users.length ? `掛給：${users.join('、')}` : '沒掛給任何角色'}`;
    }).join('\n');
};

/** 一組的每條（不含全文，內容只給開頭）；給 entry 就是那一條全文 */
export const describeWorldbook = (group: unknown, entry: unknown, data: WorldbookData): { ok: boolean; content: string } => {
    const name = typeof group === 'string' ? group.trim() : '';
    const books = data.worldbooks.filter(b => groupOf(b) === name);
    if (!books.length) return { ok: false, content: `找不到「${name}」這組。用「列出世界書」看有哪些。` };
    if (entry !== undefined) {
        const hit = findEntry(books, entry);
        if ('error' in hit) return { ok: false, content: hit.error };
        const b = hit.book;
        return {
            ok: true,
            content: `「${b.title}」id=${b.id}${b.disable ? '（停用）' : ''}\n觸發：${triggerText(b)}\n位置：${positionText(b)}；順序 ${b.order ?? 100}\n---\n${b.content || '（空白）'}`,
        };
    }
    const users = mountedBy(new Set(books.map(b => b.id)), data).map(c => c.name);
    return {
        ok: true,
        content: [
            `# 「${name}」${globalCategories(data.worldbooks).has(name) ? '（全局啟用）' : ''}`,
            users.length ? `掛給：${users.join('、')}` : '沒掛給任何角色',
            ...books.map((b, i) => `${i + 1}. id=${b.id}「${b.title}」${b.disable ? '[停用]' : ''}｜${triggerText(b)}｜${positionText(b)}｜${b.content.trim().length} 字：${b.content.trim().slice(0, 60).replace(/\n/g, ' ')}${b.content.trim().length > 60 ? '…' : ''}`),
        ].join('\n'),
    };
};

/** 「讀取角色」：人設、世界觀、掛了哪些世界書；不給聊天和記憶 */
export const describeCharacter = (ref: unknown, data: WorldbookData): { ok: boolean; content: string } => {
    const raw = typeof ref === 'string' ? ref.trim() : '';
    const pool = visibleChars(data);
    const hit = findPersonByRef(raw, pool);
    if (!hit) return { ok: false, content: `找不到角色「${raw}」（同名的話用 id）。角色：${pool.map(c => c.name).join('、') || '沒有'}` };
    const cap = (text?: string) => {
        const t = (text || '').trim();
        return t.length > 6000 ? `${t.slice(0, 6000)}…（後面還有 ${t.length - 6000} 字）` : t || '（沒寫）';
    };
    const mounted = (hit.mountedWorldbooks || []).map(m => `${m.category || DEFAULT_GROUP}／${m.title}`);
    return {
        ok: true,
        content: [
            `# ${hit.name}（id=${hit.id}）`,
            `別名：${charAliases(hit).join('、') || '（沒寫）'}`,
            `身份／職位：${charRoleTitle(hit) || '（沒寫）'}`,
            `簡介：${cap(hit.description)}`,
            `人設：${cap(hit.systemPrompt)}`,
            `世界觀：${cap(hit.worldview)}`,
            `掛的世界書：${mounted.join('、') || '沒有'}`,
        ].join('\n\n'),
    };
};

// ─── 操作 ───

const findEntry = (books: Worldbook[], ref: unknown): { book: Worldbook } | { error: string } => {
    const raw = typeof ref === 'string' ? ref.trim() : '';
    if (!raw) return { error: '要指定是哪條（entry 填標題或 id）' };
    const byId = books.find(b => b.id === raw);
    if (byId) return { book: byId };
    const named = books.filter(b => b.title.trim() === raw);
    if (named.length > 1) return { error: `這組有 ${named.length} 條叫「${raw}」，用 id：${named.map(b => b.id).join('、')}` };
    return named[0] ? { book: named[0] } : { error: `這組沒有「${raw}」這條` };
};

const POSITION_BY_LABEL: Record<string, WorldbookPosition> = Object.fromEntries(
    Object.entries(WORLDBOOK_POSITION_LABELS).map(([k, v]) => [v, Number(k) as WorldbookPosition]),
);

const parsePosition = (v: unknown): WorldbookPosition | { error: string } | undefined => {
    if (v === undefined) return undefined;
    const n = typeof v === 'number' ? v : POSITION_BY_LABEL[String(v).trim()] ?? Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 6) return { error: `position 要是 0～6 或這些名字：${Object.values(WORLDBOOK_POSITION_LABELS).slice(0, 7).join('、')}` };
    return n as WorldbookPosition;
};

const parseKeys = (v: unknown): string[] | undefined => {
    if (v === undefined) return undefined;
    if (Array.isArray(v)) return v.map(String).map(s => s.trim()).filter(Boolean);
    return splitWorldbookKeywords(String(v));
};

/** 從 op 讀觸發／位置那些欄位（加、改共用）；回傳要寫的欄位 */
const entryConfigFrom = (op: Record<string, unknown>, base: Partial<Worldbook>): { patch: Partial<Worldbook> } | { error: string } => {
    const patch: Partial<Worldbook> = {};
    const keys = parseKeys(op.keys);
    const secondary = parseKeys(op.secondaryKeys);
    if (keys !== undefined) patch.key = keys;
    if (secondary !== undefined) { patch.keysecondary = secondary; patch.selective = secondary.length > 0; }
    if (typeof op.constant === 'boolean') patch.constant = op.constant;
    const position = parsePosition(op.position);
    if (position && typeof position === 'object') return position;
    if (position !== undefined) patch.position = position;
    for (const k of ['depth', 'order'] as const) {
        if (op[k] === undefined) continue;
        const n = Number(op[k]);
        if (!Number.isFinite(n)) return { error: `${k} 要是數字` };
        patch[k] = Math.max(0, Math.floor(n));
    }
    if (op.role !== undefined) {
        const role = ({ system: 0, user: 1, assistant: 2 } as Record<string, number>)[String(op.role)] ?? Number(op.role);
        if (![0, 1, 2].includes(role)) return { error: 'role 要是 system、user、assistant' };
        patch.role = role as WorldbookDepthRole;
    }
    const merged = { ...base, ...patch };
    if (merged.constant === false && !(merged.key || []).length) return { error: '關鍵詞觸發至少要一個主要關鍵詞（不然就設 constant: true 常駐）' };
    return { patch };
};

const newEntryId = () => `wb-sore-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const resolveChars = (refs: unknown, data: WorldbookData): { ids: string[] } | { error: string } => {
    const list = Array.isArray(refs) ? refs : refs === undefined ? [] : [refs];
    const pool = visibleChars(data);
    const ids: string[] = [];
    for (const r of list) {
        const raw = String(r).trim();
        const hit = findPersonByRef(raw, pool);
        if (!hit) return { error: `找不到角色「${raw}」（同名的話用 id）` };
        ids.push(hit.id);
    }
    if (!ids.length) return { error: 'chars 要給角色名字' };
    return { ids };
};

export type WorldbookDraft = Omit<AssistantWorldbookProposal, 'id' | 'status'>;

/**
 * 一組的一串操作 → 提案。group 不存在就是開新組（只能 add）。
 * ops：add、edit、disable、enable、rename、global、mount、unmount。
 */
export const buildWorldbookProposal = (groupRef: unknown, ops: unknown[], data: WorldbookData, summary?: unknown): { draft: WorldbookDraft } | { errors: string[] } => {
    const group = typeof groupRef === 'string' ? groupRef.trim() : '';
    if (!group) return { errors: ['要指定是哪一組（group 填組名；新組就填新名字）'] };
    const existing = data.worldbooks.filter(b => groupOf(b) === group);
    const isGlobal = globalCategories(data.worldbooks).has(group);
    const errors: string[] = [];
    const changes: WorldbookDraft['changes'] = [];
    const adds: Worldbook[] = [];
    const patches = new Map<string, Partial<Worldbook>>();
    const mountAdd = new Map<string, Set<string>>();
    const mountRemove = new Map<string, Set<string>>();
    let category = group;
    let globalTo: boolean | undefined;
    const now = Date.now();
    // 找條目：既有的（套上這一串前面的改動）＋這一串前面新加的
    const current = () => [
        ...existing.map(b => ({ ...b, ...(patches.get(b.id) || {}) })),
        ...adds,
    ];
    const patch = (id: string, p: Partial<Worldbook>) => {
        const add = adds.find(b => b.id === id);
        if (add) Object.assign(add, p);
        else patches.set(id, { ...(patches.get(id) || {}), ...p });
    };

    ops.forEach((raw, i) => {
        const op = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        const fail = (msg: string) => errors.push(`第 ${i + 1} 個操作（${String(op.op ?? '?')}）：${msg}`);
        switch (op.op) {
            case 'add': {
                const title = typeof op.title === 'string' ? op.title.trim() : '';
                const content = typeof op.content === 'string' ? op.content : '';
                if (!title) return fail('新條目要有 title');
                if (!content.trim()) return fail('新條目要有 content');
                const base: Partial<Worldbook> = { constant: parseKeys(op.keys)?.length ? false : true };
                const cfg = entryConfigFrom(op, base);
                if ('error' in cfg) return fail(cfg.error);
                const book: Worldbook = {
                    id: newEntryId(), title, content, category,
                    disable: op.disable === true,
                    constant: true, key: [], keysecondary: [], selective: false, selectiveLogic: 0,
                    position: 1, depth: 4, role: 0, order: 100, scanDepth: 4,
                    useProbability: false, probability: 100, caseSensitive: false, matchWholeWords: false,
                    ...base, ...cfg.patch,
                    ...(isGlobal ? { global: true } : {}),
                    createdAt: now, updatedAt: now,
                };
                adds.push(book);
                changes.push({ label: `新增「${title}」（${triggerText(book)}，${positionText(book)}，${content.trim().length} 字）`, after: content });
                return;
            }
            case 'edit': {
                const hit = findEntry(current(), op.entry);
                if ('error' in hit) return fail(hit.error);
                const b = hit.book;
                const p: Partial<Worldbook> = {};
                if (typeof op.title === 'string' && op.title.trim() && op.title.trim() !== b.title) { p.title = op.title.trim(); changes.push({ label: `「${b.title}」改名成「${p.title}」` }); }
                if (typeof op.content === 'string' && op.content !== b.content) { p.content = op.content; changes.push({ label: `改了「${b.title}」的內容（${b.content.trim().length} → ${op.content.trim().length} 字）`, before: b.content, after: op.content }); }
                const cfg = entryConfigFrom(op, b);
                if ('error' in cfg) return fail(cfg.error);
                const trigger = { ...b, ...cfg.patch };
                if (triggerText(trigger) !== triggerText(b)) changes.push({ label: `「${b.title}」觸發：${triggerText(b)} → ${triggerText(trigger)}` });
                if (positionText(trigger) !== positionText(b)) changes.push({ label: `「${b.title}」位置：${positionText(b)} → ${positionText(trigger)}` });
                if (cfg.patch.order !== undefined && cfg.patch.order !== (b.order ?? 100)) changes.push({ label: `「${b.title}」順序：${b.order ?? 100} → ${cfg.patch.order}` });
                if (op.disable !== undefined) {
                    const off = op.disable === true;
                    if (off !== !!b.disable) { p.disable = off; changes.push({ label: `${off ? '停用' : '啟用'}「${b.title}」` }); }
                }
                const all = { ...p, ...cfg.patch };
                if (!Object.keys(all).length) return;
                patch(b.id, { ...all, updatedAt: now });
                return;
            }
            case 'disable':
            case 'enable': {
                const hit = findEntry(current(), op.entry);
                if ('error' in hit) return fail(hit.error);
                const off = op.op === 'disable';
                if (off === !!hit.book.disable) return;
                patch(hit.book.id, { disable: off, updatedAt: now });
                changes.push({ label: `${off ? '停用' : '啟用'}「${hit.book.title}」` });
                return;
            }
            case 'rename': {
                const name = typeof op.name === 'string' ? op.name.trim() : '';
                if (!name) return fail('要有 name');
                if (!existing.length) return fail('新組不用改名，直接用新名字當 group');
                if (name !== group && data.worldbooks.some(b => groupOf(b) === name)) return fail(`已經有「${name}」這組了，不能併組`);
                category = name;
                changes.push({ label: `整組改名：「${group}」→「${name}」` });
                return;
            }
            case 'global': {
                if (typeof op.on !== 'boolean') return fail('要給 on: true 或 false');
                if (op.on === isGlobal) return;
                globalTo = op.on;
                changes.push({ label: op.on ? '整組全局啟用（所有角色都讀得到，不用掛）' : '整組取消全局啟用' });
                return;
            }
            case 'mount':
            case 'unmount': {
                const chars = resolveChars(op.chars, data);
                if ('error' in chars) return fail(chars.error);
                const pool = current();
                let entryIds = pool.map(b => b.id);
                if (op.entries !== undefined) {
                    const refs = Array.isArray(op.entries) ? op.entries : [op.entries];
                    entryIds = [];
                    for (const r of refs) {
                        const hit = findEntry(pool, r);
                        if ('error' in hit) return fail(hit.error);
                        entryIds.push(hit.book.id);
                    }
                }
                if (!entryIds.length) return fail('這組沒有條目可以掛');
                const target = op.op === 'mount' ? mountAdd : mountRemove;
                chars.ids.forEach(id => {
                    const set = target.get(id) || new Set<string>();
                    entryIds.forEach(e => set.add(e));
                    target.set(id, set);
                    const name = data.characters.find(c => c.id === id)?.name;
                    changes.push({ label: `${op.op === 'mount' ? '掛給' : '從'}${name}${op.op === 'mount' ? '' : '身上拿掉'}（${entryIds.length === pool.length ? '整組' : `${entryIds.length} 條`}）` });
                });
                return;
            }
            case 'delete':
            case 'remove':
                return fail('Sore 不能刪世界書條目；要停用用 disable，要刪請用戶自己去世界書 App');
            default:
                return fail('不認得這個 op。能用：add、edit、disable、enable、rename、global、mount、unmount');
        }
    });

    if (!existing.length && !adds.length && !errors.length) errors.push(`沒有「${group}」這組；新組要先 add 條目`);
    if (errors.length) return { errors };

    // 整組改名、全局開關：套到每條（新加的直接寫在條目上）
    if (category !== group || globalTo !== undefined) {
        const groupPatch: Partial<Worldbook> = { ...(category !== group ? { category } : {}), ...(globalTo !== undefined ? { global: globalTo || undefined } : {}) };
        existing.forEach(b => patch(b.id, { ...groupPatch, updatedAt: now }));
        adds.forEach(b => Object.assign(b, groupPatch));
    }

    const mounts = [...new Set([...mountAdd.keys(), ...mountRemove.keys()])].map(charId => ({
        charId,
        add: [...(mountAdd.get(charId) || [])],
        remove: [...(mountRemove.get(charId) || [])],
    }));
    if (!changes.length) return { errors: ['沒有任何改動'] };
    return {
        draft: {
            kind: 'worldbook',
            category,
            adds,
            updates: [...patches.entries()].map(([id, p]) => ({ id, patch: p })),
            mounts,
            changes,
            targetLabel: `世界書 · ${category}${existing.length ? '' : '（新的一組）'}`,
            summary: typeof summary === 'string' ? summary.trim().slice(0, 200) || undefined : undefined,
        },
    };
};

/** 套用時角色要變成的掛載：拿掉要拿掉的、加上要加的（條目用改完的樣子），已經掛著的就換成新版 */
export const nextMounted = (current: MountedWorldbook[], mount: { add: string[]; remove: string[] }, finalBooks: Map<string, Worldbook>): MountedWorldbook[] => {
    const remove = new Set(mount.remove);
    // 已經掛著、這次也改到的條目換成新版（不然會蓋掉 mutateWorldbooks 剛同步好的那份）
    const kept = current.filter(m => !remove.has(m.id)).map(m => (finalBooks.has(m.id) ? toMountedWorldbook(finalBooks.get(m.id)!) : m));
    const have = new Set(kept.map(m => m.id));
    const added = mount.add.filter(id => !have.has(id) && finalBooks.has(id)).map(id => toMountedWorldbook(finalBooks.get(id)!));
    return [...kept, ...added];
};
