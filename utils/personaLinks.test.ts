import { describe, expect, it } from 'vitest';
import type { CharacterProfile, PersonaLink, UserProfile } from '../types';
import { formatPersonaLinksBlock, personaLinkLines, sameIdentityKeys } from './personaLinks';
import { lineFor, lineView } from './chatLine';
import { memoryLineLabel, memoryLineLabelsFor } from './memoryPalace/lineLabels';

const card = (id: string, name: string) => ({ id, name, avatar: '', bio: '', createdAt: 0, updatedAt: 0 });
const alt: PersonaLink = { id: 'L1', kind: 'alt', a: 'pA', b: 'pB', createdAt: 0 };
const sis: PersonaLink = { id: 'L2', kind: 'sameWorld', a: 'pA', b: 'pC', aToB: '姊姊', bToA: '妹妹', createdAt: 0 };
const base = {
    name: '我', avatar: '', bio: '',
    personas: [card('pA', '小星'), card('pB', '月月'), card('pC', '小雨')],
    personaLinks: [alt, sis],
} as unknown as UserProfile;
const char = (extra: Partial<CharacterProfile> = {}): CharacterProfile =>
    ({ id: 'c1', name: '阿澈', avatar: '', description: '', systemPrompt: '', memories: [], primaryPersonaKey: 'pA', knownPersonaKeys: ['pA', 'pB'], ...extra } as CharacterProfile);

describe('同一世界', () => {
    it('角色認識其中一張：告訴他稱呼，另一張只是知道有這個人', () => {
        const lines = personaLinkLines(char(), base);
        expect(lines.some(l => l.includes('「小星」是「小雨」的姊姊') && l.includes('「小雨」是TA的妹妹') && l.includes('還沒跟TA來往過'))).toBe(true);
    });
    it('兩張都認識：說明是不同的人', () => {
        const lines = personaLinkLines(char({ knownPersonaKeys: ['pA', 'pB', 'pC'] }), base);
        expect(lines.some(l => l.includes('這兩個人你都認識'))).toBe(true);
    });
});

describe('小號', () => {
    it('不知道：一個字都不說', () => {
        const lines = personaLinkLines(char(), base);
        expect(lines.some(l => l.includes('月月'))).toBe(false);
    });
    it('只認識一張卡：連結對他不存在', () => {
        const c = char({ knownPersonaKeys: ['pA'], altKnowledge: { L1: { state: 'known', since: 0 } } });
        expect(personaLinkLines(c, base).some(l => l.includes('月月'))).toBe(false);
    });
    it('一直知道：兩條線都說，小號那條說「其實就是」', () => {
        const c = char({ altKnowledge: { L1: { state: 'known', since: 0 } } });
        expect(personaLinkLines(c, base).find(l => l.includes('月月'))).toContain('其實就是「小星」本人');
        const onB = lineView(c, lineFor(c, 'pB'));
        expect(personaLinkLines(onB, base).find(l => l.includes('小星'))).toContain('跟你聊天的「月月」其實就是你也認識的「小星」');
        expect(formatPersonaLinksBlock(onB, base)).toContain('關於「月月」的其他身份與關係');
    });
    it('否認過：記得懷疑過、被否認幾次', () => {
        const c = char({ altKnowledge: { L1: { state: 'denied', at: Date.UTC(2026, 10, 1), times: 2 } } });
        expect(personaLinkLines(c, base).find(l => l.includes('月月'))).toContain('否認了（2 次');
    });
    it('小號會串：A—B、B—D 都知道，A、B、D 是同一個人', () => {
        const chain = { ...base, personas: [...(base.personas || []), card('pD', '阿D')], personaLinks: [alt, { id: 'L3', kind: 'alt', a: 'pB', b: 'pD', createdAt: 0 } as PersonaLink] } as UserProfile;
        const c = char({ knownPersonaKeys: ['pA', 'pB', 'pD'], altKnowledge: { L1: { state: 'known', since: 0 }, L3: { state: 'discovered', at: 0, how: 'revealed' } } });
        expect(sameIdentityKeys(c, chain, 'pA').sort()).toEqual(['pB', 'pD']);
        expect(sameIdentityKeys(char(), chain, 'pA')).toEqual([]);
    });
});

describe('記憶標籤認得小號', () => {
    it('知道是同一個人：標「TA 用那個身份」；不知道照舊', () => {
        const knows = memoryLineLabelsFor(char({ altKnowledge: { L1: { state: 'known', since: 0 } } }), base)!;
        expect(memoryLineLabel({ personaKey: 'pB' }, knows)).toBe('〔這是TA用「月月」的身份跟你經歷的事〕');
        const not = memoryLineLabelsFor(char(), base)!;
        expect(memoryLineLabel({ personaKey: 'pB' }, not)).toContain('「小星」不一定知道');
    });
});

describe('從已套用身份卡的檔案也查得到真實身份的名字', () => {
    it('套上「月月」之後，真實身份還是「我」；存出去不帶這個標記', async () => {
        const { applyActivePersona, personaNameForKey, REAL_IDENTITY_PERSONA_ID } = await import('./userPersona');
        const applied = applyActivePersona({ ...base, activePersonaId: 'pB' } as UserProfile);
        expect(applied.name).toBe('月月');
        expect(personaNameForKey(applied, REAL_IDENTITY_PERSONA_ID)).toBe('我');
        expect(JSON.stringify(applied)).not.toContain('realIdentityFace');
    });
});
