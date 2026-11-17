/**
 * 待辦標籤的容錯解析（plans/calendar.md 第 2 節）——純函數、零依賴，瀏覽器和主動消息 worker 共用一份
 * （同 utils/scheduleChangeParse.ts 的路子：兩邊各寫一份的話，前台認得的寫法後台不認）。
 *
 * - `[[TODO|標題|YYYY-MM-DD]]`：角色給自己加一條待辦，截止日可省
 * - `[[TODO_DONE|標題]]`：角色說做完了，勾掉（標題模糊比對，對不上就不動）
 *
 * 寫法容錯：全角豎線、冒號當分隔、`ACTION:` 前綴、中文別名（待辦／待办／做完／完成）。
 * worker 端把整段標籤原樣直通（classifier 的 TODO_TAG_RE），客戶端拼回正文後走這裡解析。
 */

export type TodoDirective =
    | { kind: 'add'; title: string; deadline?: string }
    | { kind: 'done'; title: string };

export interface ExtractedTodoDirectives {
    cleanedText: string;
    directives: TodoDirective[];
    malformedCount: number;
}

/** 整段標籤（給 worker 直通、給客戶端剝掉用）；關鍵字後面可以接 | ｜ : ： */
export const TODO_TAG_RE = /\[\[\s*(?:ACTION\s*[:：]\s*)?(TODO_DONE|TODO|待[辦办]完成|做完待[辦办]|完成待[辦办]|待[辦办])\s*(?:[|｜:：]([^\[\]\n]*))?\]\]/giu;

const DONE_KEYWORDS = new Set(['TODO_DONE', '待辦完成', '待办完成', '做完待辦', '做完待办', '完成待辦', '完成待办']);

const normalizeDate = (raw: string): string | undefined => {
    const s = raw.trim().replace(/[／/.]/g, '-');
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    if (!m) return undefined;
    const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

export const extractTodoDirectives = (text: string): ExtractedTodoDirectives => {
    const directives: TodoDirective[] = [];
    let malformedCount = 0;
    const cleanedText = text.replace(TODO_TAG_RE, (_whole, keyword: string, body: string | undefined) => {
        const isDone = DONE_KEYWORDS.has(keyword.toUpperCase());
        const parts = (body || '').split(/[|｜]/).map(p => p.trim()).filter(Boolean);
        const title = parts[0] || '';
        if (!title) { malformedCount++; return ''; }
        if (isDone) {
            directives.push({ kind: 'done', title });
            return '';
        }
        const deadline = parts.length > 1 ? normalizeDate(parts[parts.length - 1]) : undefined;
        if (parts.length > 1 && !deadline) {
            // 第二段不是日期：當成標題的一部分（角色可能用 | 斷句），不算壞
            directives.push({ kind: 'add', title: parts.join(' ') });
            return '';
        }
        directives.push({ kind: 'add', title, ...(deadline ? { deadline } : {}) });
        return '';
    }).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return { cleanedText, directives, malformedCount };
};

/** 標題模糊比對（「勾掉」用）：去空白和標點後相等、或一邊包含另一邊 */
export const todoTitleMatches = (a: string, b: string): boolean => {
    const norm = (s: string) => s.replace(/[\s，,。.、！!？?「」『』"'（）()\[\]]/g, '').toLowerCase();
    const x = norm(a); const y = norm(b);
    if (!x || !y) return false;
    return x === y || x.includes(y) || y.includes(x);
};
