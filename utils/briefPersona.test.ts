import { describe, expect, it } from 'vitest';
import { buildBriefPersonaPrompt, cleanBriefPersona, isBriefPersonaStale, personaFingerprint, resolveBriefPersona } from './briefPersona';
import { characterVoice } from './momentsVoice';

const base = { name: 'Sully', description: '貓系男友', systemPrompt: '性格冷淡，話少。', worldview: '' };

describe('精簡人設', () => {
    it('指紋跟著人設變；照舊版生成的算過期，手寫的不算', () => {
        const fp = personaFingerprint(base);
        expect(personaFingerprint({ ...base })).toBe(fp);
        expect(personaFingerprint({ ...base, systemPrompt: '性格開朗。' })).not.toBe(fp);
        expect(isBriefPersonaStale({ ...base, briefPersona: '話少的人', briefPersonaSource: fp })).toBe(false);
        expect(isBriefPersonaStale({ ...base, systemPrompt: '改過了', briefPersona: '話少的人', briefPersonaSource: fp })).toBe(true);
        expect(isBriefPersonaStale({ ...base, systemPrompt: '改過了', briefPersona: '手寫的' })).toBe(false);
        expect(isBriefPersonaStale({ ...base, briefPersonaSource: 'x' })).toBe(false);
    });

    it('生成提示詞：帶上人設、要求寫說話方式與話量、不寫私密關係', () => {
        const p = buildBriefPersonaPrompt(base);
        expect(p).toContain('性格冷淡，話少。');
        expect(p).toContain('話量');
        expect(p).toContain('不要寫跟用戶之間的私密關係');
    });

    it('清理輸出：剝前綴、引號、思考外洩，壓成一段、有上限', () => {
        expect(cleanBriefPersona('<thinking>想一下</thinking>\n精簡人設：「冷淡的駭客。\n話很少。」')).toBe('冷淡的駭客。話很少。');
        expect(cleanBriefPersona('字'.repeat(400)).length).toBeLessThanOrEqual(301);
    });

    it('朋友圈留言優先用精簡人設，沒填才從完整人設挑句子', () => {
        expect(resolveBriefPersona({ briefPersona: '  高冷，一個字打發人。 ' })).toBe('高冷，一個字打發人。');
        expect(characterVoice({ ...base, briefPersona: '高冷，一個字打發人。' })).toBe('高冷，一個字打發人。');
        expect(characterVoice(base)).toContain('話少');
    });
});
