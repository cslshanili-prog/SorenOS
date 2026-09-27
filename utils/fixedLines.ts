import type { CharacterProfile, FixedLine } from '../types';
import { scriptKey } from './scriptKey';
import { expandWorldbookMacros } from './worldbook';

/**
 * 固定台詞（神經鏈接 · 對話範例底下）：同人卡的經典對白，「你說 A，TA 就回 B」，要一字不改。
 * 跟對話範例是兩回事——範例教口吻、不能照抄，聊久了還會拿掉；固定台詞一直都在、而且要照抄。
 *
 * - 有「對方說」：對方最新一句裡出現這句（簡繁、大小寫、標點、空白不計）才觸發，這一輪放在最靠近
 *   角色開口的位置（私聊易變段尾、見面的每輪註記、通話與群聊的系統提示詞）。沒觸發不佔 token。
 * - 沒「對方說」：招牌台詞／口頭禪，每輪都帶在人設裡，劇情合適時原樣說出。
 */

export const FIXED_LINES_MAX = 30;
/** 一輪最多觸發幾句，免得對方一段長話同時踩中一堆 */
const TRIGGER_MAX = 3;

/** 比對時不計的標點與空白（全形、半形都算） */
const IGNORED = /[\s　-〿！-／：-＠［-｀｛-･!-/:-@[-`{-~…—–·‧“”‘’]/g;

export const fixedLineKey = (text: string): string => scriptKey(String(text ?? '').toLowerCase()).replace(IGNORED, '');

export const newFixedLineId = (): string => `fl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/** 存檔前整理：去頭尾空白、沒有台詞的丟掉、最多 30 句。 */
export function normalizeFixedLines(lines: FixedLine[] | undefined): FixedLine[] | undefined {
    const cleaned = (lines || [])
        .map(line => ({ id: line.id || newFixedLineId(), trigger: line.trigger?.trim() || undefined, reply: String(line.reply ?? '').trim() }))
        .filter(line => line.reply)
        .slice(0, FIXED_LINES_MAX);
    return cleaned.length ? cleaned : undefined;
}

export const signatureLines = (lines: FixedLine[] | undefined): FixedLine[] =>
    (lines || []).filter(line => !line.trigger?.trim() && line.reply?.trim());

/** 對方這句踩中了哪些固定台詞。 */
export function triggeredFixedLines(lines: FixedLine[] | undefined, userText: string | undefined): FixedLine[] {
    const said = fixedLineKey(userText || '');
    if (!said) return [];
    return (lines || [])
        .filter(line => {
            const key = fixedLineKey(line.trigger || '');
            return key && line.reply?.trim() && said.includes(key);
        })
        .slice(0, TRIGGER_MAX);
}

/** 招牌台詞（沒填「對方說」的）：放在人設裡，每輪都在。 */
export function formatSignatureLinesBlock(lines: FixedLine[] | undefined, charName: string, userName: string): string {
    const list = signatureLines(lines);
    if (!list.length) return '';
    const items = list.map(line => `- 「${expandWorldbookMacros(line.reply.trim(), charName, userName)}」`).join('\n');
    return `### 招牌台詞 (Signature Lines)
以下是 ${charName} 的固定台詞／口頭禪。劇情合適的時候原樣說出，一字不改；不需要每次都說。
${items}

`;
}

/** 這一輪被觸發的固定台詞：放在最靠近角色開口的地方。 */
export function formatTriggeredLinesBlock(matched: FixedLine[], charName: string, userName: string): string {
    if (!matched.length) return '';
    const items = matched.map(line =>
        `- ${userName} 剛才說了「${expandWorldbookMacros(line.trigger!.trim(), charName, userName)}」→ 這一輪 ${charName} 要原樣說出：「${expandWorldbookMacros(line.reply.trim(), charName, userName)}」`,
    ).join('\n');
    return `【固定台詞】這是你們之間固定的一問一答，這一輪一定要說，前後可以自然接話，但引號裡的句子一字不改：
${items}`;
}

/** 方便調用方：拿角色和對方最新一句，直接給觸發區塊（沒觸發回空字串）。 */
export function buildTriggeredLinesPrompt(
    char: Pick<CharacterProfile, 'fixedLines' | 'name'>,
    userText: string | undefined,
    userName: string,
): string {
    return formatTriggeredLinesBlock(triggeredFixedLines(char.fixedLines, userText), char.name, userName);
}

/** 訊息陣列裡對方最新說的那句（純文字）。 */
export function latestUserText(messages: Array<{ role: string; content: unknown; type?: string }> | undefined): string {
    for (let i = (messages?.length || 0) - 1; i >= 0; i--) {
        const m = messages![i];
        if (m.role !== 'user') continue;
        if (m.type && m.type !== 'text') continue;
        return typeof m.content === 'string' ? m.content : '';
    }
    return '';
}
