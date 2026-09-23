import { describe, it, expect } from 'vitest';
import { looksLikeSelfieDescription, shouldUseCharacterReference } from './imageGeneration';

describe('looksLikeSelfieDescription', () => {
    it('普通自拍描述判定為自拍', () => {
        expect(looksLikeSelfieDescription('在陽台自拍了一張')).toBe(true);
        expect(looksLikeSelfieDescription('今天心情不錯拍了張照')).toBe(true);
    });

    it('命中非自拍關鍵詞判定為非自拍', () => {
        expect(looksLikeSelfieDescription('和朋友的合照')).toBe(false);
        expect(looksLikeSelfieDescription('窗外的風景')).toBe(false);
        expect(looksLikeSelfieDescription('拍了張美食照')).toBe(false);
        expect(looksLikeSelfieDescription('路邊的一隻貓')).toBe(false);
    });

    it('空字符串兜底判定為自拍（不阻斷默認行為）', () => {
        expect(looksLikeSelfieDescription('')).toBe(true);
        expect(looksLikeSelfieDescription('   ')).toBe(true);
    });
});

describe('shouldUseCharacterReference', () => {
    const baseCfg = { referenceEnabled: true, referenceImage: 'blobref:x' };

    it('總開關沒開時不帶參考圖', () => {
        expect(shouldUseCharacterReference({ ...baseCfg, referenceEnabled: false })).toBe(false);
    });

    it('沒有參考圖時不帶', () => {
        expect(shouldUseCharacterReference({ ...baseCfg, referenceImage: undefined })).toBe(false);
    });

    it('cfg 是 undefined 時不帶', () => {
        expect(shouldUseCharacterReference(undefined)).toBe(false);
    });

    it('nonSelfieSkipsReference 關閉時無視描述內容，一律帶參考圖', () => {
        expect(shouldUseCharacterReference({ ...baseCfg, nonSelfieSkipsReference: false }, { description: '和朋友的合照' })).toBe(true);
    });

    it('nonSelfieSkipsReference 開啟（默認）時按描述判斷', () => {
        expect(shouldUseCharacterReference(baseCfg, { description: '在陽台自拍' })).toBe(true);
        expect(shouldUseCharacterReference(baseCfg, { description: '和朋友的合照' })).toBe(false);
    });

    it('forceSelfie 跳過關鍵詞判斷（OOTD/Moments 這類角色本人場景用）', () => {
        expect(shouldUseCharacterReference(baseCfg, { forceSelfie: true, description: '和朋友的合照' })).toBe(true);
    });

    it('沒傳 description 也沒 forceSelfie 時默認當自拍處理', () => {
        expect(shouldUseCharacterReference(baseCfg)).toBe(true);
    });
});
