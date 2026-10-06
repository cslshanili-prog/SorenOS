import { describe, it, expect } from 'vitest';
import { looksLikeSelfieDescription, shouldUseCharacterReference, imageGenRecord, describeImageGenRecord } from './imageGeneration';

describe('looksLikeSelfieDescription', () => {
    it('普通自拍描述判定為自拍', () => {
        expect(looksLikeSelfieDescription('在陽台自拍了一張')).toBe(true);
        expect(looksLikeSelfieDescription('今天心情不錯拍了張照')).toBe(true);
    });

    it('命中非自拍關鍵詞判定為非自拍', () => {
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
        expect(shouldUseCharacterReference(baseCfg, { description: '窗外的夜景' })).toBe(false);
    });

    it('forceSelfie 跳過關鍵詞判斷（OOTD/Moments 這類角色本人場景用）', () => {
        expect(shouldUseCharacterReference(baseCfg, { forceSelfie: true, description: '窗外的夜景' })).toBe(true);
    });

    it('沒傳 description 也沒 forceSelfie 時默認當自拍處理', () => {
        expect(shouldUseCharacterReference(baseCfg)).toBe(true);
    });
});

describe('2026-10-06：畫面裡有人的照樣帶參考圖', () => {
    it('場景詞跟「人在畫面裡」的詞同時出現時，算自拍', () => {
        expect(looksLikeSelfieDescription('在咖啡廳拿著手機對鏡自拍')).toBe(true);
        expect(looksLikeSelfieDescription('和朋友的合照')).toBe(true);
        expect(looksLikeSelfieDescription('我們一起在花海前')).toBe(true);
        expect(looksLikeSelfieDescription('穿著新買的大衣站在街道上')).toBe(true);
        expect(looksLikeSelfieDescription('selfie at a coffee shop')).toBe(true);
    });
    it('只有場景、物件的還是不帶', () => {
        expect(looksLikeSelfieDescription('窗外的夜景')).toBe(false);
        expect(looksLikeSelfieDescription('桌上的一杯咖啡')).toBe(false);
    });
    it('forceReference 跳過判斷，但沒開參考圖還是不帶', () => {
        const cfg = { referenceEnabled: true, referenceImage: 'blobref:x' } as any;
        expect(shouldUseCharacterReference(cfg, { description: '窗外的夜景', forceReference: true })).toBe(true);
        expect(shouldUseCharacterReference({ ...cfg, referenceEnabled: false }, { forceReference: true })).toBe(false);
    });
});

describe('imageGenRecord / describeImageGenRecord', () => {
    const cfg = { referenceEnabled: true, referenceImage: 'blobref:x' } as any;
    it('帶了參考圖：成功是 locked，失敗是 fallback 帶原因', () => {
        expect(imageGenRecord(cfg, true, { referenceUsed: true }, 1).reference).toBe('locked');
        const fb = imageGenRecord(cfg, true, { referenceUsed: false, referenceError: 'HTTP 400：unsupported' }, 1);
        expect(fb).toEqual({ reference: 'fallback', error: 'HTTP 400：unsupported', at: 1 });
        expect(describeImageGenRecord(fb)).toContain('HTTP 400');
    });
    it('沒帶：開了參考圖是 skipped，沒開是 off；舊訊息沒記錄是空字串', () => {
        expect(imageGenRecord(cfg, false, {}, 1).reference).toBe('skipped');
        expect(imageGenRecord(undefined, false, {}, 1).reference).toBe('off');
        expect(describeImageGenRecord(undefined)).toBe('');
    });
});
