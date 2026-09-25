import { describe, expect, it } from 'vitest';
import { canAutoPost, DEFAULT_MOMENTS_SETTINGS, normalizeMomentsSettings, setMomentsNumber } from './momentsSettings';

describe('momentsSettings', () => {
    it('沒存過就是預設值，自動發帖預設關', () => {
        expect(normalizeMomentsSettings(undefined)).toEqual(DEFAULT_MOMENTS_SETTINGS);
        expect(DEFAULT_MOMENTS_SETTINGS.autoPostEnabled).toBe(false);
    });

    it('舊存檔沒有 NPC 機率：補預設，角色那組原樣保留', () => {
        const s = normalizeMomentsSettings({ commentProbability: 60, likeProbability: 50 });
        expect(s).toMatchObject({ commentProbability: 60, likeProbability: 50, npcCommentProbability: 20, npcLikeProbability: 75 });
    });

    it('缺欄位補預設、超出範圍夾回、壞值忽略', () => {
        const s = normalizeMomentsSettings({ commentProbability: 180, likeProbability: -5, firstCommentDelaySec: NaN } as never);
        expect(s.commentProbability).toBe(100);
        expect(s.likeProbability).toBe(0);
        expect(s.firstCommentDelaySec).toBe(DEFAULT_MOMENTS_SETTINGS.firstCommentDelaySec);
        expect(s.minPostIntervalHours).toBe(48);
    });

    it('最長間隔不會小於最短間隔', () => {
        expect(normalizeMomentsSettings({ minPostIntervalHours: 80, maxPostIntervalHours: 10 }).maxPostIntervalHours).toBe(80);
        const base = normalizeMomentsSettings({});
        expect(setMomentsNumber(base, 'minPostIntervalHours', 100).maxPostIntervalHours).toBe(100);
        expect(setMomentsNumber(base, 'maxPostIntervalHours', 20).minPostIntervalHours).toBe(20);
    });

    it('poster 清單去重並濾掉壞值', () => {
        const s = normalizeMomentsSettings({ disabledPosterIds: ['a', 'a', '', 3 as never, 'b'] });
        expect(s.disabledPosterIds).toEqual(['a', 'b']);
    });

    it('canAutoPost：總開關關著誰都不發；開著時被關掉的不發', () => {
        const off = normalizeMomentsSettings({ disabledPosterIds: ['b'] });
        expect(canAutoPost(off, 'a')).toBe(false);
        const on = { ...off, autoPostEnabled: true };
        expect(canAutoPost(on, 'a')).toBe(true);
        expect(canAutoPost(on, 'b')).toBe(false);
    });
});
