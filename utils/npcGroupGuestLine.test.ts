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
