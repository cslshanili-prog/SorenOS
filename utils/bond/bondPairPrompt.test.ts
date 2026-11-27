import { describe, expect, it } from 'vitest';
import {
    buildPairAnswerPrompt, buildPairDiaryPrompt, buildPairLetterPrompt, buildPairQuestionSuggestPrompt, buildPairWishPrompt,
    cleanLong, cleanOneLine, pairAnswerOf, pairSlot,
} from './pairPrompt';
import { answerQuestion, newQuestion } from './question';

const recent = { chapter: { title: '在雨裡', summary: '共撐一把傘' }, moments: ['給了傘'], topics: ['我記得那天'], chat: ['Mio：明天見'] };

describe('角色之間的小按鈕：提示詞', () => {
    it('日記：只寫最近發生的、第一人稱、用戶不在場；沒新東西照實寫平淡', () => {
        const p = buildPairDiaryPrompt({ selfName: 'Sully', otherName: 'Mio', date: '2026-11-27', recent, lastDiary: '上一篇' });
        expect(p).toContain('〈在雨裡〉共撐一把傘');
        expect(p).toContain('- 給了傘');
        expect(p).toContain('Mio：明天見');
        expect(p).toContain('【你上一篇日記】\n上一篇');
        expect(p).toContain('用戶（手機的主人）不在場');
        expect(buildPairDiaryPrompt({ selfName: 'A', otherName: 'B', date: 'd', recent: {} })).toContain('最近沒什麼新鮮事');
    });

    it('問答：推薦題目避開問過的；作答看不到對方', () => {
        const s = buildPairQuestionSuggestPrompt({ aName: 'A', bName: 'B', relationLine: '友情線・朋友', recent: {}, asked: ['最喜歡的顏色'] });
        expect(s).toContain('- 最喜歡的顏色');
        expect(s).toContain('友情線・朋友');
        expect(buildPairAnswerPrompt({ selfName: 'A', otherName: 'B', question: '誰先道歉', recent: {} })).toContain('你看不到對方寫什麼');
    });

    it('願望、信：不重複、回信帶來信', () => {
        expect(buildPairWishPrompt({ selfName: 'A', otherName: 'B', recent: {}, existing: ['看海'] })).toContain('- 看海');
        const l = buildPairLetterPrompt({ fromName: 'B', toName: 'A', recent: {}, replyTo: '謝謝你', direction: '道歉' });
        expect(l).toContain('請寫一封回信');
        expect(l).toContain('【A 的來信】\n謝謝你');
        expect(l).toContain('想寫的方向：道歉');
    });

    it('問答的兩欄：A 放 user、B 放 char；兩邊交出就揭曉', () => {
        expect(pairSlot('a')).toBe('user');
        let q = newQuestion({ bondId: 'pair~a~b', openedBy: 'user', prompt: '題', origin: 'user' });
        q = answerQuestion(q, pairSlot('a'), { text: 'A 答', state: 'sealed' });
        q = answerQuestion(q, pairSlot('b'), { text: 'B 答', state: 'sealed' });
        const r = q.question!.rounds[0];
        expect(r.revealedAt).toBeTruthy();
        expect(pairAnswerOf(r, 'a')?.text).toBe('A 答');
        expect(pairAnswerOf(r, 'b')?.text).toBe('B 答');
        expect(q.status).toBe('published');
    });

    it('清理輸出', () => {
        expect(cleanOneLine('「想一起去看海」\n第二行')).toBe('想一起去看海');
        expect(cleanOneLine('- 1. 去爬山')).toBe('去爬山');
        expect(cleanLong('```\n信\n```')).toBe('信');
    });
});
