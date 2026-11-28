/**
 * 拾光片段（plans/bond-moments-v2.md）：從這條線真的發生過的對話生成的時間線。純邏輯，有測試。
 *
 * - 來源只有這條線的私聊、見面（角色之間是他們的私聊），不讀記憶。
 * - 一則片段＝一個時刻：tag、TA 的一兩句心裡話、照抄的一句原話（點了跳回那則）。
 * - 一天一天寫：照故事日期分組；寫過哪幾天記在 bonds.fragmentDays。
 */
import type { BondEntry, BondEventDate, BondFragment, BondRoute, BondSource, Message } from '../../types';
import { messagePlainText } from './collect';
import { newBondEntryId } from './ids';
import { parseJsonObject } from './outputPromptCore';

// ─── tag ─────────────────────────────────────────

const COMMON_TAGS = ['日常', '爭執', '和好', '里程碑', '約定', '禮物', '低潮', '驚喜'];

/** 每條路線 AI 可以挑的 tag（照這個順序顯示）；你手動改的不限 */
export const FRAGMENT_TAGS: Record<BondRoute | 'none', string[]> = {
    romance: ['日常', '心動', '曖昧', '約會', ...COMMON_TAGS.slice(1)],
    friendship: ['日常', '出遊', '並肩', ...COMMON_TAGS.slice(1)],
    family: ['日常', '團聚', '關心', ...COMMON_TAGS.slice(1)],
    none: ['日常', '見面', ...COMMON_TAGS.slice(1)],
};

export const fragmentTagsFor = (route: BondRoute | undefined): string[] => FRAGMENT_TAGS[route || 'none'];

export type FragmentTone = 'cherry' | 'cranberry' | 'mauve' | 'blush';

/** tag 的顏色：大事深、甜的偏紅、難受的灰紫、日常淡 */
export function tagTone(tag: string | undefined): FragmentTone {
    const t = String(tag || '');
    if (t === '里程碑') return 'cherry';
    if (['心動', '曖昧', '約會', '禮物', '驚喜', '團聚', '出遊'].includes(t)) return 'cranberry';
    if (['爭執', '低潮'].includes(t)) return 'mauve';
    return 'blush';
}

// ─── 分天 ─────────────────────────────────────────

export interface FragmentDay<T> {
    dayKey: string;
    messages: T[];
}

/** 照故事日期分組，天從舊到新，每天的訊息照 id */
export function groupByDay<T extends { id: number; timestamp: number }>(msgs: T[], toKey: (ts: number) => string): FragmentDay<T>[] {
    const map = new Map<string, T[]>();
    for (const m of [...msgs].sort((a, b) => a.id - b.id)) {
        const k = toKey(m.timestamp);
        const list = map.get(k);
        if (list) list.push(m); else map.set(k, [m]);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([dayKey, messages]) => ({ dayKey, messages }));
}

/** 一次交給 AI 的上限；一天聊太多就分段寫（每段各挑） */
export const FRAGMENT_PART_LIMIT = 240;

export function splitParts<T>(msgs: T[], limit = FRAGMENT_PART_LIMIT): T[][] {
    if (msgs.length <= limit) return msgs.length ? [msgs] : [];
    const parts: T[][] = [];
    for (let i = 0; i < msgs.length; i += limit) parts.push(msgs.slice(i, i + limit));
    return parts;
}

/** 一段至少要有這麼多則、而且兩邊都說過話，才值得寫（一則招呼不算一個時刻） */
export function dayWorthWriting(msgs: Array<Pick<Message, 'role' | 'type' | 'content' | 'metadata'>>, pair = false): boolean {
    const said = msgs.filter(m => m.type !== 'system' && messagePlainText(m).trim());
    if (said.length < 2) return false;
    if (pair) return true;
    return said.some(m => m.role === 'user') && said.some(m => m.role === 'assistant');
}

/** 還沒寫過的天（有對話、值得寫的那些） */
export function pendingDays(days: string[], done: Record<string, number> | undefined): string[] {
    return days.filter(d => !done?.[d]);
}

// ─── 提示詞 ─────────────────────────────────────────

export function fragmentTranscript(
    msgs: Array<Pick<Message, 'type' | 'content' | 'metadata' | 'role' | 'charId'> & { timestamp: number }>,
    nameOf: (m: Pick<Message, 'role' | 'charId' | 'metadata'>) => string,
    timeOf: (ts: number) => string,
    maxCharsPerLine = 240,
): string {
    return msgs.map((m, i) => {
        const t = messagePlainText(m).replace(/\s+/g, ' ').trim();
        return `#${i + 1} [${timeOf(m.timestamp)}] ${nameOf(m)}：${t.length > maxCharsPerLine ? `${t.slice(0, maxCharsPerLine)}…` : t}`;
    }).join('\n');
}

const ROUTE_HINT: Record<BondRoute | 'none', string> = {
    romance: '',
    friendship: '你們是朋友（友情線），心裡話不要往戀愛的方向寫。',
    family: '你們是家人（親情線），心裡話不要往戀愛的方向寫。',
    none: '',
};

/**
 * 身份卡 × 角色：角色本人寫（system 是角色自己的核心上下文），從那天的對話挑幾個時刻。
 * 角色之間：旁觀的寫法，心裡話由那一刻比較有感觸的那位寫（who 填名字）。
 */
export function buildFragmentPrompt(args: {
    /** persona：角色名；pair：兩位 */
    selfName: string;
    otherName: string;
    pair?: boolean;
    dayLabel: string;
    from: 'chat' | 'date';
    transcript: string;
    tags: string[];
    route?: BondRoute;
    /** 這段最多挑幾則 */
    max: number;
    /** 同一天已經寫過的（分段寫時，後面幾段不要重複） */
    already?: string[];
}): string {
    const where = args.from === 'date' ? '見面' : args.pair ? '私下聊天' : '聊天';
    const already = args.already?.length ? `\n這天已經記下的（不要重複同一件事）：\n${args.already.map(a => `- ${a}`).join('\n')}\n` : '';
    const routeHint = ROUTE_HINT[args.route || 'none'];
    if (args.pair) {
        return `下面是${args.selfName}和${args.otherName}在${args.dayLabel}的${where}紀錄（用戶不在場）。

${args.transcript}
${already}
請從裡面挑出值得記下的時刻，最多 ${args.max} 個（平淡的一天挑 1 個就好；真的什麼都沒有就不挑）。
每個時刻：
- n：那個時刻最有代表性的那一則的編號
- quote：照抄那一則裡的一句話，不超過 40 字，一個字都不要改
- tag：從這些裡選一個：${args.tags.join('、')}
- who：寫心裡話的人，「${args.selfName}」或「${args.otherName}」，選那一刻比較有感觸的那位
- note：who 當下的心裡話，第一人稱，一兩句，不超過 60 字；說感受，不要重述對話
${routeHint ? `\n${routeHint}` : ''}
只輸出 JSON：{"pick":[{"n":3,"quote":"…","tag":"日常","who":"${args.selfName}","note":"…"}]}`;
    }
    return `下面是你和${args.otherName}在${args.dayLabel}的${where}紀錄。

${args.transcript}
${already}
請從裡面挑出你想記下的時刻，最多 ${args.max} 個（平淡的一天挑 1 個就好；真的什麼都沒有就不挑）。
每個時刻：
- n：那個時刻最有代表性的那一則的編號（${args.otherName}說的、你說的都可以）
- quote：照抄那一則裡的一句話，不超過 40 字，一個字都不要改
- tag：從這些裡選一個：${args.tags.join('、')}
- note：你當下的心裡話，第一人稱，一兩句，不超過 60 字；說你的感受和在意的點，不要重述對話，也不要用「用戶」稱呼${args.otherName}
${routeHint ? `\n${routeHint}` : ''}
只輸出 JSON：{"pick":[{"n":3,"quote":"…","tag":"日常","note":"…"}]}`;
}

// ─── 解析 ─────────────────────────────────────────

export interface FragmentPick<T> {
    msg: T;
    tag: string;
    quote: string;
    note: string;
    /** pair：寫心裡話的人的名字（照 AI 回的） */
    who?: string;
}

const squash = (s: string) => s.replace(/\s+/g, '').replace(/[「」『』"“”]/g, '');
const QUOTE_MAX = 60;

export function cleanNote(raw: unknown): string {
    return String(raw ?? '')
        .replace(/```[a-z]*|```/gi, '')
        .replace(/^\s*[-*•]\s*/, '')
        .replace(/^["「『“]+|["」』”]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);
}

/** 原話一定要真的在那則訊息裡；對不上就取那則的開頭 */
export function settleQuote(said: string, messageText: string): string {
    const text = messageText.replace(/\s+/g, ' ').trim();
    const q = cleanNote(said);
    if (q && squash(text).includes(squash(q))) return q.length > QUOTE_MAX ? `${q.slice(0, QUOTE_MAX)}…` : q;
    return text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX)}…` : text;
}

function pickArray(raw: string): unknown[] {
    const obj = parseJsonObject(raw);
    if (obj && Array.isArray(obj.pick)) return obj.pick;
    // 退一步：整段是個陣列
    const s = String(raw || '').replace(/```(?:json)?/gi, '');
    const a = s.indexOf('['); const b = s.lastIndexOf(']');
    if (a >= 0 && b > a) {
        try { const arr = JSON.parse(s.slice(a, b + 1)); if (Array.isArray(arr)) return arr; } catch { /* 下面當沒有 */ }
    }
    return [];
}

export function parseFragmentPick<T extends Pick<Message, 'type' | 'content' | 'metadata'>>(raw: string, msgs: T[], tags: string[], max = 6): FragmentPick<T>[] {
    const out: FragmentPick<T>[] = [];
    const used = new Set<number>();
    for (const it of pickArray(raw)) {
        if (!it || typeof it !== 'object') continue;
        const o = it as Record<string, unknown>;
        const n = Number(o.n);
        if (!Number.isInteger(n) || n < 1 || n > msgs.length || used.has(n)) continue;
        const note = cleanNote(o.note);
        if (!note) continue;
        const msg = msgs[n - 1];
        used.add(n);
        const tag = typeof o.tag === 'string' && tags.includes(o.tag.trim()) ? o.tag.trim() : tags[0] || '日常';
        out.push({ msg, tag, quote: settleQuote(String(o.quote ?? ''), messagePlainText(msg)), note, ...(typeof o.who === 'string' && o.who.trim() ? { who: o.who.trim() } : {}) });
        if (out.length >= max) break;
    }
    return out;
}

// ─── 卡 ─────────────────────────────────────────

export function newFragmentEntry(input: {
    bondId: string;
    dayKey: string;
    tag: string;
    note: string;
    quote?: BondFragment['quote'];
    voice: string;
    time?: string;
    at: number;
    from: 'chat' | 'date';
    source: BondSource;
    now?: number;
}): BondEntry {
    const now = input.now ?? Date.now();
    const eventDate: BondEventDate = { precision: 'day', date: input.dayKey };
    return {
        id: newBondEntryId(),
        bondId: input.bondId,
        kind: 'moment',
        author: input.voice,
        text: input.note,
        eventDate,
        writtenAt: now,
        sources: [input.source],
        links: [],
        status: 'published',
        createdBy: 'ai',
        fragment: {
            tag: input.tag,
            ...(input.time ? { time: input.time } : {}),
            at: input.at,
            ...(input.quote ? { quote: input.quote } : {}),
            voice: input.voice,
            from: input.from,
        },
        updatedAt: now,
    };
}

export const isFragment = (e: BondEntry): boolean => e.kind === 'moment' && !!e.fragment;

/** 「清空 AI 寫的」會刪的：AI 生成的片段（你寫的片刻、里程碑不動） */
export const clearableFragments = (entries: BondEntry[]): BondEntry[] => entries.filter(e => isFragment(e) && e.createdBy === 'ai');

/** 這一天的片段（重寫某一天時先刪掉這些） */
export const fragmentsOfDay = (entries: BondEntry[], dayKey: string): BondEntry[] =>
    entries.filter(e => isFragment(e) && e.createdBy === 'ai' && e.eventDate.precision === 'day' && e.eventDate.date === dayKey);

/** 片段的排序鍵：同一天照時間（沒有時間的照原訊息時間戳） */
export const fragmentTieBreak = (e: BondEntry): number => e.fragment?.at ?? e.writtenAt;
