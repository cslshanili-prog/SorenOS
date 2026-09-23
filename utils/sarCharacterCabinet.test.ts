import { describe, expect, it } from 'vitest';
import {
    buildSARCharacterCabinetTurn,
    createSARCharacterCabinetNote,
    parseSARCharacterCabinetOutput,
    rollSARCharacterCabinetScenario,
} from './vrWorld/sarCharacterCabinet';

describe('SAR 角色櫃子自由活動', () => {
    const actor = { id: 'actor', name: '凱恩', vrState: { enabled: true } } as any;
    const other = { id: 'other', name: '艾文', vrState: { enabled: true } } as any;
    const offline = { id: 'offline', name: '未接入者', vrState: { enabled: false } } as any;
    const user = { name: 'User' } as any;

    it('隨機對象包含 User 與已接入角色，但排除自己和未接入角色', () => {
        const rolls = [0.99, 0, 0];
        const scenario = rollSARCharacterCabinetScenario(actor, [actor, other, offline], user, () => rolls.shift() ?? 0);
        expect(scenario.target).toMatchObject({ id: 'other', name: '艾文', kind: 'character' });
        expect(scenario.variant.pool).toBe('variant');
        expect(scenario.story.pool).toBe('story');

        const userScenario = rollSARCharacterCabinetScenario(actor, [actor, other], user, () => 0);
        expect(userScenario.target).toMatchObject({ id: 'user', name: 'User', kind: 'user' });
    });

    it('提示詞鎖定對象和兩枚芯片，並要求完整劇情與私人隨筆', () => {
        const scenario = rollSARCharacterCabinetScenario(actor, [actor, other], user, () => 0.99);
        const prompt = buildSARCharacterCabinetTurn(actor.name, scenario);
        expect(prompt).toContain(`已經把它們同時用在 ${scenario.target.name} 身上`);
        expect(prompt).toContain(`異界異格芯片「${scenario.variant.title}」`);
        expect(prompt).toContain(`異界座標芯片「${scenario.story.title}」`);
        expect(prompt).toContain('完整的小劇情');
        expect(prompt).toContain('第一人稱隨筆和吐槽');
        expect(prompt).toContain('不是 User 的五十輪正式推演');
    });

    it('解析結構化隨筆並生成可寫入私信卡的櫃中記錄', () => {
        const parsed = parseSARCharacterCabinetOutput('```json\n{"title":"黃瓜警報","activity":"給艾文裝了兩枚芯片，結果追著貓跑了三條街。","story":"艾文先變成了一隻貓。","notes":"我發誓我只拿出了一根黃瓜。","highlight":"他看到黃瓜以後跳上了吊燈。"}\n```');
        expect(parsed).toEqual({
            title: '黃瓜警報',
            activity: '給艾文裝了兩枚芯片，結果追著貓跑了三條街。',
            story: '艾文先變成了一隻貓。',
            notes: '我發誓我只拿出了一根黃瓜。',
            highlight: '他看到黃瓜以後跳上了吊燈。',
        });
        const scenario = rollSARCharacterCabinetScenario(actor, [actor, other], user, () => 0.99);
        const note = createSARCharacterCabinetNote(actor, scenario, parsed!, 12345);
        expect(note.actorName).toBe('凱恩');
        expect(note.targetName).toBe('艾文');
        expect(note.variantTitle).toBe(scenario.variant.title);
        expect(note.storyTitle).toBe(scenario.story.title);
        expect(note.createdAt).toBe(12345);
    });

    it('模型漏掉 JSON 時仍保住整篇隨筆', () => {
        const parsed = parseSARCharacterCabinetOutput('他變成貓以後，真的被一根黃瓜嚇上了吊燈。');
        expect(parsed?.story).toContain('黃瓜');
        expect(parsed?.notes).toContain('黃瓜');
    });
});
