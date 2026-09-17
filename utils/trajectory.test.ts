import { describe, it, expect } from 'vitest';
import {
    buildTrajectoryProfilePrompt, parseTrajectoryProfile, toggleTrajectoryChecklistItem,
    createTrajectoryArchiveDoc, createTrajectoryObjective, createTrajectoryChecklistItem,
    buildTrajectoryOotdPrompt, parseTrajectoryOotdDraft, createTrajectoryOotdPost, groupTrajectoryOotdByDate,
    filterMomentsVisibleToChar,
} from './trajectory';
import type { SocialPost, PhoneContact } from '../types';

describe('buildTrajectoryProfilePrompt', () => {
    it('不带 existing 时不出现"已经有这些条目"提示', () => {
        const prompt = buildTrajectoryProfilePrompt('角色设定块');
        expect(prompt).not.toContain('已经有这些条目');
        expect(prompt).toContain('archives');
        expect(prompt).toContain('objectives');
        expect(prompt).toContain('checklist');
    });

    it('带 existing 时列出已有标题防重复', () => {
        const existing = {
            archives: [createTrajectoryArchiveDoc({ title: '产权证明书', category: 'PERSONAL DOCUMENT', content: 'x' })],
            objectives: [createTrajectoryObjective({ title: '完成协奏曲', progress: 60, detail: 'x' })],
            checklist: [createTrajectoryChecklistItem({ title: '买罐头', dueLabel: '明天' })],
            updatedAt: Date.now(),
        };
        const prompt = buildTrajectoryProfilePrompt('角色设定块', existing);
        expect(prompt).toContain('已经有这些条目了');
        expect(prompt).toContain('产权证明书');
        expect(prompt).toContain('完成协奏曲');
        expect(prompt).toContain('买罐头');
    });
});

describe('parseTrajectoryProfile', () => {
    it('解析完整合法 JSON', () => {
        const result = parseTrajectoryProfile({
            archives: [{ title: '老城区别墅产权证明书', category: 'PERSONAL DOCUMENT', content: '兹证明……' }],
            objectives: [{ title: '完成《流光》钢琴协奏曲', progress: 65, detail: '融入雨声采样' }],
            checklist: [{ title: '去老城旧物店拿磁带', dueLabel: '明天 15:00', done: false }],
        });
        expect(result.archives).toHaveLength(1);
        expect(result.archives[0]).toMatchObject({ title: '老城区别墅产权证明书', category: 'PERSONAL DOCUMENT' });
        expect(result.objectives[0]).toMatchObject({ title: '完成《流光》钢琴协奏曲', progress: 65 });
        expect(result.checklist[0]).toMatchObject({ title: '去老城旧物店拿磁带', dueLabel: '明天 15:00', done: false });
        expect(result.updatedAt).toBeGreaterThan(0);
    });

    it('progress 是字符串数字时能纠错成 number', () => {
        const result = parseTrajectoryProfile({ objectives: [{ title: 'x', progress: '80', detail: '' }] });
        expect(result.objectives[0].progress).toBe(80);
    });

    it('progress 超出 0-100 范围时夹在边界内', () => {
        const result = parseTrajectoryProfile({ objectives: [{ title: 'x', progress: 150, detail: '' }] });
        expect(result.objectives[0].progress).toBe(100);
        const result2 = parseTrajectoryProfile({ objectives: [{ title: 'y', progress: -10, detail: '' }] });
        expect(result2.objectives[0].progress).toBe(0);
    });

    it('缺 title 的条目被过滤掉', () => {
        const result = parseTrajectoryProfile({
            archives: [{ category: 'X', content: 'no title' }],
            objectives: [{ progress: 50 }],
            checklist: [{ dueLabel: '明天' }],
        });
        expect(result.archives).toHaveLength(0);
        expect(result.objectives).toHaveLength(0);
        expect(result.checklist).toHaveLength(0);
    });

    it('category/dueLabel 缺省时给合理兜底', () => {
        const result = parseTrajectoryProfile({
            archives: [{ title: '一份文件', content: 'x' }],
            checklist: [{ title: '一件事' }],
        });
        expect(result.archives[0].category).toBe('PERSONAL DOCUMENT');
        expect(result.checklist[0].dueLabel).toBe('待安排');
    });

    it('完全不是对象/是 null 时返回三个空数组，不抛错', () => {
        expect(parseTrajectoryProfile(null)).toEqual(expect.objectContaining({ archives: [], objectives: [], checklist: [] }));
        expect(parseTrajectoryProfile('garbage')).toEqual(expect.objectContaining({ archives: [], objectives: [], checklist: [] }));
        expect(parseTrajectoryProfile(undefined)).toEqual(expect.objectContaining({ archives: [], objectives: [], checklist: [] }));
    });

    it('archives/objectives/checklist 不是数组时当作空处理', () => {
        const result = parseTrajectoryProfile({ archives: 'not an array', objectives: null, checklist: 42 });
        expect(result).toEqual(expect.objectContaining({ archives: [], objectives: [], checklist: [] }));
    });
});

describe('toggleTrajectoryChecklistItem', () => {
    it('切换指定 id 的 done，其余条目不变', () => {
        const item1 = createTrajectoryChecklistItem({ title: 'A', dueLabel: '今天', done: false });
        const item2 = createTrajectoryChecklistItem({ title: 'B', dueLabel: '明天', done: true });
        const profile = { archives: [], objectives: [], checklist: [item1, item2], updatedAt: Date.now() };

        const toggled = toggleTrajectoryChecklistItem(profile, item1.id);
        expect(toggled.checklist.find(c => c.id === item1.id)?.done).toBe(true);
        expect(toggled.checklist.find(c => c.id === item2.id)?.done).toBe(true);

        const toggledBack = toggleTrajectoryChecklistItem(toggled, item2.id);
        expect(toggledBack.checklist.find(c => c.id === item2.id)?.done).toBe(false);
    });

    it('不存在的 id 不改变任何条目', () => {
        const item1 = createTrajectoryChecklistItem({ title: 'A', dueLabel: '今天' });
        const profile = { archives: [], objectives: [], checklist: [item1], updatedAt: Date.now() };
        const result = toggleTrajectoryChecklistItem(profile, 'not-exist');
        expect(result.checklist).toEqual(profile.checklist);
    });
});

describe('buildTrajectoryOotdPrompt', () => {
    it('不带 existing 时不出现"最近穿过"提示', () => {
        const prompt = buildTrajectoryOotdPrompt('角色设定块');
        expect(prompt).not.toContain('最近穿过');
        expect(prompt).toContain('imagePrompt');
    });

    it('带 existing 时列出最近的搭配防重复', () => {
        const existing = [createTrajectoryOotdPost({ style: '休闲', colors: [], tops: '白衬衫', bottoms: '牛仔裤', shoes: '', accessories: [], imagePrompt: 'x' }, 'img-token')];
        const prompt = buildTrajectoryOotdPrompt('角色设定块', existing);
        expect(prompt).toContain('最近穿过这些搭配了');
        expect(prompt).toContain('白衬衫+牛仔裤');
    });
});

describe('parseTrajectoryOotdDraft', () => {
    it('解析完整合法 JSON', () => {
        const draft = parseTrajectoryOotdDraft({
            style: '休闲', colors: ['米白色', '杏色'], tops: '杏色亚麻衬衫', bottoms: '米白亚麻裤',
            shoes: '小白鞋', accessories: ['帆布包'], imagePrompt: 'a young woman in linen shirt',
        });
        expect(draft).toMatchObject({ style: '休闲', colors: ['米白色', '杏色'], tops: '杏色亚麻衬衫', bottoms: '米白亚麻裤', shoes: '小白鞋', accessories: ['帆布包'], imagePrompt: 'a young woman in linen shirt' });
    });

    it('缺 imagePrompt 时返回 null（没法生图，整条作废）', () => {
        expect(parseTrajectoryOotdDraft({ style: '休闲', tops: '白衬衫' })).toBeNull();
        expect(parseTrajectoryOotdDraft({ imagePrompt: '' })).toBeNull();
    });

    it('style 缺省时兜底"日常"，colors/accessories 不是数组时当空数组', () => {
        const draft = parseTrajectoryOotdDraft({ imagePrompt: 'x', colors: 'not array', accessories: null });
        expect(draft).toMatchObject({ style: '日常', colors: [], accessories: [] });
    });

    it('不是对象/null 时返回 null', () => {
        expect(parseTrajectoryOotdDraft(null)).toBeNull();
        expect(parseTrajectoryOotdDraft('garbage')).toBeNull();
        expect(parseTrajectoryOotdDraft(undefined)).toBeNull();
    });
});

describe('groupTrajectoryOotdByDate', () => {
    it('同一天的多条按时间新到旧分在一组，组间按日期新到旧排', () => {
        const day1 = new Date('2026-09-15T09:32:00').getTime();
        const day1Later = new Date('2026-09-15T21:22:00').getTime();
        const day2 = new Date('2026-09-14T10:02:00').getTime();
        const posts = [
            { ...createTrajectoryOotdPost({ style: 'a', colors: [], tops: '', bottoms: '', shoes: '', accessories: [], imagePrompt: 'x' }, 'i1'), timestamp: day1 },
            { ...createTrajectoryOotdPost({ style: 'b', colors: [], tops: '', bottoms: '', shoes: '', accessories: [], imagePrompt: 'x' }, 'i2'), timestamp: day1Later },
            { ...createTrajectoryOotdPost({ style: 'c', colors: [], tops: '', bottoms: '', shoes: '', accessories: [], imagePrompt: 'x' }, 'i3'), timestamp: day2 },
        ];
        const grouped = groupTrajectoryOotdByDate(posts);
        expect(grouped).toHaveLength(2);
        expect(grouped[0].dateKey).toBe('2026-09-15');
        expect(grouped[0].posts.map(p => p.timestamp)).toEqual([day1Later, day1]);
        expect(grouped[1].dateKey).toBe('2026-09-14');
    });

    it('空数组返回空分组', () => {
        expect(groupTrajectoryOotdByDate([])).toEqual([]);
    });
});

describe('filterMomentsVisibleToChar', () => {
    const makePost = (overrides: Partial<SocialPost>): SocialPost => ({
        id: `p-${Math.random()}`, authorName: 'x', authorAvatar: '', title: '', content: '',
        images: [], likes: 0, isCollected: false, isLiked: false, comments: [], timestamp: Date.now(), tags: [],
        ...overrides,
    });
    const makeContact = (overrides: Partial<PhoneContact>): PhoneContact => ({
        id: `c-${Math.random()}`, name: 'x', avatar: '', kind: 'real', affinity: 0, status: 'friend', createdAt: Date.now(),
        ...overrides,
    });
    const char = (contacts: PhoneContact[]) => ({ id: 'char-me', phoneState: { records: [], contacts } });

    it('用户本人的贴文一律可见', () => {
        const posts = [makePost({ authorType: 'user' })];
        expect(filterMomentsVisibleToChar(posts, char([]))).toHaveLength(1);
    });

    it('陌生人（stranger）贴文一律可见', () => {
        const posts = [makePost({ authorType: 'stranger' })];
        expect(filterMomentsVisibleToChar(posts, char([]))).toHaveLength(1);
    });

    it('char 自己发的贴文一律可见', () => {
        const posts = [makePost({ authorType: 'character', authorCharId: 'char-me' })];
        expect(filterMomentsVisibleToChar(posts, char([]))).toHaveLength(1);
    });

    it('另一角色的贴文：通讯录里有对应 friend 联系人才可见', () => {
        const posts = [makePost({ authorType: 'character', authorCharId: 'char-other' })];
        const contacts = [makeContact({ kind: 'real', linkedCharId: 'char-other', status: 'friend' })];
        expect(filterMomentsVisibleToChar(posts, char(contacts))).toHaveLength(1);
    });

    it('另一角色的贴文：通讯录里没有这个人时不可见', () => {
        const posts = [makePost({ authorType: 'character', authorCharId: 'char-other' })];
        expect(filterMomentsVisibleToChar(posts, char([]))).toHaveLength(0);
    });

    it('另一角色的贴文：联系人状态不是 friend（拉黑/待处理/已删除）时不可见', () => {
        const posts = [makePost({ authorType: 'character', authorCharId: 'char-other' })];
        for (const status of ['blocked', 'pending', 'deleted'] as const) {
            const contacts = [makeContact({ kind: 'real', linkedCharId: 'char-other', status })];
            expect(filterMomentsVisibleToChar(posts, char(contacts))).toHaveLength(0);
        }
    });

    it('联系人是 npc 类型（不是 real）时不会误判为认识那个角色', () => {
        const posts = [makePost({ authorType: 'character', authorCharId: 'char-other' })];
        const contacts = [makeContact({ kind: 'npc', linkedNpcId: 'npc-1', status: 'friend', linkedCharId: undefined })];
        expect(filterMomentsVisibleToChar(posts, char(contacts))).toHaveLength(0);
    });

    it('没有 authorType 的旧数据一律可见', () => {
        const posts = [makePost({ authorType: undefined })];
        expect(filterMomentsVisibleToChar(posts, char([]))).toHaveLength(1);
    });

    it('混合列表：只保留可见的那些，顺序不变', () => {
        const visible1 = makePost({ id: 'a', authorType: 'user' });
        const hidden = makePost({ id: 'b', authorType: 'character', authorCharId: 'char-other' });
        const visible2 = makePost({ id: 'c', authorType: 'stranger' });
        const result = filterMomentsVisibleToChar([visible1, hidden, visible2], char([]));
        expect(result.map(p => p.id)).toEqual(['a', 'c']);
    });
});
