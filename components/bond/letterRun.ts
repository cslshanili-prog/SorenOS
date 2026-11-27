/**
 * 信件要碰資料庫的那一半（plans/bond-batch5.md 第 3 節）：寄出、投遞（慢寄的到時候由 pact 的 tick 送到）、
 * 在聊天裡落信封小卡（type 'bond_invite'＋metadata.bondLetter）。純判斷在 utils/bond/letter.ts。
 *
 * - 你寄的：馬上到＝落一張「你寄了一封信」（到了）；慢寄＝落一張「寄出中，預計 X」，到了再落一張「信到了」。
 * - TA 寄的：到了才落「TA 的信到了」並打未讀；在路上的你那邊什麼都看不到。
 */
import type { APIConfig, BondEntry, BondOutputEvent, CharacterProfile } from '../../types';
import type { ResolvedSpace } from './space';
import { askChar, heartContext, relationLineOf } from './heartRun';
import { buildCharLetterPrompt, outputMaxTokens, parseLetter } from '../../utils/bond/outputPromptCore';
import { resolveOutputChars, resolveOutputSetting } from '../../utils/bond/output';
import { DB } from '../../utils/db';
import { lineFor, lineKey } from '../../utils/chatLine';
import { bondEntriesOf } from '../../utils/bond/entryRegistry';
import { saveBondEntry, saveBondEntries } from '../../utils/bond/entries';
import { arriveLetter, dueLetters, letterArrived, letterExcerpt, letterMeta, letterThread, newLetter, sendLetter, type BondLetterMeta } from '../../utils/bond/letter';
import { trackEvent } from '../../utils/analytics';
import { announceOutputDone, lastMessageAt } from './outputRun';
import { bondOrBlank, updateBond } from '../../utils/bond/store';
import { withOutputEvent } from '../../utils/bond/output';
import { nextAnniversary } from '../../utils/bond/spaces';
import { loadCalendarEvents } from '../../utils/calendarEvents';
import { getLocalDateKey } from '../../utils/localDate';

const SILENCE_MS = 7 * 86400_000;

const lineFieldsOf = (char: Pick<CharacterProfile, 'id' | 'primaryPersonaKey'>, personaKey: string | undefined) => {
    const line = lineFor(char, personaKey);
    return line.personaKey ? { charId: char.id, personaKey: line.personaKey } : { charId: char.id };
};

/** 聊天裡那張信封小卡 */
async function dropLetterCard(char: Pick<CharacterProfile, 'id' | 'name' | 'primaryPersonaKey'>, personaKey: string | undefined, e: BondEntry, event: BondLetterMeta['event']): Promise<void> {
    const meta = letterMeta(e, event);
    const fromUser = e.author === 'user';
    await DB.saveMessage({
        ...lineFieldsOf(char, personaKey), role: fromUser ? 'user' : 'assistant', type: 'bond_invite',
        content: fromUser ? (event === 'sent' ? `[寄出一封信給${char.name}，慢慢寄]` : `[寄了一封信給${char.name}]`) : `[${char.name}的信到了]`,
        metadata: { bondLetter: meta },
    } as Parameters<typeof DB.saveMessage>[0]);
}

/** 你寄出一封（草稿 → 寄出）；回傳存好的那封 */
export async function postUserLetter(space: { id: string; char: CharacterProfile; personaKey?: string }, draft: BondEntry, slowDays: number): Promise<BondEntry> {
    const sent = await saveBondEntry(sendLetter(draft, slowDays));
    await dropLetterCard(space.char, space.personaKey, sent, sent.letter!.arrivedAt ? 'arrived' : 'sent');
    trackEvent('羁绊信件', { 动作: sent.letter!.replyTo ? '回信' : '寄出', 谁: '我', 方式: slowDays > 0 ? '慢寄' : '马上', 来源: '自己写' });
    return sent;
}

/**
 * TA 寄出一封（請 TA 回信、主動產出）：馬上到就落小卡、打未讀；慢寄的等 tick 送到。
 */
export async function postCharLetter(space: { id: string; char: CharacterProfile; personaKey?: string }, letter: BondEntry, slowDays: number, source: '请TA回' | '主动', announce = true): Promise<BondEntry> {
    const sent = await saveBondEntry(sendLetter(letter, slowDays));
    if (sent.letter!.arrivedAt) await announceArrival(space, sent, announce);
    trackEvent('羁绊信件', { 动作: source === '请TA回' ? '请TA回' : '寄出', 谁: '角色', 方式: slowDays > 0 ? '慢寄' : '马上', 来源: source });
    return sent;
}

async function announceArrival(space: { id: string; char: CharacterProfile; personaKey?: string }, e: BondEntry, announce = true): Promise<void> {
    await dropLetterCard(space.char, space.personaKey, e, 'arrived');
    if (e.author !== 'user' && announce) {
        announceOutputDone({
            bondId: space.id, kind: 'letter', charId: space.char.id, charName: space.char.name,
            notice: { text: '信到了', lineKey: lineKey(lineFor(space.char, space.personaKey)) },
        });
    }
}

/** 慢寄的信時間到了：送到（pact 的 tick 呼叫）。回傳送到了幾封 */
export async function deliverDueLetters(spaces: Array<{ bondId: string; char: CharacterProfile; personaKey: string }>, now = Date.now()): Promise<number> {
    let n = 0;
    for (const sp of spaces) {
        const due = dueLetters(bondEntriesOf(sp.bondId), now);
        if (!due.length) continue;
        const arrived = due.map(e => arriveLetter(e, now));
        await saveBondEntries(arrived);
        for (const e of arrived) {
            await announceArrival({ id: sp.bondId, char: sp.char, personaKey: sp.personaKey }, e).catch(() => undefined);
            n++;
        }
    }
    return n;
}

/**
 * TA 主動寫信會提早的兩件事（plans/bond-batch5.md 3.3）：紀念日當天、很久沒說話（7 天以上）。
 * 里程碑、見面結束、你的信到了在別處記。只替開了「信」的關係記，一天一次。
 */
export async function markLetterOccasions(spaces: Array<{ bondId: string; char: CharacterProfile; personaKey: string }>, now = Date.now()): Promise<void> {
    const on = spaces.filter(sp => bondOrBlank(sp.bondId).output?.letter?.enabled === true);
    if (!on.length) return;
    const events = await loadCalendarEvents().catch(() => []);
    const today = getLocalDateKey(new Date(now));
    const dayStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate()).getTime();
    for (const sp of on) {
        const bond = bondOrBlank(sp.bondId);
        const evs = bond.outputEvents || [];
        const ann = nextAnniversary(events, { charIds: [sp.char.id], personaKey: sp.personaKey }, today);
        if (ann && ann.daysLeft === 0 && !evs.some(e => e.kind === 'anniversary' && e.at >= dayStart)) {
            await updateBond(sp.bondId, b => withOutputEvent(b, { kind: 'anniversary', at: now, ref: ann.event.id })).catch(() => undefined);
        }
        const last = await lastMessageAt(sp.char, sp.personaKey).catch(() => 0);
        if (last && now - last >= SILENCE_MS && !evs.some(e => e.kind === 'silence' && e.at > last)) {
            await updateBond(sp.bondId, b => withOutputEvent(b, { kind: 'silence', at: now })).catch(() => undefined);
        }
    }
}

// ─── TA 寫信要的上下文（主動產出、請 TA 回信共用） ───

const shortDay = (ms: number) => { const d = new Date(ms); return `${d.getMonth() + 1} 月 ${d.getDate()} 日`; };

/** 回信用：這一串的全文（角色看得到的：你寄到的、TA 自己寄出的） */
export function letterThreadForPrompt(space: { leftName: string; rightName: string; view?: CharacterProfile; char: CharacterProfile }, entries: BondEntry[], id: string): Array<{ fromName: string; text: string; date?: string }> {
    const self = (space.view || space.char).name;
    return letterThread(entries, id, 'char').slice(-6).map(e => ({
        fromName: e.author === 'user' ? space.leftName : `你（${self}）`, text: e.text, date: shortDay(e.letter!.sentAt || e.writtenAt),
    }));
}

/** 主動寫：你們最近寄到的信（一封一行） */
export function recentLetterLines(space: { leftName: string }, entries: BondEntry[]): string {
    return entries.filter(e => e.kind === 'letter' && letterArrived(e))
        .sort((a, b) => (b.letter!.arrivedAt || 0) - (a.letter!.arrivedAt || 0)).slice(0, 3).reverse()
        .map(e => `- ${shortDay(e.letter!.arrivedAt!)}｜${e.author === 'user' ? `${space.leftName}寫給你` : '你寫給對方'}：「${letterExcerpt(e.text, 120)}」`).join('\n');
}

/** 這次為什麼提筆：上一封之後最新的那件事 */
export function letterOccasion(space: { bond: { outputEvents?: BondOutputEvent[]; outputLast?: Partial<Record<string, number>> }; leftName: string }): string | undefined {
    const last = space.bond.outputLast?.letter || 0;
    const ev = [...(space.bond.outputEvents || [])].filter(e => e.at > last).sort((a, b) => b.at - a.at)
        .find(e => ['milestone', 'anniversary', 'date_end', 'silence'].includes(e.kind));
    if (!ev) return undefined;
    if (ev.kind === 'milestone') return '你們剛記下一個里程碑（一段關係裡真的發生過的轉折）。';
    if (ev.kind === 'anniversary') return '今天是你們的紀念日。';
    if (ev.kind === 'date_end') return `你們剛見完面。`;
    return `你和${space.leftName}好幾天沒說話了。`;
}

/** 這一種沒設篇幅時，請 TA 回信照 300～800 字 */
export const DEFAULT_LETTER_CHARS: [number, number] = [300, 800];

/**
 * 請 TA 回信（3.2）：照這一串全文寫，馬上寄到。回傳寫好的那封、這次有沒有用預設篇幅（提醒你可以去設定）。
 */
export async function askLetterReply(space: ResolvedSpace, letter: BondEntry, apiConfig: APIConfig): Promise<{ reply: BondEntry; usedDefault: boolean }> {
    const entries = bondEntriesOf(space.id);
    const own = space.bond.output?.letter?.chars;
    const chars: [number, number] = own && own.length === 2 ? resolveOutputChars(space.bond, 'letter') : DEFAULT_LETTER_CHARS;
    const ctx = await heartContext(space);
    const prompt = buildCharLetterPrompt({
        ...ctx, relationLine: relationLineOf(space), chars, style: resolveOutputSetting(space.bond, 'letter').style,
        thread: letterThreadForPrompt(space, entries, letter.id),
    });
    const raw = await askChar(space, apiConfig, prompt, '回信', undefined, { maxTokens: outputMaxTokens(chars, 2000) });
    const out = parseLetter(raw);
    if (!out) throw new Error('信沒寫出來，再試一次');
    const draft = newLetter({ bondId: space.id, author: space.char.id, to: 'user', text: out.text, signature: out.signature, replyTo: letter.id, origin: 'reply', paperStyle: letter.letter?.paperStyle });
    const reply = await postCharLetter(space, draft, 0, '请TA回');
    return { reply, usedDefault: !(own && own.length === 2) };
}
