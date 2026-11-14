/**
 * 另一家手機風格 App 匯出的 JSON（plans/chat-import-export.md 第 3 節）→ Soren 訊息與記憶。純邏輯，不碰資料庫。
 *
 * 私聊：{ version, exportDate, character, user, messages, summaryHistory, episodeSummary, userFacts }
 * 群聊：{ version, kind, exportDate, group: { id, name, members }, user, messages（多了 senderCharId／senderName）, summaryHistory }
 *
 * 轉出來的訊息還沒有 charId／personaKey（放到哪是匯入頁決定的），每則帶 metadata.importedFrom 給重複匯入用。
 */
import type { MemoryFragment, Message, MessageType } from '../types';

export const PHONE_IMPORT_SOURCE = 'phone-json';

export interface PhoneImportBase {
    kind: 'private' | 'group';
    /** 哪來的檔：另一家（預設）或 Soren 自己匯出的 JSON */
    origin?: 'phone' | 'soren';
    exportDate?: string;
    userName?: string;
    messages: ImportedMessage[];
    memories: ImportedMemory[];
    /** 收不進來的：原因 → 幾則 */
    skipped: Record<string, number>;
    /** 各類各幾則（預覽用） */
    counts: Partial<Record<MessageType, number>>;
    range?: { from: number; to: number };
}

export interface PhonePrivateImport extends PhoneImportBase {
    kind: 'private';
    character: { name: string; role?: string; description?: string; sourceId?: string };
}

export interface PhoneGroupImport extends PhoneImportBase {
    kind: 'group';
    group: { name: string; sourceId?: string };
    /** 群裡發過話的人（照 senderName；sourceId 是原本的角色 id） */
    speakers: { name: string; sourceId?: string; count: number }[];
}

export type PhoneImport = PhonePrivateImport | PhoneGroupImport;

/** 還沒決定放到哪的一則訊息；群聊的 speaker 是發話人名字（匯入頁對到角色 id） */
export interface ImportedMessage {
    role: Message['role'];
    type: MessageType;
    content: string;
    timestamp: number;
    metadata: Record<string, any> & { importedFrom: { source: string; id: string } };
    speaker?: string;
    /** 原本那則的 id；引用回覆在寫進資料庫之後才換成 Soren 的 id */
    replyToSourceId?: string;
    replyToPreview?: { content: string; fromMe: boolean };
}

export interface ImportedMemory {
    /** 勾選用的 key */
    key: string;
    /** memory：Soren 自己匯出的角色記憶，原樣收回來 */
    kind: 'fact' | 'summary' | 'memory';
    /** fact 的分類（user／bond／self／people／event） */
    cat?: string;
    date: string;
    summary: string;
}

// ─── 認格式 ───

const isGroupKind = (json: any) => json?.kind === 'group' || json?.kind === 'group_chat' || (!json?.character && !!json?.group);

export function isPhoneExport(json: any): boolean {
    return !!json && typeof json === 'object' && Array.isArray(json.messages) && typeof json.exportDate === 'string'
        && (isGroupKind(json) ? !!json.group : !!json.character);
}

/** type: state 大多是場景旁白（雙方都有）；只有「你已新增了…」這種是系統通知 */
const isSystemNotice = (m: any) => String(m.id ?? '').startsWith('fg_') || /^(你已新增了|你已撤回|已新增|現在可以開始聊天)/.test(s(m.text).trim());

// ─── 共用小工具 ───

const toMs = (v: unknown): number | null => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim()) {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
        const t = Date.parse(v);
        if (Number.isFinite(t)) return t;
    }
    return null;
};
const dateKey = (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const s = (v: unknown) => (typeof v === 'string' ? v : '');
const bump = (rec: Record<string, number>, k: string) => { rec[k] = (rec[k] || 0) + 1; };

/** 那家自己的 HTML 標籤（例如 <polaroid>）剝掉剩的文字 */
const stripTags = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/** 一則原始訊息 → 一則 Soren 訊息（null＝不收，原因記進 skipped） */
function convertMessage(m: any, skipped: Record<string, number>, group: boolean): ImportedMessage | null {
    const ts = toMs(m.timestamp);
    if (ts === null) { bump(skipped, '沒有時間'); return null; }
    const id = String(m.id ?? `${ts}`);
    const importedFrom = { source: PHONE_IMPORT_SOURCE, id };
    const fromMe = m.sender === 'me';
    const systemNotice = m.sender === 'system' || m.type === 'recalled' || (m.type === 'state' && isSystemNotice(m));
    const role: Message['role'] = systemNotice ? 'system' : fromMe ? 'user' : 'assistant';
    const base = {
        role, timestamp: ts,
        ...(group && !fromMe && role !== 'system' && s(m.senderName) ? { speaker: s(m.senderName) } : {}),
        ...(m.replyTo && m.replyTo.id != null ? { replyToSourceId: String(m.replyTo.id), replyToPreview: { content: s(m.replyTo.text).slice(0, 200), fromMe: m.replyTo.sender === 'me' } } : {}),
    };
    const meta: ImportedMessage['metadata'] = { importedFrom };
    if (s(m.subtext).trim()) meta.thinkingChain = s(m.subtext).trim();
    const text = s(m.text);
    const translation = s(m.translation).trim();
    if (translation && translation !== text.trim()) meta.translation = translation;

    if (m.type === 'state' && systemNotice) return { ...base, role: 'system', type: 'system', content: text || '（系統訊息）', metadata: meta };
    // 場景旁白：照誰寫的放（你／角色），標一下是旁白
    if (m.type === 'state') meta.narration = true;
    if (m.type === 'recalled') return { ...base, role: 'system', type: 'system', content: text || '撤回了一條消息', metadata: meta };
    if (m.transferData && typeof m.transferData === 'object') {
        const t = m.transferData;
        const status = t.status === 'success' || t.status === 'accepted' ? 'accepted' : t.status === 'returned' || t.status === 'refunded' ? 'returned' : 'pending';
        return { ...base, type: 'transfer', content: '[轉帳]', metadata: { ...meta, amount: s(String(t.amount ?? '')), status, ...(s(t.note) ? { note: s(t.note) } : {}), ...(s(t.currency) ? { currency: s(t.currency) } : {}) } };
    }
    if (s(m.image)) {
        return { ...base, type: 'image', content: s(m.image), metadata: { ...meta, ...(s(m.imageSummary) ? { visionDescription: s(m.imageSummary) } : {}) } };
    }
    if (s(m.sticker)) {
        return { ...base, type: 'emoji', content: s(m.sticker), metadata: { ...meta, ...(s(m.stickerMeaning) ? { stickerName: s(m.stickerMeaning) } : {}) } };
    }
    if (m.isVoice) {
        const voice = s(m.voiceText).trim() || text.replace(/^\[語音\]|\[语音\]$/, '').trim();
        if (!voice) { bump(skipped, '空的語音'); return null; }
        return { ...base, type: 'voice', content: voice, metadata: { ...meta, transcript: voice } };
    }
    if (m.isHtml) {
        const plain = stripTags(text);
        if (!plain) { bump(skipped, '那邊專用的卡片（沒有文字）'); return null; }
        return { ...base, type: 'text', content: plain, metadata: meta };
    }
    if (!text.trim()) { bump(skipped, '空白訊息'); return null; }
    return { ...base, type: 'text', content: text, metadata: meta };
}

function convertMessages(raw: any[], group: boolean) {
    const skipped: Record<string, number> = {};
    const counts: Partial<Record<MessageType, number>> = {};
    const messages: ImportedMessage[] = [];
    for (const m of raw) {
        if (!m || typeof m !== 'object') continue;
        const out = convertMessage(m, skipped, group);
        if (!out) continue;
        messages.push(out);
        counts[out.type] = (counts[out.type] || 0) + 1;
    }
    messages.sort((a, b) => a.timestamp - b.timestamp);
    const range = messages.length ? { from: messages[0].timestamp, to: messages[messages.length - 1].timestamp } : undefined;
    return { messages, skipped, counts, ...(range ? { range } : {}) };
}

const cleanSummary = (t: string) => t.replace(/^\[big summary body[^\]]*\]\s*/i, '').trim();

function convertMemories(json: any): ImportedMemory[] {
    const out: ImportedMemory[] = [];
    for (const f of Array.isArray(json.userFacts) ? json.userFacts : []) {
        const text = s(f?.content).trim();
        if (!text) continue;
        const ms = toMs(f.createdAt) ?? Date.now();
        out.push({ key: `fact:${f.id ?? out.length}`, kind: 'fact', ...(s(f.cat) ? { cat: s(f.cat) } : {}), date: dateKey(ms), summary: text });
    }
    for (const h of Array.isArray(json.summaryHistory) ? json.summaryHistory : []) {
        if (!h || h.mergedIntoBigSummary) continue;
        const text = cleanSummary(s(h.summary) || s(h.content));
        if (!text) continue;
        const ms = toMs(h.date) ?? toMs(h.dateRange?.end) ?? Date.now();
        out.push({ key: `summary:${h.id ?? out.length}`, kind: 'summary', date: dateKey(ms), summary: text });
    }
    // episodeSummary 是最新那篇大總結，跟上面重複，不收
    return out;
}

export function parsePhoneExport(json: any): PhoneImport {
    if (!isPhoneExport(json)) throw new Error('不是認得的聊天紀錄檔');
    const group = isGroupKind(json);
    const conv = convertMessages(json.messages, group);
    const base = { exportDate: s(json.exportDate), userName: s(json.user?.name) || undefined, memories: convertMemories(json), ...conv };
    if (group) {
        const speakers = new Map<string, { name: string; sourceId?: string; count: number }>();
        for (const m of json.messages) {
            const name = s(m?.senderName).trim();
            if (!name || m.sender === 'me') continue;
            const cur = speakers.get(name) || { name, ...(s(m.senderCharId) ? { sourceId: s(m.senderCharId) } : {}), count: 0 };
            cur.count++;
            speakers.set(name, cur);
        }
        return { kind: 'group', ...base, group: { name: s(json.group?.name) || '匯入的群聊', ...(s(json.group?.id) ? { sourceId: s(json.group.id) } : {}) }, speakers: [...speakers.values()] };
    }
    const c = json.character || {};
    return { kind: 'private', ...base, character: { name: s(c.name).trim() || '匯入的角色', ...(s(c.role) ? { role: s(c.role) } : {}), ...(s(c.description) ? { description: s(c.description) } : {}), ...(s(c.id) ? { sourceId: s(c.id) } : {}) } };
}

// ─── 寫進去之前 ───

/** Soren 自己匯出的 JSON 匯回來（utils/chatExport.ts）：原本的 id 是「時間|誰|類型」的指紋 */
export const SOREN_JSON_SOURCE = 'soren-json';
export const fingerprintOf = (m: Pick<Message, 'timestamp' | 'role' | 'type'>): string => `${m.timestamp}|${m.role}|${m.type}`;

/** 匯入的那則從哪來：「來源:原本的 id」（不同來源的 id 不會撞在一起）；Soren 自己的用指紋 */
export const importedKey = (f: { source: string; id: string }): string => (f.source === SOREN_JSON_SOURCE ? `fp:${f.id}` : `${f.source}:${f.id}`);

export const importedKeyOf = (m: Pick<Message, 'metadata'>): string | undefined => {
    const f = m.metadata?.importedFrom;
    return f && typeof f.source === 'string' && typeof f.id === 'string' ? importedKey(f) : undefined;
};

export type ExistingMessage = Pick<Message, 'id' | 'metadata'> & Partial<Pick<Message, 'timestamp' | 'role' | 'type'>>;

/** 已經在 Soren 裡的一則，認得出它的 key：匯入來源一個，再加指紋（Soren 自己匯出又匯回同一條線時對得上） */
export const existingKeysOf = (m: ExistingMessage): string[] => {
    const keys: string[] = [];
    const k = importedKeyOf(m);
    if (k) keys.push(k);
    if (typeof m.timestamp === 'number' && m.role && m.type) keys.push(`fp:${fingerprintOf(m as Pick<Message, 'timestamp' | 'role' | 'type'>)}`);
    return keys;
};

/** key → 還沒被對走的 Soren id（同一個指紋可能有好幾則，一則只對一次） */
export class ExistingIndex {
    private byKey = new Map<string, number[]>();
    private used = new Set<number>();
    constructor(existing: ExistingMessage[]) {
        for (const m of existing) for (const k of existingKeysOf(m)) {
            const list = this.byKey.get(k);
            if (list) list.push(m.id); else this.byKey.set(k, [m.id]);
        }
    }
    /** 第一個對得上的 id（不佔用；接引用回覆用） */
    peek(key: string): number | undefined { return this.byKey.get(key)?.[0]; }
    /** 拿走一個還沒用過的 */
    take(key: string): number | undefined {
        const list = this.byKey.get(key);
        if (!list) return undefined;
        const id = list.find(x => !this.used.has(x));
        if (id !== undefined) this.used.add(id);
        return id;
    }
}

/** 這次的訊息裡，哪幾則已經在了（照來源＋原本的 id，或指紋）；ids 是對到的 importedKey，則數看 existingMessageIds */
export function findAlreadyImported(existing: ExistingMessage[], incoming: ImportedMessage[]): { ids: Set<string>; existingMessageIds: number[] } {
    const index = new ExistingIndex(existing);
    const ids = new Set<string>();
    const existingMessageIds: number[] = [];
    for (const m of incoming) {
        const key = importedKey(m.metadata.importedFrom);
        const id = index.take(key);
        if (id !== undefined) { ids.add(key); existingMessageIds.push(id); }
    }
    return { ids, existingMessageIds };
}

/** 選中的記憶 → 角色記憶（標「從別處匯入」，fact 帶分類） */
const CAT_LABEL: Record<string, string> = { user: '關於你', bond: '你們的關係', self: '他自己', people: '其他人', event: '事件' };
export function toMemoryFragments(memories: ImportedMemory[], now = Date.now()): MemoryFragment[] {
    return memories.map((m, i) => ({
        id: `mem-import-${now}-${i}`,
        date: m.date,
        summary: m.kind === 'memory' ? m.summary : m.kind === 'fact' ? `【匯入·${CAT_LABEL[m.cat || ''] || '記得的事'}】${m.summary}` : `【匯入·總結】${m.summary}`,
    }));
}
