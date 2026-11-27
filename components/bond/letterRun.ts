/**
 * 信件要碰資料庫的那一半（plans/bond-batch5.md 第 3 節）：寄出、投遞（慢寄的到時候由 pact 的 tick 送到）、
 * 在聊天裡落信封小卡（type 'bond_invite'＋metadata.bondLetter）。純判斷在 utils/bond/letter.ts。
 *
 * - 你寄的：馬上到＝落一張「你寄了一封信」（到了）；慢寄＝落一張「寄出中，預計 X」，到了再落一張「信到了」。
 * - TA 寄的：到了才落「TA 的信到了」並打未讀；在路上的你那邊什麼都看不到。
 */
import type { BondEntry, CharacterProfile } from '../../types';
import { DB } from '../../utils/db';
import { lineFor, lineKey } from '../../utils/chatLine';
import { bondEntriesOf } from '../../utils/bond/entryRegistry';
import { saveBondEntry, saveBondEntries } from '../../utils/bond/entries';
import { arriveLetter, dueLetters, letterMeta, sendLetter, type BondLetterMeta } from '../../utils/bond/letter';
import { updateBond } from '../../utils/bond/store';
import { withOutputEvent } from '../../utils/bond/output';
import { trackEvent } from '../../utils/analytics';
import { announceOutputDone } from './outputRun';

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
    if (sent.letter!.arrivedAt) await updateBond(space.id, b => withOutputEvent(b, { kind: 'letter_received', at: Date.now(), ref: sent.id })).catch(() => undefined);
    trackEvent('羁绊信件', { 动作: sent.letter!.replyTo ? '回信' : '寄出', 谁: '我', 方式: slowDays > 0 ? '慢寄' : '马上', 来源: '自己写' });
    return sent;
}

/**
 * TA 寄出一封（請 TA 回信、主動產出）：馬上到就落小卡、打未讀；慢寄的等 tick 送到。
 */
export async function postCharLetter(space: { id: string; char: CharacterProfile; personaKey?: string }, letter: BondEntry, slowDays: number, source: '请TA回' | '主动'): Promise<BondEntry> {
    const sent = await saveBondEntry(sendLetter(letter, slowDays));
    if (sent.letter!.arrivedAt) await announceArrival(space, sent);
    trackEvent('羁绊信件', { 动作: source === '请TA回' ? '请TA回' : '寄出', 谁: '角色', 方式: slowDays > 0 ? '慢寄' : '马上', 来源: source === '请TA回' ? '自己写' : '主动' });
    return sent;
}

async function announceArrival(space: { id: string; char: CharacterProfile; personaKey?: string }, e: BondEntry): Promise<void> {
    await dropLetterCard(space.char, space.personaKey, e, 'arrived');
    if (e.author !== 'user') {
        announceOutputDone({
            bondId: space.id, kind: 'letter', charId: space.char.id, charName: space.char.name,
            notice: { text: '信到了', lineKey: lineKey(lineFor(space.char, space.personaKey)) },
        });
    } else {
        await updateBond(space.id, b => withOutputEvent(b, { kind: 'letter_received', at: Date.now(), ref: e.id })).catch(() => undefined);
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
