import { describe, expect, it, vi } from 'vitest';
import type { CharacterProfile, UserProfile } from '../../types';

let linesOn = true;
vi.mock('../devDebug', async (orig) => ({ ...(await orig() as object), isPersonaLinesEnabled: () => linesOn }));

import { worldLineView } from './engine';
import { lineOf } from '../chatLine';
import { resolveUserProfileForChar } from '../userPersona';

const base = {
    name: '我', avatar: '', bio: '',
    personas: [
        { id: 'pA', name: '妹妹', avatar: '', bio: '', createdAt: 0, updatedAt: 0 },
        { id: 'pB', name: '老婆', avatar: '', bio: '', createdAt: 0, updatedAt: 0 },
    ],
    perWorldPersonaIds: { g1: 'pB' },
} as unknown as UserProfile;

const char = (extra: Partial<CharacterProfile> = {}): CharacterProfile =>
    ({ id: 'c1', name: '阿澈', avatar: '', description: '', systemPrompt: '', memories: [], groupId: 'g1', primaryPersonaKey: 'pA', knownPersonaKeys: ['pA', 'pB'], ...extra } as CharacterProfile);

// 家園裡的「你」：照居民所在世界的世界預設；認識那張卡才走那條線（plans/persona-line-batch3.md 收尾）
describe('worldLineView', () => {
    it('世界預設是角色認識的卡 → 走那條線，身份也是那張卡', () => {
        const v = worldLineView(base, char());
        expect(lineOf(v)).toEqual({ charId: 'c1', personaKey: 'pB' });
        expect(resolveUserProfileForChar(base, v).name).toBe('老婆');
    });

    it('不認識世界預設那張卡、沒設世界預設、預覽關著 → 照主線', () => {
        expect(lineOf(worldLineView(base, char({ knownPersonaKeys: ['pA'] })))).toEqual({ charId: 'c1' });
        expect(lineOf(worldLineView(base, char({ groupId: 'g2' })))).toEqual({ charId: 'c1' });
        linesOn = false;
        expect(lineOf(worldLineView(base, char()))).toEqual({ charId: 'c1' });
        linesOn = true;
    });
});
