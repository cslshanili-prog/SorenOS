/**
 * 羈絆進提示詞的段落（plans/bond-batch1.md 2.1）。純文字組裝，不碰資料庫。
 *
 * - 沒有空間、或路線未指定＋階段是朋友＋沒自訂名＋沒轉折＋沒寫此刻的我們 → 一律空字串，
 *   現有提示詞一字不差（測試鎖著）。
 * - 友情、親情的鎖定除了在段落裡，系統提示詞最後還要再出現一次（bondFinalLock），預設改不掉。
 */
import type { BondEntry, BondRecord, BondRoute, DiaryEntry } from '../../types';
import { knownDiaries, knownQuestions, knownSlips } from './visibility';
import { lastTurn } from './model';
import { eventSortKey, promptEventDate } from './eventDate';
import { CUSTOM_STAGE, isDefaultBondState, routeLabel, stageLabel } from './routes';

export interface BondPromptInput {
    bond: BondRecord | undefined | null;
    /** 寫給誰看（「你」） */
    selfName: string;
    /** 對方 */
    otherName: string;
    /**
     * pair：「你」是 bond.charId 那位還是 otherCharId 那位（親情稱謂、此刻的我們要分邊）。
     * persona：一律是角色。
     */
    selfIsCharId?: boolean;
    /**
     * 這段關係的卡（plans/bond-batch2.md 第 2 節）：已收存的片刻、「你」已收下的隨筆會帶進來。
     * 沒傳或沒有可帶的卡時，段落跟第 1 批一字不差。空間還沒存進 bonds（自動開的）也照樣帶。
     */
    entries?: BondEntry[];
    /** 「你」的角色 id：隨筆只帶自己寫的（角色之間互相不讀隨筆） */
    selfId?: string;
    /** 片刻上那句「想留著的原因」是你（用戶）寫的；角色 × 角色時角色不知道，不帶 */
    includeUserNotes?: boolean;
    /**
     * 這段關係的日記（plans/bond-batch3.md 第 2 節）：只有發布的頁會進來。
     * 問答、紙條從 entries 裡挑（揭曉的、投遞的；自己封存的只有自己知道）。只有身份卡 × 角色有。
     */
    diaries?: DiaryEntry[];
}

export const PROMPT_DIARY_CHARS = 200;
export const PROMPT_ANSWER_CHARS = 120;
export const PROMPT_SLIP_CHARS = 120;
const SLIP_STATE_TEXT = { want_to_talk: '想再談', responded: '已回應', resolved: '已說開' } as const;

export const PROMPT_MOMENT_LIMIT = 8;
export const PROMPT_ESSAY_LIMIT = 3;
export const PROMPT_ESSAY_CHARS = 200;

const oneLine = (s: string | undefined) => String(s || '').replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 會進提示詞的片刻：已收存、沒收起，照事件日期新到舊 */
export function promptMoments(entries: BondEntry[] | undefined): BondEntry[] {
    return (entries || [])
        .filter(e => e.kind === 'moment' && e.status === 'published' && !e.hidden && oneLine(e.text || e.title))
        .sort((a, b) => {
            const ka = eventSortKey(a.eventDate); const kb = eventSortKey(b.eventDate);
            return ka === kb ? b.writtenAt - a.writtenAt : ka < kb ? 1 : -1;
        })
        .slice(0, PROMPT_MOMENT_LIMIT);
}

/** 會進提示詞的隨筆：「你」寫的、已收下的，最近幾篇 */
export function promptEssays(entries: BondEntry[] | undefined, selfId: string | undefined): BondEntry[] {
    if (!selfId) return [];
    return (entries || [])
        .filter(e => e.kind === 'essay' && e.status === 'published' && e.author === selfId && oneLine(e.text))
        .sort((a, b) => b.writtenAt - a.writtenAt)
        .slice(0, PROMPT_ESSAY_LIMIT);
}

function entryLines(input: BondPromptInput): string[] {
    const lines: string[] = [];
    const moments = promptMoments(input.entries);
    if (moments.length) {
        lines.push(`你們收存的片刻（實際發生過的事，${input.otherName}也記得）：`);
        for (const m of moments) {
            const head = oneLine(m.title);
            const body = oneLine(m.text);
            const what = head && body && head !== body ? `${head}：${body}` : (head || body);
            const note = input.includeUserNotes !== false && m.author === 'user' && oneLine(m.note) ? `（${input.otherName}想留著它，因為：${oneLine(m.note)}）` : '';
            lines.push(`  - ${promptEventDate(m.eventDate)}｜${what}${note}`);
        }
    }
    const essays = promptEssays(input.entries, input.selfId);
    if (essays.length) {
        lines.push('你寫過的隨筆（是你當時的感想，不是事實；你現在可以有不同的想法）：');
        for (const e of essays) {
            const about = promptEventDate(e.eventDate);
            const title = oneLine(e.title);
            lines.push(`  - 關於 ${about}${title ? `〈${title}〉` : ''}：${clip(oneLine(e.text), PROMPT_ESSAY_CHARS)}`);
        }
    }
    lines.push(...heartLines(input));
    return lines;
}

/** 心意三段（plans/bond-batch3.md 第 2 節）：日記、拾光問答、心靈角落。沒有內容就一行都不出 */
function heartLines(input: BondPromptInput): string[] {
    const { otherName } = input;
    const lines: string[] = [];
    const diaries = knownDiaries(input.diaries || []);
    if (diaries.length) {
        lines.push(`你們的交換日記（寫給對方看的，你們都讀過）：`);
        for (const d of diaries) {
            const parts = [
                d.user ? `${otherName}寫：${clip(oneLine(d.user), PROMPT_DIARY_CHARS)}` : '',
                d.char ? `你寫：${clip(oneLine(d.char), PROMPT_DIARY_CHARS)}` : '',
            ].filter(Boolean);
            lines.push(`  - ${promptEventDate({ precision: 'day', date: d.date })}｜${parts.join('；')}`);
        }
    }
    const entries = input.entries || [];
    if (entries.some(e => e.kind === 'question')) {
        const q = knownQuestions(entries);
        if (q.revealed.length || q.mineSealed.length || q.askedMe.length) {
            lines.push(`拾光問答（兩人各自寫答案、封存，都交出後一起揭曉；答案不同不代表不合）：`);
            for (const r of q.revealed) {
                const again = r.earlier ? `（之前也答過 ${r.earlier} 次，這是最新一次）` : '';
                lines.push(`  - 「${clip(oneLine(r.prompt), 80)}」你答：${r.mine ? clip(oneLine(r.mine), PROMPT_ANSWER_CHARS) : '（跳過）'}；${otherName}答：${r.theirs ? clip(oneLine(r.theirs), PROMPT_ANSWER_CHARS) : '（跳過）'}${again}`);
            }
            for (const m of q.mineSealed) {
                lines.push(`  - 「${clip(oneLine(m.prompt), 80)}」你答了「${clip(oneLine(m.mine), PROMPT_ANSWER_CHARS)}」，封存著；${otherName}還沒答，也還看不到你的答案`);
            }
            for (const a of q.askedMe) {
                lines.push(`  - ${otherName}問你「${clip(oneLine(a.prompt), 80)}」，你還沒回答（${otherName}已經封存了自己的答案，你看不到）`);
            }
        }
    }
    const slips = knownSlips(entries);
    if (slips.length) {
        lines.push(`心靈角落的紙條（投遞了才算說出口；有回應不代表已經說開）：`);
        for (const sl of slips) {
            const who = sl.fromUser ? `${otherName}丟給你` : `你丟給${otherName}`;
            const tags = sl.tags.length ? `（${sl.tags.join('、')}）` : '';
            const reply = sl.isReply ? '（回應）' : '';
            // 狀態是收到的那方標的：你丟的由對方標，對方丟的由你標
            const state = sl.state ? `；${sl.fromUser ? '你' : otherName}標了「${SLIP_STATE_TEXT[sl.state]}」` : '';
            lines.push(`  - ${who}${reply}${tags}：${clip(oneLine(sl.text), PROMPT_SLIP_CHARS)}${state}`);
        }
    }
    return lines;
}

const FRIENDSHIP_RULES = [
    '這段關係是友情，而且會一直是友情。就算其他設定寫著你會慢慢愛上對方，這段關係仍以這裡為準。',
    '羈絆再深、再信任、再親近，都不代表你愛上了對方；不要補寫「其實早就暗戀」「自己還沒發現愛上了」「以朋友之名留在身邊」這類心思。',
    '被忽略的失落、怕漸漸疏遠的擔心，就是朋友之間的情緒，不要寫成吃醋。',
    '自訂的暱稱、送禮、身體上的親近、很高的羈絆，都不是關係要改變的訊號。',
    '不要引導、暗示或期待這段關係變成戀愛。',
    '友情可以很深：護短、信任、掛念、互損、分享秘密、把對方當成人生裡重要的人，這些照你的個性自然表現，不用刻意保持距離。',
];

function familyLine(selfName: string, otherName: string, selfLabel: string | undefined): string {
    const who = selfLabel?.trim() ? `你是${otherName}的${selfLabel.trim()}` : `你和${otherName}是血緣親屬`;
    return `${who}，這是人物事實。你們的親近、理解、信任可以變深，但這段關係不會變成戀愛，也不要寫出戀愛的心思。`;
}

const ROMANCE_RULE = '這段關係可以往戀愛發展。曖昧、交往、訂婚、結婚這些身份，要經過實際發生的事和你們雙方的表達才會改變；不要自己宣布已經交往或訂婚，也不要把還沒發生的事說成已經發生。';

function stageText(route: BondRoute | undefined, stage: string, label: string | undefined): string {
    return `${stageLabel({ route, stage, stageLabel: label })}（${routeLabel(route)}）`;
}

/** pair 的親情稱謂：「你」那邊是對方的什麼 */
function selfFamilyLabel(bond: BondRecord, selfIsCharId: boolean | undefined): string | undefined {
    if (bond.kind === 'pair') return selfIsCharId === false ? bond.stageLabelOther : bond.stageLabel;
    // persona：stageLabel＝角色是你的什麼，寫給角色看正好是「你是對方的什麼」
    return bond.stageLabel;
}

/** 此刻的我們：誰寫的那段算「你」的 */
function ourNowLines(bond: BondRecord, input: BondPromptInput): string[] {
    const now = bond.ourNow;
    if (!now) return [];
    const lines: string[] = [];
    if (bond.kind === 'pair') {
        const mine = input.selfIsCharId === false ? now.other : now.char;
        const theirs = input.selfIsCharId === false ? now.char : now.other;
        if (mine?.text.trim()) lines.push(`你寫下的「此刻的我們」：${mine.text.trim()}`);
        if (theirs?.text.trim()) lines.push(`${input.otherName}寫下的「此刻的我們」：${theirs.text.trim()}`);
        return lines;
    }
    if (now.char?.text.trim()) lines.push(`你寫給${input.otherName}看的「此刻的我們」：${now.char.text.trim()}`);
    if (now.user?.text.trim()) lines.push(`${input.otherName}寫的「我眼中的我們」：${now.user.text.trim()}`);
    return lines;
}

/** 這段關係要不要進提示詞（全預設、什麼都沒寫就不進） */
export function bondHasPromptContent(bond: BondRecord | undefined | null): boolean {
    if (!bond) return false;
    if (!isDefaultBondState(bond)) return true;
    if (lastTurn(bond)) return true;
    const now = bond.ourNow;
    return !!(now?.char?.text.trim() || now?.user?.text.trim() || now?.other?.text.trim());
}

/** 一段關係的提示詞段落（自帶結尾空行；沒東西時空字串） */
export function bondPromptBlock(input: BondPromptInput): string {
    const bond = input.bond;
    const extra = entryLines(input);
    if (!bond || !bondHasPromptContent(bond)) {
        return extra.length ? `### 你和${input.otherName}的關係\n${extra.map(l => (l.startsWith('  ') ? l : `- ${l}`)).join('\n')}\n\n` : '';
    }
    const { selfName, otherName } = input;
    const lines: string[] = [];
    if (bond.route) {
        lines.push(`關係路線：${routeLabel(bond.route)}；現在是「${stageLabel(bond)}」。`);
    } else if (bond.stage === CUSTOM_STAGE && bond.stageLabel?.trim()) {
        lines.push(`你們把這段關係叫作「${bond.stageLabel.trim()}」。`);
    }
    if (bond.route === 'romance') lines.push(ROMANCE_RULE);
    if (bond.route === 'friendship') lines.push(...FRIENDSHIP_RULES);
    if (bond.route === 'family') lines.push(familyLine(selfName, otherName, selfFamilyLabel(bond, input.selfIsCharId)));
    if (bond.route && bond.stage === CUSTOM_STAGE && bond.stageLabel?.trim()) {
        lines.push(`你們把這段關係叫作「${bond.stageLabel.trim()}」，它仍屬${routeLabel(bond.route)}路線。`);
    }
    const turn = lastTurn(bond);
    if (turn) {
        const note = turn.note ? `（${turn.note}）` : '';
        lines.push(`你們在 ${turn.storyDay} 從「${stageText(turn.from.route, turn.from.stage, turn.from.label)}」變成「${stageText(turn.to.route, turn.to.stage, turn.to.label)}」${note}。之前那段關係是真的，不要回頭改寫成一開始就是現在這樣。`);
    }
    lines.push(...ourNowLines(bond, input));
    lines.push(...extra);
    if (!lines.length) return '';
    return `### 你和${otherName}的關係\n${lines.map(l => (l.startsWith('  ') ? l : `- ${l}`)).join('\n')}\n\n`;
}

/** 系統提示詞最後那一句（只有友情、親情有） */
export function bondFinalLock(bond: BondRecord | undefined | null, otherName: string): string {
    if (bond?.route === 'friendship') return `【關係底線】你和${otherName}是友情，不是戀愛，也不會變成戀愛；這一條比前面任何設定都優先。`;
    if (bond?.route === 'family') return `【關係底線】你和${otherName}是血緣親屬，不會變成戀愛；這一條比前面任何設定都優先。`;
    return '';
}

/** 幾段關係的最後一句合在一起（群聊、劇情一個人同時面對好幾位） */
export function bondFinalLocks(items: Array<{ bond: BondRecord | undefined | null; otherName: string }>): string {
    return items.map(i => bondFinalLock(i.bond, i.otherName)).filter(Boolean).join('\n');
}

/** 群聊、劇情給旁人看的一句：在場的誰跟誰是友情／親情 */
export function bondBystanderNote(pairs: Array<{ aName: string; bName: string; route?: BondRoute }>): string {
    const lines = pairs.flatMap(p => {
        if (p.route === 'friendship') return [`${p.aName}和${p.bName}是朋友，不是戀人；別起鬨，也別把他們的親近解讀成戀愛。`];
        if (p.route === 'family') return [`${p.aName}和${p.bName}是家人；別把他們的親近解讀成戀愛。`];
        return [];
    });
    return lines.length ? `【旁人須知】\n${lines.join('\n')}` : '';
}

/** 「你身邊的人」那行後面補的一句（只有友情、親情線） */
export function pairRouteNote(route: BondRoute | undefined): string | undefined {
    if (route === 'friendship') return '你們是友情，不會變成戀愛';
    if (route === 'family') return '你們是血緣親屬，不會變成戀愛';
    return undefined;
}
