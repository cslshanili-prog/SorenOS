import { describe, expect, it } from 'vitest';
import type { BondRecord } from '../../types';
import { applyRouteChange, blankBond, bondIdForChar, lastTurn, pairBondId, parseBondId, personaBondId } from './model';
import { hasRomanceWords, isDefaultBondState, stageForRoute, stageLabel, stagesOf, suggestBond } from './routes';
import { bondBystanderNote, bondFinalLock, bondHasPromptContent, bondPromptBlock } from './prompt';
import { bondForChar, bondForPair, bondForPersona, setBondRegistry } from './registry';
import { lineView } from '../chatLine';
import { pairLineId } from '../pairLine';
import type { CharacterProfile } from '../../types';

const persona = (over: Partial<BondRecord> = {}): BondRecord => ({ ...blankBond('c1::pA', 1), ...over });

describe('羈絆 id', () => {
    it('身份卡 × 角色：主線也帶身份卡鍵；舊角色沒有鍵退回 charId', () => {
        expect(personaBondId('c1', 'pA')).toBe('c1::pA');
        expect(personaBondId('c1', undefined)).toBe('c1');
        expect(bondIdForChar({ id: 'c1', primaryPersonaKey: 'pA' })).toBe('c1::pA');
        expect(bondIdForChar({ id: 'c1' })).toBe('c1');
    });

    it('線的視圖：照那條線的身份卡', () => {
        const char = { id: 'c1', primaryPersonaKey: 'pA', lines: { pB: {} } } as unknown as CharacterProfile;
        expect(bondIdForChar(lineView(char, { charId: 'c1', personaKey: 'pB' }))).toBe('c1::pB');
        expect(bondIdForChar(lineView(char, { charId: 'c1' }))).toBe('c1::pA');
    });

    it('角色 × 角色跟角色私聊線同一個 id', () => {
        expect(pairBondId('b', 'a')).toBe(pairLineId('a', 'b'));
        expect(parseBondId(pairBondId('b', 'a'))).toEqual({ kind: 'pair', charId: 'a', otherCharId: 'b' });
        expect(parseBondId('c1::pA')).toEqual({ kind: 'persona', charId: 'c1', personaKey: 'pA' });
        expect(parseBondId('c1')).toEqual({ kind: 'persona', charId: 'c1' });
    });

    it('還沒存過的空間：未指定、朋友；pair 預設開自動日記', () => {
        expect(blankBond('c1::pA', 5)).toMatchObject({ kind: 'persona', charId: 'c1', personaKey: 'pA', stage: 'friend', openedBy: 'auto' });
        expect(blankBond(pairBondId('x', 'y'), 5)).toMatchObject({ kind: 'pair', charId: 'x', otherCharId: 'y', pairAutoDiary: true });
        expect(blankBond('c1::pA').route).toBeUndefined();
    });
});

describe('路線與階段', () => {
    it('朋友是階段：戀愛、友情、未指定都有 friend；親情預設是親屬', () => {
        expect(stagesOf('romance').map(s => s.id)).toContain('friend');
        expect(stagesOf('friendship').map(s => s.id)).toContain('friend');
        expect(stagesOf(undefined).map(s => s.id)).toEqual(['friend', 'custom']);
        expect(stageForRoute('family', 'lovers')).toBe('kin');
        expect(stageForRoute('romance', 'friend')).toBe('friend');
        expect(stageForRoute('friendship', 'custom')).toBe('custom');
    });

    it('顯示名：自訂用名稱、親情用稱謂', () => {
        expect(stageLabel({ route: 'friendship', stage: 'custom', stageLabel: '共犯' })).toBe('共犯');
        expect(stageLabel({ route: 'family', stage: 'kin', stageLabel: '哥哥' })).toBe('哥哥');
        expect(stageLabel({ route: 'romance', stage: 'ambiguous' })).toBe('曖昧');
    });

    it('建議路線：戀愛、親情才建議，友情不建議；多義字不收', () => {
        expect(suggestBond(['', '我的老婆'])).toMatchObject({ route: 'romance', stage: 'married' });
        expect(suggestBond(['未婚妻'])).toMatchObject({ route: 'romance', stage: 'engaged' });
        expect(suggestBond(['男朋友'])).toMatchObject({ route: 'romance', stage: 'lovers' });
        expect(suggestBond(['他是我哥哥'])).toMatchObject({ route: 'family', label: '哥哥' });
        expect(suggestBond(['摯友'])).toBeNull();
        expect(suggestBond(['好兄弟', '好姐妹', '合作對象', '王先生'])).toBeNull();
    });

    it('戀愛字眼（擋角色自己改關係用）', () => {
        expect(hasRomanceWords('戀人')).toBe(true);
        expect(hasRomanceWords('暗戀對象')).toBe(true);
        expect(hasRomanceWords('最好的朋友')).toBe(false);
        expect(hasRomanceWords(undefined)).toBe(false);
    });
});

describe('改路線', () => {
    it('修正與轉折都進歷程；沒變就不動', () => {
        const b0 = persona();
        const b1 = applyRouteChange(b0, { route: 'friendship', stage: 'friend' }, { kind: 'fix', storyDay: '2026-11-01', now: 10 });
        expect(b1.route).toBe('friendship');
        expect(b1.routeLog).toHaveLength(1);
        expect(lastTurn(b1)).toBeUndefined();
        expect(applyRouteChange(b1, { route: 'friendship', stage: 'friend' }, { kind: 'fix', storyDay: 'x' })).toBe(b1);

        const b2 = applyRouteChange(b1, { route: 'romance', stage: 'lovers' }, { kind: 'turn', storyDay: '2026-11-20', note: '海邊那晚', now: 20 });
        expect(b2.stage).toBe('lovers');
        expect(lastTurn(b2)).toMatchObject({ storyDay: '2026-11-20', from: { route: 'friendship' }, to: { route: 'romance', stage: 'lovers' }, note: '海邊那晚' });
    });

    it('換到沒有這個階段的路線，退回新路線的預設', () => {
        const b = applyRouteChange(persona({ route: 'romance', stage: 'lovers' }), { route: 'family', stage: 'lovers', stageLabel: '妹妹' }, { kind: 'fix', storyDay: 'd' });
        expect(b.stage).toBe('kin');
        expect(b.stageLabel).toBe('妹妹');
    });
});

describe('提示詞', () => {
    it('沒有空間、或全是預設：空字串（現有提示詞一字不差）', () => {
        expect(bondPromptBlock({ bond: undefined, selfName: 'A', otherName: 'B' })).toBe('');
        expect(bondPromptBlock({ bond: persona(), selfName: 'A', otherName: 'B' })).toBe('');
        expect(bondHasPromptContent(persona())).toBe(false);
        expect(isDefaultBondState(persona())).toBe(true);
        expect(bondFinalLock(persona(), 'B')).toBe('');
    });

    it('友情：段落帶鎖定，最後那句另外給', () => {
        const b = persona({ route: 'friendship' });
        const block = bondPromptBlock({ bond: b, selfName: '阿澈', otherName: '小雨' });
        expect(block).toContain('### 你和小雨的關係');
        expect(block).toContain('會一直是友情');
        expect(block).toContain('不要寫成吃醋');
        expect(block).toContain('友情可以很深');
        expect(bondFinalLock(b, '小雨')).toContain('不是戀愛');
    });

    it('戀愛：不自己宣布交往；轉折句只帶最近一次', () => {
        let b = applyRouteChange(persona(), { route: 'friendship', stage: 'friend' }, { kind: 'turn', storyDay: '2026-10-01' });
        b = applyRouteChange(b, { route: 'romance', stage: 'lovers' }, { kind: 'turn', storyDay: '2026-11-20' });
        const block = bondPromptBlock({ bond: b, selfName: 'A', otherName: 'B' });
        expect(block).toContain('不要自己宣布已經交往');
        expect(block).toContain('2026-11-20 從「朋友（友情）」變成「戀人（戀愛）」');
        expect(block).not.toContain('2026-10-01');
        expect(block).toContain('之前那段關係是真的');
        expect(bondFinalLock(b, 'B')).toBe('');
    });

    it('親情：persona 照角色是你的什麼；pair 兩邊各自的稱謂', () => {
        expect(bondPromptBlock({ bond: persona({ route: 'family', stage: 'kin', stageLabel: '哥哥' }), selfName: '阿澈', otherName: '小雨' })).toContain('你是小雨的哥哥');
        const pair: BondRecord = { ...blankBond(pairBondId('a', 'b')), route: 'family', stage: 'kin', stageLabel: '姐姐', stageLabelOther: '妹妹' };
        expect(bondPromptBlock({ bond: pair, selfName: 'A', otherName: 'B', selfIsCharId: true })).toContain('你是B的姐姐');
        expect(bondPromptBlock({ bond: pair, selfName: 'B', otherName: 'A', selfIsCharId: false })).toContain('你是A的妹妹');
    });

    it('自訂名、此刻的我們', () => {
        const b = persona({ route: 'friendship', stage: 'custom', stageLabel: '共犯', ourNow: { char: { text: '最近比較會分享小事', at: 1 }, user: { text: '他很可靠', at: 2 } } });
        const block = bondPromptBlock({ bond: b, selfName: 'A', otherName: 'B' });
        expect(block).toContain('「共犯」，它仍屬友情路線');
        expect(block).toContain('你寫給B看的「此刻的我們」：最近比較會分享小事');
        expect(block).toContain('B寫的「我眼中的我們」：他很可靠');
        // 只寫了此刻的我們、路線未指定也會進
        expect(bondPromptBlock({ bond: persona({ ourNow: { user: { text: '嗯', at: 1 } } }), selfName: 'A', otherName: 'B' })).toContain('我眼中的我們');
    });

    it('旁人須知', () => {
        expect(bondBystanderNote([{ aName: 'A', bName: 'B', route: 'friendship' }, { aName: 'C', bName: 'D', route: 'romance' }]))
            .toBe('【旁人須知】\nA和B是朋友，不是戀人；別起鬨，也別把他們的親近解讀成戀愛。');
        expect(bondBystanderNote([])).toBe('');
    });
});

describe('登記表', () => {
    it('照身份卡、照兩個角色找', () => {
        const a = persona({ route: 'romance' });
        const p: BondRecord = { ...blankBond(pairBondId('x', 'y')), route: 'friendship' };
        setBondRegistry([a, p]);
        expect(bondForPersona('c1', 'pA')?.route).toBe('romance');
        expect(bondForChar({ id: 'c1', primaryPersonaKey: 'pA' })?.route).toBe('romance');
        expect(bondForPair('y', 'x')?.route).toBe('friendship');
        expect(bondForPair('x', 'x')).toBeUndefined();
        setBondRegistry([]);
    });
});
