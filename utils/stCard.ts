/**
 * SillyTavern 角色卡匯入（plans/chat-import-export.md 第 5 節）。純邏輯，不碰資料庫。
 *
 * - PNG：讀圖片裡的 tEXt／iTXt 區塊，`ccv3`（V3）優先，沒有再讀 `chara`（V2／V1），內容是 base64 的 JSON。
 * - JSON：直接讀；認 `spec: chara_card_v2／v3`，也認沒有 spec、欄位在最外層的 V1。
 * - cardToSoren：卡片 → 角色欄位＋世界書條目（卡內世界書走現成的 parseStandardWorldbook）。
 */
import type { CharacterProfile, Worldbook } from '../types';
import { parseStandardWorldbook } from './worldbook';

export interface StCardBook {
    name?: string;
    entries: any[];
}

/** 正規化之後的卡片（V1／V2／V3 都變成這個樣子） */
export interface StCard {
    spec: 'v1' | 'v2' | 'v3';
    name: string;
    description: string;
    personality: string;
    scenario: string;
    firstMes: string;
    alternateGreetings: string[];
    mesExample: string;
    systemPrompt: string;
    postHistoryInstructions: string;
    creatorNotes: string;
    creator: string;
    tags: string[];
    characterBook?: StCardBook;
    depthPrompt?: { prompt: string; depth: number; role: 'system' | 'user' | 'assistant' };
}

// ─── PNG ───

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

export const isPngBytes = (bytes: Uint8Array) => bytes.length > 8 && PNG_SIG.every((b, i) => bytes[i] === b);

const latin1 = (bytes: Uint8Array) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return s; };
const utf8 = (bytes: Uint8Array) => new TextDecoder('utf-8').decode(bytes);

/** PNG 裡的文字區塊：keyword → text（tEXt 是 latin1；iTXt 沒壓縮的才讀） */
export function readPngTextChunks(bytes: Uint8Array): Record<string, string> {
    if (!isPngBytes(bytes)) throw new Error('不是 PNG 圖片');
    const out: Record<string, string> = {};
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 8;
    while (pos + 12 <= bytes.length) {
        const len = view.getUint32(pos);
        const type = latin1(bytes.subarray(pos + 4, pos + 8));
        const start = pos + 8;
        const end = start + len;
        if (end + 4 > bytes.length) break;
        const data = bytes.subarray(start, end);
        if (type === 'tEXt') {
            const zero = data.indexOf(0);
            if (zero > 0) out[latin1(data.subarray(0, zero)).toLowerCase()] = latin1(data.subarray(zero + 1));
        } else if (type === 'iTXt') {
            // keyword \0 compressionFlag compressionMethod languageTag \0 translatedKeyword \0 text
            const zero = data.indexOf(0);
            if (zero > 0 && data[zero + 1] === 0) {
                const lang = data.indexOf(0, zero + 3);
                const trans = lang >= 0 ? data.indexOf(0, lang + 1) : -1;
                if (trans >= 0) out[latin1(data.subarray(0, zero)).toLowerCase()] = utf8(data.subarray(trans + 1));
            }
        }
        if (type === 'IEND') break;
        pos = end + 4;
    }
    return out;
}

const decodeBase64Utf8 = (b64: string): string => {
    const clean = b64.trim().replace(/\s+/g, '');
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return utf8(bytes);
};

/** 從 PNG 取出卡片 JSON（還沒正規化） */
export function extractCardJsonFromPng(bytes: Uint8Array): any {
    const chunks = readPngTextChunks(bytes);
    const raw = chunks.ccv3 ?? chunks.chara;
    if (!raw) throw new Error('這張圖裡沒有角色卡資料（不是 SillyTavern 角色卡，或存圖時被壓掉了）');
    const text = raw.trim().startsWith('{') ? raw : decodeBase64Utf8(raw);
    try { return JSON.parse(text); } catch { throw new Error('角色卡資料壞掉了，讀不出來'); }
}

// ─── 正規化 ───

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const strList = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(s => s.trim()) : []);

export function normalizeStCard(json: any): StCard {
    if (!json || typeof json !== 'object') throw new Error('不是角色卡');
    const spec = json.spec === 'chara_card_v3' ? 'v3' : json.spec === 'chara_card_v2' ? 'v2' : 'v1';
    const d = spec === 'v1' ? json : (json.data && typeof json.data === 'object' ? json.data : json);
    const name = str(d.name || json.name).trim();
    if (!name) throw new Error('角色卡沒有名字');
    const ext = d.extensions && typeof d.extensions === 'object' ? d.extensions : {};
    const dp = ext.depth_prompt;
    const book = d.character_book;
    return {
        spec,
        name,
        description: str(d.description),
        personality: str(d.personality),
        scenario: str(d.scenario),
        firstMes: str(d.first_mes),
        alternateGreetings: strList(d.alternate_greetings),
        mesExample: str(d.mes_example),
        systemPrompt: str(d.system_prompt),
        postHistoryInstructions: str(d.post_history_instructions),
        creatorNotes: str(d.creator_notes || d.creatorcomment || json.creatorcomment),
        creator: str(d.creator),
        tags: strList(d.tags),
        ...(book && Array.isArray(book.entries) && book.entries.length ? { characterBook: { name: str(book.name) || undefined, entries: book.entries } } : {}),
        ...(dp && str(dp.prompt).trim() ? { depthPrompt: { prompt: str(dp.prompt), depth: Number.isFinite(Number(dp.depth)) ? Number(dp.depth) : 4, role: dp.role === 'user' || dp.role === 'assistant' ? dp.role : 'system' } } : {}),
    };
}

/** 檔案 → 卡片：PNG 或 JSON 都行 */
export function parseStCardFile(bytes: Uint8Array): StCard {
    if (isPngBytes(bytes)) return normalizeStCard(extractCardJsonFromPng(bytes));
    let json: any;
    try { json = JSON.parse(utf8(bytes)); } catch { throw new Error('不是 PNG 角色卡，也不是 JSON 角色卡'); }
    return normalizeStCard(json);
}

// ─── 轉成 Soren ───

const ST_POSITION: Record<string, number> = { before_char: 0, after_char: 1 };
const ROLE_NUM: Record<string, number> = { system: 0, user: 1, assistant: 2 };

/** 卡內世界書的條目（V2 的 character_book 格式）→ ST 世界書檔的條目格式，交給 parseStandardWorldbook */
export function characterBookToWorldInfo(entries: any[]): { entries: Record<string, any> } {
    const out: Record<string, any> = {};
    entries.forEach((e, index) => {
        if (!e || typeof e !== 'object') return;
        const ext = e.extensions && typeof e.extensions === 'object' ? e.extensions : {};
        const uid = Number.isFinite(Number(e.id)) ? Number(e.id) : index;
        out[uid] = {
            ...ext,
            uid,
            key: strList(e.keys ?? e.key),
            keysecondary: strList(e.secondary_keys ?? e.keysecondary),
            content: str(e.content),
            comment: str(e.comment || e.name),
            constant: e.constant === true,
            selective: e.selective === true,
            order: Number.isFinite(Number(e.insertion_order)) ? Number(e.insertion_order) : (Number.isFinite(Number(ext.order)) ? Number(ext.order) : 100),
            position: Number.isFinite(Number(ext.position)) ? Number(ext.position) : (ST_POSITION[str(e.position)] ?? 1),
            disable: e.enabled === false || ext.disable === true,
            ...(typeof e.case_sensitive === 'boolean' ? { caseSensitive: e.case_sensitive } : {}),
            displayIndex: Number.isFinite(Number(ext.display_index)) ? Number(ext.display_index) : index,
        };
    });
    return { entries: out };
}

export interface SorenFromCard {
    /** 新角色要填的欄位（id、頭像由呼叫端給） */
    fields: Pick<CharacterProfile, 'name' | 'description' | 'systemPrompt'> & Partial<Pick<CharacterProfile, 'dialogueExamples' | 'dateGreetings' | 'dateScenario'>>;
    /** 卡內世界書＋深度提示，分類是角色名 */
    worldbooks: Worldbook[];
}

const join = (...parts: string[]) => parts.map(p => p.trim()).filter(Boolean).join('\n\n');

export function cardToSoren(card: StCard, now = Date.now()): SorenFromCard {
    const extra = join(
        card.systemPrompt.replace(/\{\{original\}\}/gi, '').trim() ? `【角色卡附帶的系統提示】\n${card.systemPrompt.replace(/\{\{original\}\}/gi, '').trim()}` : '',
        card.postHistoryInstructions.replace(/\{\{original\}\}/gi, '').trim() ? `【角色卡附帶的回覆要求】\n${card.postHistoryInstructions.replace(/\{\{original\}\}/gi, '').trim()}` : '',
    );
    const greetings = [card.firstMes, ...card.alternateGreetings].map(t => t.trim()).filter(Boolean);
    const category = card.characterBook?.name?.trim() || `${card.name}（角色卡）`;
    let worldbooks: Worldbook[] = [];
    if (card.characterBook) {
        try {
            worldbooks = parseStandardWorldbook(JSON.stringify(characterBookToWorldInfo(card.characterBook.entries)), category, now);
        } catch { worldbooks = []; }
    }
    if (card.depthPrompt) {
        worldbooks.push({
            id: `wb-${now}-depth-${Math.random().toString(36).slice(2, 8)}`,
            title: '角色卡的深度提示',
            content: card.depthPrompt.prompt,
            category,
            createdAt: now,
            updatedAt: now,
            constant: true,
            position: 4,
            depth: Math.max(0, Math.floor(card.depthPrompt.depth)),
            role: ROLE_NUM[card.depthPrompt.role] as any,
            order: 100,
        } as Worldbook);
    }
    return {
        fields: {
            name: card.name,
            description: card.tags.slice(0, 4).join(' · '),
            systemPrompt: join(card.description, card.personality, extra),
            ...(card.mesExample.trim() ? { dialogueExamples: card.mesExample.trim() } : {}),
            ...(card.scenario.trim() ? { dateScenario: card.scenario.trim() } : {}),
            ...(greetings.length ? { dateGreetings: greetings.map((text, i) => ({ id: `greet-${now}-${i}`, text })) } : {}),
        },
        worldbooks,
    };
}
