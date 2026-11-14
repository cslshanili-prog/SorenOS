/**
 * SillyTavern 聊天（.jsonl）→ 見面故事（plans/chat-import-export.md 第 4 節）。純邏輯，不碰資料庫。
 *
 * - 第一行是檔頭（chat_metadata、user_name、character_name），之後一行一則（name、is_user、mes、send_date、swipes…）
 * - 每則只收當時選的那一版：ST 的 mes 就是 swipes[swipe_id]，其他版本不收
 * - <thinking>…</thinking> 和 extra.reasoning 收進那則的思考過程（metadata.dateReasoning），正文拿掉；
 *   其他標籤原樣留著（交給見面匯入的 ST 預設和正則去顯示），原文存 metadata.dateRaw
 * - is_system（ST 隱藏起來、不給 AI 看的）照樣收，標 stHidden；chat_metadata、extra.model 之類不收
 *
 * 轉出來是 ImportedMessage（跟另一家的同一個型別），寫進去走 chatImportPhoneWrite 的 planImportRows／runImport。
 */
import type { ImportedMessage } from './chatImportPhone';

export const ST_CHAT_SOURCE = 'st-jsonl';

export interface StChatImport {
    /** 檔頭的名字；常常是 unused，拿不準就看 speakerName */
    userName?: string;
    /** 角色那邊在訊息上的名字（出現最多的那個） */
    charName?: string;
    messages: ImportedMessage[];
    skipped: Record<string, number>;
    stats: { user: number; char: number; hidden: number; withThinking: number; droppedSwipes: number; images: number };
    range?: { from: number; to: number };
}

const THINK_RE = /<(think|thinking|thought)>([\s\S]*?)<\/\1>/gi;
const THINK_OPEN_RE = /<(?:think|thinking|thought)>[\s\S]*$/i;

const s = (v: unknown) => (typeof v === 'string' ? v : '');
const truthy = (v: unknown) => v === true || v === 'true' || v === 'True';
const bump = (rec: Record<string, number>, k: string) => { rec[k] = (rec[k] || 0) + 1; };
const realName = (n: string) => (n && n.trim() && n.trim().toLowerCase() !== 'unused' ? n.trim() : undefined);

const toMs = (v: unknown): number | null => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim()) {
        const t = Date.parse(v);
        if (Number.isFinite(t)) return t;
        // 舊版 ST：「November 14, 2026 4:43am」
        const m = v.trim().match(/^(.+?\d{4})\s+(\d{1,2}):(\d{2})\s*(am|pm)$/i);
        if (m) {
            const base = Date.parse(m[1]);
            if (Number.isFinite(base)) {
                let h = Number(m[2]) % 12;
                if (m[4].toLowerCase() === 'pm') h += 12;
                const d = new Date(base);
                d.setHours(h, Number(m[3]), 0, 0);
                return d.getTime();
            }
        }
    }
    return null;
};

/** 正文裡的思考拆出來：回傳拿掉之後的正文和思考 */
export function splitThinking(text: string): { body: string; thinking: string } {
    const parts: string[] = [];
    let body = text.replace(THINK_RE, (_m, _tag, inner: string) => { if (inner.trim()) parts.push(inner.trim()); return ''; });
    // 沒收尾的 <thinking>（生成被截掉）：後面全算思考
    const open = body.match(THINK_OPEN_RE);
    if (open) {
        const inner = open[0].replace(/^<(?:think|thinking|thought)>/i, '').trim();
        if (inner) parts.push(inner);
        body = body.slice(0, open.index);
    }
    return { body: body.trim(), thinking: parts.join('\n\n') };
}

const parseLines = (text: string): any[] => {
    const out: any[] = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { throw new Error('檔案裡有一行不是 JSON，可能不是 SillyTavern 的聊天檔'); }
    }
    return out;
};

const isHeader = (row: any) => !!row && typeof row === 'object' && ('chat_metadata' in row || ('user_name' in row && 'character_name' in row && !('mes' in row)));
const isMessage = (row: any) => !!row && typeof row === 'object' && typeof row.mes === 'string' && 'is_user' in row;

export function isStChatText(text: string): boolean {
    try {
        const rows = parseLines(text);
        return rows.length > 0 && (isHeader(rows[0]) ? rows.slice(1) : rows).some(isMessage);
    } catch {
        return false;
    }
}

export function parseStChat(text: string): StChatImport {
    const rows = parseLines(text.replace(/^﻿/, ''));
    if (!rows.length) throw new Error('這個檔案是空的');
    const header = isHeader(rows[0]) ? rows[0] : null;
    const body = header ? rows.slice(1) : rows;
    if (!body.some(isMessage)) throw new Error('不是 SillyTavern 的聊天檔（.jsonl）');

    const skipped: Record<string, number> = {};
    const stats = { user: 0, char: 0, hidden: 0, withThinking: 0, droppedSwipes: 0, images: 0 };
    const charNames: Record<string, number> = {};
    const messages: ImportedMessage[] = [];
    let lastTs = 0;

    body.forEach((row, index) => {
        if (!isMessage(row)) { bump(skipped, '認不得的行'); return; }
        const fromUser = truthy(row.is_user);
        const extra = row.extra && typeof row.extra === 'object' ? row.extra : {};
        const raw = s(row.mes).replace(/\r\n/g, '\n');
        const { body: content, thinking } = fromUser ? { body: raw.trim(), thinking: '' } : splitThinking(raw);
        const reasoning = [s(extra.reasoning).trim(), thinking].filter(Boolean).join('\n\n');
        if (!content) { bump(skipped, fromUser ? '空白訊息' : '只有思考、沒有正文'); return; }
        const ts = toMs(row.send_date) ?? toMs(row.gen_started) ?? (lastTs ? lastTs + 1000 : Date.now());
        lastTs = Math.max(lastTs, ts);
        if (Array.isArray(row.swipes) && row.swipes.length > 1) stats.droppedSwipes += row.swipes.length - 1;
        if (Array.isArray(extra.media) && extra.media.length) stats.images += extra.media.length;
        else if (s(extra.image)) stats.images += 1;
        const hidden = truthy(row.is_system);
        if (hidden) stats.hidden++;
        if (fromUser) stats.user++; else { stats.char++; const n = realName(s(row.name)); if (n) charNames[n] = (charNames[n] || 0) + 1; }
        if (reasoning) stats.withThinking++;
        // 第一則是角色說的才算開場白（你先開口的就沒有）
        const isOpening = !fromUser && messages.length === 0;
        messages.push({
            role: fromUser ? 'user' : 'assistant',
            type: 'text',
            content,
            timestamp: ts,
            metadata: {
                importedFrom: { source: ST_CHAT_SOURCE, id: `${s(row.send_date) || index}#${fromUser ? 'u' : 'c'}` },
                source: 'date',
                ...(isOpening ? { isOpening: true } : {}),
                ...(!fromUser && raw.trim() !== content ? { dateRaw: raw.trim() } : {}),
                ...(reasoning ? { dateReasoning: reasoning } : {}),
                ...(hidden ? { stHidden: true } : {}),
            },
        });
    });

    const charName = Object.entries(charNames).sort((a, b) => b[1] - a[1])[0]?.[0] ?? realName(s(header?.character_name));
    const range = messages.length ? { from: Math.min(...messages.map(m => m.timestamp)), to: Math.max(...messages.map(m => m.timestamp)) } : undefined;
    return {
        ...(realName(s(header?.user_name)) ? { userName: realName(s(header?.user_name)) } : {}),
        ...(charName ? { charName } : {}),
        messages, skipped, stats,
        ...(range ? { range } : {}),
    };
}

/** 檔名 → 故事標題（拿掉副檔名、ST 自動加的時間戳） */
export function stChatTitle(fileName: string): string {
    const stem = fileName.replace(/\.jsonl?$/i, '').trim();
    const cleaned = stem.replace(/\s*-\s*\d{4}-\d{1,2}-\d{1,2}\s*@\s*\d{1,2}h\s*\d{1,2}m\s*\d{1,2}s(\s*\d+ms)?$/i, '').trim();
    return (cleaned || stem).slice(0, 40);
}
