import { describe, expect, it } from 'vitest';
import {
    appendStoryAffinityInputs, buildStoryAffinityAwarenessReminder, buildStoryMultiAffinityGuide, reconcileStoryAffinityScores,
    type StoryAffinityUser,
} from './storyTheater';

// 好感度：每個角色對每個在場的你各一格（plans/story-multi-persona.md 第 4 批）

const actors = [{ id: 'c1', name: '阿澈' }, { id: 'c2', name: '小雨' }];
const sis: StoryAffinityUser = { key: 'persona:sis', name: '妹妹' };
const elder: StoryAffinityUser = { key: 'persona:elder', name: '姊姊' };
const person = (charId: string, name: string, fields: Record<string, string | number>, user?: StoryAffinityUser) => [
    '<affinity_person>',
    `<character_id>${charId}</character_id>`,
    `<character_name>${name}</character_name>`,
    ...(user ? [`<user_id>${user.key}</user_id>`, `<user_name>${user.name}</user_name>`] : []),
    ...Object.entries(fields).map(([tag, value]) => `<${tag}>${value}</${tag}>`),
    '</affinity_person>',
].join('\n');
const panel = (...people: string[]) => `<affinity_panel>\n${people.join('\n')}\n</affinity_panel>`;
const scores = (content: string) => [...content.matchAll(/<affinity_person>([\s\S]*?)<\/affinity_person>/g)].map(match => {
    const tag = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(match[1])?.[1];
    return [tag('character_id'), tag('user_id'), Number(tag('c_to_u_score')), Number(tag('u_to_c_score'))];
});

describe('你對角色的變化：帶上是哪一個你', () => {
    it('只有一位時跟以前一樣不帶；好幾位時每條多兩行說是誰', () => {
        const single = appendStoryAffinityInputs('正文', [{ characterId: 'c1', characterName: '阿澈', delta: 3, reason: '開心' }]);
        expect(single).toBe('正文\n\n<u_affinity_updates>\n<u_affinity>\n<character_id>c1</character_id>\n<character_name>阿澈</character_name>\n<delta>+3</delta>\n<reason>開心</reason>\n<awareness>unnoticed</awareness>\n</u_affinity>\n</u_affinity_updates>');
        const multi = appendStoryAffinityInputs('正文', [{ characterId: 'c1', characterName: '阿澈', delta: -2, reason: '吃醋', userKey: elder.key, userName: elder.name }]);
        expect(multi).toContain('<character_name>阿澈</character_name>\n<user_id>persona:elder</user_id>\n<user_name>姊姊</user_name>\n<delta>-2</delta>');
    });
    it('察覺提醒：好幾位時說清楚是哪一位的變化', () => {
        expect(buildStoryAffinityAwarenessReminder({ delta: 2, reason: 'x', awareness: 'noticed' }, '阿澈')).toContain('阿澈明確知道用戶→自己的關係溫度');
        expect(buildStoryAffinityAwarenessReminder({ delta: 2, reason: 'x', awareness: 'noticed', userName: '姊姊' }, '阿澈')).toContain('阿澈明確知道用戶側的「姊姊」→自己的關係溫度');
        expect(buildStoryAffinityAwarenessReminder({ delta: 2, reason: 'x', userName: '姊姊' }, '阿澈')).toContain('不能讀取用戶側的「姊姊」→自己的這條');
    });
});

describe('給模型的說明', () => {
    it('只有一位時跟不給名單一模一樣，沒有任何對象欄位', () => {
        expect(buildStoryMultiAffinityGuide(actors, [sis])).toBe(buildStoryMultiAffinityGuide(actors));
        expect(buildStoryMultiAffinityGuide(actors)).not.toContain('user_id');
    });
    it('好幾位：列出每一位、每段標對象、段數是角色數乘在場人數', () => {
        const guide = buildStoryMultiAffinityGuide(actors, [sis, elder]);
        expect(guide).toContain('用戶側在場的身份共 2 位，每一位都是獨立的 U：\n- persona:sis：妹妹\n- persona:elder：姊姊');
        expect(guide).toContain('<character_name>角色名</character_name>\n<user_id>用戶側身份 ID</user_id>\n<user_name>用戶側身份名字</user_name>\n<c_to_u_score>50</c_to_u_score>');
        expect(guide).toContain('這一輪共 4 段');
        expect(guide).toContain('沒帶就是名單裡的第一位');
    });
});

describe('分數由前端復算', () => {
    it('好幾個你同場：每一格各算各的，你的更新只動指到的那一格', () => {
        const previous = panel(
            person('c1', '阿澈', { c_to_u_score: 60, u_to_c_score: 70 }, sis),
            person('c1', '阿澈', { c_to_u_score: 40, u_to_c_score: 45 }, elder),
        );
        const generated = panel(
            person('c1', '阿澈', { c_to_u_score: 0, c_to_u_delta: '+2', u_to_c_score: 0 }, sis),
            person('c1', '阿澈', { c_to_u_score: 0, c_to_u_delta: '-1', u_to_c_score: 0 }, elder),
        );
        const out = reconcileStoryAffinityScores(generated, previous, [{ characterId: 'c1', delta: 5, reason: '', userKey: elder.key, userName: elder.name }], actors, [sis, elder]);
        expect(scores(out)).toEqual([['c1', 'persona:sis', 62, 70], ['c1', 'persona:elder', 39, 50]]);
    });
    it('模型漏寫對象的那段算第一位，並補上；沒寫是哪一位的更新也算第一位', () => {
        const generated = panel(person('c1', '阿澈', { c_to_u_delta: '+1' }), person('c1', '阿澈', { c_to_u_delta: '+0' }, elder));
        const out = reconcileStoryAffinityScores(generated, '', [{ characterId: 'c1', delta: 4, reason: '' }], actors, [sis, elder]);
        expect(scores(out)).toEqual([['c1', 'persona:sis', 51, 54], ['c1', 'persona:elder', 50, 50]]);
    });
    it('以前只有一個你時留下的面板：算第一位的，新來的那位從 50 開始', () => {
        const previous = panel(person('c1', '阿澈', { c_to_u_score: 80, u_to_c_score: 75 }));
        const generated = panel(person('c1', '阿澈', { c_to_u_delta: '+0' }, sis), person('c1', '阿澈', { c_to_u_delta: '+3' }, elder));
        expect(scores(reconcileStoryAffinityScores(generated, previous, [], actors, [sis, elder]))).toEqual([['c1', 'persona:sis', 80, 75], ['c1', 'persona:elder', 53, 50]]);
    });
    it('姊姊先回家，只剩妹妹：接妹妹那一格，不會拿到姊姊的分數', () => {
        const previous = panel(
            person('c1', '阿澈', { c_to_u_score: 60, u_to_c_score: 70 }, sis),
            person('c1', '阿澈', { c_to_u_score: 20, u_to_c_score: 25 }, elder),
        );
        const generated = panel(person('c1', '阿澈', { c_to_u_delta: '+1' }));
        const out = reconcileStoryAffinityScores(generated, previous, [], actors, [sis]);
        expect(scores(out)).toEqual([['c1', undefined, 61, 70]]);
    });
    it('姊姊離開幾輪又回來：往回找到她上次的分數，不會掉回 50', () => {
        const older = panel(
            person('c1', '阿澈', { c_to_u_score: 60, u_to_c_score: 70 }, sis),
            person('c1', '阿澈', { c_to_u_score: 20, u_to_c_score: 25 }, elder),
        );
        const latest = panel(person('c1', '阿澈', { c_to_u_score: 64, u_to_c_score: 71 }));
        const generated = panel(person('c1', '阿澈', { c_to_u_delta: '+0' }, sis), person('c1', '阿澈', { c_to_u_delta: '+2' }, elder));
        const out = reconcileStoryAffinityScores(generated, [latest, '這一輪沒有面板', older], [], actors, [sis, elder]);
        expect(scores(out)).toEqual([['c1', 'persona:sis', 64, 71], ['c1', 'persona:elder', 22, 25]]);
    });
    it('只有一個你：跟以前一樣；上一輪漏了面板時往回找', () => {
        const previous = panel(person('c1', '阿澈', { c_to_u_score: 60, u_to_c_score: 70 }), person('c2', '小雨', { c_to_u_score: 30, u_to_c_score: 35 }));
        const generated = panel(person('c1', '阿澈', { c_to_u_delta: '+2' }), person('c2', '小雨', { c_to_u_delta: '-3' }));
        const inputs = [{ characterId: 'c2', delta: 1, reason: '' }];
        const expected = [['c1', undefined, 62, 70], ['c2', undefined, 27, 36]];
        expect(scores(reconcileStoryAffinityScores(generated, previous, inputs, actors))).toEqual(expected);
        expect(scores(reconcileStoryAffinityScores(generated, previous, inputs, actors, [sis]))).toEqual(expected);
        expect(scores(reconcileStoryAffinityScores(generated, ['沒有面板', previous], inputs, actors, [sis]))).toEqual(expected);
        expect(reconcileStoryAffinityScores(generated, previous, inputs, actors)).not.toContain('user_id');
    });
});
