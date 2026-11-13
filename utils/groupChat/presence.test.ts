import { describe, expect, it } from 'vitest';
import type { CharacterProfile, Message, PersonaLink, UserProfile } from '../../types';
import {
    defaultSpeakingKey, focalKnownKey, memberPresence, memberVisibleGroupMessages, presentPersonaKeys,
} from './presence';
import { presentLinkLines } from '../personaLinks';
import { buildMemberTimeline } from './timeline';
import { claimantPersonaKey, claimPacket, makePacketMeta, normalizeLegacyUserPacket, userClaimantId } from './redpacket';
import { REAL_IDENTITY_PERSONA_ID } from '../userPersona';

const card = (id: string, name: string) => ({ id, name, avatar: '', bio: '', createdAt: 0, updatedAt: 0 });
const base = (extra: Partial<UserProfile> = {}) => ({
    name: '我', avatar: '', bio: '',
    personas: [card('pA', '姊姊'), card('pB', '妹妹'), card('pC', '小號')],
    // 自動挑的那張：群單獨指定 pA（成員多數要看全域身份與預覽開關，這裡固定住）
    perGroupPersonaIds: { g1: 'pA' },
    ...extra,
} as unknown as UserProfile);
const group = (extra: Record<string, unknown> = {}) => ({ id: 'g1', members: ['c1', 'c2'], ...extra });
const char = (id: string, known: string[], primary = known[0]): CharacterProfile =>
    ({ id, name: id, knownPersonaKeys: known, primaryPersonaKey: primary } as CharacterProfile);
const userMsg = (id: number, key?: string, extra: Record<string, unknown> = {}): Message =>
    ({ id, charId: 'user', groupId: 'g1', role: 'user', type: 'text', content: `u${id}`, timestamp: id, metadata: { ...(key ? { personaKey: key } : {}), ...extra } } as Message);
const charMsg = (id: number, charId: string): Message =>
    ({ id, charId, groupId: 'g1', role: 'assistant', type: 'text', content: `c${id}`, timestamp: id } as Message);

describe('在場的身份', () => {
    const chars = [char('c1', ['pA']), char('c2', ['pA'])];

    it('沒設：自動一張（成員多數認識的）', () => {
        expect(presentPersonaKeys(base(), group(), chars, true)).toEqual(['pA']);
    });
    it('設了好幾張：照設的、去重、濾掉刪掉的卡', () => {
        const p = base({ groupPresence: { g1: ['pA', 'pB', 'pA', 'gone'] } });
        expect(presentPersonaKeys(p, group(), chars, true)).toEqual(['pA', 'pB']);
    });
    it('設成空陣列：旁觀', () => {
        expect(presentPersonaKeys(base({ groupPresence: { g1: [] } }), group(), chars, true)).toEqual([]);
    });
    it('設的卡都被刪了：回到自動，不會默默變旁觀', () => {
        expect(presentPersonaKeys(base({ groupPresence: { g1: ['gone'] } }), group(), chars, true)).toEqual(['pA']);
    });
    it('沒設、群開著舊的隱身圍觀：旁觀', () => {
        expect(presentPersonaKeys(base(), group({ userLurkMode: true }), chars, true)).toEqual([]);
    });
    it('預覽關著：不看 groupPresence', () => {
        const p = base({ groupPresence: { g1: ['pA', 'pB'] } });
        expect(presentPersonaKeys(p, group(), chars, false)).toEqual(['pA']);
    });
    it('真實身份也能在場', () => {
        const p = base({ groupPresence: { g1: [REAL_IDENTITY_PERSONA_ID, 'pB'] } });
        expect(presentPersonaKeys(p, group(), chars, true)).toEqual([REAL_IDENTITY_PERSONA_ID, 'pB']);
    });
});

describe('角色看得到的群訊息', () => {
    const msgs = [userMsg(1, 'pA'), userMsg(2, 'pA', { offstage: true }), charMsg(3, 'c1')];
    it('在場時只藏旁觀那陣子打的', () => {
        expect(memberVisibleGroupMessages(msgs, false).map(m => m.id)).toEqual([1, 3]);
    });
    it('旁觀中你的話全藏', () => {
        expect(memberVisibleGroupMessages(msgs, true).map(m => m.id)).toEqual([3]);
    });
});

describe('成員怎麼看在場的你', () => {
    it('分成認識的和群友', () => {
        expect(memberPresence(char('c1', ['pA', 'pC']), ['pA', 'pB'])).toEqual({ known: ['pA'], strangers: ['pB'] });
    });
    it('認識好幾張：主看最近在群裡說話的那張（旁觀時打的不算）', () => {
        const c = char('c1', ['pA', 'pB'], 'pA');
        const msgs = [userMsg(1, 'pA'), userMsg(2, 'pB'), userMsg(3, 'pA', { offstage: true })];
        expect(focalKnownKey(c, ['pA', 'pB'], msgs, 'pA')).toBe('pB');
    });
    it('都沒說過話：主線（在場的話），否則第一張', () => {
        expect(focalKnownKey(char('c1', ['pA', 'pB'], 'pB'), ['pA', 'pB'], [], 'pA')).toBe('pB');
        expect(focalKnownKey(char('c1', ['pA', 'pB', 'pC'], 'pC'), ['pA', 'pB'], [], 'pA')).toBe('pA');
    });
    it('一張都不認識：沒有主看的', () => {
        expect(focalKnownKey(char('c1', ['pC']), [], [userMsg(1, 'pA')], 'pA')).toBeUndefined();
    });
});

describe('發訊息用哪張卡', () => {
    it('你上一則用的那張（還在場的話）', () => {
        expect(defaultSpeakingKey(['pA', 'pB'], [userMsg(1, 'pA'), userMsg(2, 'pB')])).toBe('pB');
    });
    it('上一則那張不在場了：第一張', () => {
        expect(defaultSpeakingKey(['pA', 'pB'], [userMsg(1, 'pC')])).toBe('pA');
    });
    it('旁觀：沒有', () => {
        expect(defaultSpeakingKey([], [userMsg(1, 'pA')])).toBeUndefined();
    });
});

describe('在場的人之間的連結', () => {
    const sis: PersonaLink = { id: 'L1', kind: 'sameWorld', a: 'pA', b: 'pB', aToB: '姊姊', bToA: '妹妹', createdAt: 0 };
    const alt: PersonaLink = { id: 'L2', kind: 'alt', a: 'pA', b: 'pC', createdAt: 0 };
    const p = base({ personaLinks: [sis, alt] });

    it('互相認識：認識其中一張就說', () => {
        const lines = presentLinkLines(char('c1', ['pA']), p, ['pA', 'pB']);
        expect(lines[0]).toContain('在場的「姊姊」是「妹妹」的姊姊');
    });
    it('互相認識：兩張都不認識就不說', () => {
        expect(presentLinkLines(char('c1', ['pC']), p, ['pA', 'pB'])).toEqual([]);
    });
    it('小號：不知道是同一個人就什麼都不提', () => {
        expect(presentLinkLines(char('c1', ['pA', 'pC']), p, ['pA', 'pC'])).toEqual([]);
    });
    it('小號：知道才說', () => {
        const c = { ...char('c1', ['pA', 'pC']), altKnowledge: { L2: { state: 'known' as const, since: 0 } } };
        expect(presentLinkLines(c, p, ['pA', 'pC'])[0]).toContain('其實是同一個人的兩個身份');
    });
    it('只有一張在場：不說', () => {
        expect(presentLinkLines(char('c1', ['pA']), p, ['pA'])).toEqual([]);
    });
});

describe('成員時間線：好幾條私聊線', () => {
    it('主私聊和另一條都標名字，用戶那行寫卡名', () => {
        const priv = (id: number, role: Message['role']) => ({ id, charId: 'c1', role, type: 'text', content: `p${id}`, timestamp: id } as Message);
        const text = buildMemberTimeline({
            privateMsgs: [priv(1, 'user')],
            privateName: '姊姊',
            extraPrivate: [{ msgs: [priv(2, 'user')], name: '妹妹' }],
            groupMsgs: [],
            cap: 10,
            resolveSpeaker: () => '?',
        });
        expect(text).toContain('[私聊·姊姊]');
        expect(text).toContain('姊姊: p1');
        expect(text).toContain('[私聊·妹妹]');
        expect(text).toContain('妹妹: p2');
    });
    it('沒給名字照舊', () => {
        const text = buildMemberTimeline({
            privateMsgs: [{ id: 1, charId: 'c1', role: 'user', type: 'text', content: 'hi', timestamp: 1 } as Message],
            groupMsgs: [], cap: 10, resolveSpeaker: () => '?',
        });
        expect(text).toContain('[私聊]');
        expect(text).toContain('用戶: hi');
    });
});

describe('紅包：每張在場的卡各算一個人', () => {
    it('兩張卡各搶一次', () => {
        const meta = makePacketMeta({ packetType: 'lucky', totalAmount: 10, shares: 3, now: 0 });
        const r1 = claimPacket(meta, userClaimantId('pA'), 1, 'claim', () => 0.5);
        expect(r1.ok).toBe(true);
        if (!r1.ok) return;
        const again = claimPacket(r1.meta, userClaimantId('pA'), 2);
        expect(again.ok).toBe(false);
        expect(claimPacket(r1.meta, userClaimantId('pB'), 2).ok).toBe(true);
    });
    it('舊資料的 user 算群裡第一張', () => {
        const meta = { ...makePacketMeta({ packetType: 'lucky', totalAmount: 10, shares: 3, now: 0 }), claims: [{ claimantId: 'user', amount: 1, at: 0 }] };
        const norm = normalizeLegacyUserPacket(meta, 'pA');
        expect(norm.claims[0].claimantId).toBe('user:pA');
        expect(claimPacket(norm, userClaimantId('pA'), 1).ok).toBe(false);
        expect(claimantPersonaKey('user', 'pA')).toBe('pA');
        expect(claimantPersonaKey('user:pB', 'pA')).toBe('pB');
        expect(claimantPersonaKey('c1', 'pA')).toBeUndefined();
    });
});
