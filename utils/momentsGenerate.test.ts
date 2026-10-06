import { describe, expect, it } from 'vitest';
import { pickRefreshPosters, buildMomentContextBlock, MOMENT_PRIVACY_NOTE } from './momentsGenerate';
import { buildTrajectoryMomentsPrompt } from './trajectory';

describe('重整時挑誰發文', () => {
    const chars = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id }));

    it('挑 1～3 位、不重複', () => {
        for (const r of [0, 0.34, 0.67, 0.99]) {
            let i = 0;
            const seq = [r, 0.1, 0.5, 0.9, 0.3];
            const picked = pickRefreshPosters(chars, () => seq[i++ % seq.length]);
            expect(picked.length).toBeGreaterThanOrEqual(1);
            expect(picked.length).toBeLessThanOrEqual(3);
            expect(new Set(picked.map(p => p.id)).size).toBe(picked.length);
        }
    });

    it('只有一位或沒有角色時照單全收', () => {
        expect(pickRefreshPosters([{ id: 'a' }])).toEqual([{ id: 'a' }]);
        expect(pickRefreshPosters([])).toEqual([]);
    });
});

describe('buildMomentContextBlock（2026-10-06：發朋友圈帶時間、日程、最近聊天）', () => {
    it('三段都有：時間照給的那個 Date、正在做什麼、聊天原樣接在後面', () => {
        const block = buildMomentContextBlock({
            now: new Date(2026, 9, 6, 22, 5),
            activity: '在家追劇',
            chatBlock: '## 最近的聊天記錄（與「小美」）\n小美: 今天好累',
        });
        expect(block).toContain('## 此刻');
        expect(block).toContain('現在是 2026-10-06 星期二 22:05');
        expect(block).toContain('你這個時段正在：在家追劇');
        expect(block).toContain('小美: 今天好累');
    });
    it('都沒有就是空字串；只有聊天也會給', () => {
        expect(buildMomentContextBlock({})).toBe('');
        expect(buildMomentContextBlock({ chatBlock: '  ' })).toBe('');
        expect(buildMomentContextBlock({ chatBlock: 'x: y' })).toContain('x: y');
    });
});

describe('朋友圈提示詞的公開提醒', () => {
    it('有給 privacyNote 才加，叫角色別引用私聊原話', () => {
        expect(buildTrajectoryMomentsPrompt('role', [], { privacyNote: MOMENT_PRIVACY_NOTE })).toContain('不要引用你們私聊的原話');
        expect(buildTrajectoryMomentsPrompt('role', [])).not.toContain('私聊');
    });
});
