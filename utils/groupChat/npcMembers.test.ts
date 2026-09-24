import { describe, expect, it } from 'vitest';
import type { NPCProfile } from '../../types';
import { activeGroupNpcs, buildNpcDirectorNote, buildNpcMemberBlock, groupNpcs } from './npcMembers';

const npc = (id: string, name: string, extra: Partial<NPCProfile> = {}): NPCProfile => ({
    id, name, avatar: '', description: '', relationships: [], createdAt: 0, updatedAt: 0, ...extra,
});

describe('群裡的 NPC', () => {
    const all = [npc('n1', '房東'), npc('n2', '學妹')];

    it('按加入順序取，刪掉的略過，禁言的不算在場', () => {
        const group = { npcMemberIds: ['n2', 'gone', 'n1'], mutedMemberIds: ['n1'] };
        expect(groupNpcs(group, all).map(n => n.id)).toEqual(['n2', 'n1']);
        expect(activeGroupNpcs(group, all).map(n => n.id)).toEqual(['n2']);
        expect(activeGroupNpcs({}, all)).toEqual([]);
    });
});

describe('NPC 檔案塊', () => {
    it('設定、只列在場對象的關係、記憶都在；旁觀時標出用戶不在群裡', () => {
        const block = buildNpcMemberBlock({
            npc: npc('n1', '房東', {
                description: '嘴硬心軟的中年大叔',
                relationships: [
                    { id: 'r1', targetId: 'user', description: '租客' },
                    { id: 'r2', targetId: 'c1', description: '看著長大的鄰居小孩' },
                    { id: 'r3', targetId: 'c9', description: '不在群裡的人' },
                ],
                memory: '- 小夏答應下個月準時交房租',
            }),
            userName: '小安',
            others: [{ id: 'c1', name: '小夏' }],
            userLurking: true,
        });
        expect(block).toContain('NPC 成員檔案 START: 房東 (ID: n1)');
        expect(block).toContain('嘴硬心軟的中年大叔');
        expect(block).toContain('對「小安」（此刻不在群裡）：租客');
        expect(block).toContain('對「小夏」：看著長大的鄰居小孩');
        expect(block).not.toContain('不在群裡的人');
        expect(block).toContain('小夏答應下個月準時交房租');
    });

    it('掛的世界書照關鍵字觸發', () => {
        const npcWithBook = npc('n1', '房東', {
            mountedWorldbooks: [
                { id: 'w1', title: '公寓', content: '頂樓有間不能進的房間', key: ['頂樓'], constant: false },
                { id: 'w2', title: '常駐', content: '房東養了一隻橘貓' },
            ],
        });
        const quiet = buildNpcMemberBlock({ npc: npcWithBook, userName: '小安', others: [], scanMessages: [{ content: '今天好熱' }] });
        expect(quiet).toContain('橘貓');
        expect(quiet).not.toContain('頂樓有間');
        const hit = buildNpcMemberBlock({ npc: npcWithBook, userName: '小安', others: [], scanMessages: [{ content: '頂樓怎麼了' }] });
        expect(hit).toContain('頂樓有間不能進的房間');
    });

    it('導演說明：沒有 NPC 就是空字串；有就點名、禁 PRIVATE', () => {
        expect(buildNpcDirectorNote([])).toBe('');
        const note = buildNpcDirectorNote(['房東', '學妹']);
        expect(note).toContain('房東、學妹');
        expect(note).toContain('NPC 不能用 PRIVATE');
    });
});
