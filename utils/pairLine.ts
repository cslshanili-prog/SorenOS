/**
 * 角色私聊線（關係線第 6 批 6c，plans/persona-line-batch6.md 第 2 節）：兩個角色之間一條線，只存一份。純邏輯。
 *
 * - 訊息照舊存 messages 表，charId 寫成這對角色的線 id（`pair~<小 id>~<大 id>`，不是任何一個角色的 id），
 *   所以現有「照角色讀私聊」的地方一則都不會讀到；誰說的記在 metadata.pairSpeakerId。
 * - 讀寫直接用 DB 現成的 getMessagesByCharId / saveMessage / clearMessages（線 id 當成 charId）。
 * - 查手機的「我:／對方:」腳本照這條線算出來（pairTranscript），兩邊看到的永遠是同一份。
 */
import type { Message } from '../types';
import { parseTranscript, serializeTurns } from './relationshipChat';

export const PAIR_LINE_PREFIX = 'pair~';

export function pairLineId(a: string, b: string): string {
    const [x, y] = [a, b].sort();
    return `${PAIR_LINE_PREFIX}${x}~${y}`;
}

export function isPairLineId(id: string | undefined | null): boolean {
    return !!id && id.startsWith(PAIR_LINE_PREFIX);
}

/** 線 id → 兩個角色 id；不是線 id 回 null。角色 id 本身含 '~' 的不支援（現有 id 都不含）。 */
export function parsePairLineId(id: string): [string, string] | null {
    if (!isPairLineId(id)) return null;
    const rest = id.slice(PAIR_LINE_PREFIX.length);
    const at = rest.indexOf('~');
    if (at <= 0 || at === rest.length - 1) return null;
    return [rest.slice(0, at), rest.slice(at + 1)];
}

export function pairOtherId(pairId: string, selfId: string): string | null {
    const ids = parsePairLineId(pairId);
    if (!ids || !ids.includes(selfId)) return null;
    return ids[0] === selfId ? ids[1] : ids[0];
}

export const pairSpeakerOf = (m: Pick<Message, 'metadata' | 'charId'>): string | undefined =>
    typeof m.metadata?.pairSpeakerId === 'string' ? m.metadata.pairSpeakerId : undefined;

/** 這條線在 viewer 眼中的「我:／對方:」腳本（查手機、雙 LLM 引擎都吃這個格式）。 */
export function pairTranscript(msgs: Array<Pick<Message, 'metadata' | 'charId' | 'content'>>, viewerId: string): string {
    return serializeTurns(msgs
        .filter(m => typeof m.content === 'string' && m.content.trim())
        .map(m => ({ isMe: pairSpeakerOf(m) === viewerId, text: String(m.content).trim() })));
}

/** 一則角色私聊訊息（還沒存的） */
export function pairMessage(pairId: string, speakerId: string, content: string, timestamp: number, extra: Record<string, unknown> = {}): Omit<Message, 'id'> {
    return {
        charId: pairId,
        role: 'assistant',
        type: 'text',
        content,
        timestamp,
        metadata: { pairSpeakerId: speakerId, ...extra },
    } as Omit<Message, 'id'>;
}

/**
 * 雙 LLM 引擎回來的完整 A 視角腳本 → 這一輪新說的話（去掉原本就有的那幾行），逐行一則。
 * existingLines 是送進去的那段腳本有幾行（parseTranscript 的長度）。
 */
export function newPairMessages(args: {
    pairId: string; aId: string; bId: string; aDetail: string; existingLines: number; now: number;
}): Array<Omit<Message, 'id'>> {
    const turns = parseTranscript(args.aDetail).slice(args.existingLines);
    return turns.map((t, i) => pairMessage(args.pairId, t.isMe ? args.aId : args.bId, t.text, args.now + i));
}

/**
 * 查手機舊對話搬進這條線：腳本（owner 視角）逐行拆成訊息，時間從那筆紀錄往前每行排開一分鐘。
 */
export function messagesFromPhoneRecord(args: {
    pairId: string; ownerId: string; partnerId: string; detail: string; recordTimestamp: number;
}): Array<Omit<Message, 'id'>> {
    const turns = parseTranscript(args.detail);
    const n = turns.length;
    return turns.map((t, i) => pairMessage(args.pairId, t.isMe ? args.ownerId : args.partnerId, t.text,
        args.recordTimestamp - (n - 1 - i) * 60_000, { fromPhoneRecord: true }));
}
