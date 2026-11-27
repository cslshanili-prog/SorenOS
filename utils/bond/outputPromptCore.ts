/**
 * 心意的生成提示詞（plans/bond-batch3.md 1.5、1.6）：角色答題、出題、AI 推薦題目、丟紙條、回紙條。
 * **零依賴**（只 import 型別）：本機和主動消息 2.0 的 worker（第 3d 批）用同一份，往這裡加 import 前先確認。
 *
 * 共通的規矩（紀要 3.7、3.8、4.2、4.3）：
 * - 照角色個性決定說多少，寡言可以很短，但不因為寡言就不說；
 * - 只寫真的發生過的事；人設裡的偏好不能變成兩人一起做過的事；重大心結要有設定或事件依據；
 * - 沒有新互動時回望舊片段、接續沒說完的話、從人設出發，不重述同一件事；
 * - 盲答：角色答題時看不到對方封存的答案（這份檔案的提示詞根本不收那個欄位）。
 */
import type { BondQuestionTopic } from '../../types';

export type OutputLength = 'short' | 'medium' | 'long';

export const LENGTH_HINT: Record<OutputLength, string> = {
    short: '短短的就好，一兩句到一小段',
    medium: '一段到兩段',
    long: '可以寫長一點，三四段',
};

/** 給模型看的「最近」：每日總結＋最近的私聊（呼叫端整理好） */
/** 篇幅那句：有填字數就寫字數，沒有照三檔的口語說法 */
const lengthText = (input: { length?: OutputLength; chars?: [number, number] }) =>
    input.chars ? `大約 ${input.chars[0]}～${input.chars[1]} 字（話少的話可以短一點）` : LENGTH_HINT[input.length || 'short'];
/** 文風那行（沒填就沒有） */
const styleLine = (input: { style?: string }) => (input.style?.trim() ? `- 文風：${input.style.trim()}（仍以你的個性優先）。
` : '');

/** 輸出上限照篇幅算（中文一字大約一到兩個 token，再留 JSON 和私聊那句的量） */
export const outputMaxTokens = (chars: [number, number] | undefined, floor = 1500): number =>
    Math.max(floor, Math.min(8000, chars ? Math.ceil(chars[1] * 2.2) + 600 : floor));

export interface OutputContext {
    selfName: string;
    otherName: string;
    /** 這條線最近的每日總結，一則一行 */
    recentSummaries?: string;
    /** 最近一段私聊（已經整理成文字） */
    recentChat?: string;
}

const GROUND_RULES = (c: OutputContext) => `- 口吻、篇幅照你的個性：話少就短，嘴硬就嘴硬，直接就直接；但不要因為個性就什麼都不說。
- 只依據真的發生過的事（下面的總結和聊天）；人設裡的喜好、想像不能當成你和${c.otherName}一起做過的事；不要編造沒發生過的對話或經歷。
- 沒有新的互動也沒關係：可以回望以前的片段、接著沒說完的話題、或從你自己的生活和個性出發；不要把同一件事換個說法再講一次。`;

const recentBlock = (c: OutputContext) => [
    c.recentSummaries ? `【最近發生的事（每日總結）】\n${c.recentSummaries}` : '',
    c.recentChat ? `【最近的聊天】\n${c.recentChat}` : '',
].filter(Boolean).join('\n\n') || '（最近沒有特別記下的事）';

export const TOPIC_HINT: Record<BondQuestionTopic, string> = {
    habit: '生活習慣', memory: '一起的回憶', choice: '二選一或假設題', relationship: '對彼此、對這段關係的想法', daily: '日常小事', custom: '不限',
};

/** 角色回答一題。只收題目和揭曉過的舊輪，**不收對方這一輪封存的答案**（盲答） */
export function buildCharAnswerPrompt(input: OutputContext & {
    question: string;
    /** 對方出的題（true）還是你自己出的（false，重答時） */
    askedByOther: boolean;
    /** 以前揭曉過的輪（舊到新） */
    earlierRounds?: Array<{ mine?: string; theirs?: string }>;
    length?: OutputLength;
    chars?: [number, number];
    style?: string;
}): string {
    const earlier = (input.earlierRounds || [])
        .map((r, i) => `第 ${i + 1} 次：你答「${r.mine || '（跳過）'}」；${input.otherName}答「${r.theirs || '（跳過）'}」`)
        .join('\n');
    return `你和${input.otherName}在玩「拾光問答」：雙方各自寫答案、封存，兩人都交出後才一起揭曉。${input.askedByOther ? `這題是${input.otherName}出的。` : '這題是你出的，現在是再答一次。'}

【題目】
${input.question}
${earlier ? `\n【以前揭曉過的回答】\n${earlier}\n（這次照你現在的想法答，可以跟以前不一樣）\n` : ''}
${recentBlock(input)}

請以「${input.selfName}」的身份回答。你看不到${input.otherName}這次的答案，也不要去猜對方會怎麼答。
${GROUND_RULES(input)}
- 篇幅：${lengthText(input)}。
${styleLine(input)}- 真的不想答可以跳過。

只輸出 JSON，不要其他文字：{"answer":"你的答案"} 或 {"skip":true}`;
}

/** 角色出一題給對方，同時交出並封存自己的答案 */
export function buildCharAskPrompt(input: OutputContext & {
    /** 以前問過的題目（避免重複） */
    askedBefore?: string[];
    /** 路線＋階段的一句話（例如「友情線，現在是好朋友」） */
    relationLine?: string;
    length?: OutputLength;
    chars?: [number, number];
    style?: string;
    withNotice?: boolean;
}): string {
    const asked = (input.askedBefore || []).slice(-15).map(q => `- ${q}`).join('\n');
    return `你和${input.otherName}在玩「拾光問答」：出題的人先寫答案並封存，對方答完才一起揭曉。現在換你出一題。
${input.relationLine ? `\n（你們的關係：${input.relationLine}）\n` : ''}
${recentBlock(input)}
${asked ? `\n【以前問過的（不要重複）】\n${asked}\n` : ''}
請以「${input.selfName}」的身份出一題，可以是最近的事讓你好奇的、想更了解對方的、或延續一個話題；可以很日常、很短，不用每次都是深入的關係測驗。
${GROUND_RULES(input)}
- 題目要對方答得出來，不要問對方不可能知道的事。
- 同時寫下你自己的答案（篇幅：${lengthText(input)}），這個答案會封存，對方答完才看得到。
${styleLine(input)}- topic 從這些挑一個：habit（生活習慣）、memory（回憶）、choice（二選一或假設題）、relationship（對彼此的想法）、daily（日常小事）。
${input.withNotice ? `- ${NOTICE_FIELD_HINT('出了一題問答給對方', input.otherName)}\n` : ''}
只輸出 JSON，不要其他文字：${input.withNotice ? '{"question":"題目","topic":"daily","answer":"你的答案","notice":"私聊那句"}' : '{"question":"題目","topic":"daily","answer":"你的答案"}'}`;
}

/**
 * 角色寫一個自己的願望（plans/bond-batch4.md 1.7，主動產出多一種）：照人設、最近的事；
 * 可以是自己想做的，也可以是想跟對方一起做的。寫了只是讓對方看見，不等於約好。
 */
export function buildCharWishPrompt(input: OutputContext & {
    /** 已經寫過的願望（雙方的；避免重複） */
    wishesBefore?: string[];
    relationLine?: string;
    length?: OutputLength;
    chars?: [number, number];
    style?: string;
    withNotice?: boolean;
}): string {
    const before = (input.wishesBefore || []).slice(-15).map(w => `- ${w}`).join('\n');
    return `你和${input.otherName}有一個放願望的地方：誰想做什麼、想要什麼，都可以寫下來讓對方看見。現在換你寫一個。
${input.relationLine ? `\n（你們的關係：${input.relationLine}）\n` : ''}
${recentBlock(input)}
${before ? `\n【已經寫過的願望（不要重複）】\n${before}\n` : ''}
請以「${input.selfName}」的身份寫一個你真的想做、想要、想體驗的事，可以從最近的事、你的個性、你平常在意的東西來。
${GROUND_RULES(input)}
- 可以是你自己的（owner 寫 self），也可以是想跟${input.otherName}一起做的（owner 寫 both）；照你們的關係，不是戀愛關係就不要寫曖昧的。
- 寫願望本身就好（篇幅：${lengthText(input)}），像一句寫在便條上的話；不要寫成要求、不要逼對方答應。寫下來不代表你們約好了。
${styleLine(input)}${input.withNotice ? `- ${NOTICE_FIELD_HINT('寫了一個願望', input.otherName)}\n` : ''}
只輸出 JSON，不要其他文字：${input.withNotice ? '{"wish":"願望","owner":"self","notice":"私聊那句"}' : '{"wish":"願望","owner":"self"}'}`;
}

/** AI 推薦題目（給你挑，選中才變成你出的題） */
export function buildQuestionSuggestPrompt(input: {
    userName: string;
    charName: string;
    relationLine?: string;
    recentSummaries?: string;
    askedBefore?: string[];
    count?: number;
}): string {
    const asked = (input.askedBefore || []).slice(-20).map(q => `- ${q}`).join('\n');
    return `幫${input.userName}想幾個可以問${input.charName}的「拾光問答」題目：兩人各自寫答案、封存，都交出後一起揭曉。
${input.relationLine ? `（他們的關係：${input.relationLine}）\n` : ''}${input.recentSummaries ? `\n【最近發生的事】\n${input.recentSummaries}\n` : ''}${asked ? `\n【以前問過的（不要重複）】\n${asked}\n` : ''}
要求：
- ${input.count || 5} 題，深淺混著：有日常小事、有習慣、有回憶、有二選一、有關於這段關係的；題目照他們的關係調整（不是戀愛關係就不要問曖昧的）。
- 每題一句話，雙方都答得出來；不要預設對方的答案。
- topic 從這些挑：habit、memory、choice、relationship、daily。

只輸出 JSON 陣列，不要其他文字：[{"question":"…","topic":"daily"}]`;
}

/** 角色丟一張紙條 */
export function buildSlipPrompt(input: OutputContext & {
    tags: string[];
    /** 最近的紙條（雙方、已投遞的），一則一行；避免重複 */
    recentSlips?: string;
    relationLine?: string;
    length?: OutputLength;
    chars?: [number, number];
    style?: string;
    withNotice?: boolean;
}): string {
    return `「心靈角落」是你和${input.otherName}之間丟紙條的地方：吐槽、掛念、想一起做的事、心結、開心的事，或當面沒說出口的話。丟進去才算說出口。
${input.relationLine ? `\n（你們的關係：${input.relationLine}）\n` : ''}
${recentBlock(input)}
${input.recentSlips ? `\n【最近的紙條】\n${input.recentSlips}\n` : ''}
請以「${input.selfName}」的身份寫一張紙條給${input.otherName}。不一定要剖白或說秘密，可以只補一句當時沒接上的話，或一句短短的吐槽。
例如話少的人可以寫：「上次你說沒人在意。我當時沒接話，不代表我同意。」
${GROUND_RULES(input)}
- 重大的心結、過去的傷要有設定或發生過的事當依據，不要為了寫而捏造。
- 篇幅：${lengthText(input)}。
${styleLine(input)}- 標籤從這些挑 1～2 個：${input.tags.join('、')}。
${input.withNotice ? `- ${NOTICE_FIELD_HINT('丟了一張紙條', input.otherName)}\n` : ''}
只輸出 JSON，不要其他文字：${input.withNotice ? '{"tags":["掛念"],"text":"紙條內容","notice":"私聊那句"}' : '{"tags":["掛念"],"text":"紙條內容"}'}`;
}

/** 角色回一張紙條（對方丟給你的，或回在一串裡） */
export function buildSlipReplyPrompt(input: OutputContext & {
    /** 被回的那張（誰丟的、內容、標籤） */
    slip: { fromName: string; text: string; tags: string[] };
    /** 這一串已經有的回應（舊到新） */
    thread?: Array<{ fromName: string; text: string }>;
    length?: OutputLength;
    chars?: [number, number];
    style?: string;
    /** 這張是對方丟給你的：可以順手標狀態（想再談／已回應／已說開） */
    canMarkState?: boolean;
    withNotice?: boolean;
}): string {
    const thread = (input.thread || []).map(t => `${t.fromName}：${t.text}`).join('\n');
    return `「心靈角落」是你和${input.otherName}之間丟紙條的地方。${input.slip.fromName === input.selfName ? '這是你自己丟的紙條，對方回了你。' : `${input.otherName}丟了一張紙條給你。`}

【紙條】（${input.slip.tags.join('、') || '沒有標籤'}）
${input.slip.fromName}：${input.slip.text}
${thread ? `\n【這一串的回應】\n${thread}\n` : ''}
${recentBlock(input)}

請以「${input.selfName}」的身份回一張紙條。照你的個性：可以認真回、可以嘴硬、可以只回一句；有回應不代表事情就解決了，不用硬把話說開。
${GROUND_RULES(input)}
- 篇幅：${lengthText(input)}。
${styleLine(input)}${input.canMarkState ? `- 你也可以替這張紙條標一個狀態（state）：want_to_talk（想再談）、responded（已回應）、resolved（已說開）；只有真的說開了才標 resolved，不想標就不要給這個欄位。\n` : ''}${input.withNotice ? `- ${NOTICE_FIELD_HINT('回了紙條', input.otherName)}\n` : ''}
只輸出 JSON，不要其他文字：{"text":"回應內容"${input.canMarkState ? ',"state":"responded"' : ''}${input.withNotice ? ',"notice":"私聊那句"' : ''}}`;
}

/** 主動產出開了「同步私聊」時，順手要一句私聊（照角色口吻提一下，不重複內容） */
export const NOTICE_FIELD_HINT = (what: string, otherName: string) =>
    `另外寫一句順手傳到私聊給${otherName}的話（notice）：照你的口吻提一下你${what}，像平常傳訊息那樣，不要把內容再講一遍。`;

/** 角色主動寫一篇日記（排程用；你請 TA 回／先寫走交換日記那條路） */
export function buildDiaryPrompt(input: OutputContext & {
    date: string;
    /** 你這天已經發布的那頁（有的話，TA 是回你） */
    userPage?: string;
    /** 最近幾本（雙方發布的頁），接著沒談完的事、不重述 */
    recentDiaries?: string;
    chars: [number, number];
    style?: string;
    withNotice?: boolean;
}): string {
    return `你和${input.otherName}有一本交換日記，雙方都能寫、寫給對方看。現在是 ${input.date}，請以「${input.selfName}」的身份寫你這一頁。
${input.userPage ? `\n【${input.otherName}這天寫的】\n${input.userPage}\n（你可以回應這篇，也可以只寫你自己的一天）\n` : ''}
${recentBlock(input)}
${input.recentDiaries ? `\n【最近的日記】\n${input.recentDiaries}\n` : ''}
${GROUND_RULES(input)}
- 日記是比較完整的表達、寫給${input.otherName}看的：可以接著上一篇沒談完的事，也可以分享你自己獨立於對方的生活（照你的人設和既有背景，不要憑空建立重大的共同經歷）。不用逐日重述。
- 篇幅大約 ${input.chars[0]}～${input.chars[1]} 字；話少可以短一點，但要像一篇日記。${input.style?.trim() ? `\n- 文風：${input.style.trim()}（仍以你的個性優先）。` : ''}
${input.withNotice ? `- ${NOTICE_FIELD_HINT('寫了日記', input.otherName)}\n` : ''}
只輸出 JSON，不要其他文字：${input.withNotice ? '{"text":"日記正文","notice":"私聊那句"}' : '{"text":"日記正文"}'}`;
}

/** 從回覆裡抓 JSON 物件（可以包在程式碼區塊裡）；抓不到回 null */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
    const s = String(raw || '').replace(/```(?:json)?/gi, '').trim();
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        const v = JSON.parse(s.slice(start, end + 1));
        return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function parseCharAnswer(raw: string): { answer: string } | { skip: true } | null {
    const o = parseJsonObject(raw);
    if (o) {
        if (o.skip === true) return { skip: true };
        const a = str(o.answer);
        return a ? { answer: a } : null;
    }
    const t = String(raw || '').trim().replace(/^["「『]|["」』]$/g, '').trim();
    return t ? { answer: t } : null;
}

const TOPICS: BondQuestionTopic[] = ['habit', 'memory', 'choice', 'relationship', 'daily', 'custom'];

export function parseCharAsk(raw: string): { question: string; topic: BondQuestionTopic; answer: string } | null {
    const o = parseJsonObject(raw);
    if (!o) return null;
    const question = str(o.question);
    const answer = str(o.answer);
    if (!question || !answer) return null;
    const topic = TOPICS.includes(o.topic as BondQuestionTopic) ? o.topic as BondQuestionTopic : 'custom';
    return { question, topic, answer };
}

export function parseSlip(raw: string, allowedTags: string[]): { text: string; tags: string[] } | null {
    const o = parseJsonObject(raw);
    if (!o) {
        const t = String(raw || '').trim().replace(/^["「『]|["」』]$/g, '').trim();
        return t ? { text: t, tags: [] } : null;
    }
    const text = str(o.text);
    if (!text) return null;
    const tags = (Array.isArray(o.tags) ? o.tags : []).map(str).filter(t => allowedTags.includes(t)).slice(0, 3);
    return { text, tags };
}

/** 抓 notice（同步私聊那句）；沒有就空字串 */
export function parseCharWish(raw: string): { wish: string; together: boolean } | null {
    const o = parseJsonObject(raw);
    const wish = str(o?.wish);
    if (!o || !wish) return null;
    return { wish: wish.slice(0, 200), together: str(o.owner) === 'both' };
}

/**
 * 角色寫一封信（plans/bond-batch5.md 第 3 節）：回信（帶這一串的全文）或主動寫一封（帶最近的信、這次為什麼提筆）。
 * 信比紙條長、比聊天慢：寫給對方一個人看的完整書信，照角色的口吻；不寫成聊天訊息、不用表情符號堆。
 */
export function buildCharLetterPrompt(input: OutputContext & {
    /** 回信：這一串（舊到新，含對方最後那封）；沒有＝主動寫 */
    thread?: Array<{ fromName: string; text: string; date?: string }>;
    /** 主動寫：你們最近的信（一封一行的摘要） */
    recentLetters?: string;
    /** 這次為什麼提筆（里程碑、紀念日、見面之後、很久沒說話）；沒有就是想寫 */
    occasion?: string;
    relationLine?: string;
    chars?: [number, number];
    style?: string;
}): string {
    const thread = (input.thread || []).map(t => `—— ${t.fromName}${t.date ? `（${t.date}）` : ''}：\n${t.text}`).join('\n\n');
    const replying = !!thread;
    return `${replying ? `${input.otherName}寫了一封信給你，你要回信。` : `你想寫一封信給${input.otherName}。`}信跟聊天不一樣：是寫給對方一個人看的、比較完整、比較慢的話，可以說平常聊天說不出口的、也可以只是近況。
${input.relationLine ? `\n（你們的關係：${input.relationLine}）\n` : ''}${input.occasion ? `\n【這次提筆的原因】${input.occasion}\n` : ''}
${replying ? `【這一串信（舊到新，最後一封是${input.otherName}剛寄來的）】\n${thread}\n` : input.recentLetters ? `【你們之前的信】\n${input.recentLetters}\n` : ''}
${recentBlock(input)}

請以「${input.selfName}」的身份寫${replying ? '回信' : '這封信'}：
${GROUND_RULES(input)}
- 篇幅：${input.chars ? `大約 ${input.chars[0]}～${input.chars[1]} 字` : '大約 300～800 字'}，照你的個性；話少的人寫信也可以短、可以笨拙，但要是你會寫的信。
- 寫成一封信：可以有稱呼、分段、近況、想說的話，結尾自然收住；不要寫成一則則聊天訊息，不要用顏文字、表情符號湊。${replying ? `\n- 回應${input.otherName}信裡真的寫到的事，不要只說謝謝。` : ''}
- 照你們的關係寫，不是戀愛關係就不要寫曖昧的話。
${styleLine(input)}- signature 是信末的署名（照你平常怎麼稱呼自己，可以只是名字）。
只輸出 JSON，不要其他文字：{"text":"信的正文（用 \\n 分段，不含署名）","signature":"署名"}`;
}

export function parseLetter(raw: string): { text: string; signature?: string } | null {
    const o = parseJsonObject(raw);
    if (o) {
        const t = str(o.text);
        if (!t) return null;
        const sig = str(o.signature).slice(0, 30);
        return { text: t.slice(0, 8000), ...(sig ? { signature: sig } : {}) };
    }
    const t = String(raw || '').trim();
    return t && !t.startsWith('{') ? { text: t.slice(0, 8000) } : null;
}

export function parseNotice(raw: string): string {
    const o = parseJsonObject(raw);
    return o ? str(o.notice).slice(0, 200) : '';
}

export function parseDiary(raw: string): { text: string } | null {
    const o = parseJsonObject(raw);
    if (o) { const t = str(o.text); return t ? { text: t } : null; }
    const t = String(raw || '').trim();
    return t && !t.startsWith('{') ? { text: t } : null;
}

const SLIP_STATES = ['want_to_talk', 'responded', 'resolved'] as const;
export function parseSlipReplyState(raw: string): typeof SLIP_STATES[number] | undefined {
    const o = parseJsonObject(raw);
    const v = o ? str(o.state) : '';
    return (SLIP_STATES as readonly string[]).includes(v) ? v as typeof SLIP_STATES[number] : undefined;
}

// ─── 約定（plans/bond-batch4.md 1.1、1.2、1.4）：對方的回應 ───
// 角色照人設回應，不預設答應：提示詞只給內容，不給「請答應」的暗示。

/** 對方寫了一個願望，問你怎麼想（支持不等於答應一起做） */
export function buildWishReplyPrompt(input: OutputContext & {
    wish: string;
    /** 'user'＝對方自己的願望、'both'＝對方想跟你一起完成的 */
    owner: 'user' | 'both';
    relationLine?: string;
}): string {
    return `${input.otherName}寫了一個願望給你看：
${input.relationLine ? `（你們的關係：${input.relationLine}）\n` : ''}
【願望】${input.owner === 'both' ? `（${input.otherName}想跟你一起完成的）` : `（${input.otherName}自己的）`}
${input.wish}
${recentBlock(input)}

請以「${input.selfName}」的身份照你真正的想法回應一句或一小段：
${GROUND_RULES(input)}
- 看見不等於答應。你可以支持（support：替對方加油、想幫忙，但不一定要一起做）、想一起做（together：你也想參與）、或只是說說你的看法（neutral：不支持也不反對、有保留、覺得不太可能都可以）。照你的個性和你們的關係選，不要為了討好而答應。
- 不要替雙方訂時間、做承諾；真的要一起做，之後會另外約好。

只輸出 JSON，不要其他文字：{"stance":"support","words":"你說的話"}`;
}

/** 對方提了一個約定，問你答不答應 */
export function buildPromiseReplyPrompt(input: OutputContext & {
    promise: string;
    repeatText: string;
    relationLine?: string;
    /** 這個約定是從哪個願望談來的 */
    fromWish?: string;
}): string {
    return `${input.otherName}想跟你約定一件事：
${input.relationLine ? `（你們的關係：${input.relationLine}）\n` : ''}
【約定】${input.promise}（${input.repeatText}）
${input.fromWish ? `（從這個願望談來的：${input.fromWish}）\n` : ''}${recentBlock(input)}

請以「${input.selfName}」的身份決定答不答應，並說一句或一小段你會說的話：
${GROUND_RULES(input)}
- 照你的個性、你們的關係和你自己的生活來決定：可以答應（yes）、想改一下（tweak：說你想怎麼改，例如頻率、時間、做法）、或先不要（no：說你的理由）。不要因為對方提了就一定答應，也不要為了顯得有個性而故意拒絕。
- 答應了就是你們說好的事，之後你會記得、會做到；做不到的就別答應。

只輸出 JSON，不要其他文字：{"answer":"yes","words":"你說的話"}`;
}

/** 對方覺得你們之間有一個默契，問你認不認 */
export function buildHabitReplyPrompt(input: OutputContext & {
    habit: string;
    relationLine?: string;
}): string {
    return `${input.otherName}覺得你們之間有一個默契：
${input.relationLine ? `（你們的關係：${input.relationLine}）\n` : ''}
【默契】${input.habit}
${recentBlock(input)}

請以「${input.selfName}」的身份說你認不認，並說一句你會說的話：
${GROUND_RULES(input)}
- 默契是雙方真的說好、或真的反覆這樣做過的小習慣。照下面的總結和聊天判斷：你們真的有這樣（yes），或你不覺得、記不得有這回事（no）；可以嘴硬地認、也可以笑著否認。
- 不要為了讓對方開心而承認沒發生過的事。

只輸出 JSON，不要其他文字：{"answer":"yes","words":"你說的話"}`;
}

const WISH_STANCES = ['support', 'together', 'neutral'] as const;
export function parseWishReply(raw: string): { stance: typeof WISH_STANCES[number]; words: string } | null {
    const o = parseJsonObject(raw);
    if (!o) return null;
    const words = str(o.words);
    if (!words) return null;
    const stance = (WISH_STANCES as readonly string[]).includes(str(o.stance)) ? str(o.stance) as typeof WISH_STANCES[number] : 'neutral';
    return { stance, words };
}

export function parsePromiseReply(raw: string): { answer: 'yes' | 'tweak' | 'no'; words: string } | null {
    const o = parseJsonObject(raw);
    if (!o) return null;
    const words = str(o.words);
    const a = str(o.answer);
    if (!words || !['yes', 'tweak', 'no'].includes(a)) return null;
    return { answer: a as 'yes' | 'tweak' | 'no', words };
}

export function parseHabitReply(raw: string): { answer: 'yes' | 'no'; words: string } | null {
    const o = parseJsonObject(raw);
    if (!o) return null;
    const words = str(o.words);
    const a = str(o.answer);
    if (!words || !['yes', 'no'].includes(a)) return null;
    return { answer: a as 'yes' | 'no', words };
}
