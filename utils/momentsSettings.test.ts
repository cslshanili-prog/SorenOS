import { describe, expect, it } from 'vitest';
import { canAutoPost, DEFAULT_MOMENTS_SETTINGS, normalizeMomentsSettings, postIntervalFor, setMomentsNumber } from './momentsSettings';

describe('momentsSettings', () => {
    it('沒存過就是預設值，自動發帖預設關', () => {
        expect(normalizeMomentsSettings(undefined)).toEqual(DEFAULT_MOMENTS_SETTINGS);
        expect(DEFAULT_MOMENTS_SETTINGS.autoPostEnabled).toBe(false);
    });

    it('舊存檔沒有配角那組：補預設（比主角低），主角那組原樣保留', () => {
        const s = normalizeMomentsSettings({ commentProbability: 60, likeProbability: 50 });
        expect(s).toMatchObject({ commentProbability: 60, likeProbability: 50, supportingCommentProbability: 20, supportingLikeProbability: 50 });
        expect(s.supportingMinPostIntervalHours).toBeGreaterThan(s.minPostIntervalHours);
    });

    it('舊存檔的 NPC 那組搬成配角那組；新的那格有值就聽新的；之後不再存 npc*', () => {
        const old = { npcCommentProbability: 35, npcLikeProbability: 90, npcInteractionDelayMin: 10, replyToNpcDelaySec: 7 } as never;
        const s = normalizeMomentsSettings(old);
        expect(s).toMatchObject({ supportingCommentProbability: 35, supportingLikeProbability: 90, supportingInteractionDelayMin: 10, replyToSupportingDelaySec: 7 });
        expect('npcCommentProbability' in s).toBe(false);
        expect(normalizeMomentsSettings({ ...(old as object), supportingCommentProbability: 5 } as never).supportingCommentProbability).toBe(5);
    });

    it('配角的發文間隔自己一組，最長不小於最短；照戲份挑間隔', () => {
        const s = normalizeMomentsSettings({ supportingMinPostIntervalHours: 200, supportingMaxPostIntervalHours: 100 } as never);
        expect(s.supportingMaxPostIntervalHours).toBe(200);
        expect(setMomentsNumber(s, 'supportingMaxPostIntervalHours', 50).supportingMinPostIntervalHours).toBe(50);
        expect(postIntervalFor(s, true)).toEqual({ minPostIntervalHours: 200, maxPostIntervalHours: 200 });
        expect(postIntervalFor(s, false)).toEqual({ minPostIntervalHours: 48, maxPostIntervalHours: 72 });
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
