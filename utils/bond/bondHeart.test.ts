import { describe, expect, it } from 'vitest';
import type { DiaryEntry } from '../../types';
import { blankDiary, charPageUnread, diariesOfBond, diaryInBond, diaryWriters, pagePublished, publishUserPage, putCharPage, reviseCharPage } from './diary';
import { answerQuestion, newQuestion, parseQuestionSuggestions, questionBucket, startNewRound, visibleAnswer, waitingOn, waitingOnUser, lastRound } from './question';
import { deliverSlip, newSlip, setSlipState, slipInbox, slipReplies, slipTagOptions, slipUnreadByUser } from './slip';
import { knownDiaries, knownQuestions, knownSlips } from './visibility';
import { buildCharAnswerPrompt, buildCharAskPrompt, parseCharAnswer, parseCharAsk, parseSlip } from './outputPromptCore';
import { resolveOutputSetting } from './output';

const page = (text: string, extra: Partial<DiaryEntry['userPage']> = {}) => ({ text, paperStyle: 'plain', stickers: [], ...extra });

describe('日記', () => {
    it('照線分：舊資料沒有 bondId 算主線那張卡', () => {
        expect(diaryInBond({}, 'c1::__real__', 'c1::__real__')).toBe(true);
        expect(diaryInBond({}, 'c1::p2', 'c1::__real__')).toBe(false);
        expect(diaryInBond({ bondId: 'c1::p2' }, 'c1::p2', 'c1::__real__')).toBe(true);
    });
    it('發布：舊資料有字就算；新的要按發布', () => {
        expect(pagePublished(page('舊的'))).toBe(true);
        expect(pagePublished(page('草稿', { writtenAt: 1 }))).toBe(false);
        expect(pagePublished(page('', { publishedAt: 1 }))).toBe(false);
        // 新的一頁寫了字還是草稿
        const fresh = blankDiary({ charId: 'c1', bondId: 'b', date: '2026-11-26' });
        expect(pagePublished({ ...fresh.userPage, text: '剛寫的' })).toBe(false);
        const d = publishUserPage({ ...blankDiary({ charId: 'c1', bondId: 'b', date: '2026-11-26' }), userPage: page('今天', { writtenAt: 1 }) }, 5);
        expect(pagePublished(d.userPage)).toBe(true);
        expect(d.userPage.publishedAt).toBe(5);
    });
    it('角色那頁寫完就發布；重寫留第一版原文；你改也留', () => {
        let d = blankDiary({ charId: 'c1', bondId: 'b', date: '2026-11-26' });
        expect(diaryWriters(d)).toBe('none');
        d = putCharPage(d, page('第一版'), 'ai', 10);
        expect(d.charPage).toMatchObject({ publishedAt: 10, createdBy: 'ai' });
        expect(d.charPage!.originalText).toBeUndefined();
        expect(charPageUnread(d)).toBe(true);
        expect(diaryWriters(d)).toBe('char');
        d = putCharPage(d, page('第二版'), 'ai', 20);
        d = putCharPage(d, page('第三版'), 'ai', 30);
        expect(d.charPage!.originalText).toBe('第一版');
        expect(reviseCharPage(d, '我改的', 40).charPage!.originalText).toBe('第一版');
    });
    it('清單新到舊、只列這段的', () => {
        const a = { ...blankDiary({ charId: 'c1', bondId: 'b1', date: '2026-11-01' }), timestamp: 1 };
        const b = { ...blankDiary({ charId: 'c1', bondId: 'b2', date: '2026-11-02' }), timestamp: 2 };
        const c = { ...blankDiary({ charId: 'c1', bondId: 'b1', date: '2026-11-03' }), timestamp: 3 };
        expect(diariesOfBond([a, b, c], 'b1', 'b0').map(d => d.date)).toEqual(['2026-11-03', '2026-11-01']);
    });
});

describe('拾光問答', () => {
    it('發起的人封存才送出；雙方交出才揭曉；暫存不算', () => {
        let q = newQuestion({ bondId: 'b', openedBy: 'user', prompt: '最喜歡的季節？', origin: 'user', now: 1 });
        expect(q.status).toBe('draft');
        q = answerQuestion(q, 'user', { text: '秋天（暫存）', state: 'draft' }, 2);
        expect(q.status).toBe('draft');
        q = answerQuestion(q, 'user', { text: '秋天', state: 'sealed' }, 3);
        expect(q.status).toBe('published');
        expect(waitingOn(q)).toEqual(['char']);
        expect(questionBucket(q)).toBe('theirs');
        // 盲答：角色看不到你封存的
        expect(visibleAnswer(lastRound(q.question)!, 'user', 'char')).toBeNull();
        q = answerQuestion(q, 'char', { text: '冬天', state: 'sealed' }, 4);
        expect(lastRound(q.question)!.revealedAt).toBe(4);
        expect(visibleAnswer(lastRound(q.question)!, 'user', 'char')?.text).toBe('秋天');
        expect(questionBucket(q)).toBe('revealed');
        // 交出後不能改
        expect(answerQuestion(q, 'char', { text: '春天', state: 'sealed' })).toBe(q);
    });
    it('角色出題：封存自己的答案，等你；跳過也算揭曉', () => {
        let q = newQuestion({ bondId: 'b', openedBy: 'c1', prompt: '早餐吃什麼？', origin: 'char', now: 1 });
        q = answerQuestion(q, 'char', { text: '吐司', state: 'sealed' }, 2);
        expect(waitingOnUser(q)).toBe(true);
        expect(visibleAnswer(lastRound(q.question)!, 'char', 'user')).toBeNull();
        q = answerQuestion(q, 'user', { text: '', state: 'skipped' }, 3);
        expect(lastRound(q.question)!.revealedAt).toBe(3);
        expect(visibleAnswer(lastRound(q.question)!, 'char', 'user')?.text).toBe('吐司');
    });
    it('再答一次：揭曉後才能開新的一輪，舊的留著', () => {
        let q = newQuestion({ bondId: 'b', openedBy: 'user', prompt: 'Q', origin: 'user', now: 1 });
        expect(startNewRound(q, 'user')).toBe(q);
        q = answerQuestion(answerQuestion(q, 'user', { text: 'a', state: 'sealed' }, 2), 'char', { text: 'b', state: 'sealed' }, 3);
        q = startNewRound(q, 'c1', 9);
        expect(q.question!.rounds).toHaveLength(2);
        expect(waitingOn(q)).toEqual(['char']);
    });
    it('角色知道的：揭曉的、自己封存的、別人問我還沒答的（只有題目）', () => {
        const revealed = answerQuestion(answerQuestion(newQuestion({ bondId: 'b', openedBy: 'user', prompt: '揭曉題', origin: 'user', now: 1 }), 'user', { text: '你的', state: 'sealed' }, 2), 'char', { text: '我的', state: 'sealed' }, 3);
        const askedMe = answerQuestion(newQuestion({ bondId: 'b', openedBy: 'user', prompt: '等我答', origin: 'user', now: 4 }), 'user', { text: '不能看', state: 'sealed' }, 5);
        const mine = answerQuestion(newQuestion({ bondId: 'b', openedBy: 'c1', prompt: '我出的', origin: 'char', now: 6 }), 'char', { text: '我封存的', state: 'sealed' }, 7);
        const draft = newQuestion({ bondId: 'b', openedBy: 'user', prompt: '你還在寫', origin: 'user', now: 8 });
        const k = knownQuestions([revealed, askedMe, mine, draft]);
        expect(k.revealed).toEqual([{ prompt: '揭曉題', mine: '我的', theirs: '你的', earlier: 0, at: 3 }]);
        expect(k.mineSealed).toEqual([{ prompt: '我出的', mine: '我封存的' }]);
        expect(k.askedMe).toEqual([{ prompt: '等我答' }]);
        expect(JSON.stringify(k)).not.toContain('不能看');
        expect(JSON.stringify(k)).not.toContain('你還在寫');
    });
    it('推薦題目解析', () => {
        expect(parseQuestionSuggestions('```json\n[{"question":"喜歡貓還是狗？","topic":"choice"},{"question":""},{"question":"x","topic":"weird"}]\n```'))
            .toEqual([{ prompt: '喜歡貓還是狗？', topic: 'choice' }, { prompt: 'x', topic: 'custom' }]);
        expect(parseQuestionSuggestions('不是 JSON')).toEqual([]);
    });
});

describe('心靈角落', () => {
    it('草稿只有作者知道；投遞才算；狀態與已讀', () => {
        const draft = newSlip({ bondId: 'b', author: 'user', text: '草稿', tags: ['吐槽'], now: 1 });
        const sent = deliverSlip(newSlip({ bondId: 'b', author: 'user', text: '投遞了', tags: ['掛念', '掛念'], now: 2 }), 3);
        expect(sent.slip).toMatchObject({ tags: ['掛念'], deliveredAt: 3 });
        const fromChar = deliverSlip(newSlip({ bondId: 'b', author: 'c1', text: '上次你說沒人在意', tags: ['沒說出口的話'], now: 4 }), 5);
        expect(slipUnreadByUser(fromChar)).toBe(true);
        expect(knownSlips([draft, sent, fromChar]).map(s => s.text)).toEqual(['上次你說沒人在意', '投遞了']);
        expect(setSlipState(fromChar, 'want_to_talk').slip!.state).toBe('want_to_talk');
        expect(setSlipState(setSlipState(fromChar, 'resolved'), null).slip!.state).toBeUndefined();
    });
    it('回應串與信箱', () => {
        const root = deliverSlip(newSlip({ bondId: 'b', author: 'c1', text: '根', tags: [], now: 1 }), 2);
        const reply = deliverSlip(newSlip({ bondId: 'b', author: 'user', text: '回', tags: [], replyTo: root.id, now: 3 }), 4);
        const myDraftReply = newSlip({ bondId: 'b', author: 'user', text: '還沒投', tags: [], replyTo: root.id, now: 5 });
        expect(reply.links).toEqual([{ type: 'entry', id: root.id }]);
        expect(slipReplies([root, reply, myDraftReply], root.id).map(e => e.text)).toEqual(['回']);
        expect(slipReplies([root, reply, myDraftReply], root.id, 'user').map(e => e.text)).toEqual(['回', '還沒投']);
        expect(slipInbox([root, reply, myDraftReply]).map(e => e.text)).toEqual(['根']);
    });
    it('標籤：內建＋自訂去重', () => {
        expect(slipTagOptions(['掛念', '小抱怨', ' '])).toEqual(['吐槽', '掛念', '想一起做的事', '心結', '開心的事', '沒說出口的話', '小抱怨']);
    });
});

describe('知道的日記', () => {
    it('只有發布的頁', () => {
        const d1 = { ...blankDiary({ charId: 'c1', bondId: 'b', date: '2026-11-25' }), userPage: page('你的草稿', { writtenAt: 1 }) };
        const d2 = putCharPage({ ...blankDiary({ charId: 'c1', bondId: 'b', date: '2026-11-26' }), userPage: page('你發布的', { writtenAt: 1, publishedAt: 2 }) }, page('角色的'), 'ai', 3);
        expect(knownDiaries([d1, d2])).toEqual([{ date: '2026-11-26', user: '你發布的', char: '角色的' }]);
    });
});

describe('生成提示詞', () => {
    it('答題不收對方的答案；出題要封存答案', () => {
        const p = buildCharAnswerPrompt({ selfName: 'Sully', otherName: 'Liora', question: '最喜歡的季節？', askedByOther: true });
        expect(p).toContain('你看不到Liora這次的答案');
        expect(p).toContain('{"answer"');
        expect(buildCharAskPrompt({ selfName: 'Sully', otherName: 'Liora', askedBefore: ['舊題'] })).toContain('- 舊題');
    });
    it('解析', () => {
        expect(parseCharAnswer('{"answer":"冬天"}')).toEqual({ answer: '冬天' });
        expect(parseCharAnswer('{"skip":true}')).toEqual({ skip: true });
        expect(parseCharAnswer('「冬天吧」')).toEqual({ answer: '冬天吧' });
        expect(parseCharAsk('{"question":"Q","topic":"weird","answer":"A"}')).toEqual({ question: 'Q', topic: 'custom', answer: 'A' });
        expect(parseCharAsk('{"question":"Q"}')).toBeNull();
        expect(parseSlip('{"tags":["掛念","亂來"],"text":"記得吃飯"}', ['掛念'])).toEqual({ text: '記得吃飯', tags: ['掛念'] });
    });
});

describe('主動產出設定', () => {
    it('沒設照預設，設了蓋過', () => {
        expect(resolveOutputSetting(undefined, 'diary')).toMatchObject({ enabled: true, everyDays: [1, 3] });
        expect(resolveOutputSetting({ output: { note: { enabled: false } } }, 'note')).toMatchObject({ enabled: false, everyDays: [3, 7] });
    });
});

import { bondPromptBlock } from './prompt';
import { bondRefFromDiary, bondRefFromQuestion, bondRefFromSlip, bondRefPrefix } from './bondRef';
import { blankBond } from './model';

describe('心意進提示詞（知情範圍）', () => {
    const bond = blankBond('c1::p1', Date.now());
    it('沒有心意的內容時一字不差', () => {
        const base = bondPromptBlock({ bond, selfName: 'Sully', otherName: 'Liora', entries: [], selfId: 'c1' });
        const draftOnly = bondPromptBlock({
            bond, selfName: 'Sully', otherName: 'Liora', selfId: 'c1',
            entries: [newSlip({ bondId: 'c1::p1', author: 'user', text: '草稿', tags: [] }), newQuestion({ bondId: 'c1::p1', openedBy: 'user', prompt: '還沒送出', origin: 'user' })],
            diaries: [{ ...blankDiary({ charId: 'c1', bondId: 'c1::p1', date: '2026-11-26' }), userPage: page('沒發布', { writtenAt: 1 }) }],
        });
        expect(draftOnly).toBe(base);
    });
    it('發布的日記、揭曉的問答、投遞的紙條進來；盲答不漏', () => {
        const diary = putCharPage({ ...blankDiary({ charId: 'c1', bondId: 'c1::p1', date: '2026-11-26' }), userPage: page('今天喉嚨痛', { writtenAt: 1, publishedAt: 2 }) }, page('泡了檸檬水'), 'ai', 3);
        const revealed = answerQuestion(answerQuestion(newQuestion({ bondId: 'c1::p1', openedBy: 'user', prompt: '最喜歡的季節', origin: 'user' }), 'user', { text: '秋天', state: 'sealed' }), 'char', { text: '冬天', state: 'sealed' });
        const blind = answerQuestion(newQuestion({ bondId: 'c1::p1', openedBy: 'user', prompt: '早餐吃什麼', origin: 'user' }), 'user', { text: '秘密答案', state: 'sealed' });
        const slip = setSlipState(deliverSlip(newSlip({ bondId: 'c1::p1', author: 'c1', text: '上次沒接話', tags: ['沒說出口的話'] })), 'want_to_talk');
        const out = bondPromptBlock({ bond, selfName: 'Sully', otherName: 'Liora', selfId: 'c1', entries: [revealed, blind, slip], diaries: [diary] });
        expect(out).toContain('Liora寫：今天喉嚨痛；你寫：泡了檸檬水');
        expect(out).toContain('「最喜歡的季節」你答：冬天；Liora答：秋天');
        expect(out).toContain('Liora問你「早餐吃什麼」，你還沒回答');
        expect(out).not.toContain('秘密答案');
        expect(out).toContain('你丟給Liora（沒說出口的話）：上次沒接話；Liora標了「想再談」');
    });
    it('帶去聊聊：日記、揭曉的問答、投遞的紙條；沒揭曉的問答不能帶', () => {
        const d = putCharPage(blankDiary({ charId: 'c1', bondId: 'b', date: '2026-11-26' }), page('泡了檸檬水'), 'ai', 3);
        expect(bondRefPrefix(bondRefFromDiary('b', d, 'char', 'Sully')!)).toBe('[從羈絆帶來：〈日記〉（Sully寫的）11 月 26 日——泡了檸檬水]');
        const sealed = answerQuestion(newQuestion({ bondId: 'b', openedBy: 'user', prompt: 'Q', origin: 'user' }), 'user', { text: 'A', state: 'sealed' });
        expect(bondRefFromQuestion('b', sealed, { user: 'Liora', char: 'Sully' })).toBeNull();
        const rev = answerQuestion(sealed, 'char', { text: 'B', state: 'sealed' });
        expect(bondRefPrefix(bondRefFromQuestion('b', rev, { user: 'Liora', char: 'Sully' })!)).toBe('[從羈絆帶來：〈問答〉「Q」——Liora答「A」；Sully答「B」]');
        const s = deliverSlip(newSlip({ bondId: 'b', author: 'c1', text: '記得吃飯', tags: ['掛念'] }));
        expect(bondRefPrefix(bondRefFromSlip('b', s, s.id, 'Sully')!)).toBe('[從羈絆帶來：〈紙條〉（Sully丟的）掛念——記得吃飯]');
        expect(bondRefFromSlip('b', newSlip({ bondId: 'b', author: 'user', text: '草稿', tags: [] }), 'x', 'Liora')).toBeNull();
    });
});

import { decideBondOutputs, inWindow, intervalDueAt, markOutputDone, nextDueAt, withOutputEvent } from './output';

describe('主動產出排程', () => {
    const DAY = 86400_000;
    const now = 100 * DAY;
    const dayStart = now - 12 * 3600_000;
    const bond = (id: string, over: Partial<ReturnType<typeof blankBond>> = {}) => ({ ...blankBond(id, 1), ...over });
    const cand = (b: ReturnType<typeof bond>, over: Partial<{ eligible: boolean; recentlyActive: boolean }> = {}) => ({ bondId: b.id, bond: b, eligible: true, recentlyActive: true, ...over });
    // 22:00（日記的預設時段 20:00–23:30 裡）
    const at22 = 22 * 60;

    it('第一次只記起點，不寫', () => {
        const d = decideBondOutputs([cand(bond('c1::p'))], now, at22, dayStart);
        expect(d.due).toEqual([]);
        expect(d.seeds.map(s => s.kind).sort()).toEqual(['diary', 'essay', 'note', 'question', 'wish']);
        expect(d.seeds.find(s => s.kind === 'diary')!.at).toBe(now - DAY / 2);
    });
    it('沒聊過的預設不開；自己開了就算', () => {
        expect(decideBondOutputs([cand(bond('c1::p'), { recentlyActive: false })], now, at22, dayStart).seeds).toEqual([]);
        const b = bond('c1::p', { output: { diary: { enabled: true } } });
        expect(decideBondOutputs([cand(b, { recentlyActive: false })], now, at22, dayStart).seeds.map(s => s.kind)).toEqual(['diary']);
        expect(decideBondOutputs([cand(bond('c1::p'), { eligible: false })], now, at22, dayStart).seeds).toEqual([]);
    });
    it('保底：到了區間裡挑的那天、在時段裡才寫', () => {
        const last = now - 3 * DAY - 1;
        const b = bond('c1::p', { outputLast: { diary: last, question: now - DAY, note: now - DAY, essay: now - DAY } });
        expect(intervalDueAt(b, 'diary')!).toBeLessThanOrEqual(now);
        expect(decideBondOutputs([cand(b)], now, at22, dayStart).due).toEqual([{ bondId: 'c1::p', kind: 'diary', reason: 'interval' }]);
        // 時段外（早上 9 點）不寫
        expect(decideBondOutputs([cand(b)], now, 9 * 60, dayStart).due).toEqual([]);
        // 暫停中不寫
        expect(decideBondOutputs([cand({ ...b, output: { diary: { pausedUntil: now + 1 } } })], now, at22, dayStart).due).toEqual([]);
    });
    it('事件提早：離上次過了區間下限的一半', () => {
        const b = withOutputEvent(bond('c1::p', { outputLast: { diary: now - 13 * 3600_000, question: now - DAY, note: now - DAY, essay: now - DAY } }), { kind: 'daily_summary', at: now - 1000 });
        expect(decideBondOutputs([cand(b)], now, at22, dayStart).due).toEqual([{ bondId: 'c1::p', kind: 'diary', reason: 'event' }]);
        const tooSoon = withOutputEvent(bond('c1::p', { outputLast: { diary: now - 3600_000, question: now - DAY, note: now - DAY, essay: now - DAY } }), { kind: 'daily_summary', at: now - 1000 });
        expect(decideBondOutputs([cand(tooSoon)], now, at22, dayStart).due).toEqual([]);
    });
    it('上限：同一段一輪一份、兩份隔 3 小時、一段一天 2 份、全部一天 6 份；最久沒寫的先', () => {
        const old = now - 30 * DAY;
        const b1 = bond('a::p', { outputLast: { diary: old, question: old - 1, note: old, essay: old } });
        expect(decideBondOutputs([cand(b1)], now, at22, dayStart).due.map(d => d.kind)).toEqual(['question']);
        const recent = bond('a::p', { outputLast: { diary: old, question: now - 3600_000, note: old, essay: old } });
        expect(decideBondOutputs([cand(recent)], now, at22, dayStart).due).toEqual([]);
        const full = bond('a::p', { outputLast: { diary: old, question: now - 4 * 3600_000, note: now - 8 * 3600_000, essay: old } });
        expect(decideBondOutputs([cand(full)], now, at22, dayStart).due).toEqual([]);
        const many = Array.from({ length: 8 }, (_, i) => bond(`c${i}::p`, { outputLast: { diary: old + i, question: now - DAY, note: now - DAY, essay: now - DAY } }));
        expect(decideBondOutputs(many.map(b => cand(b)), now, at22, dayStart).due).toHaveLength(6 - 0 - 0);
    });
    it('寫完換起點；下一次最早什麼時候（事件提早、區間保底）', () => {
        const last = now - 2 * DAY;
        const b = bond('a::p', { outputLast: { diary: last } });
        const done = markOutputDone(b, 'diary', now);
        expect(done.outputLast!.diary).toBe(now);
        const interval = nextDueAt(b, 'diary')!;
        expect(interval).toBeGreaterThanOrEqual(last + DAY);
        expect(interval).toBeLessThanOrEqual(last + 3 * DAY);
        // 事件在區間下限一半之前：等到一半；之後：就是事件那時
        const early = bond('a::p', { outputLast: { diary: last }, outputEvents: [{ kind: 'daily_summary', at: last + 3600_000 }] });
        expect(nextDueAt(early, 'diary')).toBe(Math.min(last + DAY / 2, interval));
        const late = bond('a::p', { outputLast: { diary: last }, outputEvents: [{ kind: 'daily_summary', at: last + DAY }] });
        expect(nextDueAt(late, 'diary')).toBe(Math.min(last + DAY, interval));
        // 不對應這一種的事件不算
        const other = bond('a::p', { outputLast: { question: last }, outputEvents: [{ kind: 'date_end', at: last + DAY }] });
        expect(nextDueAt(other, 'question')).toBe(intervalDueAt(other, 'question'));
        expect(nextDueAt(bond('a::p'), 'diary')).toBeNull();
    });
    it('跨午夜的時段', () => {
        expect(inWindow({ from: '22:00', to: '02:00' }, 23 * 60)).toBe(true);
        expect(inWindow({ from: '22:00', to: '02:00' }, 60)).toBe(true);
        expect(inWindow({ from: '22:00', to: '02:00' }, 12 * 60)).toBe(false);
        expect(inWindow(undefined, 5)).toBe(true);
    });
});

import { OUTPUT_CHARS, resolveOutputChars } from './output';
import { buildSlipPrompt, buildSlipReplyPrompt, outputMaxTokens } from './outputPromptCore';
import { buildEssayChoosePrompt } from './essay';

describe('篇幅填字數、文風四種都能填', () => {
    const b = (output: Record<string, unknown>) => ({ output } as any);
    it('自己填的字數優先；沒填照三檔換；顛倒的排回來、超出範圍的夾住', () => {
        expect(resolveOutputChars(undefined, 'diary')).toEqual(OUTPUT_CHARS.diary.medium);
        expect(resolveOutputChars(b({ note: { length: 'long' } }), 'note')).toEqual(OUTPUT_CHARS.note.long);
        expect(resolveOutputChars(b({ note: { length: 'long', chars: [30, 80] } }), 'note')).toEqual([30, 80]);
        expect(resolveOutputChars(b({ essay: { chars: [900, 400] } }), 'essay')).toEqual([400, 900]);
        expect(resolveOutputChars(b({ diary: { chars: [1, 99999] } }), 'diary')).toEqual([10, 5000]);
    });
    it('提示詞：有字數寫字數、有文風多一行；沒給照舊', () => {
        const ctx = { selfName: '煦', otherName: 'Liora' };
        const withChars = buildSlipPrompt({ ...ctx, tags: ['掛念'], chars: [30, 80], style: '像便利貼' });
        expect(withChars).toContain('篇幅：大約 30～80 字');
        expect(withChars).toContain('- 文風：像便利貼（仍以你的個性優先）。');
        const plain = buildSlipPrompt({ ...ctx, tags: ['掛念'], length: 'short' });
        expect(plain).toContain('篇幅：短短的就好');
        expect(plain).not.toContain('文風');
        expect(buildCharAskPrompt({ ...ctx, chars: [20, 60] })).toContain('（篇幅：大約 20～60 字');
        expect(buildCharAnswerPrompt({ ...ctx, question: 'Q', askedByOther: true, style: '直白' })).toContain('- 文風：直白');
        expect(buildSlipReplyPrompt({ ...ctx, slip: { fromName: 'Liora', text: '嗨', tags: [] }, chars: [10, 40] })).toContain('大約 10～40 字');
        const essay = buildEssayChoosePrompt({ ...ctx, candidates: [{ dateText: '11 月', label: '片刻', text: '看電影' }], chars: [300, 700], style: '像散文' });
        expect(essay).toContain('篇幅大約 300～700 字');
        expect(essay).toContain('文風：像散文');
        expect(buildEssayChoosePrompt({ ...ctx, candidates: [] })).not.toContain('篇幅大約');
    });
    it('輸出上限跟著篇幅：短的照下限、長的放寬、封頂 8000', () => {
        expect(outputMaxTokens([20, 100])).toBe(1500);
        expect(outputMaxTokens([500, 2000])).toBe(5000);
        expect(outputMaxTokens([10, 5000])).toBe(8000);
        expect(outputMaxTokens(undefined, 2000)).toBe(2000);
    });
});
