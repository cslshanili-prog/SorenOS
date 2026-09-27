import { describe, expect, it } from 'vitest';
import type { CharacterProfile } from '../types';
import {
    applyExtractedExamples, buildExtractExamplesPrompt, clampExamplesCutoff, contextWindowFloor,
    formatDialogueExamplesBlock, shouldIncludeDialogueExamples,
} from './dialogueExamples';

const char = (patch: Partial<CharacterProfile> = {}) => ({
    dialogueExamples: '{{user}}：在幹嘛\n{{char}}：……睡覺。',
    ...patch,
}) as CharacterProfile;

describe('對話範例 · 要不要附上', () => {
    it('沒填就不附', () => {
        expect(shouldIncludeDialogueExamples(char({ dialogueExamples: '  ' }), 0)).toBe(false);
    });
    it('聊到門檻前附上，到了就不附（預設 60）', () => {
        expect(shouldIncludeDialogueExamples(char(), 59)).toBe(true);
        expect(shouldIncludeDialogueExamples(char(), 60)).toBe(false);
        expect(shouldIncludeDialogueExamples(char({ dialogueExamplesCutoff: 100 }), 80)).toBe(true);
    });
    it('一直附上', () => {
        expect(shouldIncludeDialogueExamples(char({ dialogueExamplesAlways: true }), 5000)).toBe(true);
    });
    it('不知道聊了幾則（別的 App）就附上', () => {
        expect(shouldIncludeDialogueExamples(char(), undefined)).toBe(true);
    });
    it('上下文設得太小：一直附上', () => {
        expect(shouldIncludeDialogueExamples(char({ contextLimit: 20 }), 500)).toBe(true);
        expect(shouldIncludeDialogueExamples(char({ contextLimit: 30 }), 500)).toBe(false);
    });
    it('自動範圍看記憶宮殿熱區', () => {
        const auto = { contextRangeMode: 'adaptive' as const, autoArchiveEnabled: true };
        expect(contextWindowFloor(char(auto))).toBe(200);
        expect(contextWindowFloor(char({ ...auto, memoryPalaceWaterline: { preset: 'offline' } }))).toBe(50);
        expect(contextWindowFloor(char({ ...auto, memoryPalaceWaterline: { preset: 'custom', hotZoneSize: 20, bufferThreshold: 10 } }))).toBe(20);
        expect(shouldIncludeDialogueExamples(char({ ...auto, memoryPalaceWaterline: { preset: 'custom', hotZoneSize: 20, bufferThreshold: 10 } }), 500)).toBe(true);
    });
    it('門檻夾在 20～300', () => {
        expect(clampExamplesCutoff(5)).toBe(20);
        expect(clampExamplesCutoff(999)).toBe(300);
        expect(clampExamplesCutoff(undefined)).toBe(60);
    });
});

describe('對話範例 · 區塊', () => {
    it('標成口吻示範、換掉 {{char}} {{user}}', () => {
        const block = formatDialogueExamplesBlock(char().dialogueExamples, '周以衡', '小星');
        expect(block).toContain('說話風格示範');
        expect(block).toContain('不是你們真的發生過的對話');
        expect(block).toContain('不要照抄');
        expect(block).toContain('小星：在幹嘛\n周以衡：……睡覺。');
    });
    it('空的就不輸出', () => {
        expect(formatDialogueExamplesBlock('', 'a', 'b')).toBe('');
    });
});

describe('對話範例 · AI 拆出範例', () => {
    const persona = `你是周以衡，高冷話少。
說話簡短，愛用反問。

【對話範例】
小星：週末要不要去看電影？
周以衡：……看什麼。

背景：大學生，影評社社長。`;

    it('提示詞要求一字不差、不挑說話規則', () => {
        const prompt = buildExtractExamplesPrompt(persona);
        expect(prompt).toContain('一字不差');
        expect(prompt).toContain('描述說話風格的規則');
        expect(prompt).toContain('影評社社長');
    });

    it('原文找得到的段落搬走，小標題一起清掉', () => {
        const raw = JSON.stringify({ examples: ['小星：週末要不要去看電影？\n周以衡：……看什麼。'] });
        const result = applyExtractedExamples(persona, raw);
        expect(result.found).toBe(1);
        expect(result.examples).toBe('小星：週末要不要去看電影？\n周以衡：……看什麼。');
        expect(result.persona).toBe('你是周以衡，高冷話少。\n說話簡短，愛用反問。\n\n背景：大學生，影評社社長。');
    });

    it('換行、空白不同也認得', () => {
        const raw = JSON.stringify({ examples: ['小星：週末要不要去看電影？ 周以衡：……看什麼。'] });
        const result = applyExtractedExamples(persona, raw);
        expect(result.found).toBe(1);
        expect(result.examples).toContain('\n周以衡');
    });

    it('模型改寫過的段落不動人設', () => {
        const raw = JSON.stringify({ examples: ['小星：要看電影嗎？\n周以衡：看什麼'] });
        const result = applyExtractedExamples(persona, raw);
        expect(result.found).toBe(0);
        expect(result.missed).toBe(1);
        expect(result.persona).toBe(persona);
        expect(result.examples).toBe('');
    });

    it('有段落沒找到：小標題留著', () => {
        const withTwo = persona + '\n\n【示例】\n周以衡：嗯。';
        const raw = JSON.stringify({ examples: ['周以衡：嗯。', '亂寫的一段不存在的內容'] });
        const result = applyExtractedExamples(withTwo, raw);
        expect(result.found).toBe(1);
        expect(result.persona).toContain('【對話範例】');
        expect(result.persona).toContain('【示例】');
    });

    it('沒有範例、或不是 JSON：原封不動', () => {
        expect(applyExtractedExamples(persona, '{"examples":[]}').persona).toBe(persona);
        expect(applyExtractedExamples(persona, '我找不到').found).toBe(0);
    });

    it('特殊符號不會弄壞比對', () => {
        const p = '規則 (a+b)*\n範例：\n他：[笑] 真的？$100？';
        const result = applyExtractedExamples(p, JSON.stringify({ examples: ['他：[笑]  真的？$100？'] }));
        expect(result.found).toBe(1);
        expect(result.persona).toBe('規則 (a+b)*');
    });
});
