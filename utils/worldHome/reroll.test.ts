import { describe, expect, it, vi } from 'vitest';
import { DB } from '../db';
import { applyRelationshipDeltas, buildOwnWorldHistory, rollbackWorldBeat, rerollWorldCharBeat, rerollWorldEpisodeAll, runWorldEpisode } from './engine';
import { formatRealClock, realNowSeg, worldNow } from './prompts';
import { applyBeatToThreads } from './threads';
import type { WorldProfile, WorldEpisode, WorldCharBeat } from '../../types';

vi.mock('../chatContextRange', () => ({ loadCharacterContextMessages: vi.fn(async () => []) }));
vi.mock('../chatRequestPayload', () => ({ buildChatRequestPayload: vi.fn(async () => ({ systemPrompt: '', cleanedApiMessages: [] })) }));
vi.mock('../safeApi', () => ({ safeFetchJson: vi.fn() }));
import { safeFetchJson } from '../safeApi';

const members = [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }];
const beat = (text = '舊劇情'): WorldCharBeat => ({ charId: 'a', charName: '甲', location: '公園', mood: '平靜', narrative: text,
    memo: [text + '備忘'], phone: { dms: [{ to: '乙', lines: [text] }] },
    relationshipDeltas: [{ withName: '乙', delta: 10, newLabel: '舊標籤' }],
});
const world = (id: string): WorldProfile => ({ id, name: '鎮', worldview: '', mode: 'light', timeMode: 'sim',
    storyClock: 1, memberIds: ['a', 'b'], npcs: [], houses: [], relationships: [{ fromId: 'a', toId: 'b', value: 100, label: '舊標籤' }], createdAt: 0, updatedAt: 0 });
const episode = (id: string): WorldEpisode => ({ id: id + '-ep', worldId: id, round: 1, storyTime: '第1天中午', trigger: 'observe', createdAt: 1,
    summary: '舊梗概', beats: [beat()], relationshipsBefore: [{ fromId: 'a', toId: 'b', value: 98, label: '朋友' }] });

describe('家園重演', () => {
    it.each([0, 1, 3])('重演保留私信和群聊位置，新消息數量 %s，支持連續重演', async (count) => {
        const w = world(`reroll-order-${count}`), ep = episode(w.id);
        const a = { ...beat(), phone: { dms: [{ to: '乙', lines: ['舊一', '舊二'] }], group: ['舊一', '舊二'] } };
        const b = { ...beat('乙的回覆'), charId: 'b', charName: '乙', phone: { dms: [{ to: '甲', lines: ['乙的回覆'] }], group: ['乙的回覆'] } };
        ep.beats = [a, b];
        applyBeatToThreads(w, { ...a, phone: { dms: [{ to: '乙', lines: ['歷史消息'] }], group: ['歷史消息'] } }, members, 0, '前一輪');
        applyBeatToThreads(w, a, members, 1, ep.storyTime);
        applyBeatToThreads(w, b, members, 1, ep.storyTime);
        const replies = w.threads!.map(t => t.messages[t.messages.length - 1]);
        await DB.saveWorld(w); await DB.saveWorldEpisode(ep);
        for (let attempt = 0; attempt < 2; attempt++) {
            const lines = Array.from({ length: count }, (_, i) => `新消息-${attempt}-${i}`);
            vi.mocked(safeFetchJson).mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ narrative: '新劇情', location: '家', mood: '開心', phone: { dms: [{ to: '乙', lines }], group: lines } }) } }] });
            const result = await rerollWorldCharBeat({ world: w, characters: members as any, apiConfig: { baseUrl: 'https://test.invalid', model: 'test' } as any, userProfile: { name: '我' } as any, groups: [], trigger: 'observe', episodeId: ep.id, charId: 'a' });
            expect(result.ok).toBe(true);
            const saved = (await DB.getWorld(w.id))!;
            for (const [index, thread] of saved.threads!.entries()) {
                expect(thread.messages.map(m => m.text)).toEqual(['歷史消息', ...lines, '乙的回覆']);
                expect(thread.messages[thread.messages.length - 1]).toEqual(replies[index]);
            }
        }
    });
    it('恢復飽和前數值和原標籤，重複重演不累計，保留其他角色消息及伏筆', () => {
        const w = world('rollback'), ep = episode(w.id);
        applyBeatToThreads(w, beat(), members, 1, ep.storyTime);
        applyBeatToThreads(w, { ...beat('他人發言'), charId: 'b', charName: '乙', phone: { group: ['他人發言'] } }, members, 1, ep.storyTime);
        w.seeds = ['a', 'b'].map(charId => ({ id: charId, charId, charName: charId, text: '秘密', hideFrom: [], round: 1, storyTime: ep.storyTime, status: 'pending' }));
        for (let i = 0; i < 2; i++) {
            rollbackWorldBeat(w, ep, 'a', members);
            expect(w.relationships[0]).toMatchObject({ value: 98, label: '朋友' });
            applyRelationshipDeltas(w, [{ ...beat(), relationshipDeltas: [{ withName: '乙', delta: -5, newLabel: '新標籤' }] }], members);
            expect(w.relationships[0]).toMatchObject({ value: 93, label: '新標籤' });
        }
        expect(w.threads!.flatMap(t => t.messages).map(m => m.text)).toEqual(['他人發言']);
        expect(w.seeds.map(s => s.charId)).toEqual(['b']);
    });
    it('舊存檔撤銷已知變化且不保留失效標籤', () => {
        const w = world('legacy'), ep = episode(w.id); delete ep.relationshipsBefore;
        rollbackWorldBeat(w, ep, 'a', members);
        expect(w.relationships[0]).toEqual({ fromId: 'a', toId: 'b', value: 90 });
    });
    it('本人最新正文和備忘進入後續上下文，不洩露其他角色私人敘事', () => {
        const w = world('history'), ep = episode(w.id);
        ep.beats = [beat('新劇情'), { ...beat('他人秘密'), charId: 'b' }];
        const context = buildOwnWorldHistory(w, [ep], 'a');
        expect(context).toContain('新劇情備忘'); expect(context).not.toContain('舊劇情'); expect(context).not.toContain('他人秘密');
        expect(buildOwnWorldHistory({ ...w, simSummarizedClock: 1 }, [ep], 'a')).toBe('');
    });
    it('原子替換已注入卡片的正文和 metadata，保留 ID 和時間', async () => {
        const w = world('atomic'), ep = episode(w.id);
        await DB.saveWorld(w); await DB.saveWorldEpisode(ep);
        await DB.saveMessage({ charId: 'a', role: 'assistant', type: 'world_card', content: '舊正文', metadata: { worldId: w.id, round: 1, storyTime: ep.storyTime } as any });
        const old = (await DB.getMessagesByCharId('a', true)).find(m => (m.metadata as any)?.worldId === w.id)!;
        await DB.replaceWorldBeat({ ...w, relationships: [] }, { ...ep, beats: [beat('新劇情')] }, 'a', {
            content: '新正文', metadata: { worldId: w.id, round: 1, storyTime: ep.storyTime, narrative: '新劇情' } as any, insertIfMissing: true,
        }, w, ep);
        expect(await DB.getMessageById(old.id)).toMatchObject({ id: old.id, timestamp: old.timestamp, content: '新正文', metadata: { narrative: '新劇情' } });
        expect((await DB.getWorld(w.id))!.relationships).toEqual([]);
    });
    it('併發關係編輯使整次提交回滾，保留原劇情與卡片', async () => {
        const w = world('conflict'), ep = episode(w.id);
        await DB.saveWorld(w); await DB.saveWorldEpisode(ep);
        await DB.updateWorld(w.id, { relationships: [] });
        await expect(DB.replaceWorldBeat(w, { ...ep, beats: [beat('新劇情')] }, 'a', { content: '新正文', metadata: {}, insertIfMissing: true }, w, ep)).rejects.toThrow();
        expect((await DB.getWorldEpisodes(w.id))[0].beats[0].narrative).toBe('舊劇情');
        expect((await DB.getMessagesByCharId('a', true)).some(m => (m.metadata as any)?.worldId === w.id)).toBe(false);
    });
    it.each([true, false])('完整重演保存劇情、私信、關係、伏筆（已有劇情：%s）', async (hadBeat) => {
        const w = world(`reroll-${hadBeat}`), ep = episode(w.id);
        if (hadBeat) applyBeatToThreads(w, beat(), members, 1, ep.storyTime);
        else {
            ep.beats = [];
            ep.failedCharIds = ['a'];
            w.relationships = ep.relationshipsBefore!.map(r => ({ ...r }));
        }
        await DB.saveWorld(w); await DB.saveWorldEpisode(ep);
        vi.mocked(safeFetchJson).mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ narrative: '新劇情', location: '家', mood: '開心', phone: { dms: [{ to: '乙', lines: ['新私信'] }] }, secrets: [{ text: '新伏筆' }], relationships: [{ with: '乙', delta: -3, relabel: '新標籤' }] }) } }] });
        const result = await rerollWorldCharBeat({ world: { ...w, relationships: [] }, characters: members as any, apiConfig: { baseUrl: 'https://test.invalid', model: 'test' } as any, userProfile: { name: '我' } as any, groups: [], trigger: 'observe', episodeId: ep.id, charId: 'a' });
        expect(result.ok).toBe(true);
        const savedEpisode = (await DB.getWorldEpisodes(w.id))[0];
        expect(savedEpisode.beats).toHaveLength(1);
        expect(savedEpisode.beats[0].narrative).toBe('新劇情');
        expect(savedEpisode.failedCharIds).toBeUndefined();
        const saved = (await DB.getWorld(w.id))!;
        expect(saved.threads!.flatMap(t => t.messages).map(m => m.text)).toEqual(['新私信']);
        expect(saved.relationships[0]).toMatchObject({ value: 95, label: '新標籤' });
        expect(saved.seeds!.some(s => s.text === '新伏筆')).toBe(true);
    });

    it('整段重演：所有人照順序重來，後面的人看得到前面的新版本；舊消息、伏筆、卡片全換掉', async () => {
        const w = world('reroll-all'), ep = episode(w.id);
        const a = beat('甲舊');
        const b = { ...beat('乙舊'), charId: 'b', charName: '乙', phone: { dms: [{ to: '甲', lines: ['乙舊私信'] }] }, relationshipDeltas: [] };
        ep.beats = [a, b];
        applyBeatToThreads(w, a, members, 1, ep.storyTime);
        applyBeatToThreads(w, b, members, 1, ep.storyTime);
        w.seeds = [{ id: 's', charId: 'a', charName: '甲', text: '舊伏筆', hideFrom: [], round: 1, storyTime: ep.storyTime, status: 'pending' }];
        await DB.saveWorld(w); await DB.saveWorldEpisode(ep);
        for (const id of ['a', 'b']) {
            await DB.saveMessage({ charId: id, role: 'assistant', type: 'world_card', content: '舊卡片', metadata: { worldId: w.id, round: 1, storyTime: ep.storyTime } as any });
        }
        const turns: string[] = [];
        vi.mocked(safeFetchJson).mockImplementation(async (_url: any, init: any) => {
            const msgs = JSON.parse(init.body).messages;
            turns.push(msgs[msgs.length - 1].content);
            const who = turns.length === 1 ? '甲' : '乙';
            return { choices: [{ message: { content: JSON.stringify({ narrative: `${who}新劇情`, location: '家', mood: '開心', phone: { group: [`${who}新群消息`] } }) } }] };
        });
        const result = await rerollWorldEpisodeAll({ world: w, characters: members as any, apiConfig: { baseUrl: 'https://test.invalid', model: 'test' } as any, userProfile: { name: '我' } as any, groups: [], trigger: 'observe', episodeId: ep.id, direction: '大家都下雨天在家' });
        expect(result.ok).toBe(true);
        expect(turns).toHaveLength(2);
        expect(turns[0]).toContain('大家都下雨天在家');
        expect(turns[0]).not.toContain('乙舊私信');
        expect(turns[1]).toContain('甲新');
        const savedEp = (await DB.getWorldEpisodes(w.id))[0];
        expect(savedEp.beats.map(x => x.narrative)).toEqual(['甲新劇情', '乙新劇情']);
        const saved = (await DB.getWorld(w.id))!;
        const texts = saved.threads!.flatMap(t => t.messages).map(m => m.text);
        expect(texts).toEqual(expect.arrayContaining(['甲新群消息', '乙新群消息']));
        expect(texts.some(t => t.includes('舊'))).toBe(false);
        expect(saved.seeds).toEqual([]);
        expect(saved.relationships[0]).toMatchObject({ value: 98, label: '朋友' });
        for (const id of ['a', 'b']) {
            const cards = (await DB.getMessagesByCharId(id, true)).filter(m => (m.metadata as any)?.worldId === w.id);
            expect(cards).toHaveLength(1);
            expect(cards[0].content).not.toBe('舊卡片');
        }
    });
    it('整段重演全部失敗時什麼都不動', async () => {
        const w = world('reroll-all-fail'), ep = episode(w.id);
        applyBeatToThreads(w, beat(), members, 1, ep.storyTime);
        await DB.saveWorld(w); await DB.saveWorldEpisode(ep);
        vi.mocked(safeFetchJson).mockRejectedValue(new Error('down'));
        const result = await rerollWorldEpisodeAll({ world: w, characters: members as any, apiConfig: { baseUrl: 'https://test.invalid', model: 'test' } as any, userProfile: { name: '我' } as any, groups: [], trigger: 'observe', episodeId: ep.id });
        expect(result).toMatchObject({ ok: false, reason: 'all-beats-failed' });
        expect((await DB.getWorldEpisodes(w.id))[0].beats[0].narrative).toBe('舊劇情');
        expect((await DB.getWorld(w.id))!.threads!.flatMap(t => t.messages).map(m => m.text)).toEqual(['舊劇情']);
    });

    it('真實時間已追上現實：手動觀測接著演同一時段稍後（標籤帶第幾次），自動 tick 照舊不演', async () => {
        const w: WorldProfile = { ...world('same-seg'), timeMode: 'real', injectToChat: false };
        w.realClock = realNowSeg(worldNow(w));
        const label = formatRealClock(w.realClock);
        await DB.saveWorld(w);
        await DB.saveWorldEpisode({ ...episode(w.id), storyTime: label, createdAt: Date.now() - 1000 });
        const deps = { world: w, characters: members as any, apiConfig: { baseUrl: 'https://test.invalid', model: 'test' } as any, userProfile: { name: '我' } as any, groups: [] };
        expect(await runWorldEpisode({ ...deps, trigger: 'tick' })).toMatchObject({ ok: false, reason: 'caught-up' });
        const turns: string[] = [];
        vi.mocked(safeFetchJson).mockImplementation(async (_url: any, init: any) => {
            const msgs = JSON.parse(init.body).messages;
            turns.push(msgs[msgs.length - 1].content);
            return { choices: [{ message: { content: JSON.stringify({ narrative: '稍後的事', location: '家', mood: '平靜' }) } }] };
        });
        const result = await runWorldEpisode({ ...deps, trigger: 'observe' });
        expect(result.ok).toBe(true);
        expect(result.episode?.storyTime).toBe(`${label} · 第2次`);
        expect(turns[0]).toContain('同一時段稍晚一點');
        expect((await DB.getWorld(w.id))!.realClock).toEqual(w.realClock);
    });
});
