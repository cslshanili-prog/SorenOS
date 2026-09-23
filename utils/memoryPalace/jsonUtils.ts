/**
 * Memory Palace — JSON 安全解析工具
 *
 * LLM 返回的 JSON 經常有格式問題：
 * - 未轉義的引號
 * - 尾隨逗號
 * - max_tokens 截斷導致 JSON 不完整（最常見！）
 * - Markdown 代碼塊包裹
 *
 * 四層 fallback 確保儘可能多地解析成功。
 */

/**
 * 從 LLM 回覆中安全提取並解析 JSON 數組
 */
export function safeParseJsonArray(raw: string): any[] {
    if (!raw || !raw.trim()) return [];

    // 去掉 markdown 代碼塊包裹
    let cleaned = raw.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();

    // 1. 嘗試提取完整的 [...] 塊
    const fullMatch = cleaned.match(/\[[\s\S]*\]/);
    if (fullMatch) {
        // 直接解析
        try {
            const result = JSON.parse(fullMatch[0]);
            if (Array.isArray(result)) return result;
        } catch { /* continue */ }

        // 修復後解析
        try {
            const fixed = fixBrokenJson(fullMatch[0]);
            const result = JSON.parse(fixed);
            if (Array.isArray(result)) return result;
        } catch { /* continue */ }

        // 逐對象搶救
        const salvaged = salvageObjects(fullMatch[0]);
        if (salvaged.length > 0) return salvaged;
    }

    // 2. 沒有完整 [...] → 可能是被 max_tokens 截斷了
    //    找到 [ 開始，盡力從截斷的內容中搶救完整的對象
    const openBracketIdx = cleaned.indexOf('[');
    if (openBracketIdx >= 0) {
        const truncated = cleaned.slice(openBracketIdx);
        const salvaged = salvageObjects(truncated);
        if (salvaged.length > 0) {
            console.warn(`⚡ [JSON] Salvaged ${salvaged.length} objects from truncated response`);
            return salvaged;
        }
    }

    // 3. 連 [ 都沒有，直接從整個文本中搶救 {...} 塊
    const lastResort = salvageObjects(cleaned);
    if (lastResort.length > 0) {
        console.warn(`⚡ [JSON] Last resort: salvaged ${lastResort.length} objects`);
        return lastResort;
    }

    return [];
}

/** 修復 LLM 輸出的 JSON 中常見格式錯誤 */
function fixBrokenJson(s: string): string {
    // 尾隨逗號 ,] 或 ,}
    s = s.replace(/,\s*([}\]])/g, '$1');
    // 屬性名單引號→雙引號
    s = s.replace(/'(\w+)'\s*:/g, '"$1":');
    // 字符串值中的未轉義換行
    s = s.replace(/"([^"]*)\n([^"]*)"/g, (_, a, b) => `"${a}\\n${b}"`);
    return s;
}

/** 按 {...} 塊逐個嘗試解析，能救多少救多少
 *
 * ⚠️ 不要用正則 `/\{(?:[^{}[\]]*|\{[^{}]*\}|\[[^\[\]]*\])*\}/g` 去切對象——
 * 這種帶嵌套選擇 + 外層 * 的 regex 在 V8 引擎下有**災難性回溯**風險：
 * 一條 LLM 回覆裡某個 content 字符串碰巧帶個裸 `{` 或結構被截斷一半，
 * regex 就會指數時間爆炸，整個主線程被鎖死（用戶 F12 都打不開）。
 * 實測觸發過一次 Gemini 3.1 pro preview 返回遷移記憶把頁面完全凍住。
 *
 * 改成線性狀態機掃描：O(n) 字符級遍歷，追蹤 brace 深度 + string 上下文，
 * 取頂層配平的 `{...}` 片段。可控、無回溯、永遠不會凍 UI。
 */
function salvageObjects(raw: string): any[] {
    const results: any[] = [];
    const n = raw.length;
    let i = 0;
    while (i < n) {
        // 跳到下一個潛在對象起點
        const start = raw.indexOf('{', i);
        if (start < 0) break;

        // 從 start 開始掃到配平的 }
        let depth = 0;
        let inString = false;
        let escaped = false;
        let end = -1;
        for (let j = start; j < n; j++) {
            const ch = raw.charCodeAt(j);
            if (escaped) { escaped = false; continue; }
            if (inString) {
                if (ch === 92 /* \ */) escaped = true;
                else if (ch === 34 /* " */) inString = false;
                continue;
            }
            if (ch === 34 /* " */) { inString = true; continue; }
            if (ch === 123 /* { */) depth++;
            else if (ch === 125 /* } */) {
                depth--;
                if (depth === 0) { end = j; break; }
            }
        }

        if (end < 0) break; // 沒配平，放棄後續（正常截斷情況）
        const candidate = raw.slice(start, end + 1);
        i = end + 1;

        // 第一層：直接解析
        try {
            const obj = JSON.parse(candidate);
            if (obj && typeof obj === 'object') {
                results.push(obj);
                continue;
            }
        } catch { /* try fix */ }
        // 第二層：修復後解析
        try {
            const obj = JSON.parse(fixBrokenJson(candidate));
            if (obj && typeof obj === 'object') {
                results.push(obj);
            }
        } catch { /* skip this object */ }
    }
    return results;
}
