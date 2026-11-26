import { describe, expect, it } from 'vitest';
import type { BondFeelingEvent } from '../../types';
import {
    applyFeelingEvent, feelingPromptLines, newFeeling, nextTier, parseFeelingEvents, parseFeelingStart, rawTier, replayFeeling, tierName,
    type FeelingEventInput,
} from './feeling';

const T = 1_800_000_000_000;
let n = 0;
const ctx = (now = T, route?: 'romance' | 'friendship' | 'family') => ({ bondId: 'c1::p1', route, now, newId: () => `id${++n}` });
const ev = (over: Partial<FeelingEventInput>): FeelingEventInput => ({ what: '一件事', category: 'sincere', valence: 1, size: 'small', target: 'both', cause: 'positive', source: 'eval', ...over });

describe('層與緩衝', () => {
    it('六層的下限 0／11／31／51／71／91', () => {
        expect([0, 10, 11, 30, 31, 51, 71, 91, 100].map(rawTier)).toEqual([1, 1, 2, 2, 3, 4, 5, 6, 6]);
    });
    it('升層要過下一層下限 +3、沒有未修復的傷；降層要低於本層下限 −3', () => {
        expect(nextTier(3, 52, true, false)).toBe(3);
        expect(nextTier(3, 54, true, false)).toBe(4);
        expect(nextTier(3, 60, false, false)).toBe(3);
        expect(nextTier(4, 49, true, false)).toBe(4);
        expect(nextTier(4, 47, true, false)).toBe(3);
        expect(nextTier(4, 49, true, true)).toBe(3);
    });
    it('第 5 層照路線叫', () => {
        expect(tierName(5, 'romance')).toBe('熱戀');
        expect(tierName(5, 'friendship')).toBe('摯友');
        expect(tierName(4)).toBe('信賴');
    });
});

describe('照事件動，不照聊天量', () => {
    const f0 = newFeeling({ closeness: 40, trust: 40 }, 'manual', T);
    it('閒聊、問候不記帳', () => {
        expect(applyFeelingEvent(f0, ev({ category: 'chitchat' }), [], ctx())).toBeNull();
    });
    it('同一種正向事件一天內遞減：1、0.5、0.2、0', () => {
        let f = f0; const log: BondFeelingEvent[] = [];
        const got: number[] = [];
        for (let i = 0; i < 4; i++) {
            const r = applyFeelingEvent(f, ev({ category: 'supported', size: 'mid', target: 'trust' }), log, ctx(T + i * 1000));
            got.push(r ? r.event.delta.trust : 0);
            if (r) { f = r.feeling; log.push(r.event); }
        }
        expect(got).toEqual([10, 5, 2, 0]);
    });
    it('禮物、讚美、討好一天合計最多 +3', () => {
        const a = applyFeelingEvent(f0, ev({ category: 'gift', size: 'mid' }), [], ctx())!;
        expect(a.event.delta).toEqual({ closeness: 3, trust: 3 });
        expect(applyFeelingEvent(a.feeling, ev({ category: 'praise' }), [a.event], ctx(T + 1))).toBeNull();
    });
    it('負面照歸因：無心 ×1、惡意 ×1.5（上限 15）、不可抗力 ×0.3', () => {
        const d = (cause: BondFeelingEvent['cause'], size: 'mid' | 'large' = 'mid') => applyFeelingEvent(f0, ev({ category: 'broken', valence: -1, size, target: 'trust', cause }), [], ctx())!.event.delta.trust;
        expect(d('careless')).toBe(-10);
        expect(d('malice')).toBe(-15);
        expect(d('unavoidable')).toBe(-3);
        expect(d('careless', 'large')).toBe(-15);
    });
});

describe('背叛、傷與修復', () => {
    const start = newFeeling({ closeness: 80, trust: 80 }, 'manual', T);
    it('戀愛線劈腿算背叛：信任 −25、親近 −10，記一筆重大的傷、直接照數值降層', () => {
        const r = applyFeelingEvent(start, ev({ what: '跟別人曖昧被發現', category: 'cheating', valence: -1, size: 'large', cause: 'malice' }), [], ctx(T, 'romance'))!;
        expect(r.event.delta).toEqual({ closeness: -10, trust: -25 });
        expect(r.feeling.openHurts).toMatchObject([{ severity: 'major', lost: { closeness: -10, trust: -25 } }]);
        expect(r.feeling.tier).toEqual({ closeness: 4, trust: 4 }); // 信任 80→55，不等緩衝直接掉一層
    });
    it('只有道歉：+2、0、−2；道歉＋補救最多回補 70%，傷標修好', () => {
        const hurt = applyFeelingEvent(start, ev({ what: '說了很傷人的話', category: 'hurt', valence: -1, size: 'mid', cause: 'malice' }), [], ctx())!;
        expect(hurt.event.delta).toEqual({ closeness: -15, trust: -15 });
        const log = [hurt.event];
        let f = hurt.feeling;
        const ds: number[] = [];
        for (let i = 0; i < 3; i++) {
            const r = applyFeelingEvent(f, ev({ category: 'apology', repair: false }), log, ctx(T + (i + 1) * 1000));
            ds.push(r ? r.event.delta.trust : 0);
            if (r) { f = r.feeling; log.push(r.event); }
        }
        expect(ds).toEqual([2, 0, -2]);
        const fix = applyFeelingEvent(f, ev({ category: 'repair', repair: true }), log, ctx(T + 9000))!;
        expect(fix.event.delta).toEqual({ closeness: 11, trust: 11 }); // 15 × 0.7 ≈ 11
        expect(fix.feeling.openHurts[0].repairedAt).toBe(T + 9000);
        expect(fix.event.repairs).toBe(hurt.event.hurt!.id);
    });
    it('有未修復的傷時不升層', () => {
        const hurt = applyFeelingEvent(newFeeling({ closeness: 50, trust: 50 }, 'manual', T), ev({ category: 'deceive', valence: -1, size: 'mid', cause: 'repeated', target: 'trust' }), [], ctx())!;
        const up = applyFeelingEvent({ ...hurt.feeling, closeness: 60 }, ev({ category: 'shared', size: 'small', target: 'closeness' }), [hurt.event], ctx(T + 1))!;
        expect(up.feeling.closeness).toBe(65);
        expect(up.feeling.tier.closeness).toBe(3);
    });
});

describe('事件帳改了重算', () => {
    it('刪掉一筆、改一筆，數值和傷都照帳本重來', () => {
        const f0 = newFeeling({ closeness: 50, trust: 50 }, 'manual', T);
        const a = applyFeelingEvent(f0, ev({ category: 'betrayal', valence: -1, size: 'large', cause: 'malice' }), [], ctx())!;
        const b = applyFeelingEvent(a.feeling, ev({ category: 'shared', size: 'small' }), [a.event], ctx(T + 1))!;
        const del = replayFeeling(f0.start, [{ ...a.event, deletedAt: T + 5 }, b.event]);
        expect(del.feeling.closeness).toBe(55);
        expect(del.feeling.openHurts).toEqual([]);
        const edited = replayFeeling(f0.start, [{ ...a.event, delta: { closeness: -5, trust: -5 } }, b.event]);
        expect(edited.feeling.trust).toBe(50);
        expect(edited.events[1].before).toEqual({ closeness: 45, trust: 45 });
    });
});

describe('提示詞與解析', () => {
    it('只給層和規範、不給數字；有傷時加行為限制；沒開始記時沒有', () => {
        expect(feelingPromptLines(undefined, 'Liora')).toEqual([]);
        const f = { ...newFeeling({ closeness: 75, trust: 40 }, 'manual', T), openHurts: [{ id: 'h', at: T, what: '失約沒說一聲', severity: 'mid' as const, lost: { closeness: 0, trust: -10 } }] };
        const lines = feelingPromptLines(f, 'Liora', 'friendship').join('\n');
        expect(lines).toContain('親近在「摯友」');
        expect(lines).toContain('信任在「友好」');
        expect(lines).not.toMatch(/75|40/);
        expect(lines).toContain('還沒修復的事：失約沒說一聲');
        expect(lines).toContain('不獨佔、不曖昧');
    });
    it('解析評估裡的 bondFeeling：類別決定正負、壞欄位丟掉', () => {
        const got = parseFeelingEvents({ bondFeeling: { events: [
            { what: '她記得我說過的話', category: 'understood', size: 'mid', target: 'closeness' },
            { what: '答應的事沒做', category: 'broken', valence: 1, size: 'huge', cause: 'positive' },
            { what: '', category: 'hurt' },
            { what: 'x', category: 'unknown' },
        ] } });
        expect(got).toEqual([
            { what: '她記得我說過的話', category: 'understood', valence: 1, size: 'mid', target: 'closeness', cause: 'positive', repair: false, source: 'eval' },
            { what: '答應的事沒做', category: 'broken', valence: -1, size: 'small', target: 'both', cause: 'careless', repair: false, source: 'eval' },
        ]);
        expect(parseFeelingStart({ closeness: 120, trust: '65', why: 'x' })).toEqual({ closeness: 100, trust: 65, why: 'x' });
    });
});

import { bondPromptBlock } from './prompt';
import { blankBond } from './model';

describe('關係段帶親近與信任', () => {
    it('沒開始記一字不差；開始記了帶層與規範', () => {
        const bond = blankBond('c1::p1', T);
        const base = bondPromptBlock({ bond, selfName: 'Sully', otherName: 'Liora', entries: [], selfId: 'c1' });
        expect(base).toBe('');
        const out = bondPromptBlock({ bond: { ...bond, feeling: newFeeling({ closeness: 60, trust: 35 }, 'manual', T) }, selfName: 'Sully', otherName: 'Liora', entries: [], selfId: 'c1' });
        expect(out).toContain('### 你和Liora的關係');
        expect(out).toContain('親近在「信賴」');
        expect(out).toContain('信任在「友好」');
    });
});
