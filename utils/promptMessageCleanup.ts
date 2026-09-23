/**
 * 剝離歷史裡舊的雙語標籤：`%%BILINGUAL%%` 形態整條在標記處截斷（只留原文側），
 * `<翻譯>` XML 形態只留 <原文>。
 */
export function cleanApiMessages(
    apiMessages: Array<{ role: string; content: any }>,
): Array<{ role: string; content: any }> {
    return apiMessages.map((msg: any) => {
        if (typeof msg.content !== 'string') return msg;
        let c: string = msg.content;
        if (c.toLowerCase().includes('%%bilingual%%')) {
            const idx = c.toLowerCase().indexOf('%%bilingual%%');
            c = c.substring(0, idx).trim();
        }
        if (/<翻[译譯]>/.test(c)) {
            c = c.replace(/<翻[译譯]>\s*<原文>([\s\S]*?)<\/原文>\s*<[译譯]文>[\s\S]*?<\/[译譯]文>\s*<\/翻[译譯]>/g, '$1').trim();
        }
        return { ...msg, content: c };
    });
}

/**
 * 單條多模態 content 的拍平內核：保留 text 部分，丟棄 image_url/base64。
 * 「圖片消息 → 文字佔位」這條規則全倉庫只此一份——本地 stripImages 路徑
 * （flattenImageContentParts）和即時對話超預算降級路徑（activeMsgClient 的
 * toFirePackChatMessages）都從這裡出，兩條路的產物永遠同源。
 */
export function flattenContentPartsToText(parts: any[]): string {
    const text = parts
        .filter((part: any) => part?.type === 'text')
        .map((part: any) => part.text || '')
        .join('\n')
        .trim();
    return text || '[圖片]';
}

/**
 * 把多模態圖片消息壓平成純文本：保留 text 部分，丟棄 image_url/base64。
 */
export function flattenImageContentParts(
    apiMessages: Array<{ role: string; content: any }>,
): Array<{ role: string; content: any }> {
    return apiMessages.map((msg) => {
        if (!Array.isArray(msg.content)) return msg;
        return { ...msg, content: flattenContentPartsToText(msg.content) };
    });
}
