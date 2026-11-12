import { describe, expect, it } from 'vitest';
import { apiForStyle, applyStyleToPrompt, BUILTIN_STYLES, canGenerateFor, isImageFeatureOff, resolveImageStyle, LEGACY_STYLE_ID, normalizeImageGenConfig, pickStyle, resetBuiltinStyle, restoreBuiltinStyles, STYLE_NONE, stripInvisible } from './imageStyle';

describe('搬遷', () => {
    const old = { charImageGenEnabled: true, baseUrl: 'https://a', apiKey: 'k', model: 'm1', size: '1024x1024', extraPrompt: '水彩風' };
    it('舊的單組 API 變第一組；補充提示詞搬成全域畫風；放進內建', () => {
        const n = normalizeImageGenConfig(old)!;
        expect(n.apiPresets).toEqual([{ id: 'img-api-1', name: 'm1', baseUrl: 'https://a', apiKey: 'k', model: 'm1', size: '1024x1024' }]);
        expect(n.activeApiId).toBe('img-api-1');
        expect(n.extraPrompt).toBeUndefined();
        expect(n.globalStyleId).toBe(LEGACY_STYLE_ID);
        expect(n.stylePresets![0]).toEqual({ id: LEGACY_STYLE_ID, name: '我原本的補充提示詞', prompt: '水彩風' });
        expect(n.stylePresets!.length).toBe(1 + BUILTIN_STYLES.length);
        expect(n.charImageGenEnabled).toBe(true);
    });
    it('冪等；刪掉的內建不再補；頂層跟著全域那組', () => {
        const n = normalizeImageGenConfig(old)!;
        expect(normalizeImageGenConfig(n)).toEqual(n);
        const removed = normalizeImageGenConfig({ ...n, stylePresets: n.stylePresets!.slice(0, 1) })!;
        expect(removed.stylePresets!.length).toBe(1);
        const two = normalizeImageGenConfig({ ...n, apiPresets: [...n.apiPresets!, { id: 'b', name: 'B', baseUrl: 'https://b', apiKey: 'kb', model: 'm2' }], activeApiId: 'b' })!;
        expect([two.baseUrl, two.apiKey, two.model, two.size]).toEqual(['https://b', 'kb', 'm2', undefined]);
    });
    it('沒填過補充提示詞：不設全域畫風；全域指到刪掉的那套就清掉', () => {
        const n = normalizeImageGenConfig({ baseUrl: 'https://a', model: 'm' })!;
        expect(n.globalStyleId).toBeUndefined();
        expect(normalizeImageGenConfig({ ...n, globalStyleId: 'gone' })!.globalStyleId).toBeUndefined();
    });
    it('恢復內建：補回刪掉的、原文還原', () => {
        expect(restoreBuiltinStyles([]).length).toBe(BUILTIN_STYLES.length);
        const edited = { ...BUILTIN_STYLES[0], id: 'x', prompt: '改過', apiId: 'b' };
        expect(resetBuiltinStyle(edited)).toMatchObject({ id: 'x', prompt: BUILTIN_STYLES[0].prompt, apiId: 'b' });
    });
});

describe('套用', () => {
    const cfg = normalizeImageGenConfig({ baseUrl: 'https://a', model: 'm', apiKey: 'k', globalStyleId: 'style-builtin-anime' })!;
    it('跟全域、指定、不套', () => {
        expect(pickStyle(cfg)?.name).toBe('精緻二次元');
        expect(pickStyle(cfg, 'style-builtin-cg')?.name).toBe('半寫實 CG');
        expect(pickStyle(cfg, STYLE_NONE)).toBeUndefined();
        expect(pickStyle(cfg, 'gone')?.name).toBe('精緻二次元');
    });
    it('有人才加人像段；負面寫成文字或欄位', () => {
        const style = { id: 's', name: 's', prompt: '畫風A', portraitPrompt: '臉部特寫', negativePrompt: 'blurry' };
        expect(applyStyleToPrompt('一杯咖啡', style, { hasPerson: false }).prompt).toBe('一杯咖啡\n\n畫風A\n\n避免（Negative）：blurry');
        const withField = applyStyleToPrompt('自拍', style, { hasPerson: true, negativeAsField: true });
        expect(withField).toEqual({ prompt: '自拍\n\n畫風A\n\n臉部特寫', negativePrompt: 'blurry' });
        expect(applyStyleToPrompt('x', undefined, { hasPerson: true })).toEqual({ prompt: 'x' });
    });
    it('清掉看不見的字元', () => {
        expect(stripInvisible('a​⁠b﻿')).toBe('ab');
    });
    it('偏好的 API 跟全域不同才算', () => {
        const c = { apiPresets: [{ id: 'a', name: 'A', baseUrl: '', apiKey: '', model: '' }, { id: 'b', name: 'B', baseUrl: '', apiKey: '', model: '' }], activeApiId: 'a' };
        expect(apiForStyle(c, { id: 's', name: 's', prompt: '', apiId: 'b' }).preferred?.id).toBe('b');
        expect(apiForStyle(c, { id: 's', name: 's', prompt: '', apiId: 'a' }).preferred).toBeUndefined();
        expect(apiForStyle(c, undefined).global?.id).toBe('a');
    });
});

describe('誰用哪一套（b）', () => {
    const cfg = { stylePresets: [{ id: 'a', name: 'A', prompt: '' }, { id: 'b', name: 'B', prompt: '' }, { id: 'c', name: 'C', prompt: '' }], featureStyles: { moments: 'c', library: 'b', ootd: 'off' } };
    const worlds: Record<string, string> = { w1: 'b' };
    const worldStyleOf = (g: string | undefined) => (g ? worlds[g] : undefined);
    const char = { groupId: 'w1', imageGenCharConfig: { styleId: 'a' } };
    it('這一次 > 角色 > 世界 > 功能那格 > 全域', () => {
        expect(resolveImageStyle(cfg, { feature: 'moments', char, override: 'c', worldStyleOf })).toEqual({ off: false, styleId: 'c' });
        expect(resolveImageStyle(cfg, { feature: 'moments', char, worldStyleOf }).styleId).toBe('a');
        expect(resolveImageStyle(cfg, { feature: 'moments', char: { groupId: 'w1' }, worldStyleOf }).styleId).toBe('b');
        expect(resolveImageStyle(cfg, { feature: 'moments', char: { groupId: 'w9' }, worldStyleOf }).styleId).toBe('c');
        expect(resolveImageStyle(cfg, { feature: 'chatPhoto', char: {}, worldStyleOf })).toEqual({ off: false });
    });
    it('關閉誰也蓋不過；不套畫風也算一層；刪掉的往下找', () => {
        expect(resolveImageStyle(cfg, { feature: 'ootd', char, override: 'a', worldStyleOf })).toEqual({ off: true });
        expect(resolveImageStyle(cfg, { feature: 'moments', char: { imageGenCharConfig: { styleId: STYLE_NONE } } }).styleId).toBe(STYLE_NONE);
        expect(resolveImageStyle(cfg, { feature: 'moments', char: { groupId: 'w1', imageGenCharConfig: { styleId: 'gone' } }, worldStyleOf }).styleId).toBe('b');
    });
    it('小號照本人；資料庫不看角色和世界', () => {
        expect(resolveImageStyle(cfg, { feature: 'avatar', char: { altOf: 'o', imageGenCharConfig: { styleId: 'c' } }, owner: { imageGenCharConfig: { styleId: 'a' } } }).styleId).toBe('a');
        expect(resolveImageStyle(cfg, { feature: 'library', char, worldStyleOf }).styleId).toBe('b');
        expect(isImageFeatureOff(cfg, 'ootd')).toBe(true);
        expect(canGenerateFor({ charImageGenEnabled: true, baseUrl: 'x', model: 'm', featureStyles: { ootd: 'off' } }, 'ootd')).toBe(false);
        expect(canGenerateFor({ charImageGenEnabled: true, baseUrl: 'x', model: 'm' }, 'ootd')).toBe(true);
    });
});
