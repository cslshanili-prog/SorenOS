import type {
    MountedWorldbook,
    Worldbook,
    WorldbookDepthRole,
    WorldbookPosition,
    WorldbookSelectiveLogic,
} from '../types';

export type WorldbookLike = Worldbook | MountedWorldbook;

export interface WorldbookScanMessage {
    role?: string;
    content: unknown;
}

export interface ResolvedWorldbookEntry {
    book: WorldbookLike;
    content: string;
    position: WorldbookPosition;
    order: number;
}

export interface WorldbookSystemSections {
    beforeCharacter: ResolvedWorldbookEntry[];
    afterCharacter: ResolvedWorldbookEntry[];
    authorsNoteTop: ResolvedWorldbookEntry[];
    authorsNoteBottom: ResolvedWorldbookEntry[];
    atDepth: ResolvedWorldbookEntry[];
    beforeExamples: ResolvedWorldbookEntry[];
    afterExamples: ResolvedWorldbookEntry[];
}

export const WORLDBOOK_POSITION_LABELS: Record<WorldbookPosition, string> = {
    0: '角色設定前',
    1: '角色設定後',
    2: '作者註釋頂部',
    3: '作者註釋底部',
    4: '聊天記錄指定深度',
    5: '示例消息前',
    6: '示例消息後',
    7: 'Outlet（不自動注入）',
};

export const WORLDBOOK_POSITION_DESCRIPTIONS: Record<WorldbookPosition, string> = {
    0: '適合放全局規則、基礎背景；會出現在角色身份與性格設定之前。',
    1: '適合一般世界觀、人物與地點設定；這是舊版世界書一直使用的默認位置。',
    2: '適合放寫作方向、語氣或節奏要求；位於作者註釋內容頂部。',
    3: '適合放作者註釋後的補充與強調；比頂部內容更靠後。',
    4: '適合臨時狀態、近期事件或強提醒；按深度和角色插入聊天記錄。',
    5: '適合放閱讀示例對話前需要先知道的說明。',
    6: '適合放示例對話結束後的補充說明。',
    7: '從 SillyTavern 導入的 outlet 條目：在 ST 裡要用 {{outlet::名稱}} 手動引用，Soren 沒有這個寫法，所以不會進提示詞，保留只是為了導出時不丟。',
};

export const WORLDBOOK_ROLE_LABELS: Record<WorldbookDepthRole, string> = {
    0: 'System',
    1: 'User',
    2: 'Assistant',
};

const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

const asStringArray = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return value.map(item => String(item).trim()).filter(Boolean);
};

/**
 * 按逗號、換行拆關鍵詞；`/a{1,3}/` 這種裡面帶逗號的正則關鍵詞整條保留，
 * 不然 ST 導入的條目在編輯器裡打開再保存，正則就被拆壞了。
 */
export const splitWorldbookKeywords = (value: string): string[] => {
    const pieces = value.split(/([,，\n])/);
    const keywords: string[] = [];
    for (let i = 0; i < pieces.length; i += 2) {
        let keyword = pieces[i];
        if (keyword.trim().startsWith('/') && !parseWorldbookKeyRegex(keyword.trim())) {
            for (let j = i + 2; j < pieces.length; j += 2) {
                const joined = pieces.slice(i, j + 1).join('');
                if (parseWorldbookKeyRegex(joined.trim())) {
                    keyword = joined;
                    i = j;
                    break;
                }
            }
        }
        keywords.push(keyword.trim());
    }
    return keywords.filter(Boolean);
};

export const toMountedWorldbook = (book: Worldbook): MountedWorldbook => ({
    id: book.id,
    title: book.title,
    content: book.content,
    category: book.category,
    key: book.key ? [...book.key] : undefined,
    keysecondary: book.keysecondary ? [...book.keysecondary] : undefined,
    constant: book.constant,
    selective: book.selective,
    selectiveLogic: book.selectiveLogic,
    order: book.order,
    position: book.position,
    disable: book.disable,
    probability: book.probability,
    useProbability: book.useProbability,
    depth: book.depth,
    role: book.role,
    scanDepth: book.scanDepth,
    caseSensitive: book.caseSensitive,
    matchWholeWords: book.matchWholeWords,
    sourceUid: book.sourceUid,
});

/**
 * Install a complete worldbook group into one character cache. Existing entries
 * with the same ids are replaced, so retrying an install cannot create duplicates.
 */
export const upsertMountedWorldbooks = (
    current: MountedWorldbook[] = [],
    books: Worldbook[] = [],
): MountedWorldbook[] => {
    const incomingIds = new Set(books.map(book => book.id));
    return [
        ...current.filter(book => !incomingIds.has(book.id)),
        ...books.map(toMountedWorldbook),
    ];
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 關鍵詞寫成 `/pattern/flags` 就按正則匹配，規則照 SillyTavern 的 parseRegexFromString：
 * 中間有沒轉義的 `/` 或語法錯就當普通文字。g / y 會讓 test() 帶狀態，去掉。
 */
export const parseWorldbookKeyRegex = (keyword: string): RegExp | null => {
    const match = keyword.match(/^\/([\w\W]+?)\/([gimsuy]*)$/);
    if (!match) return null;
    const [, pattern, flags] = match;
    if (/(^|[^\\])\//.test(pattern)) return null;
    try {
        return new RegExp(pattern.replace(/\\\//g, '/'), flags.replace(/[gy]/g, ''));
    } catch {
        return null;
    }
};

const keywordMatches = (
    text: string,
    keyword: string,
    caseSensitive: boolean,
    wholeWords: boolean,
): boolean => {
    if (!keyword) return false;
    // 正則關鍵詞自帶大小寫 flag，不受下面兩個開關影響（同 ST）
    const regex = parseWorldbookKeyRegex(keyword);
    if (regex) return regex.test(text);

    const haystack = caseSensitive ? text : text.toLocaleLowerCase();
    const needle = caseSensitive ? keyword : keyword.toLocaleLowerCase();
    // 多個詞的關鍵詞直接找整串；單詞才看邊界
    if (!wholeWords || /\s/.test(needle)) return haystack.includes(needle);
    // 邊界跟 ST 一樣用 \W：只有英文字母、數字、底線算「詞內」，中日文前後緊貼的字都算邊界，
    // 所以中文關鍵詞開了完整詞匹配照樣能中。
    return new RegExp(`(?:^|\\W)${escapeRegExp(needle)}(?:$|\\W)`).test(haystack);
};

const messageText = (message: WorldbookScanMessage): string => {
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
        return message.content
            .map(part => (typeof part === 'string' ? part : (part as any)?.text || ''))
            .filter(Boolean)
            .join('\n');
    }
    return '';
};

const scanTextForBook = (book: WorldbookLike, messages: WorldbookScanMessage[]): string => {
    const depth = Math.max(0, Math.floor(book.scanDepth ?? 4));
    if (depth === 0) return '';
    return messages.slice(-depth).map(messageText).filter(Boolean).join('\n');
};

const secondaryConditionPasses = (
    book: WorldbookLike,
    text: string,
    caseSensitive: boolean,
    wholeWords: boolean,
): boolean => {
    if (!book.selective) return true;
    const secondary = book.keysecondary || [];
    if (secondary.length === 0) return true;
    const matches = secondary.map(key => keywordMatches(text, key, caseSensitive, wholeWords));
    const logic: WorldbookSelectiveLogic = book.selectiveLogic ?? 0;
    if (logic === 1) return !matches.every(Boolean);
    if (logic === 2) return !matches.some(Boolean);
    if (logic === 3) return matches.every(Boolean);
    return matches.some(Boolean);
};

export const isWorldbookEntryActive = (
    book: WorldbookLike,
    messages: WorldbookScanMessage[] = [],
): boolean => {
    if (book.disable) return false;

    const primary = book.key || [];
    const isConstant = book.constant ?? primary.length === 0;
    const text = scanTextForBook(book, messages);
    const caseSensitive = book.caseSensitive === true;
    const wholeWords = book.matchWholeWords === true;

    if (!isConstant) {
        if (primary.length === 0) return false;
        if (!primary.some(key => keywordMatches(text, key, caseSensitive, wholeWords))) return false;
        if (!secondaryConditionPasses(book, text, caseSensitive, wholeWords)) return false;
    }

    if (book.useProbability) {
        const probability = clamp(book.probability, 0, 100, 100);
        if (probability <= 0) return false;
        if (probability < 100 && Math.random() * 100 >= probability) return false;
    }

    return true;
};

export const expandWorldbookMacros = (content: string, charName: string, userName: string): string => {
    let expanded = content;
    if (charName) expanded = expanded.replace(/{{\s*char\s*}}/gi, charName);
    if (userName) expanded = expanded.replace(/{{\s*user\s*}}/gi, userName);
    return expanded;
};

export const resolveWorldbookEntries = (
    books: WorldbookLike[] = [],
    messages: WorldbookScanMessage[] = [],
    charName = '',
    userName = '',
): ResolvedWorldbookEntry[] => books
    .filter(book => isWorldbookEntryActive(book, messages))
    .map(book => ({
        book,
        content: expandWorldbookMacros(book.content || '', charName, userName),
        position: book.position ?? 1,
        order: Number.isFinite(book.order) ? Number(book.order) : 100,
    }))
    // outlet（7）只在 ST 裡被巨集引用，不自動注入
    .filter(entry => entry.position !== 7 && entry.content.trim())
    .sort((a, b) => a.order - b.order);

/**
 * 只取「聊天記錄指定深度」的條目，交給 injectWorldbookDepthEntries 插進對話。
 * buildCoreContext 不渲染這類條目，有多輪對話的入口（私聊 / 見面 / 通話）要自己插。
 */
export const resolveWorldbookDepthEntries = (
    books: WorldbookLike[] = [],
    messages: WorldbookScanMessage[] = [],
    charName = '',
    userName = '',
): ResolvedWorldbookEntry[] => resolveWorldbookEntries(books, messages, charName, userName)
    .filter(entry => entry.position === 4);

export const splitWorldbookSections = (entries: ResolvedWorldbookEntry[]): WorldbookSystemSections => ({
    beforeCharacter: entries.filter(entry => entry.position === 0),
    afterCharacter: entries.filter(entry => entry.position === 1),
    authorsNoteTop: entries.filter(entry => entry.position === 2),
    authorsNoteBottom: entries.filter(entry => entry.position === 3),
    atDepth: entries.filter(entry => entry.position === 4),
    beforeExamples: entries.filter(entry => entry.position === 5),
    afterExamples: entries.filter(entry => entry.position === 6),
});

export const formatWorldbookSection = (
    entries: ResolvedWorldbookEntry[],
    heading: string,
): string => {
    if (entries.length === 0) return '';
    let output = `### ${heading}\n`;
    let lastLegacyCategory = '';
    for (const entry of entries) {
        // SillyTavern comments are editor-only and are not part of the prompt.
        if (entry.book.sourceUid === undefined) {
            const category = entry.book.category || '通用設定 (General)';
            if (category !== lastLegacyCategory) {
                output += `#### [${category}]\n`;
                lastLegacyCategory = category;
            }
            output += `**Title: ${entry.book.title}**\n`;
        }
        output += `${entry.content.trim()}\n---\n`;
    }
    return `${output}\n`;
};

export const injectWorldbookDepthEntries = <T extends WorldbookScanMessage>(
    messages: T[],
    entries: ResolvedWorldbookEntry[],
): Array<T | { role: string; content: string }> => {
    if (entries.length === 0) return [...messages];
    const buckets = new Map<number, ResolvedWorldbookEntry[]>();
    for (const entry of entries) {
        const depth = Math.max(0, Math.floor(entry.book.depth ?? 4));
        const index = Math.max(0, messages.length - depth);
        const bucket = buckets.get(index) || [];
        bucket.push(entry);
        buckets.set(index, bucket);
    }

    const result: Array<T | { role: string; content: string }> = [];
    for (let index = 0; index <= messages.length; index += 1) {
        const bucket = buckets.get(index) || [];
        for (const entry of bucket) {
            const roleValue = entry.book.role ?? 0;
            const role = roleValue === 1 ? 'user' : roleValue === 2 ? 'assistant' : 'system';
            result.push({ role, content: entry.content.trim() });
        }
        if (index < messages.length) result.push(messages[index]);
    }
    return result;
};

export const serializeStandardWorldbook = (books: WorldbookLike[]): string => {
    const usedUids = new Set<number>();
    const entries: Record<string, Record<string, unknown>> = {};

    books.forEach((book, index) => {
        let uid = Number.isFinite(book.sourceUid) ? Number(book.sourceUid) : index;
        while (usedUids.has(uid)) uid += 1;
        usedUids.add(uid);

        const primary = book.key || [];
        const secondary = book.keysecondary || [];
        const position = book.position ?? 1;
        // ST 用 entries[uid] 找條目，鍵必須等於 uid，不然在 ST 裡改不了、刪不掉
        entries[String(uid)] = {
            ...(book.stExtra || {}),
            uid,
            key: [...primary],
            keysecondary: [...secondary],
            comment: book.title,
            content: book.content,
            constant: book.constant ?? primary.length === 0,
            selective: book.selective ?? secondary.length > 0,
            selectiveLogic: book.selectiveLogic ?? 0,
            order: book.order ?? 100,
            position,
            disable: book.disable === true,
            probability: book.probability ?? 100,
            useProbability: book.useProbability === true,
            depth: book.depth ?? 4,
            role: position === 4 ? (book.role ?? 0) : null,
            scanDepth: book.scanDepth ?? null,
            caseSensitive: book.caseSensitive ?? null,
            matchWholeWords: book.matchWholeWords ?? null,
            displayIndex: index,
        };
    });

    return JSON.stringify({ entries }, null, 2);
};

/**
 * SillyTavern 條目裡 Soren 還不處理的欄位（名字照 ST 的 newWorldInfoEntryDefinition）。
 * 只收這張表裡的，免得把別處（比如協同生成）帶進來的雜欄位寫進導出文件。
 */
const ST_PASSTHROUGH_FIELDS = [
    'vectorized', 'addMemo', 'ignoreBudget', 'excludeRecursion', 'preventRecursion',
    'matchPersonaDescription', 'matchCharacterDescription', 'matchCharacterPersonality',
    'matchCharacterDepthPrompt', 'matchScenario', 'matchCreatorNotes', 'delayUntilRecursion',
    'outletName', 'group', 'groupOverride', 'groupWeight', 'useGroupScoring', 'automationId',
    'sticky', 'cooldown', 'delay', 'characterFilter', 'triggers', 'extensions',
] as const;

const displayIndexOf = (value: any, fallback: number): number => {
    const index = value?.displayIndex;
    return typeof index === 'number' && Number.isFinite(index) ? index : fallback;
};

const pickStExtra = (value: Record<string, unknown>): Record<string, unknown> | undefined => {
    const extra: Record<string, unknown> = {};
    for (const field of ST_PASSTHROUGH_FIELDS) {
        if (value[field] !== undefined) extra[field] = value[field];
    }
    return Object.keys(extra).length > 0 ? extra : undefined;
};

export const parseStandardWorldbook = (
    rawText: string,
    category: string,
    now = Date.now(),
): Worldbook[] => {
    const parsed = JSON.parse(rawText);
    if (!parsed || typeof parsed !== 'object' || !parsed.entries || typeof parsed.entries !== 'object') {
        throw new Error('不是受支持的標準世界書文件：缺少 entries');
    }
    // 鍵是 uid（ST 和新版導出都這樣），對象按數字鍵排序；有 displayIndex 就照它還原列表順序
    const rawEntries = (Array.isArray(parsed.entries)
        ? parsed.entries
        : Object.values(parsed.entries)
    ).map((value: any, index: number) => ({ value, index }))
        .sort((a: any, b: any) => displayIndexOf(a.value, a.index) - displayIndexOf(b.value, b.index))
        .map((item: any) => item.value);

    const books = rawEntries.flatMap((value: any, index: number): Worldbook[] => {
        if (!value || typeof value !== 'object' || typeof value.content !== 'string') return [];
        const uid = Number.isFinite(Number(value.uid)) ? Number(value.uid) : index;
        const position = clamp(value.position, 0, 7, 1) as WorldbookPosition;
        const stExtra = pickStExtra(value);
        const rawRole = value.role == null ? null : clamp(value.role, 0, 2, 0) as WorldbookDepthRole;
        return [{
            id: `wb-${now}-${index}-${Math.random().toString(36).slice(2, 8)}`,
            title: String(value.comment || value.name || `條目 ${uid + 1}`),
            content: value.content,
            category,
            createdAt: now,
            updatedAt: now,
            key: asStringArray(value.key),
            keysecondary: asStringArray(value.keysecondary),
            constant: value.constant === true,
            selective: value.selective === true,
            selectiveLogic: clamp(value.selectiveLogic, 0, 3, 0) as WorldbookSelectiveLogic,
            order: Number.isFinite(Number(value.order)) ? Number(value.order) : 100,
            position,
            disable: value.disable === true,
            probability: clamp(value.probability, 0, 100, 100),
            useProbability: value.useProbability === true,
            depth: Math.max(0, Math.floor(clamp(value.depth, 0, 999, 4))),
            role: rawRole,
            scanDepth: value.scanDepth == null ? null : Math.max(0, Math.floor(clamp(value.scanDepth, 0, 999, 4))),
            caseSensitive: value.caseSensitive == null ? null : value.caseSensitive === true,
            matchWholeWords: value.matchWholeWords == null ? null : value.matchWholeWords === true,
            sourceUid: uid,
            ...(stExtra ? { stExtra } : {}),
        }];
    });

    if (books.length === 0) throw new Error('世界書裡沒有可導入的有效條目');
    return books;
};
