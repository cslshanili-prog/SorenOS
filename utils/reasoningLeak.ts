/**
 * 模型輸出的「思考過程外洩」清理（群聊、查手機的角色間私聊都用）。
 *
 * 症狀：模型把思考過程當台詞吐出來——`<thinking>…</thinking>`，或沒有標籤、開頭直接一段
 * 「讓我看看現在的狀況…」。群聊回覆以前是原文落庫（私聊那邊的後處理會剝 <think>，群聊沒接），
 * 輪詢模式下一位成員又看得到前一位剛發的話，第一個漏了，後面八九成跟著學，滿屏內心戲。
 *
 * 兩個出口都要洗：
 * - 落庫前（GroupChat 導演／輪詢兩種模式）：源頭不再寫進去；
 * - 組歷史時（buildGroupHistoryBlock）：已經存進去的舊訊息也不再當範例傳染給下一位。
 *
 * 寧可保守：只剝有標籤的區塊、「最終發言」這類分界行之前的分析，和「開頭」那幾行明顯是分析的
 * （markdown 標題、粗體小標、系統口吻、「讓我看看現在的狀況」這類）。台詞中間的句子不動。
 */

/**
 * 思考區塊的標籤名：不只 <thinking>，實測還有 <context_analysis> 這種自創的。
 * 認名字裡帶這些字根的標籤（不帶屬性），HTML 卡片的 <div> 這類不會中。
 */
const TAG_NAME = '[a-z_]*(?:think|thought|reason|analy|context|plan|reflect|scratch|draft|internal|monologue|strateg|cot)[a-z_]*';
const CLOSED_BLOCK_RE = new RegExp(`<(${TAG_NAME})>[\\s\\S]*?<\\/\\1>`, 'gi');
const UNCLOSED_OPEN_RE = new RegExp(`<(?:${TAG_NAME})>[\\s\\S]*$`, 'i');
/** 只剩一個結束標籤（開頭那半被截掉或模型沒寫）：標籤之前的都是思考 */
const LONE_CLOSE_RE = new RegExp(`^[\\s\\S]*?<\\/(?:${TAG_NAME})>`, 'i');

/**
 * 「分析寫完、下面才是要發的」的分界行：【最終發言】、# 最終輸出、「Swan 此刻應該發送的內容：」、Final output。
 * 有這種行就只留最後一條分界之後的內容。
 */
const FINAL_MARKER_RES = [
    /^\s*(?:#{1,6}\s*|\*\*|【|\[)?\s*(?:最終|最后|最後|正式)(?:輸出|输出|發言|发言|回覆|回复|內容|内容|台詞|台词|版本|答案)\s*(?:\*\*|】|\])?\s*[：:]?\s*$/,
    /(?:應該|应该|此刻要|現在要)(?:發送|发送|發出|发出|說|说|發|发)的(?:內容|内容|台詞|台词|訊息|消息)[^\n]{0,24}[：:]\s*$/,
    /^\s*(?:#{1,6}\s*|\*\*)?\s*(?:Final (?:output|answer|response|message)s?|Output)\s*(?:\*\*)?\s*[:：]?\s*$/i,
];

/** 整行用括號包起來的旁白式分析：（思考：…）【分析】[內心獨白] */
const BRACKETED_META_RE = /^\s*[（(【\[]\s*(思考|分析|推理|內心分析|心理分析|OOC|ooc|thinking|analysis|reasoning)[^）)】\]]*[）)】\]]\s*/;

/** 系統口吻：角色在台詞裡不會這樣說話 */
const SYSTEM_VOICE_RE = /(用戶|user\b|輪到我|本輪|作為角色|作為「|我的人設|角色設定|上下文|聊天記錄顯示|根據(聊天)?記錄|輸出格式|回覆策略|發言策略|群聊模擬)/i;
/** 「讓我看看現在的狀況」這一類開場 */
const SELF_CHECK_RE = /^(好的|好|嗯|OK|Okay)?[，,。.！!\s]*(讓我|我先|我來|先|首先)(看看|看一下|想想|想一下|分析|整理|理一下|回顧|確認|梳理|思考|判斷)(一下)?[^。\n]{0,20}(狀況|情況|上下文|聊天記錄|對話記錄|局勢|劇情|設定|人設|輪到|該怎麼|怎麼回|如何回)/;
const ENGLISH_META_RE = /^(#{1,6}\s*)?(Let me|I need to|I should|I'll (think|analy[sz]e|consider)|Okay,? (so|let)|Looking at (the|this)|Analy[sz]ing|First,? I|The user)/i;
/** 群聊台詞不會用 markdown 標題開頭：# Analyzing context… */
const MD_HEADING_RE = /^#{1,6}\s+\S/;
/** 粗體小標：**時間認知**：…、**Susu 的發言策略**（整行粗體的強調台詞如「**笑死**」不算） */
const BOLD_LABEL_RE = /^\*\*[^*\n]{1,30}\*\*\s*[：:]|^\*\*[^*\n]{0,24}(分析|策略|狀態|認知|計畫|計劃|目標|思路|判斷|動機|情緒|語氣|重點|規劃|背景|局勢)[^*\n]{0,8}\*\*\s*$/;
const SEPARATOR_RE = /^[-=*_]{3,}\s*$/;
/** 接在分析小標後面的清單項 */
const LIST_ITEM_RE = /^(\d+[.)、．]|[-*•・])\s*\S/;

const isMetaLine = (line: string): boolean => {
    const t = line.trim();
    if (!t) return false;
    return BRACKETED_META_RE.test(t) && t.replace(BRACKETED_META_RE, '').trim() === ''
        || MD_HEADING_RE.test(t)
        || BOLD_LABEL_RE.test(t)
        || SEPARATOR_RE.test(t)
        || SELF_CHECK_RE.test(t)
        || ENGLISH_META_RE.test(t)
        || SYSTEM_VOICE_RE.test(t);
};

export function stripLeakedReasoning(raw: string): { content: string; stripped: boolean } {
    const original = String(raw ?? '');
    let text = original.replace(CLOSED_BLOCK_RE, '');
    text = text.replace(LONE_CLOSE_RE, '');
    text = text.replace(UNCLOSED_OPEN_RE, '');

    // 有「最終發言／最終輸出」這種分界行：前面全是分析，只留最後一條分界之後的
    let lines = text.split('\n');
    let lastMarker = -1;
    lines.forEach((line, i) => { if (FINAL_MARKER_RES.some(re => re.test(line))) lastMarker = i; });
    if (lastMarker >= 0 && lines.slice(lastMarker + 1).some(l => l.trim())) lines = lines.slice(lastMarker + 1);

    // 開頭那幾行如果是分析，一路剝到第一句像台詞的為止（空行一起吃掉；分析小標底下的清單項也算）
    let start = 0;
    let inMeta = false;
    while (start < lines.length) {
        const line = lines[start];
        if (line.trim() === '') { start++; continue; }
        if (isMetaLine(line) || (inMeta && LIST_ITEM_RE.test(line.trim()))) { inMeta = true; start++; continue; }
        break;
    }
    // 開頭剝掉之後，句首還可能黏著一段括號分析：（思考：…）「台詞」
    const rest = lines.slice(start);
    if (rest.length) rest[0] = rest[0].replace(BRACKETED_META_RE, '');
    const content = rest.join('\n').trim();
    return { content, stripped: content !== original.trim() };
}

/**
 * 一整段外洩常被拆成好幾個氣泡、各自落庫（一行一則），逐則洗會漏掉「分析小標底下的清單」
 * 這種要看前後文才認得出的行。這裡把同一位成員連著發的一串（兩則間隔 < gapMs）併起來洗，
 * 回傳要丟掉的訊息 id。只處理純文字、單行的氣泡；其餘照舊由逐則清理負責。
 */
export function leakedBubbleIds<T extends { id: number; charId?: string; role: string; type?: string; content: unknown; timestamp: number }>(
    msgs: T[],
    gapMs: number = 2 * 60_000,
): Set<number> {
    const drop = new Set<number>();
    const isBubble = (m: T) => m.role === 'assistant' && (!m.type || m.type === 'text')
        && typeof m.content === 'string' && !m.content.includes('\n') && !!m.content.trim();
    let i = 0;
    while (i < msgs.length) {
        if (!isBubble(msgs[i])) { i++; continue; }
        let j = i + 1;
        while (j < msgs.length && isBubble(msgs[j]) && msgs[j].charId === msgs[i].charId
            && msgs[j].timestamp - msgs[j - 1].timestamp < gapMs) j++;
        const run = msgs.slice(i, j);
        if (run.length > 1) {
            const cleaned = stripLeakedReasoning(run.map(m => String(m.content)).join('\n')).content;
            const kept = cleaned ? cleaned.split('\n').map(l => l.trim()).filter(Boolean) : [];
            // 洗掉的都在前面：留下的是這一串的尾巴，其餘的都丟
            const tail = run.slice(run.length - kept.length);
            const tailMatches = kept.length <= run.length && tail.every((m, k) => String(m.content).trim() === kept[k]);
            if (tailMatches) run.slice(0, run.length - kept.length).forEach(m => drop.add(m.id));
        }
        i = j;
    }
    return drop;
}
