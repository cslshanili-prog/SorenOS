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
