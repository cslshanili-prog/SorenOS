import { describe, expect, it } from 'vitest';
import type { CharacterProfile, UserProfile } from '../types';
import {
    LINE_VIEW_PERSONA, lineFor, lineKey, linePatchForChar, linePersonaKey, lineView, lineViewPersonaKey,
    primaryLine, splitLinePatch, withLineFields,
} from './chatLine';
import { REAL_IDENTITY_PERSONA_ID } from './userPersona';

const char = (extra: Partial<CharacterProfile> = {}): CharacterProfile =>
    ({ id: 'c1', name: '阿澈', avatar: '', description: '', systemPrompt: '', memories: [], ...extra } as CharacterProfile);

const profile = (extra: Partial<UserProfile> = {}): UserProfile =>
    ({ name: '我', avatar: '', bio: '', ...extra } as UserProfile);

describe('withLineFields', () => {
    it('舊角色用它現在認識的那張卡補上主線', () => {
        const base = profile({ personas: [{ id: 'p1', name: '小星', avatar: '', bio: '', createdAt: 0, updatedAt: 0 }], perCharPersonaIds: { c1: 'p1' } });
        const filled = withLineFields(base, char());
        expect(filled.primaryPersonaKey).toBe('p1');
        expect(filled.knownPersonaKeys).toEqual(['p1']);
        expect(withLineFields(profile(), char()).primaryPersonaKey).toBe(REAL_IDENTITY_PERSONA_ID);
    });

    it('已經補過就原樣回傳同一個物件', () => {
        const c = char({ primaryPersonaKey: 'p1', knownPersonaKeys: ['p1', 'p2'] });
        expect(withLineFields(profile(), c)).toBe(c);
    });

    it('認識的清單裡沒有主線就補在最前面', () => {
        const filled = withLineFields(profile(), char({ primaryPersonaKey: 'p1', knownPersonaKeys: ['p2'] }));
        expect(filled.knownPersonaKeys).toEqual(['p1', 'p2']);
    });
});

describe('lineFor / lineKey', () => {
    it('主線不帶 personaKey，鍵就是 charId', () => {
        const c = char({ primaryPersonaKey: 'p1' });
        expect(lineFor(c, 'p1')).toEqual({ charId: 'c1' });
        expect(lineFor(c, undefined)).toEqual({ charId: 'c1' });
        expect(lineKey(primaryLine('c1'))).toBe('c1');
        expect(lineFor(c, 'p2')).toEqual({ charId: 'c1', personaKey: 'p2' });
        expect(lineKey(lineFor(c, 'p2'))).toBe('c1::p2');
        expect(linePersonaKey(c, primaryLine('c1'))).toBe('p1');
        expect(linePersonaKey(c, lineFor(c, 'p2'))).toBe('p2');
    });
});

describe('lineView', () => {
    const c = char({
        primaryPersonaKey: 'p1',
        userNickname: '星星',
        chatBackground: 'bg-main',
        bubbleStyle: 'pink',
        lines: { p2: { chatBackground: 'bg-b', impression: { summary: '老婆' } as any } },
    });

    it('主線回原物件', () => {
        expect(lineView(c, primaryLine('c1'))).toBe(c);
    });

    it('關係狀態換成那條線的，沒有就是空；聊天設定沒設就照主線', () => {
        const v = lineView(c, lineFor(c, 'p2'));
        expect(v.userNickname).toBeUndefined();
        expect((v.impression as any).summary).toBe('老婆');
        expect(v.chatBackground).toBe('bg-b');
        expect(v.bubbleStyle).toBe('pink');
        expect(v.name).toBe('阿澈');
        expect(lineViewPersonaKey(v)).toBe('p2');
        expect(lineViewPersonaKey(c)).toBeUndefined();
    });

    it('視圖的標記不會跟著 JSON 存出去', () => {
        const v = lineView(c, lineFor(c, 'p2'));
        expect(JSON.stringify(v)).not.toContain('p2"]');
        expect(Object.keys(v)).not.toContain(String(LINE_VIEW_PERSONA));
        expect(structuredClone(v) as any).not.toHaveProperty([LINE_VIEW_PERSONA as any]);
    });

    it('新的一條線什麼都沒存：關係狀態全空、設定全照主線', () => {
        const v = lineView(c, lineFor(c, 'p3'));
        expect(v.userNickname).toBeUndefined();
        expect(v.chatBackground).toBe('bg-main');
    });
});

describe('splitLinePatch / linePatchForChar', () => {
    it('拆成角色自己的和跟線走的', () => {
        const { charPatch, linePatch } = splitLinePatch({ name: '新名字', userNickname: '寶', chatBackground: 'x' });
        expect(charPatch).toEqual({ name: '新名字' });
        expect(linePatch).toEqual({ userNickname: '寶', chatBackground: 'x' });
    });

    it('主線原樣回傳', () => {
        const c = char({ primaryPersonaKey: 'p1' });
        const patch = { userNickname: '寶', name: 'x' };
        expect(linePatchForChar(c, primaryLine('c1'), patch)).toBe(patch);
    });

    it('其他線寫進 lines，不動頂層、不動別條線；設成 undefined 就拿掉', () => {
        const c = char({ primaryPersonaKey: 'p1', userNickname: '星星', lines: { p2: { bubbleStyle: 'blue', userNickname: '老婆' }, p3: { userNickname: '妹' } } });
        const out = linePatchForChar(c, lineFor(c, 'p2'), { userNickname: '親愛的', bubbleStyle: undefined, name: '阿澈2' });
        expect(out.name).toBe('阿澈2');
        expect(out).not.toHaveProperty('userNickname');
        expect(out.lines!.p2).toEqual({ userNickname: '親愛的' });
        expect(out.lines!.p3).toEqual({ userNickname: '妹' });
    });

    it('只改角色自己的欄位時不碰 lines', () => {
        const c = char({ primaryPersonaKey: 'p1' });
        expect(linePatchForChar(c, lineFor(c, 'p2'), { name: 'x' })).toEqual({ name: 'x' });
    });
});

describe('身份解析認得線視圖', () => {
    it('非主線的視圖用那條線的身份卡；主線照原本的指定', async () => {
        const { resolveUserProfileForChar, personaKeyForChar } = await import('./userPersona');
        const base = profile({
            personas: [
                { id: 'pA', name: '妹妹', avatar: '', bio: '', createdAt: 0, updatedAt: 0 },
                { id: 'pB', name: '老婆', avatar: '', bio: '', createdAt: 0, updatedAt: 0 },
            ],
            perCharPersonaIds: { c1: 'pA' },
        });
        const c = withLineFields(base, char());
        expect(resolveUserProfileForChar(base, c).name).toBe('妹妹');
        const v = lineView(c, lineFor(c, 'pB'));
        expect(resolveUserProfileForChar(base, v).name).toBe('老婆');
        expect(personaKeyForChar(base, v)).toBe('pB');
    });
});

describe('lineArgOf / lineOf / lineMsgFields', () => {
    it('主線跟舊呼叫一模一樣，非主線帶身份', async () => {
        const { lineArgOf, lineOf, lineMsgFields } = await import('./chatLine');
        const c = char({ primaryPersonaKey: 'p1' });
        expect(lineArgOf(c)).toBe('c1');
        expect(lineOf(c)).toEqual({ charId: 'c1' });
        expect(lineMsgFields(c)).toEqual({ charId: 'c1' });
        const v = lineView(c, lineFor(c, 'p2'));
        expect(lineArgOf(v)).toEqual({ charId: 'c1', personaKey: 'p2' });
        expect(lineOf(v)).toEqual({ charId: 'c1', personaKey: 'p2' });
        expect(lineMsgFields(v)).toEqual({ charId: 'c1', personaKey: 'p2' });
    });
});

describe('lineScheduleId', () => {
    it('主線就是 charId，非主線可以拆回來', async () => {
        const { lineScheduleId, parseLineScheduleId } = await import('./chatLine');
        expect(lineScheduleId({ charId: 'c1' })).toBe('c1');
        expect(parseLineScheduleId('c1')).toEqual({ charId: 'c1' });
        const id = lineScheduleId({ charId: 'c1', personaKey: 'p_123' });
        expect(id).toBe('c1~line~p_123');
        expect(parseLineScheduleId(id)).toEqual({ charId: 'c1', personaKey: 'p_123' });
    });
});
