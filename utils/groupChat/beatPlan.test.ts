import { describe, it, expect } from 'vitest';
import {
    buildBeatPlanPrompt,
    enforceBeatRules,
    fallbackBeatPlan,
    maxBeatsFor,
    memberBrief,
    parseBeatPlan,
    resolveBeatPlanApi,
    type BeatMember,
} from './beatPlan';
import { buildRoundRobinInstruction } from './prompts';

const members: BeatMember[] = [
    { id: 'c1', name: '小夏', brief: '話多的學妹' },
    { id: 'c2', name: '阿方', brief: '冷面工程師' },
    { id: 'n1', name: '房東', supporting: true },
];

describe('出場表拍數', () => {
    it('氣泡上限 ÷ 1.5，至少 2、最多 8，也不超過每人兩拍', () => {
        expect(maxBeatsFor(10, 5)).toBe(7);
        expect(maxBeatsFor(4, 5)).toBe(3);
        expect(maxBeatsFor(16, 5)).toBe(8);
        expect(maxBeatsFor(16, 2)).toBe(4);
        expect(maxBeatsFor(undefined, 1)).toBe(2);
    });
});

describe('解析出場表', () => {
    it('名字對到成員、intent 留著；程式碼框和前後雜字都容得下', () => {
        const raw = '好的\n```json\n[{"speaker":"阿方","intent":"回答U的問題"},{"speaker":"「小夏」","intent":"吐槽阿方"},{"speaker":"阿方","intent":"回嘴"}]\n```';
        expect(parseBeatPlan(raw, members, 7)).toEqual([
            { speakerId: 'c2', intent: '回答U的問題' },
            { speakerId: 'c1', intent: '吐槽阿方' },
            { speakerId: 'c2', intent: '回嘴' },
        ]);
    });

    it('對不上的名字丟掉；同一人連兩拍、第三次出場、超過拍數都剪掉', () => {
        const raw = JSON.stringify([
            { speaker: '路人' }, { speaker: '小夏' }, { speaker: '小夏' }, { speaker: '阿方' },
            { speaker: '小夏' }, { speaker: '房東' }, { speaker: '小夏' }, { speaker: '阿方' },
        ]);
        expect(parseBeatPlan(raw, members, 4)!.map(b => b.speakerId)).toEqual(['c1', 'c2', 'c1', 'n1']);
    });

    it('壞掉或一拍都沒有就回 null', () => {
        expect(parseBeatPlan('我覺得小夏先說', members, 5)).toBeNull();
        expect(parseBeatPlan('[{"speaker":"不存在"}]', members, 5)).toBeNull();
        expect(parseBeatPlan('[{"speaker":', members, 5)).toBeNull();
    });

    it('規則本身：不連著同一人、每人最多兩拍', () => {
        const b = (id: string) => ({ speakerId: id, intent: '' });
        expect(enforceBeatRules([b('a'), b('a'), b('b'), b('a'), b('b'), b('a')], 10).map(x => x.speakerId)).toEqual(['a', 'b', 'a', 'b']);
    });
});

describe('退回的出場表', () => {
    it('每人一拍、順序打亂、不超過拍數', () => {
        const plan = fallbackBeatPlan(members, 7, () => 0);
        expect(plan.map(b => b.speakerId).sort()).toEqual(['c1', 'c2', 'n1']);
        expect(plan.every(b => b.intent === '')).toBe(true);
        expect(fallbackBeatPlan(members, 2)).toHaveLength(2);
    });
});

describe('排班提示詞', () => {
    it('列出成員與配角、拍數、只要 JSON', () => {
        const p = buildBeatPlanPrompt({ members, historyText: 'U: 誰會修電腦', maxBeats: 5 });
        expect(p).toContain('- 小夏：話多的學妹');
        expect(p).toContain('- 房東（配角）');
        expect(p).toContain('排 2～5 拍');
        expect(p).toContain('U: 誰會修電腦');
        expect(p).toContain('[{"speaker":"成員名字","intent":"這一拍做什麼"}]');
    });

    it('旁觀時別排人對著用戶說；劇情方向帶進去', () => {
        const p = buildBeatPlanPrompt({ members, historyText: '', maxBeats: 3, userLurking: true, plotDirection: '有人要搬家' });
        expect(p).toContain('別排人對著用戶說話');
        expect(p).toContain('有人要搬家');
    });

    it('人設摘要：簡短說明優先，沒有就截人設', () => {
        expect(memberBrief({ description: '學妹', systemPrompt: '很長的人設' })).toBe('學妹');
        expect(memberBrief({ systemPrompt: 'x'.repeat(100) })).toBe(`${'x'.repeat(80)}…`);
    });
});

describe('排班用的 API', () => {
    const apiConfig = { baseUrl: 'https://main', apiKey: 'k', model: 'big' } as any;
    it('副 API 有設就用，不然全域，都沒有回 null', () => {
        expect(resolveBeatPlanApi(apiConfig, { baseUrl: 'https://light', apiKey: 'l', model: 'small' })).toMatchObject({ baseUrl: 'https://light', model: 'small' });
        expect(resolveBeatPlanApi(apiConfig, { baseUrl: '', model: '' })).toBe(apiConfig);
        expect(resolveBeatPlanApi({ baseUrl: '', model: '' } as any)).toBeNull();
    });
});

describe('各自發言：這一拍只說一下', () => {
    const history = { text: '小夏: 今天好冷', attachedImages: [], attachedImagesNote: '' };
    it('有安排就帶上，規則是 1～2 個氣泡、看得到前面的話', () => {
        const p = buildRoundRobinInstruction('阿方', history, '無', { beatIntent: '吐槽小夏' });
        expect(p).toContain('這一拍的安排（幕後，不要照抄');
        expect(p).toContain('吐槽小夏');
        expect(p).toContain('1～2 個氣泡');
        expect(p).not.toContain('同時在打字');
    });
    it('沒安排（退回的出場表）就不寫那行', () => {
        expect(buildRoundRobinInstruction('阿方', history, '無')).not.toContain('這一拍的安排');
    });
});
