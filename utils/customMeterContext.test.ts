import { describe, it, expect } from 'vitest';
import { buildInnerStateBlock, buildPreviousMeterNote } from './customMeterContext';
import type { CharacterCustomMeter } from '../types';

const now = new Date(2026, 9, 5, 14, 0).getTime();
const base = { prompt: 'p', color: '#fff' };

describe('buildPreviousMeterNote', () => {
    it('沒生成過就不寫', () => {
        expect(buildPreviousMeterNote('text', {}, now)).toBe('');
        expect(buildPreviousMeterNote('number', { statusNote: '有點想他' }, now)).toBe('');
    });
    it('心聲帶上一次全文和時間，要求接著寫', () => {
        const note = buildPreviousMeterNote('text', { content: '今天他沒回我。', updatedAt: now - 3 * 3600_000 }, now);
        expect(note).toContain('約 3 小時前');
        expect(note).toContain('今天他沒回我。');
        expect(note).toContain('接著寫');
    });
    it('好感度帶分數和那句心聲，要求小幅調整', () => {
        const note = buildPreviousMeterNote('number', { value: 72, statusNote: '想見他', updatedAt: now - 60_000 * 30 }, now);
        expect(note).toContain('72 分');
        expect(note).toContain('「想見他」');
        expect(note).toContain('小幅變動');
    });
});

describe('buildInnerStateBlock', () => {
    const voices: CharacterCustomMeter[] = [
        { ...base, id: 'a', title: '今日心事', content: '他今天好像很累。\n想陪他。', updatedAt: now - 2 * 3600_000, shareWithChar: true },
        { ...base, id: 'b', title: '秘密', content: '不給角色看', shareWithChar: false },
        { ...base, id: 'c', title: '還沒生成', shareWithChar: true },
    ];
    const affinities: CharacterCustomMeter[] = [
        { ...base, id: 'd', title: '信任', value: 88, statusNote: '可以把背後交給他', shareWithChar: true },
        { ...base, id: 'e', title: '醋意', value: 30, statusNote: '不給看' },
    ];

    it('只收勾了帶進聊天、有內容的；好感度不帶數字', () => {
        const block = buildInnerStateBlock(voices, affinities, { now });
        expect(block).toContain('### 你此刻的心裡話');
        expect(block).toContain('- 今日心事（約 2 小時前）：他今天好像很累。 想陪他。');
        expect(block).toContain('- 信任：可以把背後交給他');
        expect(block).not.toContain('不給角色看');
        expect(block).not.toContain('不給看');
        expect(block).not.toContain('還沒生成');
        expect(block).not.toContain('88');
        expect(block).toContain('不要提到任何分數');
    });

    it('fire_pack 不寫相對時間；全都沒勾就是空字串', () => {
        expect(buildInnerStateBlock(voices, affinities, { now, withAge: false })).not.toContain('小時前');
        expect(buildInnerStateBlock([voices[1]], [affinities[1]], { now })).toBe('');
        expect(buildInnerStateBlock(undefined, undefined)).toBe('');
    });
});
