import { describe, expect, it } from 'vitest';
import {
    agreePromise, completeWish, confirmHabit, editPromise, habitWaitingOn, linkWishToPromise, newHabit, newMilestone, newPromise, newWish,
    promiseWaitingOn, publishWish, replyHabit, replyPromise, repeatLabel, retireHabit, setWishState, supportWish, wishBucket,
} from './pact';
import { knownHabits, knownMilestones, knownPromises, knownWishes } from './visibility';
import { buildHabitReplyPrompt, buildPromiseReplyPrompt, buildWishReplyPrompt, parseHabitReply, parsePromiseReply, parseWishReply } from './outputPromptCore';

const B = 'c1::p1';
const T = 1_800_000_000_000;

describe('願望：看見不等於答應', () => {
    it('草稿只有寫的人知道，發布了才進提示詞', () => {
        const w = newWish({ bondId: B, author: 'user', owner: 'user', text: '想去看一次海', now: T });
        expect(w.status).toBe('draft');
        expect(knownWishes([w])).toEqual([]);
        const p = publishWish(w, T + 1);
        expect(knownWishes([p])).toEqual([{ owner: 'user', text: '想去看一次海', state: 'want', at: T + 1 }]);
    });
    it('支持不會讓願望變成約好；談成約定才是「已約好」；完成連拾光', () => {
        const w = publishWish(newWish({ bondId: B, author: 'user', owner: 'both', text: '一起看海', now: T }), T);
        const s = supportWish(w, 'c1', '好啊，等天氣好', true, T + 1);
        expect(s.wish!.state).toBe('want');
        expect(s.wish!.support).toEqual({ by: 'c1', at: T + 1, words: '好啊，等天氣好', together: true });
        expect(knownWishes([s])[0]).toMatchObject({ owner: 'both', supportedBy: 'char' });
        const linked = linkWishToPromise(s, 'pr1', T + 2);
        expect(linked.wish).toMatchObject({ state: 'agreed', promiseId: 'pr1' });
        const done = completeWish(linked, [{ type: 'entry', id: 'm1' }], T + 3);
        expect(done.wish).toMatchObject({ state: 'done', doneAt: T + 3 });
        expect(done.links).toEqual([{ type: 'entry', id: 'm1' }]);
        expect(setWishState(done, 'shelved', T + 4).wish).toEqual({ owner: 'both', state: 'shelved', support: s.wish!.support, promiseId: 'pr1' });
    });
    it('分欄：我的／TA 的／我們的', () => {
        expect(wishBucket(newWish({ bondId: B, author: 'user', owner: 'user', text: 'a' }))).toBe('mine');
        expect(wishBucket(newWish({ bondId: B, author: 'c1', owner: 'c1', text: 'a' }))).toBe('theirs');
        expect(wishBucket(newWish({ bondId: B, author: 'user', owner: 'both', text: 'a' }))).toBe('ours');
    });
});

describe('共同約定：雙方都說好才成立', () => {
    const mk = () => newPromise({ bondId: B, author: 'user', text: '每天睡前說晚安', repeat: { kind: 'daily' }, check: { kind: 'record', record: 'goodnight' }, points: 10, participants: ['user', 'c1'], now: T });
    it('提的人算說好，等對方；對方答應才成立', () => {
        const p = mk();
        expect(p.promise).toMatchObject({ state: 'proposed', agreedBy: { user: T } });
        expect(promiseWaitingOn(p)).toBe('char');
        expect(knownPromises([p])).toEqual({ active: [], proposed: [{ text: '每天睡前說晚安', waitingOn: 'char' }] });
        const no = replyPromise(p, 'c1', 'no', '我常常很晚睡，怕做不到', T + 1);
        expect(no.promise!.state).toBe('proposed');
        const yes = replyPromise(p, 'c1', 'yes', '好，我會記得', T + 1);
        expect(yes.promise).toMatchObject({ state: 'active', agreedBy: { user: T, char: T + 1 } });
        expect(knownPromises([yes]).active).toMatchObject([{ text: '每天睡前說晚安', repeat: { kind: 'daily' } }]);
    });
    it('角色提的要你按好；提議中改了內容等於重新提', () => {
        const p = newPromise({ bondId: B, author: 'c1', text: '週末一起散步', repeat: { kind: 'weekly', days: [6] }, check: { kind: 'manual' }, participants: ['user', 'c1'], now: T });
        expect(promiseWaitingOn(p)).toBe('user');
        const edited = editPromise(agreePromise({ ...p }, 'char', T), { text: '週日一起散步' }, 'user', T + 1);
        expect(edited.promise!.agreedBy).toEqual({ user: T + 1 });
        expect(promiseWaitingOn(edited)).toBe('char');
        expect(agreePromise(p, 'user', T + 2).promise!.state).toBe('active');
        expect(editPromise(mk(), { points: null }, 'user').promise!.points).toBeUndefined();
    });
    it('頻率文字', () => {
        expect(repeatLabel({ kind: 'weekly', days: [1, 3] })).toBe('每週一、三');
        expect(repeatLabel({ kind: 'yearly', date: '02-14' })).toBe('每年 2 月 14 日');
        expect(repeatLabel({ kind: 'everyNDays', n: 3 })).toBe('每 3 天');
    });
});

describe('默契：雙方確認才算', () => {
    it('單方的是提議中、不進提示詞；對方認了才是默契；不再這樣不進提示詞', () => {
        const h = newHabit({ bondId: B, author: 'user', text: '先到家的人傳窗外照片', now: T });
        expect(habitWaitingOn(h)).toBe('char');
        expect(knownHabits([h])).toEqual([]);
        expect(knownHabits([replyHabit(h, 'c1', 'no', '有嗎？', T + 1)])).toEqual([]);
        const ok = replyHabit(h, 'c1', 'yes', '……嗯，算是吧', T + 1);
        expect(ok.habit!.state).toBe('active');
        expect(knownHabits([ok])).toEqual(['先到家的人傳窗外照片']);
        expect(knownHabits([retireHabit(ok, true)])).toEqual([]);
        expect(retireHabit(retireHabit(ok, true), false).habit!.state).toBe('active');
        expect(confirmHabit(newHabit({ bondId: B, author: 'c1', text: 'x' }), 'user').habit!.state).toBe('active');
    });
});

describe('里程碑', () => {
    it('照事件日期排，最近的在前', () => {
        const a = newMilestone({ bondId: B, author: 'user', what: 'confession', text: '在屋頂說的', eventDate: { precision: 'day', date: '2026-10-01' }, via: 'manual', now: T });
        const b = newMilestone({ bondId: B, author: 'user', what: 'together', text: '', eventDate: { precision: 'day', date: '2026-11-01' }, via: 'manual', now: T });
        const c = newMilestone({ bondId: B, author: 'user', what: 'firstDate', text: '', eventDate: { precision: 'unknown' }, via: 'manual', now: T });
        expect(knownMilestones([a, c, b]).map(e => e.milestone!.what)).toEqual(['together', 'confession', 'firstDate']);
    });
});

describe('角色的回應：提示詞與解析', () => {
    const ctx = { selfName: '煦', otherName: 'Liora' };
    it('提示詞不暗示要答應；解析認得三種', () => {
        const w = buildWishReplyPrompt({ ...ctx, wish: '想學潛水', owner: 'user' });
        expect(w).toContain('看見不等於答應');
        expect(w).toContain('Liora自己的');
        expect(buildPromiseReplyPrompt({ ...ctx, promise: '每天晚安', repeatText: '每天' })).toContain('不要因為對方提了就一定答應');
        expect(buildHabitReplyPrompt({ ...ctx, habit: '輪流選歌' })).toContain('不要為了讓對方開心而承認沒發生過的事');
        expect(parseWishReply('{"stance":"together","words":"我也想"}')).toEqual({ stance: 'together', words: '我也想' });
        expect(parseWishReply('{"stance":"??","words":"嗯"}')).toEqual({ stance: 'neutral', words: '嗯' });
        expect(parsePromiseReply('```json\n{"answer":"tweak","words":"改成週末"}\n```')).toEqual({ answer: 'tweak', words: '改成週末' });
        expect(parsePromiseReply('{"answer":"maybe","words":"x"}')).toBeNull();
        expect(parseHabitReply('{"answer":"no","words":"有嗎"}')).toEqual({ answer: 'no', words: '有嗎' });
    });
});

import { bondPromptBlock } from './prompt';
import type { BondRecord } from '../../types';

describe('提示詞【你們的約定】', () => {
    const bond = { id: B, kind: 'persona', charId: 'c1', personaKey: 'p1', stage: 'friend', openedAt: T, openedBy: 'auto', routeLog: [], days: {} } as unknown as BondRecord;
    it('沒有約定類的卡時一字不差；只有草稿的願望也一字不差', () => {
        const base = bondPromptBlock({ bond, selfName: 'Sully', otherName: 'Liora', entries: [], selfId: 'c1' });
        const draft = newWish({ bondId: B, author: 'user', owner: 'user', text: '想去看海', now: T });
        expect(bondPromptBlock({ bond, selfName: 'Sully', otherName: 'Liora', entries: [draft], selfId: 'c1' })).toBe(base);
        expect(base).toBe('');
    });
    it('願望、約定、默契、里程碑照知情範圍帶進去', () => {
        const wish = supportWish(publishWish(newWish({ bondId: B, author: 'user', owner: 'both', text: '一起看海', now: T }), T), 'c1', '好', false, T + 1);
        const active = agreePromise(newPromise({ bondId: B, author: 'user', text: '每天說晚安', repeat: { kind: 'daily' }, check: { kind: 'manual' }, participants: ['user', 'c1'], now: T }), 'char', T + 2);
        const mine = newPromise({ bondId: B, author: 'user', text: '每週通一次電話', repeat: { kind: 'weekly' }, check: { kind: 'manual' }, participants: ['user', 'c1'], now: T + 3 });
        const habitOn = confirmHabit(newHabit({ bondId: B, author: 'user', text: '先到家的傳窗外照片', origin: 'formed', now: T }), 'char', T + 4);
        const habitOff = newHabit({ bondId: B, author: 'user', text: '還沒認的', origin: 'agreed', now: T });
        const ms = newMilestone({ bondId: B, author: 'user', what: 'firstDate', text: '在河堤', eventDate: { precision: 'day', date: '2026-05-01' }, via: 'manual', now: T });
        const out = bondPromptBlock({ bond, selfName: 'Sully', otherName: 'Liora', selfId: 'c1', entries: [wish, active, mine, habitOn, habitOff, ms] });
        expect(out).toContain('Liora說是你們倆的：一起看海（想做；你表示支持）');
        expect(out).toContain('  - 每天：每天說晚安');
        expect(out).toContain('還在商量：每週通一次電話（Liora提的，等你說好不好）');
        expect(out).toContain('  - 先到家的傳窗外照片');
        expect(out).not.toContain('還沒認的');
        expect(out).toContain("2026-05-01｜第一次單獨約會：在河堤");
    });
});
