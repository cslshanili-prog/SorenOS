import { describe, expect, it } from 'vitest';
import type { AssistantWorldbookProposal, MountedWorldbook, Worldbook } from '../../types';
import { buildWorldbookProposal, describeCharacter, describeWorldbook, describeWorldbookList, type WorldbookData } from './worldbookOps';
import { applyWorldbookProposal, restoreWorldbookProposal, type WorldbookWriter, worldbookChangedSinceApply } from './applyProposal';
import { toMountedWorldbook } from '../worldbook';
import { findSoreTool } from './tools';

const book = (id: string, title: string, category: string, extra: Partial<Worldbook> = {}): Worldbook => ({
    id, title, content: `${title}的內容`, category, constant: true, position: 1, order: 100, createdAt: 1, updatedAt: 1, ...extra,
});

const makeData = (): WorldbookData => {
    const academy = [book('w1', '學院', '魔法學院'), book('w2', '校規', '魔法學院', { constant: false, key: ['校規'] })];
    return {
        worldbooks: [...academy, book('w3', '天氣', '全局設定', { global: true })],
        characters: [
            { id: 'c1', name: '阿澈', description: '學院的學長', systemPrompt: '你是阿澈，冷淡但溫柔。', worldview: '魔法存在的現代', mountedWorldbooks: [toMountedWorldbook(academy[0])] },
            { id: 'c2', name: '小遙', description: '', systemPrompt: '', mountedWorldbooks: [] },
        ],
    };
};

const fakeWriter = (data: WorldbookData): WorldbookWriter => ({
    add: b => { data.worldbooks = [...data.worldbooks, b]; },
    update: (id, patch) => {
        data.worldbooks = data.worldbooks.map(b => (b.id === id ? { ...b, ...patch } : b));
        // 模擬 mutateWorldbooks 同步角色緩存
        data.characters = data.characters.map(c => ({ ...c, mountedWorldbooks: (c.mountedWorldbooks || []).map(m => (m.id === id ? toMountedWorldbook(data.worldbooks.find(b => b.id === id)!) : m)) }));
    },
    remove: ids => { data.worldbooks = data.worldbooks.filter(b => !ids.includes(b.id)); },
    setMounted: (charId, mounted: MountedWorldbook[]) => { data.characters = data.characters.map(c => (c.id === charId ? { ...c, mountedWorldbooks: mounted } : c)); },
});

describe('讀', () => {
    it('列出、讀組、讀條目、讀角色', () => {
        const data = makeData();
        expect(describeWorldbookList(data)).toContain('「魔法學院」2 條｜掛給：阿澈');
        expect(describeWorldbookList(data)).toContain('「全局設定」1 條｜全局啟用');
        expect(describeWorldbook('魔法學院', undefined, data).content).toContain('關鍵詞：校規');
        expect(describeWorldbook('魔法學院', '校規', data).content).toContain('校規的內容');
        expect(describeWorldbook('沒有', undefined, data).ok).toBe(false);
        const char = describeCharacter('阿澈', data).content;
        expect(char).toContain('你是阿澈，冷淡但溫柔。');
        expect(char).toContain('魔法學院／學院');
    });
});

describe('改世界書', () => {
    it('加、改、停用、掛給，算出改動清單', () => {
        const r = buildWorldbookProposal('魔法學院', [
            { op: 'add', title: '宿舍', content: '男女分棟', keys: ['宿舍', '寢室'] },
            { op: 'edit', entry: '學院', content: '新的學院內容', position: 0 },
            { op: 'disable', entry: '校規' },
            { op: 'mount', chars: ['小遙'] },
        ], makeData());
        expect('draft' in r).toBe(true);
        const d = (r as any).draft as AssistantWorldbookProposal;
        expect(d.adds[0]).toMatchObject({ title: '宿舍', category: '魔法學院', constant: false, key: ['宿舍', '寢室'], position: 1, depth: 4 });
        expect(d.updates.find(u => u.id === 'w1')?.patch).toMatchObject({ content: '新的學院內容', position: 0 });
        expect(d.updates.find(u => u.id === 'w2')?.patch).toMatchObject({ disable: true });
        expect(d.mounts).toEqual([{ charId: 'c2', add: ['w1', 'w2', d.adds[0].id], remove: [] }]);
        expect(d.changes.map(c => c.label)).toEqual(expect.arrayContaining([expect.stringContaining('新增「宿舍」'), expect.stringContaining('停用「校規」'), expect.stringContaining('掛給小遙（整組）')]));
    });
    it('不能刪；關鍵詞觸發要有關鍵詞；改名不能併組', () => {
        expect((buildWorldbookProposal('魔法學院', [{ op: 'delete', entry: '學院' }], makeData()) as any).errors[0]).toContain('不能刪');
        expect((buildWorldbookProposal('魔法學院', [{ op: 'edit', entry: '學院', constant: false }], makeData()) as any).errors[0]).toContain('至少要一個主要關鍵詞');
        expect((buildWorldbookProposal('魔法學院', [{ op: 'rename', name: '全局設定' }], makeData()) as any).errors[0]).toContain('不能併組');
        expect((buildWorldbookProposal('新組', [{ op: 'disable', entry: 'x' }], makeData()) as any).errors.length).toBeGreaterThan(0);
    });
    it('新條目加進全局組跟著全局；整組改名套到每條', () => {
        const g = (buildWorldbookProposal('全局設定', [{ op: 'add', title: '季節', content: '現在是冬天' }], makeData()) as any).draft;
        expect(g.adds[0].global).toBe(true);
        const r = (buildWorldbookProposal('魔法學院', [{ op: 'rename', name: '星光學院' }, { op: 'add', title: '新', content: 'x' }], makeData()) as any).draft;
        expect(r.category).toBe('星光學院');
        expect(r.updates.every((u: any) => u.patch.category === '星光學院')).toBe(true);
        expect(r.adds[0].category).toBe('星光學院');
    });
});

describe('套用與還原', () => {
    it('套用寫進去、掛上去（已掛的換新版）；還原刪掉新加的、條目和掛載都回原樣', async () => {
        const data = makeData();
        const d = (buildWorldbookProposal('魔法學院', [
            { op: 'add', title: '宿舍', content: '男女分棟' },
            { op: 'edit', entry: '學院', content: '新的學院內容' },
            { op: 'mount', chars: ['阿澈'] },
        ], data) as any).draft;
        const proposal = { ...d, id: 'p', status: 'pending' } as AssistantWorldbookProposal;
        const applied = await applyWorldbookProposal(proposal, data, fakeWriter(data));
        expect(data.worldbooks.find(b => b.id === 'w1')?.content).toBe('新的學院內容');
        expect(data.worldbooks.some(b => b.title === '宿舍')).toBe(true);
        const mounted = data.characters[0].mountedWorldbooks!;
        expect(mounted.map(m => m.id)).toEqual(['w1', 'w2', d.adds[0].id]);
        expect(mounted[0].content).toBe('新的學院內容');
        expect(worldbookChangedSinceApply(applied, data)).toBe(false);
        await restoreWorldbookProposal(applied, data, fakeWriter(data));
        expect(data.worldbooks.some(b => b.title === '宿舍')).toBe(false);
        expect(data.worldbooks.find(b => b.id === 'w1')?.content).toBe('學院的內容');
        expect(data.characters[0].mountedWorldbooks!.map(m => m.id)).toEqual(['w1']);
        expect(data.characters[0].mountedWorldbooks![0].content).toBe('學院的內容');
    });
    it('工具：出卡片；ops 出錯不出卡片', async () => {
        const data = makeData();
        const ctx = { settings: async () => { throw new Error('x'); }, testApi: async () => ({ ok: true, message: '' }), worldbookData: () => data };
        const ok = await findSoreTool('改世界書')!.run({ group: '魔法學院', ops: [{ op: 'global', on: true }] }, ctx);
        expect(ok.proposal).toMatchObject({ kind: 'worldbook', category: '魔法學院' });
        const bad = await findSoreTool('改世界書')!.run({ group: '魔法學院', ops: [{ op: 'remove', entry: '學院' }] }, ctx);
        expect(bad.ok).toBe(false);
        expect(bad.proposal).toBeUndefined();
    });
});
