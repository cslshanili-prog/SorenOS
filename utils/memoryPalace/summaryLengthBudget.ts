/**
 * 整合回憶長度兜底（純邏輯，無外部依賴，便於單測）。
 *
 * content 超過硬上限時：
 *   1. 先用 recompress 讓模型二次壓縮；壓到硬上限內就採用（不丟信息、無「……」）。
 *   2. 二次壓縮失敗 / 壓完仍超 → 取更短的那份做基底，硬截斷 +「……」保證絕對有界。
 *
 * recompress 由調用方注入（真實路徑是 LLM 調用），單測時換成假實現即可不碰網絡。
 */
export async function enforceSummaryLengthBudget(
    content: string,
    recompress: (text: string) => Promise<string | null>,
    hardMaxChars: number,
): Promise<string> {
    if (content.length <= hardMaxChars) return content;
    const recompressed = await recompress(content);
    if (recompressed && recompressed.length <= hardMaxChars) return recompressed;
    const base = recompressed && recompressed.length < content.length ? recompressed : content;
    return base.slice(0, hardMaxChars) + '……';
}
