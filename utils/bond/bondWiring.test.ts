import { afterEach, describe, expect, it } from 'vitest';
import type { BondRecord, CharacterProfile } from '../../types';
import { ContextBuilder } from '../context';
import { blankBond, pairBondId } from './model';
import { setBondRegistry } from './registry';
import { relationshipChangeBlocked } from './guard';
import { buildBondInvitePrompt, canInviteBond, extractBondInvite, formatBondInviteRecord } from './invite';
import { bondNoteFor, sceneBondNote } from './scene';
import { castRelationLines } from '../castRelations';
import { lineView } from '../chatLine';

// 羈絆接進生成路徑（plans/bond-batch1.md 2.2、2.3、3.5）

const user = { name: '小雨', bio: '' } as any;
const char = (extra: Record<string, unknown> = {}) => ({ id: 'c1', name: '阿澈', systemPrompt: '你是阿澈。', description: '', primaryPersonaKey: 'pA', ...extra }) as unknown as CharacterProfile;
const bond = (over: Partial<BondRecord>): BondRecord => ({ ...blankBond('c1::pA', 1), ...over });

afterEach(() => setBondRegistry([]));

describe('核心上下文的羈絆段', () => {
    it('沒有空間：核心上下文跟以前一樣（沒有「你和…的關係」）', () => {
        const core = ContextBuilder.buildCoreContext(char(), user, true);
        expect(core).not.toContain('的關係\n- ');
        expect(ContextBuilder.buildCoreSections(char(), user, true).bond).toBe('');
    });

    it('友情線：段落進核心上下文，放在印象後面、你身邊的人前面', () => {
        setBondRegistry([bond({ route: 'friendship' })]);
        const sections = ContextBuilder.buildCoreSections(char(), user, true);
        expect(sections.bond).toContain('### 你和小雨的關係');
        expect(sections.bond).toContain('會一直是友情');
        const core = ContextBuilder.buildCoreContext(char(), user, true);
        expect(core).toContain('會一直是友情');
    });

    it('別條線上的你：讀那條線的空間', () => {
        setBondRegistry([bond({ route: 'friendship' }), { ...blankBond('c1::pB', 1), route: 'romance', stage: 'lovers' }]);
        const lineChar = { ...char(), lines: { pB: {} } } as unknown as CharacterProfile;
        // 線的視圖帶身份卡鍵（utils/chatLine.ts 的 lineView）
        const view = lineView(lineChar, { charId: 'c1', personaKey: 'pB' });
        expect(ContextBuilder.buildCoreSections(view, user, true).bond).toContain('戀人');
    });
});

describe('你身邊的人：角色之間的路線', () => {
    it('友情、親情線在那一行後面補一句；沒設就跟以前一樣', () => {
        const base = { char: { id: 'a', relationships: [{ id: 'r1', targetId: 'b', description: '同事' }] } as Pick<CharacterProfile, 'id' | 'relationships'>, others: [], nameOf: (id: string): string | null => (id === 'b' ? 'B' : null), userName: '你' };
        expect(castRelationLines(base)).toEqual(['跟「B」：同事']);
        expect(castRelationLines({ ...base, routeNoteOf: () => '你們是友情，不會變成戀愛' })).toEqual(['跟「B」：同事（你們是友情，不會變成戀愛）']);
    });
});

describe('擋 AI 改路線', () => {
    it('友情／親情線上帶戀愛字眼的不改；戀愛線、未指定照舊', () => {
        setBondRegistry([bond({ route: 'friendship' })]);
        expect(relationshipChangeBlocked(char(), '戀人')).toBe(true);
        expect(relationshipChangeBlocked(char(), '最好的朋友')).toBe(false);
        setBondRegistry([bond({ route: 'romance' })]);
        expect(relationshipChangeBlocked(char(), '戀人')).toBe(false);
        setBondRegistry([]);
        expect(relationshipChangeBlocked(char(), '戀人')).toBe(false);
    });
});

describe('角色邀請建立空間', () => {
    it('標籤剝掉、取出那句；沒標籤原文不動', () => {
        expect(extractBondInvite('好想一直記得今天\n[[ACTION:BOND_INVITE|要不要建一個我們的空間]]')).toEqual({ cleanedText: '好想一直記得今天', invite: '要不要建一個我們的空間' });
        expect(extractBondInvite('[[ACTION：羈絆邀請]]').invite).toBe('');
        expect(extractBondInvite('沒有標籤')).toEqual({ cleanedText: '沒有標籤', invite: null });
    });

    it('還沒有空間紀錄才教；小號不教', () => {
        expect(canInviteBond(char())).toBe(true);
        expect(buildBondInvitePrompt(char(), '小雨')).toContain('[[ACTION:BOND_INVITE|');
        expect(buildBondInvitePrompt(char({ altOf: 'x' }), '小雨')).toBe('');
        setBondRegistry([bond({ inviteDeclinedAt: 5 })]);
        expect(buildBondInvitePrompt(char(), '小雨')).toBe('');
    });

    it('記錄形態帶上回了沒', () => {
        expect(formatBondInviteRecord({ text: '一起吧', status: 'accepted' })).toBe('[你邀請對方建一個你們的羈絆空間：「一起吧」]（對方答應了，空間已經建好）');
        expect(formatBondInviteRecord({ status: 'pending' })).toContain('還沒回');
    });
});

describe('同場的關係底線', () => {
    it('角色跟在場的你、角色跟角色；沒有友情／親情線就是空字串', () => {
        setBondRegistry([
            bond({ route: 'friendship' }),
            { ...blankBond(pairBondId('c1', 'c2'), 1), route: 'family', stage: 'kin' },
            { ...blankBond('c2::pA', 1), route: 'romance' },
        ]);
        const note = sceneBondNote({ chars: [{ id: 'c1', name: '阿澈' }, { id: 'c2', name: '小晴' }], users: [{ key: 'pA', name: '小雨' }] });
        expect(note).toContain('阿澈和小雨是友情');
        expect(note).toContain('阿澈和小晴是血緣親屬');
        expect(note).not.toContain('小晴和小雨');
        expect(sceneBondNote({ chars: [{ id: 'c2', name: '小晴' }], users: [{ key: 'pA', name: '小雨' }] })).toBe('');
    });

    it('朋友圈：只列跟這個角色有關的；舊貼文沒寫身份卡就照主線', () => {
        setBondRegistry([bond({ route: 'friendship' })]);
        expect(bondNoteFor({ id: 'c1', name: '阿澈', primaryPersonaKey: 'pA' }, [{ kind: 'user', key: undefined, name: '小雨' }])).toContain('你和小雨是友情');
        expect(bondNoteFor({ id: 'c1', name: '阿澈', primaryPersonaKey: 'pA' }, [{ kind: 'char', id: 'c9', name: '路人' }])).toBe('');
    });
});
