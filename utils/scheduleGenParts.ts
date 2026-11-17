/**
 * 日程生成的那幾段提示詞和落庫對回（plans/calendar.md 第 3 批、第 5 節）——純函數，零依賴，好測。
 *
 * - 多帶的段：行程提示詞、當天的約定（含跟誰）、沒做完的待辦、一週大綱裡這天那句
 * - 輸出多三欄：with（跟誰一起，名字）、todo（這段在做哪條待辦，標題）、doneTodos（做完的待辦標題）
 * - 落庫：名字對回 Participant（對不上只留文字）、待辦標題對回 todoId、doneTodos 對回要勾的那幾條
 * - 一週：先一次請求出 7 天大綱＋這週想做的事，每天的時段分開補
 */

import type { CalendarEvent, Participant, ScheduleSlot } from '../types';
import { todoTitleMatches } from './todoTagParse';

export interface NamedParticipant { participant: Participant; name: string }

const same = (a: Participant, b: Participant) => a.kind === b.kind && a.id === b.id;

const timeOf = (e: CalendarEvent): string => (e.allDay || e.start.length < 16 ? '全天' : `${e.start.slice(11, 16)}${e.end && e.end.length >= 16 ? `–${e.end.slice(11, 16)}` : ''}`);

/** 這個人這天的約定（名下＋有份的；待辦另外列） */
export const eventsForDay = (events: CalendarEvent[], who: Participant, dayKey: string): CalendarEvent[] =>
    events.filter(e => e.kind !== 'todo' && (same(e.owner, who) || (e.participants || []).some(p => same(p, who))) && onDay(e, dayKey));

const onDay = (e: CalendarEvent, dayKey: string): boolean => {
    const startDay = e.start.slice(0, 10);
    if (e.repeat === 'yearly') return startDay.slice(5) === dayKey.slice(5);
    if (e.end && !e.allDay && e.kind === 'event') return startDay <= dayKey && dayKey <= e.end.slice(0, 10);
    return startDay === dayKey;
};

/** 這個人沒做完的待辦，截止近的在前 */
export const openTodosOf = (events: CalendarEvent[], who: Participant): CalendarEvent[] =>
    events.filter(e => e.kind === 'todo' && !e.done && same(e.owner, who)).sort((a, b) => a.start.localeCompare(b.start));

/** 行程提示詞那段 */
export const buildSchedulePromptBlock = (schedulePrompt: string | undefined): string => {
    const t = (schedulePrompt || '').trim();
    return t ? `\n## 行程提示詞（這個人固定的作息、習慣，排日程時要照著）\n${t}\n` : '';
};

/** 當天的約定那段：已經約好的事一定要排進去 */
export const buildAgreementsBlock = (events: CalendarEvent[], who: Participant, dayKey: string, nameOf: (p: Participant) => string): string => {
    const list = eventsForDay(events, who, dayKey);
    if (!list.length) return '';
    const lines = list.map(e => {
        const others = [e.owner, ...(e.participants || [])].filter(p => !same(p, who)).map(nameOf).filter(Boolean);
        const kind = e.kind === 'anniversary' ? '紀念日' : '約好的事';
        return `- ${timeOf(e)} ${e.title}${e.location ? `（${e.location}）` : ''}${others.length ? `，跟 ${others.join('、')} 一起` : ''}【${kind}】${e.note ? `：${e.note}` : ''}`;
    });
    return `\n## 這天已經約好的事（必須排進日程，時間照這裡的；紀念日要有所表示）\n${lines.join('\n')}\n`;
};

/** 沒做完的待辦那段：挑幾條排進時段 */
export const buildTodosBlock = (events: CalendarEvent[], who: Participant, dayKey: string, limit = 8): string => {
    const list = openTodosOf(events, who).slice(0, limit);
    if (!list.length) return '';
    const lines = list.map(e => `- ${e.title}${e.start ? `（截止 ${e.start.slice(0, 10)}${e.start.slice(0, 10) < dayKey ? '，已經過期' : e.start.slice(0, 10) === dayKey ? '，就是這天' : ''}）` : ''}`);
    return `\n## 沒做完的待辦（挑合理的幾條排進某個時段，截止近的優先；排了的時段把 todo 欄寫成那條的標題；不用全排）\n${lines.join('\n')}\n`;
};

/** 一週大綱裡這天那句 */
export const buildOutlineBlock = (outline: string | undefined): string => {
    const t = (outline || '').trim();
    return t ? `\n## 這天的大綱（一週計劃裡定好的，時段照它展開）\n${t}\n` : '';
};

/** 輸出格式多出來的欄位說明（接在 slot 欄位說明後面） */
export const OUTPUT_EXTRA_FIELDS = `- with: 這段跟誰一起（寫名字，好幾個用頓號隔開；一個人就省略這欄）
- todo: 這段是在做上面哪條待辦（寫那條的標題；不是待辦就省略）`;

/** 頂層多一欄 doneTodos 的說明 */
export const OUTPUT_DONE_TODOS = `  "doneTodos": ["前一天已經做完、可以勾掉的待辦標題", ...]`;

/** slot 的 with 文字 → 對回 Participant；對不上的名字留在 with 裡當文字 */
export const resolveSlotPeople = (withText: string | undefined, people: NamedParticipant[], self: Participant): { participants?: Participant[]; with?: string } => {
    const raw = (withText || '').trim();
    if (!raw) return {};
    const names = raw.split(/[、,，;；/／]|\s+和\s+|\s+跟\s+/).map(s => s.trim()).filter(Boolean);
    const participants: Participant[] = [];
    for (const n of names) {
        const hit = people.find(p => p.name === n) || people.find(p => p.name.includes(n) || n.includes(p.name));
        if (hit && !same(hit.participant, self) && !participants.some(p => same(p, hit.participant))) participants.push(hit.participant);
    }
    return { ...(participants.length ? { participants } : {}), with: names.join('、') };
};

/** slot 的 todo 標題 → todoId */
export const resolveSlotTodo = (title: string | undefined, todos: CalendarEvent[]): string | undefined => {
    const t = (title || '').trim();
    if (!t) return undefined;
    return todos.find(e => todoTitleMatches(e.title, t))?.id;
};

/** doneTodos → 要勾掉的那幾條（對不上的略過） */
export const resolveDoneTodos = (titles: unknown, todos: CalendarEvent[]): CalendarEvent[] => {
    if (!Array.isArray(titles)) return [];
    const out: CalendarEvent[] = [];
    for (const t of titles) {
        if (typeof t !== 'string' || !t.trim()) continue;
        const hit = todos.find(e => !out.includes(e) && todoTitleMatches(e.title, t));
        if (hit) out.push(hit);
    }
    return out;
};

/** 模型回的一段 → ScheduleSlot（多欄位對回） */
export const toScheduleSlot = (s: any, people: NamedParticipant[], self: Participant, todos: CalendarEvent[]): ScheduleSlot | null => {
    if (!s || typeof s !== 'object' || !s.activity) return null;
    const slot: ScheduleSlot = {
        startTime: typeof s.startTime === 'string' ? s.startTime : '00:00',
        activity: String(s.activity),
        description: typeof s.description === 'string' ? s.description : undefined,
        emoji: typeof s.emoji === 'string' ? s.emoji : undefined,
        location: typeof s.location === 'string' ? s.location : undefined,
        innerThought: typeof s.innerThought === 'string' ? s.innerThought : undefined,
    };
    const withText = typeof s.with === 'string' ? s.with : Array.isArray(s.with) ? s.with.filter((x: unknown) => typeof x === 'string').join('、') : '';
    Object.assign(slot, resolveSlotPeople(withText, people, self));
    const todoId = resolveSlotTodo(typeof s.todo === 'string' ? s.todo : undefined, todos);
    if (todoId) slot.todoId = todoId;
    return slot;
};

// ── 一週 ──────────────────────────────────────────────────────────────────

export interface WeekOutline {
    days: Array<{ date: string; outline: string }>;
    /** 這週想做的事（落成待辦，source 'ai'） */
    todos: string[];
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
export const weekdayOf = (dayKey: string): string => {
    const [y, m, d] = dayKey.split('-').map(Number);
    return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
};

/** 一週大綱的請求：每天一兩句、這週想做的事幾條 */
export const buildWeekOutlinePrompt = (name: string, days: string[], agreements: string, todos: string, schedulePrompt: string, extra: string): string => `
## Task: 排「${name}」接下來一週的大綱

日期：${days.map(d => `${d}（週${weekdayOf(d)}）`).join('、')}。
${schedulePrompt}${agreements}${todos}${extra}
每一天寫一兩句大綱：這天主要在幹嘛、有沒有特別的事（平日和週末要有差別，約好的事一定要落在那天）。
另外列 2～5 條「這週想做的事」：這個人自己會想做、還沒做的具體小事（不是日程，是待辦；跟上面已有的待辦不要重複）。

請以 JSON 格式輸出：
{
  "days": [
    { "date": "YYYY-MM-DD", "outline": "這天的大綱" },
    ...
  ],
  "todos": ["想做的事", ...]
}

僅輸出 JSON，不要其他內容。`;

export const parseWeekOutline = (parsed: any, days: string[]): WeekOutline | null => {
    if (!parsed || typeof parsed !== 'object') return null;
    const byDate = new Map<string, string>();
    for (const d of Array.isArray(parsed.days) ? parsed.days : []) {
        if (d && typeof d.date === 'string' && typeof d.outline === 'string' && d.outline.trim()) byDate.set(d.date.slice(0, 10), d.outline.trim());
    }
    const out = days.map((date, i) => ({ date, outline: byDate.get(date) || (Array.isArray(parsed.days) && typeof parsed.days[i]?.outline === 'string' ? String(parsed.days[i].outline).trim() : '') }));
    if (!out.some(d => d.outline)) return null;
    const todos = (Array.isArray(parsed.todos) ? parsed.todos : []).filter((t: unknown): t is string => typeof t === 'string' && t.trim().length > 0).map((t: string) => t.trim()).slice(0, 8);
    return { days: out, todos };
};
