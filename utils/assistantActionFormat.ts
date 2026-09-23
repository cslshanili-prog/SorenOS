/**
 * 修復模型把「機器指令」寫成單層方括號 / 歷史展示摘要的常見掉格式。
 *
 * 這裡故意只認完整、帶方括號的高置信度 token：普通正文裡的“我給你轉 520”之類
 * 不能變成副作用。輸出統一回既有 canonical 語法，後續仍由各業務解析器做開關、
 * 金額、方向、去重等校驗。
 */

const cleanArg = (value: string): string => value.trim().replace(/[|｜]/g, '／');

const normalizeExerciseSummary = (raw: string): string => {
    const value = raw.trim();
    // 展示摘要把 activity + duration 拼在一起。只在末尾明顯像時長時才拆，
    // 否則寧可把整段當活動名，也不憑空猜一個錯誤時長。
    const match = value.match(/^(.+?)\s+((?:\d+(?:\.\d+)?|半|一|[两兩]|三|四|五|六|七|八|九|十)\s*(?:分[钟鐘]|小[时時]|[时時]|分))$/);
    if (!match) return `[[LIFE:EXERCISE|${cleanArg(value)}]]`;
    return `[[LIFE:EXERCISE|${cleanArg(match[1])}|${cleanArg(match[2])}]]`;
};

/** Only sticker syntax is shared with group chat; never enable transfer/LIFE actions there. */
export const normalizeAssistantEmojiFormatting = (raw: string): string => {
    const closing: Record<string, string> = { '[[': ']]', '[': ']', '【': '】', '［［': '］］', '［': '］' };
    // Quoted examples are explanatory text. Do not repair deliberately separated spellings.
    return (raw || '').split(/(```[\s\S]*?```|`[^`\r\n]*`)/g).map((part, index) => index % 2 ? part : part.replace(
        /(\[\[|\[|【|［［|［)\s*(?:SEND_EMOJI|(?:[^\[\]【】［］\r\n:：]{1,40}?\s*)?[发發]送了表情包|表情包|表情)\s*[:：]\s*([^\[\]【】［］\r\n]+?)\s*(\]\]|\]|】|］］|］)(?![\]】］])/gim,
        (all, open: string, name: string, close: string, offset: number, source: string) => {
            // iOS Safari <16.4 不支持後行斷言。檢查原文前一字符，不消耗相鄰表情的邊界。
            if (offset > 0 && /[\[【［]/.test(source[offset - 1])) return all;
            return closing[open] === close ? '[[SEND_EMOJI: ' + name.trim() + ']]' : all;
        },
    )).join('');
};

/** 冪等：已經是 [[...]] 的規範標籤不會再次包裹。 */
export const normalizeAssistantActionFormatting = (raw: string): string => {
    let content = raw || '';

    content = normalizeAssistantEmojiFormatting(content);

    // 轉帳：只修明確的 ACTION token；口語版 [轉帳 520] 仍由 transferFormat 的
    // 容錯解析器負責，方向和金額安全校驗也仍在那裡完成。
    content = content.replace(
        /(^|[^\[])\[\s*ACTION\s*[:：]\s*(TRANSFER_(?:ACCEPT|RETURN))\s*\](?!\])/gim,
        (_all, prefix: string, verb: string) => `${prefix}[[ACTION:${verb.toUpperCase()}]]`,
    );
    content = content.replace(
        /(^|[^\[])\[\s*ACTION\s*[:：]\s*TRANSFER\s*([|｜][^\]\r\n]*)\s*\](?!\])/gim,
        (_all, prefix: string, args: string) => `${prefix}[[ACTION:TRANSFER${args.replace(/｜/g, '|')}]]`,
    );
    content = content.replace(
        /(^|[^\[])\[\s*ACTION\s*[:：]\s*TRANSFER\s*[:：]\s*([^\]\r\n]*?)\s*\](?!\])/gim,
        (_all, prefix: string, amount: string) => `${prefix}[[ACTION:TRANSFER:${amount.trim()}]]`,
    );

    // 單括號 LIFE 機器語法。
    content = content.replace(
        /(^|[^\[])\[\s*LIFE\s*[:：]\s*([A-Z_]+)\s*((?:[|｜][^\]\r\n]*)?)\s*\](?!\])/gim,
        (_all, prefix: string, verb: string, args: string) =>
            `${prefix}[[LIFE:${verb.toUpperCase()}${args.replace(/｜/g, '|')}]]`,
    );

    // LIFE 卡片摘要被模型照抄回來時，恢復成機器指令。帶“已有記錄/已確認”等
    // 狀態尾巴的卡片不會命中，避免把歷史裁決當成一筆新動作。
    content = content.replace(
        /(^|[^\[])\[\s*生活[记記][录錄]\s*[:：]\s*生理期[开開]始\s*\](?!\])/gm,
        '$1[[LIFE:PERIOD_START]]',
    );
    content = content.replace(
        /(^|[^\[])\[\s*生活[记記][录錄]\s*[:：]\s*生理期[结結]束\s*\](?!\])/gm,
        '$1[[LIFE:PERIOD_END]]',
    );
    content = content.replace(
        /(^|[^\[])\[\s*生活[记記][录錄]\s*[:：]\s*吃[药藥]\s*(?:[·・•]|\s)\s*([^\]\r\n]+?)\s*\](?!\])/gm,
        (_all, prefix: string, name: string) => `${prefix}[[LIFE:MED|${cleanArg(name)}]]`,
    );
    content = content.replace(
        /(^|[^\[])\[\s*生活[记記][录錄]\s*[:：]\s*支出\s+([¥￥]?\s*[0-9０-９][0-9０-９.,，]*\s*(?:元|[块塊][钱錢]|[块塊]|[圆圓])?)\s*(?:[（(]\s*([^\]）)\r\n]+?)\s*[）)])?\s*\](?!\])/gm,
        (_all, prefix: string, amount: string, note?: string) =>
            `${prefix}[[LIFE:EXPENSE|${amount.trim()}${note ? `|${cleanArg(note)}` : ''}]]`,
    );
    content = content.replace(
        /(^|[^\[])\[\s*生活[记記][录錄]\s*[:：]\s*[锻鍛][炼鍊]\s*(?:[·・•]|\s)\s*([^\]\r\n]+?)\s*\](?!\])/gm,
        (_all, prefix: string, summary: string) => `${prefix}${normalizeExerciseSummary(summary)}`,
    );

    return content;
};
