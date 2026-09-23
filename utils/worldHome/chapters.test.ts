import { describe, it, expect } from 'vitest';
import { worldTimeLabel, buildWorldCharTurn } from './prompts';
import {
    shouldCloseChapter, buildChapterDigest, buildChapterSummaryPrompt, parseChapterSummary,
    SIM_CHAPTER_CLOCKS, SIM_CHAPTER_DAYS,
} from './chapters';
import type { CharacterProfile, WorldProfile, WorldEpisode } from '../../types';

const mkChar = (id: string, name: string): CharacterProfile => ({ id, name } as CharacterProfile);
const mkWorld = (overrides: Partial<WorldProfile> = {}): WorldProfile => ({
    id: 'w1', name: '栗子鎮', worldview: '海邊小鎮', mode: 'light',
    memberIds: ['a', 'b'], npcs: [], houses: [], relationships: [],
    storyClock: 0, createdAt: 0, updatedAt: 0,
    ...overrides,
});

describe('worldTimeLabel（時間模式感知）', () => {
    it('real 模式沿用「第N天 早/中/晚/凌晨」（凌晨按次日稱呼）', () => {
        expect(worldTimeLabel(mkWorld({ timeMode: 'real', storyClock: 0 }))).toBe('第1天早上');
        expect(worldTimeLabel(mkWorld({ timeMode: 'real', storyClock: 3 }))).toBe('第2天凌晨');
        expect(worldTimeLabel(mkWorld({ timeMode: 'real', storyClock: 4 }))).toBe('第2天早上');
        expect(worldTimeLabel(mkWorld({ timeMode: 'real', storyClock: 6 }))).toBe('第2天晚上');
    });
    it('未設 timeMode 的舊世界按 real', () => {
        expect(worldTimeLabel(mkWorld({ storyClock: 2 }))).toBe('第1天晚上');
    });
    it('sim 模式從起始日期按「天」推進（一天四段）為真實日曆日期', () => {
        const w = mkWorld({ timeMode: 'sim', simStartDate: { year: 2024, month: 3, day: 1 } });
        expect(worldTimeLabel(w, 0)).toContain('2024年3月1日');
        expect(worldTimeLabel(w, 0)).toContain('早上');
        expect(worldTimeLabel(w, 2)).toContain('2024年3月1日'); // 同一天的晚上
        expect(worldTimeLabel(w, 2)).toContain('晚上');
        expect(worldTimeLabel(w, 3)).toContain('2024年3月2日'); // 凌晨發生在次日 0~5 點，顯示次日日期
        expect(worldTimeLabel(w, 3)).toContain('凌晨');
        expect(worldTimeLabel(w, 4)).toContain('2024年3月2日'); // 滿四段進第二天
        expect(worldTimeLabel(w, 4)).toContain('早上');
    });
    it('sim 模式跨月進位正確', () => {
        const w = mkWorld({ timeMode: 'sim', simStartDate: { year: 2024, month: 1, day: 31 } });
        expect(worldTimeLabel(w, 3)).toContain('2024年2月1日'); // 1月31日的凌晨 = 2月1日 0~5 點
        expect(worldTimeLabel(w, 4)).toContain('2024年2月1日');
    });
});

describe('shouldCloseChapter（結卷邊界）', () => {
    it('real 模式永不結卷', () => {
        expect(shouldCloseChapter(mkWorld({ timeMode: 'real' }), SIM_CHAPTER_CLOCKS)).toBe(false);
    });
    it('sim 模式：滿 20 天（80 輪）整數倍才結卷', () => {
        const w = mkWorld({ timeMode: 'sim' });
        expect(shouldCloseChapter(w, SIM_CHAPTER_CLOCKS - 1)).toBe(false);
        expect(shouldCloseChapter(w, SIM_CHAPTER_CLOCKS)).toBe(true);
        expect(shouldCloseChapter(w, SIM_CHAPTER_CLOCKS * 2)).toBe(true);
        expect(shouldCloseChapter(w, SIM_CHAPTER_CLOCKS * 2 - 2)).toBe(false);
    });
    it('已歸檔過的時鐘不再重複結卷', () => {
        const w = mkWorld({ timeMode: 'sim', simSummarizedClock: SIM_CHAPTER_CLOCKS });
        expect(shouldCloseChapter(w, SIM_CHAPTER_CLOCKS)).toBe(false);
    });
});

describe('章節總結的解析與防上帝視角', () => {
    const members = [mkChar('a', '小滿'), mkChar('b', '阿嵐')];

    it('parseChapterSummary：每人單視角按名字回填到 charId，過濾非成員', () => {
        const raw = JSON.stringify({
            synopsis: '這二十天裡兩人漸漸走近。',
            relationshipEval: '小滿對阿嵐的好感明顯上升。',
            atmosphere: '微妙的曖昧。',
            perspectives: [
                { name: '小滿', text: '我好像越來越在意阿嵐了。' },
                { name: '阿嵐', text: '小滿最近總往我這跑。' },
                { name: '路人', text: '不該出現' },
            ],
        });
        const out = parseChapterSummary(raw, members);
        expect(out.synopsis).toContain('漸漸走近');
        expect(out.atmosphere).toBe('微妙的曖昧。');
        expect(out.perspectives).toHaveLength(2);
        expect(out.perspectives.find(p => p.charId === 'a')!.text).toContain('在意阿嵐');
        expect(out.perspectives.some(p => p.charName === '路人')).toBe(false);
    });

    it('parseChapterSummary：解析失敗時整段原文兜底進 synopsis', () => {
        const out = parseChapterSummary('這是一段沒有 JSON 的總結。', members);
        expect(out.synopsis).toContain('沒有 JSON');
        expect(out.perspectives).toEqual([]);
    });

    it('buildChapterSummaryPrompt：要求為每個角色各出一條單視角', () => {
        const prompt = buildChapterSummaryPrompt({
            world: mkWorld(), members, fromLabel: '2024年3月1日', toLabel: '2024年3月20日',
            digest: '（原文摘要）',
        });
        expect(prompt).toContain('小滿、阿嵐');
        expect(prompt).toContain('單方面');
        expect(prompt).toContain(String(SIM_CHAPTER_DAYS));
    });

    it('buildChapterDigest：按時間正序，保留瞞下的事供全知總結器', () => {
        const eps: WorldEpisode[] = [
            { id: 'e2', worldId: 'w1', round: 2, storyTime: 'D2', trigger: 'observe', beats: [{ charId: 'a', charName: '小滿', location: '鎮上', narrative: 'n', mood: 'm', timeline: [{ time: '22:00', place: '酒吧', event: '偷偷喝酒', shared: false }] }], summary: 's2', createdAt: 0 },
            { id: 'e1', worldId: 'w1', round: 1, storyTime: 'D1', trigger: 'observe', beats: [{ charId: 'a', charName: '小滿', location: '家', narrative: 'n', mood: 'm' }], summary: 's1', createdAt: 0 },
        ];
        const digest = buildChapterDigest(eps);
        expect(digest.indexOf('D1')).toBeLessThan(digest.indexOf('D2')); // 正序
        expect(digest).toContain('〔瞞〕'); // 瞞下的事保留給全知總結器
    });

    it('防上帝視角：buildWorldCharTurn 只喂該角色自己的單視角與氛圍，絕不喂全知 synopsis', () => {
        const world = mkWorld({ timeMode: 'sim' });
        const turn = buildWorldCharTurn({
            world, char: members[0], members, storyTime: '2024年3月21日 週四 白天', round: 41, beatsSoFar: [],
            priorChapter: { atmosphere: '微妙的曖昧', charPerspective: '我好像越來越在意阿嵐了。' },
            userName: '',
        });
        expect(turn).toContain('前情（這是你自己的視角');
        expect(turn).toContain('越來越在意阿嵐');
        expect(turn).toContain('微妙的曖昧');
        // 別人單方面的內心、全知梗概都不該出現在這名角色的上下文裡
        expect(turn).not.toContain('阿嵐最近總往我這跑');
    });
});
