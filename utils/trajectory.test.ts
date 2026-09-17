import { describe, it, expect } from 'vitest';
import {
    buildTrajectoryProfilePrompt, parseTrajectoryProfile, toggleTrajectoryChecklistItem,
    createTrajectoryArchiveDoc, createTrajectoryObjective, createTrajectoryChecklistItem,
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
