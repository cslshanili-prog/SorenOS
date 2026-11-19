import { describe, expect, it } from 'vitest';
import { personaExtraSetting } from './personaSetting';
import { ContextBuilder } from './context';
import { buildUserOwnerContext } from './financeGenerate';

// 身份卡的「補充設定」：舊的「自定義設定」「其他補充」兩格合成一格

describe('補充設定', () => {
    it('舊資料兩格都有字就接起來；只有一格、都沒有也照樣', () => {
        expect(personaExtraSetting({ customSetting: ' 住在台北 ', otherDetails: '怕冷' })).toBe('住在台北\n怕冷');
        expect(personaExtraSetting({ customSetting: '住在台北' })).toBe('住在台北');
        expect(personaExtraSetting({ otherDetails: '怕冷' })).toBe('怕冷');
        expect(personaExtraSetting({ customSetting: '  ', otherDetails: '' })).toBe('');
        expect(personaExtraSetting(undefined)).toBe('');
    });
    it('提示詞的用戶段只出一行「補充設定」，舊的兩個標籤不再出現；留空就沒有這行', () => {
        const char = { id: 'c1', name: '阿澈', systemPrompt: '', description: '' } as any;
        const withExtra = ContextBuilder.buildCoreContext(char, { name: '小星', avatar: '', bio: '大學生', customSetting: '住在台北', otherDetails: '怕冷' } as any, false);
        expect(withExtra).toContain('- 設定/備註: 大學生\n- 補充設定: 住在台北\n怕冷\n');
        expect(withExtra).not.toContain('自定義設定');
        expect(withExtra).not.toContain('其他補充');
        const plain = ContextBuilder.buildCoreContext(char, { name: '小星', avatar: '', bio: '大學生' } as any, false);
        expect(plain).not.toContain('補充設定');
    });
    it('銀行流水那段同一個口徑', () => {
        expect(buildUserOwnerContext({ name: '小星', bio: '大學生', otherDetails: '怕冷' } as any)).toContain('- 補充設定: 怕冷');
    });
});
