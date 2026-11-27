import { describe, expect, it } from 'vitest';
import {
    buildOverviewPrompt, buildStoryPrompt, chapterLabel, chapterNeighbors, cleanStorySummary, newStoryEntry, nextChapterNo,
    normalizeWords, overviewStale, parseStory, storyChapters, storyRouteLock, storyTail,
} from './story';

const ch = (n: number, id = `s${n}`) => newStoryEntry({ bondId: 'pair~a~b', chapter: n, title: `章${n}`, text: `正文${n}`, summary: `摘要${n}`, pov: 'narrator', now: n });

describe('他們的故事：章節', () => {
    it('照章號排、下一章號、前後章', () => {
        const list = [ch(2), ch(1), ch(3), { ...ch(9), kind: 'moment' as const, story: undefined }];
        expect(storyChapters(list).map(e => e.story!.chapter)).toEqual([1, 2, 3]);
        expect(nextChapterNo(list)).toBe(4);
        expect(nextChapterNo([])).toBe(1);
        const [one, two, three] = storyChapters(list);
        expect(chapterNeighbors(list, two.id)).toEqual({ prev: one, next: three });
        expect(chapterNeighbors(list, 'nope')).toEqual({});
    });

    it('章名：有自己的名字就接在章號後面', () => {
        expect(chapterLabel({ title: '在雨裡', story: { chapter: 3, pov: 'narrator', summary: '' } })).toBe('第 3 章・在雨裡');
        expect(chapterLabel({ title: '第 3 章', story: { chapter: 3, pov: 'narrator', summary: '' } })).toBe('第 3 章');
        expect(newStoryEntry({ bondId: 'p', chapter: 2, title: ' ', text: 'x', summary: 'y', pov: 'narrator', dateKey: '2026-11-27' }))
            .toMatchObject({ kind: 'story', title: '第 2 章', eventDate: { precision: 'day', date: '2026-11-27' }, status: 'published' });
    });

    it('字數要兩格都填、小的在前；沒填不給預設', () => {
        expect(normalizeWords('1200', 800)).toEqual([800, 1200]);
        expect(normalizeWords('', 800)).toBeUndefined();
        expect(normalizeWords(0, 800)).toBeUndefined();
    });

    it('長文只帶尾段', () => {
        const long = `${'甲'.repeat(3000)}\n最後一段`;
        const tail = storyTail(long, 100);
        expect(tail.startsWith('……')).toBe(true);
        expect(tail.endsWith('最後一段')).toBe(true);
        expect(storyTail('短的')).toBe('短的');
    });

    it('概覽落後：有比概覽更新的章節才算', () => {
        expect(overviewStale(undefined, [])).toBe(false);
        expect(overviewStale(undefined, [ch(1)])).toBe(true);
        expect(overviewStale({ chapter: 1 }, [ch(1)])).toBe(false);
        expect(overviewStale({ chapter: 1 }, [ch(1), ch(2)])).toBe(true);
    });
});

describe('他們的故事：提示詞與解析', () => {
    const base = { aName: 'Sully', bName: 'Mio', words: [1200, 2000] as [number, number], chapter: 3 };

    it('帶前情、上一章結尾、時間線；用戶不在場；只要章名＋正文', () => {
        const p = buildStoryPrompt({
            ...base, relationLine: '戀愛線・曖昧', prev: [{ chapter: 1, title: '初見', summary: '在書店遇見' }],
            lastTail: '……她把傘遞過去。', timeline: ['第一次約會'], recentChat: ['Sully：明天見'], scene: '日常', direction: '一起做飯',
        });
        expect(p).toContain('第 3 章');
        expect(p).toContain('第 1 章〈初見〉：在書店遇見');
        expect(p).toContain('她把傘遞過去');
        expect(p).toContain('- 第一次約會');
        expect(p).toContain('場景：日常；方向：一起做飯');
        expect(p).toContain('用戶（手機的主人）不在場');
        expect(p).toContain('大約 1200～2000 字');
        expect(p).toContain('第三人稱旁白');
    });

    it('獨立一篇不帶前情；角色視角寫第一人稱', () => {
        const p = buildStoryPrompt({ ...base, standalone: true, povName: 'Mio', prev: [{ chapter: 1, title: 'x', summary: 'y' }], lastTail: '尾' });
        expect(p).not.toContain('【前情】');
        expect(p).not.toContain('【上一章的結尾】');
        expect(p).toContain('從 Mio 的眼睛看');
        expect(p).toContain('獨立成篇');
    });

    it('友情、親情線的鎖；未指定、戀愛沒有', () => {
        expect(storyRouteLock('friendship', 'A', 'B')).toContain('A和B是友情');
        expect(storyRouteLock('family', 'A', 'B')).toContain('血緣親屬');
        expect(storyRouteLock(undefined, 'A', 'B')).toBe('');
        expect(storyRouteLock('romance', 'A', 'B')).toBe('');
    });

    it('解析：章名去裝飾、正文留下；第一行太長當正文；空的回 null', () => {
        expect(parseStory('```\n# 《在雨裡》\n\n雨下得很大。\n\n\n\n她撐開傘。\n```')).toEqual({ title: '在雨裡', text: '雨下得很大。\n\n她撐開傘。' });
        expect(parseStory('第 3 章：重逢\n他們又見面了。')).toEqual({ title: '重逢', text: '他們又見面了。' });
        const long = '雨'.repeat(40);
        expect(parseStory(`${long}\n第二段`)).toEqual({ title: '', text: `${long}\n第二段` });
        expect(parseStory('只有章名')).toBeNull();
        expect(parseStory('')).toBeNull();
        expect(cleanStorySummary('摘要：「他們和好了」')).toBe('他們和好了');
    });

    it('概覽：章節與時間線', () => {
        const p = buildOverviewPrompt({ aName: 'A', bName: 'B', relationLine: '友情線・朋友', chapters: [{ chapter: 1, title: 't', summary: 's' }], timeline: ['x'] });
        expect(p).toContain('第 1 章〈t〉：s');
        expect(p).toContain('- x');
        expect(p).toContain('友情線・朋友');
        expect(buildOverviewPrompt({ aName: 'A', bName: 'B', chapters: [] })).toContain('（還沒有章節）');
    });
});
