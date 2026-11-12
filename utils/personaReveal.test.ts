import { describe, expect, it } from 'vitest';
import type { CharacterProfile, PersonaLink, UserProfile } from '../types';
import {
    buildSuspectPrompt, describeDiscovered, extractSuspicion, formatPersonaRevealRecord, nextAltKnowledge, resolveSuspicion,
    buildDiscoveredMeta,
} from './personaReveal';
import { lineFor, lineView } from './chatLine';

const card = (id: string, name: string) => ({ id, name, avatar: '', bio: '', createdAt: 0, updatedAt: 0 });
const alt: PersonaLink = { id: 'L1', kind: 'alt', a: 'pA', b: 'pB', createdAt: 0 };
const base = { name: '我', avatar: '', bio: '', personas: [card('pA', '小星'), card('pB', '月月'), card('pC', '小雨')], personaLinks: [alt] } as unknown as UserProfile;
const char = (extra: Partial<CharacterProfile> = {}): CharacterProfile =>
    ({ id: 'c1', name: '阿澈', avatar: '', description: '', systemPrompt: '', memories: [], primaryPersonaKey: 'pA', knownPersonaKeys: ['pA', 'pB', 'pC'], ...extra } as CharacterProfile);
const onB = (c: CharacterProfile) => lineView(c, lineFor(c, 'pB'));

describe('extractSuspicion', () => {
    it('剝掉標籤、認全形標點和中文別名，理由可省', () => {
        expect(extractSuspicion('你是不是……\n[[ACTION：SUSPECT｜小星｜說話方式一樣]]')).toEqual({ cleanedText: '你是不是……', suspicion: { name: '小星', reason: '說話方式一樣' } });
        expect(extractSuspicion('[[ACTION:懷疑|「小星」]]').suspicion).toEqual({ name: '小星', reason: '' });
        expect(extractSuspicion('沒有標籤').suspicion).toBeNull();
    });
});

describe('resolveSuspicion', () => {
    it('猜中有連結的那張：帶 linkId，卡上能承認', () => {
        const meta = resolveSuspicion(onB(char()), base, { name: '小星', reason: '' })!;
        expect(meta).toMatchObject({ kind: 'suspect', guessKey: 'pA', guessName: '小星', linkId: 'L1', status: 'pending' });
    });
    it('猜錯（沒有連結）：沒有 linkId，只能否認', () => {
        const meta = resolveSuspicion(onB(char()), base, { name: '小雨', reason: '' })!;
        expect(meta.kind).toBe('suspect');
        expect((meta as any).linkId).toBeUndefined();
    });
    it('名字對不上他認識的卡、猜的是自己、已經知道：都不落卡', () => {
        expect(resolveSuspicion(onB(char()), base, { name: '路人甲', reason: '' })).toBeNull();
        expect(resolveSuspicion(onB(char()), base, { name: '月月', reason: '' })).toBeNull();
        expect(resolveSuspicion(onB(char({ altKnowledge: { L1: { state: 'known', since: 0 } } })), base, { name: '小星', reason: '' })).toBeNull();
    });
    it('否認過還能再懷疑', () => {
        const c = char({ altKnowledge: { L1: { state: 'denied', at: 0, times: 1 } } });
        expect(resolveSuspicion(onB(c), base, { name: '小星', reason: '' })).not.toBeNull();
    });
});

describe('承認／否認之後', () => {
    it('承認＝發現；否認次數累加', () => {
        expect(nextAltKnowledge(undefined, 'admitted', 5)).toEqual({ state: 'discovered', at: 5, how: 'admitted' });
        expect(nextAltKnowledge(undefined, 'denied', 5)).toEqual({ state: 'denied', at: 5, times: 1 });
        expect(nextAltKnowledge({ state: 'denied', at: 1, times: 2 }, 'denied', 5)).toEqual({ state: 'denied', at: 5, times: 3 });
    });
    it('歷史裡的記錄形態帶上狀態；發現卡講清楚是誰', () => {
        expect(formatPersonaRevealRecord({ kind: 'suspect', guessName: '小星', status: 'denied' } as any)).toContain('status=對方否認了');
        const meta = buildDiscoveredMeta(base, alt, 'pB', 'revealed') as any;
        expect(meta).toMatchObject({ hereName: '月月', otherName: '小星' });
        expect(describeDiscovered(meta)).toContain('原來「小星」就是「月月」');
    });
});

describe('buildSuspectPrompt', () => {
    it('認識兩張以上才教，列出的是其他認識的卡，不透露哪兩張有連結', () => {
        const p = buildSuspectPrompt(onB(char()), base);
        expect(p).toContain('你也認識「小星」、「小雨」');
        expect(p).toContain('[[ACTION:SUSPECT|');
        expect(p).not.toContain('小號');
        expect(buildSuspectPrompt(char({ knownPersonaKeys: ['pA'] }), base)).toBe('');
    });
});
