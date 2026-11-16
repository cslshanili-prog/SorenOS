import { describe, it, expect, afterEach, vi } from 'vitest';
import { generateNpcGroupGuestLine } from './npcGroupGuestLine';
import type { NPCProfile, CharacterProfile } from '../types';

afterEach(() => vi.unstubAllGlobals());

const npc: NPCProfile = {
    id: 'npc-1',
    name: '路人阿姨',
    avatar: '',
    description: '常在樓下小賣部幫忙的鄰居',
    relationships: [
        { id: 'rel-1', targetId: 'char-1', description: '看著他長大，當自己孩子一樣' },
        { id: 'rel-2', targetId: 'user', description: '還不太熟，見過幾次面' },
        { id: 'rel-3', targetId: 'char-not-in-group', description: '不該出現在這次客串的關係' },
    ],
    createdAt: 0,
    updatedAt: 0,
};

const member = { id: 'char-1', name: '小明' } as unknown as CharacterProfile;

describe('generateNpcGroupGuestLine', () => {
    it('把 NPC 描述 + 在場成員/用戶關係折進 prompt，且過濾掉不在場成員的關係', async () => {
        let capturedBody: any;
        vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: any) => {
            capturedBody = JSON.parse(init.body);
            return new Response(JSON.stringify({ choices: [{ message: { content: '哎喲這不是小明嘛！' } }] }));
        }));

        const line = await generateNpcGroupGuestLine({
            npc,
            groupName: '樓下群',
            members: [member],
            userName: '用戶',
            recentTranscript: '小明: 今天真熱',
            hint: '路過打個招呼',
            api: { baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'test-model' },
        });

        expect(line).toBe('哎喲這不是小明嘛！');
        const prompt = capturedBody.messages[0].content as string;
        expect(prompt).toContain('常在樓下小賣部幫忙的鄰居');
        expect(prompt).toContain('對「小明」：看著他長大，當自己孩子一樣');
        expect(prompt).toContain('對用戶「用戶」：還不太熟，見過幾次面');
        expect(prompt).not.toContain('不該出現在這次客串的關係');
        expect(prompt).toContain('路過打個招呼');
        expect(capturedBody.model).toBe('test-model');
    });

    it('API 報錯時直接拋錯，不吞掉失敗', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));
        await expect(generateNpcGroupGuestLine({
            npc, groupName: '樓下群', members: [], userName: '用戶', recentTranscript: '',
            api: { baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'test-model' },
        })).rejects.toThrow('API 返回 500');
    });
});

describe('群聊客串的人選（NPC 搬成配角之後）', () => {
    const chars = [
        { id: 'lead', name: '主角', castRole: 'lead' },
        { id: 'sup-1', name: '配角甲', castRole: 'supporting' },
        { id: 'sup-in', name: '已在群裡', castRole: 'supporting' },
        { id: 'sup-bench', name: '下戲了', castRole: 'supporting', benchedAt: 1 },
        { id: 'sup-alt', name: '小號', castRole: 'supporting', altOf: 'lead' },
    ] as unknown as CharacterProfile[];
    const legacy = [
        { id: 'old-1', name: '舊NPC', relationships: [], createdAt: 0, updatedAt: 0 },
        { id: 'old-moved', name: '搬過的', relationships: [], migratedToCharAt: 1, createdAt: 0, updatedAt: 0 },
    ] as unknown as NPCProfile[];

    it('只列在戲上、不是小號、不在群裡的配角，加上還沒搬家的舊 NPC', async () => {
        const { groupGuestCandidates } = await import('./npcGroupGuestLine');
        const list = groupGuestCandidates(chars, legacy, { members: ['lead', 'sup-in'] });
        expect(list.map(g => [g.kind, g.id])).toEqual([['cast', 'sup-1'], ['npc', 'old-1']]);
    });

    it('沒有群也不會壞；沒有配角就是空的', async () => {
        const { groupGuestCandidates } = await import('./npcGroupGuestLine');
        expect(groupGuestCandidates([chars[0]], [], null)).toEqual([]);
    });

    it('配角轉成客串用的檔案：人設、世界觀、關係、最近一段記憶', async () => {
        const { castAsGuestProfile } = await import('./npcGroupGuestLine');
        const p = castAsGuestProfile({
            id: 'sup-1', name: '配角甲', avatar: '', description: '短介紹', systemPrompt: '完整人設',
            worldview: '世界觀', relationships: [{ id: 'r', targetId: 'user', description: '鄰居' }],
            refinedMemories: { '2026-09': '舊的', '2026-11': '最近的事' },
        } as unknown as CharacterProfile);
        expect(p).toMatchObject({ id: 'sup-1', name: '配角甲', description: '完整人設', worldview: '世界觀', memory: '最近的事' });
        expect(p.relationships).toEqual([{ id: 'r', targetId: 'user', description: '鄰居' }]);
    });
});
