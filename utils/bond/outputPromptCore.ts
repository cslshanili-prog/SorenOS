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
- 篇幅：${LENGTH_HINT[input.length || 'short']}。
- 真的不想答可以跳過。

只輸出 JSON，不要其他文字：{"answer":"你的答案"} 或 {"skip":true}`;
}

/** 角色出一題給對方，同時交出並封存自己的答案 */
export function buildCharAskPrompt(input: OutputContext & {
    /** 以前問過的題目（避免重複） */
    askedBefore?: string[];
    /** 路線＋階段的一句話（例如「友情線，現在是好朋友」） */
    relationLine?: string;
    length?: OutputLength;
}): string {
    const asked = (input.askedBefore || []).slice(-15).map(q => `- ${q}`).join('\n');
    return `你和${input.otherName}在玩「拾光問答」：出題的人先寫答案並封存，對方答完才一起揭曉。現在換你出一題。
${input.relationLine ? `\n（你們的關係：${input.relationLine}）\n` : ''}
${recentBlock(input)}
${asked ? `\n【以前問過的（不要重複）】\n${asked}\n` : ''}
請以「${input.selfName}」的身份出一題，可以是最近的事讓你好奇的、想更了解對方的、或延續一個話題；可以很日常、很短，不用每次都是深入的關係測驗。
${GROUND_RULES(input)}
- 題目要對方答得出來，不要問對方不可能知道的事。
- 同時寫下你自己的答案（篇幅：${LENGTH_HINT[input.length || 'short']}），這個答案會封存，對方答完才看得到。
- topic 從這些挑一個：habit（生活習慣）、memory（回憶）、choice（二選一或假設題）、relationship（對彼此的想法）、daily（日常小事）。

只輸出 JSON，不要其他文字：{"question":"題目","topic":"daily","answer":"你的答案"}`;
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
}): string {
    return `「心靈角落」是你和${input.otherName}之間丟紙條的地方：吐槽、掛念、想一起做的事、心結、開心的事，或當面沒說出口的話。丟進去才算說出口。
${input.relationLine ? `\n（你們的關係：${input.relationLine}）\n` : ''}
${recentBlock(input)}
${input.recentSlips ? `\n【最近的紙條】\n${input.recentSlips}\n` : ''}
請以「${input.selfName}」的身份寫一張紙條給${input.otherName}。不一定要剖白或說秘密，可以只補一句當時沒接上的話，或一句短短的吐槽。
例如話少的人可以寫：「上次你說沒人在意。我當時沒接話，不代表我同意。」
${GROUND_RULES(input)}
- 重大的心結、過去的傷要有設定或發生過的事當依據，不要為了寫而捏造。
- 篇幅：${LENGTH_HINT[input.length || 'short']}。
- 標籤從這些挑 1～2 個：${input.tags.join('、')}。

只輸出 JSON，不要其他文字：{"tags":["掛念"],"text":"紙條內容"}`;
}

/** 角色回一張紙條（對方丟給你的，或回在一串裡） */
export function buildSlipReplyPrompt(input: OutputContext & {
    /** 被回的那張（誰丟的、內容、標籤） */
    slip: { fromName: string; text: string; tags: string[] };
    /** 這一串已經有的回應（舊到新） */
    thread?: Array<{ fromName: string; text: string }>;
    length?: OutputLength;
}): string {
    const thread = (input.thread || []).map(t => `${t.fromName}：${t.text}`).join('\n');
    return `「心靈角落」是你和${input.otherName}之間丟紙條的地方。${input.slip.fromName === input.selfName ? '這是你自己丟的紙條，對方回了你。' : `${input.otherName}丟了一張紙條給你。`}

【紙條】（${input.slip.tags.join('、') || '沒有標籤'}）
${input.slip.fromName}：${input.slip.text}
${thread ? `\n【這一串的回應】\n${thread}\n` : ''}
${recentBlock(input)}

請以「${input.selfName}」的身份回一張紙條。照你的個性：可以認真回、可以嘴硬、可以只回一句；有回應不代表事情就解決了，不用硬把話說開。
${GROUND_RULES(input)}
- 篇幅：${LENGTH_HINT[input.length || 'short']}。

只輸出 JSON，不要其他文字：{"text":"回應內容"}`;
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
