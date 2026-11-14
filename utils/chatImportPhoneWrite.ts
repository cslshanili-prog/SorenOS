/**
 * 另一家聊天紀錄寫進 Soren（plans/chat-import-export.md 第 2、3 節）。
 *
 * - planImportRows：純邏輯，決定每則要新增、覆蓋還是跳過（照 metadata.importedFrom 認重複）。
 * - runImport：寫資料庫（一個事務）→ 接上引用回覆。記憶由呼叫端寫進角色卡（要走 OSContext）。
 *
 * Soren 的訊息照寫進去的先後（id）排，不照時間：匯到已經有訊息的線，新的那幾則會接在後面。
 * 覆蓋是原地換內容，位置不動。
 */
import type { Message } from '../types';
import { DB } from './db';
import { importedKey, importedKeyOf, type ImportedMessage } from './chatImportPhone';

export type DuplicateMode = 'skip' | 'overwrite';

/** 一則要寫到哪：私聊給 charId（＋非主線的 personaKey），群聊再加 groupId */
export type ImportPlace = { charId: string; personaKey?: string; groupId?: string };

export type ImportRow = Omit<Message, 'id'> & { id?: number };

export interface ImportPlan {
    rows: ImportRow[];
    /** 每一列對應的匯入訊息（同順序） */
    sources: ImportedMessage[];
    /** importedKey → 已經在 Soren 裡的訊息 id（重複匯入時用來接引用回覆） */
    existingBySource: Map<string, number>;
    skippedDuplicates: number;
    overwritten: number;
    /** 放不進去的（群聊發話人沒對到角色） */
    unplaced: number;
}

export function planImportRows(input: {
    messages: ImportedMessage[];
    existing: Pick<Message, 'id' | 'metadata'>[];
    duplicate: DuplicateMode;
    place: (m: ImportedMessage) => ImportPlace | null;
}): ImportPlan {
    const existingBySource = new Map<string, number>();
    for (const m of input.existing) {
        const key = importedKeyOf(m);
        if (key && !existingBySource.has(key)) existingBySource.set(key, m.id);
    }
    const rows: ImportRow[] = [];
    const sources: ImportedMessage[] = [];
    let skippedDuplicates = 0, overwritten = 0, unplaced = 0;
    for (const m of [...input.messages].sort((a, b) => a.timestamp - b.timestamp)) {
        const place = input.place(m);
        if (!place) { unplaced++; continue; }
        const prevId = existingBySource.get(importedKey(m.metadata.importedFrom));
        if (prevId !== undefined && input.duplicate === 'skip') { skippedDuplicates++; continue; }
        if (prevId !== undefined) overwritten++;
        rows.push({
            ...(prevId !== undefined ? { id: prevId } : {}),
            charId: place.charId,
            ...(place.personaKey ? { personaKey: place.personaKey } : {}),
            ...(place.groupId ? { groupId: place.groupId } : {}),
            role: m.role,
            type: m.type,
            content: m.content,
            timestamp: m.timestamp,
            metadata: { ...m.metadata },
        });
        sources.push(m);
    }
    return { rows, sources, existingBySource, skippedDuplicates, overwritten, unplaced };
}

/** 寫完之後：原本 id → Soren id，有引用回覆的接上（被引用的那則不在 Soren 裡就不接） */
export function replyPatches(plan: ImportPlan, ids: number[], nameOf: (m: ImportedMessage | undefined, fromMe: boolean) => string): Array<{ id: number; fields: Partial<Message> }> {
    const idBySource = new Map(plan.existingBySource);
    const bySource = new Map<string, ImportedMessage>();
    plan.sources.forEach((m, i) => { const k = importedKey(m.metadata.importedFrom); idBySource.set(k, ids[i]); bySource.set(k, m); });
    const out: Array<{ id: number; fields: Partial<Message> }> = [];
    plan.sources.forEach((m, i) => {
        if (!m.replyToSourceId) return;
        const replyKey = importedKey({ source: m.metadata.importedFrom.source, id: m.replyToSourceId });
        const target = idBySource.get(replyKey);
        if (target === undefined) return;
        const fromMe = m.replyToPreview?.fromMe ?? false;
        out.push({ id: ids[i], fields: { replyTo: { id: target, content: m.replyToPreview?.content || '', name: fromMe ? '我' : nameOf(bySource.get(replyKey), false) } } });
    });
    return out;
}

export interface ImportResult { written: number; added: number; overwritten: number; skippedDuplicates: number; unplaced: number }

export async function runImport(plan: ImportPlan, nameOf: (m: ImportedMessage | undefined, fromMe: boolean) => string): Promise<ImportResult> {
    const ids = await DB.writeImportedMessages(plan.rows);
    await DB.patchMessages(replyPatches(plan, ids, nameOf));
    return {
        written: plan.rows.length,
        added: plan.rows.length - plan.overwritten,
        overwritten: plan.overwritten,
        skippedDuplicates: plan.skippedDuplicates,
        unplaced: plan.unplaced,
    };
}
