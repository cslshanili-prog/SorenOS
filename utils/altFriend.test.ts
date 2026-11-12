import { describe, expect, it } from 'vitest';
import type { CharacterProfile } from '../types';
import { altRequestStatusText, buildOwnerAltPrompt, canOpenAlt, decideAltRequest, dueAltRequests, extractAltTags, planAltRequest, resolveAltAdd } from './altFriend';

const owner = { id: 'c1', name: '阿澈' } as CharacterProfile;
const alt = (patch: Partial<CharacterProfile> = {}) => ({ id: 'x1', name: '夜航', altOf: 'c1', altCreatedBy: 'char', ...patch }) as CharacterProfile;

describe('排申請', () => {
    it('第一次 10～40 分鐘後、被拒之後 5～20 分鐘後；好友、封鎖不排', () => {
        expect(planAltRequest(undefined, { personaKey: 'pA', greeting: '「嗨」', now: 0, rand: 0 })).toEqual({ personaKey: 'pA', greeting: '嗨', at: 600_000, status: 'pending' });
        const rejected = decideAltRequest({ personaKey: 'pA', greeting: '嗨', at: 0, status: 'pending' }, 'reject', 5);
        expect(rejected).toMatchObject({ status: 'rejected', rejectCount: 1, lastRejectedGreeting: '嗨' });
        expect(planAltRequest(rejected, { personaKey: 'pA', greeting: '再試一次', now: 0, rand: 1 })).toMatchObject({ at: 1_200_000, rejectCount: 1, status: 'pending' });
        expect(planAltRequest({ ...rejected, status: 'blocked' }, { personaKey: 'pA', greeting: 'x', now: 0 })).toBeNull();
        expect(planAltRequest({ ...rejected, status: 'accepted' }, { personaKey: 'pA', greeting: 'x', now: 0 })).toBeNull();
    });
    it('到了才出現；狀態文字', () => {
        const a = alt({ altFriendRequest: { personaKey: 'pA', greeting: '', at: 100, status: 'pending' } });
        expect(dueAltRequests([a], 99)).toEqual([]);
        expect(dueAltRequests([a], 100)).toEqual([a]);
        expect(altRequestStatusText(a, 0)).toBe('約 1 分鐘後來加你');
        expect(altRequestStatusText(a, 200)).toBe('等你回覆');
        expect(altRequestStatusText(alt(), 0)).toBe('還沒來加你');
        expect(altRequestStatusText(alt({ altUserFriend: true }), 0)).toBe('已經是你的好友');
    });
});

describe('標籤', () => {
    it('OPEN_ALT／ALT_ADD 剝掉並取第一個', () => {
        const r = extractAltTags('晚安\n[[ACTION:OPEN_ALT|雨夜|只在半夜出沒|想偷偷關心她|你好呀]]\n[[ACTION：小號加好友｜夜航｜嗨]]');
        expect(r.cleanedText).toBe('晚安');
        expect(r.openAlt).toEqual({ name: '雨夜', brief: '只在半夜出沒', purpose: '想偷偷關心她', greeting: '你好呀' });
        expect(r.altAdd).toEqual({ name: '夜航', greeting: '嗨' });
        expect(extractAltTags('沒有標籤')).toEqual({ cleanedText: '沒有標籤', openAlt: null, altAdd: null, reveal: null });
        expect(extractAltTags('[[ACTION:OPEN_ALT]]').openAlt).toBeNull();
    });
    it('開不開得了、加的是哪個', () => {
        expect(canOpenAlt(owner, [owner, alt()], '雨夜')).toBe(true);
        expect(canOpenAlt(owner, [owner, alt()], '夜航')).toBe(false);
        expect(canOpenAlt({ ...owner, altSelfLimit: 1 }, [owner, alt()], '雨夜')).toBe(false);
        expect(resolveAltAdd('c1', [owner, alt()], '夜航')?.id).toBe('x1');
        expect(resolveAltAdd('c1', [owner, alt({ altUserFriend: true })], '夜航')).toBeNull();
        expect(resolveAltAdd('c1', [owner, alt({ altFriendRequest: { personaKey: 'p', greeting: '', at: 0, status: 'blocked' } })], '夜航')).toBeNull();
    });
});

describe('本人私聊「你的小號」', () => {
    it('列狀態、教 ALT_ADD；有名額才教 OPEN_ALT', () => {
        const p = buildOwnerAltPrompt(owner, [owner, alt({ altPurpose: '接近她', altFriendRequest: { personaKey: 'p', greeting: '嗨', at: 0, status: 'rejected', rejectCount: 2, lastRejectedGreeting: '嗨' } })], '小星');
        expect(p).toContain('「夜航」；你開它是因為：接近她；加小星好友被拒絕了，小星拒絕過 2 次（上次你說「嗨」）');
        expect(p).toContain('ALT_ADD');
        expect(p).toContain('還能開 2 個');
        expect(buildOwnerAltPrompt({ ...owner, altSelfLimit: 0 }, [owner], '小星')).toBe('');
        expect(buildOwnerAltPrompt({ ...owner, altSelfLimit: 0 }, [owner, alt()], '小星')).not.toContain('OPEN_ALT');
    });
});

describe('說出來（7d）', () => {
    it('ALT_REVEAL 剝掉；本人寫帶名字、小號寫不帶', () => {
        expect(extractAltTags('其實是我\n[[ACTION:ALT_REVEAL|夜航]]')).toMatchObject({ cleanedText: '其實是我', reveal: { name: '夜航' } });
        expect(extractAltTags('[[ACTION:ALT_REVEAL]]').reveal).toEqual({ name: '' });
    });
    it('本人那段：被認出來的寫清楚、懷疑過的寫次數', () => {
        const p = buildOwnerAltPrompt(owner, [owner, alt({ altRevealed: { at: 1, how: 'admitted' } }), alt({ id: 'x2', name: '雨夜', altUserFriend: true, altDenied: { times: 2, lastAt: 1 } })], '小星');
        expect(p).toContain('「夜航」；小星已經知道它是你了');
        expect(p).toContain('已經是小星的好友；小星懷疑過 2 次它就是你，你都沒認');
        expect(p).toContain('ALT_REVEAL|小號名');
    });
});
