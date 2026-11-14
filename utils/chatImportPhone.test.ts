import { describe, expect, it } from 'vitest';
import { findAlreadyImported, isPhoneExport, parsePhoneExport, toMemoryFragments } from './chatImportPhone';

// 假資料：照那家匯出檔的形狀，內容全是編的
const T = Date.UTC(2026, 0, 2, 3, 0, 0);
const PRIVATE = {
    version: 3, exportDate: '2026-01-05T00:00:00.000Z',
    character: { id: 'c-1', name: '阿岳', role: '咖啡師', description: '話不多' },
    user: { name: '小晴' },
    messages: [
        { id: 'fg_1', sender: 'system', type: 'state', text: '你已新增了 阿岳，現在可以開始聊天了', timestamp: T },
        { id: 'm1', sender: 'me', text: '今天開門嗎？', timestamp: T + 1000 },
        { id: 'm2', sender: 'them', text: '開。', subtext: '她又來了', timestamp: T + 2000, replyTo: { id: 'm1', text: '今天開門嗎？', sender: 'me' } },
        { id: 'm3', sender: 'them', type: 'state', text: '他把杯子擦乾，放回架上。', timestamp: T + 3000 },
        { id: 'm4', sender: 'me', type: 'recalled', text: '', timestamp: T + 4000 },
        { id: 'm5', sender: 'them', image: 'https://img.example/a.jpg', imageSummary: '一杯拿鐵', timestamp: T + 5000 },
        { id: 'm6', sender: 'me', sticker: 'https://img.example/s.png', stickerMeaning: '偷看', timestamp: T + 6000 },
        { id: 'm7', sender: 'them', isVoice: true, text: '[語音]', voiceText: '路上小心', timestamp: T + 7000 },
        { id: 'm8', sender: 'them', transferData: { amount: 52, status: 'success', note: '咖啡錢' }, timestamp: T + 8000 },
        { id: 'm9', sender: 'them', isHtml: true, text: '<polaroid><img src="x"></polaroid>', timestamp: T + 9000 },
        { id: 'm10', sender: 'them', isHtml: true, text: '<note>明天<b>休息</b></note>', timestamp: T + 9500 },
        { id: 'm11', sender: 'me', text: '   ', timestamp: T + 9800 },
        { id: 'm12', sender: 'me', text: 'hello', translation: '哈囉', timestamp: 'bad' },
    ],
    userFacts: [{ id: 'f1', cat: 'user', content: '小晴不喝冰的', createdAt: T }],
    summaryHistory: [
        { id: 's1', summary: '舊的', mergedIntoBigSummary: true, date: T },
        { id: 's2', summary: '[big summary body v2] 兩人在店裡聊了一下午', date: T },
    ],
    episodeSummary: '兩人在店裡聊了一下午',
};

const GROUP = {
    version: 3, kind: 'group_chat', exportDate: '2026-01-05T00:00:00.000Z',
    group: { id: 'g-1', name: '週末小隊', members: ['c-1', 'c-2'] },
    user: { name: '小晴' },
    messages: [
        { id: 'g1', sender: 'me', text: '誰要去爬山', timestamp: T },
        { id: 'g2', sender: 'them', senderCharId: 'c-1', senderName: '阿岳', text: '我', timestamp: T + 1000 },
        { id: 'g3', sender: 'them', senderCharId: 'c-2', senderName: '米可', text: '下雨欸', timestamp: T + 2000 },
        { id: 'g4', sender: 'them', senderCharId: 'c-1', senderName: '阿岳', text: '那改天', timestamp: T + 3000 },
    ],
};

describe('另一家的匯出檔', () => {
    it('認得私聊和群聊（kind 是 group_chat）', () => {
        expect(isPhoneExport(PRIVATE)).toBe(true);
        expect(isPhoneExport(GROUP)).toBe(true);
        expect(isPhoneExport({ messages: [] })).toBe(false);
        expect(() => parsePhoneExport({ foo: 1 })).toThrow('不是認得的聊天紀錄檔');
    });

    it('私聊：各種訊息怎麼轉', () => {
        const r = parsePhoneExport(PRIVATE);
        if (r.kind !== 'private') throw new Error('kind');
        expect(r.character).toMatchObject({ name: '阿岳', role: '咖啡師', sourceId: 'c-1' });
        expect(r.userName).toBe('小晴');
        const by = (id: string) => r.messages.find(m => m.metadata.importedFrom.id === id)!;
        expect(by('fg_1')).toMatchObject({ role: 'system', type: 'system' });
        expect(by('m2')).toMatchObject({ role: 'assistant', content: '開。', replyToSourceId: 'm1', replyToPreview: { fromMe: true } });
        expect(by('m2').metadata.thinkingChain).toBe('她又來了');
        // 旁白照誰寫的放，不當系統訊息
        expect(by('m3')).toMatchObject({ role: 'assistant', type: 'text', content: '他把杯子擦乾，放回架上。' });
        expect(by('m3').metadata.narration).toBe(true);
        expect(by('m4')).toMatchObject({ role: 'system', content: '撤回了一條消息' });
        expect(by('m5')).toMatchObject({ type: 'image', content: 'https://img.example/a.jpg' });
        expect(by('m5').metadata.visionDescription).toBe('一杯拿鐵');
        expect(by('m6')).toMatchObject({ role: 'user', type: 'emoji' });
        expect(by('m6').metadata.stickerName).toBe('偷看');
        expect(by('m7')).toMatchObject({ type: 'voice', content: '路上小心' });
        expect(by('m8')).toMatchObject({ type: 'transfer' });
        expect(by('m8').metadata).toMatchObject({ amount: '52', status: 'accepted', note: '咖啡錢' });
        expect(by('m10')).toMatchObject({ type: 'text', content: '明天 休息' });
        expect(r.skipped).toEqual({ '那邊專用的卡片（沒有文字）': 1, '空白訊息': 1, '沒有時間': 1 });
        expect(r.messages).toHaveLength(10);
        expect(r.range).toEqual({ from: T, to: T + 9500 });
    });

    it('記憶：userFacts 和沒被併掉的總結；episodeSummary 不收', () => {
        const r = parsePhoneExport(PRIVATE);
        expect(r.memories.map(m => [m.kind, m.summary])).toEqual([['fact', '小晴不喝冰的'], ['summary', '兩人在店裡聊了一下午']]);
        const frags = toMemoryFragments(r.memories, 1);
        expect(frags[0].summary).toBe('【匯入·關於你】小晴不喝冰的');
        expect(frags[1].summary).toBe('【匯入·總結】兩人在店裡聊了一下午');
    });

    it('群聊：發話人和成員', () => {
        const r = parsePhoneExport(GROUP);
        if (r.kind !== 'group') throw new Error('kind');
        expect(r.group).toEqual({ name: '週末小隊', sourceId: 'g-1' });
        expect(r.speakers).toEqual([{ name: '阿岳', sourceId: 'c-1', count: 2 }, { name: '米可', sourceId: 'c-2', count: 1 }]);
        expect(r.messages[1]).toMatchObject({ role: 'assistant', speaker: '阿岳' });
        expect(r.messages[0].speaker).toBeUndefined();
    });

    it('重複匯入：照原本的 id 找出已經在的', () => {
        const r = parsePhoneExport(GROUP);
        const existing = [
            { id: 101, metadata: { importedFrom: { source: 'phone-json', id: 'g2' } } },
            { id: 102, metadata: { importedFrom: { source: 'other', id: 'g3' } } },
            { id: 103, metadata: {} },
        ];
        const hit = findAlreadyImported(existing as any, r.messages);
        expect([...hit.ids]).toEqual(['g2']);
        expect(hit.existingMessageIds).toEqual([101]);
    });
});

describe('寫入計畫', () => {
    it('跳過或覆蓋已經匯過的；引用回覆接到 Soren 的 id', async () => {
        const { planImportRows, replyPatches } = await import('./chatImportPhoneWrite');
        const r = parsePhoneExport(PRIVATE);
        const existing = [{ id: 500, metadata: { importedFrom: { source: 'phone-json', id: 'm1' } } }];
        const place = () => ({ charId: 'c', personaKey: 'pB' });
        const skip = planImportRows({ messages: r.messages, existing, duplicate: 'skip', place });
        expect(skip.skippedDuplicates).toBe(1);
        expect(skip.rows.some(row => row.id === 500)).toBe(false);
        expect(skip.rows[0]).toMatchObject({ charId: 'c', personaKey: 'pB' });
        // m2 引用 m1：m1 沒重寫，照樣接到 500
        const ids = skip.rows.map((_, i) => 1000 + i);
        const patches = replyPatches(skip, ids, () => '阿岳');
        expect(patches).toEqual([{ id: ids[skip.sources.findIndex(m => m.metadata.importedFrom.id === 'm2')], fields: { replyTo: { id: 500, content: '今天開門嗎？', name: '我' } } }]);

        const over = planImportRows({ messages: r.messages, existing, duplicate: 'overwrite', place });
        expect(over.overwritten).toBe(1);
        expect(over.rows.find(row => row.id === 500)?.content).toBe('今天開門嗎？');
        // 群聊沒對到的發話人不放
        const g = parsePhoneExport(GROUP);
        const gp = planImportRows({ messages: g.messages, existing: [], duplicate: 'skip', place: m => (m.speaker === '米可' ? null : { charId: m.role === 'user' ? 'user' : 'c-1', groupId: 'G' }) });
        expect(gp.unplaced).toBe(1);
        expect(gp.rows.every(row => row.groupId === 'G')).toBe(true);
    });
});
