import { describe, expect, it, vi } from 'vitest';
import type { CharacterProfile, UserProfile } from '../types';

let linesOn = false;
vi.mock('./devDebug', () => ({ isPersonaLinesEnabled: () => linesOn }));

const { personaKeyForChar, resolveUserProfileForChar } = await import('./userPersona');
const { withLineFields } = await import('./chatLine');

const base = (extra: Partial<UserProfile> = {}): UserProfile => ({
    name: '妹妹', avatar: '', bio: '',
    personas: [{ id: 'pB', name: '老婆', avatar: '', bio: '', createdAt: 0, updatedAt: 0 }],
    ...extra,
} as UserProfile);
const char = (extra: Partial<CharacterProfile> = {}) =>
    ({ id: 'c1', name: '阿澈', avatar: '', description: '', systemPrompt: '', memories: [], ...extra } as CharacterProfile);

describe('關係線預覽開關與主線', () => {
    it('關著：主線照舊跟著全域身份走', () => {
        linesOn = false;
        const c = char({ primaryPersonaKey: '__real__', knownPersonaKeys: ['__real__'] });
        expect(personaKeyForChar(base({ activePersonaId: 'pB' }), c)).toBe('pB');
    });

    it('開著：主線固定是 primaryPersonaKey', () => {
        linesOn = true;
        const c = char({ primaryPersonaKey: '__real__', knownPersonaKeys: ['__real__', 'pB'] });
        expect(personaKeyForChar(base({ activePersonaId: 'pB' }), c)).toBe('__real__');
        expect(resolveUserProfileForChar(base({ activePersonaId: 'pB' }), c).name).toBe('妹妹');
        linesOn = false;
    });

    it('關著時讀取會把只有一條線的角色主線對齊成現在用的身份；有多條線就不動', () => {
        const one = char({ primaryPersonaKey: '__real__', knownPersonaKeys: ['__real__'] });
        const synced = withLineFields(base({ activePersonaId: 'pB' }), one, { resync: true });
        expect(synced.primaryPersonaKey).toBe('pB');
        expect(synced.knownPersonaKeys).toEqual(['pB']);
        const two = char({ primaryPersonaKey: '__real__', knownPersonaKeys: ['__real__', 'pB'] });
        expect(withLineFields(base({ activePersonaId: 'pB' }), two, { resync: true })).toBe(two);
        const same = char({ primaryPersonaKey: 'pB', knownPersonaKeys: ['pB'] });
        expect(withLineFields(base({ activePersonaId: 'pB' }), same, { resync: true })).toBe(same);
    });
});
