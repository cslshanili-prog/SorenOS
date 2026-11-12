import { describe, expect, it } from 'vitest';
import type { CharacterProfile } from '../types';
import {
    allCloudIdsOf, cloudCharId, cloudCharPatch, cloudLineViewsOf, cloudLocalCharId, expandCharIdsWithLines,
    findCloudChar, setCloudLineRegistry,
} from './amsgCloudLine';
import { lineFor, lineView } from './chatLine';

const char = (extra: Partial<CharacterProfile> = {}): CharacterProfile =>
    ({ id: 'c1', name: '阿澈', avatar: '', description: '', systemPrompt: '', memories: [], primaryPersonaKey: 'pA', knownPersonaKeys: ['pA', 'pB'], ...extra } as CharacterProfile);

describe('線在雲端的 id', () => {
    it('主線就是 charId；非主線是另一個 id，拆得回來', () => {
        const c = char();
        expect(cloudCharId(c)).toBe('c1');
        const v = lineView(c, lineFor(c, 'pB'));
        expect(cloudCharId(v)).toBe('c1~line~pB');
        expect(cloudLocalCharId('c1~line~pB')).toBe('c1');
        expect(cloudLocalCharId('c1')).toBe('c1');
    });

    it('從雲端 id 找回那條線的視圖；角色不在就沒有', () => {
        const c = char({ lines: { pB: { userNickname: '老婆' } } });
        expect(findCloudChar([c], 'c1')).toBe(c);
        const v = findCloudChar([c], 'c1~line~pB')!;
        expect(v.userNickname).toBe('老婆');
        expect(cloudCharId(v)).toBe('c1~line~pB');
        expect(findCloudChar([c], 'c9~line~pB')).toBeUndefined();
    });

    it('改動寫回那條線，主線原樣', () => {
        const c = char({ activeMsg2Config: { enabled: true, tasks: [] } });
        const cfg = { enabled: true, tasks: [] };
        expect(cloudCharPatch(c, 'c1', { activeMsg2Config: cfg })).toEqual({ activeMsg2Config: cfg });
        const out = cloudCharPatch(c, 'c1~line~pB', { activeMsg2Config: cfg });
        expect(out).not.toHaveProperty('activeMsg2Config');
        expect(out.lines!.pB.activeMsg2Config).toEqual(cfg);
    });
});

describe('哪些線要跟雲端打交道', () => {
    it('非主線只算存過自己那份 2.0 設定的', () => {
        const c = char({ knownPersonaKeys: ['pA', 'pB', 'pC'], lines: { pB: { activeMsg2Config: { enabled: true, tasks: [] } }, pC: { userNickname: '妹' } } });
        expect(cloudLineViewsOf(c).map(cloudCharId)).toEqual(['c1', 'c1~line~pB']);
    });

    it('刪角色時主線加上每條線都要清', () => {
        const c = char({ knownPersonaKeys: ['pA', 'pB'], lines: { pC: {} } });
        expect(allCloudIdsOf(c)).toEqual(['c1', 'c1~line~pB', 'c1~line~pC']);
        expect(allCloudIdsOf(char({ knownPersonaKeys: ['pA'] }))).toEqual(['c1']);
    });

    it('MCP「只給哪些角色」展開到每條線', () => {
        setCloudLineRegistry([char(), char({ id: 'c2', knownPersonaKeys: ['pA'] })]);
        expect(expandCharIdsWithLines(['c1', 'c2'])).toEqual(['c1', 'c2', 'c1~line~pB']);
        setCloudLineRegistry([]);
        expect(expandCharIdsWithLines(['c1'])).toEqual(['c1']);
    });
});

describe('新線的主動消息 2.0 設定', () => {
    it('沒存過：照主線的頻率與額度，但關著、沒有任務', () => {
        const c = char({
            activeMsg2Config: {
                enabled: true, maxUnansweredSends: 2, dailySendCap: 5, instantChatEnabled: false,
                tasks: [{ taskUuid: 't1' } as any], lastSyncedAt: 1, lastError: 'x',
            },
        });
        const v = lineView(c, lineFor(c, 'pB'));
        expect(v.activeMsg2Config).toEqual({ enabled: false, maxUnansweredSends: 2, dailySendCap: 5, instantChatEnabled: false, tasks: [] });
        // 主線那份不受影響
        expect(c.activeMsg2Config!.tasks).toHaveLength(1);
    });

    it('存過就是這條線自己的一份', () => {
        const own = { enabled: true, tasks: [{ taskUuid: 'tB' } as any] };
        const c = char({ activeMsg2Config: { enabled: true, tasks: [] }, lines: { pB: { activeMsg2Config: own } } });
        expect(lineView(c, lineFor(c, 'pB')).activeMsg2Config).toBe(own);
    });

    it('主線沒開過 2.0，新線也沒有設定', () => {
        const c = char();
        expect(lineView(c, lineFor(c, 'pB')).activeMsg2Config).toBeUndefined();
    });
});
