import { describe, expect, it } from 'vitest';
import type { APIConfig, CharacterProfile, Message } from '../types';
import { buildReplyDraftPrompt, draftHistoryLines, parseReplyDrafts, resolveReplyDraftApi } from './replyDrafts';

const char = {
    id: 'c1', name: '周以衡', description: '', systemPrompt: '性格高冷，話很少。喜歡看電影。',
    briefPersona: '', chatNickname: '周大少爺', userNickname: '', userViewRelationship: '青梅竹馬', charViewRelationship: '',
} as unknown as CharacterProfile;
const user = { name: '小星', bio: '愛吃甜食的大學生', customSetting: '' };

const msg = (id: number, role: Message['role'], content: string, metadata?: any): Message =>
    ({ id, charId: 'c1', role, type: 'text', content, timestamp: id, metadata } as Message);

describe('回覆草稿 · 提示詞', () => {
    it('站在用戶這邊寫，帶關係、人設、最近對話', () => {
        const prompt = buildReplyDraftPrompt({ char, user, history: ['周以衡: 週末要不要看電影'], withActions: false });
        expect(prompt).toContain('你寫的是 小星 要傳出去的話');
        expect(prompt).toContain('不要替 周以衡 說話');
        expect(prompt).toContain('青梅竹馬');
        expect(prompt).toContain('小星 叫 TA「周大少爺」');
        expect(prompt).toContain('愛吃甜食的大學生');
        expect(prompt).toContain('性格高冷');
        expect(prompt).toContain('週末要不要看電影');
        expect(prompt).toContain('只寫說出口的話');
        expect(prompt).not.toContain('已經打了一半');
    });

    it('有精簡人設就用它', () => {
        const prompt = buildReplyDraftPrompt({ char: { ...char, briefPersona: '冷面毒舌的影評人。' }, user, history: [], withActions: false });
        expect(prompt).toContain('冷面毒舌的影評人');
        expect(prompt).not.toContain('喜歡看電影');
        expect(prompt).toContain('還沒聊過');
    });

    it('打了一半：三個草稿都圍著它寫', () => {
        const prompt = buildReplyDraftPrompt({ char, user, history: [], partial: '  不去  ', withActions: false });
        expect(prompt).toContain('「不去」');
        expect(prompt).toContain('不要改掉原意');
    });

    it('動作旁白：句首同一行、全形括號', () => {
        const prompt = buildReplyDraftPrompt({ char, user, history: [], withActions: true });
        expect(prompt).toContain('句首用全形括號');
        expect(prompt).toContain('跟台詞寫在同一行');
        expect(prompt).not.toContain('只寫說出口的話');
    });
});

describe('回覆草稿 · 對話整理', () => {
    it('去掉隱藏的、只留最近的，標出誰說的', () => {
        const lines = draftHistoryLines([
            msg(1, 'user', '在嗎'),
            msg(2, 'assistant', '嗯', { hidden: true }),
            msg(3, 'assistant', '週末\n要不要看電影'),
        ], '周以衡', '小星');
        expect(lines).toEqual(['小星: 在嗎', '周以衡: 週末 要不要看電影']);
    });
});

describe('回覆草稿 · 解析', () => {
    it('JSON：最多三個、去重', () => {
        const raw = '{"drafts":["不去","不去","除非你求我","哦？","再加一個"]}';
        expect(parseReplyDrafts(raw, false)).toEqual(['不去', '除非你求我', '哦？']);
    });

    it('剝思考外洩和程式碼框', () => {
        const raw = '<thinking>她應該會嘴硬</thinking>\n```json\n{"drafts":["（咬了口糖葫蘆）不去……除非你求我"]}\n```';
        expect(parseReplyDrafts(raw, true)).toEqual(['（咬了口糖葫蘆）不去……除非你求我']);
    });

    it('旁白關掉：句首括號剝掉', () => {
        expect(parseReplyDrafts('{"drafts":["（咬了口糖葫蘆）不去"]}', false)).toEqual(['不去']);
    });

    it('不是 JSON：按行拆、剝編號和引號', () => {
        const raw = '1. 「哦？周大少爺願意陪我看電影了？」\n2. 看電影啊……和你？\n- "不去"';
        expect(parseReplyDrafts(raw, false)).toEqual(['哦？周大少爺願意陪我看電影了？', '看電影啊……和你？', '不去']);
    });

    it('JSON 被截斷：剩下的行也撈得回來', () => {
        const raw = '{"drafts": [\n  "看電影啊……和你？",\n  "不去';
        expect(parseReplyDrafts(raw, false)[0]).toBe('看電影啊……和你？');
    });
});

describe('回覆草稿 · API', () => {
    const apiConfig = { baseUrl: 'https://main', apiKey: 'k', model: 'main-model' } as APIConfig;
    it('副 API 有設就用它', () => {
        expect(resolveReplyDraftApi({ baseUrl: 'https://light', apiKey: '', model: 'light' }, char, apiConfig).model).toBe('light');
    });
    it('沒設副 API：用角色聊天那組', () => {
        expect(resolveReplyDraftApi({ baseUrl: '', apiKey: '', model: '' }, char, apiConfig).model).toBe('main-model');
        expect(resolveReplyDraftApi(undefined, { ...char, chatApi: { baseUrl: 'https://own', apiKey: 'x', model: 'own' } }, apiConfig).model).toBe('own');
    });
});
