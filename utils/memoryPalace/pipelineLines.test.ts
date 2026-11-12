import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MemoryNode } from './types';

// 關係線（plans/persona-line-batch1-2.md 第 6 節）：整理記憶時每條線的私聊一起看，
// 按線分開提取（各用那條線的身份名字），記憶標上來源線，水位只推一條。
vi.mock('./extraction', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./extraction')>()),
    extractMemoriesFromBuffer: vi.fn(async (chunk: any[], charId: string, _charName: string, _llm: unknown, _ctx: string, userName: string) => ({
        memories: [{
            id: `m-${chunk[0].id}`, charId, content: `${userName}｜${chunk.map(m => m.content).join('／')}`,
            room: 'living_room', tags: [], importance: 5, mood: 'neutral', embedded: false,
            createdAt: Date.now(), lastAccessedAt: 0, accessCount: 0,
        } as MemoryNode],
        crossTimeLinks: [], eventBoxHints: [], corrections: [], unpinIds: [],
    })),
}));
vi.mock('./vectorStore', async (importOriginal) => {
    const { MemoryNodeDB } = await import('./db');
    return {
        ...(await importOriginal<typeof import('./vectorStore')>()),
        vectorizeAndStore: vi.fn(async (nodes: MemoryNode[]) => {
            for (const n of nodes) await MemoryNodeDB.save({ ...n, embedded: true });
            return { stored: nodes.length, skipped: 0 };
        }),
        checkModelConsistency: vi.fn(async () => 'ok'),
    };
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('記憶整理按關係線分開', () => {
    it('兩條線分開提取、各用自己的名字，記憶標上來源線', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
        const { DB } = await import('../db');
        const { MemoryNodeDB } = await import('./db');
        const { processNewMessages } = await import('./pipeline');
        await DB.saveUserProfile({
            name: '妹妹', avatar: '', bio: '',
            personas: [{ id: 'pB', name: '老婆', avatar: '', bio: '', createdAt: 0, updatedAt: 0 }],
        } as any);
        const charId = 'line-pipeline-c1';
        await DB.saveCharacter({ id: charId, name: '哥哥', avatar: '', description: '', systemPrompt: '', memories: [], primaryPersonaKey: '__real__', knownPersonaKeys: ['__real__', 'pB'] } as any);
        await DB.saveMessage({ charId, role: 'user', type: 'text', content: '哥我考砸了' });
        await DB.saveMessage({ charId, personaKey: 'pB', role: 'user', type: 'text', content: '老公明天回娘家' });
        await DB.saveMessage({ charId, role: 'assistant', type: 'text', content: '沒事下次加油' });
        await DB.saveMessage({ charId, personaKey: 'pB', role: 'assistant', type: 'text', content: '好我送妳' });

        const result = await processNewMessages(
            [], charId, '哥哥', { baseUrl: 'https://x.invalid', apiKey: 'k', model: 'e', dimensions: 2 } as any,
            { baseUrl: 'https://x.invalid', apiKey: 'k', model: 'm' } as any, '妹妹', true, undefined,
            { drainBuffer: true, retainRecentMessages: 0 },
        );
        expect(result?.stored).toBe(2);

        const nodes = await MemoryNodeDB.getByCharId(charId);
        const sister = nodes.find(n => n.content.includes('考砸'))!;
        const wife = nodes.find(n => n.content.includes('娘家'))!;
        expect(sister.personaKey).toBeUndefined();
        expect(sister.content.startsWith('妹妹｜')).toBe(true);
        expect(sister.content).not.toContain('娘家');
        expect(wife.personaKey).toBe('pB');
        expect(wife.content.startsWith('老婆｜')).toBe(true);
        expect(wife.content).not.toContain('考砸');

        // 水位只有一條，推到兩條線最後那則；兩條線處理過的原文都不再進上下文
        expect(await DB.getRecentMessagesByCharId(charId, 50)).toEqual([]);
        expect(await DB.getRecentMessagesByCharId({ charId, personaKey: 'pB' }, 50)).toEqual([]);
    });
});
