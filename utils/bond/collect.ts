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

export function buildMomentPickPrompt(args: { transcript: string; leftName: string; rightName: string; count?: number }): string {
    const n = args.count || 5;
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

/** 解析挑選結果；編號換回訊息 id，對不上的丟掉 */
export function parseMomentPick(raw: string, msgs: Array<{ id: number }>): MomentCandidate[] {
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
        out.push({ title: String(o.title || '').trim().slice(0, 30), text, messageIds: [...new Set(ids)].sort((a, b) => a - b) });
    }
    return out;
}

/** 這條線還沒被挑過的訊息：id 大於上次掃到的那則，取最近 limit 則 */
export function unscannedMessages<T extends { id: number }>(msgs: T[], lastScanId: number | undefined, limit = 120): T[] {
    const fresh = sortById(msgs).filter(m => !lastScanId || m.id > lastScanId);
    return fresh.slice(-limit);
}
