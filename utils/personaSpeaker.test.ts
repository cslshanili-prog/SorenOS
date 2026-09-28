import { describe, expect, it } from 'vitest';
import type { UserProfile } from '../types';
import { distinctPersonaNote, userSpeakerName } from './personaSpeaker';
import { crossPersonaNote } from './personaSpeaker';
import { REAL_IDENTITY_PERSONA_ID } from './userPersona';

const base: UserProfile = {
    name: '小柔', avatar: '', bio: '',
    personas: [{ id: 'p1', name: '阿澈', avatar: '', bio: '', createdAt: 0, updatedAt: 0 }],
};

describe('userSpeakerName', () => {
    it('照身份鍵取名字', () => {
        expect(userSpeakerName(base, 'p1', '小星')).toBe('阿澈');
        expect(userSpeakerName(base, REAL_IDENTITY_PERSONA_ID, '小星')).toBe('小柔');
    });
    it('沒有資料或沒有鍵：用傳進來的名字', () => {
        expect(userSpeakerName(null, 'p1', '小星')).toBe('小星');
        expect(userSpeakerName(base, undefined, '小星')).toBe('小星');
    });
});

describe('distinctPersonaNote', () => {
    it('列出別的名字、說明是不同的人', () => {
        const note = distinctPersonaNote(['阿澈', '阿澈', '小星'], '小星', '群裡');
        expect(note).toContain('群裡的「阿澈」跟你私下聊天的「小星」是不同的人');
        expect(note.match(/「阿澈」/g)?.length).toBe(3);
    });
    it('都是同一個人：不加', () => {
        expect(distinctPersonaNote(['小星'], '小星', '群裡')).toBe('');
        expect(distinctPersonaNote([], '小星', '群裡')).toBe('');
    });
});

describe('角色對聊：兩邊認識的你不同', () => {
    it('同一個人不加；不同就說清楚', () => {
        expect(crossPersonaNote('小星', 'B', '小星')).toBe('');
        const note = crossPersonaNote('小星', 'B', '阿澈');
        expect(note).toContain('你私下認識的「小星」跟「B」私下認識的「阿澈」是兩個不同的人');
        expect(note).toContain('別主動提起「阿澈」');
    });
});
