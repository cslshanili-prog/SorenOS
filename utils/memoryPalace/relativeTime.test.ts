import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../types';
import type { MemoryNode } from './types';
import { memoryContentWithDates, relativeTimeAnnotations, relativeTimeEnabled, relativeTimeEdit } from './relativeTime';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryTimeText } from '../../components/MemoryTimeText';
import { MemoryContentEditor } from '../../components/MemoryContentEditor';
import { extractMemoriesFromBuffer } from './extraction';
import { safeFetchJson } from '../safeApi';
import { MemoryNodeDB, EventBoxDB, MemoryVectorDB } from './db';
import { expandAndFormat } from './formatter';
import { exportMemoryPalace, importMemoryPalace } from './export';
import { resolveLinkedArchives } from './linkedArchive';

vi.mock('../safeApi', () => ({ safeFetchJson: vi.fn() }));
const fetchJson = vi.mocked(safeFetchJson);
const node = (content: string, dateKey = '2026-09-16'): MemoryNode => ({
    id: 'relative-node', charId: 'relative-char', content, room: 'user_room', tags: [],
    importance: 5, mood: 'neutral', embedded: false, createdAt: new Date(2026, 8, 15, 12).getTime(),
    lastAccessedAt: 0, accessCount: 0, relativeTimeAnchor: { dateKey, source: 'message', messageId: 1 },
});
function enabled(value: boolean) { localStorage.setItem('os_memory_palace_config', JSON.stringify({ relativeTimeAnnotations: value })); }
beforeEach(() => { localStorage.clear(); fetchJson.mockReset(); });

describe('可逆的相對時間補註', () => {
    it.each([
        ['昨天', '2026年9月15日'], ['昨晚', '2026年9月15日'], ['前天', '2026年9月14日'],
        ['3天前', '2026年9月13日'], ['三天前', '2026年9月13日'], ['十一天前', '2026年9月5日'],
        ['兩天前', '2026年9月14日'], ['上週', '2026年9月9日前後'], ['上個月', '2026年8月'],
        ['2個月前', '2026年7月'], ['兩個月前', '2026年7月'], ['十二個月前', '2025年9月'], ['去年', '2025年'],
    ])('%s 按固定的原消息參照日計算', (expression, date) => {
        expect(memoryContentWithDates(node(`${expression}開始休假`), true)).toBe(`${expression}〔${date}〕開始休假`);
    });

    it('跨月、跨年、閏日不按固定毫秒或 30 天月換算', () => {
        expect(memoryContentWithDates(node('昨天', '2024-03-01'), true)).toBe('昨天〔2024年2月29日〕');
        expect(memoryContentWithDates(node('昨天，上個月', '2026-01-01'), true)).toBe('昨天〔2025年12月31日〕，上個月〔2025年12月〕');
        expect(memoryContentWithDates(node('上個月', '2026-03-31'), true)).toBe('上個月〔2026年2月〕');
    });

    it('改措辭就重算，具體日期和用戶自己的日期括號不關聯', () => {
        const memory = node('昨天開始休假');
        expect(memoryContentWithDates({ ...memory, content: '前天開始休假' }, true)).toContain('9月14日');
        expect(relativeTimeAnnotations({ ...memory, content: '9月14日開始休假' }, true)).toEqual([]);
        expect(memoryContentWithDates(node('昨天（9.15）和昨天〔2026年9月15日〕'), true)).toBe('昨天（9.15）和昨天〔2026年9月15日〕');
        expect(memory.content).toBe('昨天開始休假');
    });

    it('不開啟、缺少參照日、非法參照日、摘要、已封存節點均不補註', () => {
        const memory = node('昨天休假');
        expect(relativeTimeEnabled()).toBe(false);
        expect(memoryContentWithDates(memory)).toBe(memory.content);
        for (const extra of [{ relativeTimeAnchor: undefined }, { isBoxSummary: true }, { archived: true }]) {
            expect(memoryContentWithDates({ ...memory, ...extra }, true)).toBe(memory.content);
        }
        expect(memoryContentWithDates(node('昨天', '2026-02-30'), true)).toBe('昨天');
        localStorage.setItem('os_memory_palace_config', '{bad');
        expect(memoryContentWithDates(memory)).toBe(memory.content);
    });

    it('重複開關可逆且不改正文或存儲字段', () => {
        const memory = node('昨天休假');
        const before = JSON.stringify(memory);
        enabled(true);
        expect(memoryContentWithDates(memory)).toContain('〔');
        enabled(false);
        expect(memoryContentWithDates(memory)).toBe('昨天休假');
        expect(JSON.stringify(memory)).toBe(before);
    });

    it('編輯原文：相對措辭沿用來源，明確日期解除關聯，關閉後不操作關聯', () => {
        const memory = node('昨天休假');
        const changed = relativeTimeEdit(memory, '前天休假', true);
        expect({ ...memory, ...changed }.relativeTimeAnchor).toEqual(memory.relativeTimeAnchor);
        expect(relativeTimeEdit(memory, '9月14日休假', true)).toEqual({ relativeTimeAnchor: undefined });
        expect(relativeTimeEdit(memory, '前天休假', false)).toEqual({});
        expect(relativeTimeEdit({ ...memory, relativeTimeAnchor: undefined }, '昨天休假', true)).toEqual({});
    });

    it('編輯頁沒有日期輸入，只能通過原文措辭調整只讀預覽', () => {
        const props = { node: node('昨天休假'), value: '前天休假', onChange: () => {}, enabled: true };
        const html = renderToStaticMarkup(createElement(MemoryContentEditor, props));
        expect(html).not.toContain('type="date"');
        expect(html).toContain('系統補註日期不可直接修改');
        expect(html).toContain('〔2026年9月14日〕');
        const off = renderToStaticMarkup(createElement(MemoryContentEditor, { ...props, enabled: false }));
        expect(off).not.toContain('補註');
        expect(off).not.toContain('2026');
    });

    it('正文界面顯示帶來源提示的系統補註，關閉後逐字保留原文', () => {
        const memory = node('昨天休假');
        const on = renderToStaticMarkup(createElement(MemoryTimeText, { node: memory, enabled: true }));
        expect(on).toContain('系統補註 · 參照日 2026-09-16');
        expect(on).toContain('〔2026年9月15日〕');
        expect(renderToStaticMarkup(createElement(MemoryTimeText, { node: memory, enabled: false }))).toBe(memory.content);
        expect(renderToStaticMarkup(createElement(MemoryTimeText, { node: memory, enabled: false, maxLength: 2 }))).toBe('昨天...');
    });

    it('不把不支持的數量或上週幾截成另一種相對日期', () => {
        const content = '1.5天前、三萬天前、上週三、上週末、大前天';
        expect(memoryContentWithDates(node(content), true)).toBe(content);
    });
});

const messages: Message[] = [16, 17].map(day => ({
    id: day, charId: 'relative-char', role: 'user', type: 'text', content: '我昨天休假。',
    timestamp: new Date(2026, 8, day, 10).getTime(),
}));
const config = { baseUrl: 'https://memory.test/v1', apiKey: 'test', model: 'test' };
function reply(source: unknown = 'M0') {
    return { choices: [{ message: { content: JSON.stringify([
        { content: '用戶昨天休假。', room: 'user_room', date: '2026-09-15', relativeTimeSource: source },
    ]) } }] } as any;
}
async function extract() { return (await extractMemoriesFromBuffer(messages, 'relative-char', '角色', config)).memories[0]; }

describe('提取時嚴格按開關綁定原消息日期', () => {
    it('默認關閉時提示詞和輸入不增加編號，模型擅自返回來源也不存關聯', async () => {
        fetchJson.mockResolvedValue(reply());
        const memory = await extract();
        const body = JSON.parse(String((fetchJson.mock.calls[0][1] as RequestInit).body));
        expect(body.messages[0].content).not.toContain('relativeTimeSource');
        expect(body.messages[1].content).not.toContain('[M0]');
        expect(memory).not.toHaveProperty('relativeTimeAnchor');
        expect(memory.content).toBe('用戶昨天休假。');
    });

    it('開啟時使用對應消息發送日，不使用事件日或批次日期', async () => {
        enabled(true); fetchJson.mockResolvedValue(reply());
        const memory = await extract();
        expect(memory.relativeTimeAnchor).toEqual({ dateKey: '2026-09-16', source: 'message', messageId: 16 });
        expect(memoryContentWithDates(memory)).toContain('昨天〔2026年9月15日〕');
    });

    it.each([undefined, 'M99', 'M-1', '0', 0])('無有效來源 %s 時不猜日期', async source => {
        enabled(true); fetchJson.mockResolvedValue(reply(source === undefined ? null : source));
        expect(await extract()).not.toHaveProperty('relativeTimeAnchor');
    });

    it('請求途中關閉開關，完成時也不落入日期關聯', async () => {
        enabled(true);
        fetchJson.mockImplementation(async () => { enabled(false); return reply(); });
        expect(await extract()).not.toHaveProperty('relativeTimeAnchor');
    });

    it('模型改寫相對措辭時，不把不匹配的原消息強行關聯', async () => {
        enabled(true);
        const response = reply();
        response.choices[0].message.content = response.choices[0].message.content.replace('昨天', '前天');
        fetchJson.mockResolvedValue(response);
        expect(await extract()).not.toHaveProperty('relativeTimeAnchor');
    });
});

describe('召回同樣遵守開關和節點邊界', () => {
    it('獨立節點開關可逆，底層正文不變', async () => {
        const memory = node('昨天開始休假');
        await MemoryNodeDB.save(memory);
        const results = [{ node: memory, finalScore: 1 }] as any;
        const before = await expandAndFormat(results, memory.charId);
        enabled(true);
        expect(await expandAndFormat(results, memory.charId)).toContain('昨天〔2026年9月15日〕');
        enabled(false);
        expect(await expandAndFormat(results, memory.charId)).toBe(before);
        expect((await MemoryNodeDB.getById(memory.id))?.content).toBe(memory.content);
    });

    it('事件盒只補活節點，不補二次摘要', async () => {
        enabled(true);
        const live = { ...node('昨天休假'), id: 'box-live', eventBoxId: 'time-box' };
        const summary = { ...node('昨天去了公園'), id: 'box-summary', isBoxSummary: true, eventBoxId: 'time-box' };
        await MemoryNodeDB.save(live); await MemoryNodeDB.save(summary);
        await EventBoxDB.save({ id: 'time-box', charId: live.charId, name: '休假', tags: [], liveMemoryIds: [live.id],
            summaryNodeId: summary.id, compressionCount: 1, updatedAt: live.createdAt, createdAt: live.createdAt } as any);
        const output = await expandAndFormat([{ node: live, finalScore: 1 }] as any, live.charId);
        expect(output).toContain('昨天〔2026年9月15日〕休假');
        expect(output).toContain('昨天去了公園');
        expect(output).not.toContain('昨天〔2026年9月15日〕去了公園');
    });
});

describe('日期補註導出與可逆導入', () => {
    it('關閉時沿用原文導出，開啟時宮殿和神經鏈接文本導出都包含日期', async () => {
        const memory = { ...node('昨天開始休假'), id: 'export-time', charId: 'export-time-char' };
        await MemoryNodeDB.save(memory);
        const chars = [{ id: memory.charId, name: '測試' }];
        const off = await exportMemoryPalace(chars);
        expect(off.characters[0].nodes[0].content).toBe(memory.content);
        expect(off.characters[0].nodes[0]).not.toHaveProperty('relativeTimeExport');
        const fragments = [{ id: 'linked-export', date: '2026-09-16', summary: '快照', palaceMemoryId: memory.id }];
        expect((await resolveLinkedArchives(memory.charId, fragments, true))[0].summary).toBe(memory.content);
        enabled(true);
        const on = JSON.parse(JSON.stringify(await exportMemoryPalace(chars)));
        expect(on.characters[0].nodes[0].content).toBe('昨天〔2026年9月15日〕開始休假');
        expect(on.characters[0].nodes[0].relativeTimeExport.originalContent).toBe(memory.content);
        expect((await resolveLinkedArchives(memory.charId, fragments, true))[0].summary).toBe(on.characters[0].nodes[0].content);
        // Normal linked editing continues to receive source text, not an editable generated date.
        expect((await resolveLinkedArchives(memory.charId, fragments))[0].summary).toBe(memory.content);
        enabled(false);
        expect((await exportMemoryPalace(chars)).characters).toEqual(off.characters);
        expect((await MemoryNodeDB.getById(memory.id))?.content).toBe(memory.content);
    });

    it('包含日期的 JSON 往返後仍可關閉、重新開啟，不重複補註且向量仍對應原文', async () => {
        const memory = { ...node('昨天休假'), id: 'roundtrip-time', charId: 'roundtrip-time-char' };
        await MemoryNodeDB.save(memory);
        await MemoryVectorDB.save({ memoryId: memory.id, charId: memory.charId, vector: [1, 0], dimensions: 2, model: 'test' });
        enabled(true);
        const exported = JSON.parse(JSON.stringify(await exportMemoryPalace([{ id: memory.charId, name: '測試' }], { includeVectors: true })));
        enabled(false);
        const result = await importMemoryPalace(exported, 'roundtrip-target');
        expect(result.vectors).toBe(1);
        const [restored] = await MemoryNodeDB.getByCharId('roundtrip-target');
        expect(restored.content).toBe('昨天休假');
        expect(restored).not.toHaveProperty('relativeTimeExport');
        expect(memoryContentWithDates(restored)).toBe('昨天休假');
        enabled(true);
        expect(memoryContentWithDates(restored)).toBe('昨天〔2026年9月15日〕休假');
        expect((await MemoryVectorDB.getByMemoryId(restored.id))?.dimensions).toBe(2);
    });

    it('用戶改過導出正文時不擅自恢復舊原文或複用舊向量', async () => {
        const memory = { ...node('昨天休假'), id: 'edited-export-time', charId: 'edited-export-time-char' };
        await MemoryNodeDB.save(memory);
        await MemoryVectorDB.save({ memoryId: memory.id, charId: memory.charId, vector: [1, 0], dimensions: 2 });
        enabled(true);
        const exported = await exportMemoryPalace([{ id: memory.charId, name: '測試' }], { includeVectors: true });
        exported.characters[0].nodes[0].content = '用戶確認9月14日休假';
        const result = await importMemoryPalace(exported, 'edited-export-target');
        expect(result.vectors).toBe(0);
        const [restored] = await MemoryNodeDB.getByCharId('edited-export-target');
        expect(restored.content).toBe('用戶確認9月14日休假');
        expect(restored.relativeTimeAnchor).toBeUndefined();
    });
});
