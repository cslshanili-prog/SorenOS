/**
 * 從聊天收存片刻（plans/bond-batch2.md 3.1）、從最近的聊天挑幾件（3.2）。純邏輯，有測試。
 *
 * - 私聊：lineId 是 lineKey（主線＝charId，其他線 charId::personaKey），讀訊息用 lineArgFromKey 拆回來。
 * - 見面：同一條私聊線的訊息、metadata.dateStoryId 是這場故事。
 * - 角色私聊：lineId 是 pair~A~B，說話的人看 metadata（utils/pairLine.ts 的 pairSpeakerOf）。
 * - 摘要、挑選只寫「發生了什麼」，不加感想、不補沒發生的事（紀要 4.2）。
 */
import type { BondEventDate, ChatLine, Message } from '../../types';

/** 從聊天裡按「收存到羈絆」帶到羈絆 App 的內容 */
export interface BondCollectRequest {
    kind: 'chat' | 'date' | 'pair';
    bondId: string;
    /** chat／date：lineKey；pair：pair~A~B */
    lineId: string;
    /** chat／date：角色；pair：其中一位 */
    charId: string;
    storyId?: string;
    messageIds: number[];
}

export function lineArgFromKey(lineId: string): string | ChatLine {
    const at = lineId.indexOf('::');
    if (at < 0) return lineId;
    return { charId: lineId.slice(0, at), personaKey: lineId.slice(at + 2) };
}

const TYPE_LABEL: Partial<Record<Message['type'], string>> = {
    image: '[圖片]', emoji: '[表情]', voice: '[語音]', transfer: '[轉帳]', mall_order: '[購物]',
};

/** 一則訊息的文字：雙語只取原文、拿掉標籤；非文字照類型寫一個標記 */
export function messagePlainText(m: Pick<Message, 'type' | 'content' | 'metadata'>): string {
    if (m.type !== 'text') {
        const label = TYPE_LABEL[m.type];
        if (label) return label;
        const s = String(m.content || '').replace(/\s+/g, ' ').trim();
        return s ? s.slice(0, 80) : `[${m.type}]`;
    }
    const raw = String(m.content || '').split('%%BILINGUAL%%')[0];
    return raw.replace(/\[\[[^\]]*\]\]/g, '').replace(/<\/?[a-zA-Z][^>]*>/g, '').replace(/\s+\n/g, '\n').trim();
}

/** 收存的原文快照：「名字：內容」一則一行，太長就截 */
export function buildCollectSnippet(
    msgs: Array<Pick<Message, 'type' | 'content' | 'metadata' | 'role' | 'charId'>>,
    nameOf: (m: Pick<Message, 'role' | 'charId' | 'metadata'>) => string,
    maxChars = 800,
    textOf: (m: Pick<Message, 'type' | 'content' | 'metadata' | 'role'>) => string = messagePlainText,
): string {
    const lines = msgs.map(m => `${nameOf(m)}：${textOf(m)}`).filter(l => !l.endsWith('：'));
    let out = '';
    for (const l of lines) {
        if (out.length + l.length + 1 > maxChars) { out += out ? '\n…' : `${l.slice(0, maxChars)}…`; break; }
        out += (out ? '\n' : '') + l;
    }
    return out;
}

/** 選到的那幾則照 id 排好（Soren 的訊息照 id 排，不照時間） */
export function sortById<T extends { id: number }>(msgs: T[]): T[] {
    return [...msgs].sort((a, b) => a.id - b.id);
}

/**
 * 往前、往後多帶幾則：在整條線（已照 id 排好、已篩過這場見面）裡找選到的頭尾，各延伸 before／after 則。
 * 回傳延伸後的 id 清單（照順序）。
 */
export function extendSelection(all: Array<{ id: number }>, selected: number[], before: number, after: number): number[] {
    if (!selected.length) return [];
    const set = new Set(selected);
    const idx = all.map((m, i) => (set.has(m.id) ? i : -1)).filter(i => i >= 0);
    if (!idx.length) return [...selected].sort((a, b) => a - b);
    const from = Math.max(0, idx[0] - Math.max(0, before));
    const to = Math.min(all.length - 1, idx[idx.length - 1] + Math.max(0, after));
    const extra = all.slice(from, to + 1).map(m => m.id);
    return [...new Set([...extra, ...selected])].sort((a, b) => a - b);
}

/** 預設的事件日期：選到的第一則那天（呼叫端先把時間戳換成故事時間的日期 key） */
export function defaultEventDate(dateKeys: string[]): BondEventDate {
    const key = dateKeys.find(k => /^\d{4}-\d{2}-\d{2}$/.test(k));
    return key ? { precision: 'day', date: key } : { precision: 'unknown' };
}

// ── AI：一兩句摘要 ──

export function buildMomentSummaryPrompt(args: { snippet: string; leftName: string; rightName: string }): string {
    return [
        `下面是 ${args.leftName} 和 ${args.rightName} 的一段對話。把這段「發生了什麼」濃縮成一到兩句，第三人稱、用名字稱呼兩人。`,
        '只寫實際發生的事和說過的話，不加感想、不評價、不猜心情、不補對話裡沒有的事。',
        '直接輸出那一兩句，不要引號、不要前言。',
        '',
        '【對話】',
        args.snippet,
    ].join('\n');
}

export function cleanSummary(text: string): string {
    return String(text || '').trim().replace(/^["「『]|["」』]$/g, '').replace(/^(摘要|總結)[:：]\s*/, '').trim();
}

// ── AI：從最近的聊天挑幾件 ──

export interface MomentCandidate {
    title: string;
    text: string;
    /** 對應到哪幾則訊息（給 AI 的編號是 1 起算的序號，這裡已換回訊息 id） */
    messageIds: number[];
    /** 收成什麼（第 4 批；沒寫就是片刻） */
    kind?: PickKind;
    /** 願望：誰的（說出口的那方） */
    owner?: 'user' | 'char' | 'both';
    /** 約定：頻率原文 */
    freq?: string;
    /** 禮物（第 5 批）：誰送誰（out＝左邊送右邊）、場合 */
    dir?: 'out' | 'in';
    occasion?: string;
    /** 禮物後續：圖鑑裡那件的 key（給 AI 的是 G 編號，這裡已換回） */
    giftKey?: string;
}

/** 收存頁能收成的幾種（第 4 批：願望、約定、默契只在身份卡 × 角色；第 5 批多禮物） */
export type CollectKind = 'moment' | 'wish' | 'promise' | 'habit' | 'gift';
/** 挑幾件能挑出來的：收存頁那幾種，再加「禮物後續」（說到圖鑑裡已經有的那件） */
export type PickKind = CollectKind | 'giftFollowup';

/** 挑幾件時給 AI 對的圖鑑：每件一個 G 編號 */
export interface PickGiftRef {
    key: string;
    title: string;
    dir: 'out' | 'in';
}

/** 給 AI 看的清單：每則一行「#序號 名字：內容」 */
export function numberedTranscript(
    msgs: Array<Pick<Message, 'id' | 'type' | 'content' | 'metadata' | 'role' | 'charId'>>,
    nameOf: (m: Pick<Message, 'role' | 'charId' | 'metadata'>) => string,
    maxCharsPerLine = 240,
    textOf: (m: Pick<Message, 'type' | 'content' | 'metadata' | 'role'>) => string = messagePlainText,
): string {
    return msgs.map((m, i) => {
        const t = textOf(m);
        return `#${i + 1} ${nameOf(m)}：${t.length > maxCharsPerLine ? `${t.slice(0, maxCharsPerLine)}…` : t}`;
    }).join('\n');
}

export function buildMomentPickPrompt(args: { transcript: string; leftName: string; rightName: string; count?: number; withPact?: boolean; gifts?: PickGiftRef[] }): string {
    const n = args.count || 5;
    if (args.withPact) return buildPickWithPactPrompt({ ...args, count: n });
    return [
        `下面是 ${args.leftName} 和 ${args.rightName} 最近的對話，每則前面有編號。`,
        `從裡面挑出最多 ${n} 件值得留下來的小事——一句好笑的話、一個約定、一次撒嬌或吵架和好、一個第一次……不一定要是大事。`,
        '每件寫：一個短標題（十個字內）、一兩句發生了什麼（第三人稱、只寫事實，不加感想、不補沒發生的事）、對應的訊息編號。',
        '沒有值得留的就回空陣列。',
        '只輸出 JSON 陣列：[{"title":"…","text":"…","refs":[3,4]}]',
        '',
        '【對話】',
        args.transcript,
    ].join('\n');
}

/** 身份卡 × 角色：除了片刻，也挑願望、約定、默契（plans/bond-batch4.md 4e）；你勾了才存 */
function buildPickWithPactPrompt(args: { transcript: string; leftName: string; rightName: string; count: number; gifts?: PickGiftRef[] }): string {
    const { leftName: L, rightName: R } = args;
    const gifts = (args.gifts || []).slice(0, PICK_GIFT_LIMIT);
    return [
        `下面是 ${L} 和 ${R} 最近的對話，每則前面有編號。`,
        `從裡面挑出最多 ${args.count} 件值得留下來的事，每件標一種：`,
        `- moment：一件小事——一句好笑的話、一次撒嬌或吵架和好、一個第一次……`,
        `- wish：有人說出口想做的事、想要的東西（還沒說好一起做）；owner 寫說出口的那方：user＝${L}、char＝${R}、both＝兩人都說想`,
        `- promise：兩人說好要做的事（一次或固定做的）；freq 寫「一次」「每天」「每週」「每週三」「每月」「每 3 天」「每年」其中一種`,
        `- habit：兩人之間不用說也會這樣的習慣（例如誰先說晚安），要對話裡真的看得出來`,
        `- gift：一份真的送出或收到的禮物（自己做的、路上買的、寄來的…，對話裡講到購物中心訂單的不算）；dir 寫 out＝${L}送給${R}、in＝${R}送給${L}；title 寫那樣東西；occasion 寫場合（生日、紀念日、道歉、想到你…，看不出來留空）`,
        ...(gifts.length ? [
            `- gift_followup：說到下面清單裡某一件已經送過的禮物後來怎麼了（戴著、用壞了、收進抽屜…）；gift 寫那件的編號，text 寫一句後來怎麼了`,
            '清單裡已經有的禮物不要再挑成 gift；只是說到它就挑成 gift_followup。',
        ] : []),
        '每件寫：一個短標題（十個字內）、一兩句內容（片刻寫發生了什麼；願望、約定、默契直接寫那件事本身；禮物寫誰送了什麼）、對應的訊息編號。只寫對話裡有的，不補沒發生的事；看不出來的欄位留空。',
        '沒有值得留的就回空陣列。',
        '只輸出 JSON 陣列：[{"kind":"moment","title":"…","text":"…","refs":[3,4]},{"kind":"promise","title":"…","text":"…","freq":"每天","refs":[7]},{"kind":"gift","dir":"in","title":"圍巾","occasion":"","text":"…","refs":[9]}]',
        ...(gifts.length ? [
            '',
            '【已經在圖鑑裡的禮物】',
            ...gifts.map((g, i) => `G${i + 1} ${g.dir === 'out' ? `${L}送給${R}` : `${R}送給${L}`}：${g.title}`),
        ] : []),
        '',
        '【對話】',
        args.transcript,
    ].join('\n');
}

/** 挑幾件給 AI 對的圖鑑最多幾件（最近的先） */
export const PICK_GIFT_LIMIT = 20;
const COLLECT_KINDS: CollectKind[] = ['moment', 'wish', 'promise', 'habit', 'gift'];
const asDir = (v: unknown): 'out' | 'in' | undefined => (v === 'out' || v === 'in' ? v : undefined);
const asOwner = (v: unknown): MomentCandidate['owner'] => (v === 'user' || v === 'char' || v === 'both' ? v : undefined);

/** 解析挑選結果；編號換回訊息 id，對不上的丟掉；禮物後續的 G 編號換回圖鑑的 key，對不上就整件丟掉 */
export function parseMomentPick(raw: string, msgs: Array<{ id: number }>, gifts: PickGiftRef[] = []): MomentCandidate[] {
    const s = String(raw || '');
    const start = s.indexOf('[');
    const end = s.lastIndexOf(']');
    if (start < 0 || end <= start) return [];
    let arr: unknown;
    try { arr = JSON.parse(s.slice(start, end + 1)); } catch { return []; }
    if (!Array.isArray(arr)) return [];
    const out: MomentCandidate[] = [];
    for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        const o = item as Record<string, unknown>;
        const text = String(o.text || '').trim();
        if (!text) continue;
        const refs = Array.isArray(o.refs) ? o.refs : [];
        const ids = refs.map(r => Number(r)).filter(n => Number.isInteger(n) && n >= 1 && n <= msgs.length).map(n => msgs[n - 1].id);
        const cand: MomentCandidate = { title: String(o.title || '').trim().slice(0, 30), text, messageIds: [...new Set(ids)].sort((a, b) => a - b) };
        if (o.kind === 'gift_followup' || o.kind === 'giftFollowup') {
            const m = /^G?(\d+)$/i.exec(String(o.gift ?? '').trim());
            const ref = m ? gifts.slice(0, PICK_GIFT_LIMIT)[Number(m[1]) - 1] : undefined;
            if (!ref) continue;
            out.push({ ...cand, kind: 'giftFollowup', giftKey: ref.key, dir: ref.dir, title: cand.title || ref.title });
            continue;
        }
        const kind = COLLECT_KINDS.includes(o.kind as CollectKind) ? o.kind as CollectKind : undefined;
        if (kind === 'gift') {
            const dir = asDir(o.dir);
            const occasion = typeof o.occasion === 'string' ? o.occasion.trim().slice(0, 20) : '';
            out.push({ ...cand, kind: 'gift', ...(dir ? { dir } : {}), ...(occasion ? { occasion } : {}) });
            continue;
        }
        if (kind && kind !== 'moment') {
            cand.kind = kind;
            if (kind === 'wish') { const owner = asOwner(o.owner); if (owner) cand.owner = owner; }
            if (kind === 'promise' && typeof o.freq === 'string' && o.freq.trim()) cand.freq = o.freq.trim();
        }
        out.push(cand);
    }
    return out;
}

/** 這條線還沒被挑過的訊息：id 大於上次掃到的那則，取最近 limit 則 */
export function unscannedMessages<T extends { id: number }>(msgs: T[], lastScanId: number | undefined, limit = 120): T[] {
    const fresh = sortById(msgs).filter(m => !lastScanId || m.id > lastScanId);
    return fresh.slice(-limit);
}

// ── AI：收成願望、約定、默契時幫忙填欄位（plans/bond-batch4.md 4e） ──

export function buildPactFillPrompt(args: { kind: Exclude<CollectKind, 'moment' | 'gift'>; snippet: string; leftName: string; rightName: string }): string {
    const { leftName: L, rightName: R } = args;
    const ask = args.kind === 'wish'
        ? [`這段對話裡有人說出想做的事或想要的東西。寫出那個願望本身（一句，像「想一起去看極光」），再判斷是誰說出口的：user＝${L}、char＝${R}、both＝兩人都說想。`,
            '只輸出 JSON：{"text":"…","owner":"user"}']
        : args.kind === 'promise'
        ? ['這段對話裡兩人說好了一件事。寫出約定的內容（一句，像「每天睡前互道晚安」），再寫頻率：「一次」「每天」「每週」「每週三」「每月」「每 3 天」「每年」其中一種。',
            '只輸出 JSON：{"text":"…","freq":"每天"}']
        : ['這段對話裡看得出兩人之間一個不用說也會這樣的習慣。寫出那個默契（一句，像「吵架後總是他先傳貼圖」）。',
            '只輸出 JSON：{"text":"…"}'];
    return [
        `下面是 ${L} 和 ${R} 的一段對話。`,
        ask[0],
        '只照這段對話寫，看不出來的欄位留空字串，不要補對話裡沒有的事。',
        ask[1],
        '',
        '【對話】',
        args.snippet,
    ].join('\n');
}

export function parsePactFill(raw: string): { text: string; owner?: 'user' | 'char' | 'both'; freq?: string } | null {
    const s = String(raw || '');
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        const o = JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>;
        const text = String(o.text || '').trim().replace(/^["「『]|["」』]$/g, '');
        const owner = asOwner(o.owner);
        const freq = typeof o.freq === 'string' && o.freq.trim() ? o.freq.trim() : undefined;
        if (!text && !owner && !freq) return null;
        return { text, ...(owner ? { owner } : {}), ...(freq ? { freq } : {}) };
    } catch {
        return null;
    }
}

// ── AI：收成禮物時幫忙填（plans/bond-batch5.md 第 6 節） ──

export interface GiftFill { title: string; dir?: 'out' | 'in'; occasion?: string; text: string }

export function buildGiftFillPrompt(args: { snippet: string; leftName: string; rightName: string }): string {
    const { leftName: L, rightName: R } = args;
    return [
        `下面是 ${L} 和 ${R} 的一段對話，裡面說到一份禮物。`,
        `寫出：title＝那樣東西（幾個字，像「手織圍巾」）；dir＝誰送誰（out＝${L}送給${R}、in＝${R}送給${L}）；occasion＝場合（生日、紀念日、節日、道歉、辛苦了、想到你、沒有理由，或對話裡講的別的場合）；text＝一兩句發生了什麼（第三人稱、用名字，只寫事實）。`,
        '只照這段對話寫，看不出來的欄位留空字串，不要補對話裡沒有的事。',
        '只輸出 JSON：{"title":"…","dir":"in","occasion":"…","text":"…"}',
        '',
        '【對話】',
        args.snippet,
    ].join('\n');
}

export function parseGiftFill(raw: string): GiftFill | null {
    const s = String(raw || '');
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        const o = JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>;
        const clean = (v: unknown) => String(v ?? '').trim().replace(/^["「『]|["」』]$/g, '');
        const title = clean(o.title).slice(0, 40);
        const text = clean(o.text);
        const occasion = clean(o.occasion).slice(0, 20);
        const dir = asDir(o.dir);
        if (!title && !text && !dir && !occasion) return null;
        return { title, text, ...(dir ? { dir } : {}), ...(occasion ? { occasion } : {}) };
    } catch {
        return null;
    }
}
