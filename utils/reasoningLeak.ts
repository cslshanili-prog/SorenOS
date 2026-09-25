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
 * 寧可保守：只剝有標籤的區塊，和「開頭」那幾行明顯是系統口吻的分析（提到「用戶」「輪到我」
 * 「上下文」「人設」、或「讓我看看現在的狀況」這類）。台詞中間的句子不動。
 */

const TAGS = 'think|thinking|thought|thoughts|reasoning|analysis|inner_thoughts';
const CLOSED_BLOCK_RE = new RegExp(`<(${TAGS})>[\\s\\S]*?<\\/\\1>`, 'gi');
const UNCLOSED_OPEN_RE = new RegExp(`<(?:${TAGS})>[\\s\\S]*$`, 'i');
/** 只剩一個結束標籤（開頭那半被截掉或模型沒寫）：標籤之前的都是思考 */
const LONE_CLOSE_RE = new RegExp(`^[\\s\\S]*?<\\/(?:${TAGS})>`, 'i');

/** 整行用括號包起來的旁白式分析：（思考：…）【分析】[內心獨白] */
const BRACKETED_META_RE = /^\s*[（(【\[]\s*(思考|分析|推理|內心分析|心理分析|OOC|ooc|thinking|analysis|reasoning)[^）)】\]]*[）)】\]]\s*/;

/** 系統口吻：角色在台詞裡不會這樣說話 */
const SYSTEM_VOICE_RE = /(用戶|user\b|輪到我|本輪|作為角色|作為「|我的人設|角色設定|上下文|聊天記錄顯示|根據(聊天)?記錄|輸出格式|回覆策略|群聊模擬)/i;
/** 「讓我看看現在的狀況」這一類開場 */
const SELF_CHECK_RE = /^(好的|好|嗯|OK|Okay)?[，,。.！!\s]*(讓我|我先|我來|先|首先)(看看|看一下|想想|想一下|分析|整理|理一下|回顧|確認|梳理|思考|判斷)(一下)?[^。\n]{0,20}(狀況|情況|上下文|聊天記錄|對話記錄|局勢|劇情|設定|人設|輪到|該怎麼|怎麼回|如何回)/;
const ENGLISH_META_RE = /^(Let me|I need to|I should|I'll (think|analy[sz]e|consider)|Okay,? (so|let)|Looking at (the|this)|Analy[sz]ing|First,? I|The user)/i;
/** 模型愛加的分析小標題 */
const HEADING_META_RE = /^\s*(#{1,6}\s*|\*\*)\s*(思考|分析|推理|思路|Thinking|Analysis|Reasoning)/i;

const isMetaLine = (line: string): boolean => {
    const t = line.trim();
    if (!t) return false;
    return BRACKETED_META_RE.test(t) && t.replace(BRACKETED_META_RE, '').trim() === ''
        || HEADING_META_RE.test(t)
        || SELF_CHECK_RE.test(t)
        || ENGLISH_META_RE.test(t)
        || SYSTEM_VOICE_RE.test(t);
};

export function stripLeakedReasoning(raw: string): { content: string; stripped: boolean } {
    const original = String(raw ?? '');
    let text = original.replace(CLOSED_BLOCK_RE, '');
    text = text.replace(LONE_CLOSE_RE, '');
    text = text.replace(UNCLOSED_OPEN_RE, '');

    // 開頭那幾行如果是分析，一路剝到第一句像台詞的為止（空行一起吃掉）
    const lines = text.split('\n');
    let start = 0;
    while (start < lines.length && (lines[start].trim() === '' || isMetaLine(lines[start]))) start++;
    // 開頭剝掉之後，句首還可能黏著一段括號分析：（思考：…）「台詞」
    const rest = lines.slice(start);
    if (rest.length) rest[0] = rest[0].replace(BRACKETED_META_RE, '');
    const content = rest.join('\n').trim();
    return { content, stripped: content !== original.trim() };
}
