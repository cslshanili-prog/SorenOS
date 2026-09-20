import { describe, it, expect } from 'vitest';
import { looksLikeSelfieDescription, shouldUseCharacterReference } from './imageGeneration';

describe('looksLikeSelfieDescription', () => {
    it('普通自拍描述判定为自拍', () => {
        expect(looksLikeSelfieDescription('在阳台自拍了一张')).toBe(true);
        expect(looksLikeSelfieDescription('今天心情不错拍了张照')).toBe(true);
    });

    it('命中非自拍关键词判定为非自拍', () => {
        expect(looksLikeSelfieDescription('和朋友的合照')).toBe(false);
        expect(looksLikeSelfieDescription('窗外的风景')).toBe(false);
        expect(looksLikeSelfieDescription('拍了张美食照')).toBe(false);
        expect(looksLikeSelfieDescription('路边的一只猫')).toBe(false);
    });

    it('空字符串兜底判定为自拍（不阻断默认行为）', () => {
        expect(looksLikeSelfieDescription('')).toBe(true);
        expect(looksLikeSelfieDescription('   ')).toBe(true);
    });
});

describe('shouldUseCharacterReference', () => {
    const baseCfg = { referenceEnabled: true, referenceImage: 'blobref:x' };

    it('总开关没开时不带参考图', () => {
        expect(shouldUseCharacterReference({ ...baseCfg, referenceEnabled: false })).toBe(false);
    });

    it('没有参考图时不带', () => {
        expect(shouldUseCharacterReference({ ...baseCfg, referenceImage: undefined })).toBe(false);
    });

    it('cfg 是 undefined 时不带', () => {
        expect(shouldUseCharacterReference(undefined)).toBe(false);
    });

    it('nonSelfieSkipsReference 关闭时无视描述内容，一律带参考图', () => {
        expect(shouldUseCharacterReference({ ...baseCfg, nonSelfieSkipsReference: false }, { description: '和朋友的合照' })).toBe(true);
    });

    it('nonSelfieSkipsReference 开启（默认）时按描述判断', () => {
        expect(shouldUseCharacterReference(baseCfg, { description: '在阳台自拍' })).toBe(true);
        expect(shouldUseCharacterReference(baseCfg, { description: '和朋友的合照' })).toBe(false);
    });

    it('forceSelfie 跳过关键词判断（OOTD/Moments 这类角色本人场景用）', () => {
        expect(shouldUseCharacterReference(baseCfg, { forceSelfie: true, description: '和朋友的合照' })).toBe(true);
    });

    it('没传 description 也没 forceSelfie 时默认当自拍处理', () => {
        expect(shouldUseCharacterReference(baseCfg)).toBe(true);
    });
});
