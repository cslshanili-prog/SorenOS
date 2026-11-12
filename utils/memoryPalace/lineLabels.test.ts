import { describe, expect, it } from 'vitest';
import type { Message, UserProfile } from '../../types';
import type { MemoryNode } from './types';
import { memoryLineLabel, memoryLineLabelsFor } from './lineLabels';
import { groupMessagesByLine } from './pipeline';
import { MemoryNodeDB } from './db';
import { expandAndFormat } from './formatter';
import { lineFor, lineView } from '../chatLine';

const profile = {
    name: '妹妹', avatar: '', bio: '',
    personas: [{ id: 'pB', name: '老婆', avatar: '', bio: '', createdAt: 0, updatedAt: 0 }],
} as UserProfile;
const brother = { id: 'line-mp-c1', name: '哥哥', avatar: '', description: '', systemPrompt: '', memories: [], primaryPersonaKey: '__real__', knownPersonaKeys: ['__real__', 'pB'] } as any;

describe('關係線：記憶標籤', () => {
    it('只有一條線的角色不標', () => {
        expect(memoryLineLabelsFor({ knownPersonaKeys: ['__real__'], primaryPersonaKey: '__real__' }, profile)).toBeUndefined();
    });

    it('在主線上，老婆那條線的記憶標清楚；同一條線的不標', () => {
        const labels = memoryLineLabelsFor(brother, profile)!;
        expect(labels.currentKey).toBe('__real__');
        expect(memoryLineLabel({}, labels)).toBe('');
        expect(memoryLineLabel({ personaKey: 'pB' }, labels)).toBe('〔這是你跟「老婆」之間的事，「妹妹」不一定知道〕');
    });

    it('在老婆那條線上，主線（沒標身份）的記憶標成跟妹妹的事', () => {
        const labels = memoryLineLabelsFor(lineView(brother, lineFor(brother, 'pB')), profile)!;
        expect(labels.currentKey).toBe('pB');
        expect(memoryLineLabel({}, labels)).toBe('〔這是你跟「妹妹」之間的事，「老婆」不一定知道〕');
        expect(memoryLineLabel({ personaKey: 'pB' }, labels)).toBe('');
    });
});

describe('關係線：整理時按線分組', () => {
    it('主線排第一，組內保持順序', () => {
        const m = (id: number, personaKey?: string) => ({ id, charId: 'c', role: 'user', type: 'text', content: String(id), timestamp: id, ...(personaKey ? { personaKey } : {}) }) as Message;
        const groups = groupMessagesByLine([m(1, 'pB'), m(2), m(3, 'pB'), m(4)]);
        expect(groups.map(g => [g.personaKey, g.messages.map(x => x.id)])).toEqual([[undefined, [2, 4]], ['pB', [1, 3]]]);
        expect(groupMessagesByLine([m(1), m(2)])).toHaveLength(1);
    });
});

describe('關係線：召回輸出帶標籤', () => {
    it('別條線的記憶在提示詞裡標出來，沒傳標籤就照舊', async () => {
        const base = { charId: brother.id, room: 'living_room', tags: [], importance: 5, mood: 'neutral', embedded: false, createdAt: Date.now() - 3600_000, lastAccessedAt: 0, accessCount: 0 } as unknown as MemoryNode;
        const sister: MemoryNode = { ...base, id: 'mp-sis', content: '妹妹說考試考砸了' };
        const wife: MemoryNode = { ...base, id: 'mp-wife', content: '老婆說明天要回娘家', personaKey: 'pB' };
        await MemoryNodeDB.save(sister); await MemoryNodeDB.save(wife);
        const results = [{ node: sister, finalScore: 1 }, { node: wife, finalScore: 0.9 }] as any;
        const labels = memoryLineLabelsFor(brother, profile);
        const out = await expandAndFormat(results, brother.id, [], '妹妹', undefined, labels);
        const wifeLine = out.split('\n').find(l => l.includes('「老婆」之間的事'));
        expect(wifeLine).toBeTruthy();
        expect(out).toContain('老婆說明天要回娘家');
        expect(out.split('\n').some(l => l.includes('「妹妹」之間的事'))).toBe(false);
        const plain = await expandAndFormat(results, brother.id, [], '妹妹');
        expect(plain).not.toContain('之間的事');
    });
});

describe('關係線：記憶片段的名字快照', () => {
    it('連結記憶宮殿的片段帶上線和名字', async () => {
        const { buildAutoArchiveFragments } = await import('./pipeline');
        const out = buildAutoArchiveFragments(
            [{ id: 'a', content: '妹妹的事', createdAt: 1 }, { id: 'b', content: '老婆的事', createdAt: 2, personaKey: 'pB' }],
            9, true, key => (key === 'pB' ? '老婆' : '妹妹'),
        )!;
        expect(out.fragments[0]).toMatchObject({ palaceMemoryId: 'a', personaName: '妹妹' });
        expect(out.fragments[0]).not.toHaveProperty('personaKey');
        expect(out.fragments[1]).toMatchObject({ palaceMemoryId: 'b', personaKey: 'pB', personaName: '老婆' });
    });
});

describe('關係線：事件盒不跨線', () => {
    it('老婆那條線的新記憶不會綁進妹妹那條線的盒子', async () => {
        const { bindMemoriesIntoEventBox } = await import('./eventBox');
        const { EventBoxDB } = await import('./db');
        const base = { charId: 'line-box-c1', room: 'living_room', tags: [], importance: 5, mood: 'neutral', embedded: true, createdAt: Date.now(), lastAccessedAt: 0, accessCount: 0 } as unknown as MemoryNode;
        const sister: MemoryNode = { ...base, id: 'box-sis', content: '妹妹要搬家', eventBoxId: 'box-move' };
        const wife: MemoryNode = { ...base, id: 'box-wife', content: '老婆也提到搬家', personaKey: 'pB' };
        await MemoryNodeDB.save(sister); await MemoryNodeDB.save(wife);
        await EventBoxDB.save({ id: 'box-move', charId: base.charId, name: '搬家', tags: [], liveMemoryIds: ['box-sis'], compressionCount: 0, createdAt: 1, updatedAt: 1 } as any);
        await bindMemoriesIntoEventBox(base.charId, [{ newMemoryId: 'box-wife', existingMemoryId: 'box-sis' }], []);
        const box = await EventBoxDB.getById('box-move');
        expect(box?.liveMemoryIds).toEqual(['box-sis']);
        expect((await MemoryNodeDB.getById('box-wife'))?.eventBoxId).not.toBe('box-move');
    });
});
