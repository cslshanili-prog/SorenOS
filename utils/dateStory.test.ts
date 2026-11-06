import { describe, expect, it } from 'vitest';
import { buildNewDateStory, dateStoryLabel, legacyStoryMembers, legacyStoryStart, messageBelongsToStory, storyTag, withStoryScenario } from './dateStory';
import { buildDateHistoryGroups, formatDateHistoryExport } from './dateHistory';
import type { CharacterProfile, DateStory, Message } from '../types';

const msg = (id: number, metadata: Record<string, unknown> = { source: 'date' }, role: 'user' | 'assistant' = 'assistant'): Message =>
    ({ id, charId: 'c1', role, type: 'text', content: `m${id}`, timestamp: id * 1000, metadata } as Message);
const story = (over: Partial<DateStory>): DateStory => ({ id: 's1', charId: 'c1', status: 'ongoing', createdAt: 1, updatedAt: 1, ...over });

describe('線下故事', () => {
    it('只看訊息上的故事標記，不收別場的、不收聊天', () => {
        const s1 = story({});
        expect(messageBelongsToStory(msg(3, { source: 'date', dateStoryId: 's1' }), s1)).toBe(true);
        expect(messageBelongsToStory(msg(3, { source: 'date', dateStoryId: 's2' }), s1)).toBe(false);
        expect(messageBelongsToStory(msg(3, { source: 'date' }), s1)).toBe(false);
        expect(messageBelongsToStory(msg(3, { source: 'chat', dateStoryId: 's1' }), s1)).toBe(false);
    });

    it('轉舊存檔時補標的是開場起、沒標過的見面訊息', () => {
        const list = [msg(1, { source: 'date', isOpening: true }), msg(5, { source: 'date', isOpening: true }), msg(6), msg(7, { source: 'date', dateStoryId: 'x' }), msg(8, { source: 'date', valentineEvent: true }), msg(9, { source: 'chat' })];
        expect(legacyStoryMembers(list, 5).map(m => m.id)).toEqual([5, 6]);
    });

    it('新故事帶走「下一場的大綱」；提示詞讀這場的', () => {
        const char = { id: 'c1', name: '凱恩', dateScenario: ' 雨夜 ' } as CharacterProfile;
        const s = buildNewDateStory(char, 5);
        expect(s).toMatchObject({ charId: 'c1', status: 'ongoing', scenario: '雨夜', createdAt: 5 });
        expect(withStoryScenario(char, { ...s, scenario: '書店' }).dateScenario).toBe('書店');
        expect(withStoryScenario(char, { ...s, scenario: undefined }).dateScenario).toBeUndefined();
        expect(withStoryScenario(char, null).dateScenario).toBe(' 雨夜 ');
        expect(storyTag(s)).toEqual({ dateStoryId: s.id });
        expect(storyTag(null)).toEqual({});
    });

    it('舊存檔從最後一次開場起算，情人節活動那種不算', () => {
        expect(legacyStoryStart([msg(1, { source: 'date', isOpening: true }), msg(2), msg(5, { source: 'date', isOpening: true }), msg(6)])).toBe(5);
        expect(legacyStoryStart([msg(1, { source: 'date', isOpening: true }), msg(4, { source: 'date', isOpening: true, valentineEvent: true })])).toBe(1);
        expect(legacyStoryStart([msg(2)])).toBeUndefined();
    });

    it('名字：取了就用，沒取用開始日期', () => {
        expect(dateStoryLabel(story({ title: ' 雨夜書店 ' }))).toBe('雨夜書店');
        expect(dateStoryLabel(story({ createdAt: new Date(2026, 8, 3).getTime() }))).toBe('9月3日開始的故事');
    });
});

describe('見面記錄 · 按故事', () => {
    const a = story({ id: 'a', status: 'completed', title: '第一場' });
    const b = story({ id: 'b', title: '第二場' });
    const messages = [
        msg(1, { source: 'date', isOpening: true }), msg(2),
        msg(3, { source: 'date', isOpening: true, dateStoryId: 'a' }), msg(4, { source: 'date', dateStoryId: 'a' }, 'user'),
        msg(7, { source: 'date', isOpening: true, dateStoryId: 'b' }), msg(8, { source: 'date', dateStoryId: 'b' }),
    ];

    it('各歸各場，故事之前的舊見面照按次切', () => {
        const groups = buildDateHistoryGroups(messages, 'story', 'oldest', [b, a]);
        expect(groups.map(g => [g.story?.id ?? null, g.messages.map(m => m.id)])).toEqual([
            [null, [1, 2]],
            ['a', [3, 4]],
            ['b', [7, 8]],
        ]);
        expect(buildDateHistoryGroups(messages, 'story', 'newest', [b, a])[0].story?.id).toBe('b');
    });

    it('導出寫上故事名字和狀態', () => {
        const text = formatDateHistoryExport('凱恩', buildDateHistoryGroups(messages, 'story', 'oldest', [a, b]), 'story');
        expect(text).toContain('整理方式：按故事');
        expect(text).toContain('第一場（已完結）');
        expect(text).toContain('第二場（進行中）');
    });
});
