/**
 * 羈絆進提示詞的段落（plans/bond-batch1.md 2.1）。純文字組裝，不碰資料庫。
 *
 * - 沒有空間、或路線未指定＋階段是朋友＋沒自訂名＋沒轉折＋沒寫此刻的我們 → 一律空字串，
 *   現有提示詞一字不差（測試鎖著）。
 * - 友情、親情的鎖定除了在段落裡，系統提示詞最後還要再出現一次（bondFinalLock），預設改不掉。
 */
import type { BondEntry, BondLedgerRow, BondRecord, BondRoute, DiaryEntry, MallOrder } from '../../types';
import { buildGiftViews, type GiftView } from './gift';
import { awaitingReply, letterArrived, letterInTransit } from './letter';
import { capsuleOpened, capsuleSealed, conditionText } from './capsule';
import { getLocalDateKey } from '../localDate';
import { knownDiaries, knownHabits, knownMilestones, knownPromises, knownQuestions, knownSlips, knownWishes } from './visibility';
import { milestoneLabel, repeatLabel } from './pact';
import { donePeriod, ledgerKeyOf, promiseStartDay, streakOf, totalPoints } from './ledger';
import { periodKeyOf, periodWord } from './period';
import { levelInfo } from './level';
import { feelingPromptLines } from './feeling';
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
    /** 完成紀錄（plans/bond-batch4.md 第 3 節）：等級、這期做了沒、連續幾天。沒有或都沒分數時不出那幾句 */
    ledger?: BondLedgerRow[];
    /** 你裝置的今天（'YYYY-MM-DD'），判「這期做了沒」用；沒給就不寫這期的狀態 */
    today?: string;
    /**
     * 這條線的送禮單（plans/bond-batch5.md 第 5 節，購物中心的單，照線篩好）。
     * 禮物從單＋卡（entries 裡的 gift）現排；你打算送的不帶（驚喜），角色自己偷偷準備的只進角色的提示詞。
     */
    giftOrders?: MallOrder[];
    /** 配送進度照這個時間算（測試用；沒給用現在） */
    now?: number;
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
    lines.push(...pactLines(input));
    lines.push(...treasureLines(input));
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

export const PROMPT_PACT_CHARS = 80;
const WISH_STATE_TEXT = { want: '想做', agreed: '已經約好要一起做', done: '完成了', shelved: '暫時擱著' } as const;

/** 約定後面那段括號：這期做了沒、連續幾期（沒給今天、一次性的約定不寫） */
function promiseStatus(e: BondEntry, ledger: BondLedgerRow[], today: string | undefined): string {
    const pr = e.promise;
    if (!pr || !today || pr.repeat.kind === 'once') return '';
    const start = promiseStartDay(e) || undefined;
    const key = ledgerKeyOf(e);
    const done = !!donePeriod(ledger, key, periodKeyOf(pr.repeat, today, start));
    const streak = streakOf(ledger, key, pr.repeat, today, start).current;
    const word = periodWord(pr.repeat);
    const unit = pr.repeat.kind === 'daily' ? '天' : pr.repeat.kind === 'weekly' ? '週' : pr.repeat.kind === 'monthly' ? '個月' : pr.repeat.kind === 'yearly' ? '年' : '輪';
    return `（${word}${done ? '已經做到了' : '還沒'}${streak >= 2 ? `；已經連續 ${streak} ${unit}` : ''}）`;
}

/**
 * 約定四段（plans/bond-batch4.md 第 3 節）：願望、共同約定、默契、里程碑。沒有內容就一行都不出。
 * 願望只是想法，有人支持也不等於答應；約定要雙方都說好才算數，還在商量的寫明等誰。
 */
function pactLines(input: BondPromptInput): string[] {
    const { otherName } = input;
    const entries = input.entries || [];
    const ledger = input.ledger || [];
    const points = totalPoints(ledger);
    if (!points && !entries.some(e => e.kind === 'wish' || e.kind === 'promise' || e.kind === 'habit' || e.kind === 'milestone')) return [];
    const lines: string[] = [];
    if (points) lines.push(`你們的羈絆等級是 Lv.${levelInfo(points).level}（一起經歷過的事累積起來的，不代表關係身份，也不會因此改變你們是什麼關係）。`);
    const wishes = knownWishes(entries);
    if (wishes.length) {
        lines.push('你們的願望（只是想做的事，有人支持也不代表答應了要一起做）：');
        for (const w of wishes) {
            const whose = w.owner === 'both' ? `${otherName}說是你們倆的` : w.owner === 'user' ? `${otherName}的` : '你的';
            const support = w.supportedBy ? `；${w.supportedBy === 'user' ? otherName : '你'}表示支持` : '';
            lines.push(`  - ${whose}：${clip(oneLine(w.text), PROMPT_PACT_CHARS)}（${WISH_STATE_TEXT[w.state]}${support}）`);
        }
    }
    const promises = knownPromises(entries);
    if (promises.active.length || promises.proposed.length) {
        lines.push('你們的約定（雙方都說好了才算數）：');
        for (const p of promises.active) lines.push(`  - ${repeatLabel(p.repeat)}：${clip(oneLine(p.text), PROMPT_PACT_CHARS)}${promiseStatus(p.entry, ledger, input.today)}`);
        for (const p of promises.proposed) {
            lines.push(`  - 還在商量：${clip(oneLine(p.text), PROMPT_PACT_CHARS)}（${p.waitingOn === 'char' ? `${otherName}提的，等你說好不好` : `你提的，${otherName}還沒說好`}）`);
        }
    }
    const habits = knownHabits(entries);
    if (habits.length) {
        lines.push('你們的默契（你們都認了的相處方式，自然照著做，不用每次提起）：');
        for (const h of habits) lines.push(`  - ${clip(oneLine(h), PROMPT_PACT_CHARS)}`);
    }
    const milestones = knownMilestones(entries);
    if (milestones.length) {
        lines.push('你們的里程碑（真的發生過的轉折）：');
        for (const m of milestones) {
            const body = oneLine(m.text);
            lines.push(`  - ${promptEventDate(m.eventDate)}｜${milestoneLabel(m.milestone!.what, m.title)}${body ? `：${clip(body, PROMPT_PACT_CHARS)}` : ''}`);
        }
    }
    return lines;
}

export const PROMPT_GIFT_LIMIT = 6;
export const PROMPT_GIFT_CHARS = 60;

const giftDay = (at: number) => promptEventDate({ precision: 'day', date: getLocalDateKey(new Date(at)) });

/** 一件禮物寫給角色看（「你」＝角色；dir out＝對方送你、in＝你送對方） */
function giftLine(v: GiftView, otherName: string): string {
    const who = v.dir === 'out' ? `${otherName}送你的` : `你送給${otherName}的`;
    const items = v.items.map(i => oneLine(i.name)).filter(n => n && n !== v.title).slice(0, 3);
    const notes = [
        v.occasion ? `${v.occasion}的禮物` : '',
        items.length ? `裡面還有${items.join('、')}` : '',
        v.state === 'bought' ? '還在配送中，還沒送到' : '',
        v.preparedDays && v.dir === 'in' ? `你偷偷準備了 ${v.preparedDays} 天` : '',
    ].filter(Boolean);
    const last = v.followups[v.followups.length - 1];
    const after = last ? `；後來：${clip(oneLine(last.text), PROMPT_GIFT_CHARS)}` : '';
    return `  - ${giftDay(v.at)}｜${who}：${clip(oneLine(v.title), PROMPT_GIFT_CHARS)}${notes.length ? `（${notes.join('，')}）` : ''}${after}`;
}

/**
 * 珍藏（plans/bond-batch5.md 第 5 節）：最近幾件禮物、你自己在偷偷準備的。沒有就一行都不出。
 * 對方打算送你的（驚喜）在 buildGiftViews 的 'char' 視角裡就不會出現。
 */
function treasureLines(input: BondPromptInput): string[] {
    const entries = input.entries || [];
    const orders = input.giftOrders || [];
    const lines: string[] = [];
    lines.push(...letterLines(input));
    lines.push(...capsuleLines(input));
    if (!orders.length && !entries.some(e => e.kind === 'gift')) return lines;
    const views = buildGiftViews({ orders, entries, forViewer: 'char', now: input.now });
    const real = views.filter(v => !v.secret && v.state !== 'planned').slice(0, PROMPT_GIFT_LIMIT);
    const secrets = views.filter(v => v.secret).sort((a, b) => a.at - b.at);
    if (real.length) {
        lines.push('你們之間的禮物（真的送出、收到過的；不用每次提起，想到了自然帶到就好）：');
        for (const v of real) lines.push(giftLine(v, input.otherName));
    }
    if (secrets.length) {
        lines.push(`你在偷偷準備送${input.otherName}的（${input.otherName}還不知道；別說破，想好時機就用購物送出去，不送也可以）：`);
        for (const v of secrets) {
            const when = v.entry?.gift?.secret?.when;
            lines.push(`  - ${clip(oneLine(v.title), PROMPT_GIFT_CHARS)}${when ? `（打算${when}送）` : ''}`);
        }
    }
    return lines;
}

export const PROMPT_LETTER_LIMIT = 3;
export const PROMPT_LETTER_CHARS = 120;

/**
 * 信件（plans/bond-batch5.md 第 5 節）：最近幾封寄到了的（雙方的），對方在等你回的標出來；
 * 你自己寄出、還在路上的你記得寄了。對方的草稿、還沒寄到的信一律不帶。沒有信就一行都不出。
 */
function letterLines(input: BondPromptInput): string[] {
    const entries = input.entries || [];
    const selfId = input.selfId;
    const mine = (e: BondEntry) => (selfId ? e.author === selfId : e.author !== 'user');
    const arrived = entries.filter(e => e.kind === 'letter' && letterArrived(e))
        .sort((a, b) => (b.letter!.arrivedAt || 0) - (a.letter!.arrivedAt || 0)).slice(0, PROMPT_LETTER_LIMIT);
    const onTheWay = entries.filter(e => e.kind === 'letter' && letterInTransit(e) && mine(e));
    if (!arrived.length && !onTheWay.length) return [];
    const other = input.otherName;
    const lines = ['你們之間的信（真的寄到了的；你寫的你記得，對方寫的你讀過）：'];
    for (const e of [...arrived].reverse()) {
        const body = clip(oneLine(e.text), PROMPT_LETTER_CHARS);
        const day = giftDay(e.letter!.arrivedAt!);
        if (mine(e)) {
            const read = e.letter!.readAt ? `${other}讀過了` : `${other}還沒打開`;
            lines.push(`  - ${day}｜你寫給${other}：「${body}」（${read}）`);
        } else {
            lines.push(`  - ${day}｜${other}寫給你：「${body}」${awaitingReply(entries, e) ? `（${other}在等你回信）` : ''}`);
        }
    }
    for (const e of onTheWay) lines.push(`  - 你寄給${other}的一封信還在路上，${other}還沒收到：「${clip(oneLine(e.text), 40)}」`);
    return lines;
}

export const PROMPT_CAPSULE_OPENED_LIMIT = 3;

/**
 * 留給以後（plans/bond-batch5.md 第 5 節）：你封的你知道內容；對方封給你的你只知道有一封、封面、條件；
 * 到期了還沒拆的提醒今天是約好的日子；拆開的雙方都知道（提前拆的寫出來）。沒有就一行都不出。
 */
function capsuleLines(input: BondPromptInput): string[] {
    const entries = (input.entries || []).filter(e => e.kind === 'capsule' && e.capsule);
    if (!entries.length) return [];
    const selfId = input.selfId;
    const mine = (e: BondEntry) => (selfId ? e.author === selfId : e.author !== 'user');
    const other = input.otherName;
    const lines: string[] = [];
    for (const e of entries.filter(capsuleSealed)) {
        const c = e.capsule!;
        const cover = c.cover ? `；封面寫著「${clip(oneLine(c.cover), 40)}」` : '';
        const due = c.dueAt ? `；條件已經到了（今天是你們約好打開它的日子），${other}還沒拆` : '';
        if (mine(e)) lines.push(`  - 你封給${other}的一封，約好${conditionText(c.openWhen)}打開${cover}；你寫的是：「${clip(oneLine(e.text), PROMPT_LETTER_CHARS)}」${due}`);
        else lines.push(`  - ${other}封給你的一封，約好${conditionText(c.openWhen)}打開${cover}；內容你還不知道${due}`);
    }
    const opened = entries.filter(capsuleOpened).sort((a, b) => b.capsule!.openedAt! - a.capsule!.openedAt!).slice(0, PROMPT_CAPSULE_OPENED_LIMIT).reverse();
    for (const e of opened) {
        const c = e.capsule!;
        const early = c.openedEarly ? `（${other}等不及，提前拆了）` : '';
        const who = mine(e) ? `你封給${other}的` : `${other}封給你的`;
        lines.push(`  - ${giftDay(c.openedAt!)}拆開了${who}那封${early}：「${clip(oneLine(e.text), PROMPT_LETTER_CHARS)}」`);
    }
    return lines.length ? ['你們的「留給以後」（封起來、約好某個時候才打開的信）：', ...lines] : [];
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
    if (bond.feeling) return true;
    if (bond.eventScene?.text) return true;
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
    // 親近與信任（plans/bond-batch4.md 1.8）：只給層和規範、未修復的傷；開始記了才有
    lines.push(...feelingPromptLines(bond.feeling, otherName, bond.route));
    lines.push(...extra);
    // 事件卡在私聊開演（plans/bond-batch4.md 2.3）：只帶這一輪，組完就清
    if (bond.eventScene?.text) lines.push(bond.eventScene.text);
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
