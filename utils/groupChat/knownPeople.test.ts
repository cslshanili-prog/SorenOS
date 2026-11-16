import { describe, it, expect } from 'vitest';
import {
    buildGroupOthersKnownNote, buildKnownPeopleNote, buildKnownPeopleSummaryNote, knownPeopleDiffer, membersKnownPeople,
} from './knownPeople';
import { buildGroupTopicPrompt } from './topicBoxes';

const profile = {
    name: '真我', avatar: '', bio: '',
    personas: [
        { id: 'pA', name: '小雨', avatar: '', bio: '', createdAt: 0, updatedAt: 0 },
        { id: 'pB', name: '阿晴', avatar: '', bio: '', createdAt: 0, updatedAt: 0 },
    ],
} as any;

const members = [
    { id: 'c1', name: '亞當', primaryPersonaKey: 'pA' },
    { id: 'c2', name: 'Susu', primaryPersonaKey: 'pB' },
    { id: 'c3', name: 'Sully', primaryPersonaKey: 'pA' },
] as any[];

describe('群裡各自私下認識的人', () => {
    it('照每位成員的主線取名字', () => {
        const people = membersKnownPeople(members, profile);
        expect(people.map(p => [p.memberName, p.knownName])).toEqual([['亞當', '小雨'], ['Susu', '阿晴'], ['Sully', '小雨']]);
        expect(knownPeopleDiffer(people)).toBe(true);
    });

    it('名字不同才提醒：列出誰認識誰、提到時要讓人聽得出是誰', () => {
        const note = buildKnownPeopleNote(membersKnownPeople(members, profile));
        expect(note).toContain('亞當 私下認識的是「小雨」');
        expect(note).toContain('Susu 私下認識的是「阿晴」');
        expect(note).toContain('別只用「他／她」');
        expect(note).toContain('幕後資訊');
        // 都認識同一個人就不加
        expect(buildKnownPeopleNote(membersKnownPeople([members[0], members[2]], profile))).toBe('');
    });

    it('總結時「他／她」要寫出是誰，並帶進話題盒提示詞', () => {
        const people = membersKnownPeople(members, profile);
        const note = buildKnownPeopleSummaryNote(people);
        expect(note).toContain('亞當→「小雨」');
        expect(note).toContain('不要寫成含糊的「他」');
        const prompt = buildGroupTopicPrompt(
            { id: 'g', name: '群', members: ['c1', 'c2'], createdAt: 0 } as any,
            [{ id: 1, charId: 'c1', role: 'assistant', type: 'text', content: '他今天很累', timestamp: 0 }] as any,
            members, '真我', [], undefined, note,
        );
        expect(prompt).toContain('【成員各自私下認識的人】');
    });

    it('私聊裡的群聊背景：只提名字跟自己認識的不同的群友', () => {
        const people = membersKnownPeople(members, profile).filter(p => p.memberId !== 'c1');
        const note = buildGroupOthersKnownNote('小雨', people);
        expect(note).toContain('Susu的「阿晴」');
        expect(note).not.toContain('Sully');
        expect(buildGroupOthersKnownNote('小雨', people.filter(p => p.memberId === 'c3'))).toBe('');
    });
});
