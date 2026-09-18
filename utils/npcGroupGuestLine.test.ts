import { describe, it, expect, afterEach, vi } from 'vitest';
import { generateNpcGroupGuestLine } from './npcGroupGuestLine';
import type { NPCProfile, CharacterProfile } from '../types';

afterEach(() => vi.unstubAllGlobals());

const npc: NPCProfile = {
    id: 'npc-1',
    name: '路人阿姨',
    avatar: '',
    description: '常在楼下小卖部帮忙的邻居',
    relationships: [
        { id: 'rel-1', targetId: 'char-1', description: '看着他长大，当自己孩子一样' },
        { id: 'rel-2', targetId: 'user', description: '还不太熟，见过几次面' },
        { id: 'rel-3', targetId: 'char-not-in-group', description: '不该出现在这次客串的关系' },
    ],
    createdAt: 0,
    updatedAt: 0,
};

const member = { id: 'char-1', name: '小明' } as unknown as CharacterProfile;

describe('generateNpcGroupGuestLine', () => {
    it('把 NPC 描述 + 在场成员/用户关系折进 prompt，且过滤掉不在场成员的关系', async () => {
        let capturedBody: any;
        vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: any) => {
            capturedBody = JSON.parse(init.body);
            return new Response(JSON.stringify({ choices: [{ message: { content: '哎哟这不是小明嘛！' } }] }));
        }));

        const line = await generateNpcGroupGuestLine({
            npc,
            groupName: '楼下群',
            members: [member],
            userName: '用户',
            recentTranscript: '小明: 今天真热',
            hint: '路过打个招呼',
            api: { baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'test-model' },
        });

        expect(line).toBe('哎哟这不是小明嘛！');
        const prompt = capturedBody.messages[0].content as string;
        expect(prompt).toContain('常在楼下小卖部帮忙的邻居');
        expect(prompt).toContain('对「小明」：看着他长大，当自己孩子一样');
        expect(prompt).toContain('对用户「用户」：还不太熟，见过几次面');
        expect(prompt).not.toContain('不该出现在这次客串的关系');
        expect(prompt).toContain('路过打个招呼');
        expect(capturedBody.model).toBe('test-model');
    });

    it('API 报错时直接抛错，不吞掉失败', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));
        await expect(generateNpcGroupGuestLine({
            npc, groupName: '楼下群', members: [], userName: '用户', recentTranscript: '',
            api: { baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'test-model' },
        })).rejects.toThrow('API 返回 500');
    });
});
