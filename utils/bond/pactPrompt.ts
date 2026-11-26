/**
 * 約定那頭要叫副 API 的兩件事（plans/bond-batch4.md 第 5 節、2.6）：
 * - AI 判讀：一期結束後讀那段聊天，判這個約定做到了沒（只照紀錄判，不替你們補完）。
 * - 回顧里程碑：讀這條線的每日總結，找出告白、交往、和好、成為摯友這類大事和日期，列出來給你一個個確認。
 * 純文字組裝與解析，零依賴（測試鎖著）。
 */
import { parseJsonObject } from './outputPromptCore';

export function buildTaskJudgePrompt(input: { promise: string; hint: string; period: string; leftName: string; rightName: string; transcript: string }): string {
    return `你是一個公正的紀錄員。${input.leftName}和${input.rightName}有一個約定：「${input.promise}」。
怎樣算做到（${input.leftName}自己寫的）：${input.hint.trim() || '照約定的字面意思判斷'}

下面是 ${input.period} 他們之間的聊天紀錄（#編號 說話的人：內容）：
${input.transcript || '（這段時間沒有聊天）'}

只照紀錄裡真的發生的判斷，不要推測、不要替他們補完；看不出來就是沒做到。
只輸出 JSON：{"done":true或false,"reason":"一句話說依據","ids":[依據的編號]}`;
}

export function parseTaskJudge(raw: string, count: number): { done: boolean; reason: string; picks: number[] } | null {
    const o = parseJsonObject(raw);
    if (!o || typeof o.done !== 'boolean') return null;
    const picks = Array.isArray(o.ids) ? o.ids.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= count) : [];
    return { done: o.done, reason: typeof o.reason === 'string' ? o.reason.trim().slice(0, 200) : '', picks: [...new Set(picks)] };
}

export interface ReviewCandidate { what: string; date?: string; title?: string; text: string; memoryIds: string[] }

export function buildMilestoneReviewPrompt(input: { leftName: string; rightName: string; kinds: Array<{ id: string; label: string }>; summaries: Array<{ id: string; date: string; text: string }> }): string {
    const list = input.summaries.map((s, i) => `#${i + 1}［${s.date}］${s.text}`).join('\n');
    return `下面是${input.leftName}和${input.rightName}這段關係按日期排好的每日總結（#編號［日期］內容）：
${list || '（沒有總結）'}

找出這段關係裡已經真的發生過的「大事」——關係的轉折點，例如：
${input.kinds.map(k => `- ${k.id}：${k.label}`).join('\n')}
- custom：上面沒有、但對這段關係很重要的轉折（title 寫名字）

規則：
- 只寫總結裡明明白白發生了的；「好像」「快要」「差點」都不算，角色只是想過、猜過也不算。
- 同一件事只寫一次，日期用那天總結的日期；看不出是哪天就不寫 date。
- 小事不算（一起吃飯、聊得開心），只要關係的轉折。沒有就回空陣列。
- text 寫一兩句發生了什麼，照總結的意思，不要加油添醋。

只輸出 JSON：{"items":[{"what":"上面的 id","date":"YYYY-MM-DD","title":"custom 才寫","text":"發生了什麼","ids":[依據的編號]}]}`;
}

export function parseMilestoneReview(raw: string, summaries: Array<{ id: string; date: string }>, kindIds: string[]): ReviewCandidate[] {
    const o = parseJsonObject(raw);
    const items = Array.isArray(o?.items) ? o!.items as unknown[] : [];
    const out: ReviewCandidate[] = [];
    for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        const x = it as Record<string, unknown>;
        const what = typeof x.what === 'string' && (kindIds.includes(x.what) || x.what === 'custom') ? x.what : null;
        const text = typeof x.text === 'string' ? x.text.trim() : '';
        if (!what || !text) continue;
        const title = what === 'custom' && typeof x.title === 'string' ? x.title.trim().slice(0, 30) : undefined;
        if (what === 'custom' && !title) continue;
        const date = typeof x.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.date) ? x.date : undefined;
        const ids = Array.isArray(x.ids) ? x.ids.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= summaries.length) : [];
        out.push({ what, ...(date ? { date } : {}), ...(title ? { title } : {}), text: text.slice(0, 300), memoryIds: [...new Set(ids)].map(n => summaries[n - 1].id) });
    }
    return out;
}
