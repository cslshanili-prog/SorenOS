import { describe, it, expect } from 'vitest';
import { switchPrimaryPersona } from './chatLine';
import { castRelationLines } from './castRelations';

describe('換主線那張卡', () => {
    it('換成新的卡：主線改認它，舊的那張不再認識，其他線照舊', () => {
        expect(switchPrimaryPersona({ primaryPersonaKey: '__real__', knownPersonaKeys: ['__real__', 'pB'] }, 'pA'))
            .toEqual({ primaryPersonaKey: 'pA', knownPersonaKeys: ['pA', 'pB'] });
    });

    it('還沒補欄位的舊角色也能換', () => {
        expect(switchPrimaryPersona({ primaryPersonaKey: '__real__' }, 'pA'))
            .toEqual({ primaryPersonaKey: 'pA', knownPersonaKeys: ['pA'] });
    });

    it('同一張、或已經是另一條線的卡：不換', () => {
        expect(switchPrimaryPersona({ primaryPersonaKey: 'pA', knownPersonaKeys: ['pA', 'pB'] }, 'pA')).toBeNull();
        expect(switchPrimaryPersona({ primaryPersonaKey: 'pA', knownPersonaKeys: ['pA', 'pB'] }, 'pB')).toBeNull();
        expect(switchPrimaryPersona({ primaryPersonaKey: 'pA' }, '')).toBeNull();
    });
});

describe('你身邊的人：跟「你」的那條只在主線上算', () => {
    const char = { id: 'c1', relationships: [
        { targetId: 'user', description: '妹妹' },
        { targetId: 'c2', description: '同事' },
    ] } as any;
    const nameOf = (id: string) => (id === 'c2' ? '小遙' : null);

    it('主線：跟你、跟別人的都在', () => {
        expect(castRelationLines({ char, others: [], nameOf, userName: '小雨' })).toEqual(['跟「小雨」：妹妹', '跟「小遙」：同事']);
    });

    it('別條線上的你是另一個人：不帶跟你的那條', () => {
        expect(castRelationLines({ char, others: [], nameOf, userName: '阿晴', includeUser: false })).toEqual(['跟「小遙」：同事']);
    });
});
