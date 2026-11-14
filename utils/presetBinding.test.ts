import { describe, expect, it } from 'vitest';
import { charDateChoice, defaultStoryPresetId, resolveDatePresetId, scenesOfPreset } from './presetBinding';

describe('預設的場景綁定', () => {
    it('見面：角色自己選的 > 場景預設 > 內建', () => {
        const none = {};
        const def = { presetSceneDefaults: { date: 'p2' } };
        expect(resolveDatePresetId({}, none)).toBeUndefined();
        expect(resolveDatePresetId({}, def)).toBe('p2');
        expect(resolveDatePresetId({ dateMeetingPresetId: 'p1' }, def)).toBe('p1');
        expect(resolveDatePresetId({ dateMeetingPresetId: 'builtin' }, def)).toBeUndefined();
        expect(resolveDatePresetId({}, { presetSceneDefaults: { date: 'builtin' } })).toBeUndefined();
    });

    it('選的那份被刪了就往下一層退', () => {
        const def = { presetSceneDefaults: { date: 'p2' } };
        expect(resolveDatePresetId({ dateMeetingPresetId: 'gone' }, def, id => id === 'p2')).toBe('p2');
        expect(resolveDatePresetId({ dateMeetingPresetId: 'gone' }, def, () => false)).toBeUndefined();
    });

    it('角色那格的狀態、舊預設算見面、劇情新開預設', () => {
        expect(charDateChoice({})).toBe('follow');
        expect(charDateChoice({ dateMeetingPresetId: 'builtin' })).toBe('builtin');
        expect(charDateChoice({ dateMeetingPresetId: 'p1' })).toBe('p1');
        expect(scenesOfPreset({ doc: {} as any })).toEqual(['date']);
        expect(scenesOfPreset({ doc: { scenes: ['date', 'chat'] } as any })).toEqual(['date', 'chat']);
        expect(defaultStoryPresetId({ presetSceneDefaults: { story: 's2' } }, ['s1', 's2'])).toBe('s2');
        expect(defaultStoryPresetId({ presetSceneDefaults: { story: 'gone' } }, ['s1', 's2'])).toBe('s1');
        expect(defaultStoryPresetId({}, [])).toBeUndefined();
    });
});
