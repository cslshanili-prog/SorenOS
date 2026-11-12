import { describe, expect, it } from 'vitest';
import { altGuessUserText, altRevealNotes, buildAltGuessPrompt, parseAltGuessDecision } from './altReveal';
import { altMaskBlock, formatAltBridge } from './charAlt';

describe('我知道你是誰', () => {
    it('猜對：照根據和性格決定；之前否認過的寫次數', () => {
        const p = buildAltGuessPrompt({ altName: '夜航', ownerName: '阿澈', userName: '小星', guessName: '阿澈', reason: '你也愛半夜吃泡麵', deniedTimes: 2 });
        expect(p).toContain('小星猜對了');
        expect(p).toContain('「你也愛半夜吃泡麵」');
        expect(p).toContain('懷疑過 2 次');
    });
    it('猜錯：照小號的身份回', () => {
        const p = buildAltGuessPrompt({ altName: '夜航', ownerName: '阿澈', userName: '小星', guessName: '阿明', reason: '', deniedTimes: 0 });
        expect(p).toContain('小星猜錯了：你不是「阿明」');
        expect(p).toContain('小星沒說根據');
    });
    it('解析與落的文字', () => {
        expect(parseAltGuessDecision({ admit: true, reply: '……被你發現了' })).toEqual({ admitted: true, reply: '……被你發現了' });
        expect(parseAltGuessDecision({ reply: 'x' })).toBeNull();
        expect(altGuessUserText('阿澈', '你也愛泡麵')).toBe('我知道你是誰——你是阿澈吧？\n你也愛泡麵');
        expect(altRevealNotes({ altName: '夜航', ownerName: '阿澈', userName: '小星', how: 'admitted' }).altLine).toBe('[系統: 小星認出了小號「夜航」，阿澈承認了]');
        expect(altRevealNotes({ altName: '夜航', ownerName: '阿澈', userName: '小星', how: 'told' }).ownerLine).toBe('[系統: 阿澈說出來了：小號「夜航」就是阿澈]');
    });
    it('認出來之後提示詞不再說「對方不知道」', () => {
        const mask = altMaskBlock({ name: '夜航', description: '', altRevealed: { at: 1, how: 'told' } }, { name: '阿澈' });
        expect(mask).toContain('對方已經知道「夜航」就是你（阿澈）了（你自己說的）');
        expect(mask).not.toContain('對方不知道');
        expect(altMaskBlock({ name: '夜航', description: '', altDenied: { times: 1, lastAt: 1 } }, { name: '阿澈' })).toContain('懷疑過 1 次');
        const bridge = formatAltBridge({ selfIsAlt: false, otherName: '夜航', ownerName: '阿澈', userName: '小星', msgs: [{ role: 'user', content: 'hi', timestamp: 1 }], formatDate: String, revealed: true });
        expect(bridge).toContain('「小星」已經知道「夜航」就是你了');
    });
});
