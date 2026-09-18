import { describe, it, expect } from 'vitest';
import {
    buildTrajectoryProfilePrompt, parseTrajectoryProfile, toggleTrajectoryChecklistItem,
    createTrajectoryArchiveDoc, createTrajectoryObjective, createTrajectoryChecklistItem,
    buildTrajectoryOotdPrompt, parseTrajectoryOotdDraft, createTrajectoryOotdPost, groupTrajectoryOotdByDate,
    buildTrajectoryMomentsPrompt, parseTrajectoryMomentDraft, createTrajectoryMomentPost,
    buildTrajectoryJourneyPrompt, createTrajectoryJourneyEntry,
} from './trajectory';

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

describe('buildTrajectoryMomentsPrompt', () => {
    it('带上最近发过的内容做防重复提示', () => {
        const existing = [
            createTrajectoryMomentPost({ content: '今天去海边了，风好大', likes: 10, comments: [], imagePrompt: 'x' }, 'i1'),
        ];
        const prompt = buildTrajectoryMomentsPrompt('role block', existing);
        expect(prompt).toContain('今天去海边了，风好大');
    });

    it('没有历史记录时不含防重复提示', () => {
        const prompt = buildTrajectoryMomentsPrompt('role block');
        expect(prompt).not.toContain('最近发过这些内容了');
    });
});

describe('parseTrajectoryMomentDraft', () => {
    it('正常解析全部字段', () => {
        const draft = parseTrajectoryMomentDraft({
            content: '今天天气正好', likes: 128,
            comments: [{ authorName: '路人甲', content: '好美的天气！' }],
            imagePrompt: 'a sunny street scene',
        });
        expect(draft).toEqual({
            content: '今天天气正好', likes: 128,
            comments: [{ authorName: '路人甲', content: '好美的天气！' }],
            imagePrompt: 'a sunny street scene',
        });
    });

    it('缺 content 或 imagePrompt 时返回 null', () => {
        expect(parseTrajectoryMomentDraft({ imagePrompt: 'x' })).toBeNull();
        expect(parseTrajectoryMomentDraft({ content: 'x' })).toBeNull();
    });

    it('likes 不是数字、comments 不是数组时兜底', () => {
        const draft = parseTrajectoryMomentDraft({ content: 'x', imagePrompt: 'x', likes: 'not a number', comments: 'not array' });
        expect(draft).toMatchObject({ likes: 0, comments: [] });
    });

    it('comments 里缺 authorName 的兜底"路人"，缺 content 的条目被过滤掉', () => {
        const draft = parseTrajectoryMomentDraft({
            content: 'x', imagePrompt: 'x',
            comments: [{ content: '有内容没名字' }, { authorName: '只有名字没内容' }],
        });
        expect(draft?.comments).toEqual([{ authorName: '路人', content: '有内容没名字' }]);
    });

    it('不是对象/null 时返回 null', () => {
        expect(parseTrajectoryMomentDraft(null)).toBeNull();
        expect(parseTrajectoryMomentDraft('garbage')).toBeNull();
        expect(parseTrajectoryMomentDraft(undefined)).toBeNull();
    });
});

describe('createTrajectoryMomentPost', () => {
    it('draft + image 拼成完整记录，每条评论都分配了 id', () => {
        const post = createTrajectoryMomentPost({
            content: '今天天气正好', likes: 128,
            comments: [{ authorName: '路人甲', content: '好美的天气！' }],
            imagePrompt: 'x',
        }, 'image-token');
        expect(post.content).toBe('今天天气正好');
        expect(post.image).toBe('image-token');
        expect(post.likes).toBe(128);
        expect(post.comments).toHaveLength(1);
        expect(post.comments[0].id).toBeTruthy();
        expect(post.comments[0].authorName).toBe('路人甲');
        expect(post.syncedMessageId).toBeUndefined();
    });
});

describe('buildTrajectoryJourneyPrompt', () => {
    it('列出参与者名字与描述，正文不出现"用户"字样的硬编码提示之外的用户身份', () => {
        const prompt = buildTrajectoryJourneyPrompt('角色设定块', {
            kind: '日常', time: '今晚八点', location: '老城区咖啡馆',
            participants: [{ name: 'Miles', description: '爵士乐手，TA 的老朋友' }],
            detail: '聊起了即兴专场',
        });
        expect(prompt).toContain('Miles');
        expect(prompt).toContain('爵士乐手，TA 的老朋友');
        expect(prompt).toContain('今晚八点');
        expect(prompt).toContain('老城区咖啡馆');
        expect(prompt).toContain('聊起了即兴专场');
        expect(prompt).toContain('绝对不能出现用户');
    });

    it('没有参与者时给出独自经历的兜底措辞', () => {
        const prompt = buildTrajectoryJourneyPrompt('角色设定块', { kind: '事件', time: '', location: '', participants: [] });
        expect(prompt).toContain('独自经历');
    });

    it('没有补充细节时不出现"补充细节"这行', () => {
        const prompt = buildTrajectoryJourneyPrompt('角色设定块', { kind: '日常', time: 'x', location: 'y', participants: [] });
        expect(prompt).not.toContain('补充细节');
    });
});

describe('createTrajectoryJourneyEntry', () => {
    it('组装出完整的记录，补充细节的首尾空白被裁掉', () => {
        const entry = createTrajectoryJourneyEntry({
            kind: '事件', time: '明天', location: '海边', participantNames: ['Aven', 'Swan'],
            detail: '  聊聊新专辑  ', story: '这是一段生成的叙事。',
        });
        expect(entry).toMatchObject({
            kind: '事件', time: '明天', location: '海边', participantNames: ['Aven', 'Swan'],
            detail: '聊聊新专辑', story: '这是一段生成的叙事。',
        });
        expect(entry.id).toMatch(/^traj-jn-/);
        expect(entry.createdAt).toBeGreaterThan(0);
        expect(entry.syncedMessageId).toBeUndefined();
    });

    it('没有补充细节（空字符串/未传）时 detail 是 undefined', () => {
        const entry1 = createTrajectoryJourneyEntry({ kind: '日常', time: '', location: '', participantNames: [], story: 'x', detail: '  ' });
        expect(entry1.detail).toBeUndefined();
        const entry2 = createTrajectoryJourneyEntry({ kind: '日常', time: '', location: '', participantNames: [], story: 'x' });
        expect(entry2.detail).toBeUndefined();
    });

    it('participantCharIds 有值时原样带上；未传或空数组时是 undefined（不落一个空数组）', () => {
        const withIds = createTrajectoryJourneyEntry({
            kind: '日常', time: '', location: '', participantNames: ['Aven'], participantCharIds: ['char-aven'], story: 'x',
        });
        expect(withIds.participantCharIds).toEqual(['char-aven']);
        const withoutIds = createTrajectoryJourneyEntry({ kind: '日常', time: '', location: '', participantNames: [], story: 'x' });
        expect(withoutIds.participantCharIds).toBeUndefined();
        const emptyIds = createTrajectoryJourneyEntry({ kind: '日常', time: '', location: '', participantNames: [], participantCharIds: [], story: 'x' });
        expect(emptyIds.participantCharIds).toBeUndefined();
    });
});
