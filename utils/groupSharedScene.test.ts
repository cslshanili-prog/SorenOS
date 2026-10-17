import { describe, it, expect } from 'vitest';
import { ContextBuilder } from './context';
import type { CharacterProfile, MountedWorldbook, UserProfile } from '../types';

const sharedBook: MountedWorldbook = {
    id: 'shared',
    title: '青梅竹馬',
    content: '{{char}}和{{user}}從小一起長大。',
    category: '測試',
};
const member = (id: string, name: string, books: MountedWorldbook[]): CharacterProfile => ({
    id, name, avatar: '', description: '', systemPrompt: '', memories: [], mountedWorldbooks: books,
} as CharacterProfile);
const user = { name: '小明', bio: '' } as UserProfile;

describe('群聊共有世界書', () => {
    it('{{char}} 換成掛了這條的成員名，不原樣發出去', () => {
        const scene = ContextBuilder.buildGroupSharedScene([
            member('a', '阿澈', [sharedBook]),
            member('b', '小白', [sharedBook]),
            member('c', '路人甲', []),
        ], user);
        expect(scene.sharedWorldbookIds.has('shared')).toBe(true);
        expect(scene.text).toContain('阿澈、小白和小明從小一起長大。');
        expect(scene.text).not.toContain('{{char}}');
        expect(scene.text).not.toContain('路人甲');
    });
});
