import { describe, expect, it } from 'vitest';
import { buildBuiltinMeetingPresetDoc } from './builtin';
import { assembleMeetingPreset } from './assemble';
import { DATE_FORMAT_RULES, DATE_PROSE_INTRO, DATE_STYLE_PRESETS, DIG_FOCUS_HINTS } from '../datePrompts';
import { buildStPreset } from './stExport';
import { parseStPreset } from './stImport';

const env = { charName: '凱恩', userName: '小雨', rng: () => 0, timeZone: 'Asia/Taipei' };
const history = [
    { role: 'assistant' as const, content: '「來了？」' },
    { role: 'user' as const, content: '「嗯，剛到。」' },
];

describe('內建規則寫成預設', () => {
    it('文風、人稱、深挖照角色現在的設定開；只開一個文風', () => {
        const doc = buildBuiltinMeetingPresetDoc({ style: 'lyrical', pov: 'third-you', digDeeper: false, extra: '多寫雨聲' });
        const on = (id: string) => doc.prompts.find(p => p.id === id)?.enabled;
        expect(doc.prompts.filter(p => p.id.startsWith('builtin_style_') && p.enabled).map(p => p.id)).toEqual(['builtin_style_lyrical']);
        expect(on('builtin_pov_third-you')).toBe(true);
        expect(on('builtin_pov_first-you')).toBe(false);
        expect(on('builtin_dig')).toBe(false);
        expect(on('builtin_turn_note')).toBe(false);
        expect(on('builtin_turn_note_plain')).toBe(true);
        expect(on('builtin_extra')).toBe(true);
        expect(doc.prompts.find(p => p.id === 'builtin_extra')?.content).toContain('多寫雨聲');
    });

    it('沒設定：電影感、不指定人稱、深挖開著、沒有額外要求', () => {
        const doc = buildBuiltinMeetingPresetDoc();
        expect(doc.prompts.find(p => p.id === 'builtin_style_cinematic')?.enabled).toBe(true);
        expect(doc.prompts.filter(p => p.id.startsWith('builtin_pov_')).every(p => !p.enabled)).toBe(true);
        expect(doc.prompts.find(p => p.id === 'builtin_turn_note')?.enabled).toBe(true);
        expect(doc.prompts.find(p => p.id === 'builtin_extra')?.enabled).toBe(false);
        expect(doc.prompts.filter(p => p.slot === 'chatHistory')).toHaveLength(1);
        // 每個條目都在某個分組裡
        const grouped = new Set(doc.groups.flatMap(g => g.promptIds));
        expect(doc.prompts.every(p => grouped.has(p.id))).toBe(true);
    });

    it('拼出來：內建的框架和格式都在，名字換成角色，佔位照順序填，每輪提醒貼在最後、線索每輪抽一條', () => {
        const doc = buildBuiltinMeetingPresetDoc({ pov: 'third-name' });
        const { messages } = assembleMeetingPreset({
            doc,
            slots: { charDescription: '你是凱恩', personaDescription: '小雨是你的戀人', scenario: '雨夜的咖啡館', memory: '上週一起看了電影' },
            history,
            env,
        });
        const all = messages.map(m => m.content).join('\n');
        expect(all).toContain(DATE_PROSE_INTRO);
        expect(all).toContain(DATE_FORMAT_RULES);
        expect(all).toContain(DATE_STYLE_PRESETS[0].block.trim());
        expect(all).toContain('稱呼你自己為「凱恩」，稱呼對方為「小雨」');
        expect(all).toContain('小雨的話裡，引號裡的是說出口的');
        expect(all).not.toContain('{{');
        const at = (text: string) => messages.findIndex(m => m.content.includes(text));
        expect(at('你是凱恩')).toBeLessThan(at('面對面見面'));
        expect(at('雨夜的咖啡館')).toBeGreaterThan(at('面對面見面'));
        expect(messages.at(-2)?.content).toBe('「嗯，剛到。」');
        expect(messages.at(-1)).toEqual({ role: 'system', content: expect.stringContaining(`本輪線索：${DIG_FOCUS_HINTS[0]}`) });
    });

    it('匯出再匯回原樣', () => {
        const doc = buildBuiltinMeetingPresetDoc({ style: 'plain' });
        expect(parseStPreset(JSON.stringify(buildStPreset(doc)), '內建規則.json')).toEqual(doc);
    });
});
