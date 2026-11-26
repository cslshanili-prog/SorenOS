import { describe, expect, it } from 'vitest';
import { buildEventScene, cardAvailability, cardDef, cardsForRoute, cardsToUnlock, finishCard, newEventCardEntry, parseEventResult, parseSync, startCard, syncProposalFor } from './eventCards';

describe('事件卡', () => {
    it('三條路線＋未指定各有一套；都有「好好談一次」', () => {
        for (const r of ['romance', 'friendship', 'family', undefined] as const) {
            expect(cardsForRoute(r).some(c => c.result.repair)).toBe(true);
        }
        expect(cardsForRoute('romance').map(c => `${c.title}:${c.unlock}`)).toEqual([
            '專屬邀約:2', '單獨出遊:3', '告白:5', '關係紀念:6', '共同生活:7', '求婚:9', '婚禮:10', '好好談一次:1',
        ]);
        expect(cardDef('romance-confession')!.venue).toBe('date');
    });
    it('能不能演：等級、階段、未修復的傷（好好談一次有傷時不看等級）', () => {
        const confess = cardDef('romance-confession')!;
        expect(cardAvailability(confess, { level: 4, stage: 'ambiguous', hasOpenHurt: false })).toBe('locked');
        expect(cardAvailability(confess, { level: 5, stage: 'friend', hasOpenHurt: false })).toBe('stage');
        expect(cardAvailability(confess, { level: 5, stage: 'ambiguous', hasOpenHurt: true })).toBe('hurt');
        expect(cardAvailability(confess, { level: 5, stage: 'ambiguous', hasOpenHurt: false })).toBe('ok');
        expect(cardAvailability(cardDef('family-talk')!, { level: 1, stage: 'kin', hasOpenHurt: true })).toBe('ok');
        expect(cardAvailability(cardDef('family-talk')!, { level: 1, stage: 'kin', hasOpenHurt: false })).toBe('locked');
    });
    it('等級到了才解鎖，已經有的不重開', () => {
        const got = cardsToUnlock([], 'friendship', 3, false).map(c => c.id);
        expect(got).toEqual(['friendship-latenight', 'friendship-entrust', 'friendship-talk']);
        const have = newEventCardEntry({ bondId: 'b', def: cardDef('friendship-latenight')!, id: 'e1', now: 1 });
        expect(cardsToUnlock([have], 'friendship', 3, false).map(c => c.id)).toEqual(['friendship-entrust', 'friendship-talk']);
    });
    it('開演、還沒（回到解鎖可以再演）、成了（完成），每次都留紀錄', () => {
        const e = newEventCardEntry({ bondId: 'b', def: cardDef('romance-confession')!, id: 'e1', now: 1 });
        const p = startCard(e, 'date', { wishIds: [], itemKeys: [] }, 2);
        expect(p.eventCard).toMatchObject({ state: 'playing', venue: 'date', startedAt: 2 });
        const again = finishCard(p, 'notYet', '他說想再想想', 3);
        expect(again.eventCard!.state).toBe('unlocked');
        const done = finishCard(startCard(again, 'chat', { wishIds: [], itemKeys: [] }, 4), 'yes', '答應了', 5);
        expect(done.eventCard!.state).toBe('done');
        expect(done.eventCard!.history!.map(h => h.result)).toEqual(['notYet', 'yes']);
    });
    it('情境不寫台詞、不保證答應，帶得進願望與回憶', () => {
        const s = buildEventScene({ title: '告白', theme: '心意藏不住', otherName: 'Liora', venue: 'chat', wishes: ['一起看海'], moments: ['河堤散步'], milestones: [] });
        expect(s).toContain('可以拒絕');
        expect(s).toContain('你們想做的事：一起看海');
        expect(s).not.toContain('你們之前的轉折');
    });
    it('演完的整理：只收三種結果', () => {
        expect(parseEventResult('{"result":"yes","summary":"答應了","ids":[2,9]}', 3)).toEqual({ result: 'yes', summary: '答應了', picks: [2] });
        expect(parseEventResult('{"result":"maybe"}', 3)).toBeNull();
    });
});

describe('同步承認', () => {
    it('友情、親情線看到戀愛不問；未指定一併問路線；同階段不問', () => {
        expect(syncProposalFor('together', 'friendship', 'friend')).toBeNull();
        expect(syncProposalFor('together', 'family', 'kin')).toBeNull();
        expect(syncProposalFor('together', undefined, 'friend')).toEqual({ stageTo: 'lovers', routeTo: 'romance' });
        expect(syncProposalFor('together', 'romance', 'ambiguous')).toEqual({ stageTo: 'lovers' });
        expect(syncProposalFor('together', 'romance', 'lovers')).toBeNull();
        expect(syncProposalFor('reconciled', 'family', 'kin')).toEqual({});
        expect(syncProposalFor('none', 'romance', 'friend')).toBeNull();
    });
    it('解析：none 或沒寫發生什麼的不算', () => {
        expect(parseSync('{"what":"none","text":"x"}', 3)).toBeNull();
        expect(parseSync('{"what":"together","text":""}', 3)).toBeNull();
        expect(parseSync('{"what":"together","date":"2026-11-26","text":"他告白、她答應了","ids":[1,3]}', 3)).toEqual({ what: 'together', date: '2026-11-26', text: '他告白、她答應了', picks: [1, 3] });
    });
});

import { bondPromptBlock } from './prompt';
import { blankBond } from './model';

describe('私聊開演的情境進提示詞', () => {
    it('有 eventScene 才帶；沒有一字不差', () => {
        const bond = blankBond('c1::p1', 1);
        expect(bondPromptBlock({ bond, selfName: 'Sully', otherName: 'Liora', entries: [], selfId: 'c1' })).toBe('');
        const out = bondPromptBlock({ bond: { ...bond, eventScene: { entryId: 'e', cardId: 'romance-confession', text: '【這一刻】可能告白', at: 1 } }, selfName: 'Sully', otherName: 'Liora', entries: [], selfId: 'c1' });
        expect(out).toContain('- 【這一刻】可能告白');
    });
});
