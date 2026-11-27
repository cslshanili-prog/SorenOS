/**
 * 角色之間「讓 AI 寫他們的故事」（plans/bond-batch6.md 第 2 節）。純邏輯，有測試。
 *
 * - 一次寫一章，你是讀者：故事裡沒有用戶，只寫這兩個人（路人、配角可以當背景）。
 * - 存下才算數；存下時寫一段摘要存在章節上，之後的章節、概覽、提示詞都讀摘要。
 * - 路線照硬規則：友情、親情線的鎖定放在最後（`storyRouteLock`），故事也不能讓他們變成戀人。
 */
import type { BondEntry, BondRoute, BondStory } from '../../types';
import { newBondEntryId } from './ids';

/** 寫故事頁的場景快選（只是加進方向，不是硬分類） */
export const STORY_SCENES = ['日常', '約會／出遊', '節日', '吵架和好', '意外', '深夜談心'] as const;

/** 最近一章最多帶多少字的全文（太長只帶尾段） */
export const STORY_TAIL_CHARS = 2400;
/** 前情最多帶幾章摘要（最近的） */
export const STORY_PREV_LIMIT = 12;

/** 這段關係的章節，照章號排 */
export function storyChapters(entries: BondEntry[]): BondEntry[] {
    return entries.filter(e => e.kind === 'story' && e.story).sort((a, b) => a.story!.chapter - b.story!.chapter || a.writtenAt - b.writtenAt);
}

export function nextChapterNo(entries: BondEntry[]): number {
    return storyChapters(entries).reduce((m, e) => Math.max(m, e.story!.chapter), 0) + 1;
}

/** 這一章的前一章、後一章 */
export function chapterNeighbors(entries: BondEntry[], id: string): { prev?: BondEntry; next?: BondEntry } {
    const list = storyChapters(entries);
    const i = list.findIndex(e => e.id === id);
    if (i < 0) return {};
    return { prev: list[i - 1], next: list[i + 1] };
}

/** 長文只帶尾段（從段落開頭切，前面補一個省略號） */
export function storyTail(text: string, max = STORY_TAIL_CHARS): string {
    const t = String(text || '').trim();
    if (t.length <= max) return t;
    const cut = t.slice(t.length - max);
    const para = cut.indexOf('\n');
    return `……${(para >= 0 && para < max / 3 ? cut.slice(para + 1) : cut).trim()}`;
}

/** 字數區間：兩格都要是正整數、小的在前；不對就回 undefined（第一次寫要你填，不給預設） */
export function normalizeWords(min: unknown, max: unknown): [number, number] | undefined {
    const a = Math.round(Number(min));
    const b = Math.round(Number(max));
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return undefined;
    return a <= b ? [a, b] : [b, a];
}

/** 友情、親情線：故事最後再鎖一次（敘述者口吻） */
export function storyRouteLock(route: BondRoute | undefined, aName: string, bName: string): string {
    if (route === 'friendship') return `【關係底線】${aName}和${bName}是友情，不是戀愛，故事裡也不會變成戀愛；這一條比前面任何設定都優先。`;
    if (route === 'family') return `【關係底線】${aName}和${bName}是血緣親屬，不會變成戀愛；這一條比前面任何設定都優先。`;
    return '';
}

export interface StoryPromptInput {
    aName: string;
    bName: string;
    /** 旁白就不給；給了是這個角色的名字（第一人稱視角） */
    povName?: string;
    direction?: string;
    scene?: string;
    words: [number, number];
    style?: string;
    /** 這段關係：路線、階段的一行（「戀愛線・交往中」） */
    relationLine?: string;
    /** 他們怎麼看對方 */
    views?: string[];
    /** 前情：之前各章的摘要（舊的在前） */
    prev?: Array<{ chapter: number; title: string; summary: string }>;
    /** 最近一章的尾段 */
    lastTail?: string;
    /** 時間線：已經發生的（拾光、約定、禮物、信） */
    timeline?: string[];
    /** 最近的私下聊天 */
    recentChat?: string[];
    chapter: number;
    standalone?: boolean;
    todayText?: string;
}

/** 叫 AI 寫一章 */
export function buildStoryPrompt(input: StoryPromptInput): string {
    const { aName: A, bName: B } = input;
    const [min, max] = input.words;
    const lines: string[] = [];
    lines.push(`請寫 ${A} 和 ${B} 之間的一章故事（第 ${input.chapter} 章）。`);
    if (input.relationLine) lines.push(`他們現在的關係：${input.relationLine}。`);
    if (input.todayText) lines.push(`故事裡的「現在」大約是 ${input.todayText}。`);
    if (input.views?.length) lines.push('', '【他們怎麼看對方】', ...input.views);
    if (!input.standalone && input.prev?.length) {
        lines.push('', '【前情】');
        for (const p of input.prev.slice(-STORY_PREV_LIMIT)) lines.push(`第 ${p.chapter} 章〈${p.title}〉：${p.summary}`);
    }
    if (!input.standalone && input.lastTail) lines.push('', '【上一章的結尾】', input.lastTail);
    if (input.timeline?.length) lines.push('', '【已經發生過的事（故事不能跟這些打架）】', ...input.timeline.map(t => `- ${t}`));
    if (input.recentChat?.length) lines.push('', '【他們最近私下聊的】', ...input.recentChat);
    lines.push('', '【這一章】');
    const want = [input.scene ? `場景：${input.scene}` : '', input.direction?.trim() ? `方向：${input.direction.trim()}` : ''].filter(Boolean);
    lines.push(want.length ? want.join('；') : `方向：照前情自然往下寫一件他們之間的事；沒有前情就寫一段日常。`);
    lines.push(input.povName ? `視角：第一人稱，從 ${input.povName} 的眼睛看，「我」就是 ${input.povName}。` : '視角：第三人稱旁白，可以寫兩個人的心理。');
    lines.push(`篇幅：大約 ${min}～${max} 字。`);
    if (input.style?.trim()) lines.push(`文風：${input.style.trim()}`);
    lines.push(
        '',
        '【規則】',
        `- 只寫 ${A} 和 ${B}；路人、其他角色可以當背景，但用戶（手機的主人）不在場，故事裡不出現、不提起用戶。`,
        '- 照他們的人設說話做事；前情、已經發生過的事不能改，也不要把角色卡上的喜好寫成已經發生的共同經歷。',
        input.standalone ? '- 這一篇獨立成篇，不必接上一章。' : '- 接著前情往下寫，事情要連得上。',
        '- 寫成一章完整的故事（有場景、對話、動作），不要寫大綱、不要寫後記或作者的話。',
        '',
        '【輸出格式】',
        '第一行只寫這一章的章名（幾個字，不加「第幾章」、不加符號），空一行之後是正文。',
    );
    return lines.join('\n');
}

const TITLE_DECOR = /^[#\s*>]*|[*\s]*$/g;

/** 解析一章：第一行是章名、之後是正文；章名裝飾、書名號、「第 N 章」拿掉；沒有正文回 null */
export function parseStory(raw: string): { title: string; text: string } | null {
    let s = String(raw || '').replace(/^\s*```[a-z]*\s*/i, '').replace(/\s*```\s*$/, '').replace(/\r\n/g, '\n').trim();
    if (!s) return null;
    const lines = s.split('\n');
    const first = lines.findIndex(l => l.trim());
    let title = (lines[first] || '').replace(TITLE_DECOR, '').trim();
    title = title.replace(/^(章名|標題)[:：]\s*/, '').replace(/^第\s*[0-9一二三四五六七八九十百]+\s*章[\s:：、—-]*/, '').replace(/^[《「『〈]|[》」』〉]$/g, '').trim();
    let body = lines.slice(first + 1).join('\n').trim();
    // 第一行太長多半不是章名，而是正文：整段當正文、章名留空
    if (title.length > 30) { body = s; title = ''; }
    s = body.replace(/\n{3,}/g, '\n\n').trim();
    if (!s) return null;
    return { title: title.slice(0, 30), text: s };
}

/** 存下時的摘要：80～150 字、第三人稱、只寫發生了什麼 */
export function buildStorySummaryPrompt(args: { aName: string; bName: string; title: string; text: string }): string {
    return [
        `下面是 ${args.aName} 和 ${args.bName} 之間的一章故事〈${args.title || '無題'}〉。`,
        '用 80～150 字寫這一章發生了什麼：第三人稱、用名字，只寫事實和結果（誰做了什麼、說好了什麼、關係有什麼變化），不加評論。',
        '直接輸出那段文字，不要標題、不要引號。',
        '',
        '【故事】',
        args.text,
    ].join('\n');
}

export function cleanStorySummary(raw: string): string {
    return String(raw || '').trim().replace(/^(摘要|總結)[:：]\s*/, '').replace(/^["「『]|["」』]$/g, '').trim().slice(0, 400);
}

/** 讀者視角的概覽（書背文案那樣的「他們的故事走到哪了」） */
export function buildOverviewPrompt(args: {
    aName: string; bName: string; relationLine?: string;
    chapters: Array<{ chapter: number; title: string; summary: string }>;
    timeline?: string[];
}): string {
    return [
        `請用 150～300 字，寫一段 ${args.aName} 和 ${args.bName} 的「故事走到哪了」，像一本書的書背文案。`,
        '第三人稱、讀者的口吻；只寫已經發生的（下面列的章節和時間線），不預告、不編造沒發生的事，結尾停在他們現在的狀態。',
        args.relationLine ? `他們現在的關係：${args.relationLine}。` : '',
        '',
        '【章節】',
        ...(args.chapters.length ? args.chapters.map(c => `第 ${c.chapter} 章〈${c.title}〉：${c.summary}`) : ['（還沒有章節）']),
        ...(args.timeline?.length ? ['', '【時間線】', ...args.timeline.map(t => `- ${t}`)] : []),
        '',
        '直接輸出那段文字，不要標題。',
    ].filter((l, i, arr) => l !== '' || arr[i - 1] !== '').join('\n');
}

/** 概覽落後了：有比寫概覽時更新的章節 */
export function overviewStale(overview: { chapter: number } | undefined, entries: BondEntry[]): boolean {
    const latest = storyChapters(entries).at(-1)?.story?.chapter || 0;
    return !!latest && (!overview || overview.chapter < latest);
}

/** 一章故事卡 */
export function newStoryEntry(input: {
    bondId: string; chapter: number; title: string; text: string; summary: string; pov: string;
    direction?: string; scene?: string; words?: [number, number]; standalone?: boolean; dateKey?: string; now?: number;
}): BondEntry {
    const now = input.now ?? Date.now();
    const story: BondStory = {
        chapter: input.chapter, pov: input.pov, summary: input.summary.trim(),
        ...(input.direction?.trim() ? { direction: input.direction.trim() } : {}),
        ...(input.scene ? { scene: input.scene } : {}),
        ...(input.words ? { words: input.words } : {}),
        ...(input.standalone ? { standalone: true } : {}),
    };
    return {
        id: newBondEntryId(), bondId: input.bondId, kind: 'story', author: 'ai',
        title: input.title.trim() || `第 ${input.chapter} 章`, text: input.text.trim(),
        eventDate: input.dateKey && /^\d{4}-\d{2}-\d{2}$/.test(input.dateKey) ? { precision: 'day', date: input.dateKey } : { precision: 'unknown' },
        writtenAt: now, sources: [], links: [], status: 'published', createdBy: 'ai', updatedAt: now, story,
    };
}

/** 章名那一行給人看的：「第 3 章・在雨裡」 */
export function chapterLabel(e: Pick<BondEntry, 'title' | 'story'>): string {
    const n = e.story?.chapter;
    const t = (e.title || '').trim();
    return n ? (t && t !== `第 ${n} 章` ? `第 ${n} 章・${t}` : `第 ${n} 章`) : t;
}
