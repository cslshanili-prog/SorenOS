/**
 * 聊天紀錄匯出（plans/chat-import-export.md 第 6 節）。純邏輯，不碰資料庫。
 *
 * - 私聊 → Soren JSON（`format: 'soren-chat'`，能從匯入頁原樣匯回來，含引用、卡片、可選的記憶）或 TXT（給人看）
 * - 見面故事 → ST 的 .jsonl（搬回酒館）；見面的 TXT 本來就有（utils/dateHistory.ts）
 * - Soren JSON 匯回來：parseSorenChatExport 轉成跟另一家一樣的 PhonePrivateImport，寫入走同一套；
 *   重複照「時間|誰|類型」的指紋認（SOREN_JSON_SOURCE），所以匯回原本那條線不會多出一份
 */
import type { MemoryFragment, Message, MessageType } from '../types';
import { fingerprintOf, SOREN_JSON_SOURCE, type ImportedMemory, type ImportedMessage, type PhoneImport, type PhonePrivateImport, isPhoneExport, parsePhoneExport } from './chatImportPhone';
import { isVisibleChatMessage } from './chatMessageVisibility';
import { isBlobRef } from './blobRef';

export const SOREN_CHAT_FORMAT = 'soren-chat';
export const SOREN_CHAT_VERSION = 1;

export interface SorenExportedMessage {
    id: number;
    role: Message['role'];
    type: MessageType;
    content: string;
    timestamp: number;
    metadata?: Record<string, any>;
    replyTo?: Message['replyTo'];
}

export interface SorenChatExport {
    format: typeof SOREN_CHAT_FORMAT;
    version: number;
    exportDate: string;
    kind: 'private';
    character: { id: string; name: string };
    user: { name: string };
    messages: SorenExportedMessage[];
    memories?: Array<Pick<MemoryFragment, 'date' | 'summary'> & { mood?: string }>;
}

export interface ExportRange { from?: number; to?: number }

/** 本地日期 'YYYY-MM-DD' → 那天 00:00／23:59:59.999 */
export const dayStart = (key: string): number => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
export const dayEnd = (key: string): number => dayStart(key) + 24 * 3600 * 1000 - 1;

const inRange = (ts: number, r?: ExportRange) => (!r || ((r.from === undefined || ts >= r.from) && (r.to === undefined || ts <= r.to)));

/** 私聊畫面那個範圍的訊息（不含見面、通話、群），照 id 排，再套日期區間 */
export function chatScopeMessages(messages: Message[], range?: ExportRange): Message[] {
    return messages.filter(m => isVisibleChatMessage(m, false) && inRange(m.timestamp, range)).sort((a, b) => a.id - b.id);
}

/** 不帶出去的 metadata：只在這台裝置有意義的 */
const LOCAL_META = ['deliveryId'];
const cleanMeta = (meta: any): Record<string, any> | undefined => {
    if (!meta || typeof meta !== 'object') return undefined;
    const out = { ...meta };
    for (const k of LOCAL_META) delete out[k];
    return Object.keys(out).length ? out : undefined;
};

export function buildSorenChatExport(input: {
    char: { id: string; name: string };
    userName: string;
    messages: Message[];
    memories?: MemoryFragment[];
    now?: number;
}): SorenChatExport {
    return {
        format: SOREN_CHAT_FORMAT,
        version: SOREN_CHAT_VERSION,
        exportDate: new Date(input.now ?? Date.now()).toISOString(),
        kind: 'private',
        character: { id: input.char.id, name: input.char.name },
        user: { name: input.userName },
        messages: input.messages.map(m => ({
            id: m.id, role: m.role, type: m.type, content: m.content, timestamp: m.timestamp,
            ...(cleanMeta(m.metadata) ? { metadata: cleanMeta(m.metadata) } : {}),
            ...(m.replyTo ? { replyTo: m.replyTo } : {}),
        })),
        ...(input.memories?.length ? { memories: input.memories.map(f => ({ date: f.date, summary: f.summary, ...(f.mood ? { mood: f.mood } : {}) })) } : {}),
    };
}

/** 本機才看得到的圖（blobref 令牌、data URI）有幾則：匯出前提醒用 */
export const localMediaCount = (messages: Message[]): number =>
    messages.filter(m => (m.type === 'image' || m.type === 'emoji') && (isBlobRef(String(m.content || '').trim()) || /^data:/i.test(String(m.content || '').trim()))).length;

// ─── TXT ───

const pad = (n: number) => String(n).padStart(2, '0');
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const dayLabel = (ts: number) => { const d = new Date(ts); return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}（週${WEEK[d.getDay()]}）`; };
const timeLabel = (ts: number) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/** 一則訊息在 TXT 裡的樣子 */
export function txtContent(m: Message, stickerName?: (url: string, fallback?: string) => string): string {
    const raw = typeof m.content === 'string' ? m.content : '';
    const meta = m.metadata || {};
    switch (m.type) {
        case 'image': return meta.visionDescription ? `[圖片：${String(meta.visionDescription).trim()}]` : '[圖片]';
        case 'emoji': return `[貼圖：${stickerName ? stickerName(raw.trim(), meta.stickerName) : (meta.stickerName || '貼圖')}]`;
        case 'voice': return `[語音] ${String(meta.transcript || raw).trim()}`;
        case 'transfer': return meta.packet ? `[紅包 ${meta.totalAmount ?? ''}]` : `[轉帳 ${meta.amount ?? ''}${meta.status === 'accepted' ? '，已收' : meta.status === 'returned' ? '，已退回' : ''}]`;
        default: {
            const t = raw.trim();
            if (/^(data:|https?:\/\/)/i.test(t) || isBlobRef(t)) return '[媒體]';
            return raw;
        }
    }
}

export function formatChatTxt(input: {
    charName: string;
    userName: string;
    messages: Message[];
    stickerName?: (url: string, fallback?: string) => string;
    now?: number;
}): string {
    const lines: string[] = [
        `聊天紀錄 · ${input.charName}`,
        `匯出時間：${dayLabel(input.now ?? Date.now())} ${timeLabel(input.now ?? Date.now())}`,
        `共 ${input.messages.length} 則`,
    ];
    let lastDay = '';
    for (const m of input.messages) {
        const day = dayLabel(m.timestamp);
        if (day !== lastDay) { lines.push('', `===== ${day} =====`); lastDay = day; }
        const who = m.role === 'user' ? input.userName : m.role === 'assistant' ? input.charName : '系統';
        const quote = m.replyTo?.content ? `（回覆「${m.replyTo.content.slice(0, 30)}」）` : '';
        lines.push(`${who} ${timeLabel(m.timestamp)}：${quote}${txtContent(m, input.stickerName)}`);
    }
    return `﻿${lines.join('\n')}\n`;
}

// ─── ST .jsonl（見面故事） ───

const THINK_RE = /<(think|thinking|thought)>[\s\S]*?<\/\1>/gi;

export function buildStChatJsonl(input: { charName: string; userName: string; messages: Message[]; now?: number }): string {
    const created = new Date(input.now ?? Date.now()).toISOString();
    const rows: any[] = [{ user_name: input.userName, character_name: input.charName, create_date: created, chat_metadata: {} }];
    for (const m of [...input.messages].sort((a, b) => a.id - b.id)) {
        if (m.type !== 'text' || (m.role !== 'user' && m.role !== 'assistant')) continue;
        const fromUser = m.role === 'user';
        const raw = typeof m.metadata?.dateRaw === 'string' ? m.metadata.dateRaw : m.content;
        const mes = String(raw || '').replace(THINK_RE, '').trim();
        if (!mes) continue;
        const reasoning = typeof m.metadata?.dateReasoning === 'string' ? m.metadata.dateReasoning : '';
        const sendDate = new Date(m.timestamp).toISOString();
        rows.push({
            name: fromUser ? input.userName : input.charName,
            is_user: fromUser,
            is_system: !!m.metadata?.stHidden,
            send_date: sendDate,
            mes,
            extra: reasoning ? { reasoning } : {},
            ...(fromUser ? {} : { swipes: [mes], swipe_id: 0, swipe_info: [{ send_date: sendDate, extra: reasoning ? { reasoning } : {} }] }),
        });
    }
    return rows.map(r => JSON.stringify(r)).join('\n') + '\n';
}

// ─── 檔名 ───

export function exportFileName(name: string, what: string, ext: 'json' | 'txt' | 'jsonl', now = Date.now()): string {
    const d = new Date(now);
    const safe = name.replace(/[\\/:*?"<>|]/g, '_').trim() || '角色';
    return `${safe}_${what}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.${ext}`;
}

// ─── Soren JSON 匯回來 ───

export const isSorenChatExport = (json: any): json is SorenChatExport =>
    !!json && typeof json === 'object' && json.format === SOREN_CHAT_FORMAT && Array.isArray(json.messages);

const dateKeyOf = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

export function parseSorenChatExport(json: SorenChatExport): PhonePrivateImport {
    if (!isSorenChatExport(json)) throw new Error('不是認得的聊天紀錄檔');
    const fpById = new Map<number, string>();
    for (const m of json.messages) if (m && typeof m.timestamp === 'number') fpById.set(m.id, fingerprintOf(m));
    const skipped: Record<string, number> = {};
    const counts: Partial<Record<MessageType, number>> = {};
    const messages: ImportedMessage[] = [];
    for (const m of json.messages) {
        if (!m || typeof m.timestamp !== 'number' || !m.role || !m.type) { skipped['格式不對'] = (skipped['格式不對'] || 0) + 1; continue; }
        const { importedFrom: _old, ...meta } = (m.metadata || {}) as Record<string, any>;
        const replyFp = m.replyTo ? fpById.get(m.replyTo.id) : undefined;
        messages.push({
            role: m.role, type: m.type, content: typeof m.content === 'string' ? m.content : '', timestamp: m.timestamp,
            metadata: { ...meta, importedFrom: { source: SOREN_JSON_SOURCE, id: fingerprintOf(m) } },
            ...(replyFp ? { replyToSourceId: replyFp, replyToPreview: { content: m.replyTo!.content || '', fromMe: m.replyTo!.name === '我' } } : {}),
        });
        counts[m.type] = (counts[m.type] || 0) + 1;
    }
    messages.sort((a, b) => a.timestamp - b.timestamp);
    const memories: ImportedMemory[] = (json.memories || []).filter(f => f && typeof f.summary === 'string' && f.summary.trim())
        .map((f, i) => ({ key: `memory:${i}`, kind: 'memory' as const, date: f.date || dateKeyOf(Date.now()), summary: f.summary }));
    return {
        kind: 'private', origin: 'soren',
        exportDate: json.exportDate, userName: json.user?.name || undefined,
        character: { name: json.character?.name || '匯入的角色', ...(json.character?.id ? { sourceId: json.character.id } : {}) },
        messages, memories, skipped, counts,
        ...(messages.length ? { range: { from: messages[0].timestamp, to: messages[messages.length - 1].timestamp } } : {}),
    };
}

/** 匯入頁收到的 JSON：Soren 自己的或另一家的 */
export function parseChatExportJson(json: any): PhoneImport {
    if (isSorenChatExport(json)) return parseSorenChatExport(json);
    if (isPhoneExport(json)) return parsePhoneExport(json);
    throw new Error('不是認得的聊天紀錄檔');
}
