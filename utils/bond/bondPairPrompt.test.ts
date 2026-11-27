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

describe('角色之間：私下聊天的關係段', async () => {
    const { bondPromptBlock } = await import('./prompt');
    const { newStoryEntry } = await import('./story');
    const { newPairDiary } = await import('./storyExtract');
    const { newGift } = await import('./gift');
    const base = (over: object) => ({ id: Math.random().toString(36), bondId: 'pair~a~b', author: 'a', text: '', eventDate: { precision: 'unknown' }, writtenAt: 1, sources: [], links: [], status: 'published', createdBy: 'ai', updatedAt: 1, ...over }) as any;
    it('沒有卡時跟以前一樣；有故事、日記、問答、禮物時照 A／B 分邊', () => {
        const input = { bond: undefined, selfName: 'Mio', otherName: 'Sully', selfIsCharId: false, entries: [], selfId: 'b', includeUserNotes: false };
        expect(bondPromptBlock({ ...input, pair: { selfId: 'b', otherId: 'a', isA: false } })).toBe(bondPromptBlock(input));
        let q = newQuestion({ bondId: 'pair~a~b', openedBy: 'user', prompt: '海還是山', origin: 'user' });
        q = answerQuestion(q, pairSlot('a'), { text: '海', state: 'sealed' });
        q = answerQuestion(q, pairSlot('b'), { text: '山', state: 'sealed' });
        const entries = [
            newStoryEntry({ bondId: 'pair~a~b', chapter: 1, title: '雨', text: 'x', summary: '共撐一把傘', pov: 'narrator' }),
            newPairDiary({ bondId: 'pair~a~b', author: 'b', text: 'Mio 的心事', date: '2026-11-27' }),
            newPairDiary({ bondId: 'pair~a~b', author: 'a', text: 'Sully 的心事', date: '2026-11-27' }),
            q,
            newGift({ bondId: 'pair~a~b', dir: 'in', state: 'given', title: '圍巾', text: '圍巾' }),
            base({ kind: 'wish', author: 'b', text: '看海', wish: { owner: 'b', state: 'want' } }),
        ];
        const out = bondPromptBlock({ ...input, entries, pair: { selfId: 'b', otherId: 'a', isA: false } });
        expect(out).toContain('第 1 章〈雨〉');
        expect(out).toContain('共撐一把傘');
        expect(out).toContain('Mio 的心事');
        expect(out).not.toContain('Sully 的心事');
        expect(out).toContain('「海還是山」你答：山；Sully答：海');
        expect(out).toContain('你送Sully：圍巾');
        expect(out).toContain('願望（你想）：看海');
    });
});
