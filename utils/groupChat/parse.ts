// 群聊 LLM 輸出解析 —— 兩層容錯（家規：嚴格層失敗後進寬鬆層，絕不靜默丟整輪輸出）。
// 純函數、無副作用，便於 vitest 直測。

export interface DirectorAction {
    charId: string;
    content: string;
}

/** 剝掉 markdown 代碼圍欄（```json / ```yaml / ``` 等），LLM 很愛裹這個 */
const stripFences = (raw: string): string =>
    String(raw ?? '')
        .replace(/```[a-zA-Z]*\r?\n?/g, '')
        .replace(/```/g, '')
        .trim();

/** 逐字段規整導演動作：charId 強轉 string，content 非 string 時兜底轉換，空的丟棄 */
const normalizeAction = (a: any): DirectorAction | null => {
    if (!a || typeof a !== 'object') return null;
    const charId = a.charId == null ? '' : String(a.charId).trim();
    const content = (typeof a.content === 'string' ? a.content : String(a.content ?? '')).trim();
    if (!charId || !content) return null;
    return { charId, content };
};

/**
 * 解析導演模式輸出的 JSON 動作數組。
 * 第一層（嚴格）：剝圍欄 → 截取最外層 [ ... ] → JSON.parse 整體。
 * 第二層（寬鬆）：正則逐個摳出含 "charId" 的對象逐個 parse，能救一個是一個。
 * 兩層皆空時返回 []，由調用方決定是否提示用戶。
 */
export function parseDirectorActions(raw: string): DirectorAction[] {
    // 推理模型常在 JSON 前面先來一段 <think>…</think>，裡面也可能有 [ ]，先剝掉再找數組
    const text = stripFences(String(raw ?? '').replace(/<(think|thinking|thought|reasoning|analysis)>[\s\S]*?<\/\1>/gi, ''));
    if (!text) return [];

    const first = text.indexOf('[');
    const last = text.lastIndexOf(']');
    if (first !== -1 && last > first) {
        try {
            const arr = JSON.parse(text.substring(first, last + 1));
            if (Array.isArray(arr)) {
                const normalized = arr.map(normalizeAction).filter((a): a is DirectorAction => a !== null);
                if (normalized.length > 0) return normalized;
            }
        } catch { /* 掉進第二層 */ }
    }

    const objMatches = text.match(/\{[^{}]*?["']charId["'][\s\S]*?\}/g) || [];
    const rescued: DirectorAction[] = [];
    for (const m of objMatches) {
        try {
            const action = normalizeAction(JSON.parse(m));
            if (action) rescued.push(action);
        } catch { /* 這個對象壞了，跳過它救別的 */ }
    }
    return rescued;
}

/**
 * [[SKIP]] 輸出剝離兜底（提示詞已不再教這個標記——輪詢模式現在要求每位成員必發言）：
 * 模型若仍吐出 [[SKIP]] 或空內容，剝淨後沒剩正文 = 本輪跳過該成員。
 */
export function stripSkipMarker(raw: string): { skipped: boolean; content: string } {
    const content = stripFences(raw).replace(/\[\[\s*SKIP\s*\]\]/gi, '').trim();
    return { skipped: content === '', content };
}

export interface GroupTopicBoxParsed {
    title: string;
    summary: string;
}

/**
 * 解析「群公共話題盒」總結輸出：提示詞要求模型只吐 {"title","summary"} 的 JSON，
 * 但實際返回常常掉格式（summary 裡帶裸換行 / 未轉義引號、外面裹一層 ```json、
 * 推理模型先來一段 <think>…</think>）。舊版 parseTopicBoxResponse 只做嚴格 JSON.parse，
 * 一旦 parse 失敗就整輪報「總結格式無法解析」並拋錯——而這會讓
 * archivedThroughMessageId 永遠推進不了，熱區以前的消息越堆越多（用戶實測卡到 649 條），
 * 歸檔隊列被一條壞輸出永久堵死。這裡按家規做三層容錯，寧可給個粗糙總結也絕不卡住隊列。
 *
 * 第一層（嚴格）：剝圍欄 / <think> 後，整體 or 最外層 {…} 直接 JSON.parse。
 * 第二層（寬鬆）：JSON 壞在字符串裡的裸換行——直接正則摳 title / summary 字段值（允許含換行）。
 * 第三層（兜底）：模型壓根沒給結構，只要有實質文本，整段當 summary 用（截斷防超長）。
 * 三層皆空返回 null，由調用方決定是否提示用戶。
 */
export function parseGroupTopicBox(raw: string): GroupTopicBoxParsed | null {
    const text = String(raw ?? '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '') // 推理模型的思考塊，會把 JSON 沖垮
        .replace(/```[a-zA-Z]*\r?\n?/g, '')
        .replace(/```/g, '')
        .trim();
    if (!text) return null;

    const fromObj = (p: any): GroupTopicBoxParsed | null => {
        if (!p || typeof p !== 'object') return null;
        const summary = p.summary == null ? '' : String(p.summary).trim();
        if (!summary) return null;
        const title = p.title == null ? '' : String(p.title).trim();
        return { title: title || '一段群聊回憶', summary };
    };

    // 第一層：整體 JSON，或截取最外層 {…} 再 parse
    try {
        const hit = fromObj(JSON.parse(text));
        if (hit) return hit;
    } catch { /* 掉進下一層 */ }
    const braceStart = text.indexOf('{');
    const braceEnd = text.lastIndexOf('}');
    if (braceStart !== -1 && braceEnd > braceStart) {
        try {
            const hit = fromObj(JSON.parse(text.slice(braceStart, braceEnd + 1)));
            if (hit) return hit;
        } catch { /* 掉進下一層 */ }
    }

    // 第二層：JSON 結構壞了，直接摳字段值（[\s\S] 容忍值裡的裸換行）。
    // summary 摳到閉合引號後緊跟的 , / } / 文末為止。
    const summaryMatch = text.match(/["']?summary["']?\s*[:：]\s*["']([\s\S]*?)["']\s*(?:[,，}]|$)/i);
    if (summaryMatch && summaryMatch[1].trim()) {
        const titleMatch = text.match(/["']?title["']?\s*[:：]\s*["']([\s\S]*?)["']\s*(?:[,，}]|$)/i);
        return {
            title: (titleMatch?.[1] || '').trim() || '一段群聊回憶',
            summary: summaryMatch[1].trim(),
        };
    }

    // 第三層：完全沒結構，但有實質文本——整段當總結用，好過永久卡死歸檔隊列
    const plain = text.replace(/^[{[]+/, '').replace(/[}\]]+$/, '').trim();
    if (plain.length >= 10) {
        return { title: '一段群聊回憶', summary: plain.length > 800 ? `${plain.slice(0, 800)}…` : plain };
    }
    return null;
}

/**
 * 解析群總結輸出裡的 summary 字段。
 * 第一層（嚴格）：剝圍欄後匹配 `summary:` + 引號閉合配對（或裸值取到文末）。
 * 第二層（寬鬆）：剝 `summary:` 前綴、剝首尾引號，取全文 trim——
 * 模型沒按 YAML 輸出時，整段就當總結正文用。
 */
export function parseSummaryYaml(raw: string): string {
    const text = stripFences(raw);
    if (!text) return '';

    const quoted = text.match(/(?:^|\n)\s*summary\s*[:：]\s*(["'])([\s\S]*?)\1\s*(?:\n|$)/i);
    if (quoted && quoted[2].trim()) return quoted[2].trim();

    const bare = text.match(/(?:^|\n)\s*summary\s*[:：]\s*([\s\S]+)$/i);
    const candidate = bare ? bare[1] : text;
    return candidate
        .replace(/^summary\s*[:：]\s*/i, '')
        .trim()
        .replace(/^["'“”]+|["'“”]+$/g, '')
        .trim();
}
