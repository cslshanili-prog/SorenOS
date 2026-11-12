import { describe, expect, it } from 'vitest';
import type { CharacterProfile } from '../types';
import { altIdentityBlock, altPersonaView, altSelfRoom, altsOf, formatAltBridge, isAltResolved } from './charAlt';
import { buildAltCharacter, buildAltGenPrompt, parseAltDraft } from './charAltGenerate';
import { setCharNameRegistry } from './charNameRegistry';
import { ContextBuilder } from './context';
import { filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';

const owner = { id: 'c1', name: '阿澈', avatar: 'a1', description: '豪門長子', systemPrompt: '你是阿澈，嘴硬心軟。', worldview: '現代都市', memories: [], refinedMemories: { '2026-10': '跟她吵過一次架' }, primaryPersonaKey: 'pA', castRole: undefined } as unknown as CharacterProfile;
const alt = { id: 'x1', name: '夜航', avatar: 'a2', description: '只在半夜出沒', systemPrompt: '', memories: [], altOf: 'c1', altPurpose: '想用別人的身份接近她', altCreatedBy: 'char' } as unknown as CharacterProfile;

describe('小號是誰', () => {
    it('列出本人的小號、它自己還能開幾個', () => {
        expect(altsOf('c1', [owner, alt]).map(c => c.id)).toEqual(['x1']);
        expect(altSelfRoom(owner, [owner, alt])).toBe(2);
        expect(altSelfRoom({ ...owner, altSelfLimit: 0 }, [owner, alt])).toBe(0);
        expect(altSelfRoom(owner, [owner, { ...alt, altCreatedBy: 'user' }])).toBe(3);
    });
    it('選角列表不列小號', () => {
        expect(filterCharactersByGroup([owner, alt], [], GROUP_FILTER_ALL).map(c => c.id)).toEqual(['c1']);
    });
});

describe('小號的提示詞：人設記憶照本人、對外換小號', () => {
    it('視圖：本人的人設與記憶，小號的 id、名字、頭像、簡介', () => {
        const v = altPersonaView(alt, owner);
        expect(v).toMatchObject({ id: 'x1', name: '夜航', avatar: 'a2', description: '只在半夜出沒', systemPrompt: '你是阿澈，嘴硬心軟。', worldview: '現代都市' });
        expect(v.refinedMemories).toEqual({ '2026-10': '跟她吵過一次架' });
        expect(isAltResolved(v)).toBe(true);
    });
    it('身份段：你是本人、現在用小號、對方不知道', () => {
        const t = altIdentityBlock(alt, owner);
        expect(t).toContain('你是「阿澈」');
        expect(t).toContain('你是阿澈，嘴硬心軟。');
        expect(t).toContain('小號「夜航」');
        expect(t).toContain('想用別人的身份接近她');
        expect(t).toContain('對方不知道「夜航」就是你');
    });
    it('ContextBuilder 遇到小號就換成本人的人設', () => {
        setCharNameRegistry([owner, alt] as any);
        const ctx = ContextBuilder.buildCoreContext(alt, { name: '小星', avatar: '', bio: '' } as any, true);
        expect(ctx).toContain('你是阿澈，嘴硬心軟。');
        expect(ctx).toContain('跟她吵過一次架');
        expect(ctx).toContain('你現在用小號「夜航」');
        setCharNameRegistry([]);
    });
});

describe('兩邊互通', () => {
    const msgs = [{ role: 'user', content: '你是誰呀', timestamp: 1 }, { role: 'assistant', content: '路過的', timestamp: 2 }] as any[];
    it('本人看小號那邊', () => {
        const t = formatAltBridge({ selfIsAlt: false, otherName: '夜航', ownerName: '阿澈', userName: '小星', msgs, formatDate: ts => `T${ts}` });
        expect(t).toContain('你用小號「夜航」跟「小星」最近聊的');
        expect(t).toContain('[T1] 小星: 你是誰呀');
        expect(t).toContain('[T2] 你: 路過的');
    });
    it('小號看本人那邊；沒訊息就是空字串', () => {
        expect(formatAltBridge({ selfIsAlt: true, otherName: '阿澈', ownerName: '阿澈', userName: '小星', msgs, formatDate: String })).toContain('你用本名「阿澈」');
        expect(formatAltBridge({ selfIsAlt: true, otherName: '阿澈', ownerName: '阿澈', userName: '小星', msgs: [], formatDate: String })).toBe('');
    });
});

describe('開小號', () => {
    it('提示詞帶本人人設、避開已有名字', () => {
        const p = buildAltGenPrompt({ owner, existingNames: ['夜航'], hint: '' });
        expect(p).toContain('你是阿澈，嘴硬心軟。');
        expect(p).toContain('「夜航」');
    });
    it('解析：要有名字', () => {
        expect(parseAltDraft('{"name":"雨夜","brief":"b","purpose":"p","appearance":"貓"}')).toEqual({ name: '雨夜', brief: 'b', purpose: 'p', appearance: '貓' });
        expect(parseAltDraft('{"brief":"沒名字"}')).toBeNull();
    });
    it('組角色卡：跟本人同世界、同主線、指回本人、日程情緒不另外跑', () => {
        const c = buildAltCharacter({ owner: { ...owner, groupId: 'w1' }, draft: { name: '雨夜', brief: 'b', purpose: 'p' }, avatar: 'av', createdBy: 'user', now: 5 });
        expect(c).toMatchObject({ name: '雨夜', altOf: 'c1', altPurpose: 'p', altCreatedBy: 'user', groupId: 'w1', primaryPersonaKey: 'pA', description: 'b', avatar: 'av' });
        expect(c.emotionConfig?.enabled).toBe(false);
    });
});
