import { describe, expect, it } from 'vitest';
import { DB } from './db';
import { runNpcMigration } from './npcMigrationRun';
import { pendingNpcs } from './npcMigration';
import type { CharacterProfile, GroupProfile, MomentPost, NPCProfile, UserProfile } from '../types';

// 舊 NPC 的編輯頁和專用路徑拿掉之後（plans/npc-cleanup.md），舊資料只能靠搬家變成配角。
// 這裡走真的資料庫：塞一筆舊 NPC 和引用它的群、聯繫人、朋友圈，跑一次搬家，確認都搬過去、清單清空、再跑不會重複。
describe('舊 NPC 搬成配角（寫資料庫那一半）', () => {
    it('塞一筆舊 NPC：搬完變成配角、引用都改寫、待搬清單清空，再跑一次不重複', async () => {
        const profileBase = { name: '我', avatar: '', bio: '' } as UserProfile;
        const lead = {
            id: 'mig-lead', name: '阿澈', avatar: '', description: '', systemPrompt: '',
            phoneState: { records: [], contacts: [{ id: 'ct1', name: '林小姐', kind: 'npc', linkedNpcId: 'mig-npc', affinity: 12, status: 'friend', createdAt: 0 }] },
        } as unknown as CharacterProfile;
        const npc: NPCProfile = {
            id: 'mig-npc', name: '林小姐', avatar: '', description: '阿澈的聯姻對象。冷靜。',
            relationships: [{ id: 'r1', targetId: 'mig-lead', description: '聯姻對象' }],
            memory: '- 跟阿澈吃過一次飯', memoryUpdatedAt: new Date(2026, 9, 3).getTime(),
            createdAt: 1, updatedAt: 2,
        };
        const group = { id: 'mig-g', name: '家族群', members: ['mig-lead'], npcMemberIds: ['mig-npc'], createdAt: 0 } as GroupProfile;
        const post = {
            id: 'mig-p', author: { kind: 'npc', id: 'mig-npc', name: '林小姐' }, content: '晚安', images: [],
            visibility: { mode: 'friends' }, likes: [], comments: [], createdAt: 0, source: 'manual',
        } as unknown as MomentPost;
        await DB.saveCharacter(lead);
        await DB.saveNPC(npc);
        await DB.saveGroup(group);
        await DB.saveMomentPosts([post]);

        const pending = pendingNpcs(await DB.getAllNPCs()).filter(n => n.id === 'mig-npc');
        expect(pending).toHaveLength(1);
        const result = await runNpcMigration({ npcs: pending, characters: [lead], profileBase, groups: [group], now: 99 });
        expect(result.movedIds).toEqual(['mig-npc']);

        const chars = await DB.getAllCharacters();
        const moved = chars.find(c => c.id === 'mig-npc');
        expect(moved).toMatchObject({ name: '林小姐', castRole: 'supporting', systemPrompt: '阿澈的聯姻對象。冷靜。' });
        expect(moved?.relationships).toEqual([{ id: 'r1', targetId: 'mig-lead', description: '聯姻對象' }]);
        expect(Object.values(moved?.refinedMemories || {})).toEqual(['- 跟阿澈吃過一次飯']);

        const contact = chars.find(c => c.id === 'mig-lead')?.phoneState?.contacts?.[0];
        expect(contact).toMatchObject({ kind: 'real', linkedCharId: 'mig-npc', affinity: 12 });

        const savedGroup = (await DB.getGroups()).find(g => g.id === 'mig-g');
        expect(savedGroup?.members).toEqual(['mig-lead', 'mig-npc']);
        expect(savedGroup?.npcMemberIds).toBeUndefined();

        expect((await DB.getMomentPost('mig-p'))?.author.kind).toBe('character');

        // 舊表留著當備份，但標了搬過；開機讀的待搬清單是空的
        const stored = (await DB.getAllNPCs()).find(n => n.id === 'mig-npc');
        expect(stored?.migratedToCharAt).toBe(99);
        expect(pendingNpcs(await DB.getAllNPCs()).filter(n => n.id === 'mig-npc')).toEqual([]);

        // 再跑一次（例如備份還原回來又是沒搬的狀態）：角色已經在了，不會建第二個
        const again = await runNpcMigration({ npcs: [npc], characters: await DB.getAllCharacters(), profileBase, groups: await DB.getGroups(), now: 100 });
        expect(again.added).toEqual([]);
        expect((await DB.getAllCharacters()).filter(c => c.id === 'mig-npc')).toHaveLength(1);
    });
});
