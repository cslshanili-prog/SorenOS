import { describe, expect, it } from 'vitest';
import { buildPactProposalPrompt, canProposePact, extractPactTags, formatBondProposalRecord, guessCheck, parseRepeat, proposalEntry, proposalMeta, proposalStatus } from './pactTags';
import { agreePromise, confirmHabit } from './pact';
import { bondRefFromPact, bondRefPrefix } from './bondRef';
import { newMilestone, newWish, publishWish } from './pact';

describe('角色提議約定／默契的標籤', () => {
    it('剝掉標籤，各收第一個；不寫 ACTION 也認、沒內容不算', () => {
        const r = extractPactTags('那就這樣說好囉\n[[ACTION:BOND_PROMISE|每天睡前互道晚安|每天]]\n[[BOND_HABIT|吵架後我先傳貼圖]]\n[[ACTION:BOND_PROMISE|第二個|每週]]');
        expect(r.cleanedText).toBe('那就這樣說好囉');
        expect(r.promise).toEqual({ kind: 'promise', text: '每天睡前互道晚安', freq: '每天' });
        expect(r.habit).toEqual({ kind: 'habit', text: '吵架後我先傳貼圖' });
        expect(extractPactTags('[[ACTION:BOND_HABIT|]]好').habit).toBeNull();
        expect(extractPactTags('沒有標籤').cleanedText).toBe('沒有標籤');
    });
    it('頻率：看得懂的照寫，看不懂就是一次', () => {
        expect(parseRepeat('每天')).toEqual({ kind: 'daily' });
        expect(parseRepeat('每週三、六')).toEqual({ kind: 'weekly', days: [3, 6] });
        expect(parseRepeat('每週')).toEqual({ kind: 'weekly' });
        expect(parseRepeat('每 3 天')).toEqual({ kind: 'everyNDays', n: 3 });
        expect(parseRepeat('每三天')).toEqual({ kind: 'everyNDays', n: 3 });
        expect(parseRepeat('每月')).toEqual({ kind: 'monthly' });
        expect(parseRepeat('每年 2/14')).toEqual({ kind: 'yearly', date: '02-14' });
        expect(parseRepeat('下次')).toEqual({ kind: 'once' });
        expect(parseRepeat('')).toEqual({ kind: 'once' });
    });
    it('完成依據：重複的像模板就照紀錄判，其他請 AI 讀', () => {
        expect(guessCheck('每天睡前說晚安', { kind: 'daily' })).toMatchObject({ check: { kind: 'record', record: 'goodnight' }, templateId: 'goodnight' });
        expect(guessCheck('下次一起去看海', { kind: 'once' })).toEqual({ check: { kind: 'ai', hint: '下次一起去看海' } });
    });
    it('有空間、不是小號、沒拉黑才教；教的那段只在那時出現', () => {
        expect(canProposePact({}, undefined)).toBe(false);
        expect(canProposePact({ altOf: 'x' }, {})).toBe(false);
        expect(canProposePact({ chatBlock: { by: 'user' } as any }, {})).toBe(false);
        expect(buildPactProposalPrompt({}, undefined, 'Liora')).toBe('');
        expect(buildPactProposalPrompt({}, {}, 'Liora')).toContain('[[ACTION:BOND_PROMISE|約定的內容|頻率]]');
    });
    it('建出來的卡是提議中、角色那邊已經說好；你按好才成立，在羈絆答應也算', () => {
        const e = proposalEntry({ kind: 'promise', text: '每週通一次電話', freq: '每週' }, { bondId: 'c1::p1', charId: 'c1', now: 5 });
        expect(e.author).toBe('c1');
        expect(e.promise).toMatchObject({ state: 'proposed', agreedBy: { char: 5 }, repeat: { kind: 'weekly' }, check: { kind: 'record', record: 'call' } });
        const meta = proposalMeta(e);
        expect(meta).toMatchObject({ kind: 'promise', entryId: e.id, repeatText: '每週', status: 'pending' });
        expect(proposalStatus(meta, e)).toBe('pending');
        expect(proposalStatus(meta, agreePromise(e, 'user', 6))).toBe('accepted');
        expect(proposalStatus(meta, undefined)).toBe('declined');
        const h = proposalEntry({ kind: 'habit', text: '他先說晚安' }, { bondId: 'b', charId: 'c1', now: 1 });
        expect(proposalStatus(proposalMeta(h), confirmHabit(h, 'user', 2))).toBe('accepted');
    });
    it('歷史裡看得到回了沒', () => {
        expect(formatBondProposalRecord({ kind: 'promise', text: '一起看海', repeatText: '一次' }, 'pending')).toBe('[你提議跟對方約定：「一起看海」（一次）]（對方還沒回）');
        expect(formatBondProposalRecord({ kind: 'habit', text: '先低頭' }, 'accepted')).toBe('[你想跟對方確認一個你們的默契：「先低頭」]（對方認了）');
    });
});

describe('帶去聊聊：約定分頁四種', () => {
    const names = { user: 'Liora', char: 'Sully' };
    it('願望草稿不能帶，發布的帶誰的和狀態', () => {
        const w = newWish({ bondId: 'b', author: 'user', owner: 'user', text: '一起看極光', now: 1 });
        expect(bondRefFromPact('b', w, names)).toBeNull();
        const ref = bondRefFromPact('b', publishWish(w, 2), names)!;
        expect(ref).toMatchObject({ kind: 'wish', pactId: w.id });
        expect(bondRefPrefix(ref)).toBe('[從羈絆帶來：〈願望〉Liora的——一起看極光（想做）]');
    });
    it('約定帶頻率、里程碑帶日子', () => {
        const p = proposalEntry({ kind: 'promise', text: '互道晚安', freq: '每天' }, { bondId: 'b', charId: 'c1', now: 1 });
        expect(bondRefPrefix(bondRefFromPact('b', p, names)!)).toBe('[從羈絆帶來：〈約定〉每天——互道晚安（還在商量）]');
        const m = newMilestone({ bondId: 'b', author: 'user', what: 'confession', text: '在河堤', eventDate: { precision: 'day', date: '2026-11-20' }, via: 'manual', now: 1 } as any);
        expect(bondRefFromPact('b', m, names)).toMatchObject({ kind: 'milestone', excerpt: '11 月 20 日，在河堤' });
    });
});

import { buildMomentPickPrompt, buildPactFillPrompt, parseMomentPick, parsePactFill } from './collect';
import { collectedPactEntry } from './pactTags';

describe('從聊天收存成願望、約定、默契', () => {
    it('挑幾件：角色 × 角色的提示詞不變；身份卡 × 角色多三種，解析帶種類', () => {
        const plain = buildMomentPickPrompt({ transcript: 't', leftName: 'L', rightName: 'R' });
        expect(plain).not.toContain('promise');
        expect(buildMomentPickPrompt({ transcript: 't', leftName: 'L', rightName: 'R', withPact: true })).toContain('- habit：');
        const msgs = [{ id: 10 }, { id: 11 }, { id: 12 }];
        const out = parseMomentPick('[{"kind":"promise","title":"晚安","text":"每天互道晚安","freq":"每天","refs":[2]},{"kind":"wish","text":"看極光","owner":"char","refs":[1]},{"kind":"weird","text":"x","refs":[3]}]', msgs);
        expect(out[0]).toMatchObject({ kind: 'promise', freq: '每天', messageIds: [11] });
        expect(out[1]).toMatchObject({ kind: 'wish', owner: 'char' });
        expect(out[2].kind).toBeUndefined();
    });
    it('AI 幫忙填：看不出來就留空', () => {
        expect(buildPactFillPrompt({ kind: 'promise', snippet: 's', leftName: 'L', rightName: 'R' })).toContain('"freq"');
        expect(parsePactFill('{"text":"一起看海","owner":"both"}')).toEqual({ text: '一起看海', owner: 'both' });
        expect(parsePactFill('{"text":"","freq":""}')).toBeNull();
        expect(parsePactFill('亂寫')).toBeNull();
    });
    it('收成的卡：願望直接發布、照誰的記；約定與默契是你提的、等對方', () => {
        const src = { type: 'message' as const, lineId: 'c1', messageIds: [1], snippet: 's', at: 1 };
        const w = collectedPactEntry({ kind: 'wish', bondId: 'b', charId: 'c1', text: '看極光', owner: 'char', source: src, now: 1 });
        expect(w).toMatchObject({ status: 'published', author: 'user', wish: { owner: 'c1', state: 'want' }, sources: [src] });
        const p = collectedPactEntry({ kind: 'promise', bondId: 'b', charId: 'c1', text: '每天睡前說晚安', repeat: { kind: 'daily' }, now: 1 });
        expect(p.promise).toMatchObject({ state: 'proposed', agreedBy: { user: 1 }, check: { kind: 'record', record: 'goodnight' } });
        const h = collectedPactEntry({ kind: 'habit', bondId: 'b', charId: 'c1', text: '他先低頭', now: 1 });
        expect(h.habit).toMatchObject({ state: 'proposed', origin: 'formed', confirmedBy: { user: 1 } });
    });
});

import { buildCharWishPrompt, parseCharWish } from './outputPromptCore';
import { DEFAULT_OUTPUT, OUTPUT_KINDS } from './output';
import { bondOutputLooksValid, parseBondOutputJobId, parseBondOutputResult } from './outputCloudJob';

describe('主動產出：願望', () => {
    it('預設 7～14 天、同步私聊；提示詞帶寫過的，解析分自己的和一起的', () => {
        expect(OUTPUT_KINDS).toContain('wish');
        expect(DEFAULT_OUTPUT.wish.everyDays).toEqual([7, 14]);
        const p = buildCharWishPrompt({ selfName: 'Sully', otherName: 'Liora', wishesBefore: ['一起看海'], withNotice: true } as any);
        expect(p).toContain('- 一起看海');
        expect(p).toContain('"notice"');
        expect(parseCharWish('{"wish":"想學做甜點","owner":"self"}')).toEqual({ wish: '想學做甜點', together: false });
        expect(parseCharWish('{"wish":"一起去看極光","owner":"both"}')).toEqual({ wish: '一起去看極光', together: true });
        expect(parseCharWish('{"owner":"self"}')).toBeNull();
    });
    it('雲端認得這一種', () => {
        expect(parseBondOutputJobId('bond-output|wish|c1::p1')).toEqual({ kind: 'wish', bondId: 'c1::p1' });
        expect(bondOutputLooksValid('wish', '{"wish":"x"}')).toBe(true);
        expect(parseBondOutputResult({ resultKind: 'bond-output', v: 1, bondId: 'b', charId: 'c', kind: 'wish', raw: '{}', dateKey: '2026-11-27' })?.kind).toBe('wish');
    });
});
