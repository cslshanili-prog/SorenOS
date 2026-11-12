import { describe, expect, it } from 'vitest';
import type { CharacterProfile } from '../types';
import { buildCastCharacters, buildCastGenPrompt, castAvatarPrompt, parseCastDrafts } from './castGenerate';

const lead = {
    id: 'c1', name: '阿澈', description: '豪門長子', systemPrompt: '你是阿澈，家族企業的繼承人。', worldview: '現代都市',
    groupId: 'w1', primaryPersonaKey: 'pA',
    mountedWorldbooks: [{ id: 'b1', title: '家族', content: '沈家三代經商', constant: true }, { id: 'b2', title: '關鍵詞', content: '只在提到時觸發', constant: false }],
} as unknown as CharacterProfile;

describe('提示詞', () => {
    it('帶主角、常駐世界書、現有角色、方向；預設不寫跟你的關係', () => {
        const p = buildCastGenPrompt({ lead, worldChars: [{ id: 'c2', name: '小雨', description: '妹妹' } as CharacterProfile], count: 3, direction: '聯姻對象和她的閨蜜', userName: '小星' });
        expect(p).toContain('生成 3 個配角');
        expect(p).toContain('沈家三代經商');
        expect(p).not.toContain('只在提到時觸發');
        expect(p).toContain('- 小雨：妹妹');
        expect(p).toContain('聯姻對象和她的閨蜜');
        expect(p).toContain('不要寫跟用戶的關係');
    });
    it('勾了跟你的關係才教；數量夾在 1～5', () => {
        const p = buildCastGenPrompt({ lead, worldChars: [], count: 9, includeUser: true, userName: '小星' });
        expect(p).toContain('生成 5 個配角');
        expect(p).toContain('對象就寫「小星」');
    });
    it('單張重生避開已經有的名字', () => {
        expect(buildCastGenPrompt({ lead, worldChars: [], count: 1, userName: '小星', avoidNames: ['林小姐'] })).toContain('「林小姐」');
    });
});

describe('解析（兩層容錯）', () => {
    it('整段陣列', () => {
        const raw = '```json\n[{"name":"林小姐","brief":"聯姻對象","persona":"你是林小姐","appearance":"長髮","relations":[{"target":"阿澈","relation":"家裡安排的聯姻對象"}]}]\n```';
        expect(parseCastDrafts(raw)).toEqual([{ name: '林小姐', brief: '聯姻對象', persona: '你是林小姐', appearance: '長髮', relations: [{ target: '阿澈', relation: '家裡安排的聯姻對象' }] }]);
    });
    it('包在 characters 裡也認', () => {
        expect(parseCastDrafts('{"characters":[{"name":"A"}]}').map(d => d.name)).toEqual(['A']);
    });
    it('壞掉的 JSON：逐個物件搶救，重名只留一個', () => {
        const raw = '好的：{"name":"甲","brief":"一"} 還有 {"name":"乙","brief":"二"}, {"name":"甲"} 最後 {"name": 壞掉';
        expect(parseCastDrafts(raw).map(d => d.name)).toEqual(['甲', '乙']);
    });
    it('沒名字的丟掉', () => {
        expect(parseCastDrafts('[{"brief":"沒名字"}]')).toEqual([]);
    });
});

describe('草稿轉配角', () => {
    const drafts = [
        { name: '林小姐', brief: '聯姻對象', persona: '你是林小姐', appearance: '', relations: [{ target: '阿澈', relation: '聯姻對象' }, { target: '阿琪', relation: '閨蜜' }, { target: '小星', relation: '情敵' }, { target: '不存在', relation: 'x' }] },
        { name: '阿琪', brief: '閨蜜', persona: '你是阿琪', appearance: '', relations: [{ target: '林小姐', relation: '閨蜜' }] },
    ];
    const run = (includeUser: boolean) => buildCastCharacters({
        drafts, lead, existing: [lead], userName: '小星', includeUser, defaultAvatar: n => `av:${n}`, now: 1000,
    });

    it('所在世界、認識的你跟主角；配角、主動消息不開', () => {
        const { chars } = run(false);
        expect(chars[0]).toMatchObject({ name: '林小姐', castRole: 'supporting', groupId: 'w1', primaryPersonaKey: 'pA', knownPersonaKeys: ['pA'], avatar: 'av:林小姐', systemPrompt: '你是林小姐', description: '聯姻對象' });
        expect(chars[0].activeMsg2Config).toBeUndefined();
    });
    it('關係照名字對上主角、同一批；對不上的丟掉；沒勾就不記跟你的關係', () => {
        const { chars } = run(false);
        const rel = chars[0].relationships!;
        expect(rel.map(r => [r.targetId, r.description])).toEqual([['c1', '聯姻對象'], [chars[1].id, '閨蜜']]);
        expect(run(true).chars[0].relationships!.some(r => r.targetId === 'user' && r.description === '情敵')).toBe(true);
    });
    it('兩邊的通訊錄：新角色自己、主角、同一批都加，同一批不重複', () => {
        const { chars, contactsForExisting } = run(false);
        expect(chars[0].phoneState!.contacts!.map(c => c.linkedCharId)).toEqual(['c1', chars[1].id]);
        expect(contactsForExisting.c1.map(c => [c.name, c.linkedCharId, c.kind])).toEqual([['林小姐', chars[0].id, 'real']]);
        expect(chars[1].phoneState!.contacts!.filter(c => c.linkedCharId === chars[0].id)).toHaveLength(1);
    });
    it('頭像提示詞帶外觀和風格', () => {
        expect(castAvatarPrompt({ name: 'A', appearance: '短髮', brief: '' }, '日系動畫風')).toContain('短髮');
        expect(castAvatarPrompt({ name: 'A', appearance: '短髮', brief: '' }, '日系動畫風')).toContain('風格：日系動畫風');
    });
});
